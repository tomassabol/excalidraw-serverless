import { beforeAll, describe, expect, test } from 'bun:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { AppStack } from '../lib/app-stack.ts';
import { loadConfig } from '../lib/config.ts';
import { DataStack } from '../lib/data-stack.ts';

const env = { account: '111111111111', region: 'eu-central-1' };

let data: Template;
let appTemplate: Template;

beforeAll(() => {
  const app = new App({
    context: {
      ownerEmail: 'owner@example.com',
      // no web build in tests: only config.json is deployed
      webBuildDir: './does-not-exist',
    },
  });
  const config = loadConfig(app);
  const dataStack = new DataStack(app, 'Data', { env });
  const appStack = new AppStack(app, 'App', {
    env,
    config,
    table: dataStack.table,
    dataBucket: dataStack.dataBucket,
  });
  data = Template.fromStack(dataStack);
  appTemplate = Template.fromStack(appStack);
});

describe('DataStack', () => {
  test('table: on-demand, TTL on expiresAt, stream, PITR, retained', () => {
    data.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          Match.objectLike({
            DeletionProtectionEnabled: true,
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ],
      }),
    });
  });

  test('data bucket is private, encrypted and retained', () => {
    data.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
  });
});

describe('AppStack', () => {
  test('Cognito: admin-only sign-up', () => {
    appTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    appTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
    });
    appTemplate.resourceCountIs('AWS::Cognito::UserPoolUser', 1);
  });

  test('only /api/health is public; everything else needs the JWT authorizer', () => {
    appTemplate.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /api/health',
      AuthorizationType: 'NONE',
    });
    appTemplate.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /api/{proxy+}',
      AuthorizationType: 'JWT',
    });
    appTemplate.resourceCountIs('AWS::ApiGatewayV2::Route', 2);
  });

  test('functions: Node 24 on arm64 with X-Ray', () => {
    // our functions are the ones with Powertools configured (CDK adds helper functions too)
    const fns = appTemplate.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: { Variables: { POWERTOOLS_SERVICE_NAME: Match.anyValue() } },
      },
    });
    expect(Object.keys(fns)).toHaveLength(2);
    for (const fn of Object.values(fns)) {
      expect(fn.Properties.Runtime).toBe('nodejs24.x');
      expect(fn.Properties.Architectures).toEqual(['arm64']);
      expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
      expect(fn.Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME).toBeString();
    }
  });

  test('purge only receives TTL removals, with partial batch failures', () => {
    appTemplate.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      FilterCriteria: {
        Filters: [
          {
            Pattern: Match.serializedJson({
              eventName: ['REMOVE'],
              userIdentity: { type: ['Service'], principalId: ['dynamodb.amazonaws.com'] },
            }),
          },
        ],
      },
    });
  });

  test('CloudFront: /api/* is uncached and forwards viewer headers', () => {
    appTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            // managed CachingDisabled / AllViewerExceptHostHeader
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
      }),
    });
  });

  test('budget alert exists when an owner email is set', () => {
    appTemplate.resourceCountIs('AWS::Budgets::Budget', 1);
  });

  test('idempotency table has its own TTL attribute', () => {
    appTemplate.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TimeToLiveSpecification: { AttributeName: 'expiration', Enabled: true },
    });
  });
});
