import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Modes:
//   default   — the real app (server); VITE_DEMO=1 adds the demo accounts on the login screen
//   artifact  — the preview published in Claude: demo only, relative paths, files next to the page
export default defineConfig(({ mode }) => ({
  base: mode === 'artifact' ? './' : process.env.VITE_BASE || './',
  define: mode === 'artifact' ? { 'import.meta.env.VITE_DEMO_ONLY': JSON.stringify('1'), 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {},
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@pilotix\/shared$/, replacement: src('../../packages/shared/src/index.ts') },
      { find: /^@pilotix\/core$/, replacement: src('../../packages/core/src/index.ts') },
    ],
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
  },
}));
