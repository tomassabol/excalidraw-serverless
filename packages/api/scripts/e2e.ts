/**
 * End-to-end check against a deployed stack. Invokes the API Lambda directly
 * with synthetic HTTP API events for a throwaway user (bypassing the JWT
 * authorizer, which only needs your IAM credentials), exercises the whole API
 * including presigned S3 uploads, invokes the purge Lambda, then deletes
 * everything it created.
 *
 *   AWS_PROFILE=... bun packages/api/scripts/e2e.ts [StackName]
 */
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const stackName = process.argv[2] ?? 'Whiteboard-App';
const region = process.env.AWS_REGION ?? 'eu-central-1';
const cfn = new CloudFormationClient({ region });
const lambda = new LambdaClient({ region });

const { StackResources = [] } = await cfn.send(
  new DescribeStackResourcesCommand({ StackName: stackName }),
);
const fnName = (prefix: string) => {
  const r = StackResources.find(
    (s) => s.ResourceType === 'AWS::Lambda::Function' && s.LogicalResourceId?.startsWith(prefix),
  );
  if (!r?.PhysicalResourceId) throw new Error(`No ${prefix} in ${stackName}`);
  return r.PhysicalResourceId;
};
const apiFn = fnName('ApiFunction');
const purgeFn = fnName('PurgeFunction');
const user = `e2e-${crypto.randomUUID()}`;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const invoke = async (fn: string, payload: unknown) => {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: fn,
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  );
  const text = new TextDecoder().decode(res.Payload);
  if (res.FunctionError) throw new Error(`${fn} failed: ${text}`);
  return JSON.parse(text);
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const [rawPath, rawQueryString = ''] = path.split('?');
  const res = await invoke(apiFn, {
    version: '2.0',
    routeKey: 'ANY /api/{proxy+}',
    rawPath,
    rawQueryString,
    queryStringParameters: rawQueryString
      ? Object.fromEntries(new URLSearchParams(rawQueryString))
      : undefined,
    headers: { host: 'e2e.local', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'e2e',
      },
      requestId: crypto.randomUUID(),
      routeKey: 'ANY /api/{proxy+}',
      stage: '$default',
      authorizer: { jwt: { claims: { sub: user }, scopes: [] } },
    },
  });
  return { status: res.statusCode as number, body: res.body ? JSON.parse(res.body) : undefined };
};

console.log(`API ${apiFn}\nuser ${user}\n`);

// workspaces + idempotency
const key = { 'idempotency-key': `e2e-${crypto.randomUUID()}` };
const ws1 = await call('POST', '/api/workspaces', { name: 'E2E' }, key);
const ws1again = await call('POST', '/api/workspaces', { name: 'E2E' }, key);
check('create workspace', ws1.status === 201, ws1);
check('idempotent retry returns same workspace', ws1again.body?.id === ws1.body?.id, ws1again);
const ws = ws1.body.id as string;
const list = await call('GET', '/api/workspaces');
check('list has exactly one workspace', list.body?.workspaces?.length === 1, list.body);

// folders
const a = (await call('POST', `/api/workspaces/${ws}/folders`, { name: 'Architecture' })).body;
const b = (await call('POST', `/api/workspaces/${ws}/folders`, { name: 'Sub', parentId: a.id }))
  .body;
const cycle = await call('PATCH', `/api/workspaces/${ws}/folders/${a.id}`, { parentId: b.id });
check('folder cycle rejected', cycle.status === 400, cycle);

// scenes + optimistic concurrency
const scene = await call('POST', `/api/workspaces/${ws}/scenes`, {
  name: 'VPC layout',
  folderId: b.id,
  tags: ['aws'],
  content: { elements: [{ id: 'e1', type: 'rectangle' }], appState: { gridSize: 20 } },
});
check('create scene', scene.status === 201 && scene.body.version === 1, scene);
const sid = scene.body.id as string;
const save = await call('PUT', `/api/workspaces/${ws}/scenes/${sid}/content`, {
  baseVersion: 1,
  elements: [{ id: 'e1' }, { id: 'e2' }],
  appState: {},
});
check('save v2', save.status === 200 && save.body.version === 2, save);
const stale = await call('PUT', `/api/workspaces/${ws}/scenes/${sid}/content`, {
  baseVersion: 1,
  elements: [],
  appState: {},
});
check(
  'stale save is 409 with currentVersion',
  stale.status === 409 && stale.body?.details?.currentVersion === 2,
  stale,
);
const loaded = await call('GET', `/api/workspaces/${ws}/scenes/${sid}`);
check('load returns latest content', loaded.body?.content?.elements?.length === 2, loaded.body);

// tags, tree, search
await call('PUT', `/api/workspaces/${ws}/tags/aws`, { color: '#ff9900' });
const tree = (await call('GET', `/api/workspaces/${ws}/tree`)).body;
check(
  'tree has folders, scene and tag',
  tree.folders.length === 2 && tree.scenes.length === 1 && tree.tags[0]?.color === '#ff9900',
  tree,
);
const found = (await call('GET', `/api/workspaces/${ws}/search?q=vpc`)).body;
check('search finds scene', found.scenes?.length === 1, found);

// files: presigned upload + download through S3
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
const fileId = 'e2e1x1png';
const up = (
  await call('POST', `/api/workspaces/${ws}/files/upload-urls`, {
    files: [{ id: fileId, mimeType: 'image/png', size: png.length }],
  })
).body;
check('upload URL issued', up.uploads?.length === 1, up);
const put = await fetch(up.uploads[0].url, {
  method: 'PUT',
  headers: up.uploads[0].headers,
  body: png,
});
check('PUT to S3 with presigned URL', put.ok, put.status);
const up2 = (
  await call('POST', `/api/workspaces/${ws}/files/upload-urls`, {
    files: [{ id: fileId, mimeType: 'image/png', size: png.length }],
  })
).body;
check('second request reports existing file', up2.existing?.[0] === fileId, up2);
const down = (
  await call('POST', `/api/workspaces/${ws}/files/download-urls`, { ids: [fileId, 'nope'] })
).body;
const got = await fetch(down.downloads[0].url);
check(
  'download via presigned URL',
  got.ok && (await got.arrayBuffer()).byteLength === png.length,
  got.status,
);
check('missing file reported', down.missing?.[0] === 'nope', down);

// trash: folder subtree, restore, purge
const trashed = (await call('DELETE', `/api/workspaces/${ws}/folders/${a.id}`)).body;
check('trash folder subtree', trashed.count === 3, trashed);
const batches = (await call('GET', `/api/workspaces/${ws}/trash`)).body.batches;
check('trash lists one batch', batches.length === 1 && batches[0].sceneCount === 1, batches);
const restored = (await call('POST', `/api/workspaces/${ws}/trash/${trashed.trashBatchId}/restore`))
  .body;
check('restore batch', restored.restored === 3, restored);

// purge Lambda: simulate TTL removal of the scene item
const purgeRes = await invoke(purgeFn, {
  Records: [
    {
      eventID: '1',
      eventName: 'REMOVE',
      eventVersion: '1.1',
      eventSource: 'aws:dynamodb',
      awsRegion: region,
      eventSourceARN: 'arn:aws:dynamodb:eu-central-1:000000000000:table/x/stream/x',
      userIdentity: { type: 'Service', principalId: 'dynamodb.amazonaws.com' },
      dynamodb: {
        ApproximateCreationDateTime: Math.floor(Date.now() / 1000),
        Keys: { PK: { S: `WS#${ws}` }, SK: { S: `SCENE#${sid}` } },
        OldImage: {
          PK: { S: `WS#${ws}` },
          SK: { S: `SCENE#${sid}` },
          type: { S: 'scene' },
          id: { S: sid },
        },
        SequenceNumber: '1',
        SizeBytes: 100,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
    },
  ],
});
check('purge Lambda processed record', purgeRes.batchItemFailures?.length === 0, purgeRes);

// cleanup: trash everything, purge, delete workspace
const del = (await call('DELETE', `/api/workspaces/${ws}/folders/${a.id}`)).body;
await call('DELETE', `/api/workspaces/${ws}/trash/${del.trashBatchId}`);
const delWs = await call('DELETE', `/api/workspaces/${ws}`);
check('cleanup: workspace deleted', delWs.status === 204, delWs);
const after = (await call('GET', '/api/workspaces')).body;
check('cleanup: no workspaces left', after.workspaces.length === 0, after);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
