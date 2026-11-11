# Working on Pilotix

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
   `gh workflow run deploy.yml -f source=urgent`.

The phone app (`.github/workflows/mobile.yml`) is still published to the phones by a push to `main` that changes
`mobile/`: during the day, ask the owner first.
