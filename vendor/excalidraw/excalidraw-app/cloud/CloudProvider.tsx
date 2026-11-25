import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { ApiError, api } from "./api";
import { signOut } from "./auth";
import { navigate, useRoute } from "./router";
import { SceneSync } from "./sceneSync";

import type { SyncStatus } from "./sceneSync";
import type { SceneMeta, TrashBatch, Workspace, WorkspaceTree } from "./types";

const LAST_WORKSPACE_KEY = "whiteboard:lastWorkspace";
const DEFAULT_WORKSPACE_NAME = "My workspace";
const DEFAULT_SCENE_NAME = "Untitled";

const readLastWorkspace = () => {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
};
const writeLastWorkspace = (id: string) => {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // ignore (private mode etc.)
  }
};

const byUpdatedDesc = (a: SceneMeta, b: SceneMeta) =>
  b.updatedAt.localeCompare(a.updatedAt);

export type CloudContextValue = ReturnType<typeof useCloudState>;

const CloudContext = createContext<CloudContextValue | null>(null);

export const useCloud = () => {
  const value = useContext(CloudContext);
  if (!value) {
    throw new Error("useCloud must be used inside <CloudProvider>");
  }
  return value;
};

const useCloudState = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const route = useRoute();

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [trash, setTrash] = useState<TrashBatch[] | null>(null);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [statusError, setStatusError] = useState<string | undefined>();
  const [fatalError, setFatalError] = useState<string | null>(null);

  const workspaceId = route.workspaceId;
  const sceneId = route.sceneId;

  const toast = useCallback(
    (message: string) => excalidrawAPI?.setToast({ message, duration: 4000 }),
    [excalidrawAPI],
  );

  /** Runs a user action, reporting failures as a toast. */
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          toast((error as Error).message || "Something went wrong");
        }
        return undefined;
      }
    },
    [toast],
  );

  // ---------------------------------------------------------- scene sync

  const syncRef = useRef<SceneSync | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    syncRef.current = new SceneSync(excalidrawAPI, {
      onStatus: (next, error) => {
        setStatus(next);
        setStatusError(error);
      },
      onScene: (scene) => {
        setTree((current) =>
          current && current.workspace.id === scene.workspaceId
            ? {
                ...current,
                scenes: current.scenes.map((s) =>
                  s.id === scene.id ? { ...s, ...scene } : s,
                ),
              }
            : current,
        );
      },
      onSceneMissing: (ws) => {
        toast("That scene no longer exists.");
        navigate({ workspaceId: ws, sceneId: null }, { replace: true });
      },
    });
    return () => {
      syncRef.current?.close();
      syncRef.current = null;
    };
  }, [excalidrawAPI, toast]);

  const onEditorChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      syncRef.current?.onChange(elements, appState);
    },
    [],
  );

  // ------------------------------------------------------------- loading

  const refreshWorkspaces = useCallback(async () => {
    let list = await api.listWorkspaces();
    if (!list.length) {
      list = [await api.createWorkspace(DEFAULT_WORKSPACE_NAME)];
    }
    setWorkspaces(list);
    return list;
  }, []);

  const refreshTree = useCallback(async (ws: string) => {
    const next = await api.getTree(ws);
    if (workspaceIdRef.current === ws) {
      setTree(next);
    }
    return next;
  }, []);

  // first load
  useEffect(() => {
    refreshWorkspaces().catch((error) => {
      if (!(error instanceof ApiError && error.status === 401)) {
        setFatalError((error as Error).message);
      }
    });
  }, [refreshWorkspaces]);

  // pick a workspace when the URL has none (or an unknown one)
  useEffect(() => {
    if (!workspaces) {
      return;
    }
    if (workspaceId && workspaces.some((w) => w.id === workspaceId)) {
      writeLastWorkspace(workspaceId);
      return;
    }
    if (workspaceId) {
      toast("Workspace not found.");
    }
    const last = readLastWorkspace();
    const target =
      workspaces.find((w) => w.id === last)?.id ?? workspaces[0].id;
    navigate({ workspaceId: target, sceneId: null }, { replace: true });
  }, [workspaces, workspaceId, toast]);

  // load the tree for the current workspace
  useEffect(() => {
    if (!workspaceId || !workspaces?.some((w) => w.id === workspaceId)) {
      return;
    }
    setTree((current) =>
      current?.workspace.id === workspaceId ? current : null,
    );
    setTrash(null);
    run(() => refreshTree(workspaceId));
  }, [workspaceId, workspaces, refreshTree, run]);

  // pick or create a scene when the URL has none
  const creatingDefaultScene = useRef(false);
  useEffect(() => {
    if (!workspaceId || sceneId || tree?.workspace.id !== workspaceId) {
      return;
    }
    const recent = [...tree.scenes].sort(byUpdatedDesc)[0];
    if (recent) {
      navigate({ workspaceId, sceneId: recent.id }, { replace: true });
      return;
    }
    if (creatingDefaultScene.current) {
      return;
    }
    creatingDefaultScene.current = true;
    run(async () => {
      const scene = await api.createScene(workspaceId, {
        name: DEFAULT_SCENE_NAME,
        folderId: null,
      });
      await refreshTree(workspaceId);
      navigate({ workspaceId, sceneId: scene.id }, { replace: true });
    }).finally(() => {
      creatingDefaultScene.current = false;
    });
  }, [workspaceId, sceneId, tree, refreshTree, run]);

  // open the scene in the URL
  useEffect(() => {
    if (workspaceId && sceneId && syncRef.current) {
      void syncRef.current.open(workspaceId, sceneId);
    }
  }, [workspaceId, sceneId, excalidrawAPI]);

  // keep the editor's scene name (used for exports) in sync with renames
  const currentScene = useMemo(
    () => tree?.scenes.find((s) => s.id === sceneId) ?? null,
    [tree, sceneId],
  );
  useEffect(() => {
    if (currentScene) {
      syncRef.current?.rememberMeta(currentScene);
    }
  }, [currentScene]);

  // ------------------------------------------------------------- actions

  const requireWs = () => {
    if (!workspaceId) {
      throw new Error("No workspace selected");
    }
    return workspaceId;
  };

  const actions = {
    openScene: (id: string) => {
      const ws = requireWs();
      navigate({ workspaceId: ws, sceneId: id });
    },

    selectWorkspace: (id: string) => {
      navigate({ workspaceId: id, sceneId: null });
    },

    createWorkspace: (name: string) =>
      run(async () => {
        const created = await api.createWorkspace(name);
        await refreshWorkspaces();
        navigate({ workspaceId: created.id, sceneId: null });
      }),

    renameWorkspace: (id: string, name: string) =>
      run(async () => {
        await api.renameWorkspace(id, name);
        await refreshWorkspaces();
        if (id === workspaceId) {
          await refreshTree(id);
        }
      }),

    deleteWorkspace: (id: string) =>
      run(async () => {
        try {
          await api.deleteWorkspace(id);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            throw new Error(
              "Only empty workspaces can be deleted. Move or delete its folders and scenes, and empty its trash first.",
            );
          }
          throw error;
        }
        if (id === workspaceId) {
          syncRef.current?.close();
        }
        const list = await refreshWorkspaces();
        if (id === workspaceId) {
          navigate({ workspaceId: list[0].id, sceneId: null });
        }
      }),

    createScene: (folderId: string | null, name = DEFAULT_SCENE_NAME) =>
      run(async () => {
        const ws = requireWs();
        const scene = await api.createScene(ws, { name, folderId });
        await refreshTree(ws);
        navigate({ workspaceId: ws, sceneId: scene.id });
        return scene;
      }),

    updateScene: (
      id: string,
      patch: { name?: string; folderId?: string | null; tags?: string[] },
    ) =>
      run(async () => {
        const ws = requireWs();
        await api.updateScene(ws, id, patch);
        await refreshTree(ws);
      }),

    trashScene: (id: string) =>
      run(async () => {
        const ws = requireWs();
        if (id === sceneId) {
          await syncRef.current?.flush();
          syncRef.current?.close();
        }
        await api.trashScene(ws, id);
        await refreshTree(ws);
        setTrash(null);
        toast("Moved to trash.");
        if (id === sceneId) {
          navigate({ workspaceId: ws, sceneId: null }, { replace: true });
        }
      }),

    createFolder: (parentId: string | null, name: string) =>
      run(async () => {
        const ws = requireWs();
        const folder = await api.createFolder(ws, name, parentId);
        await refreshTree(ws);
        return folder;
      }),

    updateFolder: (
      id: string,
      patch: { name?: string; parentId?: string | null },
    ) =>
      run(async () => {
        const ws = requireWs();
        await api.updateFolder(ws, id, patch);
        await refreshTree(ws);
      }),

    trashFolder: (id: string) =>
      run(async () => {
        const ws = requireWs();
        await syncRef.current?.flush();
        const result = await api.trashFolder(ws, id);
        const next = await refreshTree(ws);
        setTrash(null);
        toast(
          `Moved ${result.count} item${
            result.count === 1 ? "" : "s"
          } to trash.`,
        );
        if (sceneId && !next.scenes.some((s) => s.id === sceneId)) {
          syncRef.current?.close();
          navigate({ workspaceId: ws, sceneId: null }, { replace: true });
        }
      }),

    setTagColor: (name: string, color: string | null) =>
      run(async () => {
        const ws = requireWs();
        await api.setTagColor(ws, name, color);
        await refreshTree(ws);
      }),

    deleteTag: (name: string) =>
      run(async () => {
        const ws = requireWs();
        await api.deleteTag(ws, name);
        await refreshTree(ws);
      }),

    loadTrash: () =>
      run(async () => {
        const ws = requireWs();
        const batches = await api.listTrash(ws);
        if (workspaceIdRef.current === ws) {
          setTrash(batches);
        }
        return batches;
      }),

    restoreTrash: (batchId: string) =>
      run(async () => {
        const ws = requireWs();
        await api.restoreTrash(ws, batchId);
        await refreshTree(ws);
        setTrash(await api.listTrash(ws));
        toast("Restored.");
      }),

    purgeTrash: (batchId: string) =>
      run(async () => {
        const ws = requireWs();
        await api.purgeTrash(ws, batchId);
        setTrash(await api.listTrash(ws));
      }),

    signOut: async () => {
      await syncRef.current?.flush();
      await signOut();
    },
  };

  return {
    workspaces,
    workspaceId,
    tree,
    trash,
    sceneId,
    currentScene,
    status,
    statusError,
    fatalError,
    onEditorChange,
    hasUnsavedChanges: () => syncRef.current?.hasUnsavedChanges ?? false,
    flush: () => syncRef.current?.flush(),
    actions,
  };
};

export const CloudProvider = ({ children }: { children: React.ReactNode }) => {
  const value = useCloudState();
  return (
    <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
  );
};
