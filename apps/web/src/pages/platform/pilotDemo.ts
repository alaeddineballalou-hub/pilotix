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
  const base: Record<number, number[]> = { 1: [18, 1020, 362, 141, 846, 12, 5, 21], 7: [10, 560, 190, 64, 455, 6, 3, 11], 12: [6, 240, 88, 35, 189, 3, 1, 5] };
  const keys = ['watched', 'ads', 'active', 'newAds', 'analysed', 'briefs', 'followed', 'alerts'] as const;
  const f = days / 30;
  const rows = SHOPS.filter((s) => !i.shopId || s.id === i.shopId).map((s) => {
    const r = { key: String(s.id), label: s.name } as { key: string; label: string } & Record<(typeof keys)[number], number>;
    keys.forEach((k, j) => (r[k] = k === 'newAds' || k === 'alerts' ? Math.round(base[s.id][j] * f ** 0.8) : base[s.id][j]));
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
        { id: 3, version: 3, status: 'testing', tokens: 610, lessons: 9, note: null, by: 'Sara', createdAt: at(3), promotedAt: null, endedAt: null },
        { id: 2, version: 2, status: 'champion', tokens: 540, lessons: 7, note: null, by: 'Sara', createdAt: at(18), promotedAt: at(9), endedAt: null },
        { id: 1, version: 1, status: 'retired', tokens: 320, lessons: 4, note: null, by: 'Alaeddine', createdAt: at(40), promotedAt: at(32), endedAt: at(9) },
      ],
      test: { id: 3, championId: 2, challengerId: 3, share: 0.2, verdict: 'wait', why: null, stats: {}, startedAt: at(3) },
    },
    // the next book: v4 (v3 is in test), a lesson found at night and one the coach wrote in « Teach a lesson »
    next: {
      version: 4,
      lessons: 11,
      dropped: 0,
      changed: true,
      fresh: [
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
const VERSIONS: Record<string, number> = { live: 2, test: 3, next: 4, none: 0 };
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

/** the example answer of one control-room call (the Pilot AI page's reads) */
export function demoAnswer(name: string, input: any): unknown {
  switch (name) {
    case 'p.pilot.try':
      return tryAnswer(input ?? {});
    case 'p.pilot.teach':
      return teachAnswer(input ?? { messages: [] });
    case 'p.pilot.addLesson':
      return { ok: true, id: ++added, topic: input?.topic, text: input?.text };
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
    case 'p.ai.costs':
      return costs(input ?? {});
    case 'p.pilot.bookText':
      return { version: 2, updatedAt: new Date(Date.now() - 9 * DAY).toISOString(), testVersion: 3, lessons: 7, text: BOOK };
    case 'p.pilot.case':
      return {
        outcome: 'delivered',
        reason: null,
        takeover: false,
        transcript: 'C: Salam, ch7al la montre ?\nD: Wa 3alikoum salam ! La montre Atlas b 3500 DA, w la livraison l Sétif 400 DA. T7eb nwerilek video ?\nC: Ih wach rak t9oul\nD: Hadi video ta3 client. Twesslek f 48 sa3a, w tkhalass ghir ki tchouf la montre.\nC: Ok n7eb nakhodha\nD: Mlih ! 3tini smiytek, l commune w l numéro.',
      };
    default:
      return null;
  }
}
