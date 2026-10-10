import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // Bundle the workspace protocol package; keep real npm deps external.
  noExternal: ['@lgdm/protocol'],
  banner: { js: '#!/usr/bin/env node' },
  // Keep "node:" in imports: some built-ins exist only under that name (node:sea), and tsup strips it by default.
  removeNodeProtocol: false,
});
