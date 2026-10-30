// Produits › « Importer Excel »: many products and their variants from one table, one line per variant.
// The page reads the file in the browser and sends the cells; this module groups the lines into products, checks
// them (dry run = the preview) and then creates each product through saveProduct, its « Stock initial » through
// the « + Entrée » stock entry. Each product is its own transaction: the result says, product by product, what was done.
import { z } from 'zod';
import { Ctx, proc } from '../rpc';
import { defaultWarehouse, saveProduct, stockMove } from './catalog';

const cell = z.union([z.string(), z.number()]).nullable().optional();
export const ImportRow = z.object({
  /** the line number in the sheet (shown in the errors) */
  line: z.number().int().min(1),
  name: cell,
  sku: cell,
  cost: cell,
  price: cell,
  variant: cell,
  variantSku: cell,
  stock: cell,
  weightKg: cell,
  maxDiscount: cell,
});
export const ImportInput = z.object({ rows: z.array(ImportRow).max(2000), dryRun: z.boolean().default(true) });

export interface ImportVariant {
  line: number;
  title: string;
  sku: string | null;
  stock: number;
}
export interface ImportProduct {
  lines: number[];
  name: string;
  sku: string | null;
  price: number;
  cost: number;
  weightKg: number;
  maxDiscount: number | null;
  variants: ImportVariant[];
  /** ready / skip (its SKU exists) / error before the import; created / skip / error after it */
  status: 'ready' | 'created' | 'skip' | 'error';
  errors: string[];
  warnings: string[];
  productId?: number;
}
export interface ImportResult {
  dryRun: boolean;
  products: ImportProduct[];
  /** lines that belong to no product (no name) */
  lineErrors: { line: number; message: string }[];
  warehouse: { id: number; name: string } | null;
  created: number;
  skipped: number;
  failed: number;
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const key = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
/** "1 500", "1500,50", "1 500 DA", 1500 → a number; '' → null; anything else → NaN */
export function parseNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = text(v).replace(/(da|dzd|دج)\.?$/i, '').replace(/[\s  ']/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** Groups the lines into products and checks them, without the database. */
export function planImport(rows: z.infer<typeof ImportRow>[], isAdmin: boolean): { products: ImportProduct[]; lineErrors: ImportResult['lineErrors'] } {
  const products: ImportProduct[] = [];
  const lineErrors: ImportResult['lineErrors'] = [];
  const skuSeen = new Map<string, number>();
  for (const r of rows) {
    const name = text(r.name);
    const values = [r.sku, r.cost, r.price, r.variant, r.variantSku, r.stock, r.weightKg, r.maxDiscount].map(text);
    if (!name) {
      if (values.some(Boolean)) lineErrors.push({ line: r.line, message: 'Nom manquant' });
      continue;
    }
    const sku = text(r.sku) || null;
    // the same SKU, or else the same name, is the same product
    let p = (sku && products.find((x) => x.sku && key(x.sku) === key(sku))) || products.find((x) => key(x.name) === key(name));
    const errs: string[] = [];
    const amount = (v: unknown, label: string, opts: { int?: boolean; max: number }) => {
      const x = parseNum(v);
      if (x === null) return null;
      if (Number.isNaN(x) || x < 0 || x > opts.max) {
        errs.push(`${label} invalide (« ${text(v)} »)`);
        return null;
      }
      return opts.int ? Math.round(x) : x;
    };
    if (!p) {
      if (name.length > 200) errs.push('Nom trop long (200 caractères au plus)');
      if (sku && sku.length > 120) errs.push('SKU trop long');
      const price = amount(r.price, 'Prix de vente', { int: true, max: 100_000_000 });
      if (price === null && !errs.length) errs.push('Prix de vente manquant');
      const maxDiscount = amount(r.maxDiscount, 'Remise max', { int: true, max: 100_000_000 });
      p = {
        lines: [],
        name,
        sku,
        price: price ?? 0,
        cost: amount(r.cost, 'Prix d’achat', { int: true, max: 100_000_000 }) ?? 0,
        weightKg: amount(r.weightKg, 'Poids', { max: 1000 }) ?? 1,
        maxDiscount: isAdmin ? maxDiscount : null,
        variants: [],
        status: 'ready',
        errors: [],
        warnings: [],
      };
      if (maxDiscount !== null && !isAdmin) p.warnings.push('Remise max ignorée : seul l’administrateur la fixe');
      products.push(p);
    }
    p.lines.push(r.line);
    const title = text(r.variant);
    const vsku = text(r.variantSku) || null;
    const stock = amount(r.stock, 'Stock initial', { int: true, max: 1_000_000 }) ?? 0;
    if (title.length > 120) errs.push('Variante trop longue (120 caractères au plus)');
    if (vsku && vsku.length > 120) errs.push('SKU variante trop long');
    if (p.variants.some((v) => key(v.title) === key(title))) errs.push(title ? `Variante « ${title} » en double` : 'Ligne en double (sans variante)');
    if (vsku) {
      const at = skuSeen.get(key(vsku));
      if (at !== undefined) errs.push(`SKU variante « ${vsku} » déjà sur la ligne ${at}`);
      else skuSeen.set(key(vsku), r.line);
    }
    p.variants.push({ line: r.line, title, sku: vsku, stock });
    for (const e of errs) p.errors.push(`Ligne ${r.line} : ${e}`);
  }
  for (const p of products) {
    // a product has named variants, or one line without a variant: not both
    if (p.variants.length > 1 && p.variants.some((v) => !v.title)) p.errors.push(`Ligne ${p.variants.find((v) => !v.title)!.line} : Variante manquante (le produit a des variantes)`);
    if (p.errors.length) p.status = 'error';
  }
  return { products, lineErrors };
}

export async function importProducts(ctx: Ctx, i: z.infer<typeof ImportInput>): Promise<ImportResult> {
  const { products, lineErrors } = planImport(i.rows, ctx.session.isAdmin);
  const db = ctx.db;
  const wid = await defaultWarehouse(db);
  const warehouse = wid ? { id: wid, name: String((await db.query('SELECT name FROM warehouses WHERE id = $1', [wid]))[0].name) } : null;
  // what the database already has: a product SKU = skip it; a variant SKU = an error (saveProduct would refuse it)
  const check = async (p: ImportProduct) => {
    if (p.status !== 'ready') return;
    if (p.sku && (await db.query('SELECT 1 FROM products WHERE sku = $1', [p.sku]))[0]) {
      p.status = 'skip';
      p.warnings.push(`Le SKU « ${p.sku} » existe déjà : produit ignoré`);
      return;
    }
    for (const v of p.variants) if (v.sku && (await db.query('SELECT 1 FROM product_variants WHERE sku = $1', [v.sku]))[0]) p.errors.push(`Ligne ${v.line} : le SKU variante « ${v.sku} » est déjà utilisé`);
    if (p.errors.length) p.status = 'error';
    else if (!p.sku && (await db.query('SELECT 1 FROM products WHERE lower(name) = lower($1)', [p.name]))[0]) p.warnings.push('Un produit du même nom existe déjà : il sera créé une deuxième fois');
    if (p.status === 'ready' && !warehouse && p.variants.some((v) => v.stock > 0)) p.warnings.push('Aucun dépôt actif : le stock initial ne sera pas enregistré');
  };
  for (const p of products) await check(p);
  if (!i.dryRun) {
    for (const p of products) {
      if (p.status !== 'ready') continue;
      let saved;
      try {
        saved = await saveProduct(ctx, {
          name: p.name,
          sku: p.sku,
          price: p.price,
          cost: p.cost,
          weightKg: p.weightKg,
          isService: false,
          active: true,
          fixedPrice: false,
          ...(p.maxDiscount !== null ? { maxDiscount: p.maxDiscount } : {}),
          packs: [],
          linked: [],
          parts: [],
          variants: p.variants.filter((v) => v.title).map((v) => ({ title: v.title, sku: v.sku, active: true })),
        });
      } catch (e) {
        p.status = 'error';
        p.errors.push((e as Error).message);
        continue;
      }
      p.status = 'created';
      p.productId = saved.id;
      if (!warehouse) continue;
      for (const v of p.variants) {
        if (v.stock <= 0) continue;
        const sv = saved.variants.find((x) => x.title === v.title);
        try {
          if (!sv) throw new Error('variante introuvable');
          await stockMove(ctx, { variantId: sv.id, warehouseId: warehouse.id, kind: 'entry', qty: v.stock, unitCost: p.cost, note: 'Import Excel' });
        } catch (e) {
          p.warnings.push(`Ligne ${v.line} : stock initial non enregistré (${(e as Error).message})`);
        }
      }
    }
  }
  const count = (s: ImportProduct['status']) => products.filter((p) => p.status === s).length;
  return { dryRun: i.dryRun, products, lineErrors, warehouse, created: count('created'), skipped: count('skip'), failed: count('error') };
}

export const productImportProcs = {
  /** dryRun (the default) only checks: the dialog's preview. Same roles as « Nouveau produit ». */
  'catalog.importProducts': proc(['depot'], ImportInput, (ctx, i) => importProducts(ctx, i)),
};
