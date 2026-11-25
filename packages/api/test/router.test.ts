import { describe, expect, test } from 'bun:test';
import type { BasePersistenceLayer } from '@aws-lambda-powertools/idempotency/persistence';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

import { createApp } from '../src/app.ts';
import type { Store } from '../src/store.ts';

// No database: any store call fails the test. These cover routing, auth and
// request validation, which all run before the store is touched.
const store = new Proxy({} as Store, {
  get: (_t, prop) => () => {
    throw new Error(`store.${String(prop)} should not be called`);
  },
});
const app = createApp({ store, idempotencyStore: {} as BasePersistenceLayer });

const context = {
  awsRequestId: 'test',
  functionName: 'api',
  getRemainingTimeInMillis: () => 10_000,
} as unknown as Context;

const call = async (
  method: string,
  path: string,
  body?: unknown,
  sub: string | null = 'user-a',
) => {
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'example.test', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      ...(sub ? { authorizer: { jwt: { claims: { sub }, scopes: [] } } } : {}),
    },
  } as unknown as APIGatewayProxyEventV2;
  const res = await app.resolve(event, context);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

describe('api router', () => {
  test('GET /api/health is public', async () => {
    expect(await call('GET', '/api/health', undefined, null)).toEqual({
      status: 200,
      body: { status: 'ok' },
    });
  });

  test('GET /api/me returns the verified sub, 401 without one', async () => {
    expect((await call('GET', '/api/me')).body).toEqual({ userId: 'user-a' });
    expect((await call('GET', '/api/me', undefined, null)).status).toBe(401);
  });

  test('unknown route is 404', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
  });

  test('invalid ids and bodies are rejected with 422 before reaching the store', async () => {
    expect((await call('GET', '/api/workspaces/not-a-uuid/tree')).status).toBe(422);
    expect((await call('POST', '/api/workspaces', { name: '' })).status).toBe(422);
    const ws = crypto.randomUUID();
    const upload = await call('POST', `/api/workspaces/${ws}/files/upload-urls`, {
      files: [{ id: 'abc', mimeType: 'text/html', size: 10 }],
    });
    expect(upload.status).toBe(422);
    const save = await call('PUT', `/api/workspaces/${ws}/scenes/${crypto.randomUUID()}/content`, {
      elements: [],
    });
    expect(save.status).toBe(422);
  });
});
