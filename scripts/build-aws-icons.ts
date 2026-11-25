/**
 * Builds the AWS Architecture Icons library for the web app.
 *
 * Downloads the official AWS icon package (pinned in aws-icons.json and
 * checked against its SHA-256), takes the 48px service icons and the group
 * icons, and writes into the web app's public folder:
 *
 *   aws-icons/library.json        Excalidraw library items (icon + label)
 *   aws-icons/files/<sha1>.svg    the icons, content-addressed
 *
 * The icons are NOT committed to this repository: AWS's terms allow using
 * them in architecture diagrams, not redistributing the package. Outputs are
 * git-ignored and rebuilt by `bun run web:build`.
 *
 *   bun scripts/build-aws-icons.ts [--force]
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { $ } from 'bun';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache/aws-icons');
const OUT_DIR = path.join(ROOT, 'vendor/excalidraw/public/aws-icons');
const config = JSON.parse(
  await readFile(path.join(import.meta.dirname, 'aws-icons.json'), 'utf8'),
) as {
  url: string;
  sha256: string;
};
const force = process.argv.includes('--force');

// Bump when the generated library changes, so builds and browsers refresh it.
const FORMAT_VERSION = 2;

const ICON_SIZE = 64;
const LABEL_FONT_SIZE = 14;
const LABEL_GAP = 8;
// Nunito; average glyph width is about 0.55em
const FONT_FAMILY_NUNITO = 6;
const CHAR_WIDTH = 0.55;

const sha = (algo: string, data: Uint8Array | string) =>
  createHash(algo).update(data).digest('hex');

// ---------------------------------------------------------------- download

const manifestPath = path.join(OUT_DIR, 'library.json');
if (!force && existsSync(manifestPath)) {
  const current = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (current.packageSha256 === config.sha256 && current.formatVersion === FORMAT_VERSION) {
    console.log('AWS icons are up to date.');
    process.exit(0);
  }
}

await mkdir(CACHE_DIR, { recursive: true });
const zipPath = path.join(CACHE_DIR, 'package.zip');
const cachedOk =
  existsSync(zipPath) && sha('sha256', new Uint8Array(await readFile(zipPath))) === config.sha256;
if (!cachedOk) {
  console.log(`Downloading AWS icon package…\n  ${config.url}`);
  const res = await fetch(config.url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha('sha256', bytes);
  if (digest !== config.sha256) {
    throw new Error(
      `Checksum mismatch for the AWS icon package (got ${digest}). Update scripts/aws-icons.json if AWS published a new package.`,
    );
  }
  await writeFile(zipPath, bytes);
}

// Extract into its own folder; the files are only read as data.
const extractDir = path.join(CACHE_DIR, 'extracted');
await rm(extractDir, { recursive: true, force: true });
await mkdir(extractDir, { recursive: true });
await $`unzip -q -o ${zipPath} -d ${extractDir} -x "__MACOSX/*"`;

// ------------------------------------------------------------------ select

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    }),
  );
  return files.flat();
};

const all = (await walk(extractDir)).map((f) => path.relative(extractDir, f));

type Icon = { file: string; name: string; category: string };

const prettify = (s: string) => s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

const services: Icon[] = all.flatMap((file) => {
  const m = file.match(/^Architecture-Service-Icons_[^/]+\/Arch_([^/]+)\/48\/Arch_(.+)_48\.svg$/);
  return m?.[1] && m[2] ? [{ file, category: prettify(m[1]), name: prettify(m[2]) }] : [];
});

const groups: Icon[] = all.flatMap((file) => {
  const m = file.match(/^Architecture-Group-Icons_[^/]+\/(.+)_32\.svg$/);
  return m?.[1] ? [{ file, category: 'Groups', name: prettify(m[1]) }] : [];
});

const icons = [...groups, ...services].sort(
  (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
);
if (icons.length < 100) {
  throw new Error(`Only found ${icons.length} icons; did the package layout change?`);
}

// ------------------------------------------------------------------ output

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(path.join(OUT_DIR, 'files'), { recursive: true });

let seed = 1;
const nextSeed = () => {
  seed = (seed * 48271) % 2147483647;
  return seed;
};

const base = (id: string, groupId: string) => ({
  id,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [groupId],
  frameId: null,
  roundness: null,
  seed: nextSeed(),
  version: 1,
  versionNonce: nextSeed(),
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});

const libraryItems = [];
const seen = new Set<string>();

for (const icon of icons) {
  const svg = await readFile(path.join(extractDir, icon.file), 'utf8');
  const fileId = sha('sha1', svg);
  if (seen.has(fileId)) continue;
  seen.add(fileId);
  await writeFile(path.join(OUT_DIR, 'files', `${fileId}.svg`), svg);

  const slug = `${icon.category}-${icon.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const groupId = `aws-${slug}`;
  const labelWidth = Math.ceil(icon.name.length * LABEL_FONT_SIZE * CHAR_WIDTH);
  const lineHeight = 1.25;

  libraryItems.push({
    id: `aws-icon-${slug}`,
    status: 'published',
    created: 1,
    name: `${icon.name} (${icon.category})`,
    elements: [
      {
        ...base(`${groupId}-image`, groupId),
        type: 'image',
        x: 0,
        y: 0,
        width: ICON_SIZE,
        height: ICON_SIZE,
        fileId,
        status: 'saved',
        scale: [1, 1],
        crop: null,
      },
      {
        ...base(`${groupId}-label`, groupId),
        type: 'text',
        x: ICON_SIZE / 2 - labelWidth / 2,
        y: ICON_SIZE + LABEL_GAP,
        width: labelWidth,
        height: Math.ceil(LABEL_FONT_SIZE * lineHeight),
        text: icon.name,
        originalText: icon.name,
        fontSize: LABEL_FONT_SIZE,
        fontFamily: FONT_FAMILY_NUNITO,
        textAlign: 'center',
        verticalAlign: 'top',
        containerId: null,
        autoResize: true,
        lineHeight,
      },
    ],
  });
}

await writeFile(
  manifestPath,
  JSON.stringify({
    // the app re-merges the icons into the library when this changes
    version: `${config.sha256.slice(0, 16)}-${FORMAT_VERSION}`,
    formatVersion: FORMAT_VERSION,
    packageSha256: config.sha256,
    source: 'AWS Architecture Icons, https://aws.amazon.com/architecture/icons/',
    count: libraryItems.length,
    libraryItems,
  }),
);

console.log(`Wrote ${libraryItems.length} AWS icons to ${path.relative(ROOT, OUT_DIR)}`);
