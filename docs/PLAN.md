# Plan

## Decisions

|           |                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base      | Vendored Excalidraw (`git subtree` of upstream `master`, pinned commit) under `vendor/excalidraw`                                                      |
| Users     | Single user, Cognito user pool with self-signup disabled                                                                                               |
| Features  | Cloud-saved scenes; workspace → nested folder tree → scene; collections as tags; name search; trash (30 days); built-in AWS Architecture Icons library |
| Removed   | Live collaboration, share links, offline sync, AI, Firebase, Excalidraw+ promos, tracking                                                              |
| Stack     | AWS CDK (TypeScript) + bun, Powertools for AWS Lambda (TypeScript), eu-central-1, CloudFront default domain                                            |
| Idle cost | ~$0: no VPC, NAT, RDS or containers                                                                                                                    |

## Architecture

```
Browser ── CloudFront ─┬─ S3 web bucket (static build, private, OAC)
                       └─ /api/* ─ API Gateway HTTP API (Cognito JWT authorizer)
                                         └─ Lambda "api" (Node 22, arm64, Powertools HTTP router)
                                              ├─ DynamoDB main table (on-demand, single table)
                                              ├─ DynamoDB idempotency table (on-demand)
                                              └─ S3 data bucket (scene JSON + image files)
Browser ── presigned URLs ── S3 data bucket (images up/down directly)
DynamoDB TTL expiry ─ Stream ─ Lambda "purge" (Powertools Batch) ─ deletes S3 objects
```

### Data model (main table)

| PK           | SK            | Item                                                                        |
| ------------ | ------------- | --------------------------------------------------------------------------- |
| `USER#<sub>` | `WS#<wsId>`   | Workspace membership                                                        |
| `WS#<wsId>`  | `META`        | Workspace                                                                   |
| `WS#<wsId>`  | `FOLDER#<id>` | parentId, name, nameLower, deletedAt?, trashBatchId?, expiresAt?            |
| `WS#<wsId>`  | `SCENE#<id>`  | folderId, name, nameLower, tags[], version, updatedAt, s3Key, deletedAt?, … |
| `WS#<wsId>`  | `TAG#<name>`  | Collection (tag) definition                                                 |

- GSI1 (`WS#<ws>#P#<parentId>`, `<type>#<nameLower>`): list a folder's children.
- Search: query the workspace partition and filter on `nameLower`.
- Trash: soft delete with a shared `trashBatchId`; TTL on `expiresAt`; stream → purge Lambda.
- Saves use optimistic concurrency (`baseVersion`); a mismatch returns 409.
- S3 keys: `ws/<ws>/scenes/<sceneId>.json`, `ws/<ws>/files/<fileId>` (content-addressed).

### API (Cognito JWT on every route)

- `GET/POST/PATCH/DELETE /workspaces[/:id]`, `GET /workspaces/:id/tree`
- `POST/PATCH/DELETE /folders[/:id]`
- `POST /scenes`, `GET/PUT/PATCH /scenes/:id`
- `POST /workspaces/:id/files/upload-urls`, `POST /workspaces/:id/files/download-urls`
- `GET /workspaces/:id/search?q=`
- `GET /workspaces/:id/trash`, `POST /trash/:batchId/restore`, `DELETE /trash/:batchId`

### Powertools usage (`@aws-lambda-powertools/*` 2.37.0)

| Utility                      | Use                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Event Handler `/http` Router | All routes, path params, middleware, per-route `validation` (zod), `errorHandler`; custom `ConflictError extends HttpError` for 409 |
| Parser                       | DynamoDB stream records in the purge Lambda; shared zod schemas in `packages/shared`                                                |
| Logger                       | Structured logs, request ID as correlation ID, `POWERTOOLS_DEV` locally                                                             |
| Tracer                       | X-Ray on both Lambdas, wrapped AWS SDK clients (HTTP APIs don't support X-Ray, so traces start at Lambda)                           |
| Metrics                      | EMF: cold start, SceneSaved, SaveConflict, SceneBytes, FilesUploaded, TrashPurged                                                   |
| Batch Processing             | Purge Lambda with partial batch failures                                                                                            |
| Idempotency                  | `POST` create routes (`Idempotency-Key` header) and purge records; separate table, because a table has only one TTL attribute       |

## Phases

0. **Bootstrap** (done): repo, vendored Excalidraw, bun workspace, Biome, CI, license.
1. **Strip the vendored app** (done): removed Firebase, collab, share links, AI/text-to-diagram, Excalidraw+ integration and promos, Sentry, analytics, PWA/service worker and social links; rebranded to "Whiteboard" with `noindex`. Scenes persist to browser storage until Phase 4.
2. **Infrastructure (CDK)** (done): `Whiteboard-Data` (single table with GSI1, TTL, stream, PITR, deletion protection; data bucket; retained) and `Whiteboard-App` (Cognito with admin-only sign-up and managed login, HTTP API with JWT authorizer and throttling, `api` + `purge` Lambdas on Node 24/arm64 with X-Ray, idempotency table, web bucket + CloudFront with OAC, SPA rewrite function, security headers and `/api/*` behavior, web deploy with runtime `config.json`, budget alert). Optional `Whiteboard-GithubOidc` deploy role and a manual Deploy workflow.
3. **Backend**: Powertools router, routes, repositories, purge handler, tests.
4. **Frontend** (`excalidraw-app/cloud/`): OIDC sign-in, routes, sidebar (workspaces, folder tree, tags, search, trash), autosave with conflict handling, image upload via presigned URLs.
5. **AWS icons**: build-time download of the AWS Architecture Icons package, converted into a built-in library (never committed).
6. **Hardening and docs**: CSP, log retention, alarms, README.

## Working with the vendored app

- Upstream sync: `bun run upstream:pull` (`git subtree pull --prefix vendor/excalidraw upstream master --squash`).
- Keep new frontend code in `vendor/excalidraw/excalidraw-app/cloud/` and keep edits to existing upstream files small.
- The vendored app has its own bun install root (`bun run web:install`), separate from the root workspace.
- Phase 0 spike: `bun install --ignore-scripts` works for the vendored yarn monorepo (husky's `prepare` hook fails inside a subtree, so scripts are skipped). Vite must run on Node (`bunx vite`, not `bunx --bun vite`): under the bun runtime the build hung, under Node it finishes in ~10 s.
- Phase 1 notes: kept upstream behaviour that still works without a backend: browser-storage persistence and tab sync, image files in IndexedDB, "Browse libraries" (libraries.excalidraw.com), and library publishing (Excalidraw's public library backend). Edits stay in `excalidraw-app/` plus `public/` and the `.env.*` files; `packages/*` is untouched. Three `AnimationController` tests in `packages/excalidraw/tests/animation.test.ts` fail on pristine upstream too and are not related to these changes.
- Phase 2 notes: the API currently serves `GET /api/health` (public) and `GET /api/me`; the purge Lambda only logs. The data bucket allows CORS from any origin because presigned URL signatures gate access (and it avoids a cross-stack dependency on the CloudFront domain). The Cognito owner user is retained even if a deploy omits `ownerEmail`.
