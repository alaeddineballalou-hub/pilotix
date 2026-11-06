// The control room's dashboards of the shops' AI agents (Pilot AI › Dellal AI, CM AI, Spy AI): what each one did over
// the last 7, 30 or 90 days (Algeria's days), every shop together or one shop, and for Dellal one product. Read live from
// each shop's own tables, nothing copied. Dellal's figures follow the chats that started in the period (a cohort): of
// those chats, how many ended with an order, and how many with a parcel delivered and paid (its real win, the one it
// learns from). Parcels take about a week to arrive, so the real sales of the last 7 days are not counted yet.
// Dellal's instruction book (its method, its Darija rules and the lesson book the coach approved) is put together at
// each download, so a download is always the latest version.
import type { Db } from '../db';
import { daySpend, fxTable } from '../modules/ads';
import { DELLAL_PLAYBOOK } from '../modules/dellal';
import { PILOT } from '../modules/pilotlearn';
import { loadShops } from './shops';
import type { Tenancy } from './tenancy';

export const BOARD_DAYS = [7, 30, 90] as const;
export type BoardDays = (typeof BOARD_DAYS)[number];
/** a parcel takes about this long to be delivered (or refused): the real sales of the newest chats are not known yet */
export const SALE_DAYS = 7;
export const BOARD_CHANNELS = ['whatsapp', 'messenger', 'instagram', 'tiktok'] as const;

const n = (v: unknown) => Number(v) || 0;
/** a share in % with one decimal (null when there is nothing to divide: never a made-up 0 %) */
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, k: number) => iso(new Date(Date.parse(`${day}T12:00:00Z`) + k * 86_400_000));
/** a day in Algeria (YYYY-MM-DD) */
function algeriaDay(at: Date | number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
/** the Monday of a day's week (the 90-day view is drawn week by week) */
const monday = (day: string) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

/** the period asked for, the one just before it (same length) and the first day whose sales are not known yet */
export function boardPeriod(days: number, at: Date | number = Date.now()) {
  const to = algeriaDay(at);
  const from = addDays(to, -(days - 1));
  return { from, to, prevFrom: addDays(from, -days), prevTo: addDays(from, -1), openFrom: addDays(to, -(SALE_DAYS - 1)), bucket: (days > 31 ? 'week' : 'day') as 'day' | 'week' };
}
/** the points of the line: every day, or every week (its Monday) for the long view */
function buckets(p: ReturnType<typeof boardPeriod>): string[] {
  const out: string[] = [];
  const step = p.bucket === 'week' ? 7 : 1;
  for (let d = p.bucket === 'week' ? monday(p.from) : p.from; d <= p.to; d = addDays(d, step)) out.push(d);
  return out;
}
const bucketOf = (p: ReturnType<typeof boardPeriod>, day: string) => (p.bucket === 'week' ? monday(day) : day);

/** created_at inside [from, to] (Algeria's days) */
const between = (col: string, a: number, b: number) =>
  `${col} >= ($${a}::date::timestamp AT TIME ZONE 'Africa/Algiers') AND ${col} < (($${b}::date + 1)::timestamp AT TIME ZONE 'Africa/Algiers')`;
const dayOf = (col: string) => `((${col}) AT TIME ZONE 'Africa/Algiers')::date::text`;

/** the stores whose agents count (not the demo, not archived or deleted) */
async function stores(t: Tenancy) {
  return (await loadShops(t)).filter((s) => s.kind === 'store' && s.status !== 'archived' && s.status !== 'deleted' && !s.demo);
}

// ---------------------------------------------------------------- Dellal
/** delivered or exchanged: the customer has the product and paid */
const SOLD = `coalesce(o.follow_status, '') IN ('delivered', 'exchanged')`;
/** an order that will not be paid: refused, returned, lost, cancelled, fake or a wrong number */
const LOST = `(coalesce(o.follow_status, '') IN ('returned', 'returning', 'lost', 'cancelled') OR o.conf_status IN ('cancelled', 'wrong_number', 'fake'))`;
/** the products of a « search_products » answer (an array, or nothing) */
const FOUND = `m.meta->'result'->'products'`;
const FOUND_FEW = `jsonb_typeof(${FOUND}) = 'array' AND jsonb_array_length(${FOUND}) BETWEEN 1 AND 3`;

type Counts = { chats: number; handed: number; ordered: number; sold: number; orders: number; delivered: number; lost: number; revenue: number; amount: number };
const KEYS = ['chats', 'handed', 'ordered', 'sold', 'orders', 'delivered', 'lost', 'revenue', 'amount'] as const;
const zero = (): Counts => ({ chats: 0, handed: 0, ordered: 0, sold: 0, orders: 0, delivered: 0, lost: 0, revenue: 0, amount: 0 });
const add = (a: Counts, b: Counts) => {
  for (const k of KEYS) a[k] += b[k];
  return a;
};
type CohortRow = Counts & { d: string; channel: string };

/**
 * One shop's chats that started in [from, to], day by day and channel by channel: how many there were, how many went to
 * the team, how many ended with an order (any order of the chat, a duplicate left out) and with a parcel delivered, and
 * those orders' counts and money. With a product: the chats about it (Dellal's first answer when it looked it up was
 * this product, or the chat's order holds it) and only its lines in the orders.
 */
async function cohort(db: Db, from: string, to: string, productId?: number): Promise<CohortRow[]> {
  const args: unknown[] = [from, to];
  let about = '';
  let line = '';
  let money = 'o.total';
  if (productId) {
    args.push(productId, String(productId));
    about = ` AND (EXISTS (SELECT 1 FROM conv_messages m WHERE m.conversation_id = c.id AND m.role = 'tool' AND m.meta->>'tool' = 'search_products' AND ${FOUND_FEW} AND ${FOUND}->0->>'product_id' = $4)
               OR EXISTS (SELECT 1 FROM orders o2 JOIN order_items i2 ON i2.order_id = o2.id WHERE o2.conversation_id = c.id AND i2.product_id = $3))`;
    line = ' AND EXISTS (SELECT 1 FROM order_items i3 WHERE i3.order_id = o.id AND i3.product_id = $3)';
    money = '(SELECT coalesce(sum(i.qty * i.unit_price), 0) FROM order_items i WHERE i.order_id = o.id AND i.product_id = $3)';
  }
  const rows = await db.query(
    `WITH c AS (
       SELECT c.id, c.channel, ${dayOf('c.created_at')} AS d, c.mode IN ('handoff', 'human') AS handed
         FROM conversations c
        WHERE c.channel <> 'test' AND ${between('c.created_at', 1, 2)}${about}
     ), o AS (
       SELECT o.conversation_id AS cid, ${SOLD} AS sold, (${LOST}) AND NOT (${SOLD}) AS lost, ${money} AS money
         FROM orders o JOIN c ON c.id = o.conversation_id
        WHERE coalesce(o.conf_status, '') <> 'duplicate'${line}
     ), per AS (
       SELECT cid, count(*) AS n, bool_or(sold) AS sold, count(*) FILTER (WHERE sold) AS dn, count(*) FILTER (WHERE lost) AS ln,
              coalesce(sum(money) FILTER (WHERE sold), 0) AS rev, coalesce(sum(money), 0) AS amount
         FROM o GROUP BY cid
     )
     SELECT c.d, c.channel, count(*)::int AS chats, count(*) FILTER (WHERE c.handed)::int AS handed,
            count(per.cid)::int AS ordered, count(*) FILTER (WHERE per.sold)::int AS sold,
            coalesce(sum(per.n), 0)::int AS orders, coalesce(sum(per.dn), 0)::int AS delivered, coalesce(sum(per.ln), 0)::int AS lost,
            coalesce(sum(per.rev), 0)::bigint AS revenue, coalesce(sum(per.amount), 0)::bigint AS amount
       FROM c LEFT JOIN per ON per.cid = c.id
      GROUP BY c.d, c.channel`,
    args,
  );
  return rows.map((r: any) => ({ d: String(r.d), channel: String(r.channel), chats: n(r.chats), handed: n(r.handed), ordered: n(r.ordered), sold: n(r.sold), orders: n(r.orders), delivered: n(r.delivered), lost: n(r.lost), revenue: n(r.revenue), amount: n(r.amount) }));
}

/** the products of one shop's chats in the period: the ones Dellal looked up, the ones ordered, with their figures */
async function productCohort(db: Db, from: string, to: string) {
  const rows = await db.query(
    `WITH c AS (
       SELECT c.id, c.mode IN ('handoff', 'human') AS handed FROM conversations c WHERE c.channel <> 'test' AND ${between('c.created_at', 1, 2)}
     ), talk AS (
       SELECT DISTINCT pid, cid FROM (
         SELECT (${FOUND}->0->>'product_id')::bigint AS pid, m.conversation_id AS cid
           FROM conv_messages m JOIN c ON c.id = m.conversation_id
          WHERE m.role = 'tool' AND m.meta->>'tool' = 'search_products' AND ${FOUND_FEW} AND ${FOUND}->0->>'product_id' ~ '^[0-9]{1,15}$'
         UNION ALL
         SELECT i.product_id, o.conversation_id FROM orders o JOIN c ON c.id = o.conversation_id JOIN order_items i ON i.order_id = o.id
       ) x
     ), o AS (
       SELECT o.id, o.conversation_id AS cid, i.product_id AS pid, sum(i.qty * i.unit_price) AS money, bool_or(${SOLD}) AS sold, bool_or((${LOST}) AND NOT (${SOLD})) AS lost
         FROM orders o JOIN c ON c.id = o.conversation_id JOIN order_items i ON i.order_id = o.id
        WHERE coalesce(o.conf_status, '') <> 'duplicate'
        GROUP BY o.id, o.conversation_id, i.product_id
     ), per AS (
       SELECT pid, cid, count(*) AS n, bool_or(sold) AS sold, count(*) FILTER (WHERE sold) AS dn, count(*) FILTER (WHERE lost) AS ln,
              coalesce(sum(money) FILTER (WHERE sold), 0) AS rev, coalesce(sum(money), 0) AS amount
         FROM o GROUP BY pid, cid
     )
     SELECT t.pid, p.name, count(*)::int AS chats, count(*) FILTER (WHERE c.handed)::int AS handed,
            count(per.cid)::int AS ordered, count(*) FILTER (WHERE per.sold)::int AS sold,
            coalesce(sum(per.n), 0)::int AS orders, coalesce(sum(per.dn), 0)::int AS delivered, coalesce(sum(per.ln), 0)::int AS lost,
            coalesce(sum(per.rev), 0)::bigint AS revenue, coalesce(sum(per.amount), 0)::bigint AS amount
       FROM talk t JOIN c ON c.id = t.cid JOIN products p ON p.id = t.pid LEFT JOIN per ON per.pid = t.pid AND per.cid = t.cid
      GROUP BY t.pid, p.name
      ORDER BY chats DESC, ordered DESC, p.name
      LIMIT 40`,
    [from, to],
  );
  return rows.map((r: any) => ({ id: n(r.pid), name: String(r.name), c: { chats: n(r.chats), handed: n(r.handed), ordered: n(r.ordered), sold: n(r.sold), orders: n(r.orders), delivered: n(r.delivered), lost: n(r.lost), revenue: n(r.revenue), amount: n(r.amount) } as Counts }));
}

/** the figures of a group of chats: `ripe` = the same chats, old enough for their parcels to have arrived */
function figures(c: Counts, ripe: Counts) {
  return {
    chats: c.chats,
    ordered: c.ordered,
    orders: c.orders,
    delivered: c.delivered,
    lost: c.lost,
    pending: Math.max(0, c.orders - c.delivered - c.lost),
    revenue: c.revenue,
    handed: c.handed,
    /** of 100 chats, how many ended with an order */
    conversion: pct(c.ordered, c.chats),
    /** of 100 chats old enough, how many ended with a parcel delivered and paid: Dellal's real win */
    realSales: pct(ripe.sold, ripe.chats),
    ripeChats: ripe.chats,
    ripeSold: ripe.sold,
    /** of the orders that ended, how many were delivered */
    deliveredRate: pct(c.delivered, c.delivered + c.lost),
    /** an order's average amount */
    basket: c.orders ? Math.round(c.amount / c.orders) : null,
    handedRate: pct(c.handed, c.chats),
  };
}

export type DellalBoardInput = { days: BoardDays; shopId?: number; productId?: number; now?: Date | number; costs?: boolean };

export async function dellalBoard(t: Tenancy, i: DellalBoardInput) {
  const p = boardPeriod(i.days, i.now);
  const list = await stores(t);
  const chosen = i.shopId ? list.filter((s) => s.id === i.shopId) : list;
  const productId = i.shopId ? i.productId : undefined;

  const points = new Map(buckets(p).map((d) => [d, { all: zero(), ripe: zero() }]));
  const total = zero();
  const ripe = zero();
  const prev = zero();
  const byShop: { id: number; name: string; c: Counts; ripe: Counts }[] = [];
  const byChannel = new Map<string, { c: Counts; ripe: Counts }>();
  /** shops whose tables could not be read (said on the page, never shown as zeros) */
  const skipped: string[] = [];
  for (const s of chosen) {
    const db = t.shop(s.schema);
    let cur: CohortRow[];
    let before: CohortRow[];
    try {
      [cur, before] = await Promise.all([cohort(db, p.from, p.to, productId), cohort(db, p.prevFrom, p.prevTo, productId)]);
    } catch {
      skipped.push(s.name);
      continue;
    }
    const mine = { id: s.id, name: s.name, c: zero(), ripe: zero() };
    for (const r of cur) {
      const ok = r.d < p.openFrom;
      add(total, r);
      add(mine.c, r);
      if (ok) add(ripe, r), add(mine.ripe, r);
      const pt = points.get(bucketOf(p, r.d));
      if (pt) add(pt.all, r), ok && add(pt.ripe, r);
      const ch = byChannel.get(r.channel) ?? { c: zero(), ripe: zero() };
      add(ch.c, r);
      if (ok) add(ch.ripe, r);
      byChannel.set(r.channel, ch);
    }
    for (const r of before) add(prev, r);
    byShop.push(mine);
  }

  // the line: one point a day (7 and 30 days) or a week (90 days); its counts, so the page can draw the rates (and say
  // which points still wait for their parcels)
  const series = [...points].map(([day, v]) => ({
    day,
    chats: v.all.chats,
    ordered: v.all.ordered,
    ripeChats: v.ripe.chats,
    sold: v.ripe.sold,
    /** some of its chats are too new for their parcels to have arrived */
    open: (p.bucket === 'week' ? addDays(day, 6) : day) >= p.openFrom,
  }));

  // what Pilotix's key paid for Dellal in the period (managers only; a product's share of it cannot be told)
  let cost: { usd: number; perOrder: number | null; models: { model: string; calls: number; usd: number }[] } | null = null;
  if (i.costs !== false) {
    const rows = await t.platform
      .query(
        `SELECT model, coalesce(sum(calls), 0)::int AS calls, coalesce(sum(usd), 0) AS usd FROM platform.ai_usage
          WHERE feature = 'dellal' AND payer = 'pilotix' AND day BETWEEN $1::date AND $2::date${i.shopId ? ' AND shop_id = $3' : ''}
          GROUP BY model ORDER BY usd DESC`,
        i.shopId ? [p.from, p.to, i.shopId] : [p.from, p.to],
      )
      .catch(() => []);
    const models = rows.map((r: any) => ({ model: String(r.model), calls: n(r.calls), usd: Number(r.usd) || 0 }));
    const usd = models.reduce((a, m) => a + m.usd, 0);
    cost = { usd, perOrder: !productId && total.orders ? usd / total.orders : null, models };
  }

  // the breakdown: every shop; one shop's products; one product's channels
  let products: { id: number; name: string }[] = [];
  type Row = { key: string; label: string } & ReturnType<typeof figures>;
  let rows: Row[] = [];
  if (i.shopId && chosen[0]) {
    const db = t.shop(chosen[0].schema);
    const [found, ripeFound] = await Promise.all([productCohort(db, p.from, p.to).catch(() => []), productId ? Promise.resolve([]) : productCohort(db, p.from, addDays(p.openFrom, -1)).catch(() => [])]);
    products = found.map((x) => ({ id: x.id, name: x.name }));
    if (productId && !products.some((x) => x.id === productId)) {
      const r = (await db.query('SELECT id, name FROM products WHERE id = $1', [productId]).catch(() => []))[0];
      if (r) products.unshift({ id: n(r.id), name: String(r.name) });
    }
    if (productId) rows = [...byChannel].map(([ch, v]) => ({ key: ch, label: ch, ...figures(v.c, v.ripe) }));
    else {
      const ripeOf = new Map(ripeFound.map((x) => [x.id, x.c]));
      rows = found.slice(0, 15).map((x) => ({ key: String(x.id), label: x.name, ...figures(x.c, ripeOf.get(x.id) ?? zero()) }));
    }
  } else rows = byShop.filter((x) => x.c.chats).map((x) => ({ key: String(x.id), label: x.name, ...figures(x.c, x.ripe) }));
  rows.sort((a, b) => b.chats - a.chats || b.ordered - a.ordered || a.label.localeCompare(b.label));

  // why chats ended without a sale (what Pilot AI read in the shops that teach Dellal, names removed)
  const why = await t.platform
    .query(
      `SELECT outcome, coalesce(reason, 'other') AS reason, count(*)::int AS n FROM platform.pilot_cases
        WHERE done AND outcome IN ('refused', 'cancelled', 'no_order', 'fake') AND ${between('coalesce(opened_at, changed_at)', 1, 2)}${i.shopId ? ' AND shop_id = $3' : ''}
        GROUP BY 1, 2 ORDER BY n DESC, 1, 2 LIMIT 8`,
      i.shopId ? [p.from, p.to, i.shopId] : [p.from, p.to],
    )
    .catch(() => []);
  const whyAll = (
    await t.platform
      .query(
        `SELECT count(*)::int AS n FROM platform.pilot_cases WHERE done AND outcome IN ('refused', 'cancelled', 'no_order', 'fake') AND ${between('coalesce(opened_at, changed_at)', 1, 2)}${i.shopId ? ' AND shop_id = $3' : ''}`,
        i.shopId ? [p.from, p.to, i.shopId] : [p.from, p.to],
      )
      .catch(() => [{ n: 0 }])
  )[0];
  const whyTotal = n(whyAll?.n);

  const now = figures(total, ripe);
  const was = figures(prev, prev);
  return {
    days: i.days,
    from: p.from,
    to: p.to,
    prevFrom: p.prevFrom,
    prevTo: p.prevTo,
    openFrom: p.openFrom,
    saleDays: SALE_DAYS,
    bucket: p.bucket,
    shopId: i.shopId ?? null,
    productId: productId ?? null,
    shops: list.map((s) => ({ id: s.id, name: s.name })),
    products,
    kpi: now,
    prev: { chats: was.chats, conversion: was.conversion, realSales: was.realSales, deliveredRate: was.deliveredRate, basket: was.basket, handedRate: was.handedRate },
    cost,
    series,
    rows,
    rowKind: (i.shopId ? (productId ? 'channel' : 'product') : 'shop') as 'shop' | 'product' | 'channel',
    why: why.map((r: any) => ({ outcome: String(r.outcome), reason: String(r.reason), n: n(r.n), pct: pct(n(r.n), whyTotal) })),
    whyTotal,
    skipped,
  };
}

// ---------------------------------------------------------------- Dellal: how fast it answers, when chats buy, which ad
/** reply time steps (seconds): under 30 s, under 1 min, under 5 min, under 30 min, later */
export const SPEED_STEPS = [30, 60, 300, 1800] as const;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** What started a chat, from its source: an ad (its Meta id and / or its title), a comment CM AI answered, nothing */
export function chatSource(source: string | null | undefined): { kind: 'ad' | 'comment' | 'direct' | 'other'; adId: string | null; label: string | null } {
  const s = String(source ?? '').trim();
  if (!s) return { kind: 'direct', adId: null, label: null };
  let m = /^pub (\d{5,})(?: « (.*) »)?$/.exec(s);
  if (m) return { kind: 'ad', adId: m[1], label: m[2] ?? null };
  m = /^pub « (.*) »$/.exec(s);
  if (m) return { kind: 'ad', adId: null, label: m[1] };
  m = /^Commentaire (.+?)(?: \(pub\))?(?: · « (.*) »)?$/.exec(s);
  if (m) return { kind: 'comment', adId: null, label: m[2] ?? m[1] };
  return { kind: 'other', adId: null, label: s.slice(0, 80) };
}

type ChatRow = { day: string; dow: number; hour: number; source: string | null; ordered: boolean; sold: boolean; rev: number; reply: number | null; handed: boolean; team: number | null };

/**
 * One shop's chats that started in [from, to], one line each: when (Algeria's day, weekday, hour), what started it, an
 * order or a delivered parcel, the money delivered, how long until Dellal's first answer to the customer's first message,
 * and, when Dellal handed the chat to the team, how long until a person wrote. With a product: as in `cohort`.
 */
async function chatRows(db: Db, from: string, to: string, productId?: number): Promise<ChatRow[]> {
  const args: unknown[] = [from, to];
  let about = '';
  let line = '';
  let money = 'o.total';
  if (productId) {
    args.push(productId, String(productId));
    about = ` AND (EXISTS (SELECT 1 FROM conv_messages m WHERE m.conversation_id = c.id AND m.role = 'tool' AND m.meta->>'tool' = 'search_products' AND ${FOUND_FEW} AND ${FOUND}->0->>'product_id' = $4)
               OR EXISTS (SELECT 1 FROM orders o2 JOIN order_items i2 ON i2.order_id = o2.id WHERE o2.conversation_id = c.id AND i2.product_id = $3))`;
    line = ' AND EXISTS (SELECT 1 FROM order_items i3 WHERE i3.order_id = o.id AND i3.product_id = $3)';
    money = '(SELECT coalesce(sum(i.qty * i.unit_price), 0) FROM order_items i WHERE i.order_id = o.id AND i.product_id = $3)';
  }
  const rows = await db.query(
    `WITH c AS (
       SELECT c.id, c.created_at, c.source,
              (SELECT min(m.created_at) FROM conv_messages m WHERE m.conversation_id = c.id AND m.role = 'customer') AS first_in,
              (SELECT min(m.created_at) FROM conv_messages m WHERE m.conversation_id = c.id AND m.role = 'tool' AND m.meta->>'tool' = 'handoff') AS handed_at
         FROM conversations c
        WHERE c.channel <> 'test' AND ${between('c.created_at', 1, 2)}${about}
     )
     SELECT ${dayOf('c.created_at')} AS d,
            extract(dow FROM (c.created_at AT TIME ZONE 'Africa/Algiers'))::int AS dow,
            extract(hour FROM (c.created_at AT TIME ZONE 'Africa/Algiers'))::int AS hr,
            c.source,
            EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id AND coalesce(o.conf_status, '') <> 'duplicate'${line}) AS ordered,
            EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id AND ${SOLD}${line}) AS sold,
            (SELECT coalesce(sum(${money}), 0) FROM orders o WHERE o.conversation_id = c.id AND ${SOLD}${line})::bigint AS rev,
            extract(epoch FROM ((SELECT min(a.created_at) FROM conv_messages a WHERE a.conversation_id = c.id AND a.role = 'agent' AND a.created_at >= c.first_in) - c.first_in))::float AS reply,
            c.handed_at IS NOT NULL AS handed,
            extract(epoch FROM ((SELECT min(s.created_at) FROM conv_messages s WHERE s.conversation_id = c.id AND s.role = 'staff' AND s.created_at >= c.handed_at) - c.handed_at))::float AS team
       FROM c`,
    args,
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : Math.max(0, Number(v)));
  return rows.map((r: any) => ({ day: String(r.d), dow: n(r.dow), hour: n(r.hr), source: r.source ?? null, ordered: !!r.ordered, sold: !!r.sold, rev: n(r.rev), reply: num(r.reply), handed: !!r.handed, team: num(r.team) }));
}

/**
 * Dellal, more: how fast it answers (and whether the slow answers sell less), the weekday × hour of the chats that buy,
 * and each ad (or comment, or no ad) that started chats, with what Meta says it cost when the shop connected its ads.
 * Same filters as the dashboard; the real sales count only the chats old enough for their parcels to have arrived.
 */
export async function dellalMore(t: Tenancy, i: DellalBoardInput) {
  const p = boardPeriod(i.days, i.now);
  const list = await stores(t);
  const chosen = i.shopId ? list.filter((s) => s.id === i.shopId) : list;
  const productId = i.shopId ? i.productId : undefined;
  const replies: number[] = [];
  const team: number[] = [];
  let unanswered = 0;
  let handed = 0;
  const steps = [...SPEED_STEPS, Infinity].map((max) => ({ max: Number.isFinite(max) ? max : null, chats: 0, ordered: 0 }));
  const none = { chats: 0, ordered: 0 };
  const cells = new Map<string, { dow: number; hour: number; chats: number; ordered: number }>();
  type Src = { key: string; shopId: number; shop: string; kind: ReturnType<typeof chatSource>['kind']; adId: string | null; label: string | null; chats: number; ordered: number; ripeChats: number; sold: number; revenue: number };
  const srcs = new Map<string, Src>();
  const skipped: string[] = [];
  const spendOf = new Map<string, { name: string | null; cents: number }>();
  for (const s of chosen) {
    const db = t.shop(s.schema);
    let rows: ChatRow[];
    try {
      rows = await chatRows(db, p.from, p.to, productId);
    } catch {
      skipped.push(s.name);
      continue;
    }
    const adIds = new Set<string>();
    for (const r of rows) {
      // how fast
      if (r.reply === null) {
        unanswered++;
        none.chats++;
        if (r.ordered) none.ordered++;
      } else {
        replies.push(r.reply);
        const st = steps.find((x) => x.max === null || r.reply! < x.max)!;
        st.chats++;
        if (r.ordered) st.ordered++;
      }
      if (r.team !== null) team.push(r.team);
      // when
      const k = `${r.dow}:${r.hour}`;
      const cell = cells.get(k) ?? { dow: r.dow, hour: r.hour, chats: 0, ordered: 0 };
      cell.chats++;
      if (r.ordered) cell.ordered++;
      cells.set(k, cell);
      // what started it
      const src = chatSource(r.source);
      const key = `${s.id}|${src.kind}|${src.adId ?? src.label ?? ''}`;
      const x = srcs.get(key) ?? { key, shopId: s.id, shop: s.name, kind: src.kind, adId: src.adId, label: src.label, chats: 0, ordered: 0, ripeChats: 0, sold: 0, revenue: 0 };
      x.chats++;
      if (r.ordered) x.ordered++;
      if (r.day < p.openFrom) {
        x.ripeChats++;
        if (r.sold) x.sold++;
      }
      x.revenue += r.rev;
      srcs.set(key, x);
      if (src.adId) adIds.add(src.adId);
    }
    handed += rows.filter((r) => r.handed).length;
    // the ads' names and what they cost in the period (the shop's Publicité: Meta's results by ad and day)
    if (adIds.size) {
      const ids = [...adIds];
      const named = await db.query('SELECT id, name FROM ads WHERE id = ANY($1::text[])', [ids]).catch(() => []);
      // month by month in the ad account's money: a dinar account's spend is turned into dollars with the month's rate
      const spent = await db
        .query(
          `SELECT d.ad_id, to_char(d.day, 'YYYY-MM') AS ym, s.currency, coalesce(sum(d.spend_cents), 0)::bigint AS cents
             FROM ad_daily d LEFT JOIN adsets s ON s.id = d.adset_id
            WHERE d.ad_id = ANY($1::text[]) AND d.day BETWEEN $2::date AND $3::date GROUP BY 1, 2, 3`,
          [ids, p.from, p.to],
        )
        .catch(() => []);
      const fx = await fxTable(db).catch(() => (() => null) as (ym: string) => number | null);
      for (const id of ids) spendOf.set(`${s.id}|${id}`, { name: null, cents: -1 });
      for (const r of named as any[]) spendOf.set(`${s.id}|${r.id}`, { ...spendOf.get(`${s.id}|${r.id}`)!, name: String(r.name) });
      for (const r of spent as any[]) {
        const k = `${s.id}|${r.ad_id}`;
        const was = spendOf.get(k)!;
        const usd = daySpend(fx, `${r.ym}-01`, n(r.cents), r.currency).spendCents;
        spendOf.set(k, { ...was, cents: Math.max(was.cents, 0) + usd });
      }
    }
  }

  // the ads first (the most chats first), then the comments, then the rest, the chats that came without an ad last
  const rank = { ad: 0, comment: 1, other: 2, direct: 3 } as const;
  const ads = [...srcs.values()]
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.chats - a.chats || b.ordered - a.ordered)
    .slice(0, 30)
    .map((x) => {
      const sp = x.adId ? spendOf.get(`${x.shopId}|${x.adId}`) : undefined;
      const spendUsd = sp && sp.cents >= 0 ? sp.cents / 100 : null;
      return {
        key: x.key,
        kind: x.kind,
        adId: x.adId,
        label: sp?.name ?? x.label,
        shop: chosen.length > 1 ? x.shop : null,
        chats: x.chats,
        ordered: x.ordered,
        conversion: pct(x.ordered, x.chats),
        ripeChats: x.ripeChats,
        sold: x.sold,
        realSales: pct(x.sold, x.ripeChats),
        revenue: x.revenue,
        spendUsd,
        /** what one delivered, paid parcel cost in ads (the parcels that had time to arrive) */
        costPerSale: spendUsd !== null && x.sold ? spendUsd / x.sold : null,
      };
    });
  const answered = replies.length;
  return {
    days: i.days,
    from: p.from,
    to: p.to,
    openFrom: p.openFrom,
    shopId: i.shopId ?? null,
    productId: productId ?? null,
    speed: {
      answered,
      unanswered,
      median: median(replies),
      p90: quantile(replies, 0.9),
      underMinute: pct(replies.filter((x) => x < 60).length, answered),
      steps: steps.map((x) => ({ max: x.max, chats: x.chats, ordered: x.ordered, conversion: pct(x.ordered, x.chats) })),
      none: { chats: none.chats, ordered: none.ordered, conversion: pct(none.ordered, none.chats) },
      team: { chats: team.length, median: median(team), handed },
    },
    hours: [...cells.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour),
    ads,
    skipped,
  };
}

/**
 * Is Dellal getting better? The chats of the last 180 days that used each lesson book (the base method before the first
 * book, then each version), with their conversion and real sales. The fair comparison is the test (the same days, chats
 * split by chance); the versions one after the other also face other days, ads and seasons.
 */
export async function dellalBooks(t: Tenancy, i: { shopId?: number; now?: Date | number }) {
  const p = boardPeriod(SALE_DAYS, i.now);
  const ripeBefore = new Date(`${p.openFrom}T00:00:00+01:00`).toISOString();
  const since = new Date(Date.parse(ripeBefore) - 180 * 86_400_000).toISOString();
  const books = await t.platform.query(`SELECT id, version, status, created_at, promoted_at, ended_at FROM platform.pilot_books ORDER BY version`).catch(() => []);
  const test = (await t.platform.query(`SELECT id, champion_id, challenger_id, share, started_at FROM platform.pilot_tests WHERE status = 'running'`).catch(() => []))[0] ?? null;
  const exp = await t.platform
    .query(
      `SELECT shop_id, conv_id, book_id, arm, at FROM platform.pilot_exposure WHERE at >= $1::timestamptz${i.shopId ? ' AND shop_id = $2' : ''}`,
      i.shopId ? [since, i.shopId] : [since],
    )
    .catch(() => []);
  const byShop = new Map<number, Map<number, { book: number | null; arm: string; at: string }>>();
  for (const e of exp as any[]) {
    const m = byShop.get(n(e.shop_id)) ?? new Map();
    m.set(n(e.conv_id), { book: e.book_id === null ? null : n(e.book_id), arm: String(e.arm), at: new Date(e.at).toISOString() });
    byShop.set(n(e.shop_id), m);
  }
  type V = { chats: number; ordered: number; ripeChats: number; sold: number; first: string | null; last: string | null };
  const per = new Map<string, V>();
  const add1 = (key: string, at: string, ordered: boolean, ripe: boolean, sold: boolean) => {
    const v = per.get(key) ?? { chats: 0, ordered: 0, ripeChats: 0, sold: 0, first: null, last: null };
    v.chats++;
    if (ordered) v.ordered++;
    if (ripe) {
      v.ripeChats++;
      if (sold) v.sold++;
    }
    if (!v.first || at < v.first) v.first = at;
    if (!v.last || at > v.last) v.last = at;
    per.set(key, v);
  };
  const skipped: string[] = [];
  for (const s of await stores(t)) {
    const m = byShop.get(s.id);
    if (!m?.size) continue;
    const rows = await t
      .shop(s.schema)
      .query(
        `SELECT c.id, c.created_at < $2::timestamptz AS ripe,
                EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id AND coalesce(o.conf_status, '') <> 'duplicate') AS ordered,
                EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id AND ${SOLD}) AS sold
           FROM conversations c WHERE c.id = ANY($1::bigint[]) AND c.channel <> 'test'`,
        [[...m.keys()], ripeBefore],
      )
      .catch(() => null);
    if (!rows) {
      skipped.push(s.name);
      continue;
    }
    for (const r of rows as any[]) {
      const e = m.get(n(r.id))!;
      add1(e.book === null ? 'base' : String(e.book), e.at, !!r.ordered, !!r.ripe, !!r.sold);
    }
  }
  const versions = [
    { key: 'base', id: null as number | null, version: 0, status: 'base' },
    ...(books as any[]).map((b) => ({ key: String(n(b.id)), id: n(b.id), version: n(b.version), status: String(b.status) })),
  ]
    .map((b) => {
      const v = per.get(b.key);
      return v ? { ...b, chats: v.chats, ordered: v.ordered, conversion: pct(v.ordered, v.chats), ripeChats: v.ripeChats, sold: v.sold, realSales: pct(v.sold, v.ripeChats), from: v.first, to: v.last } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return {
    since,
    saleDays: SALE_DAYS,
    versions,
    test: test ? { id: n(test.id), championId: test.champion_id === null ? null : n(test.champion_id), challengerId: n(test.challenger_id), share: Number(test.share) || 0, startedAt: new Date(test.started_at).toISOString() } : null,
    skipped,
  };
}

// ---------------------------------------------------------------- Dellal's instruction book (always the latest)
const frDay = (d: string | Date) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d));

/** What every shop's Dellal reads before answering, as one text file: put together now, so it is always the latest. */
export async function dellalBookText(t: Tenancy, now: Date | number = Date.now()) {
  const books = await t.platform
    .query(
      `SELECT b.version, b.status, b.text, b.created_at, b.promoted_at, b.lesson_ids, t.share
         FROM platform.pilot_books b LEFT JOIN platform.pilot_tests t ON t.status = 'running' AND t.challenger_id = b.id
        WHERE b.status = 'champion' OR (b.status = 'testing' AND t.id IS NOT NULL)
        ORDER BY (b.status = 'champion') DESC, b.promoted_at DESC NULLS LAST, b.version DESC`,
    )
    .catch(() => []);
  const champ = books.find((b: any) => b.status === 'champion');
  const test = books.find((b: any) => b.status === 'testing');
  const lessonsOf = (b: any) => (Array.isArray(b?.lesson_ids) ? b.lesson_ids.length : typeof b?.lesson_ids === 'string' ? (JSON.parse(b.lesson_ids) as unknown[]).length : 0);
  const updatedAt = champ ? new Date(champ.promoted_at ?? champ.created_at).toISOString() : null;
  const rule = '─'.repeat(64);
  const head = (title: string) => ['', rule, title, rule, ''];
  const share = (b: any) => Math.round(n(b.share) * 100);
  const lines: string[] = ['DELLAL — LE LIVRE DE VENTE', ''];
  lines.push(champ ? `Livre de leçons de vente : version ${champ.version}, en service depuis le ${frDay(updatedAt!)} (${lessonsOf(champ)} leçon(s)).` : 'Pas encore de livre de leçons : Dellal vend avec sa méthode de base.');
  if (test) lines.push(`En test : la version ${test.version}, essayée sur ${share(test)} % des nouvelles conversations.`);
  lines.push(
    `Fichier préparé le ${frDay(new Date(now))} : chaque téléchargement donne la dernière version.`,
    '',
    'Ce livre est celui de la VENTE : avant chaque réponse, Dellal lit 1. la méthode de vente, 2. le livre de leçons de vente',
    'approuvé par le coach. La darija a son propre livre (Pilot AI › Tester & leçons › Leçons › Darija, « Télécharger le livre',
    'de darija »). Chaque boutique ajoute ensuite sa propre partie (son nom, son ton, ses langues, ses règles, son catalogue et',
    'la conversation en cours) : cette partie n’est pas dans ce fichier.',
    ...head('1. LA MÉTHODE DE VENTE (la même pour toutes les boutiques)'),
    DELLAL_PLAYBOOK.replace('${ORDER_NEXT}', 'selon la boutique, la commande part en préparation ou un conseiller appelle pour confirmer.').trim(),
    ...head(champ ? `2. LE LIVRE DE LEÇONS DE VENTE — version ${champ.version}` : '2. LE LIVRE DE LEÇONS DE VENTE'),
    champ && String(champ.text).trim() ? String(champ.text).trim() : 'Aucune leçon approuvée pour l’instant.',
  );
  if (test)
    lines.push(
      ...head(`EN TEST — version ${test.version} (${share(test)} % des nouvelles conversations)`),
      'Elle sera gardée seulement si elle fait livrer au moins autant de colis que la version actuelle : le résultat se lit sur',
      `les conversations de plus de ${PILOT.matureDays} jours (le temps des livraisons), avec au moins ${PILOT.minPass} conversations de chaque côté.`,
      '',
      String(test.text).trim() || '(vide)',
    );
  const text = lines.join('\n') + '\n';
  return { version: champ ? n(champ.version) : null, updatedAt, testVersion: test ? n(test.version) : null, lessons: lessonsOf(champ), text };
}

// ---------------------------------------------------------------- Pilot Comments
export async function cmBoard(t: Tenancy, i: { days: BoardDays; shopId?: number; now?: Date | number; costs?: boolean }) {
  const p = boardPeriod(i.days, i.now);
  const list = await stores(t);
  const chosen = i.shopId ? list.filter((s) => s.id === i.shopId) : list;
  const keys = ['comments', 'answered', 'privates', 'hidden', 'handed', 'errors', 'team', 'leads'] as const;
  type K = Record<(typeof keys)[number], number>;
  const empty = (): K => ({ comments: 0, answered: 0, privates: 0, hidden: 0, handed: 0, errors: 0, team: 0, leads: 0 });
  const total = empty();
  const prevTotal = empty();
  const points = new Map(buckets(p).map((d) => [d, 0]));
  const rows: ({ key: string; label: string } & K)[] = [];
  const skipped: string[] = [];
  const sql = (a: number, b: number) => `SELECT ${dayOf('created_at')} AS d, count(*)::int AS comments,
            count(*) FILTER (WHERE public_reply_id IS NOT NULL)::int AS answered,
            count(*) FILTER (WHERE private_sent)::int AS privates,
            count(*) FILTER (WHERE hidden)::int AS hidden,
            count(*) FILTER (WHERE status = 'handoff')::int AS handed,
            count(*) FILTER (WHERE status = 'error')::int AS errors,
            count(*) FILTER (WHERE handled_by IS NOT NULL)::int AS team,
            count(*) FILTER (WHERE conversation_id IS NOT NULL OR phone IS NOT NULL)::int AS leads
       FROM cm_comments WHERE ${between('created_at', a, b)} GROUP BY 1`;
  for (const s of chosen) {
    const db = t.shop(s.schema);
    let cur: any[];
    let before: any[];
    try {
      [cur, before] = await Promise.all([db.query(sql(1, 2), [p.from, p.to]), db.query(sql(1, 2), [p.prevFrom, p.prevTo])]);
    } catch {
      skipped.push(s.name);
      continue;
    }
    const one = empty();
    for (const x of cur) {
      for (const k of keys) one[k] += n(x[k]);
      const key = bucketOf(p, String(x.d));
      if (points.has(key)) points.set(key, points.get(key)! + n(x.comments));
    }
    for (const x of before) for (const k of keys) prevTotal[k] += n(x[k]);
    for (const k of keys) total[k] += one[k];
    if (one.comments) rows.push({ key: String(s.id), label: s.name, ...one });
  }
  rows.sort((a, b) => b.comments - a.comments || a.label.localeCompare(b.label));
  return {
    days: i.days,
    from: p.from,
    to: p.to,
    bucket: p.bucket,
    shopId: i.shopId ?? null,
    shops: list.map((s) => ({ id: s.id, name: s.name })),
    kpi: total,
    prev: prevTotal,
    cost: i.costs === false ? null : await costOf(t, 'cm', p.from, p.to, i.shopId),
    series: [...points].map(([day, comments]) => ({ day, comments })),
    rows,
    skipped,
  };
}

// ---------------------------------------------------------------- AI Spy
export async function spyBoard(t: Tenancy, i: { days: BoardDays; shopId?: number; now?: Date | number; costs?: boolean }) {
  const p = boardPeriod(i.days, i.now);
  const list = await stores(t);
  const chosen = i.shopId ? list.filter((s) => s.id === i.shopId) : list;
  const keys = ['watched', 'ads', 'active', 'newAds', 'analysed', 'briefs', 'followed', 'alerts'] as const;
  type K = Record<(typeof keys)[number], number>;
  const empty = (): K => ({ watched: 0, ads: 0, active: 0, newAds: 0, analysed: 0, briefs: 0, followed: 0, alerts: 0 });
  const total = empty();
  const rows: ({ key: string; label: string } & K)[] = [];
  const skipped: string[] = [];
  for (const s of chosen) {
    const db = t.shop(s.schema);
    const r = (
      await db
        .query(
          `SELECT (SELECT count(*) FROM spy_watch WHERE watch)::int AS watched,
                  (SELECT count(*) FROM spy_watch WHERE brief IS NOT NULL)::int AS briefs,
                  (SELECT count(*) FROM spy_follow)::int AS followed,
                  (SELECT count(*) FROM spy_ads WHERE NOT own)::int AS ads,
                  (SELECT count(*) FROM spy_ads WHERE NOT own AND active)::int AS active,
                  (SELECT count(*) FROM spy_ads WHERE NOT own AND ${between('first_seen', 1, 2)})::int AS "newAds",
                  (SELECT count(*) FROM spy_ads WHERE NOT own AND ai IS NOT NULL)::int AS analysed,
                  (SELECT count(*) FROM spy_events WHERE ${between('at', 1, 2)})::int AS alerts`,
          [p.from, p.to],
        )
        .catch(() => null)
    )?.[0];
    if (!r) {
      skipped.push(s.name);
      continue;
    }
    const one = empty();
    for (const k of keys) one[k] = n(r[k]);
    for (const k of keys) total[k] += one[k];
    if (one.watched || one.ads || one.followed) rows.push({ key: String(s.id), label: s.name, ...one });
  }
  rows.sort((a, b) => b.ads - a.ads || b.watched - a.watched || a.label.localeCompare(b.label));
  return {
    days: i.days,
    from: p.from,
    to: p.to,
    shopId: i.shopId ?? null,
    shops: list.map((s) => ({ id: s.id, name: s.name })),
    kpi: total,
    cost: i.costs === false ? null : await costOf(t, 'spy', p.from, p.to, i.shopId),
    rows,
    skipped,
  };
}

/** what Pilotix's key paid for one AI agent in [from, to] (Algeria's days) */
async function costOf(t: Tenancy, feature: string, from: string, to: string, shopId?: number) {
  const r = await t.platform
    .query(
      `SELECT coalesce(sum(usd), 0) AS usd, coalesce(sum(calls), 0)::int AS calls FROM platform.ai_usage
        WHERE feature = $1 AND payer = 'pilotix' AND day BETWEEN $2::date AND $3::date${shopId ? ' AND shop_id = $4' : ''}`,
      shopId ? [feature, from, to, shopId] : [feature, from, to],
    )
    .catch(() => [{ usd: 0, calls: 0 }]);
  return { usd: Number(r[0]?.usd) || 0, calls: n(r[0]?.calls) };
}
