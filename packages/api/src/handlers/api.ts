import { correlationPaths } from '@aws-lambda-powertools/logger/correlationId';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import middy from '@middy/core';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

import { app } from '../app.ts';
import { logger } from '../lib/powertools.ts';

export const handler = middy<APIGatewayProxyEventV2>()
  .use(
    injectLambdaContext(logger, {
      correlationIdPath: correlationPaths.API_GATEWAY_HTTP,
    }),
  )
  .handler((event: APIGatewayProxyEventV2, context: Context) => app.resolve(event, context));
