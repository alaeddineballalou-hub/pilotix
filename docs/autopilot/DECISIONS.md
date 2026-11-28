# Owner decision queue

The only place the autopilot asks you anything. It never waits: it holds the affected task and keeps working.

**To answer:** write after `Answer:` (edit this file on GitHub, or tell any Claude session "answer D2: A").
The next run applies it.

**To pause everything:** add an empty file `docs/autopilot/PAUSED` on `main` (or turn off the scheduled task).

---

### D1 — Run schedule and cost cap
- Status: closed
- Holds: —
- Why it needs you: nonstop runs spend your Claude usage.
- Options: A) every 2 hours, 07:00–23:00, max 90 min per run (recommended)  B) every hour, 24/7
- Answer: A (set at setup, 28 Nov 2026 — change any time)

### D2 — Backup for the restore rehearsal
- Status: open
- Holds: P0-06
- Why it needs you: only you have production backups. The restore runs on your PC, in a local database; the data is never committed or sent anywhere.
- Options: A) put the latest production backup file in `C:\Users\alaed\pilotix-backups\` and write how backups are made (recommended)  B) give the backup command/location used on the server
- Answer:

### D3 — Where alerts go
- Status: open
- Holds: P0-07
- Why it needs you: alerts must reach you.
- Options: A) email  B) Telegram  C) WhatsApp  D) other
- Answer:

### D4 — Privacy law (Law 18-07)
- Status: open
- Holds: Phase 1 privacy rows
- Why it needs you: legal obligations need qualified local advice before agents code them.
- Options: A) you get local advice; agents meanwhile do only the technical inventory (who can see phones/addresses, exports) (recommended)  B) skip privacy rows for now
- Answer:

### D5 — Protect `main` (Phase 3)
- Status: open
- Holds: Phase 3 branch-protection row
- Why it needs you: changes how every agent pushes.
- Options: A) keep direct push to `main` after checks + review, as CLAUDE.md says (recommended for now)  B) PR + required review
- Answer:
