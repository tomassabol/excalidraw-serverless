import { CfnOutput, Duration, aws_iam as iam, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  /** "owner/repo" allowed to deploy. */
  readonly repo: string;
  /** Existing GitHub OIDC provider ARN; one is created when omitted. */
  readonly providerArn?: string;
}

/**
 * Role GitHub Actions assumes (via OIDC, no long-lived keys) to run
 * `cdk deploy`. It can only assume the CDK bootstrap roles.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const provider = props.providerArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'Provider', props.providerArn)
      : new iam.OpenIdConnectProvider(this, 'Provider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const role = new iam.Role(this, 'DeployRole', {
      description: `GitHub Actions deploy role for ${props.repo}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.repo}:ref:refs/heads/main`,
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
