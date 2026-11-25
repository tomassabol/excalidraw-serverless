import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import type { Context, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

import { logger, tracer } from '../lib/powertools.ts';

const processor = new BatchProcessor(EventType.DynamoDBStreams);

/**
 * Receives items removed by DynamoDB TTL (the event source mapping filters on
 * REMOVE events from the dynamodb.amazonaws.com service principal).
 * Phase 3 deletes the matching S3 objects here.
 */
const recordHandler = async (record: DynamoDBRecord): Promise<void> => {
  logger.info('Expired item removed', {
    pk: record.dynamodb?.Keys?.PK?.S,
    sk: record.dynamodb?.Keys?.SK?.S,
  });
};

export const handler = middy<DynamoDBStreamEvent>()
  .use(captureLambdaHandler(tracer))
  .use(injectLambdaContext(logger))
  .handler((event: DynamoDBStreamEvent, context: Context) =>
    processPartialResponse(event, recordHandler, processor, { context }),
  );
