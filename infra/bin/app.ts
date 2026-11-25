import { App, Tags } from 'aws-cdk-lib';

import { AppStack } from '../lib/app-stack.ts';
import { loadConfig } from '../lib/config.ts';
import { DataStack } from '../lib/data-stack.ts';
import { GithubOidcStack } from '../lib/github-oidc-stack.ts';

const app = new App();
const config = loadConfig(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
};

const data = new DataStack(app, `${config.prefix}-Data`, {
  env,
  description: 'Whiteboard data: DynamoDB table and S3 data bucket (retained)',
});

new AppStack(app, `${config.prefix}-App`, {
  env,
  description: 'Whiteboard app: Cognito, HTTP API, Lambdas, CloudFront',
  config,
  table: data.table,
  dataBucket: data.dataBucket,
});

if (config.githubOidc) {
  new GithubOidcStack(app, `${config.prefix}-GithubOidc`, {
    env,
    description: 'GitHub Actions OIDC deploy role',
    repo: config.githubRepo,
    providerArn: config.githubOidcProviderArn,
  });
}

Tags.of(app).add('project', 'excalidraw-serverless');

app.synth();
