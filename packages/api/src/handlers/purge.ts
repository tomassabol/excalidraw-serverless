import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { parser } from '@aws-lambda-powertools/batch/parser';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { DynamoDBStreamRecord } from '@aws-lambda-powertools/parser/schemas/dynamodb';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import type { Context, DynamoDBStreamEvent } from 'aws-lambda';
import { z } from 'zod';

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

/** The parts of a removed item the purge needs (OldImage is unmarshalled by Parser). */
const RemovedItem = z.object({
  PK: z.string().startsWith('WS#'),
  SK: z.string(),
  type: z.string().optional(),
  id: z.string().optional(),
});

// Parser validates and unmarshalls every stream record before our handler runs;
// records that fail parsing are reported as batch item failures.
const processor = new BatchProcessor(EventType.DynamoDBStreams, {
  parser,
  schema: DynamoDBStreamRecord,
  logger,
});

type ParsedRecord = z.infer<typeof DynamoDBStreamRecord>;

/**
 * Runs for items DynamoDB TTL removed (the event source mapping only passes
 * REMOVE events from the dynamodb.amazonaws.com service principal). For
 * scenes, the S3 objects are deleted; folders have none. Deleting is
 * idempotent, so stream retries are safe.
 */
export const recordHandler = async (record: ParsedRecord): Promise<void> => {
  const old = RemovedItem.safeParse(record.dynamodb.OldImage);
  if (!old.success) {
    logger.warn('Ignoring removed item without a workspace key', {
      keys: record.dynamodb.Keys,
    });
    return;
  }
  const item = old.data;
  if (item.type !== 'scene' || !item.id) {
    return;
  }
  const workspaceId = item.PK.slice('WS#'.length);
  const deleted = await store.deleteSceneObjects(workspaceId, item.id);
  metrics.addMetric('TrashPurged', MetricUnit.Count, 1);
  logger.info('Deleted objects of expired scene', { workspaceId, sceneId: item.id, deleted });
};

export const handler = middy<DynamoDBStreamEvent>()
  .use(captureLambdaHandler(tracer))
  .use(injectLambdaContext(logger))
  .use(logMetrics(metrics))
  .handler((event: DynamoDBStreamEvent, context: Context) =>
    processPartialResponse(event, recordHandler, processor, { context }),
  );
