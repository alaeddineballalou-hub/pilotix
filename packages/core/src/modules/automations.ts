// Pilot Automations › Automatisations: what Pilotix does by itself, in one place, each one with its switch.
//  - Affectation automatique (Confirmation, Suivi): the modes of « Affectation automatique »; off = « manuel ».
//  - Stock revenu: confirmed orders without stock go to « À préparer » by themselves when the stock comes back (off:
//    they wait in « Sans stock »; « Envoyer au dépôt » here sends the ones the stock can serve).
//  - Dispatch automatique: a picked order with its company goes to « En dispatch » by itself (off: « À attribuer »).
//  - Messages de livraison: the customers' messages at each step (the same switch as in its own tab).
//  - Plus de stock → stop: an ad set whose products have nothing left is paused, and the pages of a product with
//    nothing left say « épuisé » instead of taking orders. When stock comes back the pages take orders again by
//    themselves, and the ad sets Pilotix paused go back on (only those, and not one a person started again since).
//  - Rapport du soir: at the chosen hour, the day's numbers to the owner (or the people chosen): a notification.
//  - File d'attente lente: in the call hours, new orders waiting too long without a call, or an agent on line who calls
//    nobody while orders wait for him: his team manager and the supervisors hear it (once an hour at most).
//  - Offre de retour: some days after a delivered order, a customer who said yes to offers and has not ordered again
//    gets the shop's offer (a WhatsApp campaign Meta approved, Marketing › Campagnes), at the campaigns' own pace.
// Every thing it did writes a line in auto_log, shown under its card. The job « auto-run » runs this every minute.
import { algiersDayStart, algiersHour, CONF_TODO, featureOn, slotAt } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { AutomationSettings, autoSettings, getSetting, setSetting } from '../settings';
import { addDays, dayStart, fxTable, moneyOf, moneyRows } from './ads';
import { act } from './adsmgr';
import { getAssign } from './assign';
import { REACHABLE } from './campaigns';
import { READY_SQL } from './dispatch';
import { managers } from './livreur';
import { releaseNoStock } from './nostock';
import { notifySettings, setNotifyEnabled } from './notify';
import { sendPush } from './push';
import { RESERVED } from './stockquery';

const H = 3_600_000;
const MIN = 60_000;
const id = z.number().int().positive();
/** the Algiers day of a moment, e.g. 2026-11-06 */
const algDay = (ms: number) => new Date(ms + H).toISOString().slice(0, 10);
/** campaigns whose WhatsApp template Meta approved (they can send) */
const SENDABLE = ['ready', 'sending', 'done'];
/** an alert about the same thing: once an hour at most */
const TELL_EVERY = H;
/** an ad set Meta would not pause or start: tried again after this */
const RETRY_AFTER = 2 * H;

// ---------------------------------------------------------------- memory between runs
interface AutoState {
  /** confirmation agents seen on line, since when (ms) */
  online: Record<string, number>;
  /** last alert per subject (ms): 'wait', 'idle:<agent id>' */
  told: Record<string, number>;
  /** the Algiers day the evening report / the come-back offers / the clean-up were done */
  eveningDay: string | null;
  comeBackDay: string | null;
  cleanDay: string | null;
  /** last runs (ms) */
  queueAt: number;
  stockAt: number;
  /** watched products with nothing left at the last stock check (null: not checked yet since switched on) */
  soldOut: number[] | null;
  /** ad sets Meta would not pause or start, and when (ms) */
  failed: Record<string, number>;
}
const STATE_KEY = 'automations_state';

async function readState(db: Db): Promise<AutoState> {
  const r: any = (await db.query(`SELECT value FROM settings WHERE key = $1`, [STATE_KEY]))[0]?.value ?? {};
  return {
    online: r.online ?? {},
    told: r.told ?? {},
    eveningDay: r.eveningDay ?? null,
    comeBackDay: r.comeBackDay ?? null,
    cleanDay: r.cleanDay ?? null,
    queueAt: num(r.queueAt),
    stockAt: num(r.stockAt),
    soldOut: Array.isArray(r.soldOut) ? r.soldOut.map(num) : null,
    failed: r.failed ?? {},
  };
}
async function writeState(db: Db, s: AutoState) {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [STATE_KEY, JSON.stringify(s)]);
}

async function log(ctx: Ctx, kind: string, data: Record<string, unknown>, n = 1) {
  await ctx.db.query(`INSERT INTO auto_log (kind, at, data, n) VALUES ($1, $2, $3, $4)`, [kind, new Date(ctx.now()).toISOString(), JSON.stringify(data), n]);
}

/** The people chosen (still active), or else `fallback`. */
async function peopleOr(db: Db, chosen: number[], fallback: () => Promise<number[]>): Promise<number[]> {
  if (chosen.length) {
    const ok = (await db.query(`SELECT id FROM profiles WHERE active AND id = ANY($1)`, [chosen])).map((r: any) => num(r.id));
    if (ok.length) return ok;
  }
  return fallback();
}
const admins = async (db: Db) => (await db.query(`SELECT id FROM profiles WHERE active AND 'admin' = ANY(roles)`)).map((r: any) => num(r.id));

const dzd = (n: number) => `${Math.round(n).toLocaleString('fr-FR').replace(/\s/g, '\u00a0')}\u00a0DA`;

// ---------------------------------------------------------------- Plus de stock → stop
/** What is left of each product: stock − what confirmed orders hold (active depots, active variants); a service: null. */
async function leftOf(db: Db, productIds: number[]): Promise<Map<number, { name: string; left: number | null }>> {
  const out = new Map<number, { name: string; left: number | null }>();
  if (!productIds.length) return out;
  const rows = await db.query(
    `WITH r AS (${RESERVED}),
       s AS (SELECT s.variant_id, sum(s.qty)::int AS qty FROM stock s JOIN warehouses wh ON wh.id = s.warehouse_id AND wh.active GROUP BY 1),
       rv AS (SELECT r.variant_id, sum(r.n)::int AS n FROM r JOIN warehouses wh ON wh.id = r.wid AND wh.active GROUP BY 1)
     SELECT p.id, p.name, p.is_service,
            COALESCE(sum(GREATEST(0, COALESCE(s.qty, 0) - COALESCE(rv.n, 0))) FILTER (WHERE v.active), 0)::int AS n_left
       FROM products p LEFT JOIN product_variants v ON v.product_id = p.id LEFT JOIN s ON s.variant_id = v.id LEFT JOIN rv ON rv.variant_id = v.id
      WHERE p.id = ANY($1) GROUP BY p.id, p.name, p.is_service`,
    [productIds],
  );
  for (const r of rows) out.set(num(r.id), { name: String(r.name), left: r.is_service ? null : num(r.n_left) });
  return out;
}

interface Watch {
  /** ad sets selling products (on, or paused by Pilotix) */
  sets: { id: string; name: string; status: string | null; productIds: number[]; ours: boolean; handsOff: boolean; pausedAt: string | null }[];
  /** products with an online page: how many pages */
  pages: Map<number, number>;
  left: Map<number, { name: string; left: number | null }>;
}
async function watch(db: Db): Promise<Watch> {
  const sets = (
    await db.query(
      `SELECT a.id, a.name, a.status, a.product_ids, p.adset_id IS NOT NULL AS ours, COALESCE(p.hands_off, false) AS hands_off, p.at AS paused_at
         FROM adsets a LEFT JOIN auto_paused p ON p.adset_id = a.id
        WHERE cardinality(a.product_ids) > 0 AND (a.status = 'ACTIVE' OR p.adset_id IS NOT NULL)
        ORDER BY a.id`,
    )
  ).map((r: any) => ({
    id: String(r.id),
    name: String(r.name),
    status: (r.status as string | null) ?? null,
    productIds: ((r.product_ids ?? []) as unknown[]).map(num),
    ours: !!r.ours,
    handsOff: !!r.hands_off,
    pausedAt: r.paused_at ? iso(r.paused_at) : null,
  }));
  const pages = new Map<number, number>();
  for (const r of await db.query(`SELECT product_id, count(*)::int AS n FROM landing_pages WHERE active GROUP BY 1`)) pages.set(num(r.product_id), num(r.n));
  const left = await leftOf(db, [...new Set([...sets.flatMap((s) => s.productIds), ...pages.keys()])]);
  return { sets, pages, left };
}
/** A product with nothing left (a service never is; a product removed since is not counted). */
const outOf = (w: Watch, pid: number) => {
  const x = w.left.get(pid);
  return !!x && x.left !== null && x.left <= 0;
};
/** An ad set all of whose products (services aside) have nothing left. */
const setOut = (w: Watch, s: Watch['sets'][number]) => {
  const goods = s.productIds.filter((p) => w.left.get(p)?.left !== null && w.left.has(p));
  return goods.length > 0 && goods.every((p) => outOf(w, p));
};
const setNames = (w: Watch, s: Watch['sets'][number]) => s.productIds.map((p) => w.left.get(p)?.name).filter(Boolean) as string[];

/** Someone (a person, a rule) changed this ad set after Pilotix paused it. */
async function touchedSince(db: Db, adsetId: string, since: string | null) {
  if (!since) return false;
  return (await db.query(`SELECT 1 FROM ad_actions WHERE object_id = $1 AND status = 'done' AND source <> 'auto' AND created_at > $2 LIMIT 1`, [adsetId, since])).length > 0;
}

/** Puts back on an ad set Pilotix paused (unless a person took it over since), and forgets it. Returns its name if started. */
async function giveBack(ctx: Ctx, s: Watch['sets'][number], why: string): Promise<string | null> {
  let started: string | null = null;
  if (!s.handsOff && s.status === 'PAUSED' && !(await touchedSince(ctx.db, s.id, s.pausedAt))) {
    await act(ctx, { objectId: s.id, op: 'resume', source: 'auto', why, auto: true });
    started = s.name;
  }
  await ctx.db.query(`DELETE FROM auto_paused WHERE adset_id = $1`, [s.id]);
  return started;
}

async function runNoStock(ctx: Ctx, st: AutoState, errors: string[]) {
  const db = ctx.db;
  const now = ctx.now();
  await db.query(`DELETE FROM auto_paused WHERE adset_id NOT IN (SELECT id FROM adsets)`);
  const w = await watch(db);
  const paused = new Map<number, string[]>();
  const resumed = new Map<number, string[]>();
  const add = (m: Map<number, string[]>, s: Watch['sets'][number], name: string) => {
    for (const p of s.productIds) m.set(p, [...(m.get(p) ?? []), name]);
  };
  for (const s of w.sets) {
    const out = setOut(w, s);
    const retryLater = now - num(st.failed[s.id]) < RETRY_AFTER;
    try {
      if (s.ours && !out) {
        // stock is back for one of its products: the ad set goes back on
        if (retryLater) continue;
        const name = await giveBack(ctx, s, `Stock revenu : ${setNames(w, s).join(', ')}`);
        if (name) add(resumed, s, name);
        delete st.failed[s.id];
      } else if (s.ours && out && s.status === 'ACTIVE' && !s.handsOff) {
        // a person started it again with no stock: left alone until the stock comes back
        await db.query(`UPDATE auto_paused SET hands_off = true WHERE adset_id = $1`, [s.id]);
      } else if (!s.ours && out && s.status === 'ACTIVE') {
        if (retryLater) continue;
        await act(ctx, { objectId: s.id, op: 'pause', source: 'auto', why: `Plus de stock : ${setNames(w, s).join(', ')}`, auto: true });
        await db.query(`INSERT INTO auto_paused (adset_id, product_ids, at) VALUES ($1, $2, $3) ON CONFLICT (adset_id) DO NOTHING`, [s.id, s.productIds, new Date(now).toISOString()]);
        add(paused, s, s.name);
        delete st.failed[s.id];
      }
    } catch (e: any) {
      st.failed[s.id] = now;
      errors.push(`${s.name} : ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  // one line per product whose stock ran out or came back (the first check only sets where things stand)
  const watched = [...new Set([...w.sets.flatMap((s) => s.productIds), ...w.pages.keys()])];
  const outNow = watched.filter((p) => outOf(w, p));
  const before = st.soldOut;
  if (before) {
    for (const p of outNow)
      if (!before.includes(p) || paused.has(p)) await log(ctx, 'nostock', { product: w.left.get(p)?.name ?? '', pages: w.pages.get(p) ?? 0, paused: paused.get(p) ?? [] });
    for (const p of before)
      if (!outNow.includes(p) && w.left.has(p)) await log(ctx, 'stockback', { product: w.left.get(p)?.name ?? '', pages: w.pages.get(p) ?? 0, resumed: resumed.get(p) ?? [] });
  } else
    for (const [p, names] of paused) await log(ctx, 'nostock', { product: w.left.get(p)?.name ?? '', pages: w.pages.get(p) ?? 0, paused: names });
  st.soldOut = outNow;
  st.stockAt = now;
}

/** « Plus de stock » switched off: the ad sets Pilotix paused go back on (not one a person changed since). */
async function giveAllBack(ctx: Ctx, st: AutoState) {
  const w = await watch(ctx.db);
  const names: string[] = [];
  for (const s of w.sets.filter((x) => x.ours))
    try {
      const n = await giveBack(ctx, s, 'Pilot Automations : « Plus de stock » arrêté');
      if (n) names.push(n);
    } catch {
      // Meta refused: it stays paused, as any ad set a person paused
      await ctx.db.query(`DELETE FROM auto_paused WHERE adset_id = $1`, [s.id]);
    }
  if (names.length) await log(ctx, 'stockback', { product: '', pages: 0, resumed: names, off: true });
  st.soldOut = null;
  st.failed = {};
}

// ---------------------------------------------------------------- Rapport du soir
export interface DayReport {
  day: string;
  orders: number;
  confirmed: number;
  delivered: number;
  returned: number;
  /** what the delivered orders brought */
  cash: number;
  /** the day's ad spend in dinars */
  pub: number;
  /** an ad account in dollars with no rate for this month: its spend is not counted */
  pubMissing: boolean;
  /** the delivered and returned orders' profit, minus the day's ads */
  profit: number;
}
async function spendOf(db: Db, day: string): Promise<{ dzd: number; missing: boolean }> {
  const rows = await db.query(`SELECT i.spend_cents, s.currency FROM ad_insights i LEFT JOIN adsets s ON s.id = i.adset_id WHERE i.day = $1`, [day]);
  if (!rows.length) return { dzd: 0, missing: false };
  const rate = (await fxTable(db))(day.slice(0, 7));
  let total = 0;
  let missing = false;
  for (const r of rows) {
    const v = num(r.spend_cents) / 100;
    if (String(r.currency ?? '').toUpperCase() === 'DZD') total += v;
    else if (rate) total += v * rate;
    else if (v > 0) missing = true;
  }
  return { dzd: Math.round(total), missing };
}
export async function dayReport(db: Db, day: string): Promise<DayReport> {
  const from = dayStart(day);
  const to = dayStart(addDays(day, 1));
  const c = (
    await db.query(
      `SELECT count(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND conf_status <> 'duplicate')::int AS orders,
              count(*) FILTER (WHERE confirmed_at >= $1 AND confirmed_at < $2)::int AS confirmed,
              count(*) FILTER (WHERE delivered_at >= $1 AND delivered_at < $2 AND follow_status IN ('delivered','exchanged'))::int AS delivered,
              count(*) FILTER (WHERE returned_at >= $1 AND returned_at < $2)::int AS returned
         FROM sales WHERE created_at >= $1 OR confirmed_at >= $1 OR delivered_at >= $1 OR returned_at >= $1`,
      [from, to],
    )
  )[0];
  const rows = await moneyRows(
    db,
    `(o.delivered_at >= $1 AND o.delivered_at < $2 AND o.follow_status IN ('delivered','exchanged')) OR (o.returned_at >= $1 AND o.returned_at < $2 AND o.follow_status IN ('returned','lost'))`,
    [from, to],
  );
  const spend = await spendOf(db, day);
  const m = await moneyOf(db, rows, spend.dzd);
  return { day, orders: num(c?.orders), confirmed: num(c?.confirmed), delivered: num(c?.delivered), returned: num(c?.returned), cash: m.rev, pub: m.pub, pubMissing: spend.missing, profit: m.net };
}
export const reportText = (r: DayReport) =>
  `${r.orders} commandes · ${r.confirmed} confirmées · ${r.delivered} livrées · ${r.returned} retours\nEncaissé ${dzd(r.cash)} · Pub ${r.pubMissing ? '?' : dzd(r.pub)} · Bénéfice ${dzd(r.profit)}`;

async function runEvening(ctx: Ctx, s: AutomationSettings, st: AutoState) {
  const now = ctx.now();
  const today = algDay(now);
  if (!s.evening.on || st.eveningDay === today || algiersHour(now) < s.evening.hour) return;
  st.eveningDay = today;
  const r = await dayReport(ctx.db, today);
  const to = await peopleOr(ctx.db, s.evening.to, () => admins(ctx.db));
  const sent = await sendPush(ctx, to, { title: `Rapport du soir · ${today.slice(8, 10)}/${today.slice(5, 7)}`, body: reportText(r), tag: 'auto-evening', url: '#/notify/auto' });
  await log(ctx, 'evening', { ...r, people: to.length, sent });
}

// ---------------------------------------------------------------- File d'attente lente
/** The day's first call hour (ms). */
async function openedAt(db: Db, now: number) {
  const calls = await getSetting(db, 'calls');
  const first = calls.slots[0]?.from ?? 9;
  return { open: slotAt(now, calls).open, since: algiersDayStart(now) + first * H };
}
/** New orders never called, waiting more than `hours` in the call hours (an order of the night counts from the morning). */
async function waitingOrders(db: Db, now: number, hours: number, since: number) {
  const r = (
    await db.query(
      `SELECT count(*)::int AS n, min(GREATEST(created_at, $3::timestamptz)) AS oldest FROM sales
        WHERE conf_status IN ('new','to_check') AND attempts = 0 AND created_at > $1 AND GREATEST(created_at, $3::timestamptz) < $2`,
      [new Date(now - 7 * 24 * H).toISOString(), new Date(now - hours * H).toISOString(), new Date(since).toISOString()],
    )
  )[0];
  const n = num(r?.n);
  return { n, hours: n && r.oldest ? Math.floor((now - Date.parse(iso(r.oldest))) / H) : 0 };
}

async function runQueue(ctx: Ctx, s: AutomationSettings, st: AutoState) {
  const db = ctx.db;
  const now = ctx.now();
  if (!s.queue.on) {
    st.online = {};
    return;
  }
  if (now - st.queueAt < 5 * MIN) return;
  st.queueAt = now;
  const day = await openedAt(db, now);
  if (!day.open) {
    st.online = {};
    return;
  }
  const watchers = await peopleOr(db, s.queue.to, () => managers(db));
  // orders waiting too long
  const w = await waitingOrders(db, now, s.queue.waitHours, day.since);
  if (w.n && now - num(st.told.wait) >= TELL_EVERY) {
    st.told.wait = now;
    const sent = await sendPush(ctx, watchers, {
      title: w.n > 1 ? `${w.n} commandes attendent un appel` : '1 commande attend un appel',
      body: `La plus ancienne attend depuis ${w.hours} h. Confirmation › Nouvelles.`,
      tag: 'auto-wait',
      url: '#/confirmation/nouvelles',
    });
    await log(ctx, 'queue', { what: 'wait', n: w.n, hours: w.hours, sent });
  }
  // agents on line who call nobody while orders wait for them
  const on = await db.query(`SELECT id, name, presence FROM profiles WHERE active AND 'confirmation' = ANY(roles) AND last_seen_at > $1`, [new Date(now - 3 * MIN).toISOString()]);
  const seen: Record<string, number> = {};
  for (const a of on) seen[String(a.id)] = st.online[String(a.id)] ?? now;
  st.online = seen;
  const teams = await getSetting(db, 'teams');
  for (const a of on) {
    const aid = num(a.id);
    if (a.presence === 'call') continue;
    const last = (await db.query(`SELECT max(at) AS at FROM order_events WHERE user_id = $1 AND kind IN ('call','conf_status') AND at > $2`, [aid, new Date(now - 12 * H).toISOString()]))[0]?.at;
    const quietSince = Math.max(last ? Date.parse(iso(last)) : 0, seen[String(aid)], day.since);
    const quiet = Math.floor((now - quietSince) / MIN);
    if (quiet < s.queue.idleMin || now - num(st.told[`idle:${aid}`]) < TELL_EVERY) continue;
    const work = num(
      (await db.query(`SELECT count(*)::int AS n FROM sales WHERE agent_id = $1 AND conf_status = ANY($2) AND (next_call_at IS NULL OR next_call_at <= $3)`, [aid, CONF_TODO, new Date(now).toISOString()]))[0]?.n,
    );
    if (!work) continue;
    st.told[`idle:${aid}`] = now;
    const bosses = teams.filter((t) => t.agentIds.includes(aid) && t.managerId).map((t) => t.managerId as number);
    const to = [...new Set([...bosses, ...watchers])].filter((x) => x !== aid);
    const sent = await sendPush(ctx, to, {
      title: `${a.name} n’appelle plus`,
      body: `Aucun appel depuis ${quiet} min, alors que ${work} commande${work > 1 ? 's' : ''} l’attend${work > 1 ? 'ent' : ''}.`,
      tag: `auto-idle-${aid}`,
      url: '#/confirmation/nouvelles',
    });
    await log(ctx, 'queue', { what: 'idle', agent: String(a.name), minutes: quiet, n: work, sent });
  }
  for (const k of Object.keys(st.told)) if (now - st.told[k] > 24 * H) delete st.told[k];
}

// ---------------------------------------------------------------- Offre de retour
async function runComeBack(ctx: Ctx, s: AutomationSettings, st: AutoState) {
  const db = ctx.db;
  const now = ctx.now();
  const today = algDay(now);
  if (!s.comeBack.on || !s.comeBack.campaignId || st.comeBackDay === today || algiersHour(now) < 10) return;
  const last = st.comeBackDay;
  st.comeBackDay = today;
  const c = (await db.query(`SELECT id, name, status FROM wa_campaigns WHERE id = $1`, [s.comeBack.campaignId]))[0];
  if (!c || !SENDABLE.includes(c.status)) {
    await log(ctx, 'comeback', { campaign: c?.name ?? '', problem: c ? String(c.status) : 'missing' }, 0);
    return;
  }
  // the customers delivered `days` days ago (and the days a stopped server missed, a week at most)
  const gap = last ? Math.min(7, Math.max(1, Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000))) : 1;
  const d = addDays(today, -s.comeBack.days);
  const r = await db.query(
    `INSERT INTO wa_campaign_sends (campaign_id, customer_id, phone, name)
     SELECT DISTINCT ON (c.phone) $1::bigint, c.id, c.phone, c.name
       FROM sales o JOIN customers c ON c.phone = o.phone
      WHERE o.follow_status IN ('delivered','exchanged') AND o.delivered_at >= $2 AND o.delivered_at < $3 AND ${REACHABLE}
        AND NOT EXISTS (SELECT 1 FROM sales n WHERE n.phone = o.phone AND n.created_at > o.created_at AND n.conf_status <> 'duplicate')
        AND NOT EXISTS (SELECT 1 FROM sales x WHERE x.phone = o.phone AND x.follow_status IN ('returned','lost') AND x.created_at > $4)
      ORDER BY c.phone
     ON CONFLICT (campaign_id, phone) DO NOTHING RETURNING id`,
    [c.id, dayStart(addDays(d, -(gap - 1))), dayStart(addDays(d, 1)), new Date(now - 180 * 24 * H).toISOString()],
  );
  if (!r.length) return;
  await db.query(`UPDATE wa_campaigns SET status = 'sending', started_at = COALESCE(started_at, $2), finished_at = NULL, updated_at = now() WHERE id = $1 AND status = ANY($3)`, [
    c.id,
    new Date(now).toISOString(),
    SENDABLE,
  ]);
  await log(ctx, 'comeback', { campaign: String(c.name), days: s.comeBack.days }, r.length);
}

// ---------------------------------------------------------------- the job
export async function autoRun(ctx: Ctx) {
  const s = await autoSettings(ctx.db);
  const st = await readState(ctx.db);
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      errors.push(`${name} : ${String(e?.message ?? e).slice(0, 300)}`);
    }
  };
  if (s.noStock.on && ctx.now() - st.stockAt >= 5 * MIN) await step('Plus de stock', () => runNoStock(ctx, st, errors));
  await step('Rapport du soir', () => runEvening(ctx, s, st));
  await step('File d’attente', () => runQueue(ctx, s, st));
  await step('Offre de retour', () => runComeBack(ctx, s, st));
  const today = algDay(ctx.now());
  if (st.cleanDay !== today) {
    st.cleanDay = today;
    await ctx.db.query(`DELETE FROM auto_log WHERE at < $1`, [new Date(ctx.now() - 90 * 24 * H).toISOString()]);
  }
  await writeState(ctx.db, st);
  return { errors };
}

// ---------------------------------------------------------------- the page
async function stateView(ctx: Ctx) {
  const db = ctx.db;
  const now = ctx.now();
  const s = await autoSettings(db);
  const assign = await getAssign(db);
  const notify = await notifySettings(db);
  const features = ctx.shop?.features ?? null;
  const hasAds = featureOn(features, 'marketing/publicite');
  const hasCampaigns = featureOn(features, 'marketing/campagnes');
  const waiting = num((await db.query(`SELECT count(*)::int AS n FROM orders WHERE conf_status = 'no_stock' AND follow_status IS NULL`))[0]?.n);
  const ready = waiting ? (await releaseNoStock(db, null, undefined, { dry: true })).length : 0;
  const toAssign = s.autoDispatch ? 0 : num((await db.query(`SELECT count(*)::int AS n FROM orders o WHERE ${READY_SQL}`))[0]?.n);
  // where the stock stands for what is advertised or on a page
  const w = await watch(db);
  const watched = [...new Set([...w.sets.flatMap((x) => x.productIds), ...w.pages.keys()])];
  const soldOut = watched
    .filter((p) => outOf(w, p))
    .map((p) => ({
      id: p,
      name: w.left.get(p)?.name ?? '',
      pages: w.pages.get(p) ?? 0,
      ads: w.sets.filter((x) => x.status === 'ACTIVE' && x.productIds.includes(p)).length,
      paused: w.sets.filter((x) => x.ours && x.productIds.includes(p)).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const day = await openedAt(db, now);
  const people = (
    await db.query(`SELECT id, name, roles, can_assign FROM profiles WHERE active AND NOT (roles = ARRAY['livreur']::text[]) ORDER BY ('admin' = ANY(roles)) DESC, can_assign DESC, lower(name)`)
  ).map((r: any) => ({ id: num(r.id), name: String(r.name), admin: (r.roles ?? []).includes('admin'), manager: !!r.can_assign }));
  const campaigns = hasCampaigns
    ? (await db.query(`SELECT id, name, status FROM wa_campaigns WHERE status IN ('ready','sending','done','paused') ORDER BY id DESC LIMIT 50`)).map((r: any) => ({
        id: num(r.id),
        name: String(r.name),
        status: String(r.status),
      }))
    : [];
  const comeBackSent = s.comeBack.campaignId ? num((await db.query(`SELECT count(*)::int AS n FROM wa_campaign_sends WHERE campaign_id = $1 AND sent_at IS NOT NULL`, [s.comeBack.campaignId]))[0]?.n) : 0;
  const lines = (await db.query(`SELECT id, kind, at, data, n FROM auto_log ORDER BY at DESC, id DESC LIMIT 60`)).map((r: any) => ({
    id: num(r.id),
    kind: String(r.kind),
    at: iso(r.at),
    n: num(r.n),
    data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, unknown>,
  }));
  return {
    s,
    assign: { conf: assign.conf.mode, follow: assign.follow.mode },
    delivery: notify.enabled,
    has: { ads: hasAds, campaigns: hasCampaigns, adSets: w.sets.length > 0 },
    noStock: { waiting, ready, toAssign },
    soldOut,
    today: await dayReport(db, algDay(now)),
    queueNow: { open: day.open, ...(await waitingOrders(db, now, s.queue.waitHours, day.since)) },
    people,
    campaigns,
    comeBackSent,
    log: lines,
  };
}

const SaveIn = z.object({
  assignConf: z.boolean().optional(),
  assignFollow: z.boolean().optional(),
  stockBack: z.boolean().optional(),
  autoDispatch: z.boolean().optional(),
  delivery: z.boolean().optional(),
  noStock: z.object({ on: z.boolean() }).optional(),
  evening: z.object({ on: z.boolean(), hour: z.number().int().min(12).max(23), to: z.array(id).max(30) }).optional(),
  queue: z.object({ on: z.boolean(), waitHours: z.number().int().min(1).max(48), idleMin: z.number().int().min(10).max(240), to: z.array(id).max(30) }).optional(),
  comeBack: z.object({ on: z.boolean(), days: z.number().int().min(3).max(180), campaignId: id.nullable() }).optional(),
});

export const automationsProcs = {
  /** The cards: each switch, its numbers, where things stand now, and what was done lately. */
  'auto.state': proc([], z.object({}), async (ctx) => {
    // « Stock revenu » on: what the stock can serve goes first (as when the depot looks), so « can go » means waiting for a person
    if ((await autoSettings(ctx.db)).stockBack && (await releaseNoStock(ctx.db, null)).length) ctx.emit({ type: 'orders' });
    return stateView(ctx);
  }),

  /** One switch (or one card's numbers) changed. */
  'auto.save': proc([], SaveIn, async (ctx, i) => {
    const db = ctx.db;
    const me = ctx.session.profile.id;
    const cur = await autoSettings(db);
    const next: AutomationSettings = { ...cur, assignPrev: { ...cur.assignPrev } };
    if (i.stockBack !== undefined) next.stockBack = i.stockBack;
    if (i.autoDispatch !== undefined) next.autoDispatch = i.autoDispatch;
    if (i.noStock) next.noStock = { ...cur.noStock, ...i.noStock };
    if (i.evening) next.evening = i.evening;
    if (i.queue) next.queue = i.queue;
    if (i.comeBack) {
      if (i.comeBack.on) {
        if (!i.comeBack.campaignId) throw bad('Choisissez la campagne à envoyer (Marketing › Campagnes)');
        const c = (await db.query(`SELECT status FROM wa_campaigns WHERE id = $1`, [i.comeBack.campaignId]))[0];
        if (!c) throw bad('Campagne introuvable');
        if (!SENDABLE.includes(c.status)) throw bad('Meta n’a pas encore approuvé le message de cette campagne');
      }
      next.comeBack = i.comeBack;
    }
    if (i.assignConf !== undefined || i.assignFollow !== undefined) {
      const a = await getAssign(db);
      for (const [area, on] of [
        ['conf', i.assignConf],
        ['follow', i.assignFollow],
      ] as const) {
        if (on === undefined) continue;
        const mode = a[area].mode;
        if (on && mode === 'manual') a[area] = { ...a[area], mode: cur.assignPrev[area] ?? 'turn' };
        if (!on && mode !== 'manual') {
          next.assignPrev[area] = mode;
          a[area] = { ...a[area], mode: 'manual' };
        }
      }
      await setSetting(db, 'autoAssign', a, me);
    }
    if (i.delivery !== undefined) await setNotifyEnabled(ctx, i.delivery);
    await setSetting(db, 'automations', next, me);
    const st = await readState(db);
    // « Plus de stock » off: what it paused goes back on; on: a first check now
    if (cur.noStock.on && !next.noStock.on) await giveAllBack(ctx, st);
    if (!cur.noStock.on && next.noStock.on) await runNoStock(ctx, st, []);
    // a report switched on after its hour: tonight's comes now; moved later: it comes at the new hour
    if (i.evening && (!cur.evening.on || i.evening.hour !== cur.evening.hour) && st.eveningDay === algDay(ctx.now())) st.eveningDay = null;
    await writeState(db, st);
    // « Stock revenu » on again: what the stock can serve goes now
    if (!cur.stockBack && next.stockBack && (await releaseNoStock(db, me, undefined, { force: true })).length) ctx.emit({ type: 'orders' });
    ctx.emit({ type: 'settings' });
    return stateView(ctx);
  }),

  /** « Envoyer au dépôt » (« Stock revenu » off): the « sans stock » orders the stock can serve now, oldest first. */
  'auto.release': proc([], z.object({}), async (ctx) => {
    const ids = await releaseNoStock(ctx.db, ctx.session.profile.id, undefined, { force: true });
    if (ids.length) {
      await log(ctx, 'release', {}, ids.length);
      ctx.emit({ type: 'orders' });
    }
    return { sent: ids.length, state: await stateView(ctx) };
  }),

  /** The job (every minute): each automation that is on does its part. */
  'auto.run': proc([], z.object({}), (ctx) => autoRun(ctx)),
};
