// Dépôt alerts: when someone outside the depot changes (products, address, phone, amount…) or cancels an order the depot
// still holds (à préparer / préparée), the depot agents get a red alert, with a sound, that blocks their app until one of
// them says « C'est corrigé » (the parcel was opened / relabelled / put aside). Edits made by the depot itself don't alert.
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { Ctx, notFound, proc } from '../rpc';

export const DEPOT_STAGES = ['to_prepare', 'prepared'];
export interface DepotChange {
  field: 'items' | 'customer' | 'phone' | 'phone2' | 'place' | 'address' | 'company' | 'total' | 'note';
  from: string;
  to: string;
}

/** Does this change concern the depot? (the order is still there, and the change comes from outside the depot) */
export const alertsDepot = (ctx: Ctx, followStatus: string | null) => !!followStatus && DEPOT_STAGES.includes(followStatus) && (ctx.session.isAdmin || !ctx.session.roles.includes('depot'));

export const itemsText = (rows: { name: string; variant_title?: string; variantTitle?: string; qty: number | string }[]) =>
  rows.map((r) => `${Number(r.qty) > 1 ? `${r.qty} × ` : ''}${r.name}${(r.variant_title ?? r.variantTitle) ? ` (${r.variant_title ?? r.variantTitle})` : ''}`).join(' + ') || '—';

/** One open alert per order: new changes are added to it (an older change to the same thing keeps its first « avant »). */
export async function addDepotAlert(db: Db, ctx: Ctx, orderId: number, stage: string, kind: 'edit' | 'cancel', changes: DepotChange[]) {
  if (kind === 'edit' && !changes.length) return;
  const open = (await db.query('SELECT id, kind, changes FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1', [orderId]))[0];
  if (open) {
    const was = (typeof open.changes === 'string' ? JSON.parse(open.changes) : open.changes ?? []) as DepotChange[];
    const merged = [...was];
    for (const c of changes) {
      const k = merged.findIndex((x) => x.field === c.field);
      if (k >= 0) merged[k] = { ...merged[k], to: c.to };
      else merged.push(c);
    }
    const kept = merged.filter((c) => c.from !== c.to);
    await db.query('UPDATE depot_alerts SET kind = $2, changes = $3, created_by = $4, created_at = now() WHERE id = $1', [open.id, kind === 'cancel' ? 'cancel' : open.kind, JSON.stringify(kept), ctx.session.profile.id]);
  } else {
    await db.query('INSERT INTO depot_alerts (order_id, kind, stage, changes, created_by) VALUES ($1,$2,$3,$4,$5)', [orderId, kind, stage, JSON.stringify(changes), ctx.session.profile.id]);
  }
}

const id = z.number().int().positive();
export const depotAlertProcs = {
  /** The open alerts (the depot app shows them in red, above everything, until « C'est corrigé »). */
  'depot.alerts': proc(['depot'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT a.*, o.ref, o.customer_name, o.phone, o.follow_status, o.total, o.tracking, o.own_tracking, p.name AS by_name,
              (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name || CASE WHEN i.variant_title <> '' THEN ' (' || i.variant_title || ')' ELSE '' END, ' + ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items
       FROM depot_alerts a JOIN orders o ON o.id = a.order_id LEFT JOIN profiles p ON p.id = a.created_by
       WHERE a.resolved_at IS NULL ORDER BY a.created_at`,
    );
    return rows.map((r: any) => ({
      id: num(r.id),
      orderId: num(r.order_id),
      ref: r.ref as string,
      kind: r.kind as 'edit' | 'cancel',
      stage: (r.stage ?? null) as string | null,
      status: (r.follow_status ?? null) as string | null,
      customer: r.customer_name as string,
      phone: r.phone as string,
      items: (r.items ?? '') as string,
      total: num(r.total),
      tracking: (r.tracking ?? r.own_tracking ?? null) as string | null,
      changes: (typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes ?? []) as DepotChange[],
      byName: (r.by_name ?? null) as string | null,
      at: iso(r.created_at),
    }));
  }),

  /** « C'est corrigé »: the depot fixed the parcel (or put it aside for a cancelled order). */
  'depot.alertDone': proc(['depot'], z.object({ id }), async (ctx, i) => {
    const r = await ctx.db.query('UPDATE depot_alerts SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING order_id', [i.id, ctx.session.profile.id]);
    if (!r.length) {
      const any = (await ctx.db.query('SELECT 1 FROM depot_alerts WHERE id = $1', [i.id]))[0];
      if (!any) throw notFound('Alerte introuvable');
      return { ok: true };
    }
    const { addEvent } = await import('./orders');
    await addEvent(ctx.db, num(r[0].order_id), ctx.session.profile.id, 'note', null, null, 'Dépôt : changement pris en compte (colis corrigé)');
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
};
