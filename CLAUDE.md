# Working on Pilotix

Read [AGENTS.md](AGENTS.md) first (rules for every change) and [docs/ROADMAP.md](docs/ROADMAP.md) (the engineering plan).

## Putting a change live — the owner's rule (11 Nov 2026)

The agents work in Pilotix all day. Every server update restarts it, and many updates in one day made them drop.

1. **Work on a branch** (`preview/<topic>`: the Preview workflow builds its demo) and check it there: types, tests,
   pictures of the pages it changes for the owner.
2. **Only when everything is good**: rebase on `origin/main`, then push to `main` (Pilotix CI runs on it).
3. **Fill the owner's « Pilotix Deploy » page** (a Claude artifact): one box per part the push changed, as the
   pilotix-change-push skill says. He looks, tests, and presses « Déployer cette nuit ».
4. **`main` goes live at 00:00 Algiers time only with his yes**: a Claude scheduled task reads the yes and runs
   `.github/workflows/deploy.yml` with `source=page` and the sha he said yes to; the workflow also needs Pilotix CI
   green on it. No yes = nothing goes live. Never put a change live during the day.
5. **Urgent only** (the site is down, a fix that cannot wait for the night), **and only when the owner asks for it**:
   `gh workflow run deploy.yml -f source=urgent -f sha=<the main version you checked>`. With `sha`, the run stops if
   main moved since you checked it (24 Nov 2026: an urgent deploy without it took two other commits whose tests were
   still running). Show the owner what goes live first (the deploy skill's list).

The phone app (`.github/workflows/mobile.yml`) is still published to the phones by a push to `main` that changes
`mobile/`: during the day, ask the owner first.

## Database steps — never edit an old one (24 Nov 2026)

Each database step runs **once** on a server, is written down there (`schema_migrations` for the shops' steps in
`packages/core/src/migrations/` and `db.ts › MIGRATIONS`, `platform.migrations` for `platform/schema.ts ›
PLATFORM_MIGRATIONS`), and is **never run there again**. A table, column or index written into an old step reaches new
servers and the tests (they start from an empty database), but **never the live server**: that is how « Mes appareils »
and the agency's alerts answered « Erreur du serveur » on 23–24 Nov 2026 (p003 and p005 edited).

- Any change to the tables is a **new step at the end** (`migrations/130_…` + its line in `MIGRATIONS`, or
  `p047_…` in `PLATFORM_MIGRATIONS`), with `IF NOT EXISTS` / `IF EXISTS` so it is safe to run on any server.
- `test/shopsteps.test.ts` and `test/platformsteps.test.ts` pin every old step: an edit fails CI. Add the new step's
  line at the end of its list; never change an old line to make the test pass.
- The only exception: a step whose update **stopped the server** (so it was never done there). Fix it, change its line,
  and write `db-step-fix: <step name>` in the commit message: the deploy refuses a changed line without it.
