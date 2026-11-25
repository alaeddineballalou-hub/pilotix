// Customers' old phone numbers (the owner's rule, 25 Nov 2026: « we hide the numbers after 3 days after delivery so only
// names, he can not export anything »). For everyone but the seller (vendeur) and the administrators, a customer's number
// is taken out of every answer 3 days after his orders are over — delivered, cancelled at the confirmation, coming back
// or back — so the team sees only the name and can copy no list of numbers. A customer with an order still going (to
// call, at the depot, on the road) or an open SAV ticket keeps it: someone still has to call him. A SAV ticket stays
// open until its customer was asked how it went (sav.ts: the satisfaction call, 3 tries within 30 days).
//
// It is the last boundary of every action's answer (index.ts run, like withoutPurchaseCosts): the lists, the order's
// page, the searches, a customer's history, a number typed in a note, the assistants connected to Pilotix. The same people
// see the finished orders of the last 30 days only in their lists (LIST_DAYS); older ones only by a search of 5 digits.
import { CONF_DONE_BAD, normalizePhone } from '@pilotix/shared';
import type { Ctx } from '../rpc';

/** Days after an order is over before its customer's number is hidden. */
export const PHONE_DAYS = 3;
/** Days a finished order stays in the lists (Livré, Annulé, « Tous ») of everyone but the seller and the admins. */
export const LIST_DAYS = 30;
/** How many digits a search needs to reach the older orders (« Tous », the top search bar, Réclamation). */
export const LOOKUP_DIGITS = 5;
/** The tries of the satisfaction call of a SAV ticket (sav.ts SAT_MAX_TRIES: not imported, sav.ts reads orders.ts). */
const SAT_TRIES = 3;

/** A delivery status of an order that is over: delivered, exchanged, coming back or back, lost, cancelled. */
export const OVER_FOLLOW = ['delivered', 'exchanged', 'returning', 'returned', 'lost', 'cancelled'] as const;

/** The seller and the administrators see every number and every list, and export (the owner's rule, 25 Nov 2026). */
export const seesEverything = (ctx: Ctx) => !ctx.session?.profile || ctx.session.isAdmin || ctx.session.roles.includes('vendeur');

/** A search the 30 days do not limit: at least 5 digits (a phone, a PX reference, a tracking number). */
export const isLookup = (q: string | null | undefined) => (q ?? '').replace(/\D/g, '').length >= LOOKUP_DIGITS;

const list = (xs: readonly string[]) => `'{${xs.join(',')}}'::text[]`;

/** SQL on an order row (alias `a`): it is over — lost at the confirmation, or done on the road (delivered, back…). */
export const overSql = (a = 'o', follow: readonly string[] = OVER_FOLLOW) => `(${a}.conf_status = ANY(${list(CONF_DONE_BAD)}) OR ${a}.follow_status = ANY(${list(follow)}))`;

/** SQL: when that order was over — its delivery, its coming back, else its last status change. */
export const overAtSql = (a = 'o') =>
  `coalesce(CASE WHEN ${a}.follow_status IN ('delivered','exchanged') THEN ${a}.delivered_at
                 WHEN ${a}.follow_status IN ('returning','returned') THEN coalesce(${a}.returning_at, ${a}.returned_at) END,
            (SELECT max(e.at) FROM order_events e WHERE e.order_id = ${a}.id AND e.kind IN ('conf_status','follow_status')),
            ${a}.updated_at)`;

/** Over for the lists: a parcel coming back is not, the depot still has to receive it (Dépôt › Retours). */
const DONE_FOLLOW = OVER_FOLLOW.filter((s) => s !== 'returning');

/** SQL with one `?` (a time): the order is still going (or coming back), or was over after that time. */
export const recentSql = (a = 'o') => `NOT (${overSql(a, DONE_FOLLOW)} AND ${overAtSql(a)} < ?::timestamptz)`;

/** The time `days` days before now (the server's clock, the tests' too). */
export const daysAgo = (ctx: Ctx, days: number) => new Date(ctx.now() - days * 86_400_000).toISOString();

/** Which of these numbers are hidden now: customers' numbers whose every order was over more than 3 days ago, no open SAV. */
export async function hiddenPhones(ctx: Ctx, phones: string[]): Promise<Set<string>> {
  if (!phones.length) return new Set();
  const rows = await ctx.db.query<{ p: string }>(
    `WITH hit AS (
       SELECT o.id, o.phone AS p, ${overSql()} AND ${overAtSql()} <= $2::timestamptz AS old FROM orders o WHERE o.phone = ANY($1::text[])
       UNION ALL
       SELECT o.id, o.phone2 AS p, ${overSql()} AND ${overAtSql()} <= $2::timestamptz AS old FROM orders o WHERE o.phone2 = ANY($1::text[])
     )
     SELECT h.p FROM hit h
     GROUP BY h.p
     HAVING bool_and(h.old)
        AND NOT EXISTS (
          SELECT 1 FROM complaints k
           WHERE (k.phone = h.p OR k.order_id IN (SELECT x.id FROM hit x WHERE x.p = h.p))
             AND (k.status IN ('open','progress')
                  OR (k.status = 'resolved' AND k.satisfaction IS NULL AND k.sat_tries < ${SAT_TRIES} AND k.resolved_at >= $3::timestamptz)))`,
    [phones, daysAgo(ctx, PHONE_DAYS), daysAgo(ctx, 30)],
  );
  return new Set(rows.map((r) => r.p));
}

/** Where an answer carries a customer's number as such. */
const PHONE_KEYS = new Set(['phone', 'phone2', 'looksLikePhone']);
/** An Algerian number inside a text (a note, a history line), written any way (privacy.ts). */
const PHONE_RE = /(?<![\w+])(?:\+?213[\s.-]?|0)[5-7](?:[\s.-]?\d){8}(?!\d)/g;
/** What a hidden number becomes inside a text. */
export const HIDDEN_IN_TEXT = '•••• •• •• ••';
/** An account of the team (its e-mail, its roles): not a customer, its number stays. */
const isAccount = (o: Record<string, unknown>) => typeof o.email === 'string' || Array.isArray(o.roles);
const MAX_DEPTH = 24;

function collect(v: unknown, out: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || !v || typeof v !== 'object' || v instanceof Date) return;
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === 'string') inText(x, out);
      else collect(x, out, depth + 1);
    }
    return;
  }
  const o = v as Record<string, unknown>;
  if (isAccount(o)) return;
  for (const k in o) {
    const x = o[k];
    if (typeof x === 'string') {
      if (PHONE_KEYS.has(k)) {
        const p = normalizePhone(x);
        if (p) out.add(p);
      } else inText(x, out);
    } else if (x && typeof x === 'object') collect(x, out, depth + 1);
  }
}

function inText(s: string, out: Set<string>) {
  if (s.length < 9) return;
  for (const m of s.matchAll(PHONE_RE)) {
    const p = normalizePhone(m[0]);
    if (p) out.add(p);
  }
}

function hideInText(s: string, hidden: Set<string>): string {
  if (s.length < 9) return s;
  return s.replace(PHONE_RE, (m) => (hidden.has(normalizePhone(m) ?? '') ? HIDDEN_IN_TEXT : m));
}

/** A copy of `v` without the hidden numbers (parts with none are kept as they are; nothing is changed in place). */
function strip(v: unknown, hidden: Set<string>, depth: number): unknown {
  if (depth > MAX_DEPTH || !v || typeof v !== 'object' || v instanceof Date) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = typeof x === 'string' ? hideInText(x, hidden) : strip(x, hidden, depth + 1);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  const o = v as Record<string, unknown>;
  if (isAccount(o)) return v;
  let copy: Record<string, unknown> | null = null;
  for (const k in o) {
    const x = o[k];
    let y: unknown = x;
    if (typeof x === 'string') {
      if (PHONE_KEYS.has(k)) {
        if (hidden.has(normalizePhone(x) ?? '')) y = k === 'phone' ? '' : null;
      } else y = hideInText(x, hidden);
    } else if (x && typeof x === 'object') y = strip(x, hidden, depth + 1);
    if (y !== x) {
      copy ??= { ...o };
      copy[k] = y;
    }
  }
  // the screens say « Numéro caché » instead of an empty place, and never send the empty number back
  if (copy && typeof o.phone === 'string' && copy.phone === '' && o.phone !== '') copy.phoneHidden = true;
  return copy ?? v;
}

/** Every action's answer, last: the old customers' numbers out, for everyone but the seller and the admins. */
export async function withoutOldPhones<T>(ctx: Ctx, out: T): Promise<T> {
  if (seesEverything(ctx) || !out || typeof out !== 'object') return out;
  const found = new Set<string>();
  collect(out, found, 0);
  if (!found.size) return out;
  const hidden = await hiddenPhones(ctx, [...found]);
  return hidden.size ? (strip(out, hidden, 0) as T) : out;
}

/** Is this order's number hidden from this person now (an order form sent back without it must not wipe it)? */
export async function phoneHiddenFor(ctx: Ctx, phone: string | null | undefined): Promise<boolean> {
  if (seesEverything(ctx) || !phone) return false;
  return (await hiddenPhones(ctx, [phone])).has(phone);
}
