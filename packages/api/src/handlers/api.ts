import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { correlationPaths } from '@aws-lambda-powertools/logger/correlationId';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import middy from '@middy/core';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

import { createApp } from '../app.ts';
import { createClients, env } from '../lib/clients.ts';
import { logger } from '../lib/powertools.ts';
import { createStore } from '../store.ts';

// Created once per execution environment (cold start) and reused.
const config = env();
const clients = createClients();
const app = createApp({
  store: createStore({
    ddb: clients.ddb,
    s3: clients.s3,
    tableName: config.tableName,
    dataBucket: config.dataBucket,
  }),
  idempotencyStore: new DynamoDBPersistenceLayer({
    tableName: config.idempotencyTableName,
    awsSdkV3Client: clients.dynamodb,
  }),
});

export const handler = middy<APIGatewayProxyEventV2>()
  .use(
    injectLambdaContext(logger, {
      correlationIdPath: correlationPaths.API_GATEWAY_HTTP,
    }),
  )
  .handler((event: APIGatewayProxyEventV2, context: Context) => app.resolve(event, context));
