import { BadRequestError, Router } from '@aws-lambda-powertools/event-handler/http';
import {
  metrics as metricsMiddleware,
  tracer as tracerMiddleware,
} from '@aws-lambda-powertools/event-handler/http/middleware';
import {
  IdempotencyAlreadyInProgressError,
  IdempotencyConfig,
  IdempotencyValidationError,
  makeIdempotent,
} from '@aws-lambda-powertools/idempotency';
import type { BasePersistenceLayer } from '@aws-lambda-powertools/idempotency/persistence';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  CreateFolderBody,
  CreateSceneBody,
  CreateWorkspaceBody,
  FileDownloadRequest,
  FileUploadRequest,
  Id,
  SaveSceneContentBody,
  SearchQuery,
  TagName,
  UpdateFolderBody,
  UpdateSceneBody,
  UpdateWorkspaceBody,
  UpsertTagBody,
} from '@exs/shared';
import { z } from 'zod';

import { getUserId } from './lib/auth.ts';
import { ConflictError } from './lib/errors.ts';
import { logger, metrics, tracer } from './lib/powertools.ts';
import type { Store } from './store.ts';

export interface AppDeps {
  store: Store;
  /** Persistence for idempotent create requests (`Idempotency-Key` header). */
  idempotencyStore: BasePersistenceLayer;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noContent = () => new Response(null, { status: 204 });

const WsPath = z.object({ ws: Id });
const WsIdPath = z.object({ ws: Id, id: Id });
const WsBatchPath = z.object({ ws: Id, batchId: Id });
const WsTagPath = z.object({ ws: Id, name: TagName });

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

type CreateRequest =
  | { kind: 'workspace'; userId: string; key: string; body: z.infer<typeof CreateWorkspaceBody> }
  | {
      kind: 'folder';
      userId: string;
      key: string;
      workspaceId: string;
      body: z.infer<typeof CreateFolderBody>;
    }
  | {
      kind: 'scene';
      userId: string;
      key: string;
      workspaceId: string;
      body: z.infer<typeof CreateSceneBody>;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const createApp = ({ store, idempotencyStore }: AppDeps) => {
  // CloudFront forwards /api/* to the HTTP API unchanged, so every route lives
  // under the /api prefix.
  const app = new Router({ logger, prefix: '/api' });

  // ------------------------------------------------------------ idempotency

  const idempotencyConfig = new IdempotencyConfig({
    // the same client key for the same user is the same request...
    eventKeyJmesPath: '[userId, key]',
    // ...and must carry the same payload
    payloadValidationJmesPath: '[kind, workspaceId, body]',
    expiresAfterSeconds: 60 * 60,
  });

  const runCreate = (req: CreateRequest) => {
    switch (req.kind) {
      case 'workspace':
        return store.createWorkspace(req.userId, req.body);
      case 'folder':
        return store.createFolder(req.userId, req.workspaceId, req.body);
      case 'scene':
        return store.createScene(req.userId, req.workspaceId, req.body);
    }
  };

  const idempotentCreate = makeIdempotent(runCreate, {
    persistenceStore: idempotencyStore,
    config: idempotencyConfig,
  });

  /** Runs a create idempotently when the client sent an `Idempotency-Key`. */
  const create = (headers: Headers, req: DistributiveOmit<CreateRequest, 'key'>) => {
    const key = headers.get('idempotency-key');
    if (key === null) {
      return runCreate({ ...req, key: '' });
    }
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestError('Idempotency-Key must be 8-128 URL-safe characters');
    }
    return idempotentCreate({ ...req, key });
  };

  // ------------------------------------------------------------- middleware

  app.use(tracerMiddleware(tracer));
  app.use(metricsMiddleware(metrics));
  app.use(async ({ reqCtx, next }) => {
    idempotencyConfig.registerLambdaContext(reqCtx.context);
    await next();
  });

  // ---------------------------------------------------------- error mapping

  app.errorHandler(ConflictError, async (error) => json(error.toJSON(), 409));
  app.errorHandler(IdempotencyAlreadyInProgressError, async () =>
    json({ statusCode: 409, error: 'Conflict', message: 'Request is already in progress' }, 409),
  );
  app.errorHandler(IdempotencyValidationError, async () =>
    json(
      {
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Idempotency-Key was already used with a different payload',
      },
      422,
    ),
  );

  // ----------------------------------------------------------------- public

  app.get('/health', () => ({ status: 'ok' }));

  app.get('/me', (reqCtx) => ({ userId: getUserId(reqCtx) }));

  // ------------------------------------------------------------- workspaces

  app.get('/workspaces', async (reqCtx) => ({
    workspaces: await store.listWorkspaces(getUserId(reqCtx)),
  }));

  app.post(
    '/workspaces',
    async (reqCtx) => {
      const workspace = await create(reqCtx.req.headers, {
        kind: 'workspace',
        userId: getUserId(reqCtx),
        body: reqCtx.valid.req.body,
      });
      return json(workspace, 201);
    },
    { validation: { req: { body: CreateWorkspaceBody } } },
  );

  app.patch(
    '/workspaces/:ws',
    async (reqCtx) =>
      store.renameWorkspace(getUserId(reqCtx), reqCtx.valid.req.path.ws, reqCtx.valid.req.body),
    { validation: { req: { path: WsPath, body: UpdateWorkspaceBody } } },
  );

  app.delete(
    '/workspaces/:ws',
    async (reqCtx) => {
      await store.deleteWorkspace(getUserId(reqCtx), reqCtx.valid.req.path.ws);
      return noContent();
    },
    { validation: { req: { path: WsPath } } },
  );

  app.get(
    '/workspaces/:ws/tree',
    async (reqCtx) => store.getTree(getUserId(reqCtx), reqCtx.valid.req.path.ws),
    { validation: { req: { path: WsPath } } },
  );

  app.get(
    '/workspaces/:ws/search',
    async (reqCtx) =>
      store.search(getUserId(reqCtx), reqCtx.valid.req.path.ws, reqCtx.valid.req.query.q),
    { validation: { req: { path: WsPath, query: SearchQuery } } },
  );

  // ---------------------------------------------------------------- folders

  app.post(
    '/workspaces/:ws/folders',
    async (reqCtx) => {
      const folder = await create(reqCtx.req.headers, {
        kind: 'folder',
        userId: getUserId(reqCtx),
        workspaceId: reqCtx.valid.req.path.ws,
        body: reqCtx.valid.req.body,
      });
      return json(folder, 201);
    },
    { validation: { req: { path: WsPath, body: CreateFolderBody } } },
  );

  app.patch(
    '/workspaces/:ws/folders/:id',
    async (reqCtx) => {
      const { ws, id } = reqCtx.valid.req.path;
      return store.updateFolder(getUserId(reqCtx), ws, id, reqCtx.valid.req.body);
    },
    { validation: { req: { path: WsIdPath, body: UpdateFolderBody } } },
  );

  app.delete(
    '/workspaces/:ws/folders/:id',
    async (reqCtx) => {
      const { ws, id } = reqCtx.valid.req.path;
      const result = await store.trashFolder(getUserId(reqCtx), ws, id);
      metrics.addMetric('ItemsTrashed', MetricUnit.Count, result.count);
      return result;
    },
    { validation: { req: { path: WsIdPath } } },
  );

  // ----------------------------------------------------------------- scenes

  app.post(
    '/workspaces/:ws/scenes',
    async (reqCtx) => {
      const scene = await create(reqCtx.req.headers, {
        kind: 'scene',
        userId: getUserId(reqCtx),
        workspaceId: reqCtx.valid.req.path.ws,
        body: reqCtx.valid.req.body,
      });
      metrics.addMetric('SceneCreated', MetricUnit.Count, 1);
      return json(scene, 201);
    },
    { validation: { req: { path: WsPath, body: CreateSceneBody } } },
  );

  app.get(
    '/workspaces/:ws/scenes/:id',
    async (reqCtx) => {
      const { ws, id } = reqCtx.valid.req.path;
      // scene content is arbitrary JSON from Excalidraw
      return json(await store.getScene(getUserId(reqCtx), ws, id));
    },
    { validation: { req: { path: WsIdPath } } },
  );

  app.put(
    '/workspaces/:ws/scenes/:id/content',
    async (reqCtx) => {
      const { ws, id } = reqCtx.valid.req.path;
      try {
        const { previousSize: _previousSize, ...result } = await store.saveSceneContent(
          getUserId(reqCtx),
          ws,
          id,
          reqCtx.valid.req.body,
        );
        metrics.addMetric('SceneSaved', MetricUnit.Count, 1);
        metrics.addMetric('SceneBytes', MetricUnit.Bytes, result.size);
        return result;
      } catch (error) {
        if (error instanceof ConflictError) {
          metrics.addMetric('SaveConflict', MetricUnit.Count, 1);
        }
        throw error;
      }
    },
    { validation: { req: { path: WsIdPath, body: SaveSceneContentBody } } },
  );

  app.patch(
    '/workspaces/:ws/scenes/:id',
    async (reqCtx) => {
      const { ws, id } = reqCtx.valid.req.path;
      return store.updateScene(getUserId(reqCtx), ws, id, reqCtx.valid.req.body);
    },
    { validation: { req: { path: WsIdPath, body: UpdateSceneBody } } },
  );

  app.delete(
    '/workspaces/:ws/scenes/:id',
    async (reqCtx) => {
      const { ws, id } = reqCtx.valid.req.path;
      const result = await store.trashScene(getUserId(reqCtx), ws, id);
      metrics.addMetric('ItemsTrashed', MetricUnit.Count, result.count);
      return result;
    },
    { validation: { req: { path: WsIdPath } } },
  );

  // ------------------------------------------------------------------- tags

  app.put(
    '/workspaces/:ws/tags/:name',
    async (reqCtx) => {
      const { ws, name } = reqCtx.valid.req.path;
      return store.upsertTag(getUserId(reqCtx), ws, name, reqCtx.valid.req.body);
    },
    { validation: { req: { path: WsTagPath, body: UpsertTagBody } } },
  );

  app.delete(
    '/workspaces/:ws/tags/:name',
    async (reqCtx) => {
      const { ws, name } = reqCtx.valid.req.path;
      return store.deleteTag(getUserId(reqCtx), ws, name);
    },
    { validation: { req: { path: WsTagPath } } },
  );

  // ------------------------------------------------------------------ trash

  app.get(
    '/workspaces/:ws/trash',
    async (reqCtx) => ({
      batches: await store.listTrash(getUserId(reqCtx), reqCtx.valid.req.path.ws),
    }),
    { validation: { req: { path: WsPath } } },
  );

  app.post(
    '/workspaces/:ws/trash/:batchId/restore',
    async (reqCtx) => {
      const { ws, batchId } = reqCtx.valid.req.path;
      return store.restoreTrash(getUserId(reqCtx), ws, batchId);
    },
    { validation: { req: { path: WsBatchPath } } },
  );

  app.delete(
    '/workspaces/:ws/trash/:batchId',
    async (reqCtx) => {
      const { ws, batchId } = reqCtx.valid.req.path;
      const result = await store.purgeTrash(getUserId(reqCtx), ws, batchId);
      metrics.addMetric('TrashPurged', MetricUnit.Count, result.purged);
      return result;
    },
    { validation: { req: { path: WsBatchPath } } },
  );

  // ------------------------------------------------------------------ files

  app.post(
    '/workspaces/:ws/files/upload-urls',
    async (reqCtx) => {
      const result = await store.createUploadUrls(
        getUserId(reqCtx),
        reqCtx.valid.req.path.ws,
        reqCtx.valid.req.body.files,
      );
      metrics.addMetric('FileUploadUrls', MetricUnit.Count, result.uploads.length);
      return result;
    },
    { validation: { req: { path: WsPath, body: FileUploadRequest } } },
  );

  app.post(
    '/workspaces/:ws/files/download-urls',
    async (reqCtx) =>
      store.createDownloadUrls(
        getUserId(reqCtx),
        reqCtx.valid.req.path.ws,
        reqCtx.valid.req.body.ids,
      ),
    { validation: { req: { path: WsPath, body: FileDownloadRequest } } },
  );

  return app;
};
