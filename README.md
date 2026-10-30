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
apps/web          React app (website)
mobile           Android and iOS apps (Capacitor): they open the live website and add phone powers
docs/             build guide and the inventory of the original Pilotix screens
```

The same core runs in two places:
- on the **server**, against PostgreSQL;
- in the **browser preview** (demo), against PGlite — PostgreSQL compiled to WebAssembly — with a generated demo shop.
  The preview behaves exactly like the real app, with no server.

Every change runs in CI: core rule tests, the server against a real PostgreSQL 16 with an end-to-end test,
the web build, the website (GitHub Pages, with the demo) and the preview. The Android test app is built
by `mobile.yml`, only when `mobile/` changes.

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

### Pilot AI (Dellal learns every night)

One AI key for every shop, Pilotix's own (control room › Pilot AI): shops add no key. Dellal answers with Haiku and
switches to Sonnet for the hard moments (price fight, trust fear, anger, big order, asking for a person). Its instructions
are sent as three cached blocks (the part every shop shares with the coach's lesson book, the shop's part, the chat's part).

Every night at 02:30 (Algeria), the chats of the shops ticked in the control room (Pilot AI › Shops that teach Dellal;
shops see no Pilot AI setting) are read inside each shop with names, phones, addresses, products and prices removed, and scored by what really happened:
delivered and paid is the only win, a refused parcel is a loss, cancellations and returns keep the agent's reason, chats a
person took over and won are gold, chats still waiting for delivery are kept until they end. One Message Batch (half
price) under a hard nightly cap: Haiku reads the chats, Sonnet writes short habits, a safety check refuses prices, stock,
delays, pressure or « I am human ». The coach approves, edits or rejects each habit in the control room; a new book is
tried on a share of new chats and kept only if it gets at least as many parcels delivered (stopped by itself when worse).
Code: `packages/core/src/modules/pilotlearn.ts` (the engine), `apps/server/src/jobs.ts` (the night), tests `pilotlearn*.test.ts`.

**Daily limit** (Pilot AI › Réglages, 3 $ by default, 0 = none): the most Pilotix's key spends on live answers in one
day, every shop together (Algeria's day). Reached: the AI rests until midnight as if Pilot AI were off (Dellal and the CM
AI agent answer with their simple rules, AI Spy waits; an answer already started finishes), and the owner and the managers
get one e-mail that day. When Pilotix pays, the CM AI agent and AI Spy answer with Haiku whatever the shop chose. After the
night, when lessons wait, every control-room member gets the coach's note by e-mail, and the menu shows how many wait.

**AI cost per shop** (control room › Pilot AI, owners and managers): every answer Claude gives on the server (Dellal, CM AI
agent, AI Spy) is counted per shop, day, agent and payer (Pilotix's key or the shop's own) at Anthropic's list price, in
`platform.ai_usage`. The card shows each month per shop in USD, and in DA at the rate the owner types (1 $ = … DA), with a
CSV to bill. Code: `packages/core/src/platform/aiusage.ts`, counted in `dellal-server.ts › complete()`.

**The tabs** (control room › Pilot AI): **Dellal AI** — its sales over 7, 30 or 90 days, every shop, one shop or one of
its products: the chats that started in the period and what became of them (conversion: of 100 chats, how many ended
with an order; real sales: how many with a parcel delivered and paid, counted once the parcels had 7 days to arrive),
against the period before, day by day (a 7-day average for 30 days, weeks for 90), per shop › product › channel, and why
chats ended without a sale (what Pilot AI read at night); how Dellal learns, drawn (day, night, morning, test) with its
rules in simple words, always the engine's own numbers; its instruction book (method, Darija, the lesson book in service
and the one in test) put together at each download, so it is always the latest; then last night, the coach and the books.
**CM AI** (the comments it answered, sent in private, hid or handed to the team), **Spy AI** (products watched, the
competitors' ads found and read, the alerts), **Réglages & coûts** (the key, the limits, the cost per shop). The AI
cost is shown to owners and managers only. Code: `packages/core/src/platform/aiboard.ts` (`p.dellal.board`,
`p.cm.board`, `p.spy.board`, `p.pilot.bookText`), `apps/web/src/pages/platform/PilotBoards.tsx`, `PilotLearn.tsx`.

### Backup door (direct.pilotix.online)

When Cloudflare's road from a country is cut (the site times out there while the server is fine), the team can use
`https://direct.<domain>`: the same app and server, reached straight, without Cloudflare. Setup, once: in Cloudflare › DNS,
add an **A** record named `direct` with the server's address (the same as the main record) and **DNS only** (grey cloud).
Caddy makes its certificate at the first visit (the server allows that one name, `domain-check`); the app opened there talks
to that same address (`BACKUP_DOOR` in `apps/web/src/lib/backend.ts`); Google sign-in is hidden there (e-mail and password).
The record shows the server's address publicly, as a shop's own domain already does.

## Phone apps

The apps live in `mobile/` (Capacitor 8). They open the live `https://pilotix.online`, so every website change
shows in the apps with no new app version; only new phone powers (plugins), the icon or the name need one.
Plan, steps and decisions: `mobile/PROGRESS.md`.

```bash
cd mobile && npm ci && npx cap sync android
npx cap open android                            # Android Studio → Run
```

GitHub builds the Android test app on every change in `mobile/` and puts it at
`https://github.com/alaeddineballalou-hub/pilotix/releases/download/app-test/pilotix-test.apk`.

## Several shops on one server (Pilotix as a service)

One server hosts many shops, each paying for its own plan. Every shop has **its own PostgreSQL schema** (its own
tables: no query can reach another shop's data); the platform itself (shops, plans, payments, staff, journal) lives in
the schema `platform`. The server owner's shop is shop #1 (schema `public`, as before; it never expires).

- **Control room:** `https://<domain>/#/platform` — Pilotix staff only (owner / manager / support), with a code by e-mail
  at each login (a device can be remembered 30 days). The first administrator of shop #1 is the owner (same e-mail and
  password). There: shops (create with a free trial: the owner gets an invitation e-mail and chooses the password; suspend,
  archive; numbers only, never what is inside a shop), payments received by hand (numbered receipts to print or e-mail),
  plans (monthly and yearly price, accounts, drivers, orders per month, menus and sub-menus), sign-ups, messages from
  shops, backups (nightly backups, each shop's size), Doctor, the demo shop, staff, settings and the journal.
- **Accounts:** one e-mail = one account = one password for every shop the person works in; after the password, the
  person picks the shop (or goes straight in with one). Anyone can create a shop at `#/inscription` (confirmed by e-mail)
  and add more from the account menu. Only the person who created a shop (its owner) can delete it. Tokens made before
  carry no shop: they open shop #1.
- **Own domain:** a shop's administrator writes its domain in Landing pages › Réglages; once its A record points to the
  server (`PUBLIC_IP` in `deploy/.env` when the platform's domain is behind Cloudflare), Caddy gets its HTTPS
  certificate on the first visit and `https://myshop.com/<page>` serves the shop's pages (`/` lists them, `/llms.txt`).
- **Doctor:** the control room's Doctor watches the server (machine, database, jobs, errors, silent shops); each shop's
  Dashboard has its own Pilotix Doctor.
- **Archives (Management › Archives):** accounts, products and depots a shop no longer needs are archived (closed and out
  of every list, kept in the history); only what is archived and was never used (no order, stock movement, money,
  message…) can be deleted for good, by the shop's owner. `modules/archive.ts` lists every column that points to them;
  a test fails when a new one is missing. Nobody can see a password: an administrator makes a new one, shown once.
- **Subscription:** trial → paid → a few grace days (red banner) → locked (a screen with the payment details). A locked
  shop keeps receiving orders (website, landing pages, couriers' statuses) and sees them once it pays.
- **Public links:** every shop's landing pages are `site/<store>/<page>`, where the store is the shop's name on the
  platform (unique; shop #1 chooses it in Landing pages › Réglages, the others get it in the control room). Shop #1 keeps
  its other links (`/api/lp/…`, `/api/hooks/…`); the others use `/api/s/<store>/lp/…`, `/api/s/<store>/hooks/…` (the app
  shows each shop its own).
- **Menus:** a plan lists the menu items it includes and the sub-menus it leaves out; the server refuses the paid
  features a shop does not have (AI agents, AI Spy, advertising, marketers, landing pages, Google Sheets channels).

## Going to production

One command on a fresh Ubuntu server (4 GB RAM), once the domain's DNS A records (`@` and `www`) point to it:

```bash
curl -fsSL https://raw.githubusercontent.com/alaeddineballalou-hub/pilotix/main/deploy/install.sh | sudo bash -s -- pilotix.online
```

It installs Docker, starts PostgreSQL + Redis + the server + the website behind Caddy (automatic HTTPS), asks for the
first administrator and sets a daily database backup. Run it again to update. By hand, the steps are:

**Updates from GitHub, without logging in to the server:** once, on the server, run
`sudo bash /opt/pilotix/deploy/setup-github-deploy.sh` and put the two secrets it prints in GitHub (Settings › Secrets and
variables › Actions). Then **Actions › Deploy to the server › Run workflow** backs up the database and updates the server
(the site pauses a few seconds). The key it uses can run only `deploy/update.sh`. By hand: `sudo /opt/pilotix/deploy/update.sh`.


1. Host PostgreSQL + Redis + the server (Docker image: `apps/server/Dockerfile`; it migrates on start). Put Cloudflare in front.
2. Set a long random `JWT_SECRET`, real `CORS_ORIGINS` and `PUBLIC_URL`; create the first admin with `db:seed`.
3. In the app: Réglages (shop, depots, webhook key), Sociétés de livraison (API keys of each courier, tariffs), Management (prices, pay, statuses), Utilisateurs.
4. Website orders: POST to `/api/hooks/orders/site?key=<key>` (or a sales channel's own URL, see Management → Canaux de vente).
5. **E-mails** (control-room login codes, « Mot de passe oublié » links, invitations, sign-ups): on the server run
   `sudo bash /opt/pilotix/deploy/set-email.sh` — it asks the SMTP login and key (Brevo by default: `smtp-relay.brevo.com`,
   `587`, the SMTP login and an SMTP key from Brevo › Settings › SMTP & API), restarts the server and checks the account.
   By hand: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` in `deploy/.env`, then run the installer again.
   Without them the login page simply hides the link.
6. Without Redis, call `POST /api/hooks/cron?key=<cron key>` every 30 minutes to refresh courier statuses.
7. **Algerian data law (Law 18-07, amended by Law 25-11 of 2025):** customer names, phones and addresses are personal data.
   Storing them outside Algeria needs ANPDP authorization; breaches must be reported to the ANPDP within 5 days. Check with a legal advisor.
