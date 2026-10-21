# Pilotix

Order management for cash-on-delivery e-commerce teams in Algeria — one codebase for the **website**, the **Android app** and the **iOS app**. Pilotix runs on its own: its own server, database, accounts and data.

## What's inside

```
apps/
  server/     NestJS (Fastify) API — login, roles, orders, products, team, dashboard, live updates, background jobs
  web/        React + Vite app — also packaged as Android/iOS with Capacitor
packages/
  shared/     Types and rules shared by both (statuses, roles, phone format, 69 wilayas)
db/migrations SQL schema (PostgreSQL)
scripts/      End-to-end test run in CI
```

| Part | Choice |
| --- | --- |
| Language | TypeScript everywhere (strict) |
| Screens | React 18 + Vite, TanStack Query, TanStack Table, TanStack Virtual (lists of 100,000+ orders stay smooth) |
| Languages | Français · English · العربية with full right-to-left layout for Arabic (i18next) |
| Weak network | Actions made offline are stored on the phone (IndexedDB) and sent when the network returns; each has a unique id so it is never applied twice |
| Phone apps | Capacitor (Android + iOS) |
| Server | NestJS on Fastify, zod validation, JWT login, role checks on every request, login rate limit |
| Live updates | Socket.IO — order changes and who is online, without refreshing |
| Background jobs | BullMQ + Redis — customer notifications (WhatsApp/SMS hook), daily database maintenance |
| Database | PostgreSQL 16 — orders split by month (partitions), trigram search on names/phones, full change history, money in whole dinars |

## Roles

`admin` · `manager` · `confirmation` · `agent` · `suivi` · `depot` · `livreur`. The server decides who may move an order to which status (`packages/shared/src/index.ts`, `STATUS_FLOW` and `STATUS_ROLES`). Livreurs only see their own orders.

Order statuses: new → confirmed / call back / no answer / postponed / cancelled / duplicate → assigned → shipped → delivered or returning → returned. Stock leaves on **shipped** and comes back on **returned**.

## Run it locally

Needs Node 20+ and Docker.

```bash
npm install
docker compose up -d postgres redis
cp apps/server/.env.example apps/server/.env      # then edit it
npm run build -w @pilotix/shared && npm run build -w @pilotix/server
SEED_ADMIN_PASSWORD='choose-a-strong-one' npm run db:migrate && SEED_ADMIN_PASSWORD='choose-a-strong-one' npm run db:seed
npm run dev:server            # API on http://localhost:3000
npm run dev:web               # app on http://localhost:5173
```

Log in with `admin@pilotix.dz` and the password you chose; the login screen asks for the server address (`http://localhost:3000`).

## Phone apps

```bash
npm run build -w @pilotix/web
cd apps/web
npx cap add android && npx cap open android   # Android Studio → Run
npx cap add ios && npx cap open ios           # Xcode (Mac) → Run
```

## CI (GitHub Actions)

Every push runs: server build → database migration → **end-to-end test** against a real PostgreSQL + Redis (`scripts/smoke-test.sh`), web typecheck + build, website deploy to GitHub Pages, Android APK, iOS simulator build. APK and iOS builds are downloadable from each run's **Artifacts**.

## Going to production

1. Host PostgreSQL + Redis + the server (Docker image in `apps/server/Dockerfile`). Put Cloudflare in front.
2. Set a long random `JWT_SECRET`, real `CORS_ORIGINS`, and run `db:migrate` then `db:seed` once.
3. Point the app at the server address (login screen, or `VITE_API_URL` at build time).
4. **Algerian data law (Law 18-07, amended by Law 25-11 of 2025):** customer names, phones and addresses are personal data. Storing them outside Algeria needs ANPDP authorization; breaches must be reported to the ANPDP within 5 days. Check the exact setup with a legal advisor.

## Not done yet (next steps)

- Edit-order form in the app (the API supports it: `PATCH /api/orders/:id`)
- Product and user management screens (API ready: `POST/PATCH /api/products`, `/api/users`)
- WhatsApp Business / SMS provider (hook in `apps/server/src/jobs/jobs.service.ts`)
- Delivery-company integrations (Yalidine, ZR Express…) as background jobs
- Agent performance reports; ClickHouse when volume justifies it
- Native-speaker review of the Arabic translations (`apps/web/src/locales/ar.json`)
