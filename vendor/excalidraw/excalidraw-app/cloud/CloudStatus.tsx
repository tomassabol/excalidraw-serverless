import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import clsx from "clsx";

import { useCloud } from "./CloudProvider";
import { folderIcon } from "./WorkspacePanel";

export const WORKSPACE_TAB = "workspace";

const LABELS = {
  idle: "",
  loading: "Loading…",
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Not saved, retrying",
  conflict: "Conflict",
} as const;

/** Top-right: current scene name and save status; opens the workspace panel. */
export const CloudStatus = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const { currentScene, status, statusError } = useCloud();

  return (
    <button
      type="button"
      className="cloud-status"
      title={statusError ?? "Open workspace"}
      onClick={() =>
        excalidrawAPI?.toggleSidebar({
          name: DEFAULT_SIDEBAR.name,
          tab: WORKSPACE_TAB,
        })
      }
    >
      <span className="cloud-status__icon">{folderIcon}</span>
      <span className="cloud-status__name">
        {currentScene?.name ?? "Workspace"}
      </span>
      {status !== "idle" && (
        <span
          className={clsx(
            "cloud-status__state",
            `cloud-status__state--${status}`,
          )}
        >
          {LABELS[status]}
        </span>
      )}
    </button>
  );
};
