# Working on Pilotix

## Putting a change live — the owner's rule (11 Nov 2026)

The agents work in Pilotix all day. Every server update restarts it, and many updates in one day made them drop.

1. **Work on a branch** (`preview/<topic>`: the Preview workflow builds its demo) and check it there: types, tests,
   pictures of the pages it changes for the owner.
2. **Only when everything is good**: rebase on `origin/main`, then push to `main` (Pilotix CI runs on it).
3. **`main` goes live by itself at night**, every night at 03:17 Algiers time (`.github/workflows/deploy.yml`): the
   latest main, if Pilotix CI passed on it. Never put a change live during the day.
4. **Urgent only** (the site is down, a fix that cannot wait for the night), **and only when the owner asks for it**:
   Actions › Deploy to the server › Run workflow, or `gh workflow run deploy.yml`.

The phone app (`.github/workflows/mobile.yml`) is still published to the phones by a push to `main` that changes
`mobile/`: during the day, ask the owner first.
