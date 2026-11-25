import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';

import { createClients, env } from '../lib/clients.ts';
import { logger, metrics, tracer } from '../lib/powertools.ts';
import { createStore } from '../store.ts';

const config = env();
const clients = createClients();
const store = createStore({
  ddb: clients.ddb,
  s3: clients.s3,
  tableName: config.tableName,
  dataBucket: config.dataBucket,
});

/** Weekly cleanup of S3 objects nothing references (scheduled by EventBridge). */
export const handler = middy()
  .use(captureLambdaHandler(tracer))
  .use(injectLambdaContext(logger))
  .use(logMetrics(metrics))
  .handler(async () => {
    const result = await store.collectGarbage();
    metrics.addMetric('GcFilesDeleted', MetricUnit.Count, result.filesDeleted);
    metrics.addMetric('GcSceneObjectsDeleted', MetricUnit.Count, result.sceneObjectsDeleted);
    logger.info('Garbage collection finished', { ...result });
    return result;
  });
