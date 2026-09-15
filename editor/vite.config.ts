import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the renderer only. The main process and preload are bundled by
// scripts/build-main.mjs.
export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  // Loaded from file://, so asset URLs must be relative.
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Imported assets (the built-in icons in ../assets/icons) as files, never
    // inlined as data: URLs, which the page's CSP (img-src 'self') refuses.
    assetsInlineLimit: 0,
  },
});
