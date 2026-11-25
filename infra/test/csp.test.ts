import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { buildCsp, inlineScriptHashes } from '../lib/csp.ts';

const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

describe('inlineScriptHashes', () => {
  test('hashes inline scripts only, deduplicated', () => {
    const html = `
      <script>window.a = 1;</script>
      <script type="module" src="/assets/index.js"></script>
      <script>
        window.b = 2;
      </script>
      <script>window.a = 1;</script>`;
    expect(inlineScriptHashes(html)).toEqual([
      hash('window.a = 1;'),
      hash('\n        window.b = 2;\n      '),
    ]);
  });
});

describe('buildCsp', () => {
  test('pins scripts and lists connect origins', () => {
    const csp = buildCsp({
      scriptHashes: ["'sha256-abc'"],
      connectSrc: ['https://auth.example.com'],
    });
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'");
    expect(csp).toContain("connect-src 'self' data: blob: https://auth.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
