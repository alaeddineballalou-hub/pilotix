// Catalog, stock and depot: products & variants, stock per depot, movements, picking, returns and the parcel scanner.
import { normalizePhone, Order, Page, Pack, StockRow, Warehouse } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull, Where } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { getOrder, ordersProcs, setFollow } from './orders';
import { RESERVED } from './stockquery';

// ---------------------------------------------------------------- types
export interface CatalogVariant {
  id: number;
  productId: number;
  title: string;
  sku: string;
  price: number | null;
  active: boolean;
}
export interface Part {
  name: string;
  max: number | null;
}
export interface CatalogProduct {
  id: number;
  name: string;
  sku: string;
  price: number;
  cost: number;
  weightKg: number;
  photo: string | null;
  isService: boolean;
  active: boolean;
  fixedPrice: boolean;
  maxDiscount: number | null;
  packs: Pack[];
  linked: number[];
  parts: Part[];
  feeGrid: string | null;
  variants: CatalogVariant[];
}
export interface StockLine extends StockRow {
  productActive: boolean;
  variantActive: boolean;
}
export interface Movement {
  id: number;
  at: string;
  variantId: number;
  label: string;
  sku: string;
  warehouseId: number;
  warehouseName: string;
  delta: number;
  reason: string;
  orderId: number | null;
  orderRef: string | null;
  userName: string | null;
  note: string | null;
  /** the purchase (ACH-…) or the inventory (INV-…) that made this movement */
  purchaseId: number | null;
  purchaseRef: string | null;
  inventoryRef: string | null;
}
export interface PickingRow {
  variantId: number | null;
  productId: number;
  label: string;
  toPrepare: number;
  prepared: number;
  orders: number;
  /** orders still in preparation / already pushed to dispatch that contain this product */
  toPrepareOrders: number;
  preparedOrders: number;
  stock: number;
}
export interface ScanResult {
  kind: 'ok' | 'bad' | 'warn' | 'pick';
  code: string;
  why: string;
  fix?: string;
  order?: Order | null;
  list?: Order[];
  /** what was finally done: dispatch / return / exchange */
  did?: 'dispatch' | 'return' | 'exchange';
}

const id = z.number().int().positive();
const label = (name: string, title: string | null | undefined) => (title ? `${name} ${title}` : name);
/** Courier kinds whose own label (tracking) must be on the parcel: the Pilotix label is not enough. */
export const API_COURIERS = ['zr', 'zr_legacy', 'yalidine', 'ecotrack', 'noest', 'custom'];
/** Orders with these statuses already left the depot. */
const LEFT = ['shipped', 'out_for_delivery', 'delivered', 'failed', 'alert', 'in_exchange', 'returning', 'returned', 'exchanged', 'lost'];

// ---------------------------------------------------------------- reading
function toProduct(p: any, vars: any[]): CatalogProduct {
  const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? []);
  return {
    id: num(p.id),
    name: p.name,
    sku: p.sku,
    price: num(p.price),
    cost: num(p.cost),
    weightKg: Number(p.weight_kg),
    photo: p.photo ?? null,
    isService: !!p.is_service,
    active: !!p.active,
    fixedPrice: !!p.fixed_price,
    maxDiscount: numOrNull(p.max_discount),
    packs: j(p.packs),
    linked: (p.linked ?? []).map(num),
    parts: j(p.parts),
    feeGrid: p.fee_grid ?? null,
    variants: vars.map((v) => ({ id: num(v.id), productId: num(v.product_id), title: v.title, sku: v.sku, price: numOrNull(v.price), active: !!v.active })),
  };
}

export async function listProducts(db: Db, opts: { ids?: number[]; q?: string; activeOnly?: boolean } = {}): Promise<CatalogProduct[]> {
  const w = new Where();
  if (opts.ids) w.add('p.id = ANY(?)', opts.ids);
  if (opts.activeOnly) w.add('p.active');
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    w.add(`(p.name ILIKE '%' || ? || '%' OR p.sku ILIKE ? || '%' OR EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND (x.title ILIKE '%' || ? || '%' OR x.sku ILIKE ? || '%')))`, q, q, q, q);
  }
  const rows = await db.query(`SELECT p.* FROM products p ${w.sql} ORDER BY p.active DESC, lower(p.name), p.id`, w.params);
  if (!rows.length) return [];
  const vars = await db.query('SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY id', [rows.map((r: any) => num(r.id))]);
  const by = new Map<number, any[]>();
  for (const v of vars) {
    const k = num(v.product_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(v);
  }
  return rows.map((p: any) => toProduct(p, by.get(num(p.id)) ?? []));
}

export async function defaultWarehouse(db: Db): Promise<number | null> {
  const r = await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1');
  return r[0] ? num(r[0].id) : null;
}


export const StockInput = z.object({
  q: z.string().max(100).optional(),
  missingOnly: z.boolean().default(false),
  withHidden: z.boolean().default(false),
  warehouseId: id.optional(),
  variantIds: z.array(id).max(500).optional(),
});

export async function stockRows(db: Db, f: z.infer<typeof StockInput>): Promise<StockLine[]> {
  const w = new Where();
  w.add('NOT p.is_service');
  w.add('wh.active');
  w.add('(s.variant_id IS NOT NULL OR wh.id = (SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1) OR COALESCE(r.n, 0) <> 0)');
  if (f.warehouseId) w.add('wh.id = ?', f.warehouseId);
  if (f.variantIds) w.add('v.id = ANY(?)', f.variantIds);
  if (!f.withHidden) w.add('((p.active AND v.active) OR COALESCE(s.qty, 0) <> 0 OR COALESCE(r.n, 0) <> 0)');
  if (f.q?.trim()) {
    const q = f.q.trim();
    w.add(`((p.name || ' ' || v.title) ILIKE '%' || ? || '%' OR v.sku ILIKE '%' || ? || '%' OR p.sku ILIKE '%' || ? || '%')`, q, q, q);
  }
  if (f.missingOnly) w.add('COALESCE(s.qty, 0) - COALESCE(r.n, 0) <= COALESCE(s.alert_qty, 0)');
  const rows = await db.query(
    `WITH r AS (${RESERVED})
     SELECT v.id AS variant_id, p.id AS product_id, p.name, v.title, v.sku, wh.id AS wid, wh.name AS wname,
            COALESCE(s.qty, 0) AS qty, COALESCE(s.alert_qty, 0) AS alert_qty, COALESCE(r.n, 0) AS reserved, p.cost, p.active AS pactive, v.active AS vactive
     FROM product_variants v JOIN products p ON p.id = v.product_id CROSS JOIN warehouses wh
     LEFT JOIN stock s ON s.variant_id = v.id AND s.warehouse_id = wh.id
     LEFT JOIN r ON r.variant_id = v.id AND r.wid = wh.id
     ${w.sql}
     ORDER BY lower(p.name), lower(v.title), v.id, wh.is_default DESC, wh.id LIMIT 5000`,
    w.params,
  );
  return rows.map((r: any) => {
    const qty = num(r.qty);
    const reserved = num(r.reserved);
    return {
      variantId: num(r.variant_id),
      productId: num(r.product_id),
      productName: r.name,
      variantTitle: r.title,
      sku: r.sku,
      warehouseId: num(r.wid),
      warehouseName: r.wname,
      qty,
      reserved,
      available: qty - reserved,
      alertQty: num(r.alert_qty),
      cost: num(r.cost),
      productActive: !!r.pactive,
      variantActive: !!r.vactive,
    };
  });
}

// ---------------------------------------------------------------- writing stock
/** Adds `delta` to the stock of a variant in a depot and writes the movement. Use inside a transaction. */
export async function moveStock(
  db: Db,
  a: { variantId: number; warehouseId: number; delta: number; reason: string; orderId?: number | null; userId: number | null; note?: string | null; purchaseId?: number | null; inventoryId?: number | null },
) {
  if (!a.delta) return;
  await db.query(
    `INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1,$2,$3)
     ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty`,
    [a.variantId, a.warehouseId, a.delta],
  );
  await db.query('INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, order_id, user_id, note, purchase_id, inventory_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    a.variantId, a.warehouseId, a.delta, a.reason, a.orderId ?? null, a.userId, a.note ?? null, a.purchaseId ?? null, a.inventoryId ?? null,
  ]);
}

async function ensureVariantAndDepot(db: Db, variantId: number, warehouseId: number) {
  const v = (await db.query('SELECT v.id, p.is_service FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1', [variantId]))[0];
  if (!v) throw notFound('Variante introuvable');
  if (v.is_service) throw bad('Un service n’a pas de stock');
  const w = (await db.query('SELECT id, active FROM warehouses WHERE id = $1', [warehouseId]))[0];
  if (!w) throw notFound('Dépôt introuvable');
  if (!w.active) throw bad('Ce dépôt est désactivé');
}

async function currentQty(db: Db, variantId: number, warehouseId: number) {
  return num((await db.query('SELECT qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [variantId, warehouseId]))[0]?.qty);
}

export const MoveInput = z.object({
  variantId: id,
  warehouseId: id,
  /** entry = arrival (+qty), count = inventory (qty is the counted quantity), loss = broken / lost (−qty) */
  kind: z.enum(['entry', 'count', 'loss']),
  qty: z.number().int().min(0).max(1_000_000),
  note: z.string().trim().max(300).nullable().optional(),
});

export async function stockMove(ctx: Ctx, i: z.infer<typeof MoveInput>) {
  if (i.kind !== 'count' && i.qty < 1) throw bad('Quantité invalide');
  const r = await ctx.db.tx(async (tx) => {
    await ensureVariantAndDepot(tx, i.variantId, i.warehouseId);
    const cur = await currentQty(tx, i.variantId, i.warehouseId);
    const delta = i.kind === 'entry' ? i.qty : i.kind === 'loss' ? -i.qty : i.qty - cur;
    await moveStock(tx, { variantId: i.variantId, warehouseId: i.warehouseId, delta, reason: i.kind, userId: ctx.session.profile.id, note: i.note });
    return { qty: cur + delta, delta };
  });
  ctx.emit({ type: 'stock' });
  return r;
}

export const TransferInput = z.object({ variantId: id, from: id, to: id, qty: z.number().int().min(1).max(1_000_000), note: z.string().trim().max(300).nullable().optional() });

export async function stockTransfer(ctx: Ctx, i: z.infer<typeof TransferInput>) {
  if (i.from === i.to) throw bad('Choisissez un autre dépôt');
  const r = await ctx.db.tx(async (tx) => {
    await ensureVariantAndDepot(tx, i.variantId, i.from);
    await ensureVariantAndDepot(tx, i.variantId, i.to);
    const have = await currentQty(tx, i.variantId, i.from);
    if (have < i.qty) throw bad(`Stock insuffisant dans ce dépôt (${have})`);
    const me = ctx.session.profile.id;
    await moveStock(tx, { variantId: i.variantId, warehouseId: i.from, delta: -i.qty, reason: 'transfer_out', userId: me, note: i.note });
    await moveStock(tx, { variantId: i.variantId, warehouseId: i.to, delta: i.qty, reason: 'transfer_in', userId: me, note: i.note });
    return { from: have - i.qty, to: await currentQty(tx, i.variantId, i.to) };
  });
  ctx.emit({ type: 'stock' });
  return r;
}

// ---------------------------------------------------------------- products
const PackInput = z.object({ qty: z.number().int().min(2).max(999), price: z.number().int().min(1).max(100_000_000) });
const VariantInput = z.object({
  id: id.optional(),
  title: z.string().trim().max(120),
  sku: z.string().trim().max(120).nullable().optional(),
  price: z.number().int().min(0).max(100_000_000).nullable().optional(),
  active: z.boolean().default(true),
});
export const ProductInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'Nom obligatoire').max(200),
  sku: z.string().trim().max(120).nullable().optional(),
  price: z.number().int().min(0).max(100_000_000),
  cost: z.number().int().min(0).max(100_000_000).default(0),
  weightKg: z.number().min(0).max(1000).default(1),
  photo: z.string().trim().max(1000).nullable().optional(),
  isService: z.boolean().default(false),
  active: z.boolean().default(true),
  fixedPrice: z.boolean().default(false),
  maxDiscount: z.number().int().min(0).max(100_000_000).nullable().optional(),
  packs: z.array(PackInput).max(20).default([]),
  linked: z.array(id).max(50).default([]),
  parts: z.array(z.object({ name: z.string().trim().min(1).max(120), max: z.number().int().min(1).max(999).nullable().optional() })).max(50).default([]),
  feeGrid: z.string().trim().max(80).nullable().optional(),
  variants: z.array(VariantInput).max(200).default([]),
});

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'P';

async function freeSku(db: Db, table: 'products' | 'product_variants', base: string, selfId?: number): Promise<string> {
  for (let k = 0; k < 200; k++) {
    const s = k ? `${base}-${k + 1}` : base;
    const r = await db.query(`SELECT id FROM ${table} WHERE sku = $1`, [s]);
    if (!r[0] || num(r[0].id) === selfId) return s;
  }
  return `${base}-${Date.now()}`;
}

export async function saveProduct(ctx: Ctx, i: z.infer<typeof ProductInput>): Promise<CatalogProduct> {
  const pid = await ctx.db.tx(async (tx) => {
    const cur = i.id ? (await tx.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [i.id]))[0] : null;
    if (i.id && !cur) throw notFound('Produit introuvable');
    const maxDiscount = i.maxDiscount === undefined ? (cur ? numOrNull(cur.max_discount) : 0) : i.maxDiscount;
    // Only the administrator decides how much discount agents may give.
    if (!ctx.session.isAdmin && (cur ? numOrNull(cur.max_discount) : 0) !== maxDiscount) throw forbidden('Seul l’administrateur modifie la remise maximale');
    let sku = i.sku?.trim() || '';
    if (sku) {
      const dup = (await tx.query('SELECT id FROM products WHERE sku = $1', [sku]))[0];
      if (dup && num(dup.id) !== i.id) throw bad(`Le SKU « ${sku} » est déjà utilisé`);
    } else sku = cur?.sku ?? (await freeSku(tx, 'products', slug(i.name)));
    const linked = [...new Set(i.linked)].filter((x) => x !== i.id);
    const vals = [i.name, sku, i.price, i.cost, i.weightKg, i.photo || null, i.isService, i.active, i.fixedPrice, maxDiscount, JSON.stringify(i.packs.sort((a, b) => a.qty - b.qty)), linked, JSON.stringify(i.parts.map((p) => ({ name: p.name, max: p.max ?? null }))), i.feeGrid || null];
    let productId: number;
    if (cur) {
      await tx.query(
        `UPDATE products SET name=$2, sku=$3, price=$4, cost=$5, weight_kg=$6, photo=$7, is_service=$8, active=$9, fixed_price=$10, max_discount=$11, packs=$12, linked=$13, parts=$14, fee_grid=$15 WHERE id=$1`,
        [i.id, ...vals],
      );
      productId = i.id!;
    } else {
      productId = num(
        (await tx.query(
          `INSERT INTO products (name, sku, price, cost, weight_kg, photo, is_service, active, fixed_price, max_discount, packs, linked, parts, fee_grid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          vals,
        ))[0].id,
      );
    }
    // Variants: rename / reprice / disable; never deleted (orders and stock point to them).
    const existing = await tx.query('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id', [productId]);
    const named = i.variants.filter((v) => v.title.trim() || v.id);
    for (const v of named) {
      let vsku = v.sku?.trim() || '';
      if (vsku) {
        const dup = (await tx.query('SELECT id FROM product_variants WHERE sku = $1', [vsku]))[0];
        if (dup && num(dup.id) !== v.id) throw bad(`Le SKU « ${vsku} » est déjà utilisé`);
      }
      if (v.id) {
        const old = existing.find((e: any) => num(e.id) === v.id);
        if (!old) throw bad('Variante d’un autre produit');
        await tx.query('UPDATE product_variants SET title=$2, sku=$3, price=$4, active=$5 WHERE id=$1', [v.id, v.title.trim(), vsku || old.sku, v.price ?? null, v.active]);
      } else {
        vsku ||= await freeSku(tx, 'product_variants', `${sku}-${slug(v.title).slice(0, 12)}`);
        await tx.query('INSERT INTO product_variants (product_id, title, sku, price, active) VALUES ($1,$2,$3,$4,$5)', [productId, v.title.trim(), vsku, v.price ?? null, v.active]);
      }
    }
    // A product always has at least one variant: the "no variant" one ('') when no named one is active.
    const after = await tx.query('SELECT id, title, active FROM product_variants WHERE product_id = $1', [productId]);
    const hasNamed = after.some((v: any) => v.title !== '' && v.active);
    const plain = after.find((v: any) => v.title === '');
    if (!hasNamed && !plain) await tx.query('INSERT INTO product_variants (product_id, title, sku) VALUES ($1, \'\', $2)', [productId, await freeSku(tx, 'product_variants', `${sku}-1`)]);
    else if (plain) await tx.query('UPDATE product_variants SET active = $2 WHERE id = $1', [plain.id, !hasNamed]);
    return productId;
  });
  ctx.emit({ type: 'stock' });
  return (await listProducts(ctx.db, { ids: [pid] }))[0];
}

// ---------------------------------------------------------------- depot
export async function picking(db: Db): Promise<PickingRow[]> {
  const rows = await db.query(
    `SELECT i.variant_id, p.id AS product_id, p.name, COALESCE(v.title, i.variant_title) AS title,
            sum(CASE WHEN o.follow_status = 'to_prepare' THEN i.qty ELSE 0 END)::int AS to_prep,
            sum(CASE WHEN o.follow_status = 'prepared' THEN i.qty ELSE 0 END)::int AS prepared,
            count(DISTINCT o.id)::int AS orders,
            count(DISTINCT CASE WHEN o.follow_status = 'to_prepare' THEN o.id END)::int AS to_prep_orders,
            count(DISTINCT CASE WHEN o.follow_status = 'prepared' THEN o.id END)::int AS prepared_orders,
            (SELECT COALESCE(sum(s.qty), 0)::int FROM stock s WHERE s.variant_id = i.variant_id) AS stock
     FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
     LEFT JOIN product_variants v ON v.id = i.variant_id
     WHERE o.conf_status = 'confirmed' AND o.follow_status IN ('to_prepare','prepared') AND NOT p.is_service
     GROUP BY i.variant_id, p.id, p.name, COALESCE(v.title, i.variant_title)
     ORDER BY lower(p.name), lower(COALESCE(v.title, i.variant_title))`,
  );
  return rows.map((r: any) => ({
    variantId: numOrNull(r.variant_id),
    productId: num(r.product_id),
    label: label(r.name, r.title),
    toPrepare: num(r.to_prep),
    prepared: num(r.prepared),
    orders: num(r.orders),
    toPrepareOrders: num(r.to_prep_orders),
    preparedOrders: num(r.prepared_orders),
    stock: num(r.stock),
  }));
}

export async function depotCounts(db: Db) {
  const r = await db.query(
    `SELECT follow_status AS k, count(*)::int AS n FROM orders
     WHERE (conf_status = 'confirmed' AND follow_status IN ('to_prepare','prepared','shipped','out_for_delivery')) OR follow_status IN ('returning','in_exchange')
     GROUP BY 1`,
  );
  const c = Object.fromEntries(r.map((x: any) => [x.k, num(x.n)]));
  return {
    preparer: c.to_prepare ?? 0,
    prepares: c.prepared ?? 0,
    dispatchees: c.shipped ?? 0,
    enlivraison: c.out_for_delivery ?? 0,
    retours: (c.returning ?? 0) + (c.in_exchange ?? 0),
  };
}

export const cleanCode = (v: string) => String(v || '').trim().replace(/\s+/g, '').replace(/[,()"*\\]/g, '');

/** Orders matching a scanned or typed code: reference, tracking number or phone. */
export async function findByCode(ctx: Ctx, raw: string): Promise<Order[]> {
  const code = cleanCode(raw);
  if (!code) return [];
  const phone = /^\+?\d{9,13}$/.test(code) ? normalizePhone(code) : null;
  const rows = await ctx.db.query(
    `SELECT id FROM orders WHERE upper(ref) = upper($1) OR upper(tracking) = upper($1) OR upper(own_tracking) = upper($1) OR ($2::text IS NOT NULL AND (phone = $2 OR phone2 = $2))
     ORDER BY (upper(ref) = upper($1) OR upper(tracking) = upper($1) OR upper(own_tracking) = upper($1)) DESC, id DESC LIMIT 10`,
    [code, phone],
  );
  const out: Order[] = [];
  for (const r of rows) out.push(await getOrder(ctx, num(r.id)));
  return out;
}

const followFr: Record<string, string> = {
  to_prepare: 'À préparer', prepared: 'Préparée', shipped: 'Expédiée', out_for_delivery: 'En livraison', failed: 'Reportée / échec', alert: 'Alerte',
  in_exchange: 'En échange', delivered: 'Livrée', returning: 'Retour en cours', returned: 'Retournée', exchanged: 'Échangée', lost: 'Perdue', cancelled: 'Annulée',
};
const confFr: Record<string, string> = {
  to_check: 'À vérifier', new: 'Nouvelle', no_answer: 'Pas de réponse', busy: 'Occupé', callback: 'À rappeler', postponed: 'Reportée', no_stock: 'Confirmée sans stock',
  confirmed: 'Confirmée', cancelled: 'Annulée', duplicate: 'Doublon', wrong_number: 'Faux numéro', fake: 'Fausse commande',
};
const fol = (o: Order) => (o.followStatus ? followFr[o.followStatus] ?? o.followStatus : '—');
const dayFr = (s: string | null) => (s ? new Date(s).toLocaleString('fr-FR', { timeZone: 'Africa/Algiers', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const itemsText = (o: Order) => o.items.map((i) => `${i.qty} × ${label(i.name, i.variantTitle)}`).join(' + ');

async function companyKind(db: Db, companyId: number | null) {
  if (!companyId) return null;
  return ((await db.query('SELECT kind FROM delivery_companies WHERE id = $1', [companyId]))[0]?.kind as string) ?? null;
}

export type ScanMode = 'dispatch' | 'back' | 'return' | 'exchange';

/** The rules of the depot scanner for one order. Changes the order when the parcel is good. */
export async function scanRules(ctx: Ctx, o: Order, code: string, mode: ScanMode): Promise<ScanResult> {
  const bad_ = (why: string, fix?: string): ScanResult => ({ kind: 'bad', code, order: o, why, fix });
  const f = o.followStatus;
  if (mode === 'back') {
    // a ticket parcel that came back undelivered is a return; a delivered one brings the old product back
    if (o.isExchange) return scanRules(ctx, o, code, f === 'returning' ? 'return' : 'exchange');
    if (f && ['delivered', 'exchanged', 'in_exchange'].includes(f)) {
      const x = await ctx.db.query('SELECT id FROM orders WHERE original_order_id = $1 LIMIT 1', [o.id]);
      if (x[0]) return scanRules(ctx, o, code, 'exchange');
    }
    return scanRules(ctx, o, code, 'return');
  }
  if (mode === 'dispatch') {
    if (f && LEFT.includes(f)) return bad_(`Déjà dispatchée${o.shippedAt ? ` le ${dayFr(o.shippedAt)}` : ''} (statut : ${fol(o)}).`, 'Double scan ou étiquette en double : mettez ce colis de côté.');
    if (o.confStatus !== 'confirmed') return bad_(`Commande « ${confFr[o.confStatus] ?? o.confStatus} » : elle ne doit pas partir.`, 'Ne pas expédier. Remettez les produits en place.');
    if (f === 'cancelled') return bad_('Livraison annulée.', 'Ne pas expédier.');
    if (!o.companyId) return bad_('Aucune société ni livreur choisi.', 'Choisissez la société ou le livreur dans la commande, puis scannez de nouveau.');
    const kind = await companyKind(ctx.db, o.companyId);
    const api = !!kind && API_COURIERS.includes(kind);
    if (api && !o.tracking) return bad_(`Pas encore envoyée à ${o.companyName ?? 'la société'} : l’étiquette Pilotix ne suffit pas.`, 'Envoyez-la d’abord à la société, puis collez l’étiquette qu’elle donne.');
    if (api && o.tracking && code.toUpperCase() === o.ref.toUpperCase())
      return bad_(`Étiquette Pilotix remplacée : la commande a été envoyée à ${o.companyName ?? 'la société'} avec son propre suivi.`, `Collez l’étiquette de la société ${o.tracking} et scannez-la.`);
    if (f !== 'prepared') return bad_(`Pas encore préparée (statut : ${fol(o)}).`, 'Préparez-la et marquez-la « Préparée » avant de la remettre.');
    // Own livreur / no API: the scanned label becomes the tracking number when the order has none.
    const tracking = !o.tracking && code.toUpperCase() !== o.ref.toUpperCase() ? code : null;
    await setFollow(ctx, { ids: [o.id], status: 'shipped', note: 'scan dispatch', tracking });
    return { kind: 'ok', code, order: await getOrder(ctx, o.id), why: 'Bonne pour le dispatch. Passée « Expédiée ».', did: 'dispatch' };
  }
  if (mode === 'return') {
    if (o.isExchange && f !== 'returning') return bad_('C’est un colis d’échange, pas un retour.', 'Scannez-le avec « Retour / Échange » : l’ancien produit sera remis en stock.');
    if (f === 'returned') return bad_(`Retour déjà reçu${o.returnedAt ? ` le ${dayFr(o.returnedAt)}` : ''}.`, 'Double scan : ce colis est déjà compté.');
    if (f === 'delivered') return bad_('Livrée selon Pilotix, pas en retour.', 'Gardez le colis de côté et vérifiez avec la société : le client a peut-être payé.');
    if (f !== 'returning') return bad_(`Pas marquée « Retour en cours » (statut : ${fol(o)}).`, 'Vérifiez avec la société avant d’accepter ce retour.');
    await setFollow(ctx, { ids: [o.id], status: 'returned', note: 'reçu au dépôt (scan)' });
    return { kind: 'ok', code, order: await getOrder(ctx, o.id), why: `Retour reçu. Stock remis : ${itemsText(o) || 'produits'}.`, did: 'return' };
  }
  // exchange: the exchange parcel brings back the products of the original order
  let x: Order | null = o;
  if (!o.isExchange) {
    const r = await ctx.db.query('SELECT id FROM orders WHERE original_order_id = $1 ORDER BY id DESC LIMIT 1', [o.id]);
    x = r[0] ? await getOrder(ctx, num(r[0].id)) : null;
  }
  if (!x) return bad_('Ce n’est pas une commande d’échange.', 'Si le colis est revenu, choisissez « Retour / Échange » : un retour normal sera reçu.');
  const orig = x.originalOrderId ? await getOrder(ctx, x.originalOrderId).catch(() => null) : null;
  if (!orig) return { kind: 'bad', code, order: x, why: `Échange ${x.ref} sans commande d’origine : impossible de savoir quel produit revient.`, fix: 'Remettez l’ancien produit en stock à la main (Produits & stock).' };
  const tag = `Échange ${x.ref} : ancien produit reçu au dépôt`;
  const mv = await ctx.db.query('SELECT m.created_at, p.name FROM stock_movements m LEFT JOIN profiles p ON p.id = m.user_id WHERE m.note = $1 LIMIT 1', [tag]);
  if (mv[0]) return { kind: 'bad', code, order: x, why: `Échange déjà reçu le ${dayFr(iso(mv[0].created_at))}${mv[0].name ? ` par ${mv[0].name}` : ''}.`, fix: 'Double scan : l’ancien produit est déjà en stock.' };
  if (!x.followStatus || !['delivered', 'in_exchange', 'exchanged'].includes(x.followStatus))
    return { kind: 'bad', code, order: x, why: `L’échange ${x.ref} n’est pas encore fait chez le client (statut : ${fol(x)}).`, fix: 'L’ancien produit ne peut pas être revenu. Vérifiez l’étiquette.' };
  const items = orig.items.filter((i) => i.variantId);
  if (!items.length) return { kind: 'bad', code, order: x, why: `La commande d’origine ${orig.ref} n’a pas de produit à remettre.`, fix: 'Remettez l’ancien produit en stock à la main.' };
  const wh = orig.warehouseId ?? (await defaultWarehouse(ctx.db));
  if (!wh) throw bad('Aucun dépôt actif');
  await ctx.db.tx(async (tx) => {
    for (const i of items) await moveStock(tx, { variantId: i.variantId!, warehouseId: wh, delta: i.qty, reason: 'exchange_in', orderId: orig.id, userId: ctx.session.profile.id, note: tag });
  });
  ctx.emit({ type: 'stock' });
  return { kind: 'ok', code, order: x, why: `Échange reçu. Ancien produit remis en stock : ${itemsText(orig)}.`, fix: `Commande d’origine : ${orig.ref}.`, did: 'exchange' };
}

export async function scan(ctx: Ctx, i: { code?: string; orderId?: number; mode: ScanMode }): Promise<ScanResult> {
  const code = cleanCode(i.code ?? '');
  try {
    if (i.orderId) {
      const o = await getOrder(ctx, i.orderId);
      return await scanRules(ctx, o, code || o.tracking || o.ref, i.mode);
    }
    if (!code) throw bad('Code vide');
    const list = await findByCode(ctx, code);
    const exact = list.find((o) => (o.tracking ?? '').toUpperCase() === code.toUpperCase() || o.ownTracking.toUpperCase() === code.toUpperCase() || o.ref.toUpperCase() === code.toUpperCase());
    const o = exact ?? (list.length === 1 ? list[0] : null);
    if (!o && list.length > 1) return { kind: 'pick', code, why: 'Plusieurs commandes avec ce code : choisissez la bonne.', list };
    if (!o)
      return {
        kind: 'bad',
        code,
        why: 'Ce code n’existe pas dans Pilotix.',
        fix: 'Vérifiez que toute l’étiquette a été scannée. Si la commande a été modifiée, cherchez-la par le téléphone du client et utilisez la nouvelle étiquette.',
      };
    return await scanRules(ctx, o, code, i.mode);
  } catch (e: any) {
    if (e?.code === 'forbidden') return { kind: 'bad', code, why: `Action refusée : ${e.message}`, fix: 'Votre compte n’a pas le rôle Dépôt pour ce changement.' };
    if (e?.code === 'bad_request' || e?.code === 'not_found') return { kind: 'bad', code, why: `Action refusée : ${e.message}`, fix: 'Ouvrez la commande pour voir le problème.' };
    throw e;
  }
}

// ---------------------------------------------------------------- demo test parcels (browser preview only)
export interface TestParcel {
  code: string;
  mode: 'dispatch' | 'back';
  expect: string;
  ok?: boolean;
}
export const TEST_PARCELS: TestParcel[] = [
  { code: 'PX90001', mode: 'dispatch', ok: true, expect: 'Bon : passe « Expédiée » (livreur à vous, étiquette Pilotix)' },
  { code: 'ZR-TEST-0002', mode: 'dispatch', ok: true, expect: 'Bon : passe « Expédiée » (ZR, étiquette de la société)' },
  { code: 'ZR-TEST-0003', mode: 'dispatch', expect: 'Déjà dispatchée (double scan)' },
  { code: 'PX90004', mode: 'dispatch', expect: 'Commande pas confirmée (« À rappeler »)' },
  { code: 'PX90005', mode: 'dispatch', expect: 'Aucune société ni livreur choisi' },
  { code: 'PX90006', mode: 'dispatch', expect: 'Pas encore envoyée à ZR : l’étiquette Pilotix ne suffit pas' },
  { code: 'PX90007', mode: 'dispatch', expect: 'Pas encore préparée' },
  { code: 'PX90008', mode: 'dispatch', expect: 'Livraison annulée' },
  { code: 'INCONNU-12345', mode: 'dispatch', expect: 'Ce code n’existe pas dans Pilotix' },
  { code: 'PX90011', mode: 'dispatch', expect: 'Étiquette Pilotix remplacée par celle de ZR (ZR-TEST-0011)' },
  { code: '0555990014', mode: 'dispatch', expect: '! Plusieurs commandes avec ce téléphone : choisissez la bonne' },
  { code: 'ZR-TEST-0020', mode: 'back', ok: true, expect: 'Bon : retour reçu, « Retournée », stock remis' },
  { code: 'ZR-TEST-0021', mode: 'back', expect: 'Retour déjà reçu (double scan)' },
  { code: 'ZR-TEST-0022', mode: 'back', expect: 'Livrée selon Pilotix, pas en retour (le client a peut-être payé)' },
  { code: 'ZR-TEST-0023', mode: 'back', expect: 'Pas marquée « Retour en cours » (encore en livraison)' },
  { code: 'ZR-TEST-0031', mode: 'back', ok: true, expect: 'Bon : échange reçu, l’ancien produit est remis en stock (scannez-le 2 fois pour voir « déjà reçu »)' },
  { code: 'ZR-TEST-0030', mode: 'back', expect: 'Commande d’origine : trouve l’échange ZR-TEST-0031 tout seul (« Bon » s’il n’a pas encore été scanné, sinon « déjà reçu »)' },
  { code: 'ZR-TEST-0033', mode: 'back', expect: 'Échange pas encore fait chez le client (encore en route)' },
  { code: 'ZR-TEST-0034', mode: 'back', expect: 'Échange sans commande d’origine : impossible de savoir quel produit revient' },
];
const TEST_REFS = ['PX90001', 'PX90002', 'PX90003', 'PX90004', 'PX90005', 'PX90006', 'PX90007', 'PX90008', 'PX90011', 'PX90014', 'PX90015', 'PX90020', 'PX90021', 'PX90022', 'PX90023', 'PX90030', 'PX90031', 'PX90032', 'PX90033', 'PX90034'];

/** (Re)creates the scanner test parcels. Only used by the demo. */
export async function makeTestParcels(db: Db, userId: number | null) {
  const zr = (await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0];
  const own = (await db.query(`SELECT id FROM delivery_companies WHERE kind IN ('own','manual') ORDER BY id LIMIT 1`))[0];
  const v = (await db.query(`SELECT v.id, v.title, p.id AS pid, p.name, p.price, p.cost FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  const wh = await defaultWarehouse(db);
  if (!zr || !own || !v || !wh) return 0;
  await db.tx(async (tx) => {
    const old = (await tx.query('SELECT id FROM orders WHERE ref = ANY($1)', [TEST_REFS])).map((r: any) => num(r.id));
    if (old.length) {
      await tx.query('UPDATE orders SET original_order_id = NULL WHERE original_order_id = ANY($1)', [old]);
      await tx.query('DELETE FROM stock_movements WHERE order_id = ANY($1)', [old]);
      await tx.query('DELETE FROM order_events WHERE order_id = ANY($1)', [old]);
      await tx.query('DELETE FROM orders WHERE id = ANY($1)', [old]);
    }
    await tx.query(`DELETE FROM stock_movements WHERE note LIKE 'Échange PX900%'`);
    const cust = async (phone: string, name: string) =>
      num((await tx.query(`INSERT INTO customers (phone, name, wilaya_id, orders) VALUES ($1,$2,16,1) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [phone, name]))[0].id);
    const now = Date.now();
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const mk = async (ref: string, o: { conf?: string; follow?: string | null; company?: number | null; tracking?: string | null; phone?: string; shipped?: boolean; delivered?: boolean; returned?: boolean; exchange?: boolean; original?: number | null }) => {
      const phone = o.phone ?? `05559900${ref.slice(-2)}`;
      const name = `Colis test ${ref.slice(-2)}`;
      const cid = await cust(phone, name);
      const total = num(v.price) + 400;
      const r = await tx.query(
        `INSERT INTO orders (ref, created_at, created_by, customer_id, customer_name, phone, wilaya_id, commune, address, channel, conf_status, agent_id, confirmed_at, next_call_at,
           follow_status, company_id, warehouse_id, tracking, subtotal, delivery_fee, total, prepared_at, shipped_at, delivered_at, returned_at, is_exchange, original_order_id, internal_note)
         VALUES ($1,$2,$3,$4,$5,$6,16,'Bab Ezzouar','Cité test','autre',$7,$3,$8,$9,$10,$11,$12,$13,$14,400,$15,$16,$17,$18,$19,$20,$21,'Colis de test du scanner')
         RETURNING id`,
        [ref, ago(30), userId, cid, name, phone, o.conf ?? 'confirmed', (o.conf ?? 'confirmed') === 'confirmed' ? ago(26) : null, o.conf === 'callback' ? ago(-3) : null,
          o.follow === undefined ? 'prepared' : o.follow, o.company === undefined ? own.id : o.company, wh, o.tracking ?? null, num(v.price), total,
          o.follow && o.follow !== 'to_prepare' ? ago(20) : null, o.shipped ? ago(18) : null, o.delivered ? ago(4) : null, o.returned ? ago(2) : null, !!o.exchange, o.original ?? null],
      );
      const oid = num(r[0].id);
      await tx.query('INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price) VALUES ($1,$2,$3,$4,$5,1,$6,$7)', [oid, v.pid, v.id, v.name, v.title, v.price, v.cost]);
      return oid;
    };
    await mk('PX90001', { tracking: null });
    await mk('PX90002', { company: zr.id, tracking: 'ZR-TEST-0002' });
    await mk('PX90003', { company: zr.id, tracking: 'ZR-TEST-0003', follow: 'shipped', shipped: true });
    await mk('PX90004', { conf: 'callback', follow: null, company: null });
    await mk('PX90005', { company: null });
    await mk('PX90006', { company: zr.id });
    await mk('PX90007', { follow: 'to_prepare' });
    await mk('PX90008', { follow: 'cancelled' });
    await mk('PX90011', { company: zr.id, tracking: 'ZR-TEST-0011' });
    await mk('PX90014', { phone: '0555990014' });
    await mk('PX90015', { phone: '0555990014' });
    await mk('PX90020', { company: zr.id, tracking: 'ZR-TEST-0020', follow: 'returning', shipped: true });
    await mk('PX90021', { company: zr.id, tracking: 'ZR-TEST-0021', follow: 'returned', shipped: true, returned: true });
    await mk('PX90022', { company: zr.id, tracking: 'ZR-TEST-0022', follow: 'delivered', shipped: true, delivered: true });
    await mk('PX90023', { company: zr.id, tracking: 'ZR-TEST-0023', follow: 'out_for_delivery', shipped: true });
    const o30 = await mk('PX90030', { company: zr.id, tracking: 'ZR-TEST-0030', follow: 'delivered', shipped: true, delivered: true });
    await mk('PX90031', { company: zr.id, tracking: 'ZR-TEST-0031', follow: 'delivered', shipped: true, delivered: true, exchange: true, original: o30 });
    const o32 = await mk('PX90032', { company: zr.id, tracking: 'ZR-TEST-0032', follow: 'delivered', shipped: true, delivered: true });
    await mk('PX90033', { company: zr.id, tracking: 'ZR-TEST-0033', follow: 'out_for_delivery', shipped: true, exchange: true, original: o32 });
    await mk('PX90034', { company: zr.id, tracking: 'ZR-TEST-0034', follow: 'delivered', shipped: true, delivered: true, exchange: true, original: null });
  });
  return TEST_REFS.length;
}

// ---------------------------------------------------------------- procedures
const DEPOT = ['depot'] as const;
export const catalogProcs = {
  'catalog.ping': proc(null, z.object({}), async () => ({ ok: true })),

  'catalog.warehouses': proc(null, z.object({ all: z.boolean().default(false) }), async (ctx, i): Promise<Warehouse[]> => {
    const rows = await ctx.db.query(`SELECT * FROM warehouses ${i.all ? '' : 'WHERE active'} ORDER BY is_default DESC, id`);
    return rows.map((r: any) => ({ id: num(r.id), name: r.name, wilayaId: num(r.wilaya_id), commune: r.commune, address: r.address, isDefault: !!r.is_default, active: !!r.active }));
  }),

  'catalog.products': proc([...DEPOT], z.object({ q: z.string().max(100).optional(), activeOnly: z.boolean().default(false) }), (ctx, i) => listProducts(ctx.db, i)),

  'catalog.product': proc([...DEPOT], z.object({ id }), async (ctx, { id }) => {
    const p = (await listProducts(ctx.db, { ids: [id] }))[0];
    if (!p) throw notFound('Produit introuvable');
    return p;
  }),

  /** Names of the delivery price grids (product form, "Grille de prix de livraison"). */
  'catalog.feeGrids': proc([...DEPOT], z.object({}), async (ctx) => ({ grids: Object.keys(await getSetting(ctx.db, 'clientFees')), defaultGrid: await getSetting(ctx.db, 'defaultFeeGrid') })),

  'catalog.saveProduct': proc([...DEPOT], ProductInput, (ctx, i) => saveProduct(ctx, i)),

  /** Admin: maximum discount per piece for several products at once (the "Remise maximale" card). */
  'catalog.setMaxDiscounts': proc([], z.object({ items: z.array(z.object({ id, maxDiscount: z.number().int().min(0).max(100_000_000).nullable() })).max(2000) }), async (ctx, i) => {
    await ctx.db.tx(async (tx) => {
      for (const it of i.items) await tx.query('UPDATE products SET max_discount = $2 WHERE id = $1', [it.id, it.maxDiscount]);
    });
    ctx.emit({ type: 'stock' });
    return { ok: true };
  }),

  'catalog.stock': proc([...DEPOT], StockInput, (ctx, i) => stockRows(ctx.db, i)),
  'catalog.move': proc([...DEPOT], MoveInput, (ctx, i) => stockMove(ctx, i)),
  'catalog.transfer': proc([...DEPOT], TransferInput, (ctx, i) => stockTransfer(ctx, i)),
  'catalog.setAlert': proc([...DEPOT], z.object({ variantId: id, warehouseId: id, alertQty: z.number().int().min(0).max(1_000_000) }), async (ctx, i) => {
    await ensureVariantAndDepot(ctx.db, i.variantId, i.warehouseId);
    await ctx.db.query(
      `INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty) VALUES ($1,$2,0,$3)
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET alert_qty = EXCLUDED.alert_qty`,
      [i.variantId, i.warehouseId, i.alertQty],
    );
    ctx.emit({ type: 'stock' });
    return { ok: true };
  }),

  'catalog.movements': proc(
    [...DEPOT],
    z.object({
      q: z.string().max(100).optional(),
      reason: z.string().max(40).optional(),
      warehouseId: id.optional(),
      variantId: id.optional(),
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(500).default(50),
    }),
    async (ctx, f): Promise<Page<Movement>> => {
      const w = new Where();
      if (f.reason) w.add('m.reason = ?', f.reason);
      if (f.warehouseId) w.add('m.warehouse_id = ?', f.warehouseId);
      if (f.variantId) w.add('m.variant_id = ?', f.variantId);
      if (f.from) w.add('m.created_at >= ?', f.from);
      if (f.to) w.add('m.created_at < ?', f.to);
      if (f.q?.trim()) {
        const q = f.q.trim();
        w.add(`((p.name || ' ' || v.title) ILIKE '%' || ? || '%' OR v.sku ILIKE '%' || ? || '%' OR upper(o.ref) = upper(?) OR m.note ILIKE '%' || ? || '%' OR upper(pu.ref) = upper(?) OR upper(inv.ref) = upper(?))`, q, q, q, q, q, q);
      }
      const from = `FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
        JOIN warehouses wh ON wh.id = m.warehouse_id LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN profiles u ON u.id = m.user_id
        LEFT JOIN purchases pu ON pu.id = m.purchase_id LEFT JOIN inventories inv ON inv.id = m.inventory_id`;
      const total = num((await ctx.db.query(`SELECT count(*)::int AS n ${from} ${w.sql}`, w.params))[0]?.n);
      const lim = w.p(f.pageSize);
      const off = w.p((f.page - 1) * f.pageSize);
      const rows = await ctx.db.query(
        `SELECT m.*, p.name, v.title, v.sku, wh.name AS wname, o.ref, u.name AS uname, pu.ref AS pref, inv.ref AS iref ${from} ${w.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT ${lim} OFFSET ${off}`,
        w.params,
      );
      return {
        rows: rows.map((r: any) => ({
          id: num(r.id), at: iso(r.created_at), variantId: num(r.variant_id), label: label(r.name, r.title), sku: r.sku, warehouseId: num(r.warehouse_id), warehouseName: r.wname,
          delta: num(r.delta), reason: r.reason, orderId: numOrNull(r.order_id), orderRef: r.ref ?? null, userName: r.uname ?? null, note: r.note ?? null,
          purchaseId: numOrNull(r.purchase_id), purchaseRef: r.pref ?? null, inventoryRef: r.iref ?? null,
        })),
        total,
        page: f.page,
        pageSize: f.pageSize,
      };
    },
  ),

  /** Product picker of the order forms: active products with variants, packs, linked products and available stock. */
  'catalog.search': proc(null, z.object({ q: z.string().max(100).default(''), ids: z.array(id).max(100).optional(), limit: z.number().int().min(1).max(100).default(30) }), async (ctx, i) => {
    const prods = (await listProducts(ctx.db, { q: i.q, ids: i.ids, activeOnly: !i.ids })).slice(0, i.limit);
    if (!prods.length) return [];
    const vids = prods.flatMap((p) => p.variants.map((v) => v.id));
    const st = await ctx.db.query(
      `WITH r AS (${RESERVED}) SELECT v.id, COALESCE((SELECT sum(qty) FROM stock s WHERE s.variant_id = v.id), 0)::int AS qty,
         COALESCE((SELECT sum(n) FROM r WHERE r.variant_id = v.id), 0)::int AS res FROM product_variants v WHERE v.id = ANY($1)`,
      [vids],
    );
    const S = new Map(st.map((r: any) => [num(r.id), { qty: num(r.qty), reserved: num(r.res) }]));
    return prods.map((p) => ({
      ...p,
      variants: p.variants
        .filter((v) => v.active || i.ids)
        .map((v) => {
          const s = S.get(v.id) ?? { qty: 0, reserved: 0 };
          return { ...v, label: label(p.name, v.title), stock: s.qty, available: p.isService ? null : s.qty - s.reserved };
        }),
    }));
  }),

  'catalog.picking': proc([...DEPOT], z.object({}), (ctx) => picking(ctx.db)),

  /** Couriers and livreurs for the depot filters and the "Société…" bulk action. */
  'depot.companies': proc([...DEPOT], z.object({}), async (ctx) =>
    (await ctx.db.query('SELECT id, name, kind FROM delivery_companies WHERE active ORDER BY lower(name)')).map((r: any) => ({ id: num(r.id), name: r.name as string, kind: r.kind as string })),
  ),

  'depot.counts': proc([...DEPOT], z.object({}), (ctx) => depotCounts(ctx.db)),

  'depot.find': proc([...DEPOT], z.object({ code: z.string().min(1).max(100) }), (ctx, i) => findByCode(ctx, i.code)),

  /** "Reçu au dépôt": the returned parcel is back, stock comes back (orders.setFollow moves it). */
  'depot.receiveReturn': proc([...DEPOT], z.object({ id }), async (ctx, { id }) => {
    const o = await getOrder(ctx, id);
    if (o.followStatus === 'returned') throw bad(`${o.ref} : retour déjà reçu`);
    if (!o.shippedAt) throw bad(`${o.ref} n’est jamais partie du dépôt`);
    if (o.followStatus === 'delivered') throw bad(`${o.ref} est livrée : vérifiez avec la société avant d’accepter ce retour`);
    await setFollow(ctx, { ids: [id], status: 'returned', note: 'reçu au dépôt' });
    return getOrder(ctx, id);
  }),

  /** "Retirer": takes the courier off a prepared order; it goes back to "À préparer". */
  'depot.unassign': proc([...DEPOT], z.object({ id }), async (ctx, { id }) => {
    const o = await getOrder(ctx, id);
    if (o.followStatus !== 'prepared') throw bad(`${o.ref} n’est pas en dispatch`);
    const kind = await companyKind(ctx.db, o.companyId);
    if (o.tracking && kind && API_COURIERS.includes(kind)) throw bad(`${o.ref} : déjà envoyée à ${o.companyName ?? 'la société'}. Annulez d’abord le colis chez la société (fiche de la commande).`);
    await ordersProcs['orders.assignCompany'].run(ctx, { ids: [id], companyId: null, livreurId: null });
    await setFollow(ctx, { ids: [id], status: 'to_prepare', note: 'société retirée (dépôt)' });
    return getOrder(ctx, id);
  }),

  'depot.scan': proc([...DEPOT], z.object({ code: z.string().max(100).optional(), orderId: id.optional(), mode: z.enum(['dispatch', 'back', 'return', 'exchange']) }), (ctx, i) => scan(ctx, i)),

  /** Demo only: the list of scanner test parcels. */
  'depot.testParcels': proc([...DEPOT], z.object({}), async (ctx) => {
    if (ctx.server) return [];
    const have = await ctx.db.query(`SELECT 1 FROM orders WHERE ref = 'PX90001'`);
    if (!have.length) await makeTestParcels(ctx.db, ctx.session.profile.id);
    return TEST_PARCELS;
  }),
  'depot.resetTestParcels': proc([...DEPOT], z.object({}), async (ctx) => {
    if (ctx.server) throw forbidden('Seulement dans la démo');
    const n = await makeTestParcels(ctx.db, ctx.session.profile.id);
    ctx.emit({ type: 'orders' });
    return { n };
  }),
};

