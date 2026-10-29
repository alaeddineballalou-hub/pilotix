// The two checks before an order is confirmed (one or many at once):
//  1. every product can go: switched on (product and variant), and in stock — what is left after the orders already
//     confirmed (« sans stock » ones included: they wait first, oldest first). A product with 0 left is not a blocker:
//     the order is confirmed « sans stock » and waits. A product switched off is: change it or cancel the order.
//  2. we deliver there: wilaya, commune (home), and the company — the order's, the bureau's, or the
//     default one — serves that wilaya at home / at a bureau (a courier with a tariff needs a price there; own
//     delivery men, manual companies and companies without a tariff always do). No company yet: one of them must.
// The order card asks the same question (orders.confirmCheck) before the agent presses « Confirmer ».
import { WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num } from '../db';
import { proc } from '../rpc';
import { getSetting } from '../settings';

export type LineState = 'ok' | 'empty' | 'off';
export interface CheckLine {
  productId: number;
  variantId: number | null;
  qty: number;
}
export interface LineCheck {
  productId: number;
  variantId: number | null;
  name: string;
  state: LineState;
  /** what is left for this order (null: a service, no stock) */
  available: number | null;
}
export type DeliverWhy = 'wilaya' | 'commune' | 'desk' | 'company' | 'nobody';
export interface DeliverCheck {
  ok: boolean;
  why: DeliverWhy | null;
  companyId: number | null;
  companyName: string | null;
  wilayaId: number | null;
  desk: boolean;
}

/** Each cart line: off (product or variant switched off), ok, or empty (not enough left for it). */
export async function checkLines(db: Db, lines: CheckLine[], orderId: number | null): Promise<LineCheck[]> {
  const pids = [...new Set(lines.map((l) => l.productId))];
  if (!pids.length) return [];
  const P = new Map((await db.query('SELECT id, name, active, is_service FROM products WHERE id = ANY($1)', [pids])).map((p: any) => [num(p.id), p]));
  const V = (await db.query('SELECT id, product_id, title, active FROM product_variants WHERE product_id = ANY($1)', [pids])).map((v: any) => ({
    id: num(v.id),
    productId: num(v.product_id),
    title: (v.title as string) ?? '',
    active: !!v.active,
  }));
  const left = new Map<number, number>();
  const vids = V.map((v) => v.id);
  if (vids.length) {
    const st = await db.query(
      `SELECT s.variant_id, sum(s.qty)::int AS n FROM stock s JOIN warehouses w ON w.id = s.warehouse_id AND w.active WHERE s.variant_id = ANY($1) GROUP BY 1`,
      [vids],
    );
    for (const s of st) left.set(num(s.variant_id), num(s.n));
    const promised = await db.query(
      `SELECT i.variant_id, sum(i.qty)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.variant_id = ANY($1) AND o.id <> $2 AND o.conf_status IN ('confirmed','no_stock')
          AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared'))
        GROUP BY 1`,
      [vids, orderId ?? 0],
    );
    for (const r of promised) left.set(num(r.variant_id), (left.get(num(r.variant_id)) ?? 0) - num(r.n));
  }
  // what the cart needs: the same variant on two lines counts together (a line without a variant: the product's)
  const need = new Map<string, number>();
  const keyOf = (l: CheckLine) => (l.variantId ? `v${l.variantId}` : `p${l.productId}`);
  for (const l of lines) need.set(keyOf(l), (need.get(keyOf(l)) ?? 0) + l.qty);
  return lines.map((l) => {
    const p: any = P.get(l.productId);
    const v = l.variantId ? V.find((x) => x.id === l.variantId) : undefined;
    const name = p ? `${p.name}${v?.title ? ` ${v.title}` : ''}` : `#${l.productId}`;
    const base = { productId: l.productId, variantId: l.variantId, name };
    if (!p || !p.active || (l.variantId && (!v || !v.active))) return { ...base, state: 'off' as const, available: null };
    if (p.is_service) return { ...base, state: 'ok' as const, available: null };
    const ids = l.variantId ? [l.variantId] : V.filter((x) => x.productId === l.productId && x.active).map((x) => x.id);
    const avail = ids.reduce((n, i) => n + (left.get(i) ?? 0), 0);
    return { ...base, state: avail >= (need.get(keyOf(l)) ?? l.qty) ? ('ok' as const) : ('empty' as const), available: Math.max(0, avail) };
  });
}

/** Does a company serve this wilaya (at home / at a bureau)? Own delivery men, manual companies and companies without a tariff always do. */
async function serves(db: Db, companyId: number, wilayaId: number, desk: boolean): Promise<{ ok: boolean; name: string | null }> {
  const c = (
    await db.query(
      `SELECT c.name, c.kind, c.active, (SELECT count(*)::int FROM delivery_fees f WHERE f.company_id = c.id) AS n,
              (SELECT f.home FROM delivery_fees f WHERE f.company_id = c.id AND f.wilaya_id = $2) AS home,
              (SELECT f.desk FROM delivery_fees f WHERE f.company_id = c.id AND f.wilaya_id = $2) AS desk
         FROM delivery_companies c WHERE c.id = $1`,
      [companyId, wilayaId],
    )
  )[0];
  if (!c) return { ok: false, name: null };
  const free = c.kind === 'own' || c.kind === 'manual' || num(c.n) === 0;
  return { ok: !!c.active && (free || num(desk ? c.desk : c.home) > 0), name: c.name as string };
}

/** Can this order be delivered where it says? */
export async function deliverCheck(
  db: Db,
  o: { wilayaId: number | null; commune: string | null; isStopdesk: boolean; stopdeskId: number | null; companyId: number | null },
): Promise<DeliverCheck> {
  const base = { companyId: null as number | null, companyName: null as string | null, wilayaId: o.wilayaId, desk: o.isStopdesk };
  if (!o.wilayaId) return { ...base, ok: false, why: 'wilaya' };
  if (!o.isStopdesk && !String(o.commune ?? '').trim()) return { ...base, ok: false, why: 'commune' };
  let companyId = o.companyId;
  // a bureau chosen: its company (a bureau not chosen yet: the order's company must have bureaus there)
  if (o.isStopdesk && o.stopdeskId) {
    const d = (await db.query('SELECT company_id FROM stopdesks WHERE id = $1', [o.stopdeskId]))[0];
    if (!d) return { ...base, ok: false, why: 'desk' };
    companyId = num(d.company_id);
  }
  companyId = companyId ?? (await getSetting(db, 'shop')).defaultCompanyId ?? null;
  if (companyId) {
    const s = await serves(db, companyId, o.wilayaId, o.isStopdesk);
    return { ...base, companyId, companyName: s.name, ok: s.ok, why: s.ok ? null : 'company' };
  }
  // no company yet (it gets one later): one of the active companies must deliver there
  const all = await db.query('SELECT id FROM delivery_companies WHERE active');
  for (const c of all) if ((await serves(db, num(c.id), o.wilayaId, o.isStopdesk)).ok) return { ...base, ok: true, why: null };
  return { ...base, ok: !all.length, why: all.length ? 'nobody' : null };
}

const wilayaName = (id: number | null) => (id ? `${String(id).padStart(2, '0')} ${WILAYAS[id - 1] ?? ''}`.trim() : '');

/** Why this order cannot be confirmed (null: it can), in the agent's words; `ref` '' for an order not saved yet. */
export function blockerText(ref: string, lines: LineCheck[], d: DeliverCheck): string | null {
  const pre = ref ? `${ref} : ` : '';
  if (!lines.length) return `${pre}ajoutez au moins un produit avant de confirmer.`;
  const off = lines.find((l) => l.state === 'off');
  if (off) return `${pre}« ${off.name} » est indisponible. Changez le produit ou annulez la commande.`;
  if (d.ok) return null;
  const mode = d.desk ? 'au bureau' : 'à domicile';
  switch (d.why) {
    case 'wilaya':
      return `${pre}choisissez la wilaya avant de confirmer.`;
    case 'commune':
      return `${pre}indiquez la commune avant de confirmer.`;
    case 'desk':
      return `${pre}choisissez le bureau (stop-desk) avant de confirmer.`;
    case 'company':
      return `${pre}${d.companyName ?? 'la société'} ne livre pas ${mode} à ${wilayaName(d.wilayaId)}. Changez la société ou le mode de livraison.`;
    default:
      return `${pre}aucune société ne livre ${mode} à ${wilayaName(d.wilayaId)}.`;
  }
}

/** The checks of a saved order (setConf runs them on each order it confirms). */
export async function checkOrder(db: Db, orderId: number) {
  const o = (await db.query('SELECT ref, wilaya_id, commune, is_stopdesk, stopdesk_id, company_id FROM orders WHERE id = $1', [orderId]))[0];
  const items = await db.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  const lines = await checkLines(
    db,
    items.filter((i: any) => i.product_id).map((i: any) => ({ productId: num(i.product_id), variantId: i.variant_id ? num(i.variant_id) : null, qty: num(i.qty) })),
    orderId,
  );
  const deliver = await deliverCheck(db, {
    wilayaId: o?.wilaya_id ? num(o.wilaya_id) : null,
    commune: o?.commune ?? null,
    isStopdesk: !!o?.is_stopdesk,
    stopdeskId: o?.stopdesk_id ? num(o.stopdesk_id) : null,
    companyId: o?.company_id ? num(o.company_id) : null,
  });
  return { lines, deliver, blocker: blockerText(o?.ref ?? `#${orderId}`, lines, deliver), noStock: lines.some((l) => l.state === 'empty') };
}

const id = z.number().int().positive();
export const confirmCheckProcs = {
  /** The order card's question before « Confirmer »: each product's state, and whether we deliver there (the cart and the place as they are on screen, saved or not). */
  'orders.confirmCheck': proc(
    ['confirmation'],
    z.object({
      id: id.nullable().optional(),
      items: z.array(z.object({ productId: id, variantId: id.nullable(), qty: z.number().int().min(1).max(9999) })).max(60),
      wilayaId: z.number().int().min(1).max(69).nullable(),
      commune: z.string().max(120).nullable().optional(),
      isStopdesk: z.boolean(),
      stopdeskId: id.nullable().optional(),
      companyId: id.nullable().optional(),
    }),
    async (ctx, i) => {
      const lines = await checkLines(ctx.db, i.items, i.id ?? null);
      const deliver = await deliverCheck(ctx.db, { wilayaId: i.wilayaId, commune: i.commune ?? null, isStopdesk: i.isStopdesk, stopdeskId: i.stopdeskId ?? null, companyId: i.companyId ?? null });
      const off = lines.some((l) => l.state === 'off');
      return { lines, deliver, off, noStock: lines.some((l) => l.state === 'empty'), canConfirm: lines.length > 0 && !off && deliver.ok };
    },
  ),
};
