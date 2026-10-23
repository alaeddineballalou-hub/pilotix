// Demandes de modification of a parcel already at the courier (ZR): new amount to collect, home ↔ stop desk, right commune.
// The request goes to the courier's API; the order keeps its values until the courier approves, then Pilotix applies them.
// In the browser preview (no server) the courier is simulated: the request is created, and approved at the next refresh.
import type { CourierKind } from '@pilotix/shared';
import { WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { KINDS } from '../couriers/kinds';
import type { ModState } from '../couriers/types';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { addEvent } from './orders';

const id = z.number().int().positive();
const da = (n: number) => `${Math.round(n).toLocaleString('fr-FR').replace(/ /g, ' ')} DA`;

/** What a parcel looks like for a modification (the fields that can change). */
interface ModValues {
  total: number;
  deliveryFee: number;
  isStopdesk: boolean;
  stopdeskId: number | null;
  stopdeskName: string | null;
  wilayaId: number;
  commune: string;
  address: string;
}

export interface ParcelMod {
  id: number;
  ref: string;
  orderId: number;
  orderRef: string | null;
  tracking: string | null;
  companyName: string | null;
  kinds: string[];
  old: ModValues;
  new: ModValues;
  /** "4 550 DA → 4 200 DA · Domicile → Bureau ZR Bab Ezzouar" */
  summary: string;
  note: string;
  status: 'pending' | 'approved' | 'refused' | 'error' | 'cancelled';
  extId: string | null;
  extError: string | null;
  extComment: string | null;
  createdByName: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const modRef = (n: number) => `MOD-${String(n).padStart(4, '0')}`;
const SELECT = `SELECT m.*, o.ref AS order_ref, o.tracking, co.name AS company_name, cb.name AS created_by_name
  FROM parcel_mods m JOIN orders o ON o.id = m.order_id LEFT JOIN delivery_companies co ON co.id = m.company_id LEFT JOIN profiles cb ON cb.id = m.created_by`;

const where = (v: ModValues) => (v.isStopdesk ? `Bureau ${v.stopdeskName ?? ''}`.trim() : `Domicile · ${v.commune}, ${WILAYAS[v.wilayaId - 1] ?? v.wilayaId}`);
export function modSummary(kinds: string[], o: ModValues, n: ModValues) {
  const parts: string[] = [];
  if (o.total !== n.total) parts.push(`Montant ${da(o.total)} → ${da(n.total)}`);
  if (kinds.includes('type') || kinds.includes('commune')) parts.push(`${where(o)} → ${where(n)}`);
  return parts.join(' · ') || 'Aucun changement';
}

function toMod(r: any): ParcelMod {
  const j = (x: any) => (typeof x === 'string' ? JSON.parse(x) : x ?? {});
  const kinds = (r.kinds ?? []) as string[];
  const o = j(r.old_values) as ModValues;
  const n = j(r.new_values) as ModValues;
  return {
    id: num(r.id),
    ref: modRef(num(r.id)),
    orderId: num(r.order_id),
    orderRef: r.order_ref ?? null,
    tracking: r.tracking ?? null,
    companyName: r.company_name ?? null,
    kinds,
    old: o,
    new: n,
    summary: modSummary(kinds, o, n),
    note: r.note ?? '',
    status: r.status,
    extId: r.ext_id ?? null,
    extError: r.ext_error ?? null,
    extComment: r.ext_comment ?? null,
    createdByName: r.created_by_name ?? null,
    createdAt: iso(r.created_at),
    decidedAt: isoOrNull(r.decided_at),
  };
}

async function getMod(db: Db, mid: number) {
  const r = (await db.query(`${SELECT} WHERE m.id = $1`, [mid]))[0];
  if (!r) throw notFound('Demande de modification introuvable');
  return toMod(r);
}

async function orderRow(db: Db, oid: number) {
  const o = (
    await db.query(
      `SELECT o.*, co.kind AS company_kind, co.name AS company_name, sd.name AS sd_name, sd.ext_id AS sd_ext
       FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id LEFT JOIN stopdesks sd ON sd.id = o.stopdesk_id WHERE o.id = $1`,
      [oid],
    )
  )[0];
  if (!o) throw notFound('Commande introuvable');
  return o;
}

const valuesOf = (o: any): ModValues => ({
  total: num(o.total),
  deliveryFee: num(o.delivery_fee),
  isStopdesk: !!o.is_stopdesk,
  stopdeskId: numOrNull(o.stopdesk_id),
  stopdeskName: o.sd_name ?? null,
  wilayaId: num(o.wilaya_id),
  commune: o.commune ?? '',
  address: o.address ?? '',
});

const ModCreate = z.object({
  orderId: id,
  /** new amount to collect; omitted = recomputed from the new delivery fee when the place changes, else unchanged */
  total: z.number().int().min(0).max(10_000_000).optional(),
  /** home ↔ stop desk */
  isStopdesk: z.boolean().optional(),
  stopdeskId: id.nullable().optional(),
  /** right commune (home delivery) */
  wilayaId: z.number().int().min(1).max(69).optional(),
  commune: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
  note: z.string().trim().max(500).default(''),
});

async function sendMod(ctx: Ctx, mid: number) {
  const m = await getMod(ctx.db, mid);
  const o = await orderRow(ctx.db, m.orderId);
  let extId: string | null = null;
  let error: string | null = null;
  try {
    if (!ctx.server) extId = `demo-mod-${mid}`;
    else {
      const sd = m.new.isStopdesk && m.new.stopdeskId ? (await ctx.db.query('SELECT ext_id FROM stopdesks WHERE id = $1', [m.new.stopdeskId]))[0] : null;
      const placeChanged = m.kinds.includes('type') || m.kinds.includes('commune');
      const r = (await ctx.server.courier(
        'modify',
        {
          companyId: num(o.company_id),
          mod: {
            item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id ?? null },
            amount: m.new.total !== m.old.total ? m.new.total : null,
            deliveryType: placeChanged ? (m.new.isStopdesk ? 'pickup-point' : 'home') : null,
            address: placeChanged && !m.new.isStopdesk ? { wilayaId: m.new.wilayaId, commune: m.new.commune, street: m.new.address } : null,
            hubExtId: placeChanged && m.new.isStopdesk ? sd?.ext_id ?? null : null,
          },
        },
        ctx,
      )) as { extId: string };
      extId = r.extId;
    }
  } catch (e: any) {
    error = String(e?.message ?? 'Erreur').slice(0, 300);
  }
  await ctx.db.query(`UPDATE parcel_mods SET ext_id = $2, ext_error = $3, status = $4 WHERE id = $1`, [mid, extId, error, extId ? 'pending' : 'error']);
  const text = extId ? `Demande de modification ${m.ref} envoyée à ${o.company_name} : ${m.summary}` : `${o.company_name} refuse la demande ${m.ref} : ${error}`;
  await addEvent(ctx.db, m.orderId, ctx.session.profile.id, 'note', null, 'event', text.slice(0, 300));
  ctx.emit({ type: 'order', id: m.orderId });
  return getMod(ctx.db, mid);
}

/** Applies an approved request to the order: amount (the discount absorbs the difference), place, new tracking. */
async function applyMod(db: Db, m: ParcelMod, newTracking: string | null) {
  const o = await orderRow(db, m.orderId);
  const n = m.new;
  const sub = num(o.subtotal);
  let discount = sub + n.deliveryFee - n.total;
  let subtotal = sub;
  if (discount < 0) {
    subtotal = sub - discount;
    discount = 0;
  }
  await db.query(
    `UPDATE orders SET total = $2, delivery_fee = $3, subtotal = $4, discount = $5, is_stopdesk = $6, stopdesk_id = $7, wilaya_id = $8, commune = $9, address = $10,
       tracking = COALESCE($11, tracking), updated_at = now(), version = version + 1 WHERE id = $1`,
    [m.orderId, n.total, n.deliveryFee, subtotal, discount, n.isStopdesk, n.isStopdesk ? n.stopdeskId : null, n.wilayaId, n.commune, n.address, newTracking],
  );
}

async function syncMods(ctx: Ctx, onlyOrder?: number) {
  const rows = await ctx.db.query(
    `${SELECT} WHERE m.status = 'pending' AND m.ext_id IS NOT NULL ${onlyOrder ? 'AND m.order_id = $1' : ''} ORDER BY m.created_at LIMIT 200`,
    onlyOrder ? [onlyOrder] : [],
  );
  const mods = rows.map(toMod);
  const byCompany = new Map<number, ParcelMod[]>();
  for (const [m, r] of mods.map((m, k) => [m, rows[k]] as const)) byCompany.set(num(r.company_id), [...(byCompany.get(num(r.company_id)) ?? []), m]);
  let changed = 0;
  const errors: string[] = [];
  for (const [companyId, list] of byCompany) {
    let states: ModState[];
    if (!ctx.server) states = list.map((m) => ({ extId: m.extId!, approved: true, comment: 'Validée (démo)' }));
    else
      try {
        states = (await ctx.server.courier('modStates', { companyId, extIds: list.map((m) => m.extId!) }, ctx)) as ModState[];
      } catch (e: any) {
        errors.push(String(e?.message ?? 'Erreur'));
        continue;
      }
    for (const st of states) {
      const m = list.find((x) => x.extId === st.extId);
      if (!m) continue;
      if (st.approved === null) {
        await ctx.db.query('UPDATE parcel_mods SET synced_at = now(), ext_comment = COALESCE($2, ext_comment) WHERE id = $1', [m.id, st.comment ?? null]);
        continue;
      }
      changed++;
      if (st.approved) await applyMod(ctx.db, m, st.newTracking ?? null);
      await ctx.db.query(`UPDATE parcel_mods SET status = $2, ext_comment = $3, decided_at = now(), synced_at = now() WHERE id = $1`, [m.id, st.approved ? 'approved' : 'refused', st.comment ?? null]);
      const text = st.approved
        ? `Modification ${m.ref} acceptée par ${m.companyName} : ${m.summary}${st.newTracking ? ` · nouveau suivi ${st.newTracking}` : ''}`
        : `Modification ${m.ref} refusée par ${m.companyName}${st.comment ? ` : ${st.comment}` : ''}`;
      await addEvent(ctx.db, m.orderId, null, 'note', null, 'event', text.slice(0, 300));
    }
  }
  if (changed) ctx.emit({ type: 'orders' });
  return { changed, errors };
}

export const modsProcs = {
  /** Requests of one order (newest first), or every request still waiting. */
  'suivi.mods': proc(['suivi', 'confirmation', 'depot'], z.object({ orderId: id.optional(), status: z.enum(['pending', 'all']).default('all') }), async (ctx, i) => {
    const w: string[] = [];
    const p: unknown[] = [];
    if (i.orderId) w.push(`m.order_id = $${p.push(i.orderId)}`);
    if (i.status === 'pending') w.push(`m.status = 'pending'`);
    const rows = await ctx.db.query(`${SELECT} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, p);
    return rows.map(toMod);
  }),

  /** Can this order get a request, and what it has now (for the form). */
  'suivi.modInfo': proc(['suivi', 'confirmation', 'depot'], z.object({ orderId: id }), async (ctx, { orderId }) => {
    const o = await orderRow(ctx.db, orderId);
    const api = !!KINDS[o.company_kind as CourierKind]?.mods;
    const fees = o.company_id ? await ctx.db.query('SELECT wilaya_id, home, desk FROM delivery_fees WHERE company_id = $1', [o.company_id]) : [];
    return {
      api: api && !!o.tracking,
      companyId: numOrNull(o.company_id),
      companyName: (o.company_name as string) ?? null,
      current: valuesOf(o),
      subtotal: num(o.subtotal),
      discount: num(o.discount),
      fees: fees.map((f: any) => ({ wilayaId: num(f.wilaya_id), home: numOrNull(f.home), desk: numOrNull(f.desk) })),
    };
  }),

  'suivi.modCreate': proc(['suivi', 'confirmation', 'depot'], ModCreate, async (ctx, i) => {
    const o = await orderRow(ctx.db, i.orderId);
    if (!KINDS[o.company_kind as CourierKind]?.mods) throw bad(`${o.company_name ?? 'Cette société'} ne prend pas les demandes de modification par API`);
    if (!o.tracking) throw bad(`${o.ref} n’est pas encore envoyée à ${o.company_name}`);
    if (['delivered', 'returned', 'cancelled'].includes(o.follow_status)) throw bad(`${o.ref} est terminée : plus de modification possible`);
    const busy = (await ctx.db.query(`SELECT id FROM parcel_mods WHERE order_id = $1 AND status = 'pending'`, [o.id]))[0];
    if (busy) throw bad(`${modRef(num(busy.id))} attend déjà la réponse de ${o.company_name}`);
    const old = valuesOf(o);
    const n: ModValues = { ...old };
    const kinds: string[] = [];
    if (i.isStopdesk !== undefined && i.isStopdesk !== old.isStopdesk) kinds.push('type');
    n.isStopdesk = i.isStopdesk ?? old.isStopdesk;
    if (n.isStopdesk) {
      const sid = i.stopdeskId ?? (kinds.includes('type') ? null : old.stopdeskId);
      if (!sid) throw bad('Choisissez le bureau (stop desk)');
      const sd = (await ctx.db.query('SELECT id, name, wilaya_id, commune FROM stopdesks WHERE id = $1 AND company_id = $2', [sid, o.company_id]))[0];
      if (!sd) throw bad('Bureau introuvable pour cette société');
      if (sid !== old.stopdeskId && !kinds.includes('type')) kinds.push('type');
      n.stopdeskId = num(sd.id);
      n.stopdeskName = sd.name;
      n.wilayaId = num(sd.wilaya_id) || old.wilayaId;
      n.commune = sd.commune || n.commune;
    } else {
      n.stopdeskId = null;
      n.stopdeskName = null;
      if (i.wilayaId && i.commune && (i.wilayaId !== old.wilayaId || i.commune !== old.commune)) kinds.push('commune');
      n.wilayaId = i.wilayaId ?? old.wilayaId;
      n.commune = i.commune ?? old.commune;
      if (i.address !== undefined && i.address !== old.address) {
        n.address = i.address;
        if (!kinds.includes('commune')) kinds.push('commune');
      }
      if (!n.commune) throw bad('Choisissez la commune');
    }
    // the delivery fee follows the place (company tariffs), the amount follows the fee unless given
    if (kinds.includes('type') || kinds.includes('commune')) {
      const f = (await ctx.db.query('SELECT home, desk FROM delivery_fees WHERE company_id = $1 AND wilaya_id = $2', [o.company_id, n.wilayaId]))[0];
      const fee = f ? numOrNull(n.isStopdesk ? f.desk : f.home) : null;
      if (fee !== null) n.deliveryFee = fee;
    }
    n.total = i.total ?? old.total - old.deliveryFee + n.deliveryFee;
    if (n.total !== old.total) kinds.unshift('price');
    if (!kinds.length) throw bad('Rien à modifier : changez le montant, le type de livraison ou la commune');
    const me = ctx.session.profile.id;
    const mid = num(
      (
        await ctx.db.query(
          `INSERT INTO parcel_mods (order_id, company_id, kinds, old_values, new_values, note, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id`,
          [o.id, o.company_id, kinds, JSON.stringify(old), JSON.stringify(n), i.note, me],
        )
      )[0].id,
    );
    return sendMod(ctx, mid);
  }),

  /** Sends again a request the courier refused at creation (error). */
  'suivi.modPush': proc(['suivi', 'confirmation', 'depot'], z.object({ id }), async (ctx, i) => {
    const m = await getMod(ctx.db, i.id);
    if (m.status !== 'error') throw bad(`${m.ref} est déjà chez ${m.companyName}`);
    return sendMod(ctx, i.id);
  }),

  /** Withdraws a request not decided yet (at the courier too). */
  'suivi.modCancel': proc(['suivi', 'confirmation', 'depot'], z.object({ id }), async (ctx, i) => {
    const m = await getMod(ctx.db, i.id);
    if (m.status !== 'pending' && m.status !== 'error') throw bad(`${m.ref} est déjà ${m.status === 'approved' ? 'acceptée' : 'close'}`);
    const r = (await ctx.db.query('SELECT company_id FROM parcel_mods WHERE id = $1', [i.id]))[0];
    if (m.extId && ctx.server) await ctx.server.courier('modCancel', { companyId: num(r.company_id), extId: m.extId }, ctx);
    await ctx.db.query(`UPDATE parcel_mods SET status = 'cancelled', decided_at = now() WHERE id = $1`, [i.id]);
    await addEvent(ctx.db, m.orderId, ctx.session.profile.id, 'note', null, 'event', `Demande de modification ${m.ref} annulée`);
    ctx.emit({ type: 'order', id: m.orderId });
    return getMod(ctx.db, i.id);
  }),

  /** Reads the courier's answers; an accepted request is applied to the order. */
  'suivi.modSync': proc(['suivi', 'confirmation', 'depot'], z.object({ orderId: id.optional() }), (ctx, i) => syncMods(ctx, i.orderId)),
};
