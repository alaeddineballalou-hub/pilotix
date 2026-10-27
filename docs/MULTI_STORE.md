# Multi-store Pilotix (all clients on pilotix.online)

Status: plan agreed 2026-10-26. Steps 1 and 5, billing and the store part of step 4 were built the same day (the
control room); **steps 2 and 3 were built on 2026-10-27 (accounts, store picker, sign-up, owner privacy)** — see "What is
built" below. Left: the phone apps' store picker. Each step is its own branch, tested on a copy of
production (the e2e and browser checks), and only then pushed and deployed.

## What is built

Read `README.md` › "Several shops on one server" and `packages/core/src/platform/` before changing any of this.

- **Schemas.** Shop #1 (today's shop) **stays in `public`** — nothing to move, old links and tokens keep working. Every other
  shop gets `shop_<id>` (not `s_<id>`). Platform tables in `platform`; extensions (pg_trgm) in `ext`; each pooled
  connection runs with `search_path = <schema>, ext`. Migrations: platform (`p001_platform`, `p002_accounts`), then
  `public`, then every other shop (`migrateAll`, run by `migrate.js` before the server starts).
- **Platform tables:** `shops` (slug UNIQUE = the store name, plan, trial / paid-until, status
  active|suspended|archived|deleted, demo, owner account, referral code), `plans` (monthly and yearly price, menus and
  sub-menus, limits: accounts, drivers, orders per month), `payments` (by hand, numbered receipts `PX-<year>-0001`),
  `staff` (owner / manager / support), `settings`, `audit`, and since step 2: `accounts`, `account_tokens`, `logins`
  (email × store), `signups`, `support_threads` / `support_messages`, `reminders`, `staff_codes`, `referrals`.
- **Accounts (step 2).** One e-mail = one account = one password for every store the person works in
  (`platform.accounts`); each store keeps its profiles and roles, and the profile mirrors the account's password hash.
  Login → straight in with one store, else the store picker (a 15-minute ticket, no password again); « Changer de
  boutique » from the account menu. Only the person sets their password (reset link, invitation link, Mon profil); a
  store's admin may set it only for someone who works in that store alone and is not its owner. A new password ends every
  other session at once (in every store).
- **The owner** is the account that created the store (`shops.owner_account_id`): nobody else changes their account,
  only they delete the store (password + the store's name; its schema is dropped, its row stays as « deleted »).
- **Sign-up and « Ajouter une boutique » (step 3).** `#/inscription[/<referral>]`: name checked live (unique, reserved
  words refused), terms accepted, nothing made before the e-mail link (48 h) is opened; then the store is made on the
  trial plan and the person is in. « Ajouter une boutique » needs a confirmed e-mail; stores per person: the setting,
  or the owner's own number set in the control room. Limits: 10 sign-ups per 15 minutes per address, 3 an hour per e-mail.
- **Privacy.** The control room has no « open as » and never sets or sees a store's password: a store it makes is an
  invitation e-mailed to its owner (or added to the account they already have). It sees numbers only (accounts, drivers,
  orders this month and last month, the owner's stores), and can suspend, archive and limit.
- **Store names and links.** A shop's slug is its store name, unique, never a reserved word. Landing pages:
  `site/<store>/<page>`; webhooks and the pages' calls: `/api/s/<store>/…` (shop #1 keeps `/api/…`).
- **Per shop:** tokens carry the shop; live updates in room `shop:<id>`; background jobs loop over the shops.
- **Control room** (`#/platform`): two-step login (a code by e-mail, a device remembered 30 days; emergency switch
  `PLATFORM_TWO_STEP=off`), dashboard (sign-ups, conversion, messages, stores over their limits), stores (limits, owner,
  referrals, payments with receipts to print or e-mail), plans, sign-ups, messages from stores (« Contacter Pilotix »),
  backups (nightly backups in `/opt/pilotix-backups`, the database's and each store's size), Doctor (machine, database,
  jobs, errors, settings), settings
  (trial, sign-ups, reminders, referral, security, company on receipts, terms text, payment details, a message to every
  shop), journal, demo shop, staff.
- **Automatic:** reminders e-mailed at 8:00, Algeria time (trial ending, paid period ending, grace, locked: once per end date); a free
  month to the store that brought another one, at that store's first payment.
- **Own domains** (p002, another session the same day): Caddy on-demand HTTPS, `/api/domain-check`,
  `/api/domain/<page>`; llms.txt per shop (`/api/s/<store>/llms.txt`, linked from the platform's). The Doctor (server and
  per shop). That session also made a first sign-up and store picker with a password per shop; p003 replaced them with
  the accounts above (its `platform.signups` and `platform.email_checks` tables stay, unused).

**Still open:** online card payments (Chargily Pay: CIB / Edahabia) — payments are recorded by hand in the control room.

## What the owner asked for

- Clients **sign up by themselves**; their account gets a first store.
- An account can **add more stores**.
- **Every store name is unique on the whole platform** (it is the first part of the links).
- Landing pages are `pilotix.online/<store>/<page>`: a page name is unique **inside its store**, so `a/b` and `c/b` can
  both exist, `a/b` twice cannot.
- **One email can work in several stores** (the owner of two shops, an agent working for two clients): after login the
  person picks the store.

## Design: one PostgreSQL schema per store

Today one database holds one shop: 66 tables, ~1,170 queries, settings, order numbers (PX…), users, login, live updates,
jobs and webhooks all assume a single shop.

- **Platform tables** (schema `platform`): `accounts` (email unique, password hash, name, email verified, platform admin),
  `stores` (id, slug unique, shop name, owner account, status active/suspended, created), `members` (account × store →
  the store's profile id), sign-up rate limits.
- **Each store** gets its own schema `s_<id>` with the 66 tables, exactly as today. The existing queries do not change and
  cannot see another store's tables. Order numbers, settings, Meta tokens, couriers, Google Sheets stay per store for free.
- **Every request is routed to one store**, and the `Db` given to the core runs with `search_path = s_<id>`:
  - the app: the token names the account and the store chosen at login;
  - landing pages: `/<store>/<page>` (and `/api/lp/…` links already in ads: the first store, i.e. today's shop);
  - webhooks (couriers, site orders, Google Sheets, Meta): addresses carry the store, `/api/hooks/<store>/…`;
  - jobs (courier sync, Meta, Sheets, landing, notify…): one loop over the active stores.
- **Migrations** run for the platform schema, then for every store schema; a new store = create schema + migrate + base
  settings + the owner as administrator.
- Uniqueness: `platform.stores.slug` is UNIQUE (reserved words refused: api, live, assets, lp, s, app, admin, www…);
  `landing_pages.slug` stays UNIQUE inside each store schema.

Why not a `store_id` column on every table: all ~1,170 queries would need a filter, and one forgotten filter shows a
client's orders to another client. Schemas make that mistake impossible. Limit: fine for hundreds of stores; thousands
would need another look (PostgreSQL catalog size).

## Steps

1. **Platform foundation (no visible change).** `platform` schema, store schemas, per-request `search_path`, migrations
   for all stores, today's shop moved into the first store. Tests: two stores, every procedure checked for leaks.
2. **Accounts and login.** Credentials move to `platform.accounts`; each store keeps its profiles and roles, linked to
   the account. Login → store picker when the person belongs to several. Token = account + store. Password reset per
   account. Live updates per store.
3. **Sign up and « Ajouter une boutique ».** Public sign-up (email, password, store name checked live for uniqueness),
   email verification, rate limits and a maximum number of stores per account against spam; the same form from the
   account menu adds a store.
4. **Store-aware links, webhooks and jobs.** `/<store>/<page>`, `/api/hooks/<store>/…`, job loop, llms.txt per store,
   robots.txt, Meta events with the store's own pixel and token.
5. **Platform admin** (the owner of pilotix.online): list of stores and accounts, suspend / reactivate, usage.
6. **Moving production.** Full backup, rehearsal on a copy of the production database, then the real move during a quiet
   hour. Old links and webhook addresses keep working for today's shop.

## Open questions (later)

- Custom domains per store (`shop.com` instead of `pilotix.online/<store>`).
- The phone apps (Android/iOS) need the store picker too.
