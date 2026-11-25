import type { App } from 'aws-cdk-lib';

/**
 * Deploy-time settings. Personal values (the owner email) are passed with
 * `-c key=value` or a git-ignored cdk.context.local.json and never committed.
 */
export interface AppConfig {
  /** Stack name prefix. */
  readonly prefix: string;
  /** Email of the single Cognito user and the budget alert recipient. Optional. */
  readonly ownerEmail?: string;
  /** Monthly AWS budget alert threshold in USD. */
  readonly budgetUsd: number;
  /** Extra OAuth callback/logout origins for local development. */
  readonly devOrigins: string[];
  /** Path to the built web app (vendored Excalidraw). */
  readonly webBuildDir: string;
  /** Create the GitHub OIDC deploy role stack. */
  readonly githubOidc: boolean;
  /** "owner/repo" allowed to assume the deploy role. */
  readonly githubRepo: string;
  /** Set when the account already has the GitHub OIDC provider. */
  readonly githubOidcProviderArn?: string;
}

const str = (app: App, key: string): string | undefined => {
  const value = app.node.tryGetContext(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const loadConfig = (app: App): AppConfig => ({
  prefix: str(app, 'prefix') ?? 'Whiteboard',
  ownerEmail: str(app, 'ownerEmail'),
  budgetUsd: Number(str(app, 'budgetUsd') ?? 5),
  devOrigins: (str(app, 'devOrigins') ?? 'http://localhost:3001').split(','),
  webBuildDir: str(app, 'webBuildDir') ?? '../vendor/excalidraw/excalidraw-app/build',
  githubOidc: str(app, 'githubOidc') === 'true',
  githubRepo: str(app, 'githubRepo') ?? 'tomassabol/excalidraw-serverless',
  githubOidcProviderArn: str(app, 'githubOidcProviderArn'),
});
