// API types. Mirrors packages/shared/src/index.ts (the API's zod schemas);
// duplicated here because the vendored app is a separate install root.

export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type Folder = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type SceneMeta = {
  id: string;
  workspaceId: string;
  folderId: string | null;
  name: string;
  tags: string[];
  version: number;
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type Tag = { name: string; color: string | null; sceneCount: number };

export type WorkspaceTree = {
  workspace: Workspace;
  folders: Folder[];
  scenes: SceneMeta[];
  tags: Tag[];
};

export type SceneContent = {
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
};

export type SceneWithContent = { scene: SceneMeta; content: SceneContent };

export type SaveSceneResult = {
  version: number;
  updatedAt: string;
  size: number;
};

export type TrashBatch = {
  batchId: string;
  deletedAt: string;
  expiresAt: string;
  root: { type: "folder" | "scene"; id: string; name: string };
  folderCount: number;
  sceneCount: number;
};

export type FileUploadResult = {
  uploads: { id: string; url: string; headers: Record<string, string> }[];
  existing: string[];
};

export type FileDownloadResult = {
  downloads: { id: string; url: string }[];
  missing: string[];
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
