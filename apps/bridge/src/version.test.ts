import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BRIDGE_VERSION } from './version.js';

it('reports the version in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(BRIDGE_VERSION).toBe(pkg.version);
});
