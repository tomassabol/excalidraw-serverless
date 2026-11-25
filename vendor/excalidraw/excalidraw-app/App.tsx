// excalidraw-serverless: app shell.
// Collaboration, Firebase, share links, AI, Excalidraw+ integration, Sentry
// and PWA were removed. Scenes are stored in the cloud API (see ./cloud);
// the library stays in browser storage.
import {
  DefaultSidebar,
  Excalidraw,
  ExcalidrawAPIProvider,
  Sidebar,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import {
  DEFAULT_SIDEBAR,
  EVENT,
  isDevEnv,
  preventUnload,
  resolvablePromise,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import { useCallback, useEffect, useRef, useState } from "react";
import { isElementLink } from "@excalidraw/element";
import { useHandleLibrary } from "@excalidraw/excalidraw/data/library";
import { setLibraryFilesResolver } from "@excalidraw/excalidraw/hooks/useLibraryItemSvg";

import type {
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
import { Provider, appJotaiStore } from "./app-jotai";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { FileStatusStore } from "./data/fileStatusStore";
import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
} from "./data/LocalData";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
  loadSavedDebugState,
} from "./components/DebugCanvas";
import { AuthGate } from "./cloud/AuthGate";
import {
  resolveAwsIconFiles,
  supplyAwsIconFiles,
  withAwsIcons,
} from "./cloud/awsIcons";
import { CloudProvider, useCloud } from "./cloud/CloudProvider";
import { CloudStatus, WORKSPACE_TAB } from "./cloud/CloudStatus";
import { WorkspacePanel, folderIcon } from "./cloud/WorkspacePanel";

import "./index.scss";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

// library previews of the built-in AWS icons need their SVG files
setLibraryFilesResolver(resolveAwsIconFiles);

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const cloud = useCloud();

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode] = useAppLangCode();

  // The editor starts empty; the cloud provider loads the scene from the URL.
  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
    // On wide screens the workspace panel starts open and docked, so it stays
    // open while drawing (the dock button still toggles it).
    const wide = window.innerWidth >= 1200;
    initialStatePromiseRef.current.promise.resolve({
      elements: [],
      appState: wide
        ? {
            defaultSidebarDockedPreference: true,
            openSidebar: { name: DEFAULT_SIDEBAR.name, tab: WORKSPACE_TAB },
          }
        : {},
    });
  }

  const debugCanvasRef = useRef<HTMLCanvasElement>(null);

  useHandleLibrary({
    excalidrawAPI,
    // also merges the built-in AWS icons into the library
    adapter: withAwsIcons(LibraryIndexedDBAdapter),
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

  // save when the tab is hidden; warn before leaving with unsaved changes
  const { flush, hasUnsavedChanges } = cloud;
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        void flush();
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        void flush();
        preventUnload(event);
      }
    };
    document.addEventListener(EVENT.VISIBILITY_CHANGE, onVisibility);
    window.addEventListener(EVENT.BEFORE_UNLOAD, onBeforeUnload);
    return () => {
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, onVisibility);
      window.removeEventListener(EVENT.BEFORE_UNLOAD, onBeforeUnload);
    };
  }, [flush, hasUnsavedChanges]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    cloud.onEditorChange(elements, appState);
    if (excalidrawAPI) {
      supplyAwsIconFiles(excalidrawAPI, elements, files);
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

  const openWorkspacePanel = () =>
    excalidrawAPI?.toggleSidebar({
      name: DEFAULT_SIDEBAR.name,
      tab: WORKSPACE_TAB,
      force: true,
    });

  return (
    <div style={{ height: "100%" }} className="excalidraw-app">
      <Excalidraw
        onChange={onChange}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        name={cloud.currentScene?.name}
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
        renderTopRightUI={(isMobile) =>
          isMobile ? null : (
            <div className="excalidraw-ui-top-right">
              <CloudStatus />
            </div>
          )
        }
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
          onOpenWorkspace={openWorkspacePanel}
          onSignOut={() => void cloud.actions.signOut()}
        />
        <AppWelcomeScreen />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
        </OverwriteConfirmDialog>
        <AppFooter onChange={() => excalidrawAPI?.refresh()} />

        <DefaultSidebar>
          <DefaultSidebar.TabTriggers>
            <Sidebar.TabTrigger tab={WORKSPACE_TAB} title="Workspace">
              {folderIcon}
            </Sidebar.TabTrigger>
          </DefaultSidebar.TabTriggers>
          <Sidebar.Tab tab={WORKSPACE_TAB} className="cloud-sidebar-tab">
            <WorkspacePanel />
          </Sidebar.Tab>
        </DefaultSidebar>

        <CommandPalette
          customCommandPaletteItems={[
            {
              label: "New scene",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["create", "scene", "drawing", "file"],
              perform: () => void cloud.actions.createScene(null),
            },
            {
              label: "Open workspace panel",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["folders", "scenes", "browse", "files", "trash"],
              perform: openWorkspacePanel,
            },
            {
              label: "Sign out",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["logout", "log out", "account"],
              perform: () => void cloud.actions.signOut(),
            },
          ]}
        />
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
        <AuthGate>
          <ExcalidrawAPIProvider>
            <CloudProvider>
              <ExcalidrawWrapper />
            </CloudProvider>
          </ExcalidrawAPIProvider>
        </AuthGate>
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
