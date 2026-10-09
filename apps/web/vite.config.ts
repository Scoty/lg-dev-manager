/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base + hash routing: the same build works on GitHub Pages
// (https://<user>.github.io/lg-dev-manager/) and when served by the bridge (http://localhost:5199/).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', globals: false },
});
