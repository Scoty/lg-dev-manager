import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledUi } from './config.js';

describe('the local page a clone serves', () => {
  it('is its own fresh build, never a stale web/ copy left behind by pnpm pack', () => {
    const stale = fileURLToPath(new URL('../web/', import.meta.url));
    const had = existsSync(stale);
    mkdirSync(stale, { recursive: true });
    if (!had) writeFileSync(join(stale, 'index.html'), '<title>stale 1.0.0</title>');
    try {
      const ui = bundledUi();
      expect(ui).not.toBe(stale);
      if (typeof ui === 'string') expect(ui).toBe(fileURLToPath(new URL('../../web/dist/', import.meta.url)));
    } finally {
      if (!had) rmSync(stale, { recursive: true, force: true });
    }
  });
});
