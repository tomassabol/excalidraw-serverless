# excalidraw-serverless

A personal, self-hosted whiteboard based on [Excalidraw](https://github.com/excalidraw/excalidraw),
running fully serverless on AWS and scaling to zero.

- Cloud-saved scenes with autosave, organized in workspaces → nested folders → scenes,
  with collections as colored tags
- Search, drag-and-drop, trash with 30-day retention
- AWS Architecture Icons built into the library
- Single user, Cognito sign-in

> Not affiliated with or endorsed by the Excalidraw project. The vendored Excalidraw source
> under `vendor/excalidraw` is MIT-licensed; see [NOTICE](NOTICE).

The design, decisions and history are in [docs/PLAN.md](docs/PLAN.md).

## Architecture

```
Browser ── CloudFront ─┬─ S3 web bucket (static app, fonts, AWS icons)
                       └─ /api/* ─ HTTP API (Cognito JWT) ─ Lambda "api" ─┬─ DynamoDB (metadata)
                                                                          └─ S3 data bucket (scenes, images)
Browser ── presigned URLs ── S3 data bucket (image upload/download)
DynamoDB TTL ── stream ── Lambda "purge" (deletes expired scenes' objects; failures → SQS DLQ)
EventBridge (weekly) ── Lambda "gc" (deletes unreferenced images and stale scene versions)
```

| Path                 | What                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `vendor/excalidraw/` | Excalidraw (git subtree of upstream `master`); the app shell in `excalidraw-app/` is ours, new code in `excalidraw-app/cloud/` |
| `packages/api/`      | Lambda handlers on Powertools for AWS Lambda (router, validation, idempotency, logs, traces, metrics, batch)                   |
| `packages/shared/`   | zod schemas for the API                                                                                                        |
| `infra/`             | CDK app: `Whiteboard-Data` (retained data), `Whiteboard-App` (everything else), optional `Whiteboard-GithubOidc`               |
| `scripts/`           | AWS icon library generator                                                                                                     |

## Develop

```bash
bun install            # root workspace (API, infra)
bun run web:install    # vendored Excalidraw app
bun run web:dev        # http://localhost:3001 (see below for a backend)
bun run test           # API + infra tests
bun run lint           # Biome (our code; the vendored app uses its own ESLint/Prettier)
```

To run the web app locally against a deployed stack, create
`vendor/excalidraw/.env.development.local` with
`VITE_APP_DEV_BACKEND_URL=https://<AppUrl>`; the dev server proxies `/api` and
`/config.json` there and you sign in with the same Cognito user
(`http://localhost:3001` is an allowed callback URL).

Checks for the vendored app (run in `vendor/excalidraw`): `./node_modules/.bin/tsc`,
`./node_modules/.bin/eslint --ext .ts,.tsx excalidraw-app`.

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

`ownerEmail` creates the Cognito user (Cognito emails a temporary password), the
monthly budget alert and the alarm emails. After the first deploy, **confirm the
SNS subscription** from the email AWS sends, or alarms won't reach you. The stack
outputs include `AppUrl`; `https://<AppUrl>/api/health` should return `{"status":"ok"}`.

The web build must exist before `cdk deploy`: the CSP pins the page's inline
scripts by hash, read from the built `index.html`.

End-to-end check of a deployed stack (uses a throwaway user and cleans up):

```bash
AWS_PROFILE=<profile> bun packages/api/scripts/e2e.ts
```

Optional GitHub Actions deploys: deploy once with `-c githubOidc=true`
(add `-c githubOidcProviderArn=...` if the account already has the GitHub OIDC
provider), then set the repository variables `AWS_DEPLOY_ROLE_ARN` (stack
output) and `OWNER_EMAIL`, and run the **Deploy** workflow.

## Operations

### Users and sign-in

Self sign-up is off. Manage the user with the AWS CLI (pool id is the
`UserPoolId` stack output):

```bash
# resend the invitation / temporary password
aws cognito-idp admin-create-user --user-pool-id <pool> --username <email> --message-action RESEND

# set a new password directly (user is not asked to change it)
aws cognito-idp admin-set-user-password --user-pool-id <pool> --username <email> --password '<password>' --permanent
```

Optional TOTP MFA can be set up per user. Tokens last an hour and refresh in the
background for 30 days.

### Alerts

With `ownerEmail` set, CloudWatch alarms email you (and again when they recover):

| Alarm              | Fires when                                                                         |
| ------------------ | ---------------------------------------------------------------------------------- |
| `Api5xxAlarm`      | the API returns any 5xx in 5 minutes                                               |
| `PurgeErrorsAlarm` | the purge Lambda errors                                                            |
| `PurgeDlqAlarm`    | an expired item couldn't be purged after retries (message in the `PurgeDlq` queue) |
| `GcErrorsAlarm`    | the weekly cleanup fails                                                           |

Logs are kept for 30 days in CloudWatch Logs (structured JSON, with correlation
IDs). Traces are in X-Ray; metrics are in the `Whiteboard` CloudWatch namespace.

### Costs

Everything is pay-per-request, so an idle month costs cents: S3 storage, the
four alarms (about $0.10 each), and Cognito's free tier for one user. A monthly
budget alert (default $5, `-c budgetUsd=<n>`) emails you at 80% and 100%.

### Data and backups

- `Whiteboard-Data` (DynamoDB table, S3 data bucket) and the Cognito user pool
  are retained when stacks are deleted. The table has point-in-time recovery
  and deletion protection.
- Trash entries expire after 30 days; the purge Lambda then deletes their S3
  objects. "Delete forever" in the UI does it immediately.
- Every Sunday at 03:00 UTC the cleanup Lambda deletes images no scene uses and
  scene objects that aren't a scene's current version, if they're older than a day.

### Updating Excalidraw

```bash
bun run upstream:pull       # git subtree pull of excalidraw/excalidraw master
bun run web:install && bun run web:build
```

Expect conflicts only in the few upstream files we changed: the app shell
(`excalidraw-app/App.tsx`, `components/`, `index.html`, `vite.config.mts`) and
the small patches marked `excalidraw-serverless patch`:
`scripts/woff2/woff2-vite-plugins.js` and `packages/excalidraw/fonts/ExcalidrawFontFace.ts`
(self-hosted fonts), `packages/excalidraw/hooks/useLibraryItemSvg.ts` (library previews).

### Updating the AWS icons

Update `url` and `sha256` in `scripts/aws-icons.json` to the new package from
<https://aws.amazon.com/architecture/icons/> (`shasum -a 256 <zip>`), then
rebuild and deploy. Browsers replace their built-in icons on next load.

### Security notes

- Both buckets block public access; the web bucket is only reachable through
  CloudFront (OAC), the data bucket only with short-lived presigned URLs.
- CloudFront sends a strict CSP (inline scripts pinned by hash, no `eval`;
  inline styles are allowed because the editor needs them), HSTS,
  `X-Frame-Options: DENY`, `nosniff`, a referrer policy and `noindex`.
- The API is throttled (20 req/s, burst 40) and every route except
  `/api/health` requires a Cognito access token.
