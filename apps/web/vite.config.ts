import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// VITE_BASE: "/pilotix/" for GitHub Pages, "./" (default) for the phone apps.
// --mode artifact: one self-contained HTML file (the demo preview published as a Claude artifact).
export default defineConfig(({ mode }) => ({
  base: mode === 'artifact' ? './' : process.env.VITE_BASE || './',
  plugins: mode === 'artifact' ? [react(), viteSingleFile()] : [react()],
  resolve: {
    alias: { '@pilotix/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    assetsInlineLimit: mode === 'artifact' ? 100_000_000 : 4096,
  },
}));
