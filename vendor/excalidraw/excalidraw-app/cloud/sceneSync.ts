import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { clearAppStateForDatabase } from "@excalidraw/excalidraw/appState";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { openConfirmModal } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirmState";
import {
  hashElementsVersion,
  isInitializedImageElement,
} from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { updateStaleImageStatuses } from "../data/FileManager";

import { ApiError, api } from "./api";
import { MAX_FILE_BYTES } from "./types";

import type { SceneMeta } from "./types";

export type SyncStatus =
  | "idle"
  | "loading"
  | "saved"
  | "dirty"
  | "saving"
  | "error"
  | "conflict";

type Listener = {
  onStatus: (status: SyncStatus, error?: string) => void;
  /** Called after a save or load with the server's view of the scene. */
  onScene: (scene: SceneMeta) => void;
  /** Called when the open scene no longer exists (trashed or deleted). */
  onSceneMissing: (workspaceId: string, sceneId: string) => void;
};

const SAVE_DEBOUNCE_MS = 1500;
const RETRY_DELAY_MS = 10_000;

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const imageFileIds = (elements: readonly ExcalidrawElement[]) => {
  const ids = new Set<FileId>();
  for (const element of elements) {
    if (!element.isDeleted && isInitializedImageElement(element)) {
      ids.add(element.fileId);
    }
  }
  return [...ids];
};

/**
 * Keeps the open Excalidraw scene in sync with the API:
 * loads scenes, autosaves changes (debounced), uploads images first, and
 * resolves version conflicts with the user.
 */
export class SceneSync {
  private workspaceId: string | null = null;
  private sceneId: string | null = null;
  private version = 0;
  /** Change key of the content last saved (or loaded). */
  private savedKey: string | null = null;
  private status: SyncStatus = "idle";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private openToken = 0;
  /** File ids known to be stored for the current workspace. */
  private storedFiles = new Set<string>();
  private storedFilesWorkspace: string | null = null;
  private warnedOversize = new Set<string>();
  private lastMeta: SceneMeta | null = null;

  constructor(
    private readonly excalidrawAPI: ExcalidrawImperativeAPI,
    private readonly listener: Listener,
  ) {}

  get current() {
    return { workspaceId: this.workspaceId, sceneId: this.sceneId };
  }

  get hasUnsavedChanges() {
    return (
      this.status === "dirty" ||
      this.status === "saving" ||
      this.status === "error" ||
      this.status === "conflict"
    );
  }

  private setStatus(status: SyncStatus, error?: string) {
    this.status = status;
    this.listener.onStatus(status, error);
  }

  private changeKey(
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
  ) {
    return `${hashElementsVersion(elements)}:${JSON.stringify(
      clearAppStateForDatabase(appState),
    )}`;
  }

  // ------------------------------------------------------------------ open

  /** Saves pending changes of the current scene, then loads another one. */
  async open(
    workspaceId: string,
    sceneId: string,
    {
      force = false,
      // set when called from inside a save (conflict reload): waiting for
      // that save would wait for ourselves
      skipFlush = false,
    } = {},
  ) {
    if (
      !force &&
      this.workspaceId === workspaceId &&
      this.sceneId === sceneId &&
      this.status !== "idle"
    ) {
      return;
    }
    if (!skipFlush) {
      await this.flush();
    }
    const token = ++this.openToken;
    this.clearTimer();
    this.workspaceId = workspaceId;
    this.sceneId = sceneId;
    this.savedKey = null;
    this.setStatus("loading");

    if (this.storedFilesWorkspace !== workspaceId) {
      this.storedFiles = new Set();
      this.storedFilesWorkspace = workspaceId;
    }

    let data;
    try {
      data = await api.getScene(workspaceId, sceneId);
    } catch (error) {
      if (token !== this.openToken) {
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        this.workspaceId = null;
        this.sceneId = null;
        this.setStatus("idle");
        this.listener.onSceneMissing(workspaceId, sceneId);
        return;
      }
      this.setStatus("error", (error as Error).message);
      return;
    }
    if (token !== this.openToken) {
      return;
    }

    const api_ = this.excalidrawAPI;
    const elements = restoreElements(
      data.content.elements as unknown as ExcalidrawElement[],
      null,
      { repairBindings: true },
    );
    // keep local UI preferences (theme, zoom tool state...) from the editor
    const appState = restoreAppState(
      data.content.appState as Partial<AppState>,
      api_.getAppState(),
    );
    api_.updateScene({
      elements,
      appState: { ...appState, name: data.scene.name },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api_.history.clear();
    this.version = data.scene.version;
    this.lastMeta = data.scene;
    this.listener.onScene(data.scene);

    await nextFrame();
    if (token !== this.openToken) {
      return;
    }
    const visible = api_.getSceneElements();
    if (visible.length) {
      api_.setViewport({ target: visible, fit: "scale-down" });
    }
    this.savedKey = this.changeKey(
      api_.getSceneElementsIncludingDeleted(),
      api_.getAppState(),
    );
    this.setStatus("saved");
    void this.loadImages(workspaceId, imageFileIds(elements), token);
  }

  /** Forgets the open scene (e.g. it was trashed from the sidebar). */
  close() {
    this.openToken++;
    this.clearTimer();
    this.workspaceId = null;
    this.sceneId = null;
    this.savedKey = null;
    this.setStatus("idle");
  }

  private async loadImages(workspaceId: string, ids: FileId[], token: number) {
    if (!ids.length) {
      return;
    }
    const api_ = this.excalidrawAPI;
    try {
      const erroredFiles = new Map<FileId, true>();
      for (let i = 0; i < ids.length; i += 100) {
        const { downloads, missing } = await api.downloadUrls(
          workspaceId,
          ids.slice(i, i + 100),
        );
        for (const id of missing) {
          erroredFiles.set(id as FileId, true);
        }
        const loaded = await Promise.all(
          downloads.map(async ({ id, url }): Promise<BinaryFileData | null> => {
            try {
              const res = await fetch(url);
              if (!res.ok) {
                throw new Error(String(res.status));
              }
              const blob = await res.blob();
              this.storedFiles.add(id);
              return {
                id: id as FileId,
                dataURL: (await blobToDataURL(
                  blob,
                )) as BinaryFileData["dataURL"],
                mimeType: (blob.type ||
                  "image/png") as BinaryFileData["mimeType"],
                created: Date.now(),
                lastRetrieved: Date.now(),
              };
            } catch {
              erroredFiles.set(id as FileId, true);
              return null;
            }
          }),
        );
        if (token !== this.openToken) {
          return;
        }
        api_.addFiles(loaded.filter((f): f is BinaryFileData => !!f));
      }
      if (erroredFiles.size) {
        updateStaleImageStatuses({
          excalidrawAPI: api_,
          erroredFiles,
          elements: api_.getSceneElementsIncludingDeleted(),
        });
      }
    } catch (error) {
      console.error("Loading images failed", error);
    }
  }

  // ----------------------------------------------------------------- saves

  /** Call from Excalidraw's onChange. Cheap when nothing changed. */
  onChange(elements: readonly ExcalidrawElement[], appState: AppState) {
    if (
      !this.sceneId ||
      this.savedKey === null ||
      this.status === "loading" ||
      this.status === "conflict"
    ) {
      return;
    }
    if (this.changeKey(elements, appState) === this.savedKey) {
      return;
    }
    if (this.status !== "saving") {
      this.setStatus("dirty");
    }
    this.scheduleSave(SAVE_DEBOUNCE_MS);
  }

  private clearTimer() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private scheduleSave(delay: number) {
    this.clearTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, delay);
  }

  /** Saves now if there are unsaved changes and waits for it. */
  async flush() {
    this.clearTimer();
    if (this.saving) {
      await this.saving;
    }
    if (this.status === "dirty" || this.status === "error") {
      await this.save();
    }
  }

  private save(): Promise<void> {
    if (this.saving) {
      // a save is running; save again once it's done
      return this.saving.then(() => {
        if (this.status === "dirty") {
          return this.save();
        }
      });
    }
    this.saving = this.doSave().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async doSave() {
    const { workspaceId, sceneId } = this;
    if (!workspaceId || !sceneId || this.savedKey === null) {
      return;
    }
    const api_ = this.excalidrawAPI;
    const elements = api_.getSceneElementsIncludingDeleted();
    const appState = api_.getAppState();
    const key = this.changeKey(elements, appState);
    if (key === this.savedKey) {
      this.setStatus("saved");
      return;
    }
    this.setStatus("saving");
    try {
      await this.uploadImages(workspaceId, elements);
      const { elements: savedElements, appState: savedAppState } = JSON.parse(
        serializeAsJSON(elements, appState, {}, "database"),
      );
      const result = await api.saveScene(workspaceId, sceneId, {
        baseVersion: this.version,
        elements: savedElements,
        appState: savedAppState,
      });
      if (this.sceneId !== sceneId) {
        return;
      }
      this.version = result.version;
      this.savedKey = key;
      this.listener.onScene({
        ...(this.lastMeta ?? ({} as SceneMeta)),
        id: sceneId,
        workspaceId,
        version: result.version,
        updatedAt: result.updatedAt,
        size: result.size,
      });
      const latest = this.changeKey(
        api_.getSceneElementsIncludingDeleted(),
        api_.getAppState(),
      );
      if (latest !== key) {
        this.setStatus("dirty");
        this.scheduleSave(SAVE_DEBOUNCE_MS);
      } else {
        this.setStatus("saved");
      }
    } catch (error) {
      if (this.sceneId !== sceneId) {
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        await this.resolveConflict(
          workspaceId,
          sceneId,
          Number(error.details?.currentVersion),
        );
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        this.close();
        this.listener.onSceneMissing(workspaceId, sceneId);
        return;
      }
      this.setStatus("error", (error as Error).message);
      this.scheduleSave(RETRY_DELAY_MS);
    }
  }

  /** Remember the latest metadata so save updates keep name/tags/folder. */
  rememberMeta(scene: SceneMeta) {
    if (scene.id === this.sceneId) {
      this.lastMeta = scene;
    }
  }

  private async resolveConflict(
    workspaceId: string,
    sceneId: string,
    currentVersion: number,
  ) {
    this.setStatus("conflict");
    const keepMine = await openConfirmModal({
      title: "This scene changed somewhere else",
      description:
        "A newer version was saved from another tab or device. Overwrite it with your version, or cancel to load the newer one. You can save your version to a file from this dialog first.",
      actionLabel: "Overwrite with my version",
      color: "danger",
    });
    if (this.sceneId !== sceneId) {
      return;
    }
    if (keepMine && Number.isFinite(currentVersion)) {
      this.version = currentVersion;
      this.setStatus("dirty");
      await this.doSave();
    } else {
      await this.open(workspaceId, sceneId, { force: true, skipFlush: true });
    }
  }

  private async uploadImages(
    workspaceId: string,
    elements: readonly ExcalidrawElement[],
  ) {
    const files = this.excalidrawAPI.getFiles();
    const pending = imageFileIds(elements).filter(
      (id) => !this.storedFiles.has(id) && files[id]?.dataURL,
    );
    if (!pending.length) {
      return;
    }

    const blobs = new Map<string, Blob>();
    for (const id of pending) {
      const blob = await (await fetch(files[id].dataURL)).blob();
      if (blob.size > MAX_FILE_BYTES) {
        if (!this.warnedOversize.has(id)) {
          this.warnedOversize.add(id);
          this.excalidrawAPI.setToast({
            message: "An image is larger than 10 MB and won't be saved.",
          });
        }
        continue;
      }
      blobs.set(id, blob);
    }
    const toRequest = [...blobs].map(([id, blob]) => ({
      id,
      mimeType: files[id as FileId].mimeType,
      size: blob.size,
    }));
    for (let i = 0; i < toRequest.length; i += 100) {
      const { uploads, existing } = await api.uploadUrls(
        workspaceId,
        toRequest.slice(i, i + 100),
      );
      existing.forEach((id) => this.storedFiles.add(id));
      await Promise.all(
        uploads.map(async ({ id, url, headers }) => {
          const res = await fetch(url, {
            method: "PUT",
            headers,
            body: blobs.get(id),
          });
          if (!res.ok) {
            throw new Error(`Image upload failed (${res.status})`);
          }
          this.storedFiles.add(id);
        }),
      );
    }
  }
}
