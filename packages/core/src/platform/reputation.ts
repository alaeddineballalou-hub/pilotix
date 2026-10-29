// Le réseau Pilotix: the fake-order learning shared by every seller of the platform.
//
// Every store learns from what really happened to its orders — an agent found the order fake or the number not the
// customer's (« fausse commande », « faux numéro »), the parcel was refused at the door, an agent marked the device
// « fausse commande » / « concurrent ». The platform keeps, for each phone number and each device, which stores ended
// badly with it. A new order is then checked against the OTHER sellers: when at least two different businesses (one
// owner's several stores count once; the store's own history is never counted here, it already weighs in fraud.ts)
// ended badly with this number or this device, the order goes to « À vérifier » — a person calls first. One seller alone
// is never enough, it never blocks an order on its own (fraud.ts), and a customer who already received and paid in this
// store is not bothered by it.
//
// Private by design: the platform keeps only a keyed hash of the number / of the device's fingerprint (a secret pepper,
// never the number itself), and a seller only ever learns a count — never which seller, never what happened, never who.
// Only real results are shared (agents' verdicts, marks, deliveries), never the machine's own guesses (blocked orders),
// so one store's strict settings do not spread. The latest result wins in each store: a parcel delivered after a
// refusal takes that store's « bad » back.
import { hmacSha256Hex } from '@pilotix/shared';
import type { Db } from '../db';
import type { Ctx } from '../rpc';
import type { Tenancy } from './tenancy';

const DAY = 86_400_000;
/** how long a bad end is remembered */
export const REPUTATION_DAYS = 180;
/** different businesses that must agree before the network warns (one is never enough) */
export const REPUTATION_MIN_SELLERS = 2;
const PEPPER = 'fraud_reputation_pepper';
/** an agent's verdict: the order was fake, or the number not the customer's */
const FAKE_CONF = ['fake', 'wrong_number'];
/** the parcel came back: refused at the door */
const REFUSED = ['returned', 'returning'];
/** received and paid */
const DELIVERED = ['delivered', 'exchanged'];

const peppers = new WeakMap<Tenancy, Promise<string>>();

/** The platform's secret for the hashes: made once, kept in platform.settings, never leaves the server. */
function pepperOf(t: Tenancy): Promise<string> {
  let p = peppers.get(t);
  if (!p) {
    p = (async () => {
      const fresh = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
      // two servers starting together: the first one's pepper is kept, the other reads it back
      await t.platform.query(`INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`, [PEPPER, JSON.stringify(fresh)]);
      const v = (await t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [PEPPER]))[0]?.value;
      if (typeof v !== 'string' || v.length < 32) throw new Error('fraud reputation: no secret');
      return v;
    })();
    peppers.set(t, p);
    p.catch(() => peppers.delete(t));
  }
  return p;
}

const phoneKey = (pepper: string, phone: string) => hmacSha256Hex(pepper, `p:${phone}`);
const deviceKey = (pepper: string, fphash: string) => hmacSha256Hex(pepper, `f:${fphash}`);

interface LearningShop {
  id: number;
  schema: string;
  /** the business: its owner's account (else e-mail, else the store itself) */
  owner: string;
}

/** The stores whose results teach the network: real stores (no partner space, not the demo), not deleted or archived. */
async function learningShops(t: Tenancy): Promise<LearningShop[]> {
  const rows = await t.platform.query(
    `SELECT id, schema_name, owner_account_id, owner_email FROM platform.shops
      WHERE kind = 'store' AND NOT is_demo AND status IN ('active', 'suspended') ORDER BY id`,
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    schema: String(r.schema_name),
    owner: r.owner_account_id ? `a${r.owner_account_id}` : r.owner_email ? `e${String(r.owner_email).trim().toLowerCase()}` : `s${r.id}`,
  }));
}

type Learned = Map<string, { n: number; last: number }>;
const ms = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

/** Keeps the keys whose latest result is bad (no delivered order after the last bad end). */
function badOnes(rows: any[], col: string): Learned {
  const out: Learned = new Map();
  for (const r of rows) {
    const lastBad = ms(r.last_bad);
    if (lastBad && lastBad > ms(r.last_good)) out.set(String(r[col]), { n: Number(r.n) || 1, last: lastBad });
  }
  return out;
}

/** What one store ended badly with, by phone number and by device, since `since` (its latest result wins). */
export async function learnedBy(db: Db, since: string): Promise<{ phones: Learned; devices: Learned }> {
  // numbers: an agent's « fake / wrong number », a refused parcel, a mark on the order's device (bad); delivered (good)
  const phones = await db.query(
    `WITH ev AS (
       SELECT phone, created_at AS at, (conf_status = ANY($2) OR follow_status = ANY($3)) AS bad, follow_status = ANY($4) AS good
         FROM orders WHERE created_at > $1 AND phone IS NOT NULL AND phone <> ''
       UNION ALL
       SELECT phone, at, true, false FROM fraud_marks WHERE NOT lifted AND at > $1 AND phone IS NOT NULL AND phone <> ''
     )
     SELECT phone, count(*) FILTER (WHERE bad)::int AS n, max(at) FILTER (WHERE bad) AS last_bad, max(at) FILTER (WHERE good) AS last_good
       FROM ev GROUP BY phone HAVING bool_or(bad)`,
    [since, FAKE_CONF, REFUSED, DELIVERED],
  );
  // devices (their fingerprint, the same on every store's pages): a mark, or an order an agent found fake (bad); an
  // order from it delivered (good). A refused parcel alone does not mark a device (a family shares a phone).
  const devices = await db.query(
    `WITH ev AS (
       SELECT fphash, at, true AS bad, false AS good FROM fraud_marks WHERE NOT lifted AND at > $1 AND fphash IS NOT NULL AND fphash <> ''
       UNION ALL
       SELECT s.fphash, o.created_at, o.conf_status = ANY($2), o.follow_status = ANY($3)
         FROM landing_submits s JOIN orders o ON o.id = s.order_id
        WHERE o.created_at > $1 AND s.fphash IS NOT NULL AND s.fphash <> '' AND (o.conf_status = ANY($2) OR o.follow_status = ANY($3))
     )
     SELECT fphash, count(*) FILTER (WHERE bad)::int AS n, max(at) FILTER (WHERE bad) AS last_bad, max(at) FILTER (WHERE good) AS last_good
       FROM ev GROUP BY fphash HAVING bool_or(bad)`,
    [since, FAKE_CONF, DELIVERED],
  );
  return { phones: badOnes(phones, 'phone'), devices: badOnes(devices, 'fphash') };
}

/** Replaces one store's rows in the network with what it learned (hashed). The store's data is read before the write. */
async function shareShop(t: Tenancy, s: LearningShop, pepper: string, since: string): Promise<number> {
  const { phones, devices } = await learnedBy(t.shop(s.schema), since);
  const keys: string[] = [];
  const counts: number[] = [];
  const lasts: string[] = [];
  const kinds: string[] = [];
  const add = (key: string, kind: 'phone' | 'device', v: { n: number; last: number }) => {
    keys.push(key);
    kinds.push(kind);
    counts.push(v.n);
    lasts.push(new Date(v.last).toISOString());
  };
  for (const [phone, v] of phones) add(phoneKey(pepper, phone), 'phone', v);
  for (const [fp, v] of devices) add(deviceKey(pepper, fp), 'device', v);
  await t.platform.tx(async (tx) => {
    await tx.query(`DELETE FROM platform.fraud_reputation WHERE shop_id = $1`, [s.id]);
    if (keys.length)
      await tx.query(
        `INSERT INTO platform.fraud_reputation (key, shop_id, owner_key, bad_n, last_bad, kind)
         SELECT u.k, $1, $2, u.n, u.l, u.c FROM unnest($3::text[], $4::int[], $5::timestamptz[], $6::text[]) AS u(k, n, l, c)`,
        [s.id, s.owner, keys, counts, lasts, kinds],
      );
  });
  return keys.length;
}

// ---------------------------------------------------------------- the control room's « Pilotix Protection System »
/** how many days of orders the history keeps recounting (older days keep their last count) */
const HISTORY_DAYS = 90;
const STORE_DAYS = 30;

/** one day's (or a period's) landing orders, all stores added up */
export interface ProtectionCount {
  orders: number;
  blocked: number;
  review: number;
  network: number;
  campaign: number;
  /** the buyers' quality: the orders not sent again (merged), those that turned out real (confirmed or delivered), and
   *  those that turned out fake (blocked, or « fausse » / « faux numéro » for the agent). The rest: waiting, cancelled… */
  buyers: number;
  good: number;
  bad: number;
}
const zero = (): ProtectionCount => ({ orders: 0, blocked: 0, review: 0, network: 0, campaign: 0, buyers: 0, good: 0, bad: 0 });
const COUNTS = Object.keys(zero()) as (keyof ProtectionCount)[];
/** an Algeria day ('YYYY-MM-DD'): Algeria is UTC+1 all year */
export const algeriaDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);

/** a real buyer: the agent confirmed the order, or it was delivered (as the store's own Protection page counts it) */
const REAL = `(o.conf_status IN ('confirmed', 'no_stock') OR o.follow_status IN ('delivered', 'exchanged'))`;

/** A store's landing orders day by day (Algeria time), counted as its own Protection page counts them. */
async function ordersByDay(db: Db, since: string): Promise<Map<string, ProtectionCount>> {
  const rows = await db.query(
    `SELECT to_char(s.at AT TIME ZONE 'Africa/Algiers', 'YYYY-MM-DD') AS day,
            count(*)::int AS orders,
            count(*) FILTER (WHERE s.verdict = 'block')::int AS blocked,
            count(*) FILTER (WHERE s.verdict = 'review' AND NOT s.merged)::int AS review,
            count(*) FILTER (WHERE s.reasons @> '[{"code":"shared_bad"}]')::int AS network,
            count(*) FILTER (WHERE s.reasons @> '[{"code":"campaign_bad"}]')::int AS campaign,
            count(*) FILTER (WHERE NOT s.merged)::int AS buyers,
            count(DISTINCT s.order_id) FILTER (WHERE s.verdict <> 'block' AND NOT s.merged AND ${REAL})::int AS good,
            count(*) FILTER (WHERE NOT s.merged AND (s.verdict = 'block' OR o.conf_status IN ('fake', 'wrong_number')) AND NOT coalesce(${REAL}, false))::int AS bad
       FROM landing_submits s LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.at > $1 GROUP BY 1`,
    [since],
  );
  return new Map(rows.map((r: any) => [String(r.day), Object.fromEntries(COUNTS.map((k) => [k, Number(r[k] ?? 0)])) as unknown as ProtectionCount]));
}

/** Writes the history: the days (all stores added up), today's size of the network, each store's last 30 days. */
async function recordProtection(t: Tenancy, stores: { id: number; shared: number; days: Map<string, ProtectionCount> }[], now: number) {
  const all = new Map<string, ProtectionCount>();
  const recent = algeriaDay(now - (STORE_DAYS - 1) * DAY);
  const perStore = stores.map((s) => {
    const sum = zero();
    for (const [day, c] of s.days) {
      const d = all.get(day) ?? zero();
      for (const k of COUNTS) {
        d[k] += c[k];
        if (day >= recent) sum[k] += c[k];
      }
      all.set(day, d);
    }
    return { id: s.id, shared: s.shared, ...sum };
  });
  const size = (
    await t.platform.query(
      `SELECT count(DISTINCT shop_id)::int AS sharing,
              count(DISTINCT key) FILTER (WHERE kind = 'phone')::int AS phones,
              count(DISTINCT key) FILTER (WHERE kind = 'device')::int AS devices,
              (SELECT count(*)::int FROM (SELECT key FROM platform.fraud_reputation GROUP BY key HAVING count(DISTINCT owner_key) >= $1) a) AS agreed
         FROM platform.fraud_reputation`,
      [REPUTATION_MIN_SELLERS],
    )
  )[0];
  const days = [...all.keys()];
  const col = (k: keyof ProtectionCount) => days.map((d) => all.get(d)![k]);
  const list = COUNTS.join(', ');
  const set = COUNTS.map((k) => `${k} = EXCLUDED.${k}`).join(', ');
  await t.platform.tx(async (tx) => {
    if (days.length)
      await tx.query(
        `INSERT INTO platform.protection_daily (day, ${list}, updated_at)
         SELECT u.*, now() FROM unnest($1::text[], ${COUNTS.map((_, i) => `$${i + 2}::int[]`).join(', ')}) AS u
         ON CONFLICT (day) DO UPDATE SET ${set}, updated_at = now()`,
        [days, ...COUNTS.map(col)],
      );
    // the network's size, once per day (the last run of the day wins)
    await tx.query(
      `INSERT INTO platform.protection_daily (day, stores, sharing, phones, devices, agreed, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (day) DO UPDATE SET stores = EXCLUDED.stores, sharing = EXCLUDED.sharing, phones = EXCLUDED.phones,
         devices = EXCLUDED.devices, agreed = EXCLUDED.agreed, updated_at = now()`,
      [algeriaDay(now), stores.length, Number(size?.sharing ?? 0), Number(size?.phones ?? 0), Number(size?.devices ?? 0), Number(size?.agreed ?? 0)],
    );
    await tx.query(`DELETE FROM platform.protection_stores`);
    if (perStore.length)
      await tx.query(
        `INSERT INTO platform.protection_stores (shop_id, shared, ${list})
         SELECT * FROM unnest($1::int[], $2::int[], ${COUNTS.map((_, i) => `$${i + 3}::int[]`).join(', ')})`,
        [perStore.map((s) => s.id), perStore.map((s) => s.shared), ...COUNTS.map((k) => perStore.map((s) => s[k]))],
      );
  });
}

export interface ProtectionDay extends ProtectionCount {
  day: string;
  /** the network that day (null: not recorded — before the network existed) */
  stores: number | null;
  sharing: number | null;
  phones: number | null;
  devices: number | null;
  agreed: number | null;
}

export interface ProtectionStats {
  /** the network now (null before its first run) */
  network: { stores: number; sharing: number; phones: number; devices: number; agreed: number } | null;
  /** the chosen period, all stores added up */
  totals: ProtectionCount;
  /** the period just before, the same length (to tell whether the buyers' quality rises or falls); null without history */
  previous: ProtectionCount | null;
  days: ProtectionDay[];
  /** each store, its last 30 days */
  stores: ({ id: number; name: string; slug: string; shared: number } & ProtectionCount)[];
  minSellers: number;
  lastRunAt: string | null;
}

/** What the control room shows: the network's size, the stopped orders day by day, each store. */
export async function protectionStats(t: Tenancy, now = Date.now(), period = 30): Promise<ProtectionStats> {
  const from = algeriaDay(now - (period - 1) * DAY);
  const rows = await t.platform.query(`SELECT * FROM platform.protection_daily WHERE day >= $1 ORDER BY day`, [from]);
  const byDay = new Map(rows.map((r: any) => [String(r.day), r]));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const days: ProtectionDay[] = [];
  const totals = zero();
  for (let k = period - 1; k >= 0; k--) {
    const day = algeriaDay(now - k * DAY);
    const r: any = byDay.get(day);
    const d: ProtectionDay = {
      day,
      ...(Object.fromEntries(COUNTS.map((k) => [k, Number(r?.[k] ?? 0)])) as unknown as ProtectionCount),
      stores: n(r?.stores),
      sharing: n(r?.sharing),
      phones: n(r?.phones),
      devices: n(r?.devices),
      agreed: n(r?.agreed),
    };
    for (const key of COUNTS) totals[key] += d[key];
    days.push(d);
  }
  const before = algeriaDay(now - (2 * period - 1) * DAY);
  const prev: any = (
    await t.platform.query(
      `SELECT count(*)::int AS n, ${COUNTS.map((k) => `coalesce(sum(${k}), 0)::int AS ${k}`).join(', ')} FROM platform.protection_daily WHERE day >= $1 AND day < $2`,
      [before, from],
    )
  )[0];
  const previous = prev && Number(prev.n) > 0 && Number(prev.orders) > 0 ? (Object.fromEntries(COUNTS.map((k) => [k, Number(prev[k])])) as unknown as ProtectionCount) : null;
  const last: any = (await t.platform.query(`SELECT * FROM platform.protection_daily WHERE stores IS NOT NULL ORDER BY day DESC LIMIT 1`))[0];
  const stores = await t.platform.query(
    `SELECT p.shop_id AS id, s.name, s.slug, p.shared, ${COUNTS.map((k) => `p.${k}`).join(', ')}
       FROM platform.protection_stores p JOIN platform.shops s ON s.id = p.shop_id ORDER BY p.orders DESC, s.name`,
  );
  const at = (await t.platform.query(`SELECT max(updated_at) AS at FROM platform.protection_daily`))[0]?.at;
  return {
    network: last ? { stores: Number(last.stores), sharing: Number(last.sharing ?? 0), phones: Number(last.phones ?? 0), devices: Number(last.devices ?? 0), agreed: Number(last.agreed ?? 0) } : null,
    totals,
    previous,
    days,
    stores: stores.map((r: any) => ({ id: Number(r.id), name: String(r.name), slug: String(r.slug), shared: Number(r.shared), ...(Object.fromEntries(COUNTS.map((k) => [k, Number(r[k])])) as unknown as ProtectionCount) })),
    minSellers: REPUTATION_MIN_SELLERS,
    lastRunAt: at ? new Date(at).toISOString() : null,
  };
}

/**
 * Rebuilds the network's memory store by store (the job « fraud-reputation », every 30 minutes): each store's rows are
 * replaced by what it learned in the last 180 days; stores gone (deleted, archived, the demo, partner spaces) are
 * forgotten. A store that fails is skipped (its rows stay until the next run) and reported.
 */
export async function refreshReputation(t: Tenancy, now = Date.now()): Promise<{ shops: number; keys: number; errors: string[] }> {
  const since = new Date(now - REPUTATION_DAYS * DAY).toISOString();
  const pepper = await pepperOf(t);
  const shops = await learningShops(t);
  await t.platform.query(`DELETE FROM platform.fraud_reputation WHERE NOT (shop_id = ANY($1::int[]))`, [shops.map((s) => s.id)]);
  let keys = 0;
  const errors: string[] = [];
  const history: { id: number; shared: number; days: Map<string, ProtectionCount> }[] = [];
  const historySince = new Date(now - HISTORY_DAYS * DAY).toISOString();
  for (const s of shops) {
    try {
      const shared = await shareShop(t, s, pepper, since);
      keys += shared;
      history.push({ id: s.id, shared, days: await ordersByDay(t.shop(s.schema), historySince) });
    } catch (e) {
      errors.push(`shop ${s.id}: ${(e as Error).message}`);
    }
  }
  // the control room's history; a problem there never stops the network itself
  await recordProtection(t, history, now).catch((e) => errors.push(`history: ${(e as Error).message}`));
  return { shops: shops.length, keys, errors };
}

/**
 * The network's word on a new order: how many OTHER sellers (different businesses) ended badly with this phone number or
 * this device in the last 180 days. null when there is no network here (the preview, tests, a single-shop install) or
 * for the demo shop: the signal is simply off. A seller only ever gets this count.
 */
export async function sharedReputation(ctx: Ctx, a: { phone: string | null; fphash: string | null }): Promise<{ sellers: number } | null> {
  const t = ctx.t;
  const shop = ctx.shop;
  if (!t || !shop || shop.demo) return null;
  if (!a.phone && !a.fphash) return { sellers: 0 };
  try {
    const pepper = await pepperOf(t);
    const keys = [...(a.phone ? [phoneKey(pepper, a.phone)] : []), ...(a.fphash ? [deviceKey(pepper, a.fphash)] : [])];
    const r = (
      await t.platform.query(
        `SELECT count(DISTINCT owner_key)::int AS n FROM platform.fraud_reputation WHERE key = ANY($1::text[]) AND shop_id <> $2 AND last_bad > $3`,
        [keys, shop.id, new Date(ctx.now() - REPUTATION_DAYS * DAY).toISOString()],
      )
    )[0];
    return { sellers: Number(r?.n ?? 0) };
  } catch {
    // the network cannot be asked (a server not yet updated…): the order is judged without it
    return null;
  }
}
