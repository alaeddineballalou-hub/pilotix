// Pickup bags (sacs de ramassage): the parcels handed to the courier's driver go together in one bag, made at the courier
// from Pilotix (ZR Express). Its label is printed from here, and the courier says how many of its parcels it has
// processed. In the browser preview the courier is simulated (bag numbers, processed parcels).
import type { CourierKind } from '@pilotix/shared';
import { z } from 'zod';
import { KINDS } from '../couriers/kinds';
import { keysOk } from '../couriers/load';
import type { BagAdded, BagInfo, LabelResult, TrackItem } from '../couriers/types';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc, withActionLock } from '../rpc';
import { addEvent } from './orders';

const id = z.number().int().positive();
const isDemo = (ctx: Ctx) => !ctx.server;
const courier = (ctx: Ctx, action: string, args: Record<string, unknown>) => ctx.server!.courier(action, args, ctx);
const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});

/** A parcel can go in a bag once it is handed over (Dispatchées) and the courier has not taken it in yet. */
const WAITING = `o.follow_status = 'shipped' AND o.tracking IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pickup_bag_parcels bp JOIN pickup_bags b ON b.id = bp.bag_id WHERE bp.order_id = o.id AND b.deleted_at IS NULL)
  AND (o.ext_status_at IS NULL OR o.shipped_at IS NULL OR o.ext_status_at <= o.shipped_at + interval '1 minute')`;

export interface Bag {
  id: number;
  companyId: number;
  tracking: string | null;
  state: string | null;
  parcels: number;
  /** parcels the courier has not processed yet (null: not known yet) */
  unprocessed: number | null;
  createdAt: string;
  createdBy: string | null;
  syncedAt: string | null;
}
export interface BagParcel {
  id: number;
  ref: string;
  tracking: string | null;
  customer: string;
  wilayaId: number | null;
  commune: string;
  total: number;
  followStatus: string | null;
}

/** The companies whose bags are made from Pilotix (ZR), with their keys (or the preview). */
async function bagCompanies(ctx: Ctx, onlyId?: number) {
  const rows = await ctx.db.query(`SELECT id, name, kind, active, credentials FROM delivery_companies WHERE active ${onlyId ? 'AND id = $1' : ''} ORDER BY name`, onlyId ? [onlyId] : []);
  return rows
    .filter((r: any) => KINDS[r.kind as CourierKind]?.zr)
    .filter((r: any) => isDemo(ctx) || keysOk(r.kind as CourierKind, parseJson(r.credentials) as Record<string, unknown>))
    .map((r: any) => ({ id: num(r.id), name: String(r.name), kind: r.kind as CourierKind }));
}

const toBag = (r: any): Bag => ({
  id: num(r.id),
  companyId: num(r.company_id),
  tracking: r.tracking ?? null,
  state: r.state ?? null,
  parcels: num(r.parcels),
  unprocessed: numOrNull(r.unprocessed),
  createdAt: iso(r.created_at),
  createdBy: r.created_by_name ?? null,
  syncedAt: isoOrNull(r.synced_at),
});
const BAG_SQL = `SELECT b.*, p.name AS created_by_name FROM pickup_bags b LEFT JOIN profiles p ON p.id = b.created_by`;

async function bagOr404(db: Db, bagId: number) {
  const r = (await db.query(`${BAG_SQL} WHERE b.id = $1 AND b.deleted_at IS NULL`, [bagId]))[0];
  if (!r) throw notFound('Sac introuvable');
  return { bag: toBag(r), extId: (r.ext_id as string | null) ?? null };
}

async function waitingOf(db: Db, companyId: number, onlyIds?: number[]) {
  return db.query(
    `SELECT o.id, o.ref, o.tracking, o.ext_id FROM orders o WHERE o.company_id = $1 AND ${WAITING} ${onlyIds ? 'AND o.id = ANY($2)' : ''} ORDER BY o.shipped_at, o.id`,
    onlyIds ? [companyId, onlyIds] : [companyId],
  );
}

/** Puts parcels in a bag: a new one (bagId null) or one already made. Returns what went in and what the courier refused. */
/** One bag at a time per company: a double click on « Créer un sac », or two people at once, never make two bags. */
function fill(ctx: Ctx, companyId: number, bagId: number | null, ids: number[] | null) {
  return withActionLock(ctx.db, `bag:${companyId}`, ctx.session.profile.id, 'Un sac est déjà en cours pour cette société : attendez un instant', () => fillNow(ctx, companyId, bagId, ids));
}

async function fillNow(ctx: Ctx, companyId: number, bagId: number | null, ids: number[] | null) {
  const company = (await bagCompanies(ctx, companyId))[0];
  if (!company) throw bad('Cette société ne fait pas de sacs de ramassage depuis Pilotix');
  const rows = await waitingOf(ctx.db, companyId, ids ?? undefined);
  if (ids) {
    const found = new Set(rows.map((r: any) => num(r.id)));
    const left = ids.filter((x) => !found.has(x));
    if (left.length && !rows.length) throw bad('Ces colis ne peuvent pas aller dans un sac : pas encore dispatchés, déjà dans un sac, ou déjà pris par la société');
  }
  if (!rows.length) throw bad('Aucun colis dispatché à mettre dans un sac');
  const items: TrackItem[] = rows.map((r: any) => ({ id: num(r.id), tracking: r.tracking, extId: r.ext_id ?? null }));
  let bag = bagId ? await bagOr404(ctx.db, bagId) : null;
  if (bag && bag.bag.companyId !== companyId) throw bad('Ce sac est à une autre société');
  let res: BagAdded;
  let made: { extId: string; tracking: string | null } | null = null;
  if (isDemo(ctx)) {
    res = { added: items.map((i) => i.tracking), failed: [] };
    if (!bag) made = { extId: `demo-bag-${Date.now()}`, tracking: null };
  } else if (bag) {
    res = (await courier(ctx, 'bagAdd', { companyId, bag: bag.extId, items })) as BagAdded;
  } else {
    const r = (await courier(ctx, 'bagCreate', { companyId, items })) as { extId: string; tracking: string | null } & BagAdded;
    made = { extId: r.extId, tracking: r.tracking };
    res = r;
  }
  const byTracking = new Map(rows.map((r: any) => [String(r.tracking), r]));
  const added = res.added.map((t) => byTracking.get(String(t))).filter(Boolean);
  if (!added.length && !made) throw bad(res.failed[0]?.error || 'La société a refusé ces colis');
  let newId = bag?.bag.id ?? 0;
  if (made) {
    const ins = await ctx.db.query(
      `INSERT INTO pickup_bags (company_id, ext_id, tracking, state, parcels, unprocessed, created_by) VALUES ($1,$2,$3,$4,0,0,$5) RETURNING id`,
      [companyId, made.extId, made.tracking, isDemo(ctx) ? 'Créé' : null, ctx.session.profile.id],
    );
    newId = num(ins[0].id);
    // the preview's bag number, like the courier's
    if (isDemo(ctx)) await ctx.db.query(`UPDATE pickup_bags SET tracking = $2 WHERE id = $1`, [newId, `SAC-${String(160000 + newId * 37).slice(-6)}`]);
  }
  for (const r of added as any[]) await ctx.db.query('INSERT INTO pickup_bag_parcels (bag_id, order_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [newId, num(r.id)]);
  await ctx.db.query(
    `UPDATE pickup_bags SET parcels = (SELECT count(*) FROM pickup_bag_parcels WHERE bag_id = $1), unprocessed = COALESCE(unprocessed, 0) + $2 WHERE id = $1`,
    [newId, added.length],
  );
  bag = await bagOr404(ctx.db, newId);
  for (const r of added as any[]) await addEvent(ctx.db, num(r.id), ctx.session.profile.id, 'company', null, String(companyId), `Mis dans le sac de ramassage ${bag.bag.tracking ?? ''} (${company.name})`.trim());
  ctx.emit({ type: 'orders' });
  const refOf = new Map(rows.map((r: any) => [String(r.tracking), String(r.ref)]));
  return { bag: bag.bag, added: added.length, failed: res.failed.map((f) => ({ ref: refOf.get(String(f.tracking)) ?? f.tracking, error: f.error })) };
}

/** The courier's word on each bag (state, parcels processed). The preview processes a bag two hours after it was made. */
export async function syncBags(ctx: Ctx, companyId?: number) {
  const list = await bagCompanies(ctx, companyId);
  let changed = 0;
  for (const c of list) {
    if (isDemo(ctx)) {
      const r = await ctx.db.query(
        `UPDATE pickup_bags SET unprocessed = 0, state = 'Traité', synced_at = now()
         WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(unprocessed, 1) > 0 AND created_at < now() - interval '2 hours' RETURNING id`,
        [c.id],
      );
      await ctx.db.query(`UPDATE pickup_bags SET synced_at = now() WHERE company_id = $1 AND deleted_at IS NULL`, [c.id]);
      changed += r.length;
      continue;
    }
    const remote = (await courier(ctx, 'bags', { companyId: c.id })) as BagInfo[];
    const byExt = new Map(remote.map((b) => [b.extId, b]));
    const ours = await ctx.db.query(`SELECT id, ext_id, tracking, state, parcels, unprocessed FROM pickup_bags WHERE company_id = $1 AND deleted_at IS NULL AND created_at > now() - interval '30 days'`, [c.id]);
    for (const o of ours) {
      const b = byExt.get(String(o.ext_id)) ?? remote.find((x) => x.tracking && x.tracking === o.tracking);
      if (!b) continue;
      if (b.state !== o.state || b.unprocessed !== numOrNull(o.unprocessed) || (b.tracking && b.tracking !== o.tracking)) changed++;
      await ctx.db.query(
        `UPDATE pickup_bags SET state = COALESCE($2, state), unprocessed = COALESCE($3, unprocessed), tracking = COALESCE($4, tracking), parcels = COALESCE($5, parcels), synced_at = now() WHERE id = $1`,
        [num(o.id), b.state, b.unprocessed, b.tracking, b.parcels],
      );
    }
  }
  return { changed };
}

export const pickupProcs = {
  /** For each company whose bags are made from Pilotix: the parcels waiting for a bag, and the recent bags. */
  'pickup.overview': proc(['depot', 'suivi'], z.object({}), async (ctx) => {
    const out = [];
    for (const c of await bagCompanies(ctx)) {
      const waiting = await ctx.db.query(`SELECT count(*)::int AS n FROM orders o WHERE o.company_id = $1 AND ${WAITING}`, [c.id]);
      const bags = await ctx.db.query(
        `${BAG_SQL} WHERE b.company_id = $1 AND b.deleted_at IS NULL AND (b.created_at > now() - interval '7 days' OR COALESCE(b.unprocessed, 1) > 0)
         ORDER BY b.created_at DESC LIMIT 20`,
        [c.id],
      );
      out.push({ companyId: c.id, name: c.name, waiting: num(waiting[0]?.n), bags: bags.map(toBag) });
    }
    return out;
  }),

  /** The parcels waiting for a bag at one company (handed over, not in a bag, not taken in by the company yet). */
  'pickup.waiting': proc(['depot', 'suivi'], z.object({ companyId: id }), async (ctx, { companyId }) => {
    const rows = await ctx.db.query(
      `SELECT o.id, o.ref, o.tracking, o.customer_name, o.wilaya_id, o.commune, o.total, o.follow_status FROM orders o WHERE o.company_id = $1 AND ${WAITING} ORDER BY o.shipped_at, o.id`,
      [companyId],
    );
    return rows.map((r: any): BagParcel => ({ id: num(r.id), ref: r.ref, tracking: r.tracking, customer: r.customer_name ?? '', wilayaId: numOrNull(r.wilaya_id), commune: r.commune ?? '', total: num(r.total), followStatus: r.follow_status }));
  }),

  /** Makes a new bag at the company with the given parcels (default: every parcel waiting for a bag). */
  'pickup.create': proc(['depot'], z.object({ companyId: id, ids: z.array(id).min(1).max(500).optional() }), async (ctx, i) => fill(ctx, i.companyId, null, i.ids ?? null)),

  /** A selection of parcels (any companies): one new bag per company that makes bags; the others are counted. */
  'pickup.createMany': proc(['depot'], z.object({ ids: z.array(id).min(1).max(500) }), async (ctx, { ids }) => {
    const rows = await ctx.db.query(`SELECT o.id, o.company_id FROM orders o WHERE o.id = ANY($1) AND o.company_id IS NOT NULL AND ${WAITING}`, [ids]);
    const able = new Set((await bagCompanies(ctx)).map((c) => c.id));
    const byCompany = new Map<number, number[]>();
    for (const r of rows) if (able.has(num(r.company_id))) byCompany.set(num(r.company_id), [...(byCompany.get(num(r.company_id)) ?? []), num(r.id)]);
    const made = [];
    for (const [companyId, list] of byCompany) made.push(await fill(ctx, companyId, null, list));
    return { made, skipped: ids.length - [...byCompany.values()].reduce((n, l) => n + l.length, 0) };
  }),

  /** Adds parcels to a bag already made (default: every parcel waiting for a bag). */
  'pickup.add': proc(['depot'], z.object({ bagId: id, ids: z.array(id).min(1).max(500).optional() }), async (ctx, i) => {
    const { bag } = await bagOr404(ctx.db, i.bagId);
    return fill(ctx, bag.companyId, bag.id, i.ids ?? null);
  }),

  /** Takes one parcel out of its bag (at the company too). */
  'pickup.remove': proc(['depot'], z.object({ bagId: id, orderId: id }), async (ctx, i) => {
    const { bag, extId } = await bagOr404(ctx.db, i.bagId);
    const o = (await ctx.db.query(`SELECT o.id, o.tracking, o.ext_id FROM orders o JOIN pickup_bag_parcels bp ON bp.order_id = o.id WHERE bp.bag_id = $1 AND o.id = $2`, [bag.id, i.orderId]))[0];
    if (!o) throw notFound('Ce colis n’est pas dans ce sac');
    if (!isDemo(ctx)) await courier(ctx, 'bagRemove', { companyId: bag.companyId, bag: extId, item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id ?? null } });
    await ctx.db.query('DELETE FROM pickup_bag_parcels WHERE bag_id = $1 AND order_id = $2', [bag.id, i.orderId]);
    await ctx.db.query(`UPDATE pickup_bags SET parcels = (SELECT count(*) FROM pickup_bag_parcels WHERE bag_id = $1), unprocessed = GREATEST(0, COALESCE(unprocessed, 1) - 1) WHERE id = $1`, [bag.id]);
    await addEvent(ctx.db, i.orderId, ctx.session.profile.id, 'company', null, null, `Retiré du sac de ramassage ${bag.tracking ?? ''}`.trim());
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  /** The bag's label (the company's A4 PDF). In the preview: a stand-in printed by Pilotix. */
  'pickup.label': proc(['depot', 'suivi'], z.object({ bagId: id }), async (ctx, { bagId }): Promise<LabelResult | null> => {
    const { bag } = await bagOr404(ctx.db, bagId);
    if (isDemo(ctx)) return { demo: true };
    if (!bag.tracking) throw bad('Ce sac n’a pas encore de numéro chez la société');
    return (await courier(ctx, 'bagLabel', { companyId: bag.companyId, bag: bag.tracking })) as LabelResult | null;
  }),

  /** The parcels of a bag. */
  'pickup.parcels': proc(['depot', 'suivi'], z.object({ bagId: id }), async (ctx, { bagId }) => {
    const { bag } = await bagOr404(ctx.db, bagId);
    const rows = await ctx.db.query(
      `SELECT o.id, o.ref, o.tracking, o.customer_name, o.wilaya_id, o.commune, o.total, o.follow_status FROM orders o JOIN pickup_bag_parcels bp ON bp.order_id = o.id
       WHERE bp.bag_id = $1 ORDER BY bp.added_at, o.id`,
      [bag.id],
    );
    return { bag, parcels: rows.map((r: any): BagParcel => ({ id: num(r.id), ref: r.ref, tracking: r.tracking, customer: r.customer_name ?? '', wilayaId: numOrNull(r.wilaya_id), commune: r.commune ?? '', total: num(r.total), followStatus: r.follow_status })) };
  }),

  /** Deletes a bag nobody has taken yet (at the company too); its parcels wait for a bag again. */
  'pickup.drop': proc(['depot'], z.object({ bagId: id }), async (ctx, { bagId }) => {
    const { bag, extId } = await bagOr404(ctx.db, bagId);
    if (bag.unprocessed !== null && bag.unprocessed < bag.parcels) throw bad('La société a déjà traité des colis de ce sac : il ne peut plus être supprimé');
    if (!isDemo(ctx) && extId) await courier(ctx, 'bagDrop', { companyId: bag.companyId, bag: extId });
    await ctx.db.query('UPDATE pickup_bags SET deleted_at = now() WHERE id = $1', [bag.id]);
    await ctx.db.query('DELETE FROM pickup_bag_parcels WHERE bag_id = $1', [bag.id]);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  /** Asks the company how far it is with each bag. */
  'pickup.sync': proc(['depot', 'suivi'], z.object({ companyId: id.optional() }), async (ctx, i) => syncBags(ctx, i.companyId)),
};
