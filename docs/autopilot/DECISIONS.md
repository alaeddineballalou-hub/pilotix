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
- Answer: changed 28 Nov 2026 by the owner — **nonstop**: a run starts every 30 minutes, 24/7; a run that finds the lock busy stops at once, so runs follow each other back to back. Each run still works at most 90 minutes on one task.

### D2 — Backup for the restore rehearsal
- Status: open
- Holds: P0-06
- Why it needs you: only you have production backups. The restore runs on your PC, in a local database; the data is never committed or sent anywhere.
- Options: A) put the latest production backup file in `C:\Users\alaed\pilotix-backups\` and write how backups are made (recommended)  B) give the backup command/location used on the server
- Answer: A (28 Nov 2026). **Keep this decision open until a backup file is in `C:\Users\alaed\pilotix-backups\`** — the folder does not exist yet. The owner also writes there, in `HOW-BACKUPS-ARE-MADE.txt`, how and how often backups are taken. When both are present, close D2 and run P0-06.

### D3 — Where alerts go
- Status: open
- Holds: P0-07
- Why it needs you: alerts must reach you.
- Options: A) email  B) Telegram  C) WhatsApp  D) other
- Answer: C — WhatsApp (28 Nov 2026). Use the WhatsApp sending Pilotix already has if one exists; the owner's number is never written in the repo (read it from server config / env). Production alert config still needs the owner's yes.

### D4 — Privacy law (Law 18-07)
- Status: open
- Holds: Phase 1 privacy rows
- Why it needs you: legal obligations need qualified local advice before agents code them.
- Options: A) you get local advice; agents meanwhile do only the technical inventory (who can see phones/addresses, exports) (recommended)  B) skip privacy rows for now
- Answer: B — skip privacy rows for now (28 Nov 2026). Mark Phase 1 privacy rows `deferred`; security and access-control rows go ahead.

### D5 — Protect `main` (Phase 3)
- Status: open
- Holds: Phase 3 branch-protection row
- Why it needs you: changes how every agent pushes.
- Options: A) keep direct push to `main` after checks + review, as CLAUDE.md says (recommended for now)  B) PR + required review
- Answer: A — keep direct push to `main` after checks + review (28 Nov 2026).
