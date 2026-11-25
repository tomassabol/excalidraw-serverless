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

- No secondary index: tree, search and trash read the whole workspace partition in one query, which is cheapest for a single user. Add an index only if a workspace grows to many thousands of items.
- Search: query the workspace partition and filter on `nameLower`.
- Trash: soft delete with a shared `trashBatchId`; TTL on `expiresAt`; stream → purge Lambda.
- Saves use optimistic concurrency (`baseVersion`); a mismatch returns 409.
- S3 keys: `ws/<ws>/scenes/<sceneId>.json`, `ws/<ws>/files/<fileId>` (content-addressed).

### API (Cognito JWT on every route except `/api/health`)

All routes are under `/api`; workspace content is nested under its workspace.

| Route                                             | Purpose                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `GET /health`                                     | Public liveness check                                       |
| `GET /me`                                         | Caller's user id                                            |
| `GET /workspaces`, `POST /workspaces`             | List / create (idempotent with `Idempotency-Key`)           |
| `PATCH /workspaces/:ws`, `DELETE /workspaces/:ws` | Rename / delete (only when empty, else 409)                 |
| `GET /workspaces/:ws/tree`                        | Live folders, scene metadata and tags                       |
| `GET /workspaces/:ws/search?q=`                   | Case-insensitive name search                                |
| `POST /workspaces/:ws/folders`                    | Create (idempotent)                                         |
| `PATCH /workspaces/:ws/folders/:id`               | Rename / move (cycle check)                                 |
| `DELETE /workspaces/:ws/folders/:id`              | Trash folder + subtree as one batch                         |
| `POST /workspaces/:ws/scenes`                     | Create, optionally with content (idempotent)                |
| `GET /workspaces/:ws/scenes/:id`                  | Metadata + content                                          |
| `PUT /workspaces/:ws/scenes/:id/content`          | Save with `baseVersion`; 409 + `currentVersion` on conflict |
| `PATCH /workspaces/:ws/scenes/:id`                | Rename / move / tags                                        |
| `DELETE /workspaces/:ws/scenes/:id`               | Trash                                                       |
| `PUT`/`DELETE /workspaces/:ws/tags/:name`         | Tag color / remove tag everywhere                           |
| `GET /workspaces/:ws/trash`                       | Trash batches                                               |
| `POST /workspaces/:ws/trash/:batchId/restore`     | Restore (root goes to workspace root if its parent is gone) |
| `DELETE /workspaces/:ws/trash/:batchId`           | Purge now                                                   |
| `POST /workspaces/:ws/files/upload-urls`          | Presigned PUTs for images not stored yet                    |
| `POST /workspaces/:ws/files/download-urls`        | Presigned GETs; reports missing ids                         |

Scene content is written to a new versioned object (`v<n>.json`) before the conditional `version` update, so a conflicting save never overwrites current content; the previous object is deleted after a successful save.

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
2. **Infrastructure (CDK)** (done): `Whiteboard-Data` (single table with TTL, stream, PITR, deletion protection; data bucket; retained) and `Whiteboard-App` (Cognito with admin-only sign-up and managed login, HTTP API with JWT authorizer and throttling, `api` + `purge` Lambdas on Node 24/arm64 with X-Ray, idempotency table, web bucket + CloudFront with OAC, SPA rewrite function, security headers and `/api/*` behavior, web deploy with runtime `config.json`, budget alert). Optional `Whiteboard-GithubOidc` deploy role and a manual Deploy workflow.
3. **Backend** (done): Powertools HTTP router with per-route zod validation (`@exs/shared` schemas), idempotent creates (Powertools Idempotency, separate table), Logger/Tracer/Metrics (per-route latency/error EMF plus SceneSaved, SceneBytes, SaveConflict, SceneCreated, ItemsTrashed, TrashPurged, FileUploadUrls), store for workspaces/folders/scenes/tags/trash/search/files, purge Lambda on Batch + Parser. Verified with `packages/api/scripts/e2e.ts` against the deployed stack.
4. **Frontend** (done, in `excalidraw-app/cloud/`): Cognito sign-in (oidc-client-ts, code + PKCE, tokens refreshed in the background), `/w/:ws/s/:scene` routing, autosave (1.5 s debounce, on tab hide, unload warning) with save status, conflict dialog (overwrite, or load the newer version after saving yours to a file), image upload/download via presigned URLs, and a docked workspace sidebar tab with workspace switcher, search, tag filters and colors, folder tree with inline rename and drag-and-drop, and trash with restore/purge.
5. **AWS icons** (done): `scripts/build-aws-icons.ts` (run by `bun run web:build`/`web:dev`) downloads the AWS Architecture Icons package pinned in `scripts/aws-icons.json` (SHA-256 checked), and writes 318 library items (48px service icons plus group icons, each an image + label, grouped) and content-addressed SVGs to `vendor/excalidraw/public/aws-icons/` (git-ignored). The app merges them into the library once per icon-set version and, when an icon is placed, fetches its SVG so it renders and is saved to S3 like any image. `library.json` is served no-cache; the SVGs are immutable.
6. **Hardening and docs** (done): self-hosted editor fonts; CSP with hashed inline scripts plus Permissions-Policy; 404s for missing files (OAC with list access); SNS alert topic with alarms for API 5xx, purge errors, purge dead-letter queue and cleanup errors; purge failures go to an SQS dead-letter queue; weekly cleanup Lambda for unreferenced images and stale scene versions; operations guide in the README.

## Working with the vendored app

- Upstream sync: `bun run upstream:pull` (`git subtree pull --prefix vendor/excalidraw upstream master --squash`).
- Keep new frontend code in `vendor/excalidraw/excalidraw-app/cloud/` and keep edits to existing upstream files small.
- The vendored app has its own bun install root (`bun run web:install`), separate from the root workspace.
- Phase 0 spike: `bun install --ignore-scripts` works for the vendored yarn monorepo (husky's `prepare` hook fails inside a subtree, so scripts are skipped). Vite must run on Node (`bunx vite`, not `bunx --bun vite`): under the bun runtime the build hung, under Node it finishes in ~10 s.
- Phase 1 notes: kept upstream behaviour that still works without a backend: browser-storage persistence and tab sync, image files in IndexedDB, "Browse libraries" (libraries.excalidraw.com), and library publishing (Excalidraw's public library backend). Edits stay in `excalidraw-app/` plus `public/` and the `.env.*` files; `packages/*` is untouched. Three `AnimationController` tests in `packages/excalidraw/tests/animation.test.ts` fail on pristine upstream too and are not related to these changes.
- Phase 2 notes: the API currently serves `GET /api/health` (public) and `GET /api/me`; the purge Lambda only logs. The data bucket allows CORS from any origin because presigned URL signatures gate access (and it avoids a cross-stack dependency on the CloudFront domain). The Cognito owner user is retained even if a deploy omits `ownerEmail`.
- Phase 3 notes: database-backed unit tests were dropped by choice (no DynamoDB emulator locally); `bun test` covers routing, auth and validation without a database, and `bun packages/api/scripts/e2e.ts` exercises the full API, presigned S3 uploads and the purge Lambda against a deployed stack with a throwaway user, then cleans up. Orphaned image files (no longer referenced by any scene) are not garbage-collected yet.
- Phase 4 notes: search and tag filtering run on the already-loaded tree in the browser (same results as the search endpoint, no round trip). Local development: put `VITE_APP_DEV_BACKEND_URL=https://<AppUrl>` in `vendor/excalidraw/.env.development.local`; the dev server proxies `/api` and `/config.json` there, and `http://localhost:3001` is an allowed Cognito callback. The editor still loads its hand-drawn fonts from Excalidraw's public font CDN; self-hosting them belongs to the hardening phase (together with the CSP).
- Phase 5 notes: one small patch to the vendored editor (`packages/excalidraw/hooks/useLibraryItemSvg.ts`, marked "excalidraw-serverless patch") adds `setLibraryFilesResolver`, so library thumbnails can render image elements; upstream renders previews without files. To pick up a new AWS icon release, update the URL and SHA-256 in `scripts/aws-icons.json`.
- Phase 6 notes: two more small vendored patches, both marked "excalidraw-serverless patch": `scripts/woff2/woff2-vite-plugins.js` serves fonts from our origin, and `packages/excalidraw/fonts/ExcalidrawFontFace.ts` skips the esm.sh font fallback when `window.EXCALIDRAW_SELF_HOSTED_FONTS` is set (otherwise Chrome tries the fallback URLs and the CSP blocks them). The CSP's inline script hashes come from the built `index.html` at deploy time, so build before deploying. Alarms cost about $0.10 each per month and are only created with `ownerEmail`.
