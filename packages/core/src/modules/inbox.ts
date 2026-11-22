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
import { algiersDayStart, CONF_TODO, Language, slotAt } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { Ctx, proc } from '../rpc';
import { getSetting } from '../settings';
import { BellKind, ringBell } from './bell';
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
} satisfies Record<string, Words>;

/** A sentence of W in this language, its {words} filled. */
export function say(key: keyof typeof W, lang: Language, v: Record<string, string | number> = {}): string {
  return (W[key][lang] ?? W[key].fr).replace(/\{(\w+)\}/g, (_, k: string) => (v[k] === undefined ? '' : String(v[k])));
}
/** 4500 → « 4 500 » */
const money = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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
const oneLine = (o: Bits) => [o.ref, o.name, o.total > 0 ? `${money(o.total)} DA` : ''].filter(Boolean).join(' · ');
const refList = (list: Bits[]) => list.slice(0, 4).map((o) => o.ref).join(', ') + (list.length > 4 ? ` +${list.length - 4}` : '');
async function namesOf(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.query('SELECT id, name FROM profiles WHERE id = ANY($1)', [[...new Set(ids)]]);
  return new Map(rows.map((r: any) => [num(r.id), String(r.name ?? '').trim()]));
}

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
    const rung = await ringBell(ctx, people, (lang, n) => ({ kind: t.kind, ...t.text(lang, n), url: t.url ?? null, orderId: t.orderId ?? null, important }), { tag: t.tag, count: t.count });
    const phone = t.phone ?? 'work';
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
  const bits = await orderBits(ctx.db, [...given.values()].flat());
  const by = o.by ? (await namesOf(ctx.db, [o.by])).get(o.by) ?? '' : '';
  for (const [agent, ids] of given) {
    const list = ids.map((i) => bits.get(i)).filter((x): x is Bits => !!x);
    if (!list.length) continue;
    const one = list.length === 1 ? list[0] : null;
    const why = (lang: Language) => (o.rotation ? `${say('rotation', lang)} · ` : by ? `${say('fromManager', lang, { who: by })} · ` : '');
    await tell(ctx, [agent], {
      kind: area === 'conf' ? 'order' : 'alert',
      count: list.length,
      orderId: one?.id ?? null,
      url: area === 'conf' ? '#/confirmation/nouvelles' : '#/suivi/alertes',
      by: o.by ?? null,
      text: (lang, n) =>
        area === 'conf'
          ? { title: n === 1 ? say('order1', lang) : say('orderN', lang, { n }), body: why(lang) + (one ? oneLine(one) : refList(list)) }
          : { title: n === 1 ? say('given', lang) : say('alertN', lang, { n }), body: why(lang) + (one ? oneLine(one) : refList(list)) },
    });
  }
}

/** Orders taken from their agent (a rotation, a manager): one line per person. `to`: who has each order now. */
export async function tellTaken(ctx: Ctx, taken: Map<number, { id: number; to: number | null }[]>, o: { by?: number | null; rotation?: boolean; area?: 'conf' | 'follow' } = {}) {
  const all = [...taken.values()].flat();
  const bits = await orderBits(ctx.db, all.map((x) => x.id));
  const names = await namesOf(ctx.db, all.map((x) => x.to).filter((x): x is number => !!x));
  for (const [agent, list0] of taken) {
    const list = list0.filter((x) => bits.has(x.id));
    if (!list.length) continue;
    const one = list.length === 1 ? list[0] : null;
    const who = one?.to ? names.get(one.to) ?? '' : '';
    await tell(ctx, [agent], {
      kind: 'taken',
      count: list.length,
      url: o.area === 'follow' ? '#/suivi/alertes' : '#/confirmation/nouvelles',
      by: o.by ?? null,
      text: (lang, n) => ({
        title: n === 1 && one ? say('taken1', lang, { ref: bits.get(one.id)!.ref }) : say('takenN', lang, { n }),
        body: one ? (who ? say(o.rotation ? 'late' : 'givenTo', lang, { who }) : bits.get(one.id)!.name) : refList(list.map((x) => bits.get(x.id)!)),
      }),
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
  const bits = await orderBits(ctx.db, moves.map((m) => m.id));
  const back = new Set(['returning', 'returned']);
  /** person → kind → their orders */
  const out = new Map<number, Map<'delivered' | 'returned' | 'cancelled' | 'alert', { o: Bits; to: string }[]>>();
  const add = (who: number | null, kind: 'delivered' | 'returned' | 'cancelled' | 'alert', o: Bits, to: string) => {
    if (!who || who === by) return;
    const m = out.get(who) ?? new Map();
    m.set(kind, [...(m.get(kind) ?? []), { o, to }]);
    out.set(who, m);
  };
  for (const m of moves) {
    const o = bits.get(m.id);
    if (!o || m.from === m.to) continue;
    if (m.to === 'delivered') add(o.agent, 'delivered', o, m.to);
    else if (back.has(m.to) && !back.has(m.from ?? '')) add(o.agent, 'returned', o, m.to);
    else if (m.to === 'cancelled') add(o.agent, 'cancelled', o, m.to);
    else if (m.to === 'alert' || m.to === 'failed') add(o.follow, 'alert', o, m.to);
  }
  for (const [who, kinds] of out)
    for (const [kind, list] of kinds) {
      const one = list.length === 1 ? list[0] : null;
      const word = { delivered: ['delivered1', 'deliveredN'], returned: ['returned1', 'returnedN'], cancelled: ['cancelled1', 'cancelledN'], alert: ['alert1', 'alertN'] }[kind] as [keyof typeof W, keyof typeof W];
      await tell(ctx, [who], {
        kind,
        count: list.length,
        orderId: one?.o.id ?? null,
        url: kind === 'alert' ? '#/suivi/alertes' : '#/commandes/tout',
        by,
        text: (lang) => ({
          title: one ? say(word[0], lang, { ref: one.o.ref }) : say(word[1], lang, { n: list.length }),
          body: one
            ? [one.o.name, kind === 'alert' ? say(one.to === 'failed' ? 'failed' : 'onAlert', lang) : kind === 'cancelled' ? say('afterYou', lang) : one.o.total > 0 ? `${money(one.o.total)} DA` : ''].filter(Boolean).join(' · ')
            : refList(list.map((x) => x.o)),
        }),
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
  const confirming = (CONF_TODO as string[]).includes(String(o.conf_status));
  const onRoad = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'].includes(String(o.follow_status ?? ''));
  const who = confirming ? numOrNull(o.agent_id) : onRoad ? numOrNull(o.follow_agent_id) ?? numOrNull(o.agent_id) : null;
  if (!who) return;
  const text = m.text.replace(/\s+/g, ' ').trim();
  await tell(ctx, [who], {
    kind: 'message',
    tag: `chat-${m.conversationId}`,
    orderId: num(o.id),
    url: '#/commandes/tout',
    text: (lang, n) => ({ title: `💬 ${m.name || String(o.ref)}${n > 1 ? ` · ${say('messages', lang, { n })}` : ''}`, body: `${o.ref} · ${text.slice(0, 160)}` }),
  });
}

// ---------------------------------------------------------------- every minute (jobs.ts › inbox-run)
/** A callback whose time came, the depot's orders to prepare, and the lines older than 30 days. */
export async function inboxRun(ctx: Ctx) {
  const now = ctx.now();
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
  for (const r of due as any[]) {
    const at = new Date(r.next_call_at).getTime();
    const told = await tell(ctx, [num(r.agent_id)], {
      kind: 'callback',
      tag: `call-${num(r.id)}-${Math.floor(at / 1000)}`,
      orderId: num(r.id),
      url: '#/confirmation/attente',
      phone: 'always',
      text: (lang) => ({ title: say('callback', lang, { name: String(r.customer_name ?? '').trim() || String(r.ref) }), body: say('callbackAt', lang, { ref: String(r.ref), time: clock(at) }) }),
    });
    calls += told.length;
  }
  const depot = await depotRun(ctx, now);
  // the lines older than 30 days go, once an hour
  let gone = 0;
  if (new Date(now).getUTCMinutes() === 7) gone = (await ctx.db.query(`DELETE FROM inbox WHERE created_at < now() - interval '30 days' RETURNING id`)).length;
  return { calls, depot, gone };
}

/** Every 15 minutes at most, in the call hours: the depot is told how many new orders wait to be prepared. */
async function depotRun(ctx: Ctx, now: number): Promise<number> {
  if (!(await workNow(ctx))) return 0;
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
  const team = (await ctx.db.query(`SELECT id FROM profiles WHERE active AND 'depot' = ANY(roles) AND NOT ('admin' = ANY(roles)) AND agency_id IS NULL`)).map((x: any) => num(x.id));
  const told = await tell(ctx, team, {
    kind: 'depot',
    tag: 'depot-prepare',
    count: fresh,
    url: '#/depot/preparer',
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
};
