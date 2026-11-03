// « Liste noire partagée »: a number one of the seller's boutiques blacklists by hand (a person: « Mettre en liste
// noire », « Bloquer le client », a fake landing page order) is blacklisted in all the boutiques of the same owner, so
// a scammer blocked in one boutique arrives « À vérifier » in the others too. The automatic list (parcels refused,
// trust.ts) stays each boutique's own: it is learned there and lifted there when the customer pays.
//
// Each boutique keeps its own list (customers.blacklisted: what makes a new order « À vérifier », the client score,
// « Liste noire seulement »), so nothing else changes: the others get the number (a customer is made there when the
// number never ordered there), the reason with the boutique it comes from (customers.blacklist_shop), and a line on
// their open orders of that number. Taking a number off the list takes it off the others only where it came from this
// boutique: another boutique's own decision stays. A boutique that cannot be reached is skipped: the action here is done
// anyway.
import { CONF_DONE_BAD } from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num } from '../db';
import { Ctx, proc } from '../rpc';
import { addEvent } from './orders';

export interface SisterShop {
  id: number;
  name: string;
  schema: string;
}

/** This boutique's name and the owner's other boutiques (none on a server with one shop, or in a partner's space). */
export async function sisterShops(ctx: Ctx): Promise<{ here: string; sisters: SisterShop[] }> {
  const t = ctx.t;
  if (!t || !ctx.shop || (ctx.shop.kind && ctx.shop.kind !== 'store')) return { here: '', sisters: [] };
  const rows = (await t.platform.query(
    `SELECT s.id, s.name, s.schema_name, me.name AS here FROM platform.shops me
       JOIN platform.shops s ON s.owner_account_id = me.owner_account_id AND s.id <> me.id
     WHERE me.id = $1 AND me.owner_account_id IS NOT NULL AND s.kind = 'store' AND s.status NOT IN ('deleted', 'archived')
     ORDER BY s.id`,
    [ctx.shop.id],
  )) as any[];
  const here = rows[0]?.here ? String(rows[0].here) : '';
  return { here, sisters: rows.map((r) => ({ id: num(r.id), name: String(r.name), schema: String(r.schema_name) })) };
}

export interface BlackNumber {
  phone: string;
  name: string;
  wilayaId: number | null;
}

/** The open orders of these customers (not shipped, not cancelled): they get a line in their history. */
async function noteOpen(db: Db, customerIds: number[], note: string) {
  if (!customerIds.length) return;
  const open = await db.query(`SELECT id FROM sales WHERE customer_id = ANY($1) AND (follow_status IS NULL OR follow_status IN ('to_prepare','prepared')) AND conf_status <> ALL($2)`, [customerIds, CONF_DONE_BAD]);
  for (const o of open) await addEvent(db, num(o.id), null, 'note', null, 'event', note);
}

/** In another boutique: these numbers on its list (where it does not already have them by its own decision). */
async function putOn(db: Db, from: { id: number; name: string }, list: BlackNumber[], reason: string | null) {
  const phones = list.map((x) => x.phone);
  const why = reason ? `${reason} · ${from.name}` : `Liste noire de ${from.name}`;
  return db.tx(async (tx) => {
    // already blacklisted there by a person (its own decision or another boutique's): left as it is
    const had = new Set(((await tx.query('SELECT phone FROM customers WHERE phone = ANY($1) AND blacklisted AND NOT blacklist_auto', [phones])) as any[]).map((r) => String(r.phone)));
    const add = list.filter((x) => !had.has(x.phone));
    if (!add.length) return 0;
    const rows = (await tx.query(
      `INSERT INTO customers (phone, name, wilaya_id, blacklisted, blacklist_reason, blacklist_auto, blacklist_shop)
       SELECT p, n, w, true, $4, false, $5 FROM unnest($1::text[], $2::text[], $3::smallint[]) AS x(p, n, w)
       ON CONFLICT (phone) DO UPDATE SET blacklisted = true, blacklist_auto = false, blacklist_reason = EXCLUDED.blacklist_reason, blacklist_shop = EXCLUDED.blacklist_shop
       RETURNING id`,
      [add.map((x) => x.phone), add.map((x) => x.name || 'Client'), add.map((x) => x.wilayaId), why, from.id],
    )) as any[];
    await noteOpen(tx, rows.map((r) => num(r.id)), `Client mis en liste noire dans ${from.name}${reason ? ` : ${reason}` : ''}`);
    return rows.length;
  });
}

/** In another boutique: these numbers off its list, only where they came from that boutique. */
async function takeOff(db: Db, from: { id: number; name: string }, phones: string[]) {
  return db.tx(async (tx) => {
    const rows = (await tx.query(
      `UPDATE customers SET blacklisted = false, blacklist_reason = NULL, blacklist_shop = NULL
       WHERE phone = ANY($1) AND blacklisted AND NOT blacklist_auto AND blacklist_shop = $2 RETURNING id`,
      [phones, from.id],
    )) as any[];
    await noteOpen(tx, rows.map((r) => num(r.id)), `Client retiré de la liste noire dans ${from.name}`);
    return rows.length;
  });
}

/**
 * A person here put these numbers on (or off) the blacklist: the owner's other boutiques follow. Their names where it
 * was done (for « aussi dans … »).
 */
export async function shareBlacklist(ctx: Ctx, list: BlackNumber[], on: boolean, reason: string | null = null): Promise<string[]> {
  const nums = [...new Map(list.filter((x) => x.phone).map((x) => [x.phone, x])).values()];
  if (!nums.length || !ctx.t || !ctx.shop) return [];
  const { here, sisters } = await sisterShops(ctx).catch(() => ({ here: '', sisters: [] as SisterShop[] }));
  const from = { id: ctx.shop.id, name: here || 'une autre boutique' };
  const done: string[] = [];
  for (const s of sisters) {
    try {
      const db = ctx.t.shop(s.schema);
      if (on) await putOn(db, from, nums, reason);
      else await takeOff(db, from, nums.map((x) => x.phone));
      done.push(s.name);
    } catch {
      // that boutique could not be reached (being moved, locked database…): this one is done anyway
    }
  }
  return done;
}

/** The numbers of these customers here (to share them). */
export async function blackNumbers(db: Db, customerIds: number[]): Promise<BlackNumber[]> {
  if (!customerIds.length) return [];
  return ((await db.query('SELECT phone, name, wilaya_id FROM customers WHERE id = ANY($1)', [customerIds])) as any[]).map((r) => ({ phone: String(r.phone), name: String(r.name ?? ''), wilayaId: r.wilaya_id === null || r.wilaya_id === undefined ? null : num(r.wilaya_id) }));
}

export const sharedBlacklistProcs = {
  /** « Liste noire partagée avec … »: the owner's other boutiques, and how many numbers this boutique blocked itself. */
  'customers.shareInfo': proc(['confirmation', 'suivi'], z.object({}), async (ctx) => {
    const { sisters } = await sisterShops(ctx).catch(() => ({ sisters: [] as SisterShop[] }));
    const own = sisters.length ? num((await ctx.db.query('SELECT count(*)::int AS n FROM customers WHERE blacklisted AND NOT blacklist_auto AND blacklist_shop IS NULL'))[0]?.n) : 0;
    return { shops: sisters.map((s) => s.name), own };
  }),

  /** Sends every number this boutique blocked itself (before the list was shared too) to the owner's other boutiques. */
  'customers.shareAll': proc([], z.object({}), async (ctx) => {
    const rows = (await ctx.db.query('SELECT phone, name, wilaya_id, blacklist_reason FROM customers WHERE blacklisted AND NOT blacklist_auto AND blacklist_shop IS NULL ORDER BY id')) as any[];
    const byReason = new Map<string, BlackNumber[]>();
    for (const r of rows) {
      const k = String(r.blacklist_reason ?? '');
      byReason.set(k, [...(byReason.get(k) ?? []), { phone: String(r.phone), name: String(r.name ?? ''), wilayaId: r.wilaya_id === null ? null : num(r.wilaya_id) }]);
    }
    let shops: string[] = [];
    for (const [reason, list] of byReason) for (let i = 0; i < list.length; i += 500) shops = await shareBlacklist(ctx, list.slice(i, i + 500), true, reason || null);
    if (!rows.length) shops = (await sisterShops(ctx).catch(() => ({ sisters: [] as SisterShop[] }))).sisters.map((s) => s.name);
    return { numbers: rows.length, shops };
  }),
};
