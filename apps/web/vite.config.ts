import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Modes:
//   default   — the real app (server); VITE_DEMO=1 adds the demo accounts on the login screen (GitHub Pages' preview)
//   artifact  — the preview published in Claude: demo only, relative paths, files next to the page
// The in-browser demo (PostgreSQL in the browser, the shared core with its made-up data) is built only into those two:
// the live site (pilotix.online, VITE_DEMO=0) gets an empty file in their place, so none of the demo's files ship
// there (25 Nov 2026: the demo lives only in the Pilotix artifact). Nothing reaches that file on the live site: every use
// of the demo sits behind DEMO_BUILD / DEMO_ONLY (lib/backend.ts).
export default defineConfig(({ mode }) => {
  const demoBuild = mode === 'artifact' || loadEnv(mode, src('.'), 'VITE_').VITE_DEMO === '1';
  const noDemo = demoBuild ? [] : [{ find: /^(@electric-sql\/pglite|@pilotix\/core)$/, replacement: src('./src/lib/noDemo.ts') }];
  return {
    base: mode === 'artifact' ? './' : process.env.VITE_BASE || './',
    define: mode === 'artifact' ? { 'import.meta.env.VITE_DEMO_ONLY': JSON.stringify('1'), 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {},
    // JSX drawn by lib/jsx: React's, with the app's « #/… » links turned into real addresses (lib/route.ts)
    plugins: [react({ jsxImportSource: '@pilotix/jsx' })],
    resolve: {
      alias: [
        ...noDemo,
        { find: /^@pilotix\/shared$/, replacement: src('../../packages/shared/src/index.ts') },
        { find: /^@pilotix\/core$/, replacement: src('../../packages/core/src/index.ts') },
        { find: /^@pilotix\/jsx\/(jsx-runtime|jsx-dev-runtime)$/, replacement: src('./src/lib/jsx/$1.ts') },
      ],
    },
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
      rollupOptions: {
        output: {
          // The artifact host serves a fixed list of file types: PostgreSQL's data bundle ships as ".wasm" (bytes unchanged).
          assetFileNames: (a: { name?: string }) => (a.name?.endsWith('.data') ? 'assets/[name]-[hash].pgdata.wasm' : 'assets/[name]-[hash][extname]'),
        },
      },
    },
  };
});
