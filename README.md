# excalidraw-serverless

A personal, self-hosted whiteboard based on [Excalidraw](https://github.com/excalidraw/excalidraw),
running fully serverless on AWS and scaling to zero.

- Cloud-saved scenes, organized in workspaces → nested folders → scenes, with collections as tags
- Search by name, trash with 30-day retention
- AWS Architecture Icons available out of the box in the library
- Single user, Cognito sign-in

> Not affiliated with or endorsed by the Excalidraw project. The vendored Excalidraw source
> under `vendor/excalidraw` is MIT-licensed; see [NOTICE](NOTICE).

## Status

Phases 0–2 done (bootstrap, stripped app, infrastructure). See [docs/PLAN.md](docs/PLAN.md).

## Develop

```bash
bun install            # root workspace (API, infra)
bun run web:install    # vendored Excalidraw app
bun run web:dev        # http://localhost:3001
bun run test           # API + infra tests
```

## Deploy

Requires AWS credentials for the target account and a one-time CDK bootstrap
in `eu-central-1`:

```bash
cd infra && bunx cdk bootstrap aws://<account-id>/eu-central-1
```

Then build and deploy everything (web app, API, auth, data):

```bash
bun run web:install && bun run web:build
cd infra && bunx cdk deploy --all -c ownerEmail=<your-email>
```

`ownerEmail` creates the single Cognito user (Cognito emails a temporary
password) and the monthly budget alert. The stack outputs include `AppUrl`;
`https://<AppUrl>/api/health` should return `{"status":"ok"}`.

Optional GitHub Actions deploys: deploy once with `-c githubOidc=true`
(add `-c githubOidcProviderArn=...` if the account already has the GitHub OIDC
provider), then set the repository variables `AWS_DEPLOY_ROLE_ARN` (stack
output) and `OWNER_EMAIL`, and run the **Deploy** workflow.
