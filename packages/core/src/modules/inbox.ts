// The bell (owner's ask, 22 Nov 2026): « a notification for every one, about each order », at the top of every page, as
// a pop-up with its own sound while Pilotix is open, and on the phone even when it is closed.
// - an agent: a new order given to them (the auto split, a rotation, a manager), the time of a callback they set, their
//   order delivered (the cash sound), back or cancelled after they confirmed it, an order taken from them;
// - Suivi: an alert or a failed delivery on a parcel they follow, a parcel on alert given to them;
// - Dépôt: the orders to prepare, grouped (one line every 15 minutes at most, while the team works);
// - the customer's WhatsApp / Messenger / Instagram message: to the agent who has their order now;
// - managers and the owner: every phone notification they already got goes in their bell too (push.ts › sendPush).
// The person who did the thing is never told of it. The phones ring in the shop's call hours (Réglages › Appels), except a
// callback, whose time the agent chose; outside them the line waits in the bell, without a sound.
// Management › Notifications (owner's ask, 22 Nov 2026) sets each kind: on or off, who gets it — the order's own person
// in their words, the others (the manager, the owners, the depot, chosen people) in the third person, one line per kind
// that grows while it is not read — and when the phones ring (notifyRules). The sounds stay Pilotix's own.
import { algiersDayStart, CONF_TODO, Language, slotAt } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { Ctx, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { BellKind, ringBell } from './bell';
import { runAgencyKpis, tellAgencyAssignments, tellAgencyOrderStatus } from './agencybell';
import { pushOnly } from './push';

// ---------------------------------------------------------------- the words (the person's language)
type Words = Record<Language, string>;
const W = {
  order1: { fr: 'Nouvelle commande pour vous', en: 'New order for you', ar: 'طلب جديد لك' },
  orderN: { fr: '{n} nouvelles commandes pour vous', en: '{n} new orders for you', ar: 'طلبات جديدة لك: {n}' },
  rotation: { fr: 'Rotation', en: 'Rotation', ar: 'تدوير' },
  fromManager: { fr: 'Donnée par {who}', en: 'Given by {who}', ar: 'أسندها {who}' },
  callback: { fr: '📞 Rappeler {name} maintenant', en: '📞 Call {name} back now', ar: '📞 أعد الاتصال بـ{name} الآن' },
  callbackAt: { fr: '{ref} · rappel prévu à {time}', en: '{ref} · callback set for {time}', ar: '{ref} · موعد الاتصال {time}' },
  delivered1: { fr: '💰 {ref} livrée', en: '💰 {ref} delivered', ar: '💰 تم توصيل {ref}' },
  deliveredN: { fr: '💰 {n} commandes livrées', en: '💰 {n} orders delivered', ar: '💰 طلبات تم توصيلها: {n}' },
  returned1: { fr: '↩️ {ref} en retour', en: '↩️ {ref} is coming back', ar: '↩️ {ref} في طريق الإرجاع' },
  returnedN: { fr: '↩️ {n} commandes en retour', en: '↩️ {n} orders coming back', ar: '↩️ طلبات في طريق الإرجاع: {n}' },
  cancelled1: { fr: '❌ {ref} annulée', en: '❌ {ref} cancelled', ar: '❌ تم إلغاء {ref}' },
  cancelledN: { fr: '❌ {n} commandes annulées', en: '❌ {n} orders cancelled', ar: '❌ طلبات ملغاة: {n}' },
  afterYou: { fr: 'après votre confirmation', en: 'after your confirmation', ar: 'بعد تأكيدك' },
  taken1: { fr: '{ref} n’est plus à vous', en: '{ref} is no longer yours', ar: '{ref} لم يعد لك' },
  takenN: { fr: '{n} commandes ne sont plus à vous', en: '{n} orders are no longer yours', ar: 'طلبات لم تعد لك: {n}' },
  givenTo: { fr: 'Donnée à {who}', en: 'Given to {who}', ar: 'أُسندت إلى {who}' },
  late: { fr: 'Pas traitée à temps : donnée à {who}', en: 'Not handled in time: given to {who}', ar: 'لم تُعالَج في الوقت: أُسندت إلى {who}' },
  alert1: { fr: '⚠️ Alerte sur {ref}', en: '⚠️ Alert on {ref}', ar: '⚠️ تنبيه على {ref}' },
  alertN: { fr: '⚠️ {n} colis à traiter', en: '⚠️ {n} parcels to handle', ar: '⚠️ طرود للمعالجة: {n}' },
  failed: { fr: 'Échec de livraison', en: 'Delivery failed', ar: 'فشل التوصيل' },
  onAlert: { fr: 'Alerte du livreur', en: 'Courier alert', ar: 'تنبيه من عامل التوصيل' },
  given: { fr: 'Colis en alerte pour vous', en: 'A parcel on alert for you', ar: 'طرد في حالة تنبيه لك' },
  depot1: { fr: '📦 Une nouvelle commande à préparer', en: '📦 A new order to prepare', ar: '📦 طلب جديد للتحضير' },
  depotN: { fr: '📦 {n} nouvelles commandes à préparer', en: '📦 {n} new orders to prepare', ar: '📦 طلبات جديدة للتحضير: {n}' },
  depotAll: { fr: '{total} à préparer en tout', en: '{total} to prepare in all', ar: 'المجموع للتحضير: {total}' },
  messages: { fr: '{n} messages', en: '{n} messages', ar: 'رسائل: {n}' },
  // the others' lines (a manager, the owners, the depot, chosen people): about someone else's order
  teamOrder1: { fr: 'Nouvelle commande', en: 'New order', ar: 'طلب جديد' },
  teamOrderN: { fr: '{n} nouvelles commandes', en: '{n} new orders', ar: 'طلبات جديدة: {n}' },
  forWho: { fr: 'pour {who}', en: 'for {who}', ar: 'لـ{who}' },
  teamCallback: { fr: '📞 {who} doit rappeler {name}', en: '📞 {who} has to call {name} back', ar: '📞 على {who} أن يعيد الاتصال بـ{name}' },
  teamTaken1: { fr: '{ref} n’est plus à {who}', en: '{ref} is no longer {who}’s', ar: '{ref} لم يعد لـ{who}' },
  teamTakenN: { fr: '{n} commandes ont changé d’agent', en: '{n} orders changed agent', ar: 'طلبات غيّرت وكيلها: {n}' },
} satisfies Record<string, Words>;

/** A sentence of W in this language, its {words} filled. */
export function say(key: keyof typeof W, lang: Language, v: Record<string, string | number> = {}): string {
  return (W[key][lang] ?? W[key].fr).replace(/\{(\w+)\}/g, (_, k: string) => (v[k] === undefined ? '' : String(v[k])));
}
/** 4500 → « 4 500 » */
const money = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** 4500 → « 4 500 DA » (« 4 500 د.ج » in Arabic) */
const da = (n: number, lang: Language) => `${money(n)} ${lang === 'ar' ? 'د.ج' : 'DA'}`;
/** HH:MM, Algiers time */
const clock = (t: number) => new Date(t + 3_600_000).toISOString().slice(11, 16);

interface Bits {
  id: number;
  ref: string;
  name: string;
  total: number;
  agent: number | null;
  follow: number | null;
}
/** What a line says of each order: its ref, the customer, the amount, who has it. */
async function orderBits(db: Db, ids: number[]): Promise<Map<number, Bits>> {
  if (!ids.length) return new Map();
  const rows = await db.query('SELECT id, ref, customer_name, total, agent_id, follow_agent_id FROM orders WHERE id = ANY($1)', [[...new Set(ids)]]);
  return new Map(rows.map((r: any) => [num(r.id), { id: num(r.id), ref: String(r.ref), name: String(r.customer_name ?? '').trim(), total: num(r.total), agent: numOrNull(r.agent_id), follow: numOrNull(r.follow_agent_id) }]));
}
const oneLine = (o: Bits, lang: Language) => [o.ref, o.name, o.total > 0 ? da(o.total, lang) : ''].filter(Boolean).join(' · ');
const refList = (list: Bits[]) => list.slice(0, 4).map((o) => o.ref).join(', ') + (list.length > 4 ? ` +${list.length - 4}` : '');
async function namesOf(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.query('SELECT id, name FROM profiles WHERE id = ANY($1)', [[...new Set(ids)]]);
  return new Map(rows.map((r: any) => [num(r.id), String(r.name ?? '').trim()]));
}

// ---------------------------------------------------------------- Management › Notifications: who gets what
/** The kinds the bell writes itself (« info »: the other pages' own notifications — paie, rapport du soir… — set there). */
export const NOTIFY_KINDS = ['order', 'callback', 'delivered', 'returned', 'cancelled', 'taken', 'alert', 'depot', 'message'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
/** A rule's people: the order's agent, its Suivi agent, the team manager of the person it is about, the owners (the
 *  administrators), the depot team. */
export const NOTIFY_WHO = ['agent', 'suivi', 'manager', 'owner', 'depot'] as const;
export type NotifyWho = (typeof NOTIFY_WHO)[number];
export const NOTIFY_PHONE = ['work', 'always', 'never'] as const;
export interface NotifyRule {
  on: boolean;
  who: NotifyWho[];
  /** chosen people, told whatever their role */
  people: number[];
  /** the phones: in the shop's call hours, always, never */
  phone: (typeof NOTIFY_PHONE)[number];
}
/** Who each kind can go to (the page offers these). */
export const NOTIFY_CAN: Record<NotifyKind, readonly NotifyWho[]> = {
  order: ['agent', 'manager', 'owner'],
  callback: ['agent', 'manager', 'owner'],
  delivered: ['agent', 'suivi', 'manager', 'owner', 'depot'],
  returned: ['agent', 'suivi', 'manager', 'owner', 'depot'],
  cancelled: ['agent', 'suivi', 'manager', 'owner', 'depot'],
  taken: ['agent', 'manager', 'owner'],
  alert: ['suivi', 'agent', 'manager', 'owner'],
  depot: ['depot', 'owner'],
  // the agent while the order is being confirmed, the Suivi agent once it is on the road
  message: ['agent', 'suivi', 'manager', 'owner'],
};
/** Before the page, as it was — and the owner's ask: a new order goes to the agent's manager and the owners too. */
export const DEFAULT_NOTIFY: Record<NotifyKind, NotifyRule> = {
  order: { on: true, who: ['agent', 'manager', 'owner'], people: [], phone: 'work' },
  callback: { on: true, who: ['agent'], people: [], phone: 'always' },
  delivered: { on: true, who: ['agent'], people: [], phone: 'work' },
  returned: { on: true, who: ['agent'], people: [], phone: 'work' },
  cancelled: { on: true, who: ['agent'], people: [], phone: 'work' },
  taken: { on: true, who: ['agent'], people: [], phone: 'work' },
  alert: { on: true, who: ['suivi'], people: [], phone: 'work' },
  depot: { on: true, who: ['depot'], people: [], phone: 'work' },
  message: { on: true, who: ['agent', 'suivi'], people: [], phone: 'work' },
};

/** A kind's rule from what was saved: each part checked, the rest its default. */
export function cleanRule(kind: NotifyKind, v: unknown): NotifyRule {
  const d = DEFAULT_NOTIFY[kind];
  const s = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof NotifyRule, unknown>>;
  const who = Array.isArray(s.who) ? s.who : null;
  return {
    on: typeof s.on === 'boolean' ? s.on : d.on,
    who: who ? NOTIFY_CAN[kind].filter((w) => who.includes(w)) : [...d.who],
    people: Array.isArray(s.people) ? [...new Set(s.people.filter((x): x is number => Number.isSafeInteger(x) && (x as number) > 0))].slice(0, 50) : [...d.people],
    phone: (NOTIFY_PHONE as readonly unknown[]).includes(s.phone) ? (s.phone as NotifyRule['phone']) : d.phone,
  };
}

/** Every kind's rule (Management › Notifications), each one checked over its default. */
export async function notifyRules(db: Db): Promise<Record<NotifyKind, NotifyRule>> {
  const saved = (await getSetting(db, 'notify')) ?? {};
  return Object.fromEntries(NOTIFY_KINDS.map((k) => [k, cleanRule(k, saved[k])])) as Record<NotifyKind, NotifyRule>;
}

/** The people around the orders, read once for one telling: the owners, the depot team, the teams' managers. */
function around(ctx: Ctx) {
  let owners: Promise<number[]> | null = null;
  let depot: Promise<number[]> | null = null;
  let teams: Promise<{ managerId: number | null; agentIds: number[] }[]> | null = null;
  const ids = (rows: any[]) => rows.map((x) => num(x.id));
  return {
    owners: () => (owners ??= ctx.db.query(`SELECT id FROM profiles WHERE active AND 'admin' = ANY(roles) AND agency_id IS NULL`).then(ids)),
    depot: () => (depot ??= ctx.db.query(`SELECT id FROM profiles WHERE active AND 'depot' = ANY(roles) AND NOT ('admin' = ANY(roles)) AND agency_id IS NULL`).then(ids)),
    /** the manager of each team this person is in (Management › Équipes) */
    managersOf: async (who: readonly number[]) => {
      const list = await (teams ??= getSetting(ctx.db, 'teams').then((t) => (Array.isArray(t) ? t : [])));
      return list.filter((t) => t.managerId && who.some((p) => t.agentIds?.includes(p))).map((t) => t.managerId as number);
    },
  };
}
type Around = ReturnType<typeof around>;

/**
 * The people a rule tells beside the one a thing is about (`self`, told in their own words when their role `selfRole`
 * is ticked): the order's other person ticked (`agents`, `suivis`), the team manager of `self`, the owners, the depot,
 * the chosen people. `self` is left out when they get their own line.
 */
async function othersOf(a: Around, rule: NotifyRule, o: { self: readonly number[]; selfRole: NotifyWho | null; agents?: readonly (number | null)[]; suivis?: readonly (number | null)[] }): Promise<number[]> {
  if (!rule.on) return [];
  const has = (w: NotifyWho) => rule.who.includes(w);
  const ids: number[] = [...rule.people];
  if (has('agent') && o.selfRole !== 'agent') ids.push(...(o.agents ?? []).filter((x): x is number => !!x));
  if (has('suivi') && o.selfRole !== 'suivi') ids.push(...(o.suivis ?? []).filter((x): x is number => !!x));
  if (has('manager')) ids.push(...(await a.managersOf(o.self)));
  if (has('owner')) ids.push(...(await a.owners()));
  if (has('depot')) ids.push(...(await a.depot()));
  const selfTold = !!o.selfRole && has(o.selfRole);
  return [...new Set(ids)].filter((x) => !(selfTold && o.self.includes(x)));
}
/** Does the person a thing is about get their own line? */
const selfOn = (rule: NotifyRule, role: NotifyWho) => rule.on && rule.who.includes(role);

// ---------------------------------------------------------------- telling
/** Loud, and kept on screen until seen. */
const IMPORTANT = new Set<BellKind>(['order', 'callback', 'alert']);

export interface Tell {
  kind: BellKind;
  /** the line, in the person's language; `n`: how many things it says (with the unread line of the same tag it replaces) */
  text: (lang: Language, n: number) => { title: string; body: string };
  /** how many things this time (several orders at once: one line « 3 nouvelles commandes ») */
  count?: number;
  url?: string | null;
  orderId?: number | null;
  /** replaces the person's unread line with the same tag */
  tag?: string | null;
  important?: boolean;
  /** the phones: in the shop's call hours (default), always (a callback: the agent chose its time), never */
  phone?: 'work' | 'always' | 'never';
  /** who did it: never told of their own work (null: Pilotix itself) */
  by?: number | null;
  /** in the bell only: no pop-up, no sound, no phone (something else rings it already) */
  silent?: boolean;
  /** a line that grows (its tag) about several orders opens its page, not one order */
  listWhenMany?: boolean;
}

/** In the shop's call hours now (Réglages › Appels): the team is at work. */
async function workNow(ctx: Ctx): Promise<boolean> {
  return slotAt(ctx.now(), await getSetting(ctx.db, 'calls')).open;
}

/** Writes the line in each person's bell, then rings their phones. Never fails the work that tells: returns who was told. */
export async function tell(ctx: Ctx, to: readonly (number | null | undefined)[], t: Tell): Promise<number[]> {
  try {
    const people = [...new Set(to.filter((x): x is number => typeof x === 'number' && x > 0 && x !== t.by))];
    if (!people.length) return [];
    const important = t.important ?? IMPORTANT.has(t.kind);
    const rung = await ringBell(ctx, people, (lang, n) => ({ kind: t.kind, ...t.text(lang, n), url: t.url ?? null, orderId: t.listWhenMany && n > 1 ? null : t.orderId ?? null, important }), { tag: t.tag, count: t.count, silent: t.silent });
    const phone = t.silent ? 'never' : t.phone ?? 'work';
    const fresh = rung.filter((r) => !r.quiet);
    if (fresh.length && phone !== 'never' && ctx.server?.push && (phone === 'always' || (await workNow(ctx))))
      for (const r of fresh)
        await pushOnly(ctx, [r.id], { title: r.line.title, body: r.line.body, tag: t.tag ?? `${t.kind}-${r.id}-${ctx.now()}`, url: t.url ?? '#/accueil', alarm: important, kind: t.kind, order: t.orderId ?? null }).catch(() => 0);
    return rung.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Orders given to agents (Confirmation) or parcels on alert given to Suivi: one line per person, all their orders in it. */
export async function tellGiven(ctx: Ctx, area: 'conf' | 'follow', given: Map<number, number[]>, o: { by?: number | null; rotation?: boolean } = {}) {
  await tellAgencyAssignments(ctx, area, given, o.by).catch(() => {});
  const kind: NotifyKind = area === 'conf' ? 'order' : 'alert';
  const rule = (await notifyRules(ctx.db))[kind];
  if (!rule.on) return;
  const selfRole: NotifyWho = area === 'conf' ? 'agent' : 'suivi';
  const a = around(ctx);
  const bits = await orderBits(ctx.db, [...given.values()].flat());
  const names = await namesOf(ctx.db, [...given.keys(), ...(o.by ? [o.by] : [])]);
  const by = o.by ? names.get(o.by) ?? '' : '';
  // Confirmation › « Bloquer jusqu'à l'appel » on: the new order already covers a plain agent's screen and rings
  // (confblock.ts): his line stays quiet in the bell
  const blocked = area === 'conf' ? await blockedAgents(ctx, [...given.keys()]) : new Set<number>();
  const url = area === 'conf' ? '#/confirmation/nouvelles' : '#/suivi/alertes';
  for (const [agent, ids] of given) {
    const list = ids.map((i) => bits.get(i)).filter((x): x is Bits => !!x);
    if (!list.length) continue;
    const one = list.length === 1 ? list[0] : null;
    const why = (lang: Language) => (o.rotation ? `${say('rotation', lang)} · ` : by ? `${say('fromManager', lang, { who: by })} · ` : '');
    if (selfOn(rule, selfRole))
      await tell(ctx, [agent], {
        kind,
        silent: blocked.has(agent),
        count: list.length,
        orderId: one?.id ?? null,
        url,
        by: o.by ?? null,
        phone: rule.phone,
        text: (lang, n) =>
          area === 'conf'
            ? { title: n === 1 ? say('order1', lang) : say('orderN', lang, { n }), body: why(lang) + (one ? oneLine(one, lang) : refList(list)) }
            : { title: n === 1 ? say('given', lang) : say('alertN', lang, { n }), body: why(lang) + (one ? oneLine(one, lang) : refList(list)) },
      });
    // the others ticked (the manager, the owners…): one line that grows, « 5 nouvelles commandes », the last ones in it
    const others = await othersOf(a, rule, { self: [agent], selfRole, agents: list.map((x) => x.agent), suivis: list.map((x) => x.follow) });
    const who = names.get(agent) ?? '';
    await tell(ctx, others, {
      kind,
      tag: `team-${kind}`,
      count: list.length,
      orderId: one?.id ?? null,
      listWhenMany: true,
      url,
      by: o.by ?? null,
      phone: rule.phone,
      important: false,
      text: (lang, n) => ({
        title: area === 'conf' ? (n === 1 ? say('teamOrder1', lang) : say('teamOrderN', lang, { n })) : n === 1 && one ? say('alert1', lang, { ref: one.ref }) : say('alertN', lang, { n }),
        body: [one ? oneLine(one, lang) : refList(list), who ? say('forWho', lang, { who }) : ''].filter(Boolean).join(' · '),
      }),
    });
  }
}

/** The store's plain confirmation agents among these, when « Bloquer jusqu'à l'appel » is on (confblock.ts › plainAgent). */
async function blockedAgents(ctx: Ctx, ids: number[]): Promise<Set<number>> {
  if (!ids.length || !(await getSetting(ctx.db, 'confBlock')).on) return new Set();
  const rows = await ctx.db.query(
    `SELECT id FROM profiles WHERE id = ANY($1) AND 'confirmation' = ANY(roles) AND agency_id IS NULL
        AND NOT ('admin' = ANY(roles) OR 'agent_manager' = ANY(roles) OR 'vendeur' = ANY(roles))`,
    [ids],
  );
  return new Set(rows.map((r: any) => num(r.id)));
}

/** Orders taken from their agent (a rotation, a manager): one line per person. `to`: who has each order now. */
export async function tellTaken(ctx: Ctx, taken: Map<number, { id: number; to: number | null }[]>, o: { by?: number | null; rotation?: boolean; area?: 'conf' | 'follow' } = {}) {
  const rule = (await notifyRules(ctx.db)).taken;
  if (!rule.on) return;
  const a = around(ctx);
  const all = [...taken.values()].flat();
  const bits = await orderBits(ctx.db, all.map((x) => x.id));
  const names = await namesOf(ctx.db, [...all.map((x) => x.to).filter((x): x is number => !!x), ...taken.keys()]);
  const url = o.area === 'follow' ? '#/suivi/alertes' : '#/confirmation/nouvelles';
  for (const [agent, list0] of taken) {
    const list = list0.filter((x) => bits.has(x.id));
    if (!list.length) continue;
    const one = list.length === 1 ? list[0] : null;
    const who = one?.to ? names.get(one.to) ?? '' : '';
    const body = (lang: Language) => (one ? (who ? say(o.rotation ? 'late' : 'givenTo', lang, { who }) : bits.get(one.id)!.name) : refList(list.map((x) => bits.get(x.id)!)));
    if (selfOn(rule, 'agent'))
      await tell(ctx, [agent], {
        kind: 'taken',
        count: list.length,
        url,
        by: o.by ?? null,
        phone: rule.phone,
        text: (lang, n) => ({ title: n === 1 && one ? say('taken1', lang, { ref: bits.get(one.id)!.ref }) : say('takenN', lang, { n }), body: body(lang) }),
      });
    const others = (await othersOf(a, rule, { self: [agent], selfRole: 'agent' })).filter((x) => !list.some((l) => l.to === x));
    const lost = names.get(agent) ?? '';
    await tell(ctx, others, {
      kind: 'taken',
      tag: 'team-taken',
      count: list.length,
      url,
      by: o.by ?? null,
      phone: rule.phone,
      text: (lang, n) => ({ title: n === 1 && one ? say('teamTaken1', lang, { ref: bits.get(one.id)!.ref, who: lost }) : say('teamTakenN', lang, { n }), body: body(lang) }),
    });
  }
}

/** A parcel's delivery status changed (orders.ts › setFollow): the agent who confirmed it, the Suivi agent following it. */
export interface FollowMove {
  id: number;
  from: string | null;
  to: string;
}
export async function tellFollow(ctx: Ctx, moves: FollowMove[], by: number | null) {
  if (!moves.length) return;
  const rules = await notifyRules(ctx.db);
  const a = around(ctx);
  const bits = await orderBits(ctx.db, moves.map((m) => m.id));
  const back = new Set(['returning', 'returned']);
  type K = 'delivered' | 'returned' | 'cancelled' | 'alert';
  /** person → kind → their orders: their own lines, and the others' (`team`, in the third person) */
  const own = new Map<number, Map<K, { o: Bits; to: string }[]>>();
  const team = new Map<number, Map<K, { o: Bits; to: string }[]>>();
  const add = (out: typeof own, who: number, kind: K, o: Bits, to: string) => {
    if (who === by) return;
    const m = out.get(who) ?? new Map();
    m.set(kind, [...(m.get(kind) ?? []), { o, to }]);
    out.set(who, m);
  };
  for (const m of moves) {
    const o = bits.get(m.id);
    if (!o || m.from === m.to) continue;
    const kind: K | null =
      m.to === 'delivered' ? 'delivered' : back.has(m.to) && !back.has(m.from ?? '') ? 'returned' : m.to === 'cancelled' ? 'cancelled' : m.to === 'alert' || m.to === 'failed' ? 'alert' : null;
    if (!kind) continue;
    await tellAgencyOrderStatus(ctx, m.id, kind === 'alert' ? 'parcelAlert' : kind, by).catch(() => {});
    const rule = rules[kind];
    if (!rule.on) continue;
    // the person it is about: the agent who confirmed it, or the Suivi agent of a parcel on alert
    const selfRole: NotifyWho = kind === 'alert' ? 'suivi' : 'agent';
    const self = kind === 'alert' ? o.follow : o.agent;
    if (self && selfOn(rule, selfRole)) add(own, self, kind, o, m.to);
    for (const p of await othersOf(a, rule, { self: self ? [self] : [], selfRole, agents: [o.agent], suivis: [o.follow] })) add(team, p, kind, o, m.to);
  }
  const names = await namesOf(ctx.db, [...bits.values()].flatMap((o) => [o.agent, o.follow]).filter((x): x is number => !!x));
  const word = { delivered: ['delivered1', 'deliveredN'], returned: ['returned1', 'returnedN'], cancelled: ['cancelled1', 'cancelledN'], alert: ['alert1', 'alertN'] } as const;
  const what = (kind: K, x: { o: Bits; to: string }, lang: Language, mine: boolean) =>
    kind === 'alert' ? say(x.to === 'failed' ? 'failed' : 'onAlert', lang) : kind === 'cancelled' && mine ? say('afterYou', lang) : x.o.total > 0 ? da(x.o.total, lang) : '';
  for (const [out, mine] of [[own, true], [team, false]] as const)
    for (const [who, kinds] of out)
      for (const [kind, list] of kinds) {
        const one = list.length === 1 ? list[0] : null;
        // the others' line names the order's person: the agent who confirmed it (the Suivi agent for an alert)
        const of = one ? names.get((kind === 'alert' ? one.o.follow : one.o.agent) ?? 0) ?? '' : '';
        await tell(ctx, [who], {
          kind,
          count: list.length,
          orderId: one?.o.id ?? null,
          url: kind === 'alert' ? '#/suivi/alertes' : '#/commandes/tout',
          by,
          phone: rules[kind].phone,
          ...(mine ? {} : { tag: `team-${kind}`, listWhenMany: true, important: false }),
          text: (lang, n) => {
            const many = mine ? list.length : n;
            return {
              title: many === 1 && one ? say(word[kind][0], lang, { ref: one.o.ref }) : say(word[kind][1], lang, { n: many }),
              body: one ? [one.o.name, what(kind, one, lang, mine), mine ? '' : of].filter(Boolean).join(' · ') : refList(list.map((x) => x.o)),
            };
          },
        });
      }
}

/** A customer wrote (WhatsApp, Messenger, Instagram): the agent who has their order now (Confirmation, else Suivi). */
export async function tellMessage(ctx: Ctx, m: { conversationId: number; phone: string | null; customerId?: number | null; name: string; text: string }) {
  if (!m.phone && !m.customerId) return;
  const o = (
    await ctx.db.query(
      `SELECT id, ref, agent_id, follow_agent_id, conf_status, follow_status FROM orders
        WHERE (phone = $1 OR customer_id = $2) AND created_at > now() - interval '30 days'
        ORDER BY created_at DESC LIMIT 1`,
      [m.phone ?? '', m.customerId ?? 0],
    )
  )[0];
  if (!o) return;
  const rule = (await notifyRules(ctx.db)).message;
  if (!rule.on) return;
  const confirming = (CONF_TODO as string[]).includes(String(o.conf_status));
  const onRoad = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'].includes(String(o.follow_status ?? ''));
  // the person who has the order now: its agent while it is being confirmed, its Suivi agent once on the road
  const follow = numOrNull(o.follow_agent_id);
  const who = confirming ? numOrNull(o.agent_id) : onRoad ? follow ?? numOrNull(o.agent_id) : null;
  const role: NotifyWho = !confirming && onRoad && follow ? 'suivi' : 'agent';
  const text = m.text.replace(/\s+/g, ' ').trim();
  const title = (lang: Language, n: number) => `💬 ${m.name || String(o.ref)}${n > 1 ? ` · ${say('messages', lang, { n })}` : ''}`;
  if (who && selfOn(rule, role))
    await tell(ctx, [who], {
      kind: 'message',
      tag: `chat-${m.conversationId}`,
      orderId: num(o.id),
      url: '#/commandes/tout',
      phone: rule.phone,
      text: (lang, n) => ({ title: title(lang, n), body: `${o.ref} · ${text.slice(0, 160)}` }),
    });
  // the others ticked (a manager, the owners…): the same message, and whose customer it is
  const others = await othersOf(around(ctx), { ...rule, who: rule.who.filter((w) => w !== 'agent' && w !== 'suivi') }, { self: who ? [who] : [], selfRole: who ? role : null });
  const name = who ? (await namesOf(ctx.db, [who])).get(who) ?? '' : '';
  await tell(ctx, others.filter((x) => x !== who || !selfOn(rule, role)), {
    kind: 'message',
    tag: `team-chat-${m.conversationId}`,
    orderId: num(o.id),
    url: '#/commandes/tout',
    phone: rule.phone,
    important: false,
    text: (lang, n) => ({ title: title(lang, n), body: [`${o.ref} · ${text.slice(0, 160)}`, name ? say('forWho', lang, { who: name }) : ''].filter(Boolean).join(' · ') }),
  });
}

// ---------------------------------------------------------------- every minute (jobs.ts › inbox-run)
/** A callback whose time came, the depot's orders to prepare, and the lines older than 30 days. */
export async function inboxRun(ctx: Ctx) {
  const now = ctx.now();
  if (ctx.shop?.kind === 'agency') {
    await runAgencyKpis(ctx);
    return { calls: 0, depot: 0, gone: await pruneInbox(ctx, now) };
  }
  let calls = 0;
  // the callbacks the agents set (« À rappeler », « Reporté »): told once when their time comes (up to 20 minutes late)
  const due = await ctx.db.query(
    `SELECT o.id, o.ref, o.customer_name, o.agent_id, o.next_call_at FROM orders o
      WHERE o.next_call_at <= $1::timestamptz AND o.next_call_at > $1::timestamptz - interval '20 minutes'
        AND o.agent_id IS NOT NULL AND o.conf_status IN ('callback', 'postponed')
        AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.tag = 'call-' || o.id::text || '-' || floor(extract(epoch FROM o.next_call_at))::bigint::text)
      ORDER BY o.next_call_at LIMIT 200`,
    [new Date(now).toISOString()],
  );
  const rule = (await notifyRules(ctx.db)).callback;
  const a = around(ctx);
  const agents = await namesOf(ctx.db, (due as any[]).map((r) => num(r.agent_id)));
  for (const r of rule.on ? (due as any[]) : []) {
    const at = new Date(r.next_call_at).getTime();
    const agent = num(r.agent_id);
    const name = String(r.customer_name ?? '').trim() || String(r.ref);
    // each callback its own tag, the agent's line and the others': told once (the query above skips a tag already there)
    const base = { kind: 'callback' as const, tag: `call-${num(r.id)}-${Math.floor(at / 1000)}`, orderId: num(r.id), url: '#/confirmation/attente', phone: rule.phone };
    if (selfOn(rule, 'agent'))
      calls += (await tell(ctx, [agent], { ...base, text: (lang) => ({ title: say('callback', lang, { name }), body: say('callbackAt', lang, { ref: String(r.ref), time: clock(at) }) }) })).length;
    const others = await othersOf(a, rule, { self: [agent], selfRole: 'agent' });
    calls += (
      await tell(ctx, others, { ...base, important: false, text: (lang) => ({ title: say('teamCallback', lang, { who: agents.get(agent) ?? '', name }), body: say('callbackAt', lang, { ref: String(r.ref), time: clock(at) }) }) })
    ).length;
  }
  const depot = await depotRun(ctx, now);
  return { calls, depot, gone: await pruneInbox(ctx, now) };
}

/** Expire old lines once an hour. */
async function pruneInbox(ctx: Ctx, now: number): Promise<number> {
  if (new Date(now).getUTCMinutes() !== 7) return 0;
  return (await ctx.db.query(`DELETE FROM inbox WHERE created_at < now() - interval '30 days' RETURNING id`)).length;
}

/** Every 15 minutes at most, in the call hours: the depot is told how many new orders wait to be prepared. */
async function depotRun(ctx: Ctx, now: number): Promise<number> {
  const rule = (await notifyRules(ctx.db)).depot;
  if (!rule.on || !(await workNow(ctx))) return 0;
  const last = (await ctx.db.query(`SELECT max(created_at) AS at FROM inbox WHERE tag = 'depot-prepare'`))[0]?.at;
  const lastAt = last ? new Date(last).getTime() : 0;
  if (now - lastAt < 15 * 60_000) return 0;
  // since the last line, or since the start of the day
  const since = new Date(Math.max(lastAt, algiersDayStart(now))).toISOString();
  const r = (
    await ctx.db.query(
      `SELECT count(*) FILTER (WHERE confirmed_at > $1::timestamptz) AS fresh, count(*) AS total FROM orders
        WHERE follow_status = 'to_prepare' AND conf_status = 'confirmed' AND shipped_at IS NULL`,
      [since],
    )
  )[0];
  const fresh = num(r?.fresh);
  const total = num(r?.total);
  if (!fresh) return 0;
  // the depot team, the owners, the chosen people (Management › Notifications)
  const team = await othersOf(around(ctx), rule, { self: [], selfRole: null });
  const told = await tell(ctx, team, {
    kind: 'depot',
    tag: 'depot-prepare',
    count: fresh,
    url: '#/depot/preparer',
    phone: rule.phone,
    text: (lang, n) => ({ title: n === 1 ? say('depot1', lang) : say('depotN', lang, { n }), body: say('depotAll', lang, { total }) }),
  });
  return told.length;
}

// ---------------------------------------------------------------- the bell's actions
const id = z.number().int().positive();
type Row = Record<string, any>;
const line = (r: Row) => ({
  id: num(r.id),
  kind: String(r.kind) as BellKind,
  title: String(r.title),
  body: String(r.body ?? ''),
  url: r.url ? String(r.url) : null,
  orderId: numOrNull(r.order_id),
  important: !!r.important,
  n: num(r.n),
  at: new Date(r.created_at).toISOString(),
  read: !!r.read_at,
});

export const inboxProcs = {
  /** The bell: the person's last lines (newest first), how many are not read, the shop's call hours (the sound stays on then). */
  'inbox.list': proc(null, z.object({}), async (ctx) => {
    const me = ctx.session.profile.id;
    const rows = await ctx.db.query('SELECT id, kind, title, body, url, order_id, important, n, created_at, read_at FROM inbox WHERE profile_id = $1 ORDER BY created_at DESC, id DESC LIMIT 60', [me]);
    const unread = num((await ctx.db.query('SELECT count(*) AS n FROM inbox WHERE profile_id = $1 AND read_at IS NULL', [me]))[0]?.n);
    const calls = await getSetting(ctx.db, 'calls');
    return { items: rows.map(line), unread, slots: calls.slots.map((s) => ({ from: s.from, to: s.to })), now: ctx.now() };
  }),
  /** Seen (a line opened). The person's other screens follow. */
  'inbox.read': proc(null, z.object({ ids: z.array(id).min(1).max(200) }), async (ctx, i) => {
    const me = ctx.session.profile.id;
    const r = await ctx.db.query('UPDATE inbox SET read_at = now() WHERE profile_id = $1 AND id = ANY($2) AND read_at IS NULL RETURNING id', [me, i.ids]);
    if (r.length) ctx.emit({ type: 'inbox', data: { to: [], quiet: [me] } });
    return { read: r.length };
  }),
  /** « Tout marquer comme lu » */
  'inbox.readAll': proc(null, z.object({}), async (ctx) => {
    const me = ctx.session.profile.id;
    const r = await ctx.db.query('UPDATE inbox SET read_at = now() WHERE profile_id = $1 AND read_at IS NULL RETURNING id', [me]);
    if (r.length) ctx.emit({ type: 'inbox', data: { to: [], quiet: [me] } });
    return { read: r.length };
  }),
  /** Every minute (jobs.ts): callbacks due, the depot's orders to prepare, old lines gone. */
  'inbox.run': proc([], z.object({}), (ctx) => inboxRun(ctx)),
  /**
   * Management › Notifications (administrators): each kind's rule, who it can go to, Pilotix's defaults, the people who
   * can be chosen, and « Bloquer jusqu'à l'appel » (the agent's new order on a blocked screen: set in Confirmation).
   */
  'notify.get': proc([], z.object({}), async (ctx) => {
    const people = await ctx.db.query(`SELECT id, name, roles FROM profiles WHERE active AND agency_id IS NULL ORDER BY name`);
    const calls = await getSetting(ctx.db, 'calls');
    return {
      rules: await notifyRules(ctx.db),
      can: NOTIFY_CAN,
      defaults: DEFAULT_NOTIFY,
      people: people.map((p: any) => ({ id: num(p.id), name: String(p.name ?? '').trim(), roles: (p.roles ?? []) as string[] })),
      block: !!(await getSetting(ctx.db, 'confBlock')).on,
      slots: calls.slots.map((s) => ({ from: s.from, to: s.to })),
    };
  }),
  /** Saves the rules sent (the others stay as they are). */
  'notify.set': proc(
    [],
    z.object({
      rules: z
        .record(
          z.enum(NOTIFY_KINDS),
          z.object({ on: z.boolean(), who: z.array(z.enum(NOTIFY_WHO)).max(NOTIFY_WHO.length), people: z.array(id).max(50), phone: z.enum(NOTIFY_PHONE) }),
        )
        .refine((r) => Object.keys(r).length > 0),
    }),
    async (ctx, i) => {
      const saved = { ...((await getSetting(ctx.db, 'notify')) ?? {}) };
      for (const [k, v] of Object.entries(i.rules) as [NotifyKind, NotifyRule][]) saved[k] = cleanRule(k, v);
      await setSetting(ctx.db, 'notify', saved, ctx.session.profile.id);
      return { rules: await notifyRules(ctx.db) };
    },
  ),
};
