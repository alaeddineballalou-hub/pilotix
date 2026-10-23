// One parcel at its courier (ZR Express), seen and changed from Pilotix: the courier's journey (each status, hub, who),
// the SMS it sent the customer, its livreur, the customer's return risk, and modification requests — price, home ↔
// stop desk, address / commune, phone — sent to the courier, followed, and applied to the order once the courier
// accepts. In the browser preview the courier is simulated from Pilotix's own data.
import { CourierKind, FOLLOW_FINAL, FollowStatus, normalizePhone, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { word } from '../couriers/demo';
import { KINDS } from '../couriers/kinds';
import type { ChangeInput, ChangeState, ParcelInfo } from '../couriers/types';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { addEvent } from './orders';

const id = z.number().int().positive();
const isDemo = (ctx: Ctx) => !ctx.server;
const courier = (ctx: Ctx, action: string, args: Record<string, unknown>) => ctx.server!.courier(action, args, ctx);
const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
const wilayaName = (w: number | null | undefined) => (w ? WILAYAS[w - 1] ?? String(w) : '');

export type ChangeKind = 'amount' | 'delivery' | 'address' | 'phone';
/** What a request changes, as shown (and applied to the order once accepted). */
export interface ChangeValues {
  amount?: number;
  stopdesk?: boolean;
  stopdeskId?: number | null;
  stopdeskName?: string | null;
  wilayaId?: number;
  commune?: string;
  address?: string;
  phone?: string;
  phone2?: string | null;
}
export interface ParcelChange {
  id: number;
  kind: ChangeKind;
  old: ChangeValues;
  new: ChangeValues;
  /** pending (waiting for the courier) · approved (applied to the order) · refused · cancelled · failed (not sent) */
  status: 'pending' | 'approved' | 'refused' | 'cancelled' | 'failed';
  answer: string | null;
  error: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  decidedAt: string | null;
}

const toChange = (r: any): ParcelChange => ({
  id: num(r.id),
  kind: r.kind,
  old: parseJson(r.old),
  new: parseJson(r.new),
  status: r.status,
  answer: r.answer ?? null,
  error: r.error ?? null,
  note: r.note ?? null,
  createdAt: iso(r.created_at),
  createdBy: r.created_by_name ?? null,
  decidedAt: isoOrNull(r.decided_at),
});
const CHANGES_SQL = `SELECT ch.*, p.name AS created_by_name FROM parcel_changes ch LEFT JOIN profiles p ON p.id = ch.created_by`;

/** The order and its courier, when the courier gives its services from Pilotix (ZR) and the parcel was sent to it. */
async function parcelOf(db: Db, orderId: number) {
  const o = (
    await db.query(
      `SELECT o.id, o.ref, o.tracking, o.ext_id, o.ext_status, o.ext_status_at, o.follow_status, o.company_id, o.phone, o.phone2, o.wilaya_id, o.commune,
         o.address, o.is_stopdesk, o.stopdesk_id, o.subtotal, o.delivery_fee, o.discount, o.total, o.shipped_at, o.created_at, o.customer_name,
         c.kind, c.name AS company_name, c.credentials, sd.name AS sd_name, sd.ext_id AS sd_ext
       FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id LEFT JOIN stopdesks sd ON sd.id = o.stopdesk_id WHERE o.id = $1`,
      [orderId],
    )
  )[0];
  if (!o) throw notFound('Commande introuvable');
  return o;
}
const servesFrom = (o: any) => !!o.tracking && !!o.company_id && !!KINDS[o.kind as CourierKind]?.zr;

// ---------------------------------------------------------------- the preview: ZR simulated from Pilotix's data
const LIVREURS = [
  ['Rachid', 'Benali', '0555 41 22 87'],
  ['Yacine', 'Hamadi', '0661 30 18 54'],
  ['Sofiane', 'Merabet', '0770 92 45 13'],
  ['Walid', 'Kaci', '0557 64 08 39'],
];
const STEP_COLOR: Partial<Record<FollowStatus, string>> = { prepared: '#94a3b8', shipped: '#3b82f6', out_for_delivery: '#f59e0b', failed: '#ef4444', alert: '#ef4444', delivered: '#16a34a', returning: '#ef4444', returned: '#7c3aed' };

async function demoInfo(db: Db, o: any): Promise<ParcelInfo> {
  const kind = o.kind as CourierKind;
  const ev = await db.query(`SELECT kind, to_value, note, at FROM order_events WHERE order_id = $1 AND kind IN ('follow_status','company') ORDER BY at`, [o.id]);
  const f = o.follow_status as FollowStatus | null;
  const hub = (w: number) => `Agence ZR ${wilayaName(w)}`;
  const history: ParcelInfo['history'] = [];
  const sent = ev.find((e: any) => e.kind === 'company' && /suivi/.test(e.note ?? ''));
  if (sent) history.push({ at: iso(sent.at), status: word(kind, 'prepared'), color: STEP_COLOR.prepared!, hub: null, by: null, comment: null, situations: [] });
  for (const e of ev.filter((x: any) => x.kind === 'follow_status' && ['shipped', 'out_for_delivery', 'failed', 'delivered', 'returning', 'returned'].includes(x.to_value))) {
    const s = e.to_value as FollowStatus;
    const at = iso(e.at);
    history.push({
      at,
      status: word(kind, s).split(' · ')[0],
      color: STEP_COLOR[s] ?? null,
      hub: s === 'shipped' ? 'Centre de tri ZR Alger' : hub(num(o.wilaya_id)),
      by: s === 'out_for_delivery' || s === 'failed' || s === 'delivered' ? LIVREURS[num(o.id) % LIVREURS.length].slice(0, 2).join(' ') : null,
      comment: s === 'failed' ? e.note ?? null : null,
      situations: s === 'failed' ? [{ name: 'Client injoignable', at: new Date(Date.parse(at) + 15 * 60_000).toISOString() }] : [],
    });
  }
  history.sort((a, b) => b.at.localeCompare(a.at));
  // what Pilotix knows of the customer across its orders: the courier's return meter, in the preview
  const past = (await db.query(`SELECT follow_status FROM orders WHERE phone = $1 AND id <> $2 AND follow_status = ANY($3)`, [o.phone, o.id, ['delivered', 'returned', 'returning', 'exchanged']])).map((r: any) => r.follow_status);
  const returns = past.filter((s: string) => s === 'returned' || s === 'returning').length;
  const orders = past.length + 1;
  const score = Math.round((returns / orders) * 100);
  const onRoad = !!f && !FOLLOW_FINAL.includes(f) && f !== 'returning';
  const changes = await db.query(`SELECT kind, status FROM parcel_changes WHERE order_id = $1`, [o.id]);
  const lv = LIVREURS[num(o.id) % LIVREURS.length];
  const shippedAt = o.shipped_at ? Date.parse(new Date(o.shipped_at).toISOString()) : null;
  const sms: ParcelInfo['sms'] = [];
  if (shippedAt) sms.push({ at: new Date(shippedAt + 40 * 60_000).toISOString(), phone: o.phone, message: `ZR Express : votre commande ${o.ref} est en route. Suivi ${o.tracking}.`, status: 'delivered' });
  const out = ev.find((e: any) => e.kind === 'follow_status' && e.to_value === 'out_for_delivery');
  if (out) sms.push({ at: iso(out.at), phone: o.phone, message: `ZR Express : votre colis ${o.tracking} arrive aujourd’hui. Livreur ${lv[0]} : ${lv[2]}.`, status: 'delivered' });
  sms.sort((a, b) => b.at.localeCompare(a.at));
  // the courier's words, « state · situation » (a word that is only our status, as « alert », is not the courier's)
  const words = (o.ext_status && o.ext_status !== f ? String(o.ext_status) : f ? word(kind, f) : '').split(' · ');
  return {
    state: words[0] || null,
    color: f ? STEP_COLOR[f] ?? null : null,
    situation: words[1] ?? (f === 'failed' || f === 'alert' ? 'Client injoignable' : null),
    livreur: f && ['out_for_delivery', 'failed', 'delivered', 'alert'].includes(f) ? { name: `${lv[0]} ${lv[1]}`, phone: lv[2], hub: hub(num(o.wilaya_id)) } : null,
    risk: { score, level: score >= 40 ? 'high' : score >= 15 ? 'medium' : 'low', orders, returns },
    canModify: onRoad,
    canChangePhone: onRoad,
    pendingChange: changes.some((c: any) => c.status === 'pending' && c.kind !== 'phone'),
    modifications: changes.filter((c: any) => c.kind !== 'phone' && ['pending', 'approved'].includes(c.status)).length,
    modificationLimit: 2,
    phoneChanges: changes.filter((c: any) => c.kind === 'phone' && c.status === 'approved').length,
    phoneChangeLimit: 1,
    phoneChangePrice: 50,
    delivery: { type: o.is_stopdesk ? 'pickup-point' : 'home', hub: o.is_stopdesk ? o.sd_name ?? null : null, city: wilayaName(num(o.wilaya_id)), district: o.commune ?? null, street: o.address ?? null },
    amount: num(o.total),
    deliveryPrice: null,
    returnPrice: null,
    history,
    sms,
  };
}

// ---------------------------------------------------------------- applying an accepted request to the order
/** The order's new values once the courier accepted (its total, place or phone), with a line in its history. */
async function applyChange(ctx: Ctx, ch: any) {
  const n = parseJson(ch.new) as ChangeValues;
  await ctx.db.tx(async (tx) => {
    const o = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [ch.order_id]))[0];
    if (!o) return;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length + 1}`);
    };
    if (n.amount != null && n.amount !== num(o.total)) {
      // a lower price is a discount; a higher one goes on the delivery fee
      const s = num(o.subtotal);
      const fee = num(o.delivery_fee);
      if (n.amount <= s + fee) put('discount', s + fee - n.amount);
      else {
        put('discount', 0);
        put('delivery_fee', n.amount - s);
      }
      put('total', n.amount);
    }
    if (ch.kind === 'delivery' || ch.kind === 'address') {
      if (n.stopdesk !== undefined) {
        put('is_stopdesk', !!n.stopdesk);
        put('stopdesk_id', n.stopdesk ? n.stopdeskId ?? null : null);
      }
      if (n.wilayaId) put('wilaya_id', n.wilayaId);
      if (n.commune !== undefined) put('commune', n.commune);
      if (n.address !== undefined) put('address', n.address);
    }
    if (ch.kind === 'phone' && n.phone) {
      put('phone', n.phone);
      if (n.phone2 !== undefined) put('phone2', n.phone2);
    }
    if (sets.length) await tx.query(`UPDATE orders SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE id = $1`, [ch.order_id, ...vals]);
    await tx.query('UPDATE parcel_changes SET applied_at = now() WHERE id = $1', [ch.id]);
    await addEvent(tx, num(ch.order_id), ctx.session.profile.id, 'edit', null, null, `Modification acceptée par ${ch.company_name ?? 'la société'} : ${describe(ch.kind, parseJson(ch.old), n)}`);
  });
  ctx.emit({ type: 'order', id: num(ch.order_id) });
}

const da = (v: number | undefined) => (v == null ? '—' : `${new Intl.NumberFormat('fr-FR').format(v)} DA`);
/** "Prix 5 150 DA → 4 800 DA", "Domicile → Stop desk ZR Kouba"… (French: the order's history). */
export function describe(kind: ChangeKind, o: ChangeValues, n: ChangeValues): string {
  const place = (v: ChangeValues) =>
    v.stopdesk ? `Stop desk ${v.stopdeskName ?? ''}`.trim() : `Domicile ${[wilayaName(v.wilayaId), v.commune, v.address].filter(Boolean).join(', ')}`.trim();
  const amount = n.amount != null && n.amount !== o.amount ? ` · prix ${da(o.amount)} → ${da(n.amount)}` : '';
  if (kind === 'amount') return `prix ${da(o.amount)} → ${da(n.amount)}`;
  if (kind === 'phone') return `téléphone ${o.phone ?? '—'} → ${n.phone ?? '—'}${n.phone2 ? ` (2e : ${n.phone2})` : ''}`;
  if (kind === 'delivery') return `${place(o)} → ${place(n)}${amount}`;
  return `adresse ${[wilayaName(o.wilayaId), o.commune, o.address].filter(Boolean).join(', ')} → ${[wilayaName(n.wilayaId), n.commune, n.address].filter(Boolean).join(', ')}${amount}`;
}

/** The courier's answers to the requests still waiting (one order, or all); accepted ones are applied to the order.
 *  The preview accepts a request half a minute after it was sent. */
async function syncChanges(ctx: Ctx, orderId?: number) {
  const pending = await ctx.db.query(
    `SELECT ch.*, c.name AS company_name FROM parcel_changes ch JOIN delivery_companies c ON c.id = ch.company_id
     WHERE ch.status = 'pending' ${orderId ? 'AND ch.order_id = $1' : ''} ORDER BY ch.created_at LIMIT 200`,
    orderId ? [orderId] : [],
  );
  let changed = 0;
  const byCompany = new Map<number, any[]>();
  for (const p of pending) byCompany.set(num(p.company_id), [...(byCompany.get(num(p.company_id)) ?? []), p]);
  for (const [companyId, list] of byCompany) {
    let states: ChangeState[];
    if (isDemo(ctx)) states = list.filter((p) => Date.now() - Date.parse(iso(p.created_at)) > 30_000).map((p) => ({ extId: p.ext_id, approved: true, answer: null, at: new Date().toISOString() }));
    else {
      try {
        states = (await courier(ctx, 'changeStates', { companyId, extIds: list.filter((p) => p.ext_id).map((p) => p.ext_id) })) as ChangeState[];
      } catch {
        continue;
      }
    }
    for (const s of states) {
      const p = list.find((x) => x.ext_id === s.extId);
      if (!p) continue;
      await ctx.db.query('UPDATE parcel_changes SET synced_at = now() WHERE id = $1', [p.id]);
      if (s.approved === null) continue;
      changed++;
      await ctx.db.query(`UPDATE parcel_changes SET status = $2, answer = $3, decided_at = COALESCE($4::timestamptz, now()) WHERE id = $1`, [p.id, s.approved ? 'approved' : 'refused', s.answer, s.at]);
      if (s.approved) await applyChange(ctx, p);
      else await addEvent(ctx.db, num(p.order_id), ctx.session.profile.id, 'note', null, null, `Modification refusée par ${p.company_name}${s.answer ? ` : ${s.answer}` : ''} (${describe(p.kind, parseJson(p.old), parseJson(p.new))})`);
    }
  }
  return { changed };
}
export { syncChanges };

const ChangeIn = z.object({
  orderId: id,
  kind: z.enum(['amount', 'delivery', 'address', 'phone']),
  amount: z.number().int().min(0).max(10_000_000).optional(),
  stopdesk: z.boolean().optional(),
  stopdeskId: id.nullable().optional(),
  wilayaId: z.number().int().min(1).max(69).optional(),
  commune: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(30).optional(),
  phone2: z.string().trim().max(30).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const parcelsProcs = {
  /** The parcel at its courier: journey, SMS, livreur, return risk, what can still change, and the requests made. */
  'parcel.info': proc(['suivi', 'depot', 'confirmation'], z.object({ orderId: id }), async (ctx, { orderId }) => {
    const o = await parcelOf(ctx.db, orderId);
    const changes = (await ctx.db.query(`${CHANGES_SQL} WHERE ch.order_id = $1 ORDER BY ch.created_at DESC`, [orderId])).map(toChange);
    const back = (await ctx.db.query('SELECT tracking FROM parcel_returns WHERE order_id = $1', [orderId]))[0];
    const base = { companyId: numOrNull(o.company_id), companyName: (o.company_name as string | null) ?? null, returnTracking: (back?.tracking as string | undefined) ?? null, changes };
    if (!servesFrom(o)) return { ...base, supported: false, info: null as ParcelInfo | null, error: null as string | null };
    if (isDemo(ctx)) return { ...base, supported: true, info: await demoInfo(ctx.db, o), error: null };
    try {
      const info = (await courier(ctx, 'parcel', { companyId: num(o.company_id), item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id ?? null } })) as ParcelInfo;
      return { ...base, supported: true, info, error: null };
    } catch (e: any) {
      return { ...base, supported: true, info: null, error: (e?.message as string) ?? 'Erreur' };
    }
  }),

  /** Sends a modification request to the courier (a phone change is applied at once). */
  'parcel.change': proc(['suivi'], ChangeIn, async (ctx, i) => {
    const o = await parcelOf(ctx.db, i.orderId);
    if (!servesFrom(o)) throw bad('Ce colis n’est pas chez une société qui accepte les demandes de modification depuis Pilotix');
    if (o.follow_status && FOLLOW_FINAL.includes(o.follow_status)) throw bad('Colis terminé : plus de modification possible');
    if (i.kind !== 'phone' && (await ctx.db.query(`SELECT 1 FROM parcel_changes WHERE order_id = $1 AND status = 'pending' AND kind <> 'phone'`, [o.id]))[0])
      throw bad('Une demande attend déjà la réponse de la société pour ce colis');
    const old: ChangeValues = {
      amount: num(o.total),
      stopdesk: !!o.is_stopdesk,
      stopdeskId: numOrNull(o.stopdesk_id),
      stopdeskName: o.sd_name ?? null,
      wilayaId: num(o.wilaya_id),
      commune: o.commune ?? '',
      address: o.address ?? '',
      phone: o.phone,
      phone2: o.phone2 ?? null,
    };
    const next: ChangeValues = {};
    const input: ChangeInput = { item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id ?? null }, kind: i.kind };
    if (i.kind === 'amount') {
      if (i.amount == null) throw bad('Le nouveau montant manque');
      if (i.amount === num(o.total)) throw bad('C’est déjà le montant à encaisser');
      next.amount = input.amount = i.amount;
    } else if (i.kind === 'phone') {
      const phone = normalizePhone(i.phone ?? '');
      if (!phone) throw bad('Numéro de téléphone algérien invalide');
      const phone2 = i.phone2 ? normalizePhone(i.phone2) : null;
      if (i.phone2 && !phone2) throw bad('Deuxième numéro invalide');
      next.phone = input.phone = phone;
      next.phone2 = input.phone2 = phone2;
    } else {
      const stopdesk = i.kind === 'delivery' ? !!i.stopdesk : !!o.is_stopdesk;
      if (i.kind === 'address' && stopdesk) throw bad('Colis livré en stop desk : changez plutôt le bureau (Domicile ↔ Stop desk)');
      if (stopdesk) {
        const sd = i.stopdeskId ? (await ctx.db.query('SELECT id, name, ext_id, wilaya_id, commune FROM stopdesks WHERE id = $1 AND company_id = $2', [i.stopdeskId, o.company_id]))[0] : null;
        if (!sd) throw bad('Choisissez le bureau (stop desk)');
        if (!isDemo(ctx) && !sd.ext_id) throw bad(`Ce bureau n’a pas d’identifiant chez ${o.company_name} : réimportez ses stop desks`);
        Object.assign(next, { stopdesk: true, stopdeskId: num(sd.id), stopdeskName: sd.name, wilayaId: num(sd.wilaya_id), commune: sd.commune ?? '' });
        Object.assign(input, { stopdesk: true, hubExtId: sd.ext_id ?? null, wilayaId: num(sd.wilaya_id), commune: sd.commune ?? '' });
      } else {
        if (!i.wilayaId || !i.commune) throw bad('Choisissez la wilaya et la commune');
        Object.assign(next, { stopdesk: false, stopdeskId: null, wilayaId: i.wilayaId, commune: i.commune, address: i.address ?? '' });
        Object.assign(input, { stopdesk: false, wilayaId: i.wilayaId, commune: i.commune, address: i.address ?? '' });
      }
      if (i.amount != null && i.amount !== num(o.total)) next.amount = input.amount = i.amount;
      if (i.kind === 'delivery' && !!o.is_stopdesk === stopdesk && (!stopdesk || num(o.stopdesk_id) === next.stopdeskId)) throw bad(stopdesk ? 'C’est déjà ce bureau' : 'Le colis est déjà livré à domicile');
    }
    let extId: string | null = null;
    let approved: boolean | null = null;
    if (isDemo(ctx)) {
      extId = `demo-change-${Date.now()}`;
      approved = i.kind === 'phone' ? true : null;
    } else {
      const r = (await courier(ctx, 'change', { companyId: num(o.company_id), orderId: num(o.id), change: input })) as { extId: string; approved: boolean | null };
      extId = r.extId;
      approved = r.approved;
    }
    const ins = await ctx.db.query(
      `INSERT INTO parcel_changes (order_id, company_id, ext_id, kind, old, new, status, note, created_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [o.id, o.company_id, extId, i.kind, JSON.stringify(old), JSON.stringify(next), approved ? 'approved' : 'pending', i.note ?? null, ctx.session.profile.id, approved ? new Date().toISOString() : null],
    );
    const row = { ...ins[0], company_name: o.company_name };
    await addEvent(ctx.db, num(o.id), ctx.session.profile.id, 'note', null, null, `Demande de modification envoyée à ${o.company_name} : ${describe(i.kind, old, next)}${i.note ? ` (${i.note})` : ''}`);
    if (approved) await applyChange(ctx, row);
    ctx.emit({ type: 'order', id: num(o.id) });
    return toChange((await ctx.db.query(`${CHANGES_SQL} WHERE ch.id = $1`, [row.id]))[0]);
  }),

  /** The courier's answers to the requests still waiting (one order, or every one). */
  'parcel.changeSync': proc(['suivi', 'depot'], z.object({ orderId: id.optional() }), async (ctx, i) => syncChanges(ctx, i.orderId)),

  /** Withdraws a request the courier has not answered yet. */
  'parcel.changeCancel': proc(['suivi'], z.object({ id }), async (ctx, i) => {
    const ch = (await ctx.db.query(`SELECT ch.*, c.name AS company_name FROM parcel_changes ch JOIN delivery_companies c ON c.id = ch.company_id WHERE ch.id = $1`, [i.id]))[0];
    if (!ch) throw notFound('Demande introuvable');
    if (ch.status !== 'pending') throw bad('La société a déjà répondu à cette demande');
    if (!isDemo(ctx) && ch.ext_id) await courier(ctx, 'changeCancel', { companyId: num(ch.company_id), extId: ch.ext_id });
    await ctx.db.query(`UPDATE parcel_changes SET status = 'cancelled', decided_at = now() WHERE id = $1`, [ch.id]);
    await addEvent(ctx.db, num(ch.order_id), ctx.session.profile.id, 'note', null, null, `Demande de modification retirée (${describe(ch.kind, parseJson(ch.old), parseJson(ch.new))})`);
    ctx.emit({ type: 'order', id: num(ch.order_id) });
    return { ok: true };
  }),
};
