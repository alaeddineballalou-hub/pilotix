// Products & stock, beyond the catalog: the prices table (sale price, purchase price, maximum discount), inventories
// (a whole depot counted and validated in one go), low-stock alerts, transfers between depots (one or many products),
// suppliers, and purchases — stock that comes in at a purchase price, paid to the supplier now or later.
import { Page } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { moveStock, stockRows, StockLine } from './catalog';
import { CaisseKey, checkCaisse } from './cash';

const id = z.number().int().positive();
const money = z.number().int().min(0).max(100_000_000);
const qty = z.number().int().min(1).max(1_000_000);
const DEPOT = ['depot'] as const;
const label = (name: string, title: string | null | undefined) => (title ? `${name} ${title}` : name);
const pad = (n: number) => String(n).padStart(4, '0');
const me = (ctx: Ctx) => ctx.session.profile.id;

async function activeDepot(db: Db, warehouseId: number) {
  const w = (await db.query('SELECT id, name, active FROM warehouses WHERE id = $1', [warehouseId]))[0];
  if (!w) throw notFound('Dépôt introuvable');
  if (!w.active) throw bad(`Le dépôt « ${w.name} » est désactivé`);
  return { id: num(w.id), name: w.name as string };
}

/** The variants of `ids` (each one once), with their product; refuses services, which have no stock. */
async function stockable(db: Db, ids: number[]) {
  if (new Set(ids).size !== ids.length) throw bad('Un produit est en double dans la liste');
  const rows = await db.query('SELECT v.id, v.title, p.id AS pid, p.name, p.cost, p.is_service FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1)', [ids]);
  const by = new Map<number, { productId: number; label: string; cost: number }>();
  for (const r of rows) {
    if (r.is_service) throw bad(`« ${r.name} » est un service : il n’a pas de stock`);
    by.set(num(r.id), { productId: num(r.pid), label: label(r.name, r.title), cost: num(r.cost) });
  }
  if (by.size !== ids.length) throw notFound('Produit introuvable');
  return by;
}

/** Locks and reads the stock of these variants in one depot. */
async function lockedQty(db: Db, warehouseId: number, ids: number[]) {
  const rows = await db.query('SELECT variant_id, qty FROM stock WHERE warehouse_id = $1 AND variant_id = ANY($2) FOR UPDATE', [warehouseId, ids]);
  return new Map<number, number>(rows.map((r: any) => [num(r.variant_id), num(r.qty)]));
}

const nextId = async (db: Db, table: 'purchases' | 'inventories') => num((await db.query(`SELECT nextval(pg_get_serial_sequence('${table}', 'id')) AS id`))[0].id);

// ---------------------------------------------------------------- prices
export const PricesInput = z.object({
  items: z
    .array(
      z.object({
        /** the product */
        id,
        price: money,
        cost: money,
        /** maximum discount per piece: only the administrator changes it */
        maxDiscount: money.nullable().optional(),
        /** variants with their own sale price (null = the product's price) */
        variants: z.array(z.object({ id, price: money.nullable() })).max(200).default([]),
      }),
    )
    .min(1)
    .max(2000),
});

export async function setPrices(ctx: Ctx, i: z.infer<typeof PricesInput>) {
  const changed = await ctx.db.tx(async (tx) => {
    let n = 0;
    for (const it of i.items) {
      const cur = (await tx.query('SELECT id, price, cost, max_discount FROM products WHERE id = $1 FOR UPDATE', [it.id]))[0];
      if (!cur) throw notFound('Produit introuvable');
      const md = it.maxDiscount === undefined ? numOrNull(cur.max_discount) : it.maxDiscount;
      if (md !== numOrNull(cur.max_discount) && !ctx.session.isAdmin) throw forbidden('Seul l’administrateur modifie la remise maximale');
      if (num(cur.price) !== it.price || num(cur.cost) !== it.cost || md !== numOrNull(cur.max_discount)) {
        await tx.query('UPDATE products SET price = $2, cost = $3, max_discount = $4 WHERE id = $1', [it.id, it.price, it.cost, md]);
        n++;
      }
      for (const v of it.variants) {
        const old = (await tx.query('SELECT price FROM product_variants WHERE id = $1 AND product_id = $2', [v.id, it.id]))[0];
        if (!old) throw bad('Variante d’un autre produit');
        if (numOrNull(old.price) !== v.price) {
          await tx.query('UPDATE product_variants SET price = $2 WHERE id = $1', [v.id, v.price]);
          n++;
        }
      }
    }
    return n;
  });
  ctx.emit({ type: 'stock' });
  return { changed };
}

// ---------------------------------------------------------------- inventory
export const InventoryInput = z.object({
  warehouseId: id,
  /** what was counted; products not in the list are left as they are */
  lines: z.array(z.object({ variantId: id, counted: z.number().int().min(0).max(1_000_000) })).min(1).max(5000),
  note: z.string().trim().max(300).default(''),
});

export interface InventoryResult {
  id: number;
  ref: string;
  counted: number;
  changed: number;
  found: number;
  missing: number;
  value: number;
}

export async function applyInventory(ctx: Ctx, i: z.infer<typeof InventoryInput>): Promise<InventoryResult> {
  const r = await ctx.db.tx(async (tx) => {
    const w = await activeDepot(tx, i.warehouseId);
    const ids = i.lines.map((l) => l.variantId);
    const vars = await stockable(tx, ids);
    const cur = await lockedQty(tx, w.id, ids);
    const invId = await nextId(tx, 'inventories');
    const ref = `INV-${pad(invId)}`;
    await tx.query('INSERT INTO inventories (id, ref, warehouse_id, counted, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [invId, ref, w.id, ids.length, i.note, me(ctx)]);
    let changed = 0;
    let found = 0;
    let missing = 0;
    let value = 0;
    for (const l of i.lines) {
      const delta = l.counted - (cur.get(l.variantId) ?? 0);
      if (!delta) continue;
      changed++;
      if (delta > 0) found += delta;
      else missing -= delta;
      value += delta * vars.get(l.variantId)!.cost;
      await moveStock(tx, { variantId: l.variantId, warehouseId: w.id, delta, reason: 'count', userId: me(ctx), note: `Inventaire ${ref}${i.note ? ` — ${i.note}` : ''}`, inventoryId: invId });
    }
    await tx.query('UPDATE inventories SET changed = $2, found = $3, missing = $4, value = $5 WHERE id = $1', [invId, changed, found, missing, value]);
    return { id: invId, ref, counted: ids.length, changed, found, missing, value };
  });
  ctx.emit({ type: 'stock' });
  return r;
}

// ---------------------------------------------------------------- transfers
export const TransferManyInput = z.object({
  from: id,
  to: id,
  lines: z.array(z.object({ variantId: id, qty })).min(1).max(500),
  note: z.string().trim().max(300).default(''),
});

export async function transferMany(ctx: Ctx, i: z.infer<typeof TransferManyInput>) {
  if (i.from === i.to) throw bad('Choisissez un autre dépôt');
  const r = await ctx.db.tx(async (tx) => {
    const a = await activeDepot(tx, i.from);
    const b = await activeDepot(tx, i.to);
    const ids = i.lines.map((l) => l.variantId);
    const vars = await stockable(tx, ids);
    const have = await lockedQty(tx, a.id, ids);
    for (const l of i.lines) {
      const h = have.get(l.variantId) ?? 0;
      if (h < l.qty) throw bad(`Stock insuffisant à ${a.name} pour « ${vars.get(l.variantId)!.label} » (${h})`);
    }
    const note = i.note || `${a.name} → ${b.name}`;
    for (const l of i.lines) {
      await moveStock(tx, { variantId: l.variantId, warehouseId: a.id, delta: -l.qty, reason: 'transfer_out', userId: me(ctx), note });
      await moveStock(tx, { variantId: l.variantId, warehouseId: b.id, delta: l.qty, reason: 'transfer_in', userId: me(ctx), note });
    }
    return { lines: i.lines.length, pieces: i.lines.reduce((s, l) => s + l.qty, 0) };
  });
  ctx.emit({ type: 'stock' });
  return r;
}

export interface TransferRow {
  id: number;
  at: string;
  label: string;
  sku: string;
  qty: number;
  fromName: string;
  toName: string;
  userName: string | null;
  note: string | null;
}

// ---------------------------------------------------------------- suppliers
export const SupplierInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'Nom obligatoire').max(120),
  phone: z.string().trim().max(40).default(''),
  address: z.string().trim().max(300).default(''),
  note: z.string().trim().max(500).default(''),
  active: z.boolean().default(true),
});

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  address: string;
  note: string;
  active: boolean;
  purchases: number;
  total: number;
  paid: number;
  due: number;
  lastAt: string | null;
}

async function listSuppliers(db: Db, all: boolean, ids?: number[]): Promise<Supplier[]> {
  const w = new Where();
  if (!all) w.add('s.active');
  if (ids) w.add('s.id = ANY(?)', ids);
  const rows = await db.query(
    `SELECT s.*, count(pu.id)::int AS n, COALESCE(sum(pu.total), 0)::bigint AS total, COALESCE(sum(pu.paid), 0)::bigint AS paid, max(pu.created_at) AS last
     FROM suppliers s LEFT JOIN purchases pu ON pu.supplier_id = s.id ${w.sql}
     GROUP BY s.id ORDER BY s.active DESC, lower(s.name), s.id`,
    w.params,
  );
  return rows.map((r: any) => ({
    id: num(r.id), name: r.name, phone: r.phone, address: r.address, note: r.note, active: !!r.active,
    purchases: num(r.n), total: num(r.total), paid: num(r.paid), due: num(r.total) - num(r.paid), lastAt: isoOrNull(r.last),
  }));
}

async function saveSupplier(ctx: Ctx, i: z.infer<typeof SupplierInput>): Promise<Supplier> {
  const sid = await ctx.db.tx(async (tx) => {
    const dup = (await tx.query('SELECT id FROM suppliers WHERE lower(name) = lower($1)', [i.name]))[0];
    if (dup && num(dup.id) !== i.id) throw bad(`Le fournisseur « ${i.name} » existe déjà`);
    if (i.id) {
      const r = await tx.query('UPDATE suppliers SET name=$2, phone=$3, address=$4, note=$5, active=$6 WHERE id=$1 RETURNING id', [i.id, i.name, i.phone, i.address, i.note, i.active]);
      if (!r[0]) throw notFound('Fournisseur introuvable');
      return i.id;
    }
    return num((await tx.query('INSERT INTO suppliers (name, phone, address, note, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [i.name, i.phone, i.address, i.note, i.active]))[0].id);
  });
  return (await listSuppliers(ctx.db, true, [sid]))[0];
}

// ---------------------------------------------------------------- purchases
export const PurchaseInput = z.object({
  supplierId: id.nullable(),
  warehouseId: id,
  lines: z.array(z.object({ variantId: id, qty, unitCost: money })).min(1).max(500),
  /** paid to the supplier at once (DA) */
  paid: money.default(0),
  /** the caisse that money leaves (default: the owner's main caisse; an employee's own caisse) */
  caisse: CaisseKey.optional(),
  /** the products' purchase price becomes the price of this purchase */
  updateCost: z.boolean().default(true),
  note: z.string().trim().max(300).default(''),
});

export interface PurchaseRow {
  id: number;
  ref: string;
  at: string;
  supplierId: number | null;
  supplierName: string | null;
  warehouseId: number;
  warehouseName: string;
  lines: number;
  pieces: number;
  total: number;
  paid: number;
  due: number;
  paidAt: string | null;
  userName: string | null;
  note: string;
}
export interface PurchaseLine {
  variantId: number;
  label: string;
  sku: string;
  qty: number;
  unitCost: number;
  amount: number;
}

const PURCHASE_SELECT = `SELECT pu.*, s.name AS sname, wh.name AS wname, u.name AS uname,
    (SELECT count(*) FROM purchase_lines l WHERE l.purchase_id = pu.id)::int AS nlines,
    (SELECT COALESCE(sum(qty), 0) FROM purchase_lines l WHERE l.purchase_id = pu.id)::int AS pieces
  FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id JOIN warehouses wh ON wh.id = pu.warehouse_id LEFT JOIN profiles u ON u.id = pu.created_by`;

const toPurchase = (r: any): PurchaseRow => ({
  id: num(r.id), ref: r.ref, at: iso(r.created_at), supplierId: numOrNull(r.supplier_id), supplierName: r.sname ?? null, warehouseId: num(r.warehouse_id), warehouseName: r.wname,
  lines: num(r.nlines), pieces: num(r.pieces), total: num(r.total), paid: num(r.paid), due: num(r.total) - num(r.paid), paidAt: isoOrNull(r.paid_at), userName: r.uname ?? null, note: r.note ?? '',
});

export async function getPurchase(db: Db, pid: number): Promise<PurchaseRow & { lineItems: PurchaseLine[] }> {
  const r = (await db.query(`${PURCHASE_SELECT} WHERE pu.id = $1`, [pid]))[0];
  if (!r) throw notFound('Achat introuvable');
  const lines = await db.query(
    `SELECT l.*, p.name, v.title, v.sku FROM purchase_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id WHERE l.purchase_id = $1 ORDER BY l.id`,
    [pid],
  );
  return {
    ...toPurchase(r),
    lineItems: lines.map((l: any) => ({ variantId: num(l.variant_id), label: label(l.name, l.title), sku: l.sku, qty: num(l.qty), unitCost: num(l.unit_cost), amount: num(l.qty) * num(l.unit_cost) })),
  };
}

export async function createPurchase(ctx: Ctx, i: z.infer<typeof PurchaseInput>) {
  const pid = await ctx.db.tx(async (tx) => {
    const w = await activeDepot(tx, i.warehouseId);
    let supplier: string | null = null;
    if (i.supplierId) {
      const s = (await tx.query('SELECT name, active FROM suppliers WHERE id = $1', [i.supplierId]))[0];
      if (!s) throw notFound('Fournisseur introuvable');
      if (!s.active) throw bad(`Le fournisseur « ${s.name} » est archivé`);
      supplier = s.name;
    }
    const vars = await stockable(tx, i.lines.map((l) => l.variantId));
    const total = i.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    if (total > 2_000_000_000) throw bad('Montant trop grand');
    if (i.paid > total) throw bad('Le montant payé dépasse le total de l’achat');
    const pid = await nextId(tx, 'purchases');
    const ref = `ACH-${pad(pid)}`;
    await tx.query('INSERT INTO purchases (id, ref, supplier_id, warehouse_id, total, paid, paid_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      pid, ref, i.supplierId, w.id, total, i.paid, i.paid > 0 ? new Date(ctx.now()).toISOString() : null, i.note, me(ctx),
    ]);
    if (i.paid > 0) {
      const k = supplierCaisse(ctx, i.caisse);
      await checkCaisse(tx, k);
      await supplierCash(tx, k, i.paid, ref, supplier, me(ctx));
    }
    for (const l of i.lines) {
      await tx.query('INSERT INTO purchase_lines (purchase_id, variant_id, qty, unit_cost) VALUES ($1,$2,$3,$4)', [pid, l.variantId, l.qty, l.unitCost]);
      await moveStock(tx, { variantId: l.variantId, warehouseId: w.id, delta: l.qty, reason: 'purchase', userId: me(ctx), note: `Achat ${ref}${supplier ? ` — ${supplier}` : ''}`, purchaseId: pid });
    }
    if (i.updateCost) {
      // several variants of one product in the purchase: the product's purchase price is their average
      const by = new Map<number, { q: number; v: number }>();
      for (const l of i.lines) {
        const p = vars.get(l.variantId)!.productId;
        const a = by.get(p) ?? { q: 0, v: 0 };
        by.set(p, { q: a.q + l.qty, v: a.v + l.qty * l.unitCost });
      }
      for (const [p, a] of by) await tx.query('UPDATE products SET cost = $2 WHERE id = $1', [p, Math.round(a.v / a.q)]);
    }
    return pid;
  });
  ctx.emit({ type: 'stock' });
  return getPurchase(ctx.db, pid);
}

// ---------------------------------------------------------------- procedures
/** Which caisse pays a supplier: the owner / an admin choose (main by default); an employee pays from his own caisse. */
function supplierCaisse(ctx: Ctx, asked: string | undefined): string {
  const owner = ctx.session.isAdmin || ctx.session.roles.includes('vendeur');
  const own = `u${ctx.session.profile.id}`;
  const k = asked ?? (owner ? 'main' : own);
  if (!owner && k !== own) throw forbidden('Vous ne pouvez payer un fournisseur qu’avec votre caisse');
  return k;
}

/** Money paid to (or taken back from) a supplier leaves (or comes back to) a caisse, so balances stay true. */
async function supplierCash(db: Db, caisse: string, delta: number, ref: string, supplier: string | null, userId: number) {
  if (!delta) return;
  await db.query(`INSERT INTO cash_moves (caisse, amount, kind, category, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
    caisse, -delta, delta > 0 ? 'expense' : 'income', delta > 0 ? 'supplier' : null, `Fournisseur${supplier ? ` ${supplier}` : ''} — ${ref}`, userId,
  ]);
}

export const stockProcs = {
  /** "Prix": sale price, purchase price and maximum discount of many products at once. */
  'catalog.setPrices': proc([...DEPOT], PricesInput, (ctx, i) => setPrices(ctx, i)),

  /** "Inventaire": the counted quantities of a depot, validated in one go. */
  'catalog.inventory': proc([...DEPOT], InventoryInput, (ctx, i) => applyInventory(ctx, i)),

  'catalog.inventories': proc([...DEPOT], z.object({ limit: z.number().int().min(1).max(100).default(20) }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT inv.*, wh.name AS wname, u.name AS uname FROM inventories inv JOIN warehouses wh ON wh.id = inv.warehouse_id LEFT JOIN profiles u ON u.id = inv.created_by
       ORDER BY inv.created_at DESC, inv.id DESC LIMIT ${Number(i.limit)}`,
    );
    return rows.map((r: any) => ({
      id: num(r.id), ref: r.ref as string, at: iso(r.created_at), warehouseName: r.wname as string, counted: num(r.counted), changed: num(r.changed),
      found: num(r.found), missing: num(r.missing), value: num(r.value), note: r.note as string, userName: (r.uname ?? null) as string | null,
    }));
  }),

  /** "Alertes": products out of stock or under their alert level, with what sold in 30 days, the last purchase, and how
   *  many to buy (30 days of sales plus the alert level, less what is left). */
  'catalog.alerts': proc([...DEPOT], z.object({ warehouseId: id.optional() }), async (ctx, i) => {
    const rows = (await stockRows(ctx.db, { missingOnly: true, withHidden: false, warehouseId: i.warehouseId })).filter((r) => r.productActive && r.variantActive);
    const vids = [...new Set(rows.map((r) => r.variantId))];
    const since = new Date(ctx.now() - 30 * 86_400_000).toISOString();
    // sold = shipped to customers in the last 30 days (an order leaves its depot, the default one when it has none)
    const sold = vids.length
      ? await ctx.db.query(
          `SELECT i.variant_id, COALESCE(o.warehouse_id, (SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1)) AS warehouse_id, sum(i.qty)::int AS n
           FROM order_items i JOIN orders o ON o.id = i.order_id
           WHERE i.variant_id = ANY($1) AND o.shipped_at >= $2 GROUP BY 1, 2`,
          [vids, since],
        )
      : [];
    const last = vids.length
      ? await ctx.db.query(
          `SELECT DISTINCT ON (l.variant_id) l.variant_id, l.unit_cost, pu.created_at, pu.ref, s.id AS sid, s.name AS sname
           FROM purchase_lines l JOIN purchases pu ON pu.id = l.purchase_id LEFT JOIN suppliers s ON s.id = pu.supplier_id
           WHERE l.variant_id = ANY($1) ORDER BY l.variant_id, pu.created_at DESC, l.id DESC`,
          [vids],
        )
      : [];
    const S = new Map(sold.map((r: any) => [`${num(r.variant_id)}-${num(r.warehouse_id)}`, num(r.n)]));
    const L = new Map(last.map((r: any) => [num(r.variant_id), { unitCost: num(r.unit_cost), at: iso(r.created_at), ref: r.ref as string, supplierId: numOrNull(r.sid), supplierName: (r.sname ?? null) as string | null }]));
    return rows
      .map((r: StockLine) => {
        const sold30 = S.get(`${r.variantId}-${r.warehouseId}`) ?? 0;
        return {
          ...r,
          level: (r.available <= 0 ? 'out' : 'low') as 'out' | 'low',
          sold30,
          suggest: Math.max(1, Math.max(r.alertQty + 1, sold30 + r.alertQty) - r.available),
          lastPurchase: L.get(r.variantId) ?? null,
        };
      })
      .sort((a, b) => (a.level === b.level ? b.sold30 - a.sold30 : a.level === 'out' ? -1 : 1));
  }),

  /** "Dépôts & transferts": the depots with their stock, and the transfers between them. */
  'catalog.depots': proc([...DEPOT], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT wh.*, COALESCE(sum(s.qty) FILTER (WHERE s.qty > 0), 0)::bigint AS pieces, count(s.variant_id) FILTER (WHERE s.qty > 0)::int AS products,
              COALESCE(sum(s.qty::bigint * p.cost) FILTER (WHERE s.qty > 0), 0)::bigint AS value
       FROM warehouses wh LEFT JOIN stock s ON s.warehouse_id = wh.id LEFT JOIN product_variants v ON v.id = s.variant_id LEFT JOIN products p ON p.id = v.product_id
       GROUP BY wh.id ORDER BY wh.active DESC, wh.is_default DESC, wh.id`,
    );
    return rows.map((r: any) => ({
      id: num(r.id), name: r.name as string, wilayaId: num(r.wilaya_id), commune: r.commune as string, address: r.address as string, isDefault: !!r.is_default, active: !!r.active,
      pieces: num(r.pieces), products: num(r.products), value: num(r.value),
    }));
  }),

  'catalog.transfers': proc(
    [...DEPOT],
    z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(200).default(30) }),
    async (ctx, f): Promise<Page<TransferRow>> => {
      // a transfer is two movements written together: out of one depot, into the other
      const from = `FROM stock_movements i
        JOIN stock_movements o ON o.reason = 'transfer_out' AND o.variant_id = i.variant_id AND o.created_at = i.created_at AND o.delta = -i.delta
        JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
        JOIN warehouses wi ON wi.id = i.warehouse_id JOIN warehouses wo ON wo.id = o.warehouse_id LEFT JOIN profiles u ON u.id = i.user_id
        WHERE i.reason = 'transfer_in'`;
      const total = num((await ctx.db.query(`SELECT count(*)::int AS n ${from}`))[0]?.n);
      const rows = await ctx.db.query(
        `SELECT i.id, i.created_at, i.delta, i.note, p.name, v.title, v.sku, wi.name AS toname, wo.name AS fromname, u.name AS uname ${from}
         ORDER BY i.created_at DESC, i.id DESC LIMIT $1 OFFSET $2`,
        [f.pageSize, (f.page - 1) * f.pageSize],
      );
      return {
        rows: rows.map((r: any) => ({ id: num(r.id), at: iso(r.created_at), label: label(r.name, r.title), sku: r.sku, qty: num(r.delta), fromName: r.fromname, toName: r.toname, userName: r.uname ?? null, note: r.note ?? null })),
        total,
        page: f.page,
        pageSize: f.pageSize,
      };
    },
  ),

  'catalog.transferMany': proc([...DEPOT], TransferManyInput, (ctx, i) => transferMany(ctx, i)),

  // ---- suppliers and purchases
  'suppliers.list': proc([...DEPOT], z.object({ all: z.boolean().default(false) }), (ctx, i) => listSuppliers(ctx.db, i.all)),
  'suppliers.save': proc([...DEPOT], SupplierInput, (ctx, i) => saveSupplier(ctx, i)),

  'purchases.list': proc(
    [...DEPOT],
    z.object({
      supplierId: id.optional(),
      q: z.string().max(100).optional(),
      /** only the purchases not fully paid to the supplier */
      unpaid: z.boolean().default(false),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(30),
    }),
    async (ctx, f) => {
      const w = new Where();
      if (f.supplierId) w.add('pu.supplier_id = ?', f.supplierId);
      if (f.unpaid) w.add('pu.paid < pu.total');
      if (f.q?.trim()) {
        const q = f.q.trim();
        w.add(
          `(upper(pu.ref) = upper(?) OR s.name ILIKE '%' || ? || '%' OR pu.note ILIKE '%' || ? || '%' OR EXISTS (SELECT 1 FROM purchase_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id WHERE l.purchase_id = pu.id AND (p.name || ' ' || v.title) ILIKE '%' || ? || '%'))`,
          q, q, q, q,
        );
      }
      const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id ${w.sql}`, w.params))[0]?.n);
      const lim = w.p(f.pageSize);
      const off = w.p((f.page - 1) * f.pageSize);
      const rows = await ctx.db.query(`${PURCHASE_SELECT} ${w.sql} ORDER BY pu.created_at DESC, pu.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
      const month = new Date(ctx.now() + 3_600_000);
      const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1) - 3_600_000).toISOString();
      const s = (await ctx.db.query(
        `SELECT COALESCE(sum(total - paid), 0)::bigint AS due, count(*) FILTER (WHERE paid < total)::int AS unpaid, count(*)::int AS n,
                count(*) FILTER (WHERE created_at >= $1)::int AS mn, COALESCE(sum(total) FILTER (WHERE created_at >= $1), 0)::bigint AS mt FROM purchases`,
        [monthStart],
      ))[0];
      const page: Page<PurchaseRow> = { rows: rows.map(toPurchase), total, page: f.page, pageSize: f.pageSize };
      return { ...page, summary: { due: num(s.due), unpaid: num(s.unpaid), count: num(s.n), monthCount: num(s.mn), monthTotal: num(s.mt) } };
    },
  ),

  'purchases.get': proc([...DEPOT], z.object({ id }), (ctx, i) => getPurchase(ctx.db, i.id)),
  'purchases.create': proc([...DEPOT], PurchaseInput, (ctx, i) => createPurchase(ctx, i)),

  /** What has been paid to the supplier for this purchase, in total. */
  'purchases.pay': proc([...DEPOT], z.object({ id, paid: money, caisse: CaisseKey.optional() }), async (ctx, i) => {
    const k = supplierCaisse(ctx, i.caisse);
    await checkCaisse(ctx.db, k);
    await ctx.db.tx(async (tx) => {
      const r = (await tx.query('SELECT p.ref, p.total, p.paid, s.name AS supplier FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1 FOR UPDATE OF p', [i.id]))[0];
      if (!r) throw notFound('Achat introuvable');
      if (i.paid > num(r.total)) throw bad('Le montant payé dépasse le total de l’achat');
      if (i.paid === num(r.paid)) return;
      await tx.query('UPDATE purchases SET paid = $2, paid_at = $3 WHERE id = $1', [i.id, i.paid, new Date(ctx.now()).toISOString()]);
      // only the difference moves: paying 30 000 more takes 30 000 out of the caisse
      await supplierCash(tx, k, i.paid - num(r.paid), r.ref, r.supplier ?? null, me(ctx));
    });
    return getPurchase(ctx.db, i.id);
  }),
};
