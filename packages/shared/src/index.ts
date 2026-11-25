import { z } from 'zod';

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

/** Server-generated ids (UUID v4). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Excalidraw file ids: SHA-1 hex in practice; allow URL-safe ids up to 128 chars. */
export const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export type FileId = z.infer<typeof FileId>;

export const Name = z.string().trim().min(1).max(200);

export const TagName = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[^/#]+$/, 'Tag names cannot contain "/" or "#"');

export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const IsoDate = z.iso.datetime();

/** Images Excalidraw can embed. */
export const ImageMimeType = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  'image/avif',
  'image/jfif',
]);

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 100;

// -----------------------------------------------------------------------------
// Entities
// -----------------------------------------------------------------------------

export const Workspace = z.object({
  id: Id,
  name: Name,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Workspace = z.infer<typeof Workspace>;

export const Folder = z.object({
  id: Id,
  workspaceId: Id,
  parentId: Id.nullable(),
  name: Name,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Folder = z.infer<typeof Folder>;

export const SceneMeta = z.object({
  id: Id,
  workspaceId: Id,
  folderId: Id.nullable(),
  name: Name,
  tags: z.array(TagName),
  version: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type SceneMeta = z.infer<typeof SceneMeta>;

export const Tag = z.object({
  name: TagName,
  color: Color.nullable(),
  sceneCount: z.number().int().nonnegative(),
});
export type Tag = z.infer<typeof Tag>;

/** Excalidraw scene payload. Elements and appState are opaque to the API. */
export const SceneContent = z.object({
  elements: z.array(z.record(z.string(), z.unknown())),
  appState: z.record(z.string(), z.unknown()).default({}),
});
export type SceneContent = z.infer<typeof SceneContent>;

export const TrashItemType = z.enum(['folder', 'scene']);

export const TrashBatch = z.object({
  batchId: Id,
  deletedAt: IsoDate,
  expiresAt: IsoDate,
  root: z.object({ type: TrashItemType, id: Id, name: Name }),
  folderCount: z.number().int().nonnegative(),
  sceneCount: z.number().int().nonnegative(),
});
export type TrashBatch = z.infer<typeof TrashBatch>;

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

export const CreateWorkspaceBody = z.object({ name: Name });
export const UpdateWorkspaceBody = z.object({ name: Name });

export const CreateFolderBody = z.object({
  name: Name,
  parentId: Id.nullable().default(null),
});
export const UpdateFolderBody = z
  .object({ name: Name.optional(), parentId: Id.nullable().optional() })
  .refine((b) => b.name !== undefined || b.parentId !== undefined, 'Nothing to update');

export const CreateSceneBody = z.object({
  name: Name,
  folderId: Id.nullable().default(null),
  tags: z.array(TagName).max(20).default([]),
  content: SceneContent.optional(),
});
export const UpdateSceneBody = z
  .object({
    name: Name.optional(),
    folderId: Id.nullable().optional(),
    tags: z.array(TagName).max(20).optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.folderId !== undefined || b.tags !== undefined,
    'Nothing to update',
  );

export const SaveSceneContentBody = SceneContent.extend({
  /** The version the client's content is based on (optimistic concurrency). */
  baseVersion: z.number().int().nonnegative(),
});

export const UpsertTagBody = z.object({ color: Color.nullable() });

export const FileUploadRequest = z.object({
  files: z
    .array(
      z.object({
        id: FileId,
        mimeType: ImageMimeType,
        size: z.number().int().positive().max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_FILES_PER_REQUEST),
});

export const FileDownloadRequest = z.object({
  ids: z.array(FileId).min(1).max(MAX_FILES_PER_REQUEST),
});

export const SearchQuery = z.object({ q: z.string().trim().min(1).max(100) });

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const WorkspaceTree = z.object({
  workspace: Workspace,
  folders: z.array(Folder),
  scenes: z.array(SceneMeta),
  tags: z.array(Tag),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTree>;

export const SceneWithContent = z.object({
  scene: SceneMeta,
  content: SceneContent,
});
export type SceneWithContent = z.infer<typeof SceneWithContent>;

export const SaveSceneResult = z.object({
  version: z.number().int(),
  updatedAt: IsoDate,
  size: z.number().int(),
});
export type SaveSceneResult = z.infer<typeof SaveSceneResult>;

export const FileUploadResult = z.object({
  uploads: z.array(
    z.object({ id: FileId, url: z.url(), headers: z.record(z.string(), z.string()) }),
  ),
  existing: z.array(FileId),
});
export type FileUploadResult = z.infer<typeof FileUploadResult>;

export const FileDownloadResult = z.object({
  downloads: z.array(z.object({ id: FileId, url: z.url() })),
  missing: z.array(FileId),
});
export type FileDownloadResult = z.infer<typeof FileDownloadResult>;

export const SearchResult = z.object({
  folders: z.array(Folder),
  scenes: z.array(SceneMeta),
});
export type SearchResult = z.infer<typeof SearchResult>;

/** Body of a 409 returned when saving on top of a newer version. */
export const ConflictDetails = z.object({ currentVersion: z.number().int() });

/** Trash retention. */
export const TRASH_RETENTION_DAYS = 30;
