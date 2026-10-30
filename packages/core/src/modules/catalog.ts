// Catalog, stock and depot: products & variants, stock per depot, movements, picking, returns and the parcel scanner.
import { API_COURIER_KINDS, normalizePhone, Order, Page, Pack, StockRow, Warehouse } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull, Where } from '../db';
import { bad, Ctx, forbidden, hasRole, notFound, proc, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { cancelParcel, sendOrders } from './delivery';
import { assignCompanies, getOrder, setFollow } from './orders';
import { landingSettings, quickCreatePage } from './landingquery';
import { RESERVED } from './stockquery';
import { releaseNoStock } from './nostock';
import { blockedByAlert } from './depotalerts';
import { atIn, confIn, dayIn, followIn, ScanLang, scanT } from './scantext';
import { checkDispatch, dispatchOrders } from './dispatch';
import { getPrefs } from './prefs';

// ---------------------------------------------------------------- types
export interface CatalogVariant {
  id: number;
  productId: number;
  title: string;
  sku: string;
  price: number | null;
  cost: number | null;
  maxDiscount: number | null;
  weightKg: number | null;
  alertQty: number | null;
  feeGrid: string | null;
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
  barcode: string | null;
  brand: string | null;
  externalId: string | null;
  pageUrl: string | null;
  sellerId: number | null;
  description: string | null;
  alertQty: number;
  defaultCompanyId: number | null;
  /** Taille, Couleur, Genre…: the options the variants are made from (empty: variants typed one by one) */
  options: ProductOption[];
  variants: CatalogVariant[];
  services: ProductService[];
}
export interface ProductService { id: number; name: string; price: number; cost: number; }
export interface ProductOption {
  name: string;
  values: string[];
}
/** Between the option values in a variant's name: « 12P / ROSE / Fille ». */
export const OPTION_SEP = ' / ';
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
export const API_COURIERS = [...API_COURIER_KINDS];
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
    barcode: p.barcode ?? null,
    brand: p.brand ?? null,
    externalId: p.external_id ?? null,
    pageUrl: p.page_url ?? null,
    sellerId: numOrNull(p.seller_id),
    description: p.description ?? null,
    alertQty: num(p.alert_qty),
    defaultCompanyId: numOrNull(p.default_company_id),
    options: j(p.options),
    services: j(p.services),
    variants: vars.map((v) => ({ id: num(v.id), productId: num(v.product_id), title: v.title, sku: v.sku, price: numOrNull(v.price), cost: numOrNull(v.cost), maxDiscount: numOrNull(v.max_discount), weightKg: numOrNull(v.weight_kg), alertQty: numOrNull(v.alert_qty), feeGrid: v.fee_grid ?? null, active: !!v.active })),
  };
}

export async function listProducts(db: Db, opts: { ids?: number[]; q?: string; activeOnly?: boolean } = {}): Promise<CatalogProduct[]> {
  const w = new Where();
  if (opts.ids) w.add('p.id = ANY(?)', opts.ids);
  // archived products leave the lists (asked by id they are still found: an old order shows them)
  else w.add('p.archived_at IS NULL');
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
  else w.add('(p.archived_at IS NULL OR COALESCE(s.qty, 0) <> 0 OR COALESCE(r.n, 0) <> 0)');
  if (f.q?.trim()) {
    const q = f.q.trim();
    w.add(`((p.name || ' ' || v.title) ILIKE '%' || ? || '%' OR v.sku ILIKE '%' || ? || '%' OR p.sku ILIKE '%' || ? || '%')`, q, q, q);
  }
  if (f.missingOnly) w.add('COALESCE(s.qty, 0) - COALESCE(r.n, 0) <= COALESCE(s.alert_qty, v.alert_qty, p.alert_qty, 0)');
  const rows = await db.query(
    `WITH r AS (${RESERVED})
     SELECT v.id AS variant_id, p.id AS product_id, p.name, v.title, v.sku, wh.id AS wid, wh.name AS wname,
            COALESCE(s.qty, 0) AS qty, COALESCE(s.alert_qty, v.alert_qty, p.alert_qty, 0) AS alert_qty, COALESCE(r.n, 0) AS reserved, COALESCE(v.cost, p.cost) AS cost, p.active AS pactive, v.active AS vactive
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

// ---------------------------------------------------------------- price history
/** Writes what changed among a product's sale price, purchase price and maximum discount. Inside the caller's transaction. */
export async function logProductChange(
  db: Db,
  productId: number,
  userId: number | null,
  before: { price?: number | null; cost?: number | null; max_discount?: number | null },
  after: { price?: number | null; cost?: number | null; max_discount?: number | null },
  why: string | null = null,
) {
  for (const f of ['price', 'cost', 'max_discount'] as const) {
    if (!(f in after) || after[f] === undefined) continue;
    const a = before[f] == null ? null : Number(before[f]);
    const b = after[f] == null ? null : Number(after[f]);
    if (a !== b) await db.query('INSERT INTO product_changes (product_id, user_id, field, from_value, to_value, why) VALUES ($1,$2,$3,$4,$5,$6)', [productId, userId, f, a, b, why]);
  }
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
  // stock came in: the oldest « sans stock » orders it can now serve go to « À préparer »
  if (a.delta > 0) await releaseNoStock(db, a.userId, [a.variantId]);
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
  /** entry only: the purchase price of these pieces; when it differs, it becomes the product's purchase price */
  unitCost: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

export async function stockMove(ctx: Ctx, i: z.infer<typeof MoveInput>) {
  if (i.kind !== 'count' && i.qty < 1) throw bad('Quantité invalide');
  const r = await ctx.db.tx(async (tx) => {
    await ensureVariantAndDepot(tx, i.variantId, i.warehouseId);
    const cur = await currentQty(tx, i.variantId, i.warehouseId);
    const delta = i.kind === 'entry' ? i.qty : i.kind === 'loss' ? -i.qty : i.qty - cur;
    let note = i.note || null;
    if (i.kind === 'entry' && i.unitCost != null) {
      // the supplier changed its price: this entry's price is the product's purchase price from now on
      const p = (await tx.query('SELECT p.id, p.cost FROM products p JOIN product_variants v ON v.product_id = p.id WHERE v.id = $1 FOR UPDATE OF p', [i.variantId]))[0];
      const old = num(p.cost);
      if (old !== i.unitCost) {
        await tx.query('UPDATE products SET cost = $2 WHERE id = $1', [p.id, i.unitCost]);
        await logProductChange(tx, num(p.id), ctx.session.profile.id, { cost: old }, { cost: i.unitCost }, 'Entrée de stock');
      }
      const price = old !== i.unitCost ? `Prix d’achat ${old} → ${i.unitCost} DA` : `Prix d’achat ${i.unitCost} DA`;
      note = note ? `${note} — ${price}` : price;
    }
    await moveStock(tx, { variantId: i.variantId, warehouseId: i.warehouseId, delta, reason: i.kind, userId: ctx.session.profile.id, note });
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
  cost: z.number().int().min(0).max(100_000_000).nullable().optional(),
  maxDiscount: z.number().int().min(0).max(100_000_000).nullable().optional(),
  weightKg: z.number().min(0).max(1000).nullable().optional(),
  alertQty: z.number().int().min(0).max(1_000_000).nullable().optional(),
  feeGrid: z.string().trim().max(80).nullable().optional(),
  active: z.boolean().default(true),
});
export const ProductInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'Nom obligatoire').max(200),
  sku: z.string().trim().max(120).nullable().optional(),
  price: z.number().int().min(0).max(100_000_000),
  cost: z.number().int().min(0).max(100_000_000).default(0),
  weightKg: z.number().min(0).max(1000).default(1),
  /** a link, or a small picture picked in the form (a data: URL of ~10–30 KB) */
  photo: z.string().trim().max(200_000).nullable().optional(),
  isService: z.boolean().default(false),
  active: z.boolean().default(true),
  fixedPrice: z.boolean().default(false),
  maxDiscount: z.number().int().min(0).max(100_000_000).nullable().optional(),
  packs: z.array(PackInput).max(20).default([]),
  linked: z.array(id).max(50).default([]),
  parts: z.array(z.object({ name: z.string().trim().min(1).max(120), max: z.number().int().min(1).max(999).nullable().optional() })).max(50).default([]),
  /** Optional paid services such as montage; each becomes a linked stock-free service product. */
  services: z.array(z.object({ id: id.optional(), name: z.string().trim().min(1).max(120), price: z.number().int().min(0).max(100_000_000), cost: z.number().int().min(0).max(100_000_000) })).max(20).optional(),
  feeGrid: z.string().trim().max(80).nullable().optional(),
  barcode: z.string().trim().max(120).nullable().optional(),
  brand: z.string().trim().max(120).nullable().optional(),
  externalId: z.string().trim().max(120).nullable().optional(),
  pageUrl: z.string().trim().max(1000).nullable().optional(),
  sellerId: id.nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  /** given to every depot of the product (each depot can then be changed in Stock › Seuil d'alerte) */
  alertQty: z.number().int().min(0).max(1_000_000).optional(),
  defaultCompanyId: id.nullable().optional(),
  /** Taille, Couleur, Genre…: at most 3 options; a value never holds « / » (it separates the values in a variant's name) */
  options: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Nom de l’option manquant').max(40),
        values: z.array(z.string().trim().min(1).max(60).refine((v) => !v.includes('/'), 'Une valeur ne peut pas contenir « / »')).min(1, 'Ajoutez au moins une valeur').max(60),
      }),
    )
    .max(3, '3 options au maximum')
    .optional(),
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
    if (cur?.archived_at && i.active) throw bad('Ce produit est archivé : sortez-le d’abord des archives (Management › Archives)');
    const maxDiscount = i.maxDiscount === undefined ? (cur ? numOrNull(cur.max_discount) : 0) : i.maxDiscount;
    // Only the administrator decides how much discount agents may give.
    if (!ctx.session.isAdmin && (cur ? numOrNull(cur.max_discount) : 0) !== maxDiscount) throw forbidden('Seul l’administrateur modifie la remise maximale');
    let sku = i.sku?.trim() || '';
    if (sku) {
      const dup = (await tx.query('SELECT id FROM products WHERE sku = $1', [sku]))[0];
      if (dup && num(dup.id) !== i.id) throw bad(`Le SKU « ${sku} » est déjà utilisé`);
    } else sku = cur?.sku ?? (await freeSku(tx, 'products', slug(i.name)));
    let linked = [...new Set(i.linked)].filter((x) => x !== i.id);
    if (i.options) {
      const names = i.options.map((o) => o.name.toLowerCase());
      if (new Set(names).size !== names.length) throw bad('Deux options ont le même nom');
      for (const o of i.options) {
        const vals = o.values.map((v) => v.toLowerCase());
        if (new Set(vals).size !== vals.length) throw bad(`L’option « ${o.name} » a deux fois la même valeur`);
      }
    }
    const options = i.options === undefined ? (cur ? (typeof cur.options === 'string' ? JSON.parse(cur.options) : cur.options ?? []) : []) : i.options;
    // Paid add-ons are real service products: selecting one in an order adds a priced,
    // stock-free order line with its own purchase cost and retained order history.
    const previousServices: ProductService[] = cur ? (typeof cur.services === 'string' ? JSON.parse(cur.services) : cur.services ?? []) : [];
    let services: ProductService[] = previousServices;
    if (i.services !== undefined) {
      if (new Set(i.services.map((s) => s.name.trim().toLowerCase())).size !== i.services.length) throw bad('Deux services portent le même nom');
      services = [];
      const oldIds = new Set(previousServices.map((s) => Number(s.id)));
      for (const service of i.services) {
        if (service.id && !oldIds.has(service.id)) throw bad('Service non lié à ce produit');
        const serviceName = `${service.name.trim()} — ${i.name}`;
        let serviceId = service.id;
        if (serviceId) {
          await tx.query('UPDATE products SET name=$2, price=$3, cost=$4, active=$5, weight_kg=0 WHERE id=$1 AND is_service', [serviceId, serviceName, service.price, service.cost, i.active]);
        } else {
          const serviceSku = await freeSku(tx, 'products', `${sku}-SERVICE-${slug(service.name)}`);
          const created = (await tx.query('INSERT INTO products (name, sku, price, cost, is_service, active, fixed_price, max_discount, weight_kg) VALUES ($1,$2,$3,$4,true,$5,true,0,0) RETURNING id', [serviceName, serviceSku, service.price, service.cost, i.active]))[0];
          serviceId = num(created.id);
          await tx.query("INSERT INTO product_variants (product_id, title, sku, active) VALUES ($1, '', $2, true)", [serviceId, await freeSku(tx, 'product_variants', `${serviceSku}-1`)]);
        }
        services.push({ id: serviceId!, name: service.name.trim(), price: service.price, cost: service.cost });
      }
      const live = new Set(services.map((s) => s.id));
      for (const old of previousServices) if (!live.has(Number(old.id))) await tx.query('UPDATE products SET active=false WHERE id=$1 AND is_service', [old.id]);
      linked = [...new Set([...linked.filter((lid) => !oldIds.has(lid)), ...services.map((s) => s.id)])];
    }

    // fields not sent keep their value (older callers send only the first ones)
    const keep = <T,>(v: T | undefined, col: string): T | null => (v === undefined ? (cur?.[col] ?? null) : (v as any) === '' ? null : v);
    const extra = [keep(i.barcode, 'barcode'), keep(i.brand, 'brand'), keep(i.externalId, 'external_id'), keep(i.pageUrl, 'page_url'), keep(i.sellerId, 'seller_id'), keep(i.description, 'description'), i.alertQty ?? num(cur?.alert_qty), keep(i.defaultCompanyId, 'default_company_id')];
    const vals = [i.name, sku, i.price, i.cost, i.weightKg, i.photo || null, i.isService, i.active, i.fixedPrice, maxDiscount, JSON.stringify(i.packs.sort((a, b) => a.qty - b.qty)), linked, JSON.stringify(i.parts.map((p) => ({ name: p.name, max: p.max ?? null }))), i.feeGrid || null, ...extra];
    let productId: number;
    if (cur) {
      await logProductChange(tx, i.id!, ctx.session.profile.id, { price: cur.price, cost: cur.cost, max_discount: cur.max_discount }, { price: i.price, cost: i.cost, max_discount: maxDiscount }, 'Fiche produit');
      await tx.query(
        `UPDATE products SET name=$2, sku=$3, price=$4, cost=$5, weight_kg=$6, photo=$7, is_service=$8, active=$9, fixed_price=$10, max_discount=$11, packs=$12, linked=$13, parts=$14, fee_grid=$15,
         barcode=$16, brand=$17, external_id=$18, page_url=$19, seller_id=$20, description=$21, alert_qty=$22, default_company_id=$23, options=$24, services=$25 WHERE id=$1`,
        [i.id, ...vals, JSON.stringify(options), JSON.stringify(services)],
      );
      productId = i.id!;
    } else {
      productId = num(
        (await tx.query(
          `INSERT INTO products (name, sku, price, cost, weight_kg, photo, is_service, active, fixed_price, max_discount, packs, linked, parts, fee_grid,
                                 barcode, brand, external_id, page_url, seller_id, description, alert_qty, default_company_id, options, services)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
          [...vals, JSON.stringify(options), JSON.stringify(services)],
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
        if (!ctx.session.isAdmin && v.maxDiscount !== undefined && v.maxDiscount !== numOrNull(old.max_discount)) throw forbidden('Seul l’administrateur modifie la remise maximale');
        await tx.query('UPDATE product_variants SET title=$2, sku=$3, price=$4, active=$5, cost=$6, max_discount=$7, weight_kg=$8, alert_qty=$9, fee_grid=$10 WHERE id=$1', [v.id, v.title.trim(), vsku || old.sku, v.price === undefined ? old.price : v.price, v.active, v.cost === undefined ? old.cost : v.cost, v.maxDiscount === undefined ? old.max_discount : v.maxDiscount, v.weightKg === undefined ? old.weight_kg : v.weightKg, v.alertQty === undefined ? old.alert_qty : v.alertQty, v.feeGrid === undefined ? old.fee_grid : v.feeGrid]);
      } else {
        vsku ||= await freeSku(tx, 'product_variants', `${sku}-${slug(v.title).slice(0, 12)}`);
        if (!ctx.session.isAdmin && v.maxDiscount != null) throw forbidden('Seul l’administrateur modifie la remise maximale');
        await tx.query('INSERT INTO product_variants (product_id, title, sku, price, active, cost, max_discount, weight_kg, alert_qty, fee_grid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [productId, v.title.trim(), vsku, v.price ?? null, v.active, v.cost ?? null, v.maxDiscount ?? null, v.weightKg ?? null, v.alertQty ?? null, v.feeGrid ?? null]);
      }
    }
    // Update per-depot thresholds only when a variant's minimum stock changes.
    for (const v of named) {
      if (v.alertQty == null) continue;
      const saved = (await tx.query('SELECT id FROM product_variants WHERE product_id=$1 AND title=$2 LIMIT 1', [productId, v.title.trim()]))[0];
      if (!saved) continue;
      const old = existing.find((e: any) => num(e.id) === num(saved.id));
      if (old && numOrNull(old.alert_qty) === v.alertQty) continue;
      await tx.query(`INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty)
        SELECT $1, id, 0, $2 FROM warehouses WHERE active
        ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET alert_qty = EXCLUDED.alert_qty`, [saved.id, v.alertQty]);
    }
    // A product always has at least one variant: the "no variant" one ('') when no named one is active.
    const after = await tx.query('SELECT id, title, active FROM product_variants WHERE product_id = $1', [productId]);
    const hasNamed = after.some((v: any) => v.title !== '' && v.active);
    const plain = after.find((v: any) => v.title === '');
    if (!hasNamed && !plain) await tx.query('INSERT INTO product_variants (product_id, title, sku) VALUES ($1, \'\', $2)', [productId, await freeSku(tx, 'product_variants', `${sku}-1`)]);
    else if (plain) await tx.query('UPDATE product_variants SET active = $2 WHERE id = $1', [plain.id, !hasNamed]);
    // « Stock minimum d'alerte »: a new product, or a changed level, applies to every variant in every active depot
    if (!i.isService && i.alertQty !== undefined && (!cur || i.alertQty !== num(cur.alert_qty)))
      await tx.query(
        `INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty)
         SELECT v.id, w.id, 0, $2 FROM product_variants v CROSS JOIN warehouses w WHERE v.product_id = $1 AND w.active AND v.alert_qty IS NULL
         ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET alert_qty = EXCLUDED.alert_qty`,
        [productId, i.alertQty],
      );
    return productId;
  });
  // Landing pages › Réglages « a page for every new product »: made at once (the marketer completes it later)
  if (!i.id && i.active && !i.isService && (await landingSettings(ctx.db)).autoCreate) await quickCreatePage(ctx.db, pid, ctx.session.profile.id).catch(() => null);
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

export async function depotCounts(db: Db, now = Date.now()) {
  // « Sans stock »: waiting orders, and those waiting longer than the shop's number of days (Préférences)
  const days = (await getPrefs(db)).noStockDays;
  const ns = (
    await db.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE COALESCE(confirmed_at, created_at) <= $1::timestamptz)::int AS late
         FROM orders WHERE conf_status = 'no_stock' AND follow_status IS NULL`,
      [new Date(now - days * 86_400_000).toISOString()],
    )
  )[0];
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
    noStock: num(ns?.n),
    noStockLate: num(ns?.late),
    // « En dispatch » problems: refused by the courier, to cancel by hand, waiting over 24 h
    prepAlerts: num(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM orders
            WHERE (follow_status = 'prepared' AND (send_error IS NOT NULL OR prepared_at <= $1::timestamptz)) OR cancel_by_hand`,
          [new Date(now - 24 * 3_600_000).toISOString()],
        )
      )[0]?.n,
    ),
  };
}

export const cleanCode = (v: string) => String(v || '').trim().replace(/\s+/g, '').replace(/[,()"*\\]/g, '');

/** Orders matching a scanned or typed code: reference, tracking number or phone. */
export async function findByCode(ctx: Ctx, raw: string): Promise<Order[]> {
  const code = cleanCode(raw);
  if (!code) return [];
  const phone = /^\+?\d{9,13}$/.test(code) ? normalizePhone(code) : null;
  const rows = await ctx.db.query(
    `SELECT id FROM orders WHERE upper(ref) = upper($1) OR upper(tracking) = upper($1) OR upper(own_tracking) = upper($1)
       OR id IN (SELECT order_id FROM parcel_returns WHERE upper(tracking) = upper($1)) OR ($2::text IS NOT NULL AND (phone = $2 OR phone2 = $2))
     ORDER BY (upper(ref) = upper($1) OR upper(tracking) = upper($1) OR upper(own_tracking) = upper($1) OR id IN (SELECT order_id FROM parcel_returns WHERE upper(tracking) = upper($1))) DESC, id DESC LIMIT 10`,
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
export async function scanRules(ctx: Ctx, o: Order, code: string, mode: ScanMode, lang: ScanLang = 'fr'): Promise<ScanResult> {
  const bad_ = (why: string, fix?: string): ScanResult => ({ kind: 'bad', code, order: o, why, fix });
  const T = (k: Parameters<typeof scanT>[1], v?: Record<string, string | number>) => scanT(lang, k, v);
  const st = (x: Order) => followIn(lang, x.followStatus);
  const co = (x: Order) => x.companyName ?? T('company');
  const f = o.followStatus;
  if (mode === 'back') {
    // a ticket parcel that came back undelivered is a return; a delivered one brings the old product back
    if (o.isExchange) return scanRules(ctx, o, code, f === 'returning' ? 'return' : 'exchange', lang);
    if (f && ['delivered', 'exchanged', 'in_exchange'].includes(f)) {
      const x = await ctx.db.query('SELECT id FROM orders WHERE original_order_id = $1 LIMIT 1', [o.id]);
      if (x[0]) return scanRules(ctx, o, code, 'exchange', lang);
    }
    return scanRules(ctx, o, code, 'return', lang);
  }
  if (mode === 'dispatch') {
    if (f && LEFT.includes(f)) return bad_(T('already', { at: atIn(lang, o.shippedAt), status: st(o) }), T('alreadyFix'));
    if (o.confStatus !== 'confirmed') return bad_(T('notConfirmed', { conf: confIn(lang, o.confStatus) }), T('notConfirmedFix'));
    if (f === 'cancelled') return bad_(T('cancelled'), T('dontSend'));
    if (!o.companyId) return bad_(T('noCompany'), T('noCompanyFix'));
    const kind = await companyKind(ctx.db, o.companyId);
    const api = !!kind && API_COURIERS.includes(kind);
    if (api && !o.tracking) return bad_(T('notSent', { company: co(o) }), T('notSentFix'));
    // a Pilotix label (order reference or Pilotix number) on a parcel the company gave its own number to
    const is = (c: string | null | undefined) => !!c && c.toUpperCase() === code.toUpperCase();
    if (api && o.tracking && !is(o.tracking) && (is(o.ref) || is(o.ownTracking)))
      return bad_(T('replaced', { company: co(o) }), T('replacedFix', { tracking: o.tracking }));
    if (o.isExchange && (await ctx.db.query('SELECT 1 FROM parcel_returns WHERE order_id = $1 AND upper(tracking) = upper($2)', [o.id, code]))[0])
      return bad_(T('returnLabel'), T('returnLabelFix', { code: o.tracking ?? o.ref }));
    if (f !== 'prepared') return bad_(T('notPrepared', { status: st(o) }), T('notPreparedFix'));
    // its red alert is still open (changed or cancelled since it was packed): it never leaves, the alert people are told
    const held = await blockedByAlert(ctx, o.id, o.ref, 'dispatch', lang);
    if (held) return bad_(held, T('alertFix'));
    // Own livreur / no API: the scanned label becomes the tracking number when the order has none.
    const tracking = !o.tracking && code.toUpperCase() !== o.ref.toUpperCase() ? code : null;
    await setFollow(ctx, { ids: [o.id], status: 'shipped', note: 'scan dispatch', tracking });
    return { kind: 'ok', code, order: await getOrder(ctx, o.id), why: T('okDispatch'), did: 'dispatch' };
  }
  if (mode === 'return') {
    if (o.isExchange && f !== 'returning') return bad_(T('exchangeNotReturn'), T('exchangeNotReturnFix'));
    if (f === 'returned') return bad_(T('returnAlready', { at: atIn(lang, o.returnedAt) }), T('returnAlreadyFix'));
    if (f === 'delivered') return bad_(T('deliveredNotReturn'), T('deliveredNotReturnFix'));
    if (f !== 'returning') return bad_(T('notReturning', { status: st(o) }), T('notReturningFix'));
    await setFollow(ctx, { ids: [o.id], status: 'returned', note: 'reçu au dépôt (scan)' });
    return { kind: 'ok', code, order: await getOrder(ctx, o.id), why: T('okReturn', { items: itemsText(o) || T('products') }), did: 'return' };
  }
  // exchange: the exchange parcel brings back the products of the original order
  let x: Order | null = o;
  if (!o.isExchange) {
    const r = await ctx.db.query('SELECT id FROM orders WHERE original_order_id = $1 ORDER BY id DESC LIMIT 1', [o.id]);
    x = r[0] ? await getOrder(ctx, num(r[0].id)) : null;
  }
  if (!x) return bad_(T('notExchange'), T('notExchangeFix'));
  const orig = x.originalOrderId ? await getOrder(ctx, x.originalOrderId).catch(() => null) : null;
  if (!orig) return { kind: 'bad', code, order: x, why: T('noOrig', { ref: x.ref }), fix: T('byHandFix') };
  const tag = `Échange ${x.ref} : ancien produit reçu au dépôt`;
  if (!x.followStatus || !['delivered', 'in_exchange', 'exchanged'].includes(x.followStatus))
    return { kind: 'bad', code, order: x, why: T('exNotDone', { ref: x.ref, status: st(x) }), fix: T('exNotDoneFix') };
  // what really comes back: the lines the SAV exchanged (kept on the ticket), not the whole original order;
  // a parts exchange brings nothing back (the article stays with the customer)
  const tk = (await ctx.db.query('SELECT exchange_kind, exchange_back FROM complaints WHERE exchange_order_id = $1 ORDER BY id DESC LIMIT 1', [x.id]))[0];
  if (tk?.exchange_kind === 'parts') return { kind: 'bad', code, order: x, why: T('parts', { ref: x.ref }), fix: T('nothingBack') };
  const kept = tk?.exchange_back ? ((typeof tk.exchange_back === 'string' ? JSON.parse(tk.exchange_back) : tk.exchange_back) as { variantId: number; qty: number }[]) : null;
  const items = kept ? kept.map((b) => ({ variantId: num(b.variantId) as number | null, qty: num(b.qty) })) : orig.items.filter((i) => i.variantId).map((i) => ({ variantId: i.variantId, qty: i.qty }));
  if (!items.length) return { kind: 'bad', code, order: x, why: T('origEmpty', { ref: orig.ref }), fix: T('byHandShortFix') };
  const wh = orig.warehouseId ?? (await defaultWarehouse(ctx.db));
  if (!wh) throw bad('Aucun dépôt actif');
  // the check and the stock move under one lock: two scanners at once never put it back twice
  const done = await withActionLock(ctx.db, `exscan:${x.id}`, ctx.session.profile.id, 'Ce colis est en cours de scan sur un autre poste', () =>
    ctx.db.tx(async (tx) => {
      const mv = await tx.query('SELECT m.created_at, p.name FROM stock_movements m LEFT JOIN profiles p ON p.id = m.user_id WHERE m.note = $1 LIMIT 1', [tag]);
      if (mv[0]) return mv[0];
      for (const i of items) await moveStock(tx, { variantId: i.variantId!, warehouseId: wh, delta: i.qty, reason: 'exchange_in', orderId: orig.id, userId: ctx.session.profile.id, note: tag });
      return null;
    }),
  );
  if (done) return { kind: 'bad', code, order: x, why: T('exAlready', { at: dayIn(lang, iso(done.created_at)), by: done.name ? T('by', { name: done.name }) : '' }), fix: T('exAlreadyFix') };
  ctx.emit({ type: 'stock' });
  // the first order: delivered and paid, then exchanged — « Échangée » (money kept, never counted as a return)
  if (orig.followStatus === 'delivered' || orig.followStatus === 'in_exchange')
    // (a follow-up status: set for the depot as the suivi would)
    await setFollow({ ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'suivi'] } }, { ids: [orig.id], status: 'exchanged', note: `Ancien produit revenu avec l’échange ${x.ref}` }, { system: true });
  const backText = kept ? T('exchangedItems', { n: items.reduce((s, i) => s + i.qty, 0) }) : itemsText(orig);
  return { kind: 'ok', code, order: x, why: T('okExchange', { items: backText }), fix: T('okExchangeFix', { ref: orig.ref }), did: 'exchange' };
}

export async function scan(ctx: Ctx, i: { code?: string; orderId?: number; mode: ScanMode; lang?: ScanLang }): Promise<ScanResult> {
  const code = cleanCode(i.code ?? '');
  const lang = i.lang ?? 'fr';
  const T = (k: Parameters<typeof scanT>[1], v?: Record<string, string | number>) => scanT(lang, k, v);
  try {
    if (i.orderId) {
      const o = await getOrder(ctx, i.orderId);
      return await scanRules(ctx, o, code || o.tracking || o.ref, i.mode, lang);
    }
    if (!code) return { kind: 'bad', code, why: T('emptyCode') };
    const list = await findByCode(ctx, code);
    const exact = list.find((o) => (o.tracking ?? '').toUpperCase() === code.toUpperCase() || o.ownTracking.toUpperCase() === code.toUpperCase() || o.ref.toUpperCase() === code.toUpperCase());
    // the courier's return parcel of an exchange (its own number) brings the old product back
    const back = exact ? null : (await ctx.db.query('SELECT order_id FROM parcel_returns WHERE upper(tracking) = upper($1) LIMIT 1', [code]))[0];
    // « Expédier »: a parcel leaves only on its own label (barcode or QR code); a phone number or a partial code never sends it
    if (i.mode === 'dispatch' && !exact && !back && list.length)
      return { kind: 'bad', code, why: T('notLabel'), fix: T('notLabelFix') };
    const o = exact ?? (back ? list.find((x) => x.id === num(back.order_id)) : undefined) ?? (list.length === 1 ? list[0] : null);
    if (!o && list.length > 1) return { kind: 'pick', code, why: T('pick'), list };
    if (!o)
      return {
        kind: 'bad',
        code,
        why: T('unknown'),
        fix: T('unknownFix'),
      };
    return await scanRules(ctx, o, code, i.mode, lang);
  } catch (e: any) {
    if (e?.code === 'forbidden') return { kind: 'bad', code, why: T('forbidden', { msg: e.message }), fix: T('forbiddenFix') };
    // (the real reason, and what to do with the parcel)
    if (e?.code === 'bad_request' || e?.code === 'not_found') return { kind: 'bad', code, why: e.message, fix: T('blockedFix') };
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
    const rows = await ctx.db.query(`SELECT * FROM warehouses ${i.all ? 'WHERE archived_at IS NULL' : 'WHERE active'} ORDER BY is_default DESC, id`);
    return rows.map((r: any) => ({ id: num(r.id), name: r.name, wilayaId: num(r.wilaya_id), commune: r.commune, address: r.address, isDefault: !!r.is_default, active: !!r.active }));
  }),

  'catalog.products': proc([...DEPOT], z.object({ q: z.string().max(100).optional(), activeOnly: z.boolean().default(false) }), (ctx, i) => listProducts(ctx.db, i)),

  'catalog.product': proc([...DEPOT], z.object({ id }), async (ctx, { id }) => {
    const p = (await listProducts(ctx.db, { ids: [id] }))[0];
    if (!p) throw notFound('Produit introuvable');
    return p;
  }),

  /** Names of the delivery price grids (product form, "Grille de prix de livraison"). */
  'catalog.feeGrids': proc([...DEPOT], z.object({}), async (ctx) => ({
    grids: Object.keys(await getSetting(ctx.db, 'clientFees')),
    defaultGrid: await getSetting(ctx.db, 'defaultFeeGrid'),
    /** the product form's « Société par défaut » and « Vendeur » lists */
    companies: (await ctx.db.query('SELECT id, name FROM delivery_companies WHERE active ORDER BY name')).map((r: any) => ({ id: num(r.id), name: r.name as string })),
    sellers: (await ctx.db.query(`SELECT id, name FROM profiles WHERE active AND ('vendeur' = ANY(roles) OR 'admin' = ANY(roles)) ORDER BY name`)).map((r: any) => ({ id: num(r.id), name: r.name as string })),
  })),

  'catalog.saveProduct': proc([...DEPOT], ProductInput, (ctx, i) => saveProduct(ctx, i)),

  /** Fast availability switch: physically available stock stays recorded when an item is switched off. */
  'catalog.setAvailability': proc([...DEPOT], z.object({
    productId: id.optional(),
    variantId: id.optional(),
    active: z.boolean(),
  }).refine((x) => Number(!!x.productId) + Number(!!x.variantId) === 1, 'Choisissez un produit ou une variante'), async (ctx, i) => {
    await ctx.db.tx(async (tx) => {
      if (i.productId) {
        const product = (await tx.query('SELECT id FROM products WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [i.productId]))[0];
        if (!product) throw notFound('Produit introuvable');
        await tx.query('UPDATE products SET active = $2 WHERE id = $1', [i.productId, i.active]);
        const addons = (await tx.query('SELECT services FROM products WHERE id = $1', [i.productId]))[0]?.services ?? [];
        const services = typeof addons === 'string' ? JSON.parse(addons) : addons;
        for (const service of services) await tx.query('UPDATE products SET active = $2 WHERE id = $1 AND is_service', [service.id, i.active]);
      } else {
        const variant = (await tx.query('SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND p.archived_at IS NULL FOR UPDATE OF v', [i.variantId]))[0];
        if (!variant) throw notFound('Variante introuvable');
        await tx.query('UPDATE product_variants SET active = $2 WHERE id = $1', [i.variantId, i.active]);
      }
    });
    ctx.emit({ type: 'stock' });
    return { ok: true };
  }),



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
    // the purchase price is for the depot and the owner, not for every account (livreurs, marketers, agents)
    const seeCost = ctx.session.isAdmin || hasRole(ctx.session, 'depot', 'vendeur');
    return prods.map((p) => ({
      ...p,
      cost: seeCost ? p.cost : 0,
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

  'depot.counts': proc([...DEPOT], z.object({}), async (ctx) => {
    // the depot looks every minute: « sans stock » orders the stock can now serve go to « À préparer » first
    await releaseNoStock(ctx.db, null);
    return depotCounts(ctx.db, ctx.now());
  }),

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

  /** "Retirer": takes the courier off a prepared order; it goes back to "À préparer". A parcel already at a company
   *  with an API is cancelled there first (refused when the company already has it). */
  'depot.unassign': proc([...DEPOT], z.object({ id }), async (ctx, { id }) => {
    const o = await getOrder(ctx, id);
    if (o.followStatus !== 'prepared') throw bad(`${o.ref} n’est pas en dispatch`);
    const kind = await companyKind(ctx.db, o.companyId);
    if (o.tracking && kind && API_COURIERS.includes(kind)) await cancelParcel(ctx, id);
    await assignCompanies(ctx, { ids: [id], companyId: null, livreurId: null }, { check: false });
    await setFollow(ctx, { ids: [id], status: 'to_prepare', note: 'société retirée (dépôt)' });
    return getOrder(ctx, id);
  }),

  /**
   * « Envoyer au dispatch », and « Société… » in En dispatch. The parcels get their partner and go to « En dispatch »;
   * a partner with an API gets the parcel right away, and its own tracking number replaces the Pilotix one: the label
   * can be printed from then on. A parcel moving to another company is cancelled at the old one first. A parcel the
   * company refuses stays in « En dispatch », waiting for its number (send it again from there); the others go on.
   */
  'depot.dispatch': proc([...DEPOT], z.object({ ids: z.array(id).min(1).max(500), companyId: id.optional() }), async (ctx, i) => {
    await checkDispatch(ctx, i.ids, i.companyId);
    return dispatchOrders(ctx, i.ids, i.companyId);
  }),

  'depot.scan': proc(
    [...DEPOT],
    // lang: the answer in the worker's language (French, English, Arabic)
    z.object({ code: z.string().max(100).optional(), orderId: id.optional(), mode: z.enum(['dispatch', 'back', 'return', 'exchange']), lang: z.enum(['fr', 'en', 'ar']).optional() }),
    (ctx, i) => scan(ctx, i),
  ),

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

