import { Router } from '@aws-lambda-powertools/event-handler/http';
import {
  metrics as metricsMiddleware,
  tracer as tracerMiddleware,
} from '@aws-lambda-powertools/event-handler/http/middleware';

import { getUserId } from './lib/auth.ts';
import { ConflictError } from './lib/errors.ts';
import { logger, metrics, tracer } from './lib/powertools.ts';

// CloudFront forwards /api/* to the HTTP API unchanged, so every route lives
// under the /api prefix.
export const app = new Router({ logger, prefix: '/api' });

app.use(tracerMiddleware(tracer));
app.use(metricsMiddleware(metrics));

app.errorHandler(ConflictError, async (error) => ({
  statusCode: 409,
  body: JSON.stringify(error.toJSON()),
  headers: { 'content-type': 'application/json' },
}));

// Public: no authorizer on this route (see infra AppStack).
app.get('/health', () => ({ status: 'ok' }));

app.get('/me', (reqCtx) => ({ userId: getUserId(reqCtx) }));
