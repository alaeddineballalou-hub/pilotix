# Pilotix — rules for every coding agent (Codex, Claude, others)

Read `CLAUDE.md` too: it holds the owner's full rules. The two that broke the live site when they were missed:

## 1. Database steps: never edit an old one

Each database step runs **once** on a server and is **never run there again**. A change written into an old step reaches
the tests and new servers (they start from an empty database) but **never the live server**. On 23 Nov 2026 two old
platform steps (p003, p005) were edited: on the live server « Mes appareils », every phone notification of a store and
the agency's alerts answered « Erreur du serveur » until new steps were added on 24 Nov.

- A change to the tables = a **new step at the end**:
  - shops: a new file `packages/core/src/migrations/130_<name>.ts` and its line at the end of `MIGRATIONS` in
    `packages/core/src/db.ts`;
  - platform: a new `['p047_<name>', SQL]` at the end of `PLATFORM_MIGRATIONS` in
    `packages/core/src/platform/schema.ts` (an SQL constant elsewhere that an old step uses counts as that old step).
- Write it so it can run on any server: `CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP … IF EXISTS`.
- `packages/core/src/test/shopsteps.test.ts` and `packages/core/src/test/platformsteps.test.ts` pin every old step by
  its fingerprint. When one fails, move your change into a new step. Add the new step's line at the end of its list.
  **Never change an old line to make the test pass.**
- Only exception: a step whose update stopped the server (never done there). Fix it, change its line, and write
  `db-step-fix: <step name>` in the commit message. The deploy refuses a changed line without it.

## 2. Going live: only with the owner's yes

The agents work in Pilotix all day and each server update restarts it. Push to `main` only when the branch is checked
(types, tests, pictures of the changed pages). `main` goes live at night after the owner's yes on his « Pilotix
Deploy » page. During the day only if he asks, and then with the version you checked:
`gh workflow run deploy.yml -f source=urgent -f sha=<that version>` (the run stops if main moved since).
