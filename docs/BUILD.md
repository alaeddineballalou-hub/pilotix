# Pilotix v3 — build guide (read fully before writing code)

Goal: rebuild the ORIGINAL Pilotix app (a single-file app we are replacing) screen for screen, same look and same
features, on a clean stack. It must run standalone (no CodPilot). French UI by default, plus English and Arabic (RTL).

## Where things are

```
packages/shared   types + rules (statuses, roles, reasons, wilayas/communes, call timers, demo accounts). Built to dist.
packages/core     ALL business logic. SQL migrations, procedures (actions) with role checks, demo seed, tests.
                  Runs on the server (PostgreSQL) AND in the browser preview (PGlite = PostgreSQL in WASM).
apps/web          React 18 + Vite app (website + Android/iOS via Capacitor). Talks to core through `rpc(name, input)`.
apps/server       NestJS server (being rewritten to expose core procedures at POST /api/rpc/:name).
docs/LEGACY_INVENTORY.md   precise inventory of the original app (pages, columns, statuses, rules).
/home/claude/ref/shots/*.png   screenshots of the ORIGINAL app, per role and page  (look at them!)
/home/claude/ref/text/*.txt    the visible text of each original page
/home/claude/ref/dom/*.html    the original HTML markup of each page (class names to reuse!)
/home/claude/ref/legacy.html   the original app itself (runs headless; demo accounts on its login screen)
```

## Commands (node_modules is already installed; npm install does NOT work here — never add dependencies)

```bash
cd /home/claude/pilotix
npm run build -w @pilotix/shared                         # after changing shared
(cd packages/core && npx tsc -p . && node --test 'dist/test/*.test.js')   # core build + tests (PGlite)
npx tsc -p apps/web/tsconfig.json --noEmit               # typecheck the app
(cd apps/web && npx vite build --mode artifact --outDir /tmp/<you>-dist)   # build the in-browser demo
(cd /tmp/<you>-dist && python3 -m http.server <your port> &)               # serve it
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /home/claude/ref/newshot.cjs http://localhost:<port>/ /tmp/<you>.png "Administrateur" "<route>"
#   → logs in with a demo button (regex on its label) and screenshots #/<route>. Read the png to compare with ref/shots.
```

Available libraries (only these): react 18, react-dom, @tanstack/react-query 5, @tanstack/react-table 8, @tanstack/react-virtual 3,
i18next + react-i18next, zod, bcryptjs, socket.io-client, idb-keyval, @zxing/browser + @zxing/library (barcode), @capacitor/*,
@electric-sql/pglite (core tests / demo). Node 22 has global fetch.

## Ownership — edit ONLY your files

Every builder owns a feature. You may create files inside your folders. Do NOT edit shared files
(apps/web/src/ui/*, lib/*, layout/*, main.tsx, registry files, packages/shared, core/src/{db,rpc,settings,seed,index,registry}.ts,
other features' folders). If you truly need a change there, describe it in your final report instead.

| feature | core module (procedures) | core migration / seed | web folder | translation namespace(s) |
|---|---|---|---|---|
| orders | modules/orders.ts (exists, extend) + modules/customers.ts | migrations/002_orders.ts, 006_customers.ts, seeds/orders.ts, seeds/customers.ts | pages/orders, pages/clients | orders, clients |
| confirmation | modules/confirmation.ts | 003_confirmation.ts, seeds/confirmation.ts | pages/confirmation | confirmation |
| stats | modules/stats.ts | 004_stats.ts, seeds/stats.ts | pages/home, pages/dashboard | home, dashboard |
| catalog | modules/catalog.ts | 005_catalog.ts, seeds/catalog.ts | pages/depot (Depot, Scanner, Produits) | depot, produits, scanner |
| suivi + sav | modules/suivi.ts, modules/sav.ts | 007_suivi.ts, 008_sav.ts, seeds/suivi.ts, seeds/sav.ts | pages/suivi, pages/sav | suivi, sav |
| delivery + cash | modules/delivery.ts, modules/cash.ts, couriers/* (new) | 009_delivery.ts, 010_cash.ts, seeds/delivery.ts, seeds/cash.ts | pages/livraison, pages/caisse, pages/tournee | livraison, caisse, tournee |
| admin + ads | modules/admin.ts, modules/ads.ts, meta.ts (new) | 011_admin.ts, 012_ads.ts, seeds/admin.ts, seeds/ads.ts | pages/admin, pages/ads | admin, ads |

Also yours: `packages/core/src/test/<feature>.test.ts` (use `test/harness.ts`: `const { db, as } = await setup(); const ctx = await as(EMAILS.conf)`).

## Core (procedures)

```ts
import { z } from 'zod';
import { proc, bad, forbidden, notFound, hasRole } from '../rpc';
import { Where, num, iso, isoOrNull } from '../db';
import { getSetting, setSetting } from '../settings';
import { getOrder, listOrders, setConf, setFollow, addEvent, createOrder, toOrder } from './orders';

export const xxxProcs = {
  'xxx.list': proc(['depot'] /* roles; null = everyone; [] = admin only; admin always passes */, z.object({ q: z.string().optional() }),
    async (ctx, input) => { const rows = await ctx.db.query('SELECT … WHERE x = $1', [input.q]); return rows; }),
};
```
- `ctx.db.query(sql, params)` → rows; `ctx.db.tx(async (tx) => …)` for several writes. `ctx.session` = { profile, roles (expanded), isAdmin }.
- `ctx.emit({ type: 'orders' })` after writes so open screens refresh. `ctx.now()` for time.
- Server-only things (courier APIs, Meta Ads): call `ctx.server?.courier(...)` / `ctx.server?.meta(...)`; when `ctx.server` is missing
  (browser demo) SIMULATE a realistic result so the demo works.
- Money = whole dinars (integers). bigint columns come back as strings on the server: always wrap with `num()`.
- Write SQL that runs on both PostgreSQL 16 and PGlite (no extensions; ILIKE for search).
- Messages in errors: French (the UI shows them).
- Procedures must return plain JSON (no Date objects: use ISO strings).

## Web

```ts
import { rpc } from '../../lib/backend';                // typed: rpc('orders.list', {...}) → Page<Order>
import { useRpc, useAction } from '../../lib/query';     // useRpc('orders.list', input) (react-query); useAction('orders.setConf', { success: 'Enregistré' })
import { useSession } from '../../lib/session';          // { session, has('depot'), me }
import { openOrder, openOrderForm } from '../../lib/modals';  // order card / order form (built by the orders feature)
import { downloadCsv, printHtml, escapeHtml } from '../../lib/files';
import { da, n, pct, when, dateOnly, dateTime, dur, since, wilaya, wilayaName, periodRange, toLocalInput, fromLocalInput } from '../../lib/format';
import { Card, Kpi, Kpis, Tabs, StageBar, StatusBadge, StatusSelect, Pager, SortTh, BulkBar, Field, Help, Loading, Empty, ErrorBox, Icon, PeriodSelect, copyText } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
```
- Pages are exported by name from `pages/<folder>/index.tsx` (see `pages/registry.tsx`) and receive `{ sub, rest }` from `#/page/sub/rest…`.
- Stage bars: render `<StageBar items=[{key,label,href:'#/depot/preparer',count}] current={sub} />` at the top of the page, like the original.
- Reuse the ORIGINAL markup/class names (see ref/dom/*.html): `.card .card-head`, `.kpis .kpi .l .v .s` (+ `t-ok/t-bad/t-warn`), `.tbl` with
  `td data-l="Label"` (mobile layout), `.badge t-…`, `.chip`, `.flag`, `.btn primary|small|ok|danger|ghost`, `.tabs .tab.on`, `.qtbl`, `.qo` (orange 36px
  actions), `.qexp`, `.qdetail`, `.qd3`/`.qd4-ptbl`/`.qd4-tbl`, `.pager`, `.bulkbar`, `.filters`, `.field .lab`, `.row`, `.grid2/.grid3`, `.empty-box`.
  The original stylesheet is loaded globally (apps/web/src/styles/legacy.css) — you rarely need new CSS; if you do, put a small `.css` file in your folder and import it.
- Every visible text through `t('<ns>.key')` with your namespace files `apps/web/src/locales/{fr,en,ar}/<ns>.json` (write all three; Arabic must be real Arabic).
  Shared namespaces you can READ: common, nav, roles, status (conf/follow/channel/cancelReason/failReason/returnReason), shell, login.
  Numbers, phones, refs, tracking: wrap in `<span className="ltr">` so Arabic layout keeps them readable.
- Phone/WhatsApp: `tel:` and `https://wa.me/<phoneIntl>?text=…` links (template from settings `shop.whatsappTemplate`).
- Empty states, loading (`<Loading/>`), errors (`<ErrorBox/>`) everywhere. Mobile (≤760px) must work: tables use `data-l` labels.
- No `alert/confirm/prompt` — confirmation steps inside the page/modal.

## Quality bar

- Feature parity with the inventory + screenshots for your pages (same sections, columns, buttons, KPIs, wording in French).
- Role rules enforced in core (not only hidden buttons).
- Core tests for your main rules (happy path + one refusal). All tests and typecheck must pass.
- Build the demo, screenshot your main pages, compare with ref/shots, fix differences.
- Final report: what you built (pages, procedures), what you could not do, any change you need in shared files (exact diff).
