import {
  chevronDownIcon,
  pencilIcon,
  PlusIcon,
  searchIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCloud } from "./CloudProvider";

import "./cloud.scss";

import type { Folder, SceneMeta, Tag } from "./types";

const EXPANDED_KEY = "whiteboard:expandedFolders";
const DRAG_TYPE = "application/x-whiteboard-item";

export const folderIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
  </svg>
);

const sceneIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
  </svg>
);

const tagIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z" />
  </svg>
);

const restoreIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 14l-4 -4l4 -4" />
    <path d="M5 10h11a4 4 0 1 1 0 8h-1" />
  </svg>
);

const readExpanded = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });

// -----------------------------------------------------------------------------
// Small building blocks
// -----------------------------------------------------------------------------

const InlineInput = ({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = () => {
    if (done.current) {
      return;
    }
    done.current = true;
    const value = ref.current?.value.trim() ?? "";
    if (value && value !== initial) {
      onSubmit(value);
    } else {
      onCancel();
    }
  };
  return (
    <input
      ref={ref}
      className="cloud-input"
      defaultValue={initial}
      placeholder={placeholder}
      maxLength={200}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          submit();
        }
        if (event.key === "Escape") {
          done.current = true;
          onCancel();
        }
        event.stopPropagation();
      }}
      onBlur={submit}
      onClick={(event) => event.stopPropagation()}
    />
  );
};

const IconButton = ({
  title,
  icon,
  onClick,
  className,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  className?: string;
}) => (
  <button
    type="button"
    className={clsx("cloud-icon-button", className)}
    title={title}
    aria-label={title}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    {icon}
  </button>
);

const TagDot = ({ tag }: { tag: Tag | undefined }) => (
  <span
    className="cloud-tag-dot"
    style={{ background: tag?.color ?? "var(--color-gray-40)" }}
  />
);

// -----------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------

type Editing =
  | { kind: "rename-folder"; id: string }
  | { kind: "rename-scene"; id: string }
  | { kind: "tags"; id: string }
  | { kind: "new-folder"; parentId: string | null }
  | { kind: "new-workspace" }
  | { kind: "rename-workspace" }
  | null;

export const WorkspacePanel = () => {
  const cloud = useCloud();
  const { tree, workspaces, workspaceId, sceneId, actions } = cloud;

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      // ignore
    }
  }, [expanded]);

  useEffect(() => {
    setTagFilter(null);
    setQuery("");
    setShowTrash(false);
  }, [workspaceId]);

  useEffect(() => {
    if (showTrash) {
      void actions.loadTrash();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTrash, workspaceId]);

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const scenes = useMemo(() => tree?.scenes ?? [], [tree]);
  const tags = useMemo(() => tree?.tags ?? [], [tree]);
  const tagsByKey = useMemo(
    () => new Map(tags.map((t) => [t.name.toLowerCase(), t])),
    [tags],
  );

  const childrenOf = useMemo(() => {
    const folderMap = new Map<string | null, Folder[]>();
    const sceneMap = new Map<string | null, SceneMeta[]>();
    for (const f of folders) {
      const list = folderMap.get(f.parentId) ?? [];
      list.push(f);
      folderMap.set(f.parentId, list);
    }
    for (const s of scenes) {
      const list = sceneMap.get(s.folderId) ?? [];
      list.push(s);
      sceneMap.set(s.folderId, list);
    }
    return { folders: folderMap, scenes: sceneMap };
  }, [folders, scenes]);

  const folderPath = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    return (id: string | null) => {
      const parts: string[] = [];
      let current = id ? byId.get(id) : undefined;
      while (current) {
        parts.unshift(current.name);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return parts.join(" / ");
    };
  }, [folders]);

  // reveal the open scene's folders
  useEffect(() => {
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene?.folderId) {
      return;
    }
    const byId = new Map(folders.map((f) => [f.id, f]));
    const toOpen: string[] = [];
    let current = byId.get(scene.folderId);
    while (current) {
      toOpen.push(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    setExpanded((prev) =>
      toOpen.every((id) => prev.has(id)) ? prev : new Set([...prev, ...toOpen]),
    );
  }, [sceneId, scenes, folders]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  // ----------------------------------------------------------- drag & drop

  const onDragStart =
    (item: { type: "scene" | "folder"; id: string }) =>
    (event: React.DragEvent) => {
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
      event.dataTransfer.effectAllowed = "move";
    };

  const dropProps = (folderId: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes(DRAG_TYPE)) {
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(folderId ?? "root");
      }
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const raw = event.dataTransfer.getData(DRAG_TYPE);
      if (!raw) {
        return;
      }
      const item = JSON.parse(raw) as { type: "scene" | "folder"; id: string };
      if (item.type === "scene") {
        const scene = scenes.find((s) => s.id === item.id);
        if (scene && scene.folderId !== folderId) {
          void actions.updateScene(item.id, { folderId });
        }
      } else if (item.id !== folderId) {
        const folder = folders.find((f) => f.id === item.id);
        if (folder && folder.parentId !== folderId) {
          void actions.updateFolder(item.id, { parentId: folderId });
        }
      }
      if (folderId) {
        setExpanded((prev) => new Set([...prev, folderId]));
      }
    },
  });

  // ------------------------------------------------------------------ rows

  const sceneRow = (scene: SceneMeta, depth: number, showPath = false) => {
    const active = scene.id === sceneId;
    return (
      <div key={scene.id} className="cloud-node">
        <div
          className={clsx("cloud-row", { "cloud-row--active": active })}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={editing?.kind !== "rename-scene"}
          onDragStart={onDragStart({ type: "scene", id: scene.id })}
          onClick={() => actions.openScene(scene.id)}
          title={scene.name}
        >
          <span className="cloud-row__icon">{sceneIcon}</span>
          {editing?.kind === "rename-scene" && editing.id === scene.id ? (
            <InlineInput
              initial={scene.name}
              onSubmit={(name) => {
                setEditing(null);
                void actions.updateScene(scene.id, { name });
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span className="cloud-row__label">
              {scene.name}
              {showPath && scene.folderId && (
                <span className="cloud-row__path">
                  {folderPath(scene.folderId)}
                </span>
              )}
            </span>
          )}
          <span className="cloud-row__tags">
            {scene.tags.map((t) => (
              <TagDot key={t} tag={tagsByKey.get(t.toLowerCase())} />
            ))}
          </span>
          <span className="cloud-row__actions">
            <IconButton
              title="Tags"
              icon={tagIcon}
              onClick={() => setEditing({ kind: "tags", id: scene.id })}
            />
            <IconButton
              title="Rename"
              icon={pencilIcon}
              onClick={() => setEditing({ kind: "rename-scene", id: scene.id })}
            />
            <IconButton
              title="Move to trash"
              icon={TrashIcon}
              onClick={() => void actions.trashScene(scene.id)}
            />
          </span>
        </div>
        {editing?.kind === "tags" && editing.id === scene.id && (
          <div
            className="cloud-row-editor"
            style={{ paddingLeft: 30 + depth * 14 }}
          >
            <InlineInput
              initial={scene.tags.join(", ")}
              placeholder="Tags, comma separated"
              onSubmit={(value) => {
                setEditing(null);
                const next = value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .slice(0, 20);
                void actions.updateScene(scene.id, { tags: next });
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
      </div>
    );
  };

  const folderNode = (folder: Folder, depth: number): React.ReactNode => {
    const open = expanded.has(folder.id);
    const childFolders = childrenOf.folders.get(folder.id) ?? [];
    const childScenes = childrenOf.scenes.get(folder.id) ?? [];
    return (
      <div key={folder.id} className="cloud-node">
        <div
          className={clsx("cloud-row cloud-row--folder", {
            "cloud-row--drop": dropTarget === folder.id,
          })}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={editing?.kind !== "rename-folder"}
          onDragStart={onDragStart({ type: "folder", id: folder.id })}
          onClick={() => toggle(folder.id)}
          title={folder.name}
          {...dropProps(folder.id)}
        >
          <span
            className={clsx("cloud-row__chevron", {
              "cloud-row__chevron--closed": !open,
            })}
          >
            {chevronDownIcon}
          </span>
          <span className="cloud-row__icon">{folderIcon}</span>
          {editing?.kind === "rename-folder" && editing.id === folder.id ? (
            <InlineInput
              initial={folder.name}
              onSubmit={(name) => {
                setEditing(null);
                void actions.updateFolder(folder.id, { name });
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span className="cloud-row__label">{folder.name}</span>
          )}
          <span className="cloud-row__actions">
            <IconButton
              title="New scene in folder"
              icon={PlusIcon}
              onClick={() => void actions.createScene(folder.id)}
            />
            <IconButton
              title="New subfolder"
              icon={folderIcon}
              onClick={() => {
                setExpanded((prev) => new Set([...prev, folder.id]));
                setEditing({ kind: "new-folder", parentId: folder.id });
              }}
            />
            <IconButton
              title="Rename"
              icon={pencilIcon}
              onClick={() =>
                setEditing({ kind: "rename-folder", id: folder.id })
              }
            />
            <IconButton
              title="Move to trash"
              icon={TrashIcon}
              onClick={() => void actions.trashFolder(folder.id)}
            />
          </span>
        </div>
        {open && (
          <div>
            {editing?.kind === "new-folder" && editing.parentId === folder.id && (
              <div
                className="cloud-row-editor"
                style={{ paddingLeft: 30 + (depth + 1) * 14 }}
              >
                <InlineInput
                  initial=""
                  placeholder="Folder name"
                  onSubmit={(name) => {
                    setEditing(null);
                    void actions.createFolder(folder.id, name);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            )}
            {childFolders.map((f) => folderNode(f, depth + 1))}
            {childScenes.map((s) => sceneRow(s, depth + 1))}
            {!childFolders.length && !childScenes.length && (
              <div
                className="cloud-empty-hint"
                style={{ paddingLeft: 30 + (depth + 1) * 14 }}
              >
                Empty
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ----------------------------------------------------------- filtering

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0 || tagFilter !== null;
  const filteredScenes = filtering
    ? scenes.filter(
        (s) =>
          (!needle || s.name.toLowerCase().includes(needle)) &&
          (!tagFilter ||
            s.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())),
      )
    : [];
  const filteredFolders =
    needle && !tagFilter
      ? folders.filter((f) => f.name.toLowerCase().includes(needle))
      : [];

  // -------------------------------------------------------------- render

  if (cloud.fatalError) {
    return (
      <div className="cloud-panel">
        <div className="cloud-error">{cloud.fatalError}</div>
      </div>
    );
  }

  return (
    <div className="cloud-panel">
      <div className="cloud-section cloud-workspace">
        {editing?.kind === "new-workspace" ? (
          <InlineInput
            initial=""
            placeholder="Workspace name"
            onSubmit={(name) => {
              setEditing(null);
              void actions.createWorkspace(name);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : editing?.kind === "rename-workspace" && tree ? (
          <InlineInput
            initial={tree.workspace.name}
            onSubmit={(name) => {
              setEditing(null);
              void actions.renameWorkspace(tree.workspace.id, name);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <select
            className="cloud-select"
            value={workspaceId ?? ""}
            aria-label="Workspace"
            onChange={(event) => {
              if (event.target.value === "__new__") {
                setEditing({ kind: "new-workspace" });
              } else {
                actions.selectWorkspace(event.target.value);
              }
            }}
          >
            {(workspaces ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value="__new__">+ New workspace…</option>
          </select>
        )}
        <IconButton
          title="Rename workspace"
          icon={pencilIcon}
          onClick={() => setEditing({ kind: "rename-workspace" })}
        />
        <IconButton
          title="Delete workspace (must be empty)"
          icon={TrashIcon}
          onClick={() => {
            if (
              tree &&
              window.confirm(
                `Delete the workspace "${tree.workspace.name}"? This only works when it is empty.`,
              )
            ) {
              void actions.deleteWorkspace(tree.workspace.id);
            }
          }}
        />
      </div>

      <div className="cloud-section cloud-search">
        <span className="cloud-search__icon">{searchIcon}</span>
        <input
          className="cloud-input"
          type="search"
          placeholder="Search scenes and folders"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
            }
            event.stopPropagation();
          }}
        />
      </div>

      {tags.length > 0 && (
        <div className="cloud-section cloud-tags">
          {tags.map((tag) => (
            <button
              key={tag.name}
              type="button"
              className={clsx("cloud-chip", {
                "cloud-chip--active": tagFilter === tag.name,
              })}
              onClick={() =>
                setTagFilter((current) =>
                  current === tag.name ? null : tag.name,
                )
              }
              title={`${tag.sceneCount} scene${
                tag.sceneCount === 1 ? "" : "s"
              }`}
            >
              <TagDot tag={tag} />
              {tag.name}
            </button>
          ))}
          <button
            type="button"
            className="cloud-chip cloud-chip--ghost"
            onClick={() => setShowTags((v) => !v)}
          >
            {showTags ? "Done" : "Edit"}
          </button>
        </div>
      )}

      {showTags && (
        <div className="cloud-section cloud-tag-editor">
          {tags.map((tag) => (
            <div key={tag.name} className="cloud-tag-editor__row">
              <input
                type="color"
                value={tag.color ?? "#868e96"}
                aria-label={`Color of ${tag.name}`}
                onChange={(event) =>
                  void actions.setTagColor(tag.name, event.target.value)
                }
              />
              <span className="cloud-row__label">{tag.name}</span>
              <span className="cloud-muted">{tag.sceneCount}</span>
              <IconButton
                title={`Remove tag "${tag.name}" from all scenes`}
                icon={TrashIcon}
                onClick={() => {
                  if (tagFilter === tag.name) {
                    setTagFilter(null);
                  }
                  void actions.deleteTag(tag.name);
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div className="cloud-toolbar">
        <button
          type="button"
          className="cloud-button"
          onClick={() => void actions.createScene(null)}
        >
          {PlusIcon} New scene
        </button>
        <button
          type="button"
          className="cloud-button"
          onClick={() => setEditing({ kind: "new-folder", parentId: null })}
        >
          {folderIcon} New folder
        </button>
      </div>

      <div
        className={clsx("cloud-tree", {
          "cloud-tree--drop": dropTarget === "root",
        })}
        {...dropProps(null)}
      >
        {!tree && <div className="cloud-empty-hint">Loading…</div>}
        {tree && filtering && (
          <>
            {filteredFolders.map((f) => (
              <div
                key={f.id}
                className="cloud-row cloud-row--folder"
                onClick={() => {
                  setQuery("");
                  setTagFilter(null);
                  setExpanded((prev) => new Set([...prev, f.id]));
                }}
              >
                <span className="cloud-row__icon">{folderIcon}</span>
                <span className="cloud-row__label">
                  {f.name}
                  {f.parentId && (
                    <span className="cloud-row__path">
                      {folderPath(f.parentId)}
                    </span>
                  )}
                </span>
              </div>
            ))}
            {filteredScenes.map((s) => sceneRow(s, 0, true))}
            {!filteredFolders.length && !filteredScenes.length && (
              <div className="cloud-empty-hint">No matches</div>
            )}
          </>
        )}
        {tree && !filtering && (
          <>
            {editing?.kind === "new-folder" && editing.parentId === null && (
              <div className="cloud-row-editor" style={{ paddingLeft: 30 }}>
                <InlineInput
                  initial=""
                  placeholder="Folder name"
                  onSubmit={(name) => {
                    setEditing(null);
                    void actions.createFolder(null, name);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            )}
            {(childrenOf.folders.get(null) ?? []).map((f) => folderNode(f, 0))}
            {(childrenOf.scenes.get(null) ?? []).map((s) => sceneRow(s, 0))}
          </>
        )}
      </div>

      <div className="cloud-section cloud-trash">
        <button
          type="button"
          className="cloud-trash__toggle"
          onClick={() => setShowTrash((v) => !v)}
        >
          <span
            className={clsx("cloud-row__chevron", {
              "cloud-row__chevron--closed": !showTrash,
            })}
          >
            {chevronDownIcon}
          </span>
          <span className="cloud-row__icon">{TrashIcon}</span>
          Trash
        </button>
        {showTrash && (
          <div className="cloud-trash__list">
            {cloud.trash === null && (
              <div className="cloud-empty-hint">Loading…</div>
            )}
            {cloud.trash?.length === 0 && (
              <div className="cloud-empty-hint">
                Trash is empty. Items are kept for 30 days.
              </div>
            )}
            {cloud.trash?.map((batch) => (
              <div key={batch.batchId} className="cloud-row cloud-row--static">
                <span className="cloud-row__icon">
                  {batch.root.type === "folder" ? folderIcon : sceneIcon}
                </span>
                <span className="cloud-row__label">
                  {batch.root.name}
                  <span className="cloud-row__path">
                    {batch.root.type === "folder"
                      ? `${
                          batch.folderCount + batch.sceneCount - 1
                        } items inside · `
                      : ""}
                    deleted {formatDate(batch.deletedAt)}
                  </span>
                </span>
                <span className="cloud-row__actions cloud-row__actions--visible">
                  <IconButton
                    title="Restore"
                    icon={restoreIcon}
                    onClick={() => void actions.restoreTrash(batch.batchId)}
                  />
                  <IconButton
                    title="Delete forever"
                    icon={TrashIcon}
                    className="cloud-icon-button--danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${batch.root.name}" forever? This can't be undone.`,
                        )
                      ) {
                        void actions.purgeTrash(batch.batchId);
                      }
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
