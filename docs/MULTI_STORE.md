# Multi-store Pilotix (all clients on pilotix.online)

Status: plan agreed 2026-10-26. **Since then the control room ("Pilotix as a service", another session, same day) built
steps 1 and 5, billing, and the store part of step 4 — see "What is built" just below. Start from there: steps 2 and 3
remain.** Each step is its own branch, previewed, tested, and only then pushed and deployed.

## What is built (control room, 2026-10-26)

Read `README.md` › "Several shops on one server" and `packages/core/src/platform/` before changing any of this.

- **Schemas.** Shop #1 (today's shop) **stays in `public`** — nothing to move, old links and tokens keep working. Every other
  shop gets `shop_<id>` (not `s_<id>`). Platform tables in `platform`; extensions (pg_trgm) in `ext`; each pooled
  connection runs with `search_path = <schema>, ext`. Migrations: platform, then `public`, then every other shop
  (`migrateAll`).
- **Platform tables:** `shops` (slug UNIQUE = the store name, plan, trial / paid-until, status active|suspended|archived,
  demo, owner contact), `plans` (price, menus and sub-menus, account and order limits), `payments` (recorded by hand),
  `staff` (control-room accounts: owner / manager / support), `settings`, `audit`, `logins`.
- **Login today: one email = one shop.** `platform.logins` (email → shop) is kept by a trigger on every shop's
  `profiles`; an email already used in another shop is refused. Step 2 replaces this with accounts × stores.
- **Store names and links.** A shop's slug is its store name, unique, never a reserved word (`STORE_RESERVED`).
  Landing pages: `site/<store>/<page>` for every shop (the server finds the shop by its name; an unknown name sends to
  shop #1's address). Shop #1 still picks its name in Landing pages › Réglages › « Lien des pages » and the platform
  follows (`syncPrimaryStore`); other shops get theirs from the control room (read-only in their Réglages). Webhooks and
  the pages' order/lead/image calls: `/api/s/<store>/…` (shop #1 keeps `/api/…`).
- **Per shop:** tokens carry the shop; live updates in room `shop:<id>`; background jobs loop over the shops; courier
  caches keyed per shop's credentials.
- **Control room** (`#/platform`): shops (create with a free trial, suspend, archive, open as their admin for support,
  new admin password), payments by hand (BaridiMob, CCP, cash…) that extend the paid period, plans with menus and
  sub-menus plus per-shop overrides (the server refuses what is off), demo shop (reset nightly, "Essayer la démo"
  button), staff, settings (trial and grace days, payment details, a message to every shop), journal.

**Still to do from this plan:** step 2 (accounts working in several stores, store picker, token = account + store,
password reset per account — replaces `platform.logins`), step 3 (self sign-up creating a shop on the trial plan, email
verification, rate limits, « Ajouter une boutique »), llms.txt per store, the phone apps' store picker.

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

- Billing / plans (free trial, monthly price per store?) — not in these steps.
- Custom domains per store (`shop.com` instead of `pilotix.online/<store>`).
- The phone apps (Android/iOS) need the store picker too (step 2).
