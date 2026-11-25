import { UnauthorizedError } from '@aws-lambda-powertools/event-handler/http';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

type HasEvent = { event: unknown };

/**
 * Returns the Cognito `sub` of the caller. API Gateway's JWT authorizer has
 * already verified the token, so this only reads the verified claims.
 */
export const getUserId = (reqCtx: HasEvent): string => {
  const event = reqCtx.event as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>;
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedError('Missing verified user identity');
  }
  return sub;
};
