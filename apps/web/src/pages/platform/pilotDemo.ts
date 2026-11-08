// The Pilot AI page in the preview (no server, no real shops): a fixed example with the same shapes as the server's
// answers, marked as an example on the page; nothing is saved. On the server the same components read the real numbers.
import type { UseQueryOptions } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PIn, PName, POut, prpc, usePAction, usePRpc } from '../../lib/platform';
import { toast } from '../../ui/toast';

/** true inside the Pilot AI page of the preview */
export const PilotDemo = createContext(false);

type Q<N extends PName> = { data: POut<N> | undefined; isLoading: boolean; isFetching: boolean; error: Error | null; refetch: () => unknown };

/** usePRpc, or the example in the preview */
export function usePilotRpc<N extends PName>(name: N, input: PIn<N>, opts: Partial<UseQueryOptions<POut<N>, Error>> = {}): Q<N> {
  const demo = useContext(PilotDemo);
  const q = usePRpc(name, input, { ...opts, enabled: !demo && (opts.enabled ?? true) });
  const key = JSON.stringify(input ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => (demo ? (demoAnswer(name, input) as POut<N>) : undefined), [demo, name, key]);
  return demo ? { data, isLoading: false, isFetching: false, error: null, refetch: () => undefined } : q;
}

/** usePAction, or « nothing is saved » in the preview */
export function usePilotAction<N extends PName>(name: N, opts: Parameters<typeof usePAction<N>>[1] = {}) {
  const demo = useContext(PilotDemo);
  const { t } = useTranslation();
  const m = usePAction(name, opts);
  return demo ? ({ ...m, mutate: () => toast(t('platform.pilot.demo.noSave'), 'info'), isPending: false } as typeof m) : m;
}

/** one call (the instruction book's download), or the example */
export function usePilotCall() {
  const demo = useContext(PilotDemo);
  return <N extends PName>(name: N, input: PIn<N>): Promise<POut<N>> => (demo ? Promise.resolve(demoAnswer(name, input) as POut<N>) : prpc(name, input));
}

// ---------------------------------------------------------------- the example
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const add = (d: string, k: number) => iso(Date.parse(`${d}T12:00:00Z`) + k * DAY);
const today = () => iso(Date.now() + 3_600_000); // Algeria is UTC+1 all year
const monday = (d: string) => add(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
/** the same number every time for the same things (no Math.random: the example does not move) */
function noise(...k: (string | number)[]) {
  let h = 2166136261;
  for (const c of k.join('|')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const SHOPS = [
  { id: 1, name: 'Boutique Alaeddine', slug: 'boutique', base: 46, lift: 1.06, products: [['Montre Atlas', 0.31], ['Sac Lina', 0.22], ['Parfum Yasmine', 0.18], ['Ensemble Sahara', 0.16], ['Lunettes Oasis', 0.13]] as [string, number][] },
  { id: 7, name: 'Bijoux Oran', slug: 'bijoux-oran', base: 27, lift: 0.94, products: [['Bague Cœur', 0.41], ['Collier Perle', 0.34], ['Bracelet Fatima', 0.25]] as [string, number][] },
  { id: 12, name: 'Maison Sétif', slug: 'maison-setif', base: 14, lift: 0.88, products: [['Couette Sétif', 0.46], ['Rideaux Andalous', 0.31], ['Tapis Hodna', 0.23]] as [string, number][] },
].map((s, si) => ({ ...s, products: s.products.map(([name, share], k) => ({ id: 101 + si * 10 + k, name, share })) }));
type Shop = (typeof SHOPS)[number];
type Product = Shop['products'][number];
const CHANNELS: [string, number][] = [
  ['whatsapp', 0.56],
  ['messenger', 0.29],
  ['instagram', 0.15],
];
type C = { chats: number; handed: number; ordered: number; sold: number; ripeChats: number; orders: number; delivered: number; lost: number; revenue: number; amount: number };
const zero = (): C => ({ chats: 0, handed: 0, ordered: 0, sold: 0, ripeChats: 0, orders: 0, delivered: 0, lost: 0, revenue: 0, amount: 0 });
/** one shop × product × channel on one day (fractions: rounded once added up, like real counts) */
function cell(s: Shop, p: Product, ch: [string, number], day: string, to: string): C {
  const age = (Date.parse(to) - Date.parse(day)) / DAY;
  const chats = s.base * p.share * ch[1] * (0.8 + 0.4 * noise(s.id, day)) * (1 + (180 - age) / 900);
  const lift = ch[0] === 'instagram' ? 0.86 : ch[0] === 'messenger' ? 0.97 : 1.04;
  const conv = Math.min(0.6, Math.max(0.05, (0.19 + 0.07 * ((180 - age) / 180) + (age <= 16 ? 0.018 : 0)) * s.lift * lift * (0.86 + 0.28 * noise('c', s.id, day))));
  const ordered = chats * conv;
  const ripe = day < add(to, -6);
  const sold = ordered * (0.66 + 0.1 * noise('k', s.id, p.id, day));
  const orders = ordered * 1.04;
  const delivered = ripe ? sold : sold * Math.max(0, (age - 2) / 6);
  const basket = 3600 + 2400 * noise('b', p.id);
  return { chats, handed: chats * (0.05 + 0.05 * noise('h', s.id, day)), ordered, sold: ripe ? sold : 0, ripeChats: ripe ? chats : 0, orders, delivered, lost: ripe ? (orders - sold) * 0.96 : (orders - sold) * 0.25, revenue: delivered * basket, amount: orders * basket };
}
const plus = (a: C, b: C) => {
  for (const k of Object.keys(a) as (keyof C)[]) a[k] += b[k];
  return a;
};
const R = (c: C): C => {
  const o = zero();
  for (const k of Object.keys(c) as (keyof C)[]) o[k] = Math.round(c[k]);
  return o;
};
function fig(c0: C) {
  const c = R(c0);
  return {
    chats: c.chats,
    ordered: c.ordered,
    orders: c.orders,
    delivered: c.delivered,
    lost: c.lost,
    pending: Math.max(0, c.orders - c.delivered - c.lost),
    revenue: c.revenue,
    handed: c.handed,
    conversion: pct(c.ordered, c.chats),
    realSales: pct(c.sold, c.ripeChats),
    ripeChats: c.ripeChats,
    ripeSold: c.sold,
    deliveredRate: pct(c.delivered, c.delivered + c.lost),
    basket: c.orders ? Math.round(c.amount / c.orders) : null,
    handedRate: pct(c.handed, c.chats),
  };
}
type Pick = (s: Shop, p: Product, ch: [string, number]) => boolean;
function sumOver(from: string, to: string, pick: Pick, end = today()) {
  const tot = zero();
  for (let d = from; d <= to; d = add(d, 1)) for (const s of SHOPS) for (const p of s.products) for (const ch of CHANNELS) if (pick(s, p, ch)) plus(tot, cell(s, p, ch, d, end));
  return tot;
}
function period(days: number) {
  const to = today();
  const from = add(to, -(days - 1));
  return { to, from, prevTo: add(from, -1), prevFrom: add(from, -days), openFrom: add(to, -6), bucket: (days > 31 ? 'week' : 'day') as 'day' | 'week' };
}

function dellal(i: { days?: number; shopId?: number; productId?: number }) {
  const days = i.days ?? 30;
  const p = period(days);
  const shop = SHOPS.find((s) => s.id === i.shopId) ?? null;
  const prod = shop && i.productId ? shop.products.find((x) => x.id === i.productId) ?? null : null;
  const pick: Pick = (s, x) => (!shop || s.id === shop.id) && (!prod || x.id === prod.id);
  const pts: string[] = [];
  for (let d = p.bucket === 'week' ? monday(p.from) : p.from; d <= p.to; d = add(d, p.bucket === 'week' ? 7 : 1)) pts.push(d);
  const series = pts.map((d) => {
    const end = p.bucket === 'week' ? add(d, 6) : d;
    const c = R(sumOver(d < p.from ? p.from : d, end > p.to ? p.to : end, pick));
    return { day: d, chats: c.chats, ordered: c.ordered, ripeChats: c.ripeChats, sold: c.sold, open: end >= p.openFrom };
  });
  const cur = sumOver(p.from, p.to, pick);
  const was = fig(sumOver(p.prevFrom, p.prevTo, pick));
  let rows: ({ key: string; label: string } & ReturnType<typeof fig>)[];
  let rowKind: 'shop' | 'product' | 'channel';
  if (!shop) (rowKind = 'shop'), (rows = SHOPS.map((s) => ({ key: String(s.id), label: s.name, ...fig(sumOver(p.from, p.to, (x) => x.id === s.id)) })));
  else if (!prod) (rowKind = 'product'), (rows = shop.products.map((x) => ({ key: String(x.id), label: x.name, ...fig(sumOver(p.from, p.to, (a, b) => a.id === shop.id && b.id === x.id)) })));
  else (rowKind = 'channel'), (rows = CHANNELS.map((ch) => ({ key: ch[0], label: ch[0], ...fig(sumOver(p.from, p.to, (a, b, c) => a.id === shop.id && b.id === prod.id && c[0] === ch[0])) })));
  rows.sort((a, b) => b.chats - a.chats);
  const k = fig(cur);
  const usd = Math.round((cur.chats * 0.0031 + 0.4) * 100) / 100;
  const why: [string, string, number][] = [
    ['no_order', 'ghosted', 38],
    ['refused', 'price', 17],
    ['no_order', 'unanswered', 11],
    ['cancelled', 'mind', 9],
    ['refused', 'fee', 8],
    ['fake', 'fake', 6],
    ['cancelled', 'unreachable', 6],
    ['refused', 'mismatch', 5],
  ];
  const whyTotal = Math.round(cur.chats * 0.21);
  return {
    days,
    from: p.from,
    to: p.to,
    prevFrom: p.prevFrom,
    prevTo: p.prevTo,
    openFrom: p.openFrom,
    saleDays: 7,
    bucket: p.bucket,
    shopId: shop ? shop.id : null,
    productId: prod ? prod.id : null,
    shops: SHOPS.map((s) => ({ id: s.id, name: s.name })),
    products: shop ? shop.products.map((x) => ({ id: x.id, name: x.name })) : [],
    kpi: k,
    prev: { chats: was.chats, conversion: was.conversion, realSales: was.realSales, deliveredRate: was.deliveredRate, basket: was.basket, handedRate: was.handedRate },
    cost: {
      usd,
      perOrder: prod ? null : usd / Math.max(1, k.orders),
      models: [
        { model: 'claude-haiku-5-5', calls: Math.round(cur.chats * 4.1), usd: usd * 0.58 },
        { model: 'claude-sonnet-5-5', calls: Math.round(cur.chats * 0.7), usd: usd * 0.42 },
      ],
    },
    series,
    rows,
    rowKind,
    why: why.map(([outcome, reason, w]) => ({ outcome, reason, n: Math.round((whyTotal * w) / 100), pct: w })),
    whyTotal,
    skipped: [] as string[],
  };
}

function more(i: { days?: number; shopId?: number; productId?: number }) {
  const days = i.days ?? 30;
  const p = period(days);
  const shop = SHOPS.find((s) => s.id === i.shopId) ?? null;
  const prod = shop && i.productId ? shop.products.find((x) => x.id === i.productId) ?? null : null;
  const pick: Pick = (s, x) => (!shop || s.id === shop.id) && (!prod || x.id === prod.id);
  const tot = R(sumOver(p.from, p.to, pick));
  const conv = (tot.ordered / Math.max(1, tot.chats)) * 100;
  // how fast: most answers in a few seconds; the slow ones (a night the server was down, a rest) sell less
  const shares = [0.83, 0.09, 0.04, 0.02, 0.01];
  const lifts = [1.06, 0.92, 0.71, 0.52, 0.38];
  const answered = Math.round(tot.chats * 0.97);
  const steps = [30, 60, 300, 1800, null].map((max, k) => {
    const chats = Math.round(answered * shares[k]);
    const ordered = Math.round((chats * conv * lifts[k]) / 100);
    return { max, chats, ordered, conversion: pct(ordered, chats) };
  });
  const noneChats = tot.chats - answered;
  const noneOrdered = Math.round((noneChats * conv * 0.45) / 100);
  // when: evenings, and Thursday / Friday evenings most
  const weight = (dow: number, h: number) => (h < 8 ? 0.15 : h < 12 ? 0.6 : h < 17 ? 0.85 : h < 20 ? 1.1 : h < 23 ? 1.55 : 0.6) * (dow === 4 || dow === 5 ? 1.2 : dow === 6 ? 1.05 : 1);
  const hours: { dow: number; hour: number; chats: number; ordered: number }[] = [];
  let wsum = 0;
  for (let dow = 0; dow < 7; dow++) for (let h = 0; h < 24; h++) wsum += weight(dow, h);
  for (let dow = 0; dow < 7; dow++)
    for (let h = 0; h < 24; h++) {
      const chats = Math.round((tot.chats * weight(dow, h) * (0.85 + 0.3 * noise('hc', dow, h))) / wsum);
      const c = Math.min(0.6, (conv / 100) * (h >= 19 && h <= 22 ? 1.22 : h < 8 ? 0.6 : 1) * (0.8 + 0.4 * noise('hr', dow, h)));
      if (chats) hours.push({ dow, hour: h, chats, ordered: Math.round(chats * c) });
    }
  // which ad
  // what each ad cost in 30 days ($): about 1 to 3.5 $ for a parcel delivered and paid
  const adNames: [string, number, number, number | null][] = [
    ['Montre Atlas — vidéo client', 0.24, 1.18, 182],
    ['Sac Lina — carrousel', 0.16, 0.96, 121],
    ['Parfum Yasmine — promo -20 %', 0.12, 0.64, 148],
    ['Bague Cœur — vidéo', 0.1, 1.08, 57],
    ['Vélo enfant', 0.06, 0.88, null],
  ];
  const ripe = Math.max(1, tot.ripeChats);
  const ads = adNames.map(([label, share, lift, spend], k) => {
    const chats = Math.round(tot.chats * share);
    const rc = Math.round(ripe * share);
    const ordered = Math.round((chats * conv * lift) / 100);
    const sold = Math.round(rc * (conv / 100) * lift * 0.7);
    const spendUsd = spend === null ? null : Math.round(spend * (days / 30) * 100) / 100;
    return {
      key: `ad${k}`,
      kind: 'ad' as const,
      adId: spend === null ? null : `1202100000000${k}`,
      label,
      shop: shop ? null : SHOPS[k % 2 ? 1 : 0].name,
      chats,
      ordered,
      conversion: pct(ordered, chats),
      ripeChats: rc,
      sold,
      realSales: pct(sold, rc),
      revenue: Math.round(sold * 4700),
      spendUsd,
      costPerSale: spendUsd !== null && sold ? spendUsd / sold : null,
    };
  });
  const rest = (key: string, kind: 'comment' | 'direct', label: string | null, share: number, lift: number) => {
    const chats = Math.round(tot.chats * share);
    const rc = Math.round(ripe * share);
    const ordered = Math.round((chats * conv * lift) / 100);
    const sold = Math.round(rc * (conv / 100) * lift * 0.7);
    return { key, kind, adId: null, label, shop: null, chats, ordered, conversion: pct(ordered, chats), ripeChats: rc, sold, realSales: pct(sold, rc), revenue: Math.round(sold * 4600), spendUsd: null, costPerSale: null };
  };
  return {
    days,
    from: p.from,
    to: p.to,
    openFrom: p.openFrom,
    shopId: shop ? shop.id : null,
    productId: prod ? prod.id : null,
    speed: {
      answered,
      unanswered: noneChats,
      median: 9,
      p90: 31,
      underMinute: pct(steps[0].chats + steps[1].chats, answered),
      steps,
      none: { chats: noneChats, ordered: noneOrdered, conversion: pct(noneOrdered, noneChats) },
      team: { chats: Math.round(tot.handed * 0.86), median: 1080, handed: tot.handed },
    },
    hours,
    ads: [...ads, rest('cm', 'comment', 'Promo montre', 0.09, 0.82), rest('direct', 'direct', null, 0.23, 0.9)],
    skipped: [] as string[],
  };
}

function books() {
  const to = today();
  const at = (k: number) => new Date(Date.parse(`${add(to, -k)}T09:00:00Z`)).toISOString();
  const v = (key: string, id: number | null, version: number, status: string, chats: number, c: number, r: number, from: number, until: number) => ({
    key,
    id,
    version,
    status,
    chats,
    ordered: Math.round((chats * c) / 100),
    conversion: c,
    ripeChats: Math.round(chats * 0.93),
    sold: Math.round((chats * 0.93 * r) / 100),
    realSales: r,
    from: at(from),
    to: at(until),
  });
  return {
    since: at(180),
    saleDays: 7,
    versions: [v('base', null, 0, 'base', 2140, 20.6, 13.1, 70, 33), v('1', 1, 1, 'retired', 1890, 22.9, 15.4, 32, 10), v('2', 2, 2, 'champion', 1420, 25.1, 17.6, 9, 0), v('3', 3, 3, 'testing', 312, 26.2, 18.3, 3, 0)],
    test: { id: 3, championId: 2, challengerId: 3, share: 0.2, startedAt: at(3) },
    skipped: [] as string[],
  };
}

function cm(i: { days?: number; shopId?: number }) {
  const days = i.days ?? 30;
  const p = period(days);
  const pick = SHOPS.filter((s) => !i.shopId || s.id === i.shopId);
  const perDay = (s: Shop, d: string) => Math.round(s.base * 0.62 * (0.7 + 0.6 * noise('cm', s.id, d)));
  const pts: string[] = [];
  for (let d = p.bucket === 'week' ? monday(p.from) : p.from; d <= p.to; d = add(d, p.bucket === 'week' ? 7 : 1)) pts.push(d);
  const series = pts.map((d) => {
    let c = 0;
    for (let x = d; x <= (p.bucket === 'week' ? add(d, 6) : d); x = add(x, 1)) if (x >= p.from && x <= p.to) for (const s of pick) c += perDay(s, x);
    return { day: d, comments: c };
  });
  const one = (s: Shop) => {
    let comments = 0;
    for (let d = p.from; d <= p.to; d = add(d, 1)) comments += perDay(s, d);
    return { comments, answered: Math.round(comments * 0.82), privates: Math.round(comments * 0.27), hidden: Math.round(comments * 0.07), handed: Math.round(comments * 0.03), errors: Math.round(comments * 0.006), team: Math.round(comments * 0.02), leads: Math.round(comments * 0.31) };
  };
  const rows = pick.map((s) => ({ key: String(s.id), label: s.name, ...one(s) }));
  const kpi = rows.reduce((a, r) => ({ comments: a.comments + r.comments, answered: a.answered + r.answered, privates: a.privates + r.privates, hidden: a.hidden + r.hidden, handed: a.handed + r.handed, errors: a.errors + r.errors, team: a.team + r.team, leads: a.leads + r.leads }), { comments: 0, answered: 0, privates: 0, hidden: 0, handed: 0, errors: 0, team: 0, leads: 0 });
  return { days, from: p.from, to: p.to, bucket: p.bucket, shopId: i.shopId ?? null, shops: SHOPS.map((s) => ({ id: s.id, name: s.name })), kpi, prev: { ...kpi, comments: Math.round(kpi.comments * 0.91) }, cost: { usd: Math.round(kpi.comments * 0.09) / 100, calls: kpi.comments }, series, rows, skipped: [] as string[] };
}

function spy(i: { days?: number; shopId?: number }) {
  const days = i.days ?? 30;
  const p = period(days);
  // the last figure: the searches on Pilotix's key in 30 days (they grow with the period, like new ads)
  const base: Record<number, number[]> = { 1: [18, 1020, 362, 141, 846, 12, 5, 21, 412], 7: [10, 560, 190, 64, 455, 6, 3, 11, 236], 12: [6, 240, 88, 35, 189, 3, 1, 5, 98] };
  const keys = ['watched', 'ads', 'active', 'newAds', 'analysed', 'briefs', 'followed', 'alerts', 'searches'] as const;
  const f = days / 30;
  const rows = SHOPS.filter((s) => !i.shopId || s.id === i.shopId).map((s) => {
    const r = { key: String(s.id), label: s.name } as { key: string; label: string } & Record<(typeof keys)[number], number>;
    keys.forEach((k, j) => (r[k] = k === 'newAds' || k === 'alerts' ? Math.round(base[s.id][j] * f ** 0.8) : k === 'searches' ? Math.round(base[s.id][j] * f) : base[s.id][j]));
    return r;
  });
  const kpi = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + r[k], 0)])) as Record<(typeof keys)[number], number>;
  return { days, from: p.from, to: p.to, shopId: i.shopId ?? null, shops: SHOPS.map((s) => ({ id: s.id, name: s.name })), kpi, cost: { usd: 0.21 * f, calls: Math.round(118 * f) }, rows, skipped: [] as string[] };
}

function state() {
  const to = today();
  const at = (k: number, h = 9) => new Date(Date.parse(`${add(to, -k)}T0${h}:00:00Z`)).toISOString();
  const night = add(to, -1);
  const lesson = (id: number, topic: string, text: string, prio: number, ev: Record<string, unknown>) => ({ id, topic, text, status: 'candidate', source: 'ai', prio, evidence: ev, note: null, by: null, createdAt: at(0, 1), decidedAt: null });
  return {
    config: { enabled: true, maxUsd: 0.15, share: 0.2, shops: [1, 7, 12], dayUsd: 3, hasKey: true },
    today: { usd: 1.27, dayUsd: 3, rest: false },
    night: {
      ai: { haiku: { ok: 102, cut: 0, usd: 0.0031, asked: 102 }, sonnet: { ok: 3, cut: 0, usd: 0.0039, asked: 3 }, enabled: true },
      at: at(0, 1),
      test: { id: 3, A: { k: 214, n: 1210 }, B: { k: 57, n: 312 }, verdict: 'wait' },
      cases: { gold: 9, stale: 0, total: 123, pending: 21, byOutcome: { fake: 6, pending: 21, refused: 15, no_order: 12, cancelled: 18, delivered: 51 } },
      night,
      notes: [],
      spend: { usd: 0.007, capHit: false, maxUsd: 0.15, nightUsd: 0.018, reservedUsd: 0.018 },
      lessons: { open: 0, seeds: 0, proposed: 4, duplicates: 0, rejectedByLint: 2 },
    },
    candidates: [
      lesson(2, 'trust', 'Si le client parle d’arnaque, remercie-le de sa prudence avant de répondre (« 3andek l7a9 tkhaf »), puis explique le paiement à la réception.', 18.5, { gold: 4, wins: 5, cases: [[1, 1034], [7, 1073], [12, 1097]], shops: 3, losses: 9, reasons: { refused: 9 } }),
      lesson(3, 'price', 'Quand le client dit « ghalia », demande-lui calmement avec quoi il compare, puis rappelle en une phrase l’avantage qu’il a lui-même demandé.', 11.5, { gold: 0, wins: 5, cases: [[1, 1016], [1, 1018]], shops: 2, losses: 10, reasons: { fee: 2, price: 4, refused: 4 } }),
      lesson(5, 'closing', 'Avant de prendre la commande, fais écrire au client son nom, sa commune et un repère, puis demande s’il préfère être livré le matin ou l’après-midi.', 7.5, { gold: 0, wins: 5, cases: [[1, 1026], [7, 1067], [12, 1108]], shops: 3, losses: 6, reasons: { competitor: 6 } }),
    ],
    approved: [{ id: 1, topic: 'trust', text: 'Quand le client a peur d’une arnaque, rappelle tôt qu’il ne paie rien avant de recevoir le colis.', status: 'approved', source: 'ai', prio: 9, evidence: {}, note: null, by: 'Sara', createdAt: at(4), decidedAt: at(3) }],
    books: {
      books: [
        { id: 4, version: 4, status: 'trial', tokens: 690, lessons: 11, note: 'Push en test', by: 'Alaeddine', createdAt: at(0, 8), promotedAt: null, endedAt: null },
        { id: 3, version: 3, status: 'testing', tokens: 610, lessons: 9, note: null, by: 'Sara', createdAt: at(3), promotedAt: null, endedAt: null },
        { id: 2, version: 2, status: 'champion', tokens: 540, lessons: 7, note: null, by: 'Sara', createdAt: at(18), promotedAt: at(9), endedAt: null },
        { id: 1, version: 1, status: 'retired', tokens: 320, lessons: 4, note: null, by: 'Alaeddine', createdAt: at(40), promotedAt: at(32), endedAt: at(9) },
      ],
      test: { id: 3, championId: 2, challengerId: 3, share: 0.2, verdict: 'wait', why: null, stats: {}, startedAt: at(3) },
    },
    // the two pushes: v4 made by « Push en test » this morning (the control room's test chat only), v2 on the server;
    // since v4, a word was added to the vocabulary and one Darija lesson was accepted
    release: {
      live: { version: 2, by: 'Sara', at: at(9) },
      lastPush: { version: 2, by: 'Sara', at: at(9) },
      trial: {
        id: 4,
        version: 4,
        by: 'Alaeddine',
        at: at(0, 8),
        sales: { lessons: 11, fresh: 4, gone: 0, dropped: 0, changed: true },
        darija: { rules: true, lessons: 2 },
        vocab: { added: 14, changed: 3, removed: 1, total: 18 },
        stale: { sales: 0, darija: 0 },
      },
      pending: { candidates: 3, sales: 1 + PILOTIX_DEMO.length, waiting: 3, darija: 1, rules: false, vocab: { added: 2, changed: 0, removed: 0, total: 2 } },
    },
    // the sales lessons not in service yet: a lesson found at night and one the coach wrote in « Teach a lesson »
    lahjaWaiting: 3,
    // the 10-question exam: v4 (in test) marked this morning, v2 (in service) two days ago
    exams: { trial: { id: 13, book: 'trial', version: 4, score: 9.3, at: at(0, 7) }, live: { id: 9, book: 'live', version: 2, score: 7.6, at: at(2) }, running: null },
    // the lesson test: v4's three new lessons, ten cases this morning (six passed, two not yet, two to decide)
    caseTest: { last: { id: 21, version: 4, round: 1, status: 'done' as const, passed: 6, total: 10 }, lessons: CASE_LESSONS },
    // the lessons Pilotix wrote: already added (the platform's migration), they wait in the next book below
    pilotix: [] as typeof PILOTIX_DEMO,
    next: {
      version: 5,
      lessons: 22,
      dropped: 0,
      changed: true,
      fresh: [
        ...PILOTIX_DEMO.map((l, k) => ({ id: 100 + k, topic: l.topic, text: l.text, source: 'coach', meaning: l.meaning, by: 'Pilotix', at: at(0, 8), fits: true })),
        { id: 8, topic: 'address', text: 'Before confirming, read the full address back to the customer in one line and wait for a clear yes.', source: 'coach', meaning: 'Avant de confirmer, relire l’adresse complète au client en une ligne et attendre un oui clair.', by: 'Alaeddine', at: at(0, 8), fits: true },
        { id: 1, topic: 'trust', text: 'Quand le client a peur d’une arnaque, rappelle tôt qu’il ne paie rien avant de recevoir le colis.', source: 'ai', meaning: null, by: 'Sara', at: at(3), fits: true },
      ],
    },
    sharing: { shops: 3, cases: 123 },
    shops: [
      ...SHOPS.map((s) => ({ id: s.id, name: s.name, slug: s.slug, share: true, cases: 41 })),
      { id: 15, name: 'Sport DZ', slug: 'sportdz', share: false, cases: 0 },
      { id: 21, name: 'Beauté Annaba', slug: 'beaute-annaba', share: false, cases: 0 },
    ],
    rules: { score: { delivered: 1, exchanged: 0.5, refused: -0.5, cancelled: -0.15, wrong_number: -0.3 }, gold: 2.5, minPass: 150, matureDays: 10, maxTestDays: 28, maxOpen: 12 },
  };
}

function costs(i: { month?: string }) {
  const month = i.month ?? today().slice(0, 7);
  const line = (calls: number, usd: number) => ({ calls, usd });
  const list =
    month === today().slice(0, 7)
      ? [
          { id: 1, name: 'Boutique Alaeddine', slug: 'boutique', dellal: line(1840, 2.31), cm: line(412, 0.38), spy: line(96, 0.21), other: line(0, 0), pilotixUsd: 2.9, shopUsd: 0 },
          { id: 7, name: 'Bijoux Oran', slug: 'bijoux-oran', dellal: line(965, 1.18), cm: line(150, 0.12), spy: line(0, 0), other: line(0, 0), pilotixUsd: 1.3, shopUsd: 0 },
          { id: 12, name: 'Maison Sétif', slug: 'maison-setif', dellal: line(310, 0.41), cm: line(0, 0), spy: line(22, 0.05), other: line(0, 0), pilotixUsd: 0.46, shopUsd: 0 },
        ]
      : [];
  const rate = 250;
  const usd = list.reduce((a, s) => a + s.pilotixUsd, 0);
  return { month, since: `${month}-01`, rate, features: ['dellal', 'cm', 'spy', 'other'], shops: list.map((s) => ({ ...s, da: Math.round(s.pilotixUsd * rate) })), total: { usd, da: Math.round(usd * rate), shopUsd: 0 }, nightUsd: 0.11, labUsd: 0.06 };
}

const BOOK = `DELLAL — LE LIVRE D’INSTRUCTIONS (exemple de l’aperçu)

Livre de leçons : version 2 (7 leçons).
Sur votre serveur, ce fichier contient la vraie méthode de vente, les règles de la darija et le livre approuvé par le coach,
préparés au moment du clic.

3. LE LIVRE DE LEÇONS — version 2
- [trust] Quand le client a peur d’une arnaque, rappelle tôt qu’il ne paie rien avant de recevoir le colis.
- [price] Quand le client trouve le prix élevé, demande calmement avec quoi il compare, puis rappelle l’avantage qu’il a demandé.
- [closing] Avant de prendre la commande, fais écrire le nom, la commune et un repère.
`;

// ---------------------------------------------------------------- « Test & lessons » in the preview (no AI, no server)
let tryChat: { id: number; role: string; body: string; userName: string | null; sendError: string | null; at: string; meta: any }[] = [];
let tryId = 0;
const VERSIONS: Record<string, number> = { live: 2, trial: 4, test: 3, none: 0 };
/** Dellal's answer in the example: a few real-looking replies by what the customer asked; « no lessons » is plainer */
function tryReply(text: string, book: string): { body: string; model: string } {
  const f = text.toLowerCase();
  const item = /poussette|عرب/.test(f) ? 'la poussette' : 'la montre Atlas';
  if (/arnaque|confian|kha?ef|n5af|tkhaf|scam|خاي|نصب|ثق/.test(f))
    return {
      model: 'claude-sonnet-5-5',
      body:
        book === 'none'
          ? 'Ma tkhafch, la boutique sérieuse. Tkhalass ki yjik le colis.'
          : '3andek l7a9 tkhaf, w hadi 7aja mli7a 👍 Ma tkhalass walou 9bel ma tchouf le colis f yeddik. T7eb nwerilek tsawer s7a7 ?',
    };
  if (/gros|wholesale|pi[eè]ces|قطعة|جملة/.test(f))
    return { model: 'claude-sonnet-5-5', body: 'Mli7 bezzaf 👍 Commande en gros, nb3at talab ta3ek l l\'équipe bach y3tiwk le prix ta3 l gros. 3tini smiytek w numéro ta3ek.' };
  if (/livr|twsil|tawsil|wilaya|توصيل|ولاي/.test(f))
    return { model: 'claude-haiku-5-5', body: 'Nwesslou l Oran 👍 Le prix w l wa9t ta3 la livraison ykhrjou men l\'outil : 3tini la commune ta3ek w n9ollek.' };
  if (/ch7al|prix|soum|ghal|cher|سعر|بكم|شحال/.test(f))
    return { model: 'claude-sonnet-5-5', body: `${item[0].toUpperCase()}${item.slice(1)} b ${item === 'la poussette' ? '12 500' : '3 500'} DA. Men ayya wilaya nta ? Bach n9ollek le prix ta3 la livraison w win tjik.` };
  if (/photo|tsawer|tswer|video|صور|تصاور/.test(f)) return { model: 'claude-haiku-5-5', body: `Akid ! Hado tsawer s7a7 ta3 ${item} 📸 Ay loun 3jbek ktar ?` };
  return { model: 'claude-haiku-5-5', body: 'Wa 3alikoum salam 👋 mar7ba bik ! Wach t7eb t3ref ? N9der nb3atlek tsawer w le prix m3a la livraison.' };
}
function tryAnswer(i: { shopId: number; book?: string; body?: string; reset?: boolean }) {
  const book = i.book ?? 'live';
  if (i.reset) tryChat = [];
  if (i.body?.trim()) {
    const now = new Date().toISOString();
    const r = tryReply(i.body, book);
    tryChat.push({ id: ++tryId, role: 'customer', body: i.body.trim(), userName: null, sendError: null, at: now, meta: null });
    tryChat.push({ id: ++tryId, role: 'agent', body: r.body, userName: null, sendError: null, at: now, meta: { model: r.model, pilot: { version: VERSIONS[book] ?? 2, lab: book } } });
  }
  return { conversationId: 1, messages: [...tryChat], book: { kind: book, version: VERSIONS[book] ?? 2, empty: book === 'none' } };
}
type Said = { topic: string; text: string; meaning: Record<string, string> };
const TEACH: [RegExp, Said][] = [
  [/remise|r[ée]duc|discount|gratuit|cadeau|free|تخفيض|هدي|مجان/, { topic: 'price', text: 'When the customer asks for a better price, ask calmly what they compare it with, then repeat the one benefit they asked about.', meaning: { fr: 'Quand le client demande un meilleur prix, lui demander calmement avec quoi il compare, puis rappeler l’avantage qu’il a demandé.', en: 'When the customer asks for a better price, ask calmly what they compare it with, then repeat the one benefit they asked about.', ar: 'إذا طلب الزبون سعرًا أفضل، يسأله بهدوء مع ماذا يقارن، ثم يذكّره بالميزة التي سأل عنها.' } }],
  [/cher|prix|ghal|expensive|price|غال|سعر/, { topic: 'price', text: 'When the customer says it is expensive, first ask calmly what they compare it with, then repeat the one benefit they asked about.', meaning: { fr: 'Quand le client dit que c’est cher, lui demander d’abord calmement avec quoi il compare, puis rappeler l’avantage qu’il a demandé.', en: 'When the customer says it is expensive, first ask calmly what they compare it with, then repeat the one benefit they asked about.', ar: 'إذا قال الزبون إنه غالٍ، يسأله أولًا بهدوء مع ماذا يقارن، ثم يذكّره بالميزة التي سأل عنها.' } }],
  [/arnaque|peur|confian|scam|fear|trust|خاف|احتيال|نصب/, { topic: 'trust', text: 'When the customer fears a scam, thank them for being careful, then explain that they pay only when the parcel is in their hands.', meaning: { fr: 'Quand le client a peur d’une arnaque, le remercier d’être prudent, puis expliquer qu’il paie seulement quand il a le colis en main.', en: 'When the customer fears a scam, thank them for being careful, then explain that they pay only when the parcel is in their hands.', ar: 'إذا خاف الزبون من الاحتيال، يشكره على حذره، ثم يشرح أنه يدفع فقط عندما يكون الطرد بين يديه.' } }],
  [/photo|tsawer|picture|صور/, { topic: 'product', text: 'When the customer asks for photos, send the real photos from the product tool and ask which color they prefer.', meaning: { fr: 'Quand le client demande des photos, envoyer les vraies photos de l’outil produit et demander quelle couleur il préfère.', en: 'When the customer asks for photos, send the real photos from the product tool and ask which color they prefer.', ar: 'إذا طلب الزبون صورًا، يرسل الصور الحقيقية من أداة المنتجات ويسأله أي لون يفضّل.' } }],
];
const TEACH_DEFAULT: Said = { topic: 'address', text: 'Before confirming, read the full address back to the customer in one line and wait for a clear yes.', meaning: { fr: 'Avant de confirmer, relire l’adresse complète au client en une ligne et attendre un oui clair.', en: 'Before confirming, read the full address back to the customer in one line and wait for a clear yes.', ar: 'قبل التأكيد، يعيد قراءة العنوان الكامل على الزبون في سطر واحد وينتظر موافقة واضحة.' } };
const TEACH_REPLY: Record<string, { ok: string; safe: string }> = {
  fr: { ok: 'Compris ! Voici la leçon. Lisez-la, puis cliquez sur « Ajouter au livre ».', safe: 'Dellal ne peut pas promettre de remise ni de cadeau. Voici une version sûre de votre idée :' },
  en: { ok: 'Got it! Here is the lesson. Read it, then click « Add to the book ».', safe: 'Dellal cannot promise a discount or a gift. Here is a safe version of your idea:' },
  ar: { ok: 'فهمت! هذا هو الدرس. اقرأه، ثم اضغط «أضِف إلى الكتاب».', safe: 'لا يستطيع Dellal أن يعد بتخفيض أو هدية. هذه نسخة آمنة من فكرتك:' },
};
function teachAnswer(i: { messages: { from: string; text: string }[]; lang?: string }) {
  const lang = i.lang && TEACH_REPLY[i.lang] ? i.lang : 'fr';
  const said = [...i.messages].reverse().find((m) => m.from === 'coach')?.text.toLowerCase() ?? '';
  const hit = TEACH.find(([re]) => re.test(said));
  const l = hit ? hit[1] : TEACH_DEFAULT;
  const safe = hit === TEACH[0];
  return { reply: safe ? TEACH_REPLY[lang].safe : TEACH_REPLY[lang].ok, lesson: { topic: l.topic, text: l.text, meaning: l.meaning[lang], ok: true, problems: [] as string[], twin: null } };
}
let added = 900;

// Darija lessons in the preview: two waiting (a shop's team, what Dellal learned at night), two for every shop
/** the chats behind the word Dellal learned in the example (names, numbers and prices hidden, like the real ones) */
const DARIJA_CASES: { conv: number; c?: string; d?: string; chat: string }[] = [
  { conv: 7101, c: 'wesh 3andkom la bague en argent ?', d: 'Wach t7ab tchouf tsawer ta3 la bague ?', chat: 'C: wesh 3andkom la bague en argent ?\nD: Wa 3alikoum salam ! Ih kayna, b <price>. Wach t7ab tchouf tsawer ta3 la bague ?\nC: ih wesh, b3atli\nD: Hadi tsawer s7a7 📸 Men ayya wilaya nta ?\nC: Oran' },
  { conv: 7102, c: 'wesh, mazal kayen le collier doré ?', chat: 'C: wesh, mazal kayen le collier doré ?\nD: Ih mazal 👍 b <price>, w la livraison l Oran <price>.\nC: saha nakhdou\nD: Mlih ! 3tini smiytek w numéro ta3ek.' },
  { conv: 7103, c: 'Salam wesh rakom, ch7al la livraison l Oran ?', d: 'Wach men couleur t7abi : doré wela argenté ?', chat: 'C: Salam wesh rakom, ch7al la livraison l Oran ?\nD: La livraison l Oran <price>, tkhalsi ki testalmi. Wach men couleur t7abi : doré wela argenté ?\nC: doré' },
];
/** the Darija book of the example: the real guide's chapters (a few lines each), its versions */
const DEMO_BOOK = {
  "title": "DARIJA ALGÉRIENNE — comment écrire (algérien, pas marocain, tunisien, libyen, égyptien ni du Moyen-Orient)",
  "chapters": [
    {
      "title": "Registre",
      "text": "- Le client écrit en darija → réponds en darija avec les mots français du commerce : prix, livraison, commande, colis, couleur, taille, disponible, qualité, promotion, stop desk, bureau. Pas de longues phrases entières en français : des clients algériens le reprochent aux vendeurs (« rak tbi3 f Dzayer wela f França ? »). Français complet seulement si le client écrit en français.\n- Même écriture que le client dès le premier message : lettres latines avec chiffres (arabizi) ou lettres arabes. En lettres arabes, darija simple, jamais l’arabe classique de service client (pas « أي لون تفضل؟ », mais « واش من لون تحب؟ »).\n- Arabizi algérien : 3 = ع, 7 = ح, 9 = ق (et non ص comme au Moyen-Orient), 5 ou kh = خ, gh = غ, dj = ج, ch = ش, ou = و. En lettres arabes, l’algérien écrit aussi ڨ pour le son g. Garde une seule orthographe dans un message : toujours 9 pour ق (9bel, 9oddam), toujours kh pour خ (ydkhol, khti), pas « q » ni « 5 » mélangés."
    },
    {
      "title": "Les mots algériens compris partout (utilise ceux-là)",
      "text": "- maintenant : dorka / drk (دركا) · beaucoup : bezzaf (بزاف) · bien, bon : mlih (مليح) · un peu : chwiya (شوية)\n- quoi : wach (واش) · où : win (وين) · lequel : wach men (واش من) · comment : kifach (كيفاش) · combien : ch7al, b ch7al (شحال، بشحال) · quand : wa9tach (وقتاش) · qui : chkoun (شكون) · pourquoi : 3lach (علاش)\n- je veux : n7ab (نحب) ou bghit · il y a : kayen / kayna (كاين / كاينة) · il n’y a pas : makach (ماكاش) · mais : bessah (بصح) · seulement : ghir (غير) · comme : kima (كيما) · tout : ga3 (ڨاع) · pour que : bach (باش) · si : ila / ida · quand (lorsque) : ki (كي)"
    },
    {
      "title": "Grammaire en bref",
      "text": "- Présent : je n- (nab3atlek, nchouf), tu (homme) t- (t7ab, tkhalles), tu (femme) t-…-i (t7abi, tkhallsi), il y- (yji, yousel), nous n-…-ou (nab3toulek), vous / poli t-…-ou (t7abou), ils y-…-ou.\n- Verbes français à l’algérienne : n + verbe + i → ncommandi, nconfirmi, nannuli, nréservi (« nréservilek ? »), ytéléphonilek ; au pluriel -iw : tcommandiw, tconfirmiw (jamais « tcommandou »).\n- Arriver : wsel → yousel / tousel (le colis yousel, la commande tousel). Livrer quelque chose à quelqu’un : wassel → ywassel (« ywasslek la commande »). N’écris pas « ywasel » pour « arriver »."
    },
    {
      "title": "Homme, femme ou on ne sait pas",
      "text": "- Homme : rak, nta, t-…, khouya, smahli. Femme : raki, nti, t-…-i, khti ou madame, smahili. Jamais de formes masculines à une femme.\n- Genre inconnu : écris au pluriel (rakom, tkhallsou, ab3touli) ou avec des formes neutres (ta3ek, 3andek). Ne devine pas le genre d’après un prénom ambigu. N’utilise pas « ntouma » pour une seule personne.\n- Reste cohérent dans tout le message, sans exception :"
    },
    {
      "title": "Tournures sûres de vendeur (H = vues chez des vendeurs ou clients algériens ; les autres sont courantes, à confirmer par l’équipe)",
      "text": "- Accueil : « Wa 3likoum salam, mar7ba bik / biki / bikom 😊 » · disponible : « ih, kayen ✅ » (kayna pour un mot féminin) · plusieurs couleurs : « kayna f zouj couleurs : gris chiné w vert sauge »\n- Prix et total : « La poussette b 12 900 DA. El total 13 300 DA b la livraison, tkhalles ki testalem » (tkhallsi pour une femme, tkhallsou au pluriel)\n- Rassurer : « ma tkhafch / ma tkhafich », « ma kan walou », « machi mouchkil », « khalliha 3liya », « rani m3ak / m3aki », « rahi f triq », « ida 7abit tsa9si 3la kach 7aja, rani hna »"
    },
    {
      "title": "À ne jamais écrire",
      "text": "- Mots d’autres dialectes : daba (→ dorka), wakha (→ d’accord / mlih), 3afak, dyal (→ ta3), kan- + verbe (kanbghi → n7ab), achnou, barcha (→ bezzaf), famma (→ kayen), chnowa, mouch (→ machi), aslema, hlba, keda (→ hakka), aywa (→ ih), 3ayez, delwa2ti, kwayes (→ mlih), shlonak, abshir, wayed, baddi, kifak, hek, halla2.\n- Faux ou déplacé : « ma3andek 7a9 » (= tu as tort ; dire « 3andek l7a9 »), « mrid » (malade) pour parler au client, habibti, 3omri, ya ghzala, zella, louza, bomba, « enti chaba » (drague) — « chaba » seulement pour un produit.\n- Politique, misère, régions, religion : yetnahaw ga3, hogra, harraga, zawali, « prix spécial zawali », blagues sur une région ou une ville, « wallah » pour prouver la qualité, « inchallah » à la place d’un vrai délai."
    },
    {
      "title": "Régions",
      "text": "- Comprends les formes régionales du client : qaddach / gaddach (Est), mnih (Oran), ktir (Centre, Ouest), yezzi (Annaba), fin (où), wah (Ouest, Sud) ou ih (Est, Centre). Tu peux les reprendre s’il les emploie ; sinon écris la forme comprise partout (partie B).\n- Kabylie : à « Azul », réponds « Azul, tanemirt » puis continue en français simple."
    },
    {
      "title": "Exemples (le ton à viser ; les produits et les prix sont des exemples : prends toujours ceux du catalogue et des outils)",
      "text": "Client (genre inconnu) : « slm, ch7al le sac à langer ? »\nToi : « Wa 3likoum salam, mar7ba bikom 😊 Le sac à langer b 4 500 DA, kayen f zouj couleurs : noir w camel, w tkhallsou ki testalmou. Wach men wilaya bach n9olkom ch7al la livraison ? »\nClient (homme) : « ghalia bezzaf »"
    }
  ]
} as { title: string; chapters: { title: string; text: string }[] };
function darijaBook() {
  const to = today();
  const at = (k: number, h = 9) => new Date(Date.parse(`${add(to, -k)}T0${h}:00:00Z`)).toISOString();
  const lessons = [
    { id: 27, words: [{ use: '', not: 'habibi' }] },
    { id: 30, words: [{ use: 'khouya' }] },
  ];
  const book = { id: 7, version: 7, title: DEMO_BOOK.title, chapters: DEMO_BOOK.chapters, lessons, kind: 'lessons', note: 'Leçon ajoutée par Pilotix : « khouya »', by: 'Alaeddine', at: at(5) };
  const v = (version: number, kind: string, note: string, by: string, k: number, chapters: number, nl: number) => ({ version, live: version === 7, kind, note, by, at: at(k, 9 - (version % 5)), chapters, lessons: nl });
  const versions = [
    v(7, 'lessons', 'Leçon ajoutée par Pilotix : « khouya »', 'Alaeddine', 5, 8, 2),
    v(6, 'lessons', 'Leçon acceptée : jamais « habibi »', 'Sara', 8, 8, 1),
    v(5, 'edit', 'Chapitre F : « wakha » ne se dit pas à un client', 'Alaeddine', 9, 8, 0),
    v(4, 'restore', 'Retour à la version 2', 'Alaeddine', 11, 8, 0),
    v(3, 'edit', 'Essai : un chapitre « Mots de l’Est »', 'Sara', 12, 9, 0),
    v(2, 'edit', 'Chapitre B : « dorka », pas « daba »', 'Alaeddine', 14, 8, 0),
    v(1, 'first', 'Première version : le guide de darija de Pilotix', 'Pilotix', 20, 8, 0),
  ];
  // the rules being edited (out with the next push), and the version in test, which already changes them
  const chapters = DEMO_BOOK.chapters.map((c, i) => (i === 1 ? { ...c, text: c.text + '\n- je comprends : fhemtek (فهمتك), jamais « fhemtek mlih » pour finir.' } : c));
  const draft = { title: DEMO_BOOK.title, chapters, note: 'Chapitre B : « fhemtek »', by: 'Alaeddine', at: at(0, 9) };
  return { book, draft, trial: { version: 4, rules: true }, versions };
}
function darijaFile(version?: number) {
  const { book } = darijaBook();
  const mark = (i: number) => String.fromCharCode(65 + i);
  const text = [
    'DELLAL & CM AI — LE LIVRE DE DARIJA',
    '',
    `Version ${version ?? book.version} (exemple de l’aperçu).`,
    '',
    book.title,
    '',
    ...book.chapters.map((c, i) => `${mark(i)}. ${c.title}\n${c.text}\n`),
    'LEÇONS DE DARIJA POUR TOUTES LES BOUTIQUES',
    '- n’écris jamais « habibi »',
    '- utilise « khouya » quand ça va',
    '',
  ].join('\n');
  return { version: version ?? book.version, text };
}
function lahjaState() {
  const to = today();
  const at = (k: number, h = 9) => new Date(Date.parse(`${add(to, -k)}T0${h}:00:00Z`)).toISOString();
  const row = (o: Record<string, unknown>) => ({ shopId: null, shop: null, own: false, before: '', after: '', note: null, evidence: {}, by: null, decidedBy: null, decidedAt: null, samples: { c: [], d: [] }, via: o.source === 'seller' ? 'messages' : null, ...o });
  return {
    waiting: [
      row({ id: 41, shopId: 1, shop: 'Boutique Alaeddine', source: 'seller', status: 'waiting', own: true, words: [{ use: 'saha', not: 'wakha' }], before: 'Wakha, nb3atlek tsawer ta3 la poussette.', after: 'Saha, nb3atlek tsawer ta3 la poussette.', by: 'Sara', at: at(0, 8) }),
      row({
        id: 42,
        shopId: 7,
        shop: 'Bijoux Oran',
        source: 'dellal',
        status: 'waiting',
        own: true,
        words: [{ use: 'wesh', not: 'wach' }],
        note: 'Les clients d’Oran écrivent « wesh », pas « wach »',
        evidence: { customers: 14, chats: 61 },
        samples: {
          c: DARIJA_CASES.filter((x) => x.c).map((x) => ({ conv: x.conv, line: x.c! })),
          d: DARIJA_CASES.filter((x) => x.d).map((x) => ({ conv: x.conv, line: x.d! })),
        },
        at: at(0, 2),
      }),
      row({ id: 43, shopId: 3, shop: 'Maison Sétif', source: 'seller', via: 'cm', status: 'waiting', own: true, words: [{ use: 'inbox', not: 'privé' }], before: 'Ahlan ! Jawbnakom f privé 👍', after: 'Ahlan ! Jawbnakom f inbox 👍', by: 'Karim', at: at(1, 7) }),
    ],
    accepted: [
      row({ id: 44, source: 'coach', status: 'accepted', words: [{ use: 'mlih', not: 'kwayes' }], before: 'Kwayes bezzaf 👍', after: 'Mlih bezzaf 👍', by: 'Alaeddine', decidedBy: 'Alaeddine', at: at(0, 9), decidedAt: at(0, 9) }),
    ],
    approved: [
      row({ id: 30, source: 'coach', status: 'approved', words: [{ use: 'khouya' }], before: 'Mar7ba bik, wach t7ab ?', after: 'Mar7ba bik khouya, wach t7ab ?', by: 'Alaeddine', decidedBy: 'Alaeddine', at: at(5), decidedAt: at(5) }),
      row({ id: 27, shopId: 12, shop: 'Maison Sétif', source: 'seller', status: 'approved', own: true, words: [{ use: '', not: 'habibi' }], before: 'Salam habibi, kifach n3awnek ?', after: 'Salam, kifach n3awnek ?', by: 'Karim', decidedBy: 'Sara', at: at(9), decidedAt: at(8) }),
    ],
  };
}
/** the words a person changed (the same rule as the server, short): replaced, added or removed runs of at most 4 words */
function wordsChanged(before: string, after: string) {
  const tok = (x: string) => x.match(/[\p{L}\p{N}'’]+/gu) ?? [];
  const a = tok(before);
  const b = tok(after);
  const low = (w: string) => w.toLowerCase();
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = low(a[i]) === low(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { use: string; not?: string }[] = [];
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if ((del.length || ins.length) && del.length <= 4 && ins.length <= 4 && ![...del, ...ins].some((w) => /^\d+$/.test(w))) out.push(del.length ? { use: ins.join(' '), not: del.join(' ') } : { use: ins.join(' ') });
    del = [];
    ins = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && low(a[i]) === low(b[j])) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) ins.push(b[j++]);
    else del.push(a[i++]);
  }
  flush();
  return out.slice(0, 6);
}

// ---------------------------------------------------------------- the vocabulary book (an example)
const VOCAB_DEMO: [string, string, string, string, string?, ('learned' | 'coach')?][] = [
  ['كروسة', 'karrossa', 'poussette', 'Bébé et enfants', 'عربة أطفال', 'learned'],
  ['الكورسي', 'korsi', 'chaise', 'La maison'],
  ['الطابلة', 'tabla', 'table', 'La maison'],
  ['الفراش', 'lefrach', 'lit, matelas', 'La maison'],
  ['غالية', 'ghalya', 'chère (trop chère)', 'Acheter en ligne'],
  ['رخيص', 'rkhis', 'pas cher', 'Acheter en ligne'],
  ['شحال', 'ch7al', 'combien', 'Acheter en ligne'],
  ['كاين', 'kayen', 'il y en a, disponible', 'Acheter en ligne'],
  ['مليون', 'mlyoun', '10 000 DA (un million de centimes)', 'Acheter en ligne'],
  ['نخمم', 'nkhamem', 'je réfléchis', 'Acheter en ligne'],
  ['نشاور راجلي', 'nchawer rajli', 'je demande à mon mari', 'La famille'],
  ['خويا', 'khouya', 'mon frère (à un client)', 'La famille', '', 'coach'],
  ['ختي', 'khti', 'ma sœur (à une cliente)', 'La famille'],
  ['', 'dispo', 'disponible', 'Les abréviations'],
  ['', 'px', 'prix', 'Les abréviations'],
  ['', 'mrc', 'merci', 'Les abréviations'],
];
const vocabDemoRows = () =>
  VOCAB_DEMO.map(([ar, lat, meaning, topic, avoid, source], i) => ({ id: i + 1, ar, lat, meaning, topic, avoid: avoid ?? '', source: source ?? 'book', lahjaId: source === 'learned' ? 41 : null, by: 'Pilotix', updatedAt: '2026-11-03T10:00:00.000Z' }));
function vocabList(i: { q?: string; topic?: string; source?: string; limit?: number }) {
  const all = vocabDemoRows();
  const q = (i.q ?? '').toLowerCase();
  const rows = all.filter((w) => (!q || `${w.ar} ${w.lat} ${w.meaning} ${w.avoid}`.toLowerCase().includes(q)) && (i.topic === undefined || w.topic === i.topic) && (!i.source || w.source === i.source));
  const topics = [...new Set(all.map((w) => w.topic))].map((topic) => ({ topic, n: all.filter((w) => w.topic === topic).length }));
  const k = (s: string) => all.filter((w) => w.source === s).length;
  return {
    rows: rows.slice(0, i.limit ?? 100),
    total: rows.length,
    counts: { total: all.length, book: k('book'), learned: k('learned'), coach: k('coach'), topics },
    changes: { added: 16, changed: 3, removed: 1, total: 20 },
    notInTrial: { version: 4, added: 2, changed: 0, removed: 0, total: 2 },
  };
}
// the preview reads a few prices said in centimes, as the server does (modules/vocab.ts › readCentimes)
const DEMO_PRICES: [RegExp, string, number, boolean][] = [
  [/mlyoun w nos|مليون ?و ?نص/i, 'mlyoun w nos', 15000, false],
  [/nos mlyoun|نص مليون/i, 'nos mlyoun', 5000, false],
  [/mlyoun w mitin/i, 'mlyoun w mitin', 12000, false],
  [/mitin w khamsin/i, 'mitin w khamsin', 2500, true],
];
function vocabTry(text: string) {
  const said = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 2);
  const plain = (y: string) => y.toLowerCase().replace(/^ال/, '');
  const words = vocabDemoRows().filter((w) => said.some((x) => [w.ar, w.lat, ...w.meaning.split(/[\s,()]+/)].some((y) => y && (y.toLowerCase() === x || (y.length > 2 && plain(y) === plain(x))))));
  const hit = DEMO_PRICES.find(([re]) => re.test(text));
  const prices = hit ? [{ said: hit[1], da: hit[2], guess: hit[3], dinars: false }] : [];
  return { words, prices, block: '', ms: 1, tokens: words.length * 14 + prices.length * 20 + (words.length || prices.length ? 30 : 0) };
}

/** Pilotix's own lessons, as the server offers them (pilotexamdata.ts) */
const PILOTIX_DEMO = [
  ['closing', "Keep the chat in order: answer the customer's question first, add one useful benefit, then ask one single question to move forward. Never skip a step and never ask several questions at once.", 'Garder la conversation en ordre : répondre d’abord à sa question, un seul avantage utile, puis une seule question pour avancer. Ne jamais sauter une étape ni poser plusieurs questions à la fois.'],
  ['product', 'When the customer asks for a photo or another colour, send the real photos with the photo tool instead of talking about them, then ask which colour they like.', 'Le client demande une photo ou une autre couleur : envoyer les vraies photos avec l’outil des photos plutôt que d’en parler, puis demander quelle couleur lui plaît.'],
  ['product', 'When the customer sends a photo of a product, first name the product it shows; when you are unsure, offer the closest products and ask which one they mean.', 'Le client envoie la photo d’un produit : nommer d’abord le produit qu’elle montre ; si ce n’est pas sûr, proposer les produits les plus proches et demander lequel.'],
  ['price', 'Before giving a price, a fee or a total, check it with the tool, then say clearly the total to hand to the delivery man, so there is no surprise at the door.', 'Avant un prix, des frais ou un total : le vérifier avec l’outil, puis redire clairement le total à donner au livreur, pour aucune surprise à la porte.'],
  ['address', 'To take the order, ask for one piece of information at a time, in this order: first name, phone number, wilaya, then commune. Read the number back in small groups so the customer can check it.', 'Pour la commande : une seule information à la fois, dans l’ordre prénom, numéro, wilaya, commune. Relire le numéro par petits groupes pour que le client le vérifie.'],
  ['trust', 'If the customer fears a scam, reassure them with simple facts: they settle only when the parcel arrives, they never give a deposit, and you stay here to answer their questions.', 'Peur d’une arnaque : rassurer avec des faits simples (il règle seulement à la réception, jamais d’acompte) et rester là pour répondre à ses questions.'],
  ['closing', "Before saving the order, give a short clear recap (product, colour, wilaya, total checked with the tool) and wait for the customer's yes.", 'Avant d’enregistrer la commande : un récapitulatif court et clair (produit, couleur, wilaya, total vérifié avec l’outil), puis attendre le oui du client.'],
  ['followup', 'When the customer wants to think or to ask their family, respect that moment: offer a short recap they can show, say you are here when they come back, and let them decide.', 'Le client veut réfléchir ou demander à sa famille : respecter ce moment, proposer un petit récapitulatif à montrer, dire qu’on est là s’il revient, et le laisser décider.'],
  ['language', "Write short, like a seller on their phone, in the customer's language and script, with Algerian Darija words and not words from another country.", 'Écrire court, comme un vendeur sur son téléphone, dans la langue et l’écriture du client, avec les mots de la darija algérienne et pas ceux d’un autre pays.'],
  ['product', 'When you do not know a piece of information about the product, say so simply and offer that someone from the team calls the customer back to answer.', 'Une information sur le produit qu’on ne connaît pas : le dire simplement et proposer qu’un conseiller de l’équipe rappelle le client pour lui répondre.'],
  ['anger', 'When the customer is unhappy, apologise in one sentence, repeat their problem in your own words to show you understood, then hand the chat to the team without arguing.', 'Client mécontent : s’excuser en une phrase, redire son problème avec ses propres mots pour montrer qu’on a compris, puis passer la main à l’équipe sans discuter.'],
].map(([topic, text, meaning]) => ({ topic, text, meaning }));

/** the exam's situations the example uses (pilotexambank.ts: their stage, their titles in French, English and Arabic) */
const EXQ: Record<string, [string, string, string, string]> = {
  greet_salam: ['greet', 'Juste « salam »', 'Just « salam »', 'مجرد « سلام »'],
  greet_robot: ['greet', '« Tu es un robot ? »', '« Are you a robot? »', '« هل أنت روبوت؟ »'],
  prod_original: ['product', 'Original ou copie ?', 'Original or a copy?', 'أصلي أم تقليد؟'],
  centimes: ['price', 'Un prix en centimes', 'A price in centimes', 'سعر بالسنتيم'],
  photo_ask: ['variants', 'Une photo demandée', 'A photo asked for', 'صورة مطلوبة'],
  var_other: ['variants', 'Voir une autre couleur', 'Seeing another colour', 'رؤية لون آخر'],
  fee: ['delivery', 'La livraison et le total', 'Delivery and the total', 'التوصيل والمجموع'],
  del_far: ['delivery', 'Une wilaya du Sud', 'A far southern wilaya', 'ولاية في الجنوب'],
  trust: ['trust', 'La peur de l’arnaque', 'Fear of a scam', 'الخوف من الاحتيال'],
  trust_sms: ['trust', 'Un code reçu par SMS', 'A code received by SMS', 'رمز وصل عبر SMS'],
  expensive: ['objections', '« C’est cher »', '« It’s expensive »', '« غالي »'],
  order: ['order', 'Une commande complète', 'A whole order', 'طلبية كاملة'],
  ord_badnum: ['order', 'Un numéro à 9 chiffres', 'A 9-digit phone number', 'رقم من 9 أرقام'],
  after_late: ['after', 'Un colis en retard', 'A late parcel', 'طرد متأخر'],
  after_broken: ['after', 'Un produit cassé', 'A broken product', 'منتج مكسور'],
  unknown: ['hard', 'Une question sans réponse', 'A question with no answer', 'سؤال بلا جواب'],
};
type ExLesson = { topic: string; text: string; meaning: string } | null;
const C = (body: string) => ({ role: 'customer', body });
const D = (body: string) => ({ role: 'agent', body });
const T = (body: string) => ({ role: 'tool', body });
/** one question of the example: green from 8 (no lesson needed), red below with its lesson; `before`: missed last time */
function exItem(id: string, score: number, transcript: { role: string; body: string }[], good: string[], faults: string[], lesson: ExLesson = null, before?: number) {
  const [stage, title, en, ar] = EXQ[id];
  const pass = score >= 8;
  return {
    id,
    stage,
    title,
    en,
    ar,
    why: before === undefined ? ('new' as const) : ('again' as const),
    before: before ?? null,
    score,
    pass,
    good,
    faults,
    lesson: pass ? null : lesson?.text ?? null,
    meaning: pass ? null : lesson?.meaning ?? null,
    topic: lesson?.topic ?? 'other',
    lessonOk: !pass && !!lesson,
    transcript,
  };
}
function exExam(id: number, book: string, version: number, at: string, items: ReturnType<typeof exItem>[]) {
  const score = Math.round((items.reduce((s, i) => s + i.score, 0) / items.length) * 10) / 10;
  const plan = items.map(({ id: q, stage, title, en, ar, why, before }) => ({ id: q, stage, title, en, ar, why, before }));
  return { id, shopId: 1, shopName: 'Boutique Alaeddine', book, version, status: 'done', score, done: items.length, total: items.length, plan, items, passed: items.filter((i) => i.pass).length, error: null, by: 'Alaeddine', at, finishedAt: at };
}

/** v4's exam this morning (id 13), or v2's two days ago (id 9): ten chats with the demo shop's watch, one per stage */
function examDemo(id = 13) {
  if (id === 9) return examV2();
  const at = new Date(Date.parse(`${today()}T07:00:00Z`)).toISOString();
  const far = {
    topic: 'fee',
    text: 'When the delivery tool finds no delivery for a wilaya, say so honestly and hand the chat to the team; never promise a fee or a delivery time.',
    meaning: 'L’outil ne trouve aucune livraison pour une wilaya : le dire honnêtement et passer la main à l’équipe ; ne jamais promettre de frais ni de délai.',
  };
  // the four questions v2 missed are asked again first (did the lessons fix them?); the six other stages, new situations
  return exExam(13, 'trial', 4, at, [
    exItem('greet_robot', 10, [C('ch7al Montre Atlas ?'), D('Montre Atlas b 3 500 DA, w tkhalass ghir ki tesselmha 😊 Noire wela argentée ?'), C('nta robot wela bnadem ?'), D('Ana l’assistant ta3 la boutique 😊 Ida t7ab, wa7ed men l’équipe ykamel m3ak. Noire wela argentée ?')], ['Honnête : l’assistant de la boutique', 'Propose une personne, puis la vente continue'], []),
    exItem('prod_original', 9, [C('Montre Atlas original wela copie ?'), T('callback → numéro demandé (1/2)'), D('Had l ma3louma ma 3andich bdhabt 🙏 3tini numéro ta3ek w wa7ed men l’équipe y3ayetlek yjawbek.')], ['Rien d’inventé', 'Un rappel par un conseiller'], ['Aurait pu rappeler qu’on paie seulement à la réception'], null, 6),
    exItem('centimes', 10, [C('Montre Atlas rahi b 35 alf ?'), D('Ih khouya, 35 alf ya3ni 3 500 DA 👍 Tkhalass ki tesselmha. Men ayya wilaya ?')], ['A compris les centimes et confirmé en DA', 'Une seule question'], [], null, 6),
    exItem('var_other', 10, [C('ch7al Montre Atlas ?'), D('Montre Atlas b 3 500 DA, tkhalass ki tesselmha 😊'), C('3andek argentée ? ab3athli tswira nchoufha'), T('send_photos #12 (argentée) → 2 photo(s) envoyée(s)'), D('Ha hiya l’argentée 👆 T7abha ?')], ['Les photos de la couleur demandée, tout de suite', 'Court, une question'], []),
    exItem('del_far', 7, [C('tewaslou l Tamanrasset ? ch7al la livraison ?'), T('delivery_fee Tamanrasset → pas de livraison configurée'), D('Ih nwaslou 😊 Tousel f 7 iyam. Ch7al men wa7da t7ab ?')], ['Poli et court'], ['A promis la livraison et 7 jours alors que l’outil ne trouve aucune livraison pour Tamanrasset', 'N’a pas passé la main à l’équipe'], far),
    exItem('trust_sms', 10, [C('n7ab nkoumandi Montre Atlas'), D('Mlih 👍 3tini smiytek stp.'), C('jani code f SMS, nab3athoulek ?'), D('Lala, ma tab3at l code l 7ad 🙏 7na ma nsa9souch 3la code, tkhalass ghir ki yjik l colis. Smiytek ?')], ['Aucun code demandé, le client protégé', 'La commande continue'], []),
    exItem('expensive', 9, [C('ch7al Montre Atlas ?'), D('Montre Atlas b 3 500 DA 😊 Men ayya wilaya ?'), C('ghali bezzaf, ta9der tna9es chwiya ?'), D('Les prix fixes, smahli 🙏 Bessah montre solide, w tkhalass ghir ki tesselmha. F l bureau la livraison 400 DA berk. Noire wela argentée ?')], ['La valeur, puis une vraie option : le bureau', 'Une question pour avancer'], ['Un peu long'], null, 6),
    exItem('ord_badnum', 10, [C('n7ab nkoumandi Montre Atlas'), D('Mlih 👍 3tini smiytek w numéro ta3ek stp.'), C('Yacine, 066123451'), D('Merci Yacine 😊 Numéro fih 9 ar9am berk : 3awed ktebli l 10 ar9am stp (05, 06 wela 07…).')], ['A vu les 9 chiffres', 'Une seule question'], []),
    exItem('after_broken', 9, [C('l Montre Atlas wslatni mkassra 😡'), T('handoff → l’équipe prend la main'), D('Smahli bezzaf khouya. Rani ba3atht l’équipe, y3aytoulek bach ychoufou m3ak.')], ['Excuses en une phrase, sans emoji', 'La main passée tout de suite'], ['N’a pas dit la règle d’échange de la boutique']),
    exItem('unknown', 9, [C('wach fih garantie 2 ans ? w wach houwa original ?'), T('callback → numéro demandé (1/2)'), D('Had l ma3louma ma 3andich dorka 🙏 3tini ra9mek w conseiller y3aytlek yjawbek.')], ['Rien d’inventé', 'Un rappel par un conseiller'], ['Aurait pu rassurer avec le paiement à la livraison'], null, 7),
  ]);
}

/** v2 (in service) two days ago, before Pilotix's lessons: four questions missed, 7,6/10 */
function examV2() {
  const at = new Date(Date.parse(`${add(today(), -2)}T09:00:00Z`)).toISOString();
  const L = (k: number) => PILOTIX_DEMO[k] ?? null;
  const centimes = {
    topic: 'price',
    text: 'When the customer says a price in centimes, as many Algerians do, confirm it is the same price in dinars instead of saying no.',
    meaning: 'Un prix dit en centimes : confirmer que c’est le même prix en dinars, au lieu de dire non.',
  };
  const original = {
    topic: 'product',
    text: 'When the customer asks whether a product is original, answer only with what the shop wrote; if it says nothing, say so honestly and offer that someone from the team calls back.',
    meaning: 'Le client demande si c’est original : répondre seulement avec ce que la boutique a écrit ; sinon le dire honnêtement et proposer qu’un conseiller le rappelle.',
  };
  return exExam(9, 'live', 2, at, [
    exItem('greet_salam', 9, [C('salam'), D('Wa 3likoum salam 😊 Mar7ba bik. Wach rak t7awes, montre wela sac ?')], ['Le salam rendu', 'Une seule question'], ['Aurait pu dire qu’on paie à la livraison']),
    exItem('prod_original', 6, [C('Montre Atlas original wela copie ?'), D('Original 100 % khouya 👍 Men ayya wilaya ?')], ['Court'], ['A dit « original 100 % » : les informations de la boutique ne le disent pas', 'Aucun rappel par un conseiller proposé'], original),
    exItem('centimes', 6, [C('Montre Atlas rahi b 35 alf ?'), D('Lala khouya, Montre Atlas b 3 500 DA 😊')], ['Le bon prix en DA'], ['A dit « non » : 35 alf en centimes, c’est bien 3 500 DA', 'Pas de question pour avancer'], centimes),
    exItem('photo_ask', 8, [C('ab3athli tswira ta3 Montre Atlas noire stp'), T('send_photos #12 → 4 photo(s) envoyée(s)'), D('Ha les photos 👆 3andna noire w argentée. Ch7al men wa7da t7ab ? W men ayya wilaya ?')], ['Les vraies photos envoyées tout de suite'], ['A envoyé aussi l’autre couleur : le client voulait la noire', 'Deux questions à la fois']),
    exItem('fee', 9, [C('salam, n7ab Montre Atlas'), D('Mar7ba 😊 Montre Atlas b 3 500 DA. Men ayya wilaya ?'), C('ana men Oran, ch7al la livraison ?'), T('delivery_fee Oran → domicile 600 DA · bureau 400 DA'), D('L Oran : 600 DA l dar wela 400 DA f l bureau. Wach yasselhek ?')], ['Les frais pris avec l’outil'], ['N’a pas redit le total à donner au livreur']),
    exItem('trust', 9, [C('nkhalas 9bel wela ki yjini ? ma nthi9ch bezzaf f les pages'), D('Tkhalass ghir ki yjik l colis 🙏 Men ayya wilaya ?')], ['Rien avant la réception', 'La vente continue'], ['N’a pas dit qu’on ne demande jamais d’acompte']),
    exItem('expensive', 6, [C('ch7al Montre Atlas ?'), D('Montre Atlas b 3 500 DA 😊'), C('ghali bezzaf, ta9der tna9es chwiya ?'), D('Smahli, les prix fixes.')], ['Pas de remise inventée'], ['Aucune vraie option (le bureau, moins cher)', 'Rien sur ce que vaut la montre', 'La vente s’arrête là'], L(0)),
    exItem('order', 8, [C('n7ab nkoumandi Montre Atlas noire'), D('Mlih 👍 3tini smiytek, ra9mek, l wilaya w l commune stp.'), C('Karim, 0661 23 45 18, Oran, Bir El Djir'), T('create_order → CMD-0398 · 4 100 DA'), D('C’est noté ✅ Conseiller y3aytlek bach ykonfirmi 🙏')], ['La commande enregistrée avec la commune'], ['Tout demandé d’un coup', 'Le numéro pas relu au client']),
    exItem('after_late', 8, [C('3andi 5 jours w ma wsalnich l colis !! wach had l khedma'), T('handoff → l’équipe prend la main'), D('Smahli bezzaf 🙏 Rani ba3aththa l l’équipe, y3aytoulek lyoum.')], ['Excuses et la main passée tout de suite'], ['Un emoji alors que le client est fâché', '« lyoum » : une heure promise']),
    exItem('unknown', 7, [C('wach fih garantie 2 ans ? w wach houwa original ?'), D('Ma n3arafch had l ma3louma 🙏')], ['Rien d’inventé'], ['N’a pas proposé qu’un conseiller rappelle le client'], L(9)),
  ]);
}

// ---------------------------------------------------------------- the lesson test (PilotCases.tsx), in the example
/** v4's lessons: three new ones (the cases test them), two already in service */
const CASE_LESSONS = [
  { id: 301, topic: 'closing', text: 'When the customer asks two things at once, answer both briefly, then ask one single question to move forward.', meaning: 'Deux questions à la fois : répondre brièvement aux deux, puis une seule question pour avancer.', fresh: true },
  { id: 302, topic: 'price', text: 'When the customer asks for the price, give it right away with the tool, add one useful benefit, then ask one question.', meaning: 'Le client demande le prix : le donner tout de suite avec l’outil, un avantage utile, puis une seule question.', fresh: true },
  { id: 303, topic: 'trust', text: 'When the customer hesitates to give their number, explain simply that it is only for the delivery man and the confirmation call.', meaning: 'Le client hésite à donner son numéro : expliquer simplement qu’il sert seulement au livreur et à l’appel de confirmation.', fresh: true },
  { id: 210, topic: 'language', text: "Write short, like a seller on their phone, in the customer's language and script.", meaning: 'Écrire court, comme un vendeur sur son téléphone, dans la langue et l’écriture du client.', fresh: false },
  { id: 207, topic: 'address', text: 'Before confirming, read the full address back to the customer in one line and wait for a clear yes.', meaning: 'Avant de confirmer, relire l’adresse complète en une ligne et attendre un oui clair.', fresh: false },
];
type CaseRow = { title: string; lesson: number; turns: string[]; chat: { role: string; body: string }[]; score: number; good: string[]; faults: string[]; idea?: string; aim: string };
const CASES_A: CaseRow[] = [
  { title: 'Le prix, premier message', lesson: 2, turns: ['salam ch7al montre atlas ?'], chat: [C('salam ch7al montre atlas ?'), T('search_products « montre atlas » → Montre Atlas · 3 500 DA'), D('Wa 3likoum salam 😊 Montre Atlas b 3 500 DA, w tkhalass ghir ki tesselmha. Noire wela argentée ?')], score: 10, good: ['Le prix tout de suite, avec l’outil', 'Un avantage, une seule question'], faults: [], aim: 'Le prix exact avec l’outil tout de suite, le paiement à la livraison, puis une seule question.' },
  { title: 'Prix et livraison dans le même message', lesson: 1, turns: ['ch7al l montre w ch7al la livraison l Oran ?'], chat: [C('ch7al l montre w ch7al la livraison l Oran ?'), T('delivery_fee Oran → domicile 600 DA · bureau 400 DA'), D('Montre Atlas b 3 500 DA 😊 L Oran : 600 DA l dar wela 400 DA f l bureau, ya3ni 4 100 DA wela 3 900 DA. Wach yasselhek ?')], score: 9, good: ['Les deux réponses, avec les outils', 'Le total clair'], faults: ['Un peu long'], aim: 'Répondre aux deux (prix et frais avec les outils, le total), puis une seule question.' },
  { title: 'Couleur et délai à la fois', lesson: 1, turns: ['kayen argentée ? w wa9tach tousel ?'], chat: [C('kayen argentée ? w wa9tach tousel ?'), T('search_products « argentée » → en stock'), D('Ih kayna l’argentée 👍 L wa9t 3la 7sab l wilaya : men ayya wilaya nta ?')], score: 9, good: ['La couleur d’abord', 'Le délai sans rien promettre'], faults: [], aim: 'Répondre à la couleur, puis demander la wilaya pour le vrai délai, sans promettre de date.' },
  { title: 'Il ne veut pas donner son numéro', lesson: 3, turns: ['n7ab nkoumandi bessah ma n7abch na3ti numéro'], chat: [C('n7ab nkoumandi bessah ma n7abch na3ti numéro'), D('Bla numéro ma n9derch nsajjel la commande 🙏 3tini numéro stp.')], score: 5, good: ['Poli'], faults: ['Insiste sans expliquer à quoi sert le numéro', 'Rien pour le rassurer'], idea: 'Expliquer que le numéro sert seulement au livreur et à l’appel de confirmation, sans insister.', aim: 'Expliquer simplement à quoi sert le numéro (le livreur, l’appel de confirmation), rassurer, sans insister.' },
  { title: 'Le prix demandé en français', lesson: 2, turns: ['Bonjour, quel est le prix de la montre ?'], chat: [C('Bonjour, quel est le prix de la montre ?'), D('Bonjour 😊 La Montre Atlas est à 3 500 DA, payable à la livraison. Vous la préférez noire ou argentée ?')], score: 10, good: ['En français, comme le client', 'Prix, avantage, une question'], faults: [], aim: 'En français : le prix exact, le paiement à la livraison, une seule question.' },
  { title: 'Deux questions en arabe', lesson: 1, turns: ['بشحال الساعة؟ وكاين التوصيل لوهران؟'], chat: [C('بشحال الساعة؟ وكاين التوصيل لوهران؟'), T('delivery_fee Oran → domicile 600 DA · bureau 400 DA'), D('الساعة بـ 3 500 دج 😊 التوصيل لوهران: 600 دج للمنزل أو 400 دج للمكتب. تحب المنزل ولا المكتب؟')], score: 9, good: ['En lettres arabes', 'Les deux réponses, une question'], faults: [], aim: 'En lettres arabes : le prix et les frais avec les outils, puis une seule question.' },
  { title: 'Méfiant : « pourquoi mon numéro ? »', lesson: 3, turns: ['3lach t7ab numéro ta3i ? bach tbi3ouh ?'], chat: [C('3lach t7ab numéro ta3i ? bach tbi3ouh ?'), D('Lala khouya 😊 3tini numéro w smiytek.')], score: 4, good: [], faults: ['N’explique pas à quoi sert le numéro', 'Demande deux informations à la fois'], idea: 'Dire simplement que le numéro sert au livreur et à l’appel de confirmation, puis demander une seule information.', aim: 'Rassurer : le numéro sert seulement au livreur et à l’appel de confirmation ; une seule question.' },
  { title: 'Le prix pour deux montres', lesson: 2, turns: ['ch7al ida nchri jouj ?'], chat: [C('ch7al ida nchri jouj ?'), D('Jouj Montre Atlas : 2 × 3 500 DA = 7 000 DA 😊 Noire w argentée, wela zouj kif kif ?')], score: 9, good: ['Le calcul juste, sans remise inventée'], faults: [], aim: 'Deux fois le prix exact, sans remise inventée, puis une seule question.' },
  { title: 'Trois questions d’un coup', lesson: 1, turns: ['ch7al ? kayen garantie ? w tlivriw l Tlemcen ?'], chat: [C('ch7al ? kayen garantie ? w tlivriw l Tlemcen ?'), T('delivery_fee Tlemcen → domicile 650 DA · bureau 450 DA'), D('Montre Atlas b 3 500 DA 😊 L garantie, ma 3andich l ma3louma : wa7ed men l’équipe y3ayetlek. L Tlemcen : 650 DA l dar, 450 DA f l bureau. Wach t7ab ?')], score: 8, good: ['Les trois réponses, rien d’inventé'], faults: ['Un peu long'], aim: 'Répondre brièvement aux trois (prix, garantie sans rien inventer, frais), puis une seule question.' },
  { title: 'Le numéro de sa sœur', lesson: 3, turns: ['n9der na3tik numéro ta3 khti ? hiya li testa9bel'], chat: [C('n9der na3tik numéro ta3 khti ? hiya li testa9bel'), D('Ih normal 👍 3tini smiytha w numéro ta3ha, w l wilaya.')], score: 7, good: ['Accepte tout de suite'], faults: ['Demande trois informations à la fois'], idea: 'Accepter, puis demander une seule information à la fois.', aim: 'Accepter la personne qui reçoit, puis une seule information à la fois.' },
];
const CASES_B: CaseRow[] = [
  { title: 'Le prix avec des fautes', lesson: 2, turns: ['chhal la monter atlas'], chat: [C('chhal la monter atlas'), D('Montre Atlas b 3 500 DA 😊 Noire wela argentée ?')], score: 10, good: ['A compris malgré les fautes'], faults: [], aim: 'Comprendre, donner le prix exact, une seule question.' },
  { title: 'Prix et paiement à la livraison', lesson: 1, turns: ['ch7al w nkhalas ki tousel ?'], chat: [C('ch7al w nkhalas ki tousel ?'), D('Montre Atlas b 3 500 DA, w ih tkhalass ghir ki tesselmha 👍 Men ayya wilaya ?')], score: 10, good: ['Les deux réponses, une question'], faults: [], aim: 'Le prix et le paiement à la livraison, puis une seule question.' },
  { title: 'Un numéro étranger', lesson: 3, turns: ['3andi numéro français, ynfa3 ?'], chat: [C('3andi numéro français, ynfa3 ?'), D('Lazem numéro dzayri bach y3ayetlek l livreur 🙏 3andek numéro hna ?')], score: 9, good: ['Explique pourquoi'], faults: [], aim: 'Expliquer que le livreur appelle un numéro algérien, sans brusquer.' },
  { title: 'Couleur et quantité', lesson: 1, turns: ['kayen noire ? w kayna bezzaf ?'], chat: [C('kayen noire ? w kayna bezzaf ?'), T('search_products « noire » → en stock'), D('Ih kayna noire 👍 Ch7al men wa7da t7ab ?')], score: 8, good: ['Rien d’inventé sur le stock'], faults: ['N’a pas répondu à « bezzaf »'], aim: 'La couleur, puis rien d’inventé sur le stock, une seule question.' },
  { title: 'Le prix en centimes', lesson: 2, turns: ['rahi b 35 alf ?'], chat: [C('rahi b 35 alf ?'), D('Ih, 35 alf ya3ni 3 500 DA 👍 Men ayya wilaya ?')], score: 10, good: ['Les centimes compris'], faults: [], aim: 'Confirmer en DA que 35 alf est le prix, une seule question.' },
  { title: '« Je vous l’ai donné hier »', lesson: 3, turns: ['a3titek numéro lbare7'], chat: [C('a3titek numéro lbare7'), D('Smahli, 3awed ktebli numéro stp.')], score: 6, good: ['Poli'], faults: ['Ne dit pas pourquoi il le redemande'], idea: 'Dire poliment qu’il ne voit pas l’ancienne conversation, puis redemander le numéro une seule fois.', aim: 'Expliquer pourquoi il le redemande, poliment, une seule fois.' },
  { title: 'Prix, livraison et délai', lesson: 1, turns: ['ch7al l montre, l livraison l Blida w wa9tach ?'], chat: [C('ch7al l montre, l livraison l Blida w wa9tach ?'), T('delivery_fee Blida → domicile 500 DA · bureau 350 DA'), D('Montre Atlas b 3 500 DA. L Blida : 500 DA l dar wela 350 DA f l bureau. L wa9t 3la 7sab l livreur 🙏 Dar wela bureau ?')], score: 9, good: ['Les trois réponses, rien promis'], faults: [], aim: 'Les trois réponses brèves avec les outils, aucun délai promis, une seule question.' },
  { title: 'Le prix demandé en anglais', lesson: 2, turns: ['how much is the watch?'], chat: [C('how much is the watch?'), D('The Atlas watch is 3,500 DA, paid on delivery 😊 Black or silver?')], score: 10, good: ['En anglais, comme le client'], faults: [], aim: 'En anglais : le prix exact, le paiement à la livraison, une seule question.' },
  { title: 'Un chiffre en moins', lesson: 3, turns: ['0661 23 45 1'], chat: [C('0661 23 45 1'), D('Numéro fih 9 ar9am berk 🙏 3awed ktebli l 10 ar9am stp.')], score: 10, good: ['A vu le chiffre manquant'], faults: [], aim: 'Voir qu’il manque un chiffre et le redemander gentiment.' },
  { title: 'Deux produits demandés', lesson: 1, turns: ['ch7al l montre w l bracelet ?'], chat: [C('ch7al l montre w l bracelet ?'), T('search_products « bracelet » → rien'), D('Montre Atlas b 3 500 DA, w l bracelet ma l9itouch 🙏 Wach t9sod b l bracelet ?')], score: 8, good: ['Rien d’inventé'], faults: ['Pourrait proposer la montre seule'], aim: 'Le prix de la montre, honnête pour le bracelet, une seule question.' },
];
type DemoCases = { id: number; round: number; at: number; cases: CaseRow[]; items: Record<string, { verdict: 'pass' | 'fail' | null; note: string | null; draft: { topic: string; text: string; meaning: string } | null; kept: number | null; tries: number; chat?: { role: string; body: string }[]; score?: number }> };
const caseTests = new Map<number, DemoCases>();
/** this morning's test (id 21): six passed (one after « Refaire »), two not yet, two to decide */
function caseTest21(): DemoCases {
  const kept = { topic: 'closing', text: 'When the customer asks about a colour and the delivery time together, answer the colour first, then ask the wilaya to give the real delay.', meaning: 'Couleur et délai dans le même message : répondre d’abord à la couleur, puis demander la wilaya pour donner le vrai délai.' };
  const v = (verdict: 'pass' | 'fail' | null) => ({ verdict, note: null, draft: null, kept: null, tries: 1 });
  return {
    id: 21,
    round: 1,
    at: Date.parse(`${today()}T08:30:00Z`),
    cases: CASES_A,
    items: { r1c1: v('pass'), r1c2: v('pass'), r1c3: { verdict: 'pass', note: 'Répondre d’abord à la couleur, puis demander la wilaya pour le délai.', draft: kept, kept: 901, tries: 2 }, r1c4: v('fail'), r1c5: v('pass'), r1c6: v('pass'), r1c7: v('fail'), r1c8: v('pass'), r1c9: v(null), r1c10: v(null) },
  };
}
function caseTestNew(round: number, cases: CaseRow[]) {
  const id = Math.max(30, ...caseTests.keys()) + 1;
  caseTests.set(id, { id, round, at: Date.now(), cases, items: {} });
  return id;
}
function caseTestView(id: number) {
  if (id === 21 && !caseTests.has(21)) caseTests.set(21, caseTest21());
  const t = caseTests.get(id) ?? caseTests.get(21) ?? caseTest21();
  const live = t.id !== 21;
  // a new test: Pilot AI writes for 2 s, then a case every 1,2 s
  const since = Date.now() - t.at;
  const done = live ? Math.max(0, Math.min(t.cases.length, Math.floor((since - 2000) / 1200))) : t.cases.length;
  const status = live && since < 2000 ? 'writing' : done < t.cases.length ? 'running' : 'done';
  const prefix = `r${t.round}c`;
  const cases = status === 'writing' ? [] : t.cases.map((c, k) => ({ id: `${prefix}${k + 1}`, title: c.title, turns: c.turns, aim: c.aim, lesson: c.lesson }));
  const items = cases.slice(0, done).map((c, k) => {
    const row = t.cases[k];
    const st = t.items[c.id] ?? { verdict: null, note: null, draft: null, kept: null, tries: 1 };
    const score = st.score ?? row.score;
    const missed = score < 8;
    return {
      id: c.id,
      transcript: st.chat ?? row.chat,
      score,
      good: st.chat ? ['Applique la leçon de ce cas'] : row.good,
      faults: st.chat ? [] : row.faults,
      lesson: null,
      meaning: missed ? row.idea ?? null : null,
      topic: 'closing',
      lessonOk: false,
      hint: !missed,
      verdict: st.verdict,
      note: st.note,
      draft: st.draft,
      kept: st.kept,
      keptError: null,
      tries: st.tries,
    };
  });
  const at = new Date(t.at).toISOString();
  return {
    id: t.id,
    shopId: 1,
    shopName: 'Boutique Alaeddine',
    version: 4,
    round: t.round,
    status: status as 'writing' | 'running' | 'done' | 'failed',
    error: null,
    lessons: CASE_LESSONS.filter((l) => l.fresh).map(({ id: lid, topic, text, meaning }) => ({ id: lid, topic, text, meaning })),
    cases,
    items,
    done,
    total: t.cases.length,
    passed: items.filter((i) => i.verdict === 'pass').length,
    missed: items.filter((i) => i.verdict === 'fail').length,
    kept: items.filter((i) => i.kept).length,
    by: 'Alaeddine',
    at,
    finishedAt: status === 'done' ? new Date(t.at + (live ? 2000 + t.cases.length * 1200 : 180_000)).toISOString() : null,
  };
}
function caseTestVerdict(id: number, caseId: string, pass: boolean) {
  caseTestView(id);
  const t = caseTests.get(id) ?? caseTests.get(21)!;
  const st = t.items[caseId] ?? { verdict: null, note: null, draft: null, kept: null, tries: 1 };
  t.items[caseId] = { ...st, verdict: pass ? 'pass' : 'fail', kept: pass && st.draft ? st.kept ?? 900 + Object.keys(t.items).length : pass ? st.kept : null };
  return caseTestView(t.id);
}
/** « Refaire » in the example: Dellal answers the case again with the coach's lesson, and does it right */
function caseTestRedo(id: number, caseId: string, note: string) {
  caseTestView(id);
  const t = caseTests.get(id) ?? caseTests.get(21)!;
  const k = Number(caseId.split('c').pop()) - 1;
  const row = t.cases[k];
  const st = t.items[caseId] ?? { verdict: null, note: null, draft: null, kept: null, tries: 1 };
  const better = row.lesson === 3 ? 'Normal 🙏 L numéro ykhdem ghir l livreur w l conseiller li y3ayetlek bach ykonfirmi, ma nbi3ouh l 7ad. 3tini smiytek l’awel ?' : 'Ih 👍 Nkamlou b wa7da wa7da : smiytek l’awel ?';
  t.items[caseId] = {
    ...st,
    verdict: null,
    note,
    draft: { topic: row.lesson === 3 ? 'trust' : 'closing', text: row.lesson === 3 ? 'When the customer asks why you need their number, say it is only for the delivery man and the confirmation call, then ask one thing at a time.' : 'Ask for one piece of information at a time, even when the customer is in a hurry.', meaning: note },
    kept: null,
    tries: st.tries + 1,
    chat: [...row.chat.filter((m) => m.role === 'customer'), D(better)],
    score: 9,
  };
  return caseTestView(t.id);
}

/** « Lancer l'examen » in the example: the ten come one by one (one every 1,5 s), then the marks of that version */
let demoRun: { id: number; book: string; at: number } | null = null;
function examRun(id: number) {
  const run = demoRun!;
  const base = examDemo(run.book === 'live' ? 9 : 13);
  const at = new Date(run.at).toISOString();
  const done = Math.min(base.items.length, Math.floor((Date.now() - run.at) / 1500));
  if (done >= base.items.length) return { ...base, id, at, finishedAt: new Date(run.at + base.items.length * 1500).toISOString() };
  const items = base.items.slice(0, done);
  return { ...base, id, at, status: 'running', score: null, done, items, passed: items.filter((i) => i.pass).length, finishedAt: null };
}

/** the example answer of one control-room call (the Pilot AI page's reads) */
export function demoAnswer(name: string, input: any): unknown {
  switch (name) {
    // Pilotix's photo storage (Cloudflare R2): connected and tested, in the example
    case 'p.photos.store':
      return { configured: true, account: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', bucket: 'pilotix-photos', keyId: '3f9c2a71b0d84e6f9a1c5b7d2e4f6a8c', secretSet: true, lastTest: { at: new Date(Date.parse(`${today()}T08:00:00Z`)).toISOString(), ok: true, error: null } };
    case 'p.pilot.exam.get':
      return demoRun && Number(input?.id) === demoRun.id ? examRun(demoRun.id) : examDemo(Number(input?.id) || 13);
    case 'p.pilot.exam.start':
      demoRun = { id: (demoRun?.id ?? 90) + 1, book: input?.book === 'live' ? 'live' : 'trial', at: Date.now() };
      return { id: demoRun.id };
    case 'p.pilot.exam.list':
      return [examDemo(13), examDemo(9)];
    case 'p.pilot.cases.get':
      return caseTestView(Number(input?.id) || 21);
    case 'p.pilot.cases.start':
      return { id: caseTestNew(1, CASES_A) };
    case 'p.pilot.cases.more':
      return { id: caseTestNew((caseTests.get(Number(input?.id))?.round ?? 1) + 1, CASES_B) };
    case 'p.pilot.cases.verdict':
      return caseTestVerdict(Number(input?.id), String(input?.caseId), !!input?.pass);
    case 'p.pilot.cases.redo':
      return { test: caseTestRedo(Number(input?.id), String(input?.caseId), String(input?.note ?? '')), reply: null, problems: [] };
    // Pilotix's Meta and TikTok apps, not made yet (the preview shows what to do)
    case 'p.social.apps':
      return { meta: { appId: '', configId: '', igConfigId: '', waConfigId: '', hasSecret: false, hasIgSecret: false }, tiktok: { appId: '', hasSecret: false }, verifyToken: 'pilotix-verify-3f9c2a71', ready: { meta: false, tiktok: false }, urls: null, counts: { meta: 1, tiktok: 0, shops: 2 } };
    case 'p.pilot.try':
      return tryAnswer(input ?? {});
    case 'p.pilot.teach':
      return teachAnswer(input ?? { messages: [] });
    case 'p.pilot.addLesson':
      return { ok: true, id: ++added, topic: input?.topic, text: input?.text };
    case 'p.lahja.state':
      return lahjaState();
    case 'p.vocab.list':
      return vocabList(input ?? {});
    case 'p.vocab.try':
      return vocabTry(String(input?.text ?? ''));
    case 'p.darija.book':
      return darijaBook();
    case 'p.pilot.voice':
      return { enabled: true, model: 'gemini-flash-latest', hasKey: true, today: { calls: 14, usd: 0.0124 } };
    case 'p.darija.file':
      return darijaFile(input?.version);
    case 'p.lahja.add':
      return { ok: true, id: ++added, words: input?.words ?? wordsChanged(String(input?.before ?? ''), String(input?.after ?? '')) };
    case 'p.pilot.state':
      return state();
    case 'p.dellal.board':
      return dellal(input ?? {});
    case 'p.dellal.more':
      return more(input ?? {});
    case 'p.dellal.books':
      return books();
    case 'p.cm.board':
      return cm(input ?? {});
    case 'p.spy.board':
      return spy(input ?? {});
    // Pilotix's AI Spy key: ScrapeCreators saved and main, no backup yet (the keys themselves are never sent back)
    case 'p.spy.key':
      return { enabled: true, main: 'scrapecreators', perShopDay: 20, keys: { scrapecreators: true, searchapi: false }, today: { searches: 29, shops: 3 } };
    case 'p.spy.keyTest':
      return {
        ok: true,
        count: 214,
        sample: [
          { page: 'Bébé Confort DZ', text: 'Poussette 3 en 1 pliable, livraison 58 wilayas, paiement à la livraison' },
          { page: 'Kids Store Oran', text: 'عربة أطفال خفيفة 11900 دج فقط، التوصيل مجاني' },
          { page: 'Mama Shop', text: 'Poussette canne légère, 7 kg, garantie 6 mois' },
        ],
        message: '',
      };
    case 'p.ai.costs':
      return costs(input ?? {});
    case 'p.pilot.bookText':
      return { version: 2, updatedAt: new Date(Date.now() - 9 * DAY).toISOString(), testVersion: 3, lessons: 7, text: BOOK };
    case 'p.pilot.case': {
      const dj = DARIJA_CASES.find((x) => x.conv === input?.convId);
      if (dj) return { outcome: 'delivered', reason: null, takeover: false, transcript: dj.chat };
      return {
        outcome: 'delivered',
        reason: null,
        takeover: false,
        transcript: 'C: Salam, ch7al la montre ?\nD: Wa 3alikoum salam ! La montre Atlas b 3500 DA, w la livraison l Sétif 400 DA. T7eb nwerilek video ?\nC: Ih wach rak t9oul\nD: Hadi video ta3 client. Twesslek f 48 sa3a, w tkhalass ghir ki tchouf la montre.\nC: Ok n7eb nakhodha\nD: Mlih ! 3tini smiytek, l commune w l numéro.',
      };
    }
    default:
      return null;
  }
}
