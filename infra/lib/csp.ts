import { createHash } from 'node:crypto';

/** SHA-256 CSP sources for every inline <script> in an HTML document. */
export const inlineScriptHashes = (html: string): string[] => {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\ssrc\s*=/.test(attrs) || body.length === 0) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...new Set(hashes)];
};

export interface CspOptions {
  /** Hash sources for the page's inline scripts. */
  scriptHashes: string[];
  /** Extra origins the app talks to with fetch/XHR. */
  connectSrc: string[];
}

/**
 * Content-Security-Policy for the web app. Notes on the less strict parts:
 * - style-src 'unsafe-inline': the editor sets inline styles everywhere
 * - 'wasm-unsafe-eval': font subsetting during export runs WebAssembly
 * - worker-src blob:/data:: image resizing (pica) starts inline workers
 * - connect-src data:/blob:: images are converted between data URLs and blobs
 * - frame-src https:: embeddable elements (YouTube, Figma, ...)
 */
export const buildCsp = ({ scriptHashes, connectSrc }: CspOptions): string =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' data: blob: ${connectSrc.join(' ')}`.trim(),
    "worker-src 'self' blob: data:",
    'frame-src https:',
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
