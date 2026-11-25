import { getAccessToken, signIn } from "./auth";
import { loadConfig } from "./config";

import type {
  FileDownloadResult,
  FileUploadResult,
  Folder,
  SaveSceneResult,
  SceneContent,
  SceneMeta,
  SceneWithContent,
  TrashBatch,
  Workspace,
  WorkspaceTree,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  body?: unknown;
  /** Send an Idempotency-Key so retries of a create don't duplicate it. */
  idempotent?: boolean;
  signal?: AbortSignal;
};

const request = async <T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> => {
  const [config, token] = await Promise.all([loadConfig(), getAccessToken()]);
  if (!token) {
    await signIn();
    throw new ApiError(401, "Signing in");
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (opts.idempotent) {
    headers["idempotency-key"] = crypto.randomUUID();
  }

  const send = () =>
    fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });

  let res: Response;
  try {
    res = await send();
  } catch (error) {
    if (!opts.idempotent && method !== "GET") {
      throw error;
    }
    // network blip: retry once (safe for GETs and idempotent creates)
    res = await send();
  }

  if (res.status === 401) {
    await signIn();
    throw new ApiError(401, "Session expired");
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.message ?? `Request failed (${res.status})`,
      data?.details,
    );
  }
  return data as T;
};

const ws = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}`;

export const api = {
  listWorkspaces: () =>
    request<{ workspaces: Workspace[] }>("GET", "/workspaces").then(
      (r) => r.workspaces,
    ),
  createWorkspace: (name: string) =>
    request<Workspace>("POST", "/workspaces", {
      body: { name },
      idempotent: true,
    }),
  renameWorkspace: (workspaceId: string, name: string) =>
    request<Workspace>("PATCH", ws(workspaceId), { body: { name } }),
  deleteWorkspace: (workspaceId: string) =>
    request<void>("DELETE", ws(workspaceId)),
  getTree: (workspaceId: string) =>
    request<WorkspaceTree>("GET", `${ws(workspaceId)}/tree`),

  createFolder: (workspaceId: string, name: string, parentId: string | null) =>
    request<Folder>("POST", `${ws(workspaceId)}/folders`, {
      body: { name, parentId },
      idempotent: true,
    }),
  updateFolder: (
    workspaceId: string,
    folderId: string,
    patch: { name?: string; parentId?: string | null },
  ) =>
    request<Folder>("PATCH", `${ws(workspaceId)}/folders/${folderId}`, {
      body: patch,
    }),
  trashFolder: (workspaceId: string, folderId: string) =>
    request<{ trashBatchId: string; count: number }>(
      "DELETE",
      `${ws(workspaceId)}/folders/${folderId}`,
    ),

  createScene: (
    workspaceId: string,
    input: {
      name: string;
      folderId: string | null;
      tags?: string[];
      content?: SceneContent;
    },
  ) =>
    request<SceneMeta>("POST", `${ws(workspaceId)}/scenes`, {
      body: input,
      idempotent: true,
    }),
  getScene: (workspaceId: string, sceneId: string, signal?: AbortSignal) =>
    request<SceneWithContent>("GET", `${ws(workspaceId)}/scenes/${sceneId}`, {
      signal,
    }),
  saveScene: (
    workspaceId: string,
    sceneId: string,
    content: SceneContent & { baseVersion: number },
  ) =>
    request<SaveSceneResult>(
      "PUT",
      `${ws(workspaceId)}/scenes/${sceneId}/content`,
      { body: content },
    ),
  updateScene: (
    workspaceId: string,
    sceneId: string,
    patch: { name?: string; folderId?: string | null; tags?: string[] },
  ) =>
    request<SceneMeta>("PATCH", `${ws(workspaceId)}/scenes/${sceneId}`, {
      body: patch,
    }),
  trashScene: (workspaceId: string, sceneId: string) =>
    request<{ trashBatchId: string; count: number }>(
      "DELETE",
      `${ws(workspaceId)}/scenes/${sceneId}`,
    ),

  setTagColor: (workspaceId: string, name: string, color: string | null) =>
    request<{ name: string; color: string | null }>(
      "PUT",
      `${ws(workspaceId)}/tags/${encodeURIComponent(name)}`,
      { body: { color } },
    ),
  deleteTag: (workspaceId: string, name: string) =>
    request<{ scenesUpdated: number }>(
      "DELETE",
      `${ws(workspaceId)}/tags/${encodeURIComponent(name)}`,
    ),

  listTrash: (workspaceId: string) =>
    request<{ batches: TrashBatch[] }>("GET", `${ws(workspaceId)}/trash`).then(
      (r) => r.batches,
    ),
  restoreTrash: (workspaceId: string, batchId: string) =>
    request<{ restored: number }>(
      "POST",
      `${ws(workspaceId)}/trash/${batchId}/restore`,
    ),
  purgeTrash: (workspaceId: string, batchId: string) =>
    request<{ purged: number }>(
      "DELETE",
      `${ws(workspaceId)}/trash/${batchId}`,
    ),

  uploadUrls: (
    workspaceId: string,
    files: { id: string; mimeType: string; size: number }[],
  ) =>
    request<FileUploadResult>("POST", `${ws(workspaceId)}/files/upload-urls`, {
      body: { files },
    }),
  downloadUrls: (workspaceId: string, ids: string[]) =>
    request<FileDownloadResult>(
      "POST",
      `${ws(workspaceId)}/files/download-urls`,
      { body: { ids } },
    ),
};
