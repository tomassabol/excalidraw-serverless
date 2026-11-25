import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_authorizers as authorizers,
  aws_budgets as budgets,
  CfnOutput,
  aws_cloudfront as cloudfront,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_cognito as cognito,
  Duration,
  aws_dynamodb as dynamodb,
  aws_lambda_event_sources as eventSources,
  aws_events as events,
  Fn,
  aws_apigatewayv2_integrations as integrations,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_lambda_nodejs as nodejs,
  aws_cloudfront_origins as origins,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_sns as sns,
  aws_sns_subscriptions as snsSubscriptions,
  aws_sqs as sqs,
  aws_events_targets as targets,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { AppConfig } from './config.ts';
import { buildCsp, inlineScriptHashes } from './csp.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const API_SRC = path.join(REPO_ROOT, 'packages/api/src/handlers');

export interface AppStackProps extends StackProps {
  readonly config: AppConfig;
  readonly table: dynamodb.ITableV2;
  readonly dataBucket: s3.IBucket;
}

/**
 * Everything that can be recreated: auth, API, functions and the website.
 * All of it is pay-per-request, so the stack costs ~$0 when idle.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, table, dataBucket } = props;

    const webBuildDir = path.resolve(REPO_ROOT, 'infra', config.webBuildDir);
    const hasWebBuild = existsSync(path.join(webBuildDir, 'index.html'));

    // A short, stable, unique suffix for globally named resources.
    const suffix = Fn.select(0, Fn.split('-', Fn.select(2, Fn.split('/', this.stackId))));

    // -------------------------------------------------------------------------
    // Website bucket + CloudFront
    // -------------------------------------------------------------------------
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SPA routing: any path without a file extension serves index.html.
    // Attached only to the default (S3) behavior, never to /api/*.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.split('/').pop();
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`),
    });

    // -------------------------------------------------------------------------
    // API: HTTP API + Lambda
    // -------------------------------------------------------------------------
    const idempotencyTable = new dynamodb.TableV2(this, 'IdempotencyTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiration',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const commonEnv = {
      POWERTOOLS_METRICS_NAMESPACE: config.prefix,
      NODE_OPTIONS: '--enable-source-maps',
      TABLE_NAME: table.tableName,
      DATA_BUCKET_NAME: dataBucket.bucketName,
      IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
    };

    const fn = (
      id: string,
      entry: string,
      service: string,
      props: Partial<nodejs.NodejsFunctionProps>,
    ) =>
      new nodejs.NodejsFunction(this, id, {
        entry: path.join(API_SRC, entry),
        handler: 'handler',
        projectRoot: REPO_ROOT,
        depsLockFilePath: path.join(REPO_ROOT, 'bun.lock'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        tracing: lambda.Tracing.ACTIVE,
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        environment: { ...commonEnv, POWERTOOLS_SERVICE_NAME: service },
        bundling: {
          format: nodejs.OutputFormat.ESM,
          minify: true,
          sourceMap: true,
          mainFields: ['module', 'main'],
          // some dependencies still call require(); give ESM bundles one
          banner:
            "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
        ...props,
      });

    const apiFn = fn('ApiFunction', 'api.ts', 'api', {
      memorySize: 1024,
      timeout: Duration.seconds(10),
    });
    table.grantReadWriteData(apiFn);
    idempotencyTable.grantReadWriteData(apiFn);
    dataBucket.grantReadWrite(apiFn, 'ws/*');

    const purgeFn = fn('PurgeFunction', 'purge.ts', 'purge', {
      memorySize: 256,
      timeout: Duration.seconds(60),
    });
    dataBucket.grantDelete(purgeFn, 'ws/*');
    dataBucket.grantRead(purgeFn, 'ws/*');
    table.grantReadData(purgeFn);
    idempotencyTable.grantReadWriteData(purgeFn);
    // records that still fail after the retries are kept here for 14 days
    const purgeDlq = new sqs.Queue(this, 'PurgeDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    purgeFn.addEventSource(
      new eventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 25,
        retryAttempts: 5,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new eventSources.SqsDlq(purgeDlq),
        // only items removed by TTL
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('REMOVE'),
            userIdentity: {
              type: lambda.FilterRule.isEqual('Service'),
              principalId: lambda.FilterRule.isEqual('dynamodb.amazonaws.com'),
            },
          }),
        ],
      }),
    );

    // Weekly cleanup of S3 objects nothing references (unused images, scene
    // versions left behind by interrupted saves).
    const gcFn = fn('GcFunction', 'gc.ts', 'gc', {
      memorySize: 512,
      timeout: Duration.minutes(5),
    });
    table.grantReadData(gcFn);
    dataBucket.grantRead(gcFn, 'ws/*');
    dataBucket.grantDelete(gcFn, 'ws/*');
    new events.Rule(this, 'GcSchedule', {
      description: 'Weekly cleanup of unreferenced S3 objects',
      schedule: events.Schedule.cron({ minute: '0', hour: '3', weekDay: 'SUN' }),
      targets: [new targets.LambdaFunction(gcFn, { retryAttempts: 2 })],
    });

    // -------------------------------------------------------------------------
    // Cognito: one admin-created user, no self sign-up
    // -------------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 12,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolDomain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: Fn.join('-', ['whiteboard', suffix]) },
    });

    // The CSP pins the built page's inline scripts by hash and lists the
    // origins the app talks to (Cognito, the S3 data bucket for presigned
    // image URLs, and Excalidraw's public library site).
    const csp = buildCsp({
      scriptHashes: hasWebBuild
        ? inlineScriptHashes(readFileSync(path.join(webBuildDir, 'index.html'), 'utf8'))
        : [],
      connectSrc: [
        `https://cognito-idp.${this.region}.amazonaws.com`,
        userPoolDomain.baseUrl(),
        `https://${dataBucket.bucketRegionalDomainName}`,
        'https://libraries.excalidraw.com',
        'https://us-central1-excalidraw-room-persistence.cloudfunctions.net',
      ],
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
            override: true,
          },
        ],
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.prefix} web + API`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        // LIST lets S3 answer 404 (instead of 403) for files that don't exist
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    });

    const appUrl = `https://${distribution.distributionDomainName}`;
    const callbackPath = '/auth/callback';

    const userPoolClient = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: { user: false, userSrp: false, userPassword: false },
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [appUrl, ...config.devOrigins].map((o) => `${o}${callbackPath}`),
        logoutUrls: [appUrl, ...config.devOrigins].map((o) => `${o}/`),
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    if (config.ownerEmail) {
      // Cognito emails a temporary password; the first sign-in sets a new one.
      const owner = new cognito.CfnUserPoolUser(this, 'OwnerUser', {
        userPoolId: userPool.userPoolId,
        username: config.ownerEmail,
        desiredDeliveryMediums: ['EMAIL'],
        userAttributes: [
          { name: 'email', value: config.ownerEmail },
          { name: 'email_verified', value: 'true' },
        ],
      });
      // never delete the user just because ownerEmail was left out of a deploy
      owner.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: `${config.prefix} API`,
      // Same origin as the web app (CloudFront /api/*), so no CORS needed.
    });
    const stage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    stage?.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingRateLimit: 20,
      ThrottlingBurstLimit: 40,
    });

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      userPool.userPoolProviderUrl,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFn);

    httpApi.addRoutes({
      path: '/api/health',
      methods: [apigw.HttpMethod.GET],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });

    distribution.addBehavior(
      '/api/*',
      new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      }),
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: securityHeaders,
      },
    );

    // -------------------------------------------------------------------------
    // Web app deployment (built by `bun run web:build`)
    // -------------------------------------------------------------------------
    const runtimeConfig = {
      region: this.region,
      apiBaseUrl: '/api',
      auth: {
        authority: userPool.userPoolProviderUrl,
        domain: userPoolDomain.baseUrl(),
        clientId: userPoolClient.userPoolClientId,
        redirectPath: callbackPath,
      },
    };

    // Hashed and content-addressed assets: cache for a year. index.html,
    // 404.html, config.json and the AWS icon manifest are deployed separately
    // with no-cache so a deploy takes effect immediately.
    if (hasWebBuild) {
      new s3deploy.BucketDeployment(this, 'DeployAssets', {
        destinationBucket: webBucket,
        sources: [
          s3deploy.Source.asset(webBuildDir, {
            exclude: ['index.html', '404.html', 'aws-icons/library.json'],
          }),
        ],
        cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
        prune: false,
        memoryLimit: 1024,
      });
    }
    new s3deploy.BucketDeployment(this, 'DeployEntry', {
      destinationBucket: webBucket,
      sources: [
        ...(hasWebBuild
          ? [
              s3deploy.Source.asset(webBuildDir, {
                exclude: [
                  '**',
                  '!index.html',
                  '!404.html',
                  '!aws-icons',
                  '!aws-icons/library.json',
                ],
              }),
            ]
          : []),
        s3deploy.Source.jsonData('config.json', runtimeConfig),
      ],
      cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
      prune: false,
      distribution,
      distributionPaths: ['/index.html', '/404.html', '/config.json', '/aws-icons/library.json'],
    });

    // -------------------------------------------------------------------------
    // Alerts: budget, plus alarms emailed through SNS (only with an owner
    // email; CloudWatch alarms cost about $0.10 each per month)
    // -------------------------------------------------------------------------
    const ownerEmail = config.ownerEmail;
    if (ownerEmail) {
      const alerts = new sns.Topic(this, 'Alerts', { displayName: `${config.prefix} alerts` });
      // Confirm the subscription from the email AWS sends after the first deploy.
      alerts.addSubscription(new snsSubscriptions.EmailSubscription(ownerEmail));
      const notify = new cloudwatchActions.SnsAction(alerts);
      const alarm = (id: string, description: string, metric: cloudwatch.IMetric) => {
        const a = new cloudwatch.Alarm(this, id, {
          alarmDescription: description,
          metric,
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        a.addAlarmAction(notify);
        a.addOkAction(notify);
      };
      // The router turns handler errors into 500 responses, so 5xx from the
      // API covers both handler errors and Lambda crashes/timeouts.
      alarm(
        'Api5xxAlarm',
        'The API returned server errors',
        httpApi.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }),
      );
      alarm(
        'PurgeErrorsAlarm',
        'The purge Lambda failed',
        purgeFn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      );
      alarm(
        'PurgeDlqAlarm',
        'Expired items could not be purged; see the purge dead-letter queue',
        purgeDlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
      );
      alarm(
        'GcErrorsAlarm',
        'The weekly S3 cleanup failed',
        gcFn.metricErrors({ period: Duration.hours(1), statistic: 'Sum' }),
      );

      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `${config.prefix}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: config.budgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'ACTUAL',
            threshold,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: ownerEmail }],
        })),
      });
    }

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new CfnOutput(this, 'AppUrl', { value: appUrl });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'CognitoDomain', { value: runtimeConfig.auth.domain });
    new CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
