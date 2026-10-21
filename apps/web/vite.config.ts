import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// VITE_BASE: "/pilotix/" for GitHub Pages, "./" (default) for the phone apps.
export default defineConfig({
  base: process.env.VITE_BASE || './',
  plugins: [react()],
  resolve: {
    alias: { '@pilotix/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 600 },
});
