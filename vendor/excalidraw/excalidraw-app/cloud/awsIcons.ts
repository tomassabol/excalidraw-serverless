import { isInitializedImageElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";
import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { MaybePromise } from "@excalidraw/common/utility-types";

/**
 * Built-in AWS Architecture Icons (generated at build time by
 * scripts/build-aws-icons.ts into /aws-icons/).
 *
 * - The icons are merged into the user's library once per icon-set version.
 * - Library items reference their SVG by file id only (Excalidraw libraries
 *   can't carry files), so when an icon is placed on the canvas its file is
 *   fetched from /aws-icons/files/<id>.svg and added to the editor. From then
 *   on it is saved to S3 like any other image.
 */

const MANIFEST_URL = "/aws-icons/library.json";
const VERSION_KEY = "whiteboard:awsIconsVersion";
/** Ids of generated library items start with this (see build-aws-icons.ts). */
const AWS_ITEM_PREFIX = "aws-icon-";

type Manifest = {
  version: string;
  count: number;
  libraryItems: LibraryItems;
};

let manifestPromise: Promise<Manifest | null> | null = null;

const loadManifest = () => {
  manifestPromise ??= fetch(MANIFEST_URL, { cache: "no-cache" })
    .then((res) => (res.ok ? (res.json() as Promise<Manifest>) : null))
    .catch(() => null);
  return manifestPromise;
};

const readVersion = () => {
  try {
    return localStorage.getItem(VERSION_KEY);
  } catch {
    return null;
  }
};

const writeVersion = (version: string) => {
  try {
    localStorage.setItem(VERSION_KEY, version);
  } catch {
    // ignore
  }
};

type Adapter = {
  load: () => Promise<LibraryPersistedData | null>;
  save: (data: LibraryPersistedData) => MaybePromise<void>;
};

/**
 * Wraps a library persistence adapter so a new AWS icon set is merged into
 * the stored library (and saved) the first time it's seen. Icons the user
 * removed stay removed until the next icon-set version, which replaces all
 * built-in icon items.
 */
export const withAwsIcons = (adapter: Adapter) => ({
  load: async (): Promise<LibraryPersistedData | null> => {
    const data = await adapter.load();
    const manifest = await loadManifest();
    if (!manifest || readVersion() === manifest.version) {
      return data;
    }
    // replace older copies of the built-in icons, keep everything else
    const existing = (data?.libraryItems ?? []).filter(
      (item) => !item.id.startsWith(AWS_ITEM_PREFIX),
    );
    const merged: LibraryPersistedData = {
      libraryItems: [...existing, ...manifest.libraryItems],
    };
    await adapter.save(merged);
    writeVersion(manifest.version);
    return merged;
  },
  save: (data: LibraryPersistedData) => adapter.save(data),
});

// ---------------------------------------------------------------- files

let iconIds: Set<string> | null = null;
let iconIdsLoading = false;

/** File ids of the built-in icons; null until the manifest has loaded. */
const knownIconIds = () => {
  if (!iconIds && !iconIdsLoading) {
    iconIdsLoading = true;
    void loadManifest().then((manifest) => {
      iconIds = new Set(
        (manifest?.libraryItems ?? []).flatMap((item) =>
          item.elements.flatMap((el) =>
            el.type === "image" && el.fileId ? [el.fileId] : [],
          ),
        ),
      );
    });
  }
  return iconIds;
};

const inFlight = new Set<string>();

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** Icon files by id; the SVGs are immutable, so cache them for the session. */
const fileCache = new Map<string, Promise<BinaryFileData | null>>();

const loadIconFile = (id: FileId) => {
  let entry = fileCache.get(id);
  if (!entry) {
    entry = (async (): Promise<BinaryFileData | null> => {
      const res = await fetch(`/aws-icons/files/${id}.svg`);
      if (!res.ok) {
        return null;
      }
      const blob = new Blob([await res.arrayBuffer()], {
        type: "image/svg+xml",
      });
      return {
        id,
        mimeType: "image/svg+xml",
        dataURL: (await blobToDataURL(blob)) as BinaryFileData["dataURL"],
        created: Date.now(),
        lastRetrieved: Date.now(),
      };
    })().catch(() => null);
    fileCache.set(id, entry);
  }
  return entry;
};

/**
 * Supplies icon files to library item previews (registered with the editor
 * via setLibraryFilesResolver).
 */
export const resolveAwsIconFiles = async (
  fileIds: readonly FileId[],
): Promise<BinaryFiles> => {
  const loaded = await Promise.all(fileIds.map(loadIconFile));
  const files: BinaryFiles = {};
  for (const file of loaded) {
    if (file) {
      files[file.id] = file;
    }
  }
  return files;
};

/**
 * Call from onChange: adds the SVG for AWS icons placed on the canvas whose
 * image file the editor doesn't have yet.
 */
export const supplyAwsIconFiles = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
) => {
  const known = knownIconIds();
  if (!known) {
    return;
  }
  const ids: FileId[] = [];
  for (const element of elements) {
    if (
      !element.isDeleted &&
      isInitializedImageElement(element) &&
      !files[element.fileId] &&
      !inFlight.has(element.fileId) &&
      known.has(element.fileId)
    ) {
      ids.push(element.fileId);
    }
  }
  if (!ids.length) {
    return;
  }
  ids.forEach((id) => inFlight.add(id));
  void resolveAwsIconFiles(ids)
    .then((loaded) => {
      const list = Object.values(loaded);
      if (list.length) {
        excalidrawAPI.addFiles(list);
      }
    })
    .finally(() => ids.forEach((id) => inFlight.delete(id)));
};
