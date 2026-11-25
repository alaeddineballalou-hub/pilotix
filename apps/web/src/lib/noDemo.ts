// The live site's stand-in for the in-browser demo's engine (vite.config.ts): PostgreSQL in the browser
// (@electric-sql/pglite) and the shared core with its made-up data (@pilotix/core) are never built into pilotix.online
// (25 Nov 2026: the demo lives only in the Pilotix artifact). Nothing reaches this file there: every use of the demo
// sits behind DEMO_BUILD / DEMO_ONLY (lib/backend.ts).
export {};
