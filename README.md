# Pilotix

Order management for cash-on-delivery e-commerce teams in Algeria: confirmation calls, depot, delivery follow-up, couriers,
after-sales, livreurs, cash, stock, customers, marketing (advertising results and marketer pay per ad set), team pay and **Dellal**, an AI sales agent that answers
WhatsApp, Messenger, Instagram and TikTok and takes orders — on the **web**, **Android** and **iOS**.
Pilotix runs on its own: its own server, database and accounts.

**Languages:** Français · English · العربية (right-to-left).

## How it is built

```
packages/shared   statuses, roles, reasons, 69 wilayas + 1,541 communes, call timing rules
packages/core     every business rule (orders, confirmation, depot, suivi, SAV, couriers, cash, stock, pay, ads…),
                  the SQL schema and migrations, the demo shop, and the tests
apps/server       NestJS server: login, POST /api/rpc/:action (runs the core), live updates (Socket.IO),
                  website order webhook, courier sync and Meta Ads sync jobs
apps/web          React app (website) — also the Android and iOS apps (Capacitor)
docs/             build guide and the inventory of the original Pilotix screens
```

The same core runs in two places:
- on the **server**, against PostgreSQL;
- in the **browser preview** (demo), against PGlite — PostgreSQL compiled to WebAssembly — with a generated demo shop.
  The preview behaves exactly like the real app, with no server.

Every change runs in CI: core rule tests, the server against a real PostgreSQL 16 with an end-to-end test,
the web build, the website (GitHub Pages, with the demo), the Android APK and the preview.

## Roles

| Role | Can |
|---|---|
| Administrateur | everything, including users, couriers, prices, settings, cash |
| Vendeur (propriétaire) | orders, confirmation, suivi, stock, customers, marketing (no users / settings) |
| Agent manager | what an agent does + team supervision and dashboard |
| Confirmation | call customers, confirm orders |
| Suivi | follow parcels, alerts, claims, swaps |
| Dépôt | prepare, ship, receive returns, stock |
| Livreur | own round: delivered / failed / return, chat with the shop |
| Marketeur | own ad sets, their real profit and what they are paid (Marketing) |

## Run it locally

Needs Node 22 and Docker.

```bash
npm install
docker compose up -d postgres redis
cp apps/server/.env.example apps/server/.env          # then edit it
npm run build -w @pilotix/shared && npm run build -w @pilotix/core && npm run build -w @pilotix/server
npm run db:migrate
SEED_ADMIN_PASSWORD='choose-a-strong-one' npm run db:seed
npm run dev:server                                     # API on http://localhost:3000
npm run dev:web                                        # app on http://localhost:5173
```

### Dellal (AI sales agent)

Menu **Messages**: one inbox for WhatsApp, Messenger, Instagram and TikTok. Dellal answers with your real products, stock and
delivery fees, takes the order (→ Confirmation › Nouvelles, or straight to Confirmée) and hands the conversation to a person
for complaints, wholesale, or anything it is unsure about. Setup in Messages › Réglages (admin): the Anthropic API key, then
in your Meta app the webhook `https://<server>/api/hooks/meta` with the verify token shown there, the app secret, the WhatsApp
phone number ID + token and the page token. Follow-ups run every 15 minutes (needs `REDIS_URL`). Without a key, and in the
demo, a rule-based demo seller answers so the whole flow can be tried in Messages › Tester.

Try it with the demo shop instead: `npm run seed:demo -w @pilotix/server` on an empty database
(accounts `admin@demo.pilotix.dz`, `samira@demo.pilotix.dz`… password `demo-pilotix`), or open the preview / the website and pick a demo account.

## Phone apps

```bash
npm run build -w @pilotix/web
cd apps/web
npx cap add android && npx cap open android     # Android Studio → Run
npx cap add ios && npx cap open ios             # Xcode on a Mac → Run
```

## Going to production

One command on a fresh Ubuntu server (4 GB RAM), once the domain's DNS A records (`@` and `www`) point to it:

```bash
curl -fsSL https://raw.githubusercontent.com/alaeddineballalou-hub/pilotix/main/deploy/install.sh | sudo bash -s -- pilotix.online
```

It installs Docker, starts PostgreSQL + Redis + the server + the website behind Caddy (automatic HTTPS), asks for the
first administrator and sets a daily database backup. Run it again to update. By hand, the steps are:


1. Host PostgreSQL + Redis + the server (Docker image: `apps/server/Dockerfile`; it migrates on start). Put Cloudflare in front.
2. Set a long random `JWT_SECRET`, real `CORS_ORIGINS` and `PUBLIC_URL`; create the first admin with `db:seed`.
3. In the app: Réglages (shop, depots, webhook key), Sociétés de livraison (API keys of each courier, tariffs), Management (prices, pay, statuses), Utilisateurs.
4. Website orders: POST to `/api/hooks/orders/site?key=<key>` (or a sales channel's own URL, see Management → Canaux de vente).
5. Without Redis, call `POST /api/hooks/cron?key=<cron key>` every 30 minutes to refresh courier statuses.
6. **Algerian data law (Law 18-07, amended by Law 25-11 of 2025):** customer names, phones and addresses are personal data.
   Storing them outside Algeria needs ANPDP authorization; breaches must be reported to the ANPDP within 5 days. Check with a legal advisor.
