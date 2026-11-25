// excalidraw-serverless: slimmed-down app shell.
// Collaboration, Firebase, share links, AI, Excalidraw+ integration, Sentry
// and PWA were removed. Scenes persist to browser storage for now; cloud
// persistence is added under ./cloud in a later phase.
import {
  Excalidraw,
  CaptureUpdateAction,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { CommandPalette } from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import {
  EVENT,
  debounce,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  isDevEnv,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@excalidraw/excalidraw/i18n";
import { isElementLink } from "@excalidraw/element";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { useHandleLibrary } from "@excalidraw/excalidraw/data/library";

import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import { Provider, useAtomValue, appJotaiStore } from "./app-jotai";
import { STORAGE_KEYS, SYNC_BROWSER_TABS_TIMEOUT } from "./app_constants";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { updateStaleImageStatuses } from "./data/FileManager";
import { FileStatusStore } from "./data/fileStatusStore";
import { importFromLocalStorage } from "./data/localStorage";
import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  LocalData,
  localStorageQuotaExceededAtom,
} from "./data/LocalData";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { getPreferredLanguage } from "./app-language/language-detector";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
  loadSavedDebugState,
} from "./components/DebugCanvas";

import "./index.scss";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

const getImageFileIds = (
  elements: readonly ExcalidrawElement[] | null | undefined,
) =>
  (elements || []).reduce((acc, element) => {
    if (isInitializedImageElement(element)) {
      return acc.concat(element.fileId);
    }
    return acc;
  }, [] as FileId[]);

const initializeScene = (): ExcalidrawInitialDataState => {
  const localDataState = importFromLocalStorage();
  return {
    elements: restoreElements(localDataState?.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    }),
    appState: restoreAppState(localDataState?.appState, null),
  };
};

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const [errorMessage, setErrorMessage] = useState("");

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode, setLangCode] = useAppLangCode();

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const debugCanvasRef = useRef<HTMLCanvasElement>(null);

  useHandleLibrary({
    excalidrawAPI,
    adapter: LibraryIndexedDBAdapter,
    // TODO maybe remove this in several months (shipped: 24-03-11)
    migrationAdapter: LibraryLocalStorageMigrationAdapter,
  });

  const [, forceRefresh] = useState(false);

  useEffect(() => {
    if (isDevEnv()) {
      const debugState = loadSavedDebugState();

      if (debugState.enabled && !window.visualDebug) {
        window.visualDebug = {
          data: [],
        };
      } else {
        delete window.visualDebug;
      }
      forceRefresh((prev) => !prev);
    }
  }, [excalidrawAPI]);

  const loadLocalImages = useCallback(
    (fileIds: FileId[]) => {
      if (!excalidrawAPI || !fileIds.length) {
        return;
      }
      LocalData.fileStorage
        .getFiles(fileIds)
        .then(({ loadedFiles, erroredFiles }) => {
          if (loadedFiles.length) {
            excalidrawAPI.addFiles(loadedFiles);
          }
          updateStaleImageStatuses({
            excalidrawAPI,
            erroredFiles,
            elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
          });
        });
    },
    [excalidrawAPI],
  );

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const scene = initializeScene();
    const fileIds = getImageFileIds(scene.elements);
    loadLocalImages(fileIds);
    // on fresh load, clear unused files from IDB (from previous session)
    LocalData.fileStorage.clearObsoleteFiles({ currentFileIds: fileIds });
    initialStatePromiseRef.current.promise.resolve(scene);

    // keep several open tabs in sync through browser storage
    const syncData = debounce(() => {
      if (isTestEnv() || document.hidden) {
        return;
      }
      // don't sync if local state is newer or identical to browser state
      if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
        const localDataState = importFromLocalStorage();
        setLangCode(getPreferredLanguage());
        excalidrawAPI.updateScene({
          ...localDataState,
          // a text edit goes on through the sync: its editor takes the
          // synced text, or closes if the text is gone
          appState: localDataState.appState && {
            ...localDataState.appState,
            editingTextElement: excalidrawAPI.getAppState().editingTextElement,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        LibraryIndexedDBAdapter.load().then((data) => {
          if (data) {
            excalidrawAPI.updateLibrary({
              libraryItems: data.libraryItems,
            });
          }
        });
      }

      if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
        const currFiles = excalidrawAPI.getFiles();
        loadLocalImages(
          getImageFileIds(
            excalidrawAPI.getSceneElementsIncludingDeleted(),
          ).filter((id) => !currFiles[id]),
        );
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const onUnload = () => {
      LocalData.flushSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        LocalData.flushSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
    };
  }, [excalidrawAPI, setLangCode, loadLocalImages]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
          preventUnload(event);
        } else {
          console.warn(
            "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
          );
        }
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
                if (newElement !== element) {
                  didChange = true;
                }
                return newElement;
              }
              return element;
            });

          if (didChange) {
            excalidrawAPI.updateScene({
              elements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        }
      });
    }

    // Render the debug scene if the debug canvas is available
    if (debugCanvasRef.current && excalidrawAPI) {
      debugRenderer(
        debugCanvasRef.current,
        appState,
        elements,
        window.devicePixelRatio,
      );
    }
  };

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  // ---------------------------------------------------------------------------
  // onExport — intercepts file save to wait for pending image loads
  // ---------------------------------------------------------------------------
  const onExport: Required<ExcalidrawProps>["onExport"] = useCallback(
    async function* () {
      let snapshot = FileStatusStore.getSnapshot();
      const { pending, total } = FileStatusStore.getPendingCount(
        snapshot.value,
      );
      if (pending === 0) {
        return;
      }

      // Yield initial progress
      yield {
        type: "progress",
        progress: (total - pending) / total,
        message: `Loading images (${total - pending}/${total})...`,
      };

      // Wait for all pending images to finish
      while (true) {
        snapshot = await FileStatusStore.pull(snapshot.version);
        const { pending: nowPending, total: nowTotal } =
          FileStatusStore.getPendingCount(snapshot.value);

        yield {
          type: "progress",
          progress: (nowTotal - nowPending) / nowTotal,
          message: `Loading images (${nowTotal - nowPending}/${nowTotal})...`,
        };

        if (nowPending === 0) {
          await new Promise((r) => setTimeout(r, 500));
          yield {
            type: "progress",
            message: `Preparing export...`,
          };
          return;
        }
      }
    },
    [],
  );

  return (
    <div style={{ height: "100%" }} className="excalidraw-app">
      <Excalidraw
        onChange={onChange}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.setViewport({
              target: element.link,
              fit: "scale-down",
              animation: true,
            });
          }
        }}
      >
        <AppMainMenu
          theme={appTheme}
          refresh={() => forceRefresh((prev) => !prev)}
        />
        <AppWelcomeScreen />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
        </OverwriteConfirmDialog>
        <AppFooter onChange={() => excalidrawAPI?.refresh()} />

        {localStorageQuotaExceeded && (
          <div className="alert alert--danger">
            {t("alerts.localStorageQuotaExceeded")}
          </div>
        )}

        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}

        <CommandPalette />
        {isVisualDebuggerEnabled() && excalidrawAPI && (
          <DebugCanvas
            appState={excalidrawAPI.getAppState()}
            scale={window.devicePixelRatio}
            ref={debugCanvasRef}
          />
        )}
      </Excalidraw>
    </div>
  );
};

const ExcalidrawApp = () => {
  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        <ExcalidrawAPIProvider>
          <ExcalidrawWrapper />
        </ExcalidrawAPIProvider>
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
