import { describe, expect, test } from 'bun:test';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

import { app } from '../src/app.ts';

const context = { awsRequestId: 'test', functionName: 'api' } as unknown as Context;

const event = (path: string, sub?: string): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'example.test' },
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      ...(sub ? { authorizer: { jwt: { claims: { sub }, scopes: [] } } } : {}),
    },
  }) as unknown as APIGatewayProxyEventV2;

describe('api router', () => {
  test('GET /api/health is public', async () => {
    const res = await app.resolve(event('/api/health'), context);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({ status: 'ok' });
  });

  test('GET /api/me returns the verified sub', async () => {
    const res = await app.resolve(event('/api/me', 'user-123'), context);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '')).toEqual({ userId: 'user-123' });
  });

  test('GET /api/me without claims is 401', async () => {
    const res = await app.resolve(event('/api/me'), context);
    expect(res.statusCode).toBe(401);
  });

  test('unknown route is 404', async () => {
    const res = await app.resolve(event('/api/nope', 'user-123'), context);
    expect(res.statusCode).toBe(404);
  });
});
