// Google Sheets sales channel: reads a public sheet, lets the shop say which column is what (the customer's name,
// the phone, the wilaya…), then turns each new line into an order in Confirmation › Nouvelles.
// Also: test orders, to try the whole flow on the live shop with fake customers, and remove them afterwards.
import { communesOf, normalizePhone, WILAYAS, WILAYAS_AR } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { AppError, bad, Ctx, notFound, proc, withActionLock } from '../rpc';
import { createOrder } from './orders';

const id = z.number().int().positive();

// ---------------------------------------------------------------- the fields a column can fill
export const SHEET_FIELDS = ['ref', 'date', 'name', 'phone', 'phone2', 'wilaya', 'commune', 'address', 'product', 'sku', 'variant', 'qty', 'unitPrice', 'total', 'stopdesk', 'note', 'ignore'] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];
/** Without these, a line cannot become an order (a product or a SKU). */
const REQUIRED: SheetField[] = ['name', 'phone', 'wilaya'];

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();

/** Words in a column title that tell what it is (French, English, Arabic, darija). Checked in this order. */
const GUESS: [SheetField, RegExp][] = [
  // first the titles that hold another field's word: « Date de la commande », « Référence produit », « Numéro de commande »
  ['date', /\b(date|horodateur|horodatage|timestamp|heure|time|created)\b|التاريخ|الوقت/],
  ['sku', /\b(sku|code\s*(du\s*)?produit|reference\s*(du\s*)?produit|ref\s*produit)\b/],
  ['ref', /\b((numero|num|n|no|id)\s*(de\s*)?(la\s*)?(commande|order)|order\s*(id|number|no|n)|id|ref|reference)\b|رقم\s*الطلب/],
  ['phone2', /\b(tel|telephone|phone|mobile|numero|num)\s*2\b|\b2(e|eme)?\s*(tel|telephone|numero)\b|هاتف\s*2|رقم\s*2/],
  ['phone', /\b(tel|telephone|phone|mobile|numero|num|gsm)\b|هاتف|الهاتف|رقم/],
  ['unitPrice', /prix\s*unit|unit\s*price|\bpu\b/],
  ['total', /\b(prix|price|total|montant|amount|somme)\b|السعر|المبلغ|الثمن/],
  ['qty', /\b(quantite|qte|qty|quantity|nombre|nbr)\b|الكمية|العدد/],
  ['variant', /\b(variante|variant|taille|couleur|size|color|colour|pointure|modele)\b|المقاس|اللون/],
  ['product', /\b(produit|product|article|item|offre)\b|المنتج|منتج|السلعة/],
  ['wilaya', /\b(wilaya|state|province|region)\b|الولاية|ولاية/],
  ['commune', /\b(commune|city|ville|daira|localite)\b|البلدية|بلدية|المدينة/],
  ['address', /\b(adresse|address|adress|quartier|rue)\b|العنوان|عنوان/],
  ['stopdesk', /\b(stop\s*desk|stopdesk|bureau|type\s*livraison|livraison)\b|المكتب/],
  ['note', /\b(note|remarque|commentaire|comment|message|observation)\b|ملاحظة/],
  ['name', /\b(nom|name|client|customer|prenom|full\s*name)\b|الاسم|اسم|الزبون/],
];

/** A first guess of what each column is, from its title (each field once). */
export function guessMapping(headers: string[]): Record<string, SheetField> {
  const out: Record<string, SheetField> = {};
  const taken = new Set<SheetField>();
  for (const h of headers) {
    const n = norm(h);
    const hit = GUESS.find(([f, re]) => !taken.has(f) && re.test(n));
    out[h] = hit ? hit[0] : 'ignore';
    if (hit) taken.add(hit[0]);
  }
  return out;
}

// ---------------------------------------------------------------- reading the sheet
/** The CSV address of a Google sheet link (published to the web, or shared "anyone with the link"). */
export function sheetCsvUrl(link: string): string {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw bad('Lien de la feuille Google invalide');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !u.pathname.startsWith('/spreadsheets/')) throw bad('Collez le lien d’une feuille Google (docs.google.com/spreadsheets/…)');
  const gid = u.searchParams.get('gid') || /gid=(\d+)/.exec(u.hash)?.[1] || null;
  const pub = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
  if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`;
  const doc = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
  if (doc) return `https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  throw bad('Lien de la feuille Google non reconnu');
}

/** CSV text → rows (quoted fields, commas and line breaks inside quotes, a BOM at the start). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

async function channelOf(ctx: Ctx, channelId: number) {
  const ch = (await ctx.db.query('SELECT * FROM sales_channels WHERE id = $1', [channelId]))[0];
  if (!ch) throw notFound('Canal introuvable');
  if (ch.kind !== 'sheets') throw bad('Ce canal n’est pas une feuille Google');
  const config = typeof ch.config === 'string' ? JSON.parse(ch.config) : ch.config ?? {};
  return { ch, config: config as { url?: string; mapping?: Record<string, SheetField> } };
}

/** The sheet's lines: the first line gives the column titles. */
async function readSheet(ctx: Ctx, url: string): Promise<{ headers: string[]; rows: string[][] }> {
  let csv: string;
  if (ctx.server?.sheetCsv) csv = await ctx.server.sheetCsv(sheetCsvUrl(url));
  else csv = await demoCsv(ctx); // the browser preview has no server: an example sheet with the shop's own products
  const all = parseCsv(csv);
  if (!all.length) throw bad('La feuille est vide');
  const headers = all[0].map((h, i) => h.trim() || `Colonne ${i + 1}`);
  // two columns with the same title would share one choice: number them
  const seen = new Map<string, number>();
  const uniq = headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} (${n})` : h;
  });
  return { headers: uniq, rows: all.slice(1) };
}

async function demoCsv(ctx: Ctx): Promise<string> {
  const p = await ctx.db.query('SELECT name FROM products WHERE active AND NOT is_service ORDER BY id LIMIT 3');
  const names = p.map((r: any) => String(r.name));
  const prod = (i: number) => `"${(names[i % Math.max(1, names.length)] ?? 'Produit').replace(/"/g, '""')}"`;
  return [
    'Date,Nom complet,Téléphone,Wilaya,Commune,Adresse,Produit,Quantité,Prix,Remarque',
    `2026-10-26 10:12,Karim Benali,0661 23 45 67,16 - Alger,Bab Ezzouar,Cité 1200 logts,${prod(0)},1,3500,`,
    `2026-10-26 10:40,Amina Saidi,0770 11 22 33,Oran,Bir El Djir,,${prod(1)},2,6000,Appeler après 18h`,
    `2026-10-26 11:05,Yacine Haddad,0555 98 76 54,سطيف,El Eulma,Rue des frères,${prod(2)},1,2900,`,
  ].join('\n');
}

// ---------------------------------------------------------------- one line → one order
function wilayaOf(v: string): number | null {
  const s = v.trim();
  const code = /^\s*(\d{1,2})\b/.exec(s);
  if (code && Number(code[1]) >= 1 && Number(code[1]) <= 69) return Number(code[1]);
  const n = norm(s.replace(/^\d+\s*[-–.:]?\s*/, ''));
  if (!n) return null;
  const fr = WILAYAS.findIndex((w) => norm(w) === n);
  if (fr >= 0) return fr + 1;
  const ar = Object.entries(WILAYAS_AR).find(([, w]) => norm(w) === n || norm(w).replace(/^ولاية\s*/, '') === n);
  if (ar) return Number(ar[0]);
  const alias: Record<string, number> = { algiers: 16, alger: 16, djazair: 16, constantine: 25, oran: 31, wahran: 31, setif: 19, bejaia: 6, bgayet: 6, tizi: 15, annaba: 23 };
  if (alias[n]) return alias[n];
  const part = WILAYAS.findIndex((w) => norm(w).startsWith(n) || n.startsWith(norm(w)));
  return part >= 0 ? part + 1 : null;
}

const yes = (v: string) => /^(oui|yes|y|1|true|vrai|stop\s*desk|stopdesk|bureau|نعم|مكتب)$/i.test(v.trim());
const money = (v: string) => {
  const n = Number(String(v).replace(/[^\d.,]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

async function sha256(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

type Line = Partial<Record<SheetField, string>>;
const lineOf = (headers: string[], row: string[], mapping: Record<string, SheetField>): Line => {
  const l: Line = {};
  headers.forEach((h, i) => {
    const f = mapping[h];
    if (f && f !== 'ignore' && l[f] === undefined) l[f] = String(row[i] ?? '').trim();
  });
  return l;
};
const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
/**
 * What makes a line « the same order », so it becomes an order only once:
 * - its order number (N°, ID…) when the sheet has that column;
 * - otherwise its date + the phone (a form or a landing tool writes the moment of the order);
 * - otherwise the phone + the product + the variant + the quantity.
 * Columns the team changes afterwards (a status, a comment, a corrected address) never make a line new again.
 */
async function keyOf(l: Line): Promise<string> {
  if (clean(l.ref)) return `ref:${clean(l.ref)}`;
  const phone = normalizePhone(l.phone ?? '') ?? clean(l.phone).replace(/\D/g, '');
  if (clean(l.date)) return `dp:${await sha256(`${clean(l.date)}\u241f${phone}`)}`;
  return `pp:${await sha256([phone, norm(l.sku || l.product), norm(l.variant), clean(l.qty) || '1'].join('\u241f'))}`;
}
/** The key of the first version (every cell of the line): lines imported with it stay known. */
const legacyKeyOf = async (row: string[]) => `row:${await sha256(row.map((x) => x.trim()).join('\u241f'))}`;
/**
 * The same line of the same Google sheet, whatever the channel: kept on the order (unique in the database), so even a
 * channel deleted and added again with this sheet never brings back a line already made into an order.
 */
export const sheetIdOf = (url: string) => /\/spreadsheets\/d\/(?:e\/)?([\w-]+)/.exec(url)?.[1] ?? 'x';
const extIdOf = (url: string, key: string) => `sheet:${sheetIdOf(url)}:${key}`.slice(0, 200);

async function findProduct(ctx: Ctx, l: Line): Promise<{ productId: number; variantId: number | null }> {
  if (l.sku) {
    const v = (await ctx.db.query('SELECT id, product_id FROM product_variants WHERE sku = $1', [l.sku]))[0];
    if (v) return { productId: num(v.product_id), variantId: num(v.id) };
    const p = (await ctx.db.query('SELECT id FROM products WHERE sku = $1', [l.sku]))[0];
    if (p) return { productId: num(p.id), variantId: null };
    if (!l.product) throw bad(`SKU inconnu : ${l.sku}`);
  }
  if (!l.product) throw bad('Produit manquant');
  const want = norm(l.product);
  const prods = await ctx.db.query('SELECT id, name FROM products WHERE active ORDER BY id');
  const p =
    prods.find((r: any) => norm(r.name) === want) ??
    prods.find((r: any) => norm(r.name).includes(want) || want.includes(norm(r.name)));
  if (!p) throw bad(`Produit inconnu : ${l.product}`);
  let variantId: number | null = null;
  const vs = await ctx.db.query('SELECT id, title FROM product_variants WHERE product_id = $1 AND active ORDER BY id', [p.id]);
  if (!l.variant) {
    // one variant only: that one; several: the sheet must say which (a colour, a size…)
    if (vs.length === 1) variantId = num(vs[0].id);
    else if (vs.length > 1) throw bad(`« ${p.name} » a plusieurs variantes : ajoutez une colonne Variante (couleur, taille…) dans la feuille`);
  } else {
    const w = norm(l.variant);
    const v = vs.find((x: any) => norm(x.title) === w) ?? vs.find((x: any) => norm(x.title).includes(w) || (w && w.includes(norm(x.title)) && norm(x.title)));
    if (!v) throw bad(`Variante inconnue : ${l.variant}`);
    variantId = num(v.id);
  }
  return { productId: num(p.id), variantId };
}

async function orderFromLine(ctx: Ctx, ch: any, l: Line) {
  for (const f of REQUIRED) if (!l[f]) throw bad(`Colonne vide : ${f === 'name' ? 'nom' : f === 'phone' ? 'téléphone' : 'wilaya'}`);
  const phone = normalizePhone(l.phone!);
  if (!phone) throw bad(`Téléphone invalide : ${l.phone}`);
  const wilayaId = wilayaOf(l.wilaya!);
  if (!wilayaId) throw bad(`Wilaya inconnue : ${l.wilaya}`);
  const { productId, variantId } = await findProduct(ctx, l);
  const qty = Math.min(999, Math.max(1, Math.round(Number(String(l.qty ?? '').replace(/[^\d]/g, '')) || 1)));
  const unit = l.unitPrice ? money(l.unitPrice) : l.total ? money(l.total) : null;
  // the same number ordered in the last 3 days (by the sheet, a landing page, by hand…): imported, and flagged for the agent
  const twin = (
    await ctx.db.query(
      `SELECT ref FROM orders WHERE phone = $1 AND created_at > now() - interval '3 days' AND conf_status NOT IN ('cancelled','duplicate','fake','wrong_number') ORDER BY id DESC LIMIT 1`,
      [phone],
    )
  )[0];
  return createOrder(ctx, {
    customerName: l.name!.slice(0, 120),
    phone,
    phone2: l.phone2 ? normalizePhone(l.phone2) : null,
    wilayaId,
    commune: (l.commune ?? '').slice(0, 120),
    address: (l.address ?? '').slice(0, 300),
    isStopdesk: l.stopdesk ? yes(l.stopdesk) : false,
    channel: 'autre',
    source: String(ch.name).slice(0, 120),
    items: [{ productId, variantId, qty, ...(unit !== null ? { unitPrice: l.unitPrice ? unit : Math.round(unit / qty) } : {}) }],
    discount: 0,
    customerNote: l.note ? l.note.slice(0, 1000) : null,
    internalNote: twin ? `⚠️ Même numéro que ${twin.ref} (moins de 3 jours) : doublon possible` : null,
    confirm: false,
    isExchange: false,
  });
}

/**
 * Turns the sheet's new lines into orders (at most `limit` a run). Lines with a problem are tried again next time.
 * Never changes an order already made: a line already imported is skipped, whatever its order became since (confirmed,
 * delivered, cancelled, deleted).
 */
async function syncChannel(ctx: Ctx, channelId: number, limit = 300) {
  // one sync at a time per channel (the 10-minute job and a click at the same moment)
  return withActionLock(ctx.db, `sheet-sync:${channelId}`, ctx.session.profile.id, 'Synchronisation déjà en cours : réessayez dans une minute', () => syncNow(ctx, channelId, limit), 600);
}

async function syncNow(ctx: Ctx, channelId: number, limit: number) {
  const { ch, config } = await channelOf(ctx, channelId);
  if (!config.url) throw bad('Lien de la feuille manquant');
  const mapping = config.mapping;
  if (!mapping || !Object.values(mapping).some((f) => f !== 'ignore')) throw bad('Choisissez d’abord quelle colonne va où');
  const { headers, rows } = await readSheet(ctx, config.url);
  const sheet = sheetIdOf(config.url);
  const done = new Set<string>((await ctx.db.query('SELECT row_key FROM sheet_rows WHERE sheet_id = $1', [sheet])).map((r: any) => r.row_key));
  const errors: { line: number; error: string }[] = [];
  let created = 0;
  let already = 0;
  const seenNow = new Set<string>(); // the same order written twice in the sheet: once
  for (let i = 0; i < rows.length && created < limit; i++) {
    const l = lineOf(headers, rows[i], mapping);
    const key = await keyOf(l);
    if (done.has(key) || seenNow.has(key) || done.has(await legacyKeyOf(rows[i]))) {
      already++;
      continue;
    }
    seenNow.add(key);
    const ext = extIdOf(config.url, key);
    try {
      const made = await ctx.db.tx(async (tx) => {
        // the line is taken first: a second sync running at the same moment waits here, then skips it
        const claim = await tx.query('INSERT INTO sheet_rows (sheet_id, channel_id, row_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING row_key', [sheet, channelId, key]);
        if (!claim.length) return null;
        // already an order from this same sheet line (a channel deleted then added again with this sheet)
        const prev = (await tx.query('SELECT id FROM orders WHERE ext_order_id = $1', [ext]))[0];
        if (prev) {
          await tx.query('UPDATE sheet_rows SET order_id = $3 WHERE sheet_id = $1 AND row_key = $2', [sheet, key, prev.id]);
          return null;
        }
        const o = await orderFromLine({ ...ctx, db: tx }, ch, l);
        // unique in the database: never two orders for one sheet line, whatever happens
        await tx.query('UPDATE orders SET ext_order_id = $2 WHERE id = $1', [o.id, ext]);
        await tx.query('UPDATE sheet_rows SET order_id = $3 WHERE sheet_id = $1 AND row_key = $2', [sheet, key, o.id]);
        return o;
      });
      if (made) created++;
      else already++;
    } catch (e: any) {
      // nothing kept for this line (its transaction was undone): tried again at the next sync
      errors.push({ line: i + 2, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  await ctx.db.query('UPDATE sales_channels SET last_sync_at = now() WHERE id = $1', [channelId]);
  if (created) ctx.emit({ type: 'orders' });
  return { created, already, errors: errors.slice(0, 50), errorCount: errors.length, lines: rows.length };
}

const Mapping = z.record(z.string().max(200), z.enum(SHEET_FIELDS));

export const sheetsProcs = {
  /** The sheet's column titles, the first lines, and what each column is (saved choice, or a guess from the titles). */
  'channels.sheet.read': proc([], z.object({ id }), async (ctx, i) => {
    const { config } = await channelOf(ctx, i.id);
    if (!config.url) throw bad('Lien de la feuille manquant');
    const { headers, rows } = await readSheet(ctx, config.url);
    const guess = guessMapping(headers);
    const mapping = Object.fromEntries(headers.map((h) => [h, config.mapping?.[h] ?? guess[h]]));
    const done = num((await ctx.db.query('SELECT count(*) AS n FROM sheet_rows WHERE sheet_id = $1', [sheetIdOf(config.url)]))[0].n);
    return { headers, sample: rows.slice(0, 5), lines: rows.length, mapping, saved: !!config.mapping, done, fields: SHEET_FIELDS };
  }),
  /**
   * Saves which column is what. `skipExisting`: the lines already in the sheet are not imported (only the ones added
   * from now on become orders).
   */
  'channels.sheet.saveMapping': proc([], z.object({ id, mapping: Mapping, skipExisting: z.boolean().default(false) }), async (ctx, i) => {
    const { ch, config } = await channelOf(ctx, i.id);
    const used = Object.values(i.mapping).filter((f) => f !== 'ignore') as SheetField[];
    const dup = used.find((f, k) => used.indexOf(f) !== k);
    if (dup) throw bad(`Deux colonnes vont au même endroit (${dup})`);
    const missing = REQUIRED.filter((f) => !used.includes(f));
    if (missing.length) throw bad(`Choisissez la colonne : ${missing.map((f) => (f === 'name' ? 'Nom du client' : f === 'phone' ? 'Téléphone' : 'Wilaya')).join(', ')}`);
    if (!used.includes('product') && !used.includes('sku')) throw bad('Choisissez la colonne du produit (ou du SKU)');
    await ctx.db.query('UPDATE sales_channels SET config = $2 WHERE id = $1', [ch.id, JSON.stringify({ ...config, mapping: i.mapping })]);
    let skipped = 0;
    if (i.skipExisting && config.url) {
      const { headers, rows } = await readSheet(ctx, config.url);
      for (const row of rows) {
        const r = await ctx.db.query('INSERT INTO sheet_rows (sheet_id, channel_id, row_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING row_key', [sheetIdOf(config.url), ch.id, await keyOf(lineOf(headers, row, i.mapping))]);
        skipped += r.length;
      }
    }
    return { ok: true, skipped };
  }),
  /** "Synchroniser maintenant": the new lines become orders in Confirmation › Nouvelles. */
  'channels.sheet.sync': proc([], z.object({ id }), (ctx, i) => syncChannel(ctx, i.id)),
  /** Every active sheet channel with its columns chosen (the server runs it every 10 minutes). */
  'channels.sheet.syncAll': proc([], z.object({}), async (ctx) => {
    const chans = await ctx.db.query("SELECT id, name FROM sales_channels WHERE kind = 'sheets' AND active AND config ? 'mapping'");
    const out: { id: number; name: string; created?: number; errorCount?: number; error?: string }[] = [];
    for (const c of chans) {
      try {
        const r = await syncChannel(ctx, num(c.id));
        out.push({ id: num(c.id), name: c.name, created: r.created, errorCount: r.errorCount });
      } catch (e: any) {
        if (e instanceof AppError && e.code === 'conflict') continue; // already syncing (a click): that run does the work
        out.push({ id: num(c.id), name: c.name, error: String(e?.message ?? e) });
      }
    }
    return out;
  }),

  // ---------------------------------------------------------------- test orders
  /**
   * Fake orders to try the live shop (Confirmation, Dépôt…): real products, fake customers named « TEST … » with
   * phone numbers that do not exist (0500…), no message sent to anyone. Never sent to a courier by themselves.
   */
  'admin.testOrders.create': proc([], z.object({ count: z.number().int().min(1).max(20).default(5) }), async (ctx, i) => {
    const prods = await ctx.db.query(
      `SELECT p.id, (SELECT v.id FROM product_variants v WHERE v.product_id = p.id AND v.active ORDER BY v.id LIMIT 1) AS vid
       FROM products p WHERE p.active AND NOT p.is_service ORDER BY p.id LIMIT 30`,
    );
    if (!prods.length) throw bad('Ajoutez d’abord un produit (Produits & stock)');
    const first = ['Karim', 'Amina', 'Yacine', 'Sara', 'Mohamed', 'Lina', 'Walid', 'Imane', 'Riad', 'Nesrine'];
    const last = ['Benali', 'Saidi', 'Haddad', 'Boudiaf', 'Mansouri', 'Khelifi', 'Belkacem', 'Ziani'];
    const wil = [16, 31, 19, 25, 6, 9, 15, 23, 35, 13];
    const made: { id: number; ref: string }[] = [];
    const base = num((await ctx.db.query("SELECT count(*) AS n FROM orders WHERE source = 'Test Pilotix'"))[0].n);
    for (let k = 0; k < i.count; k++) {
      const n = base + k;
      const w = wil[n % wil.length];
      const communes = communesOf(w);
      const p = prods[n % prods.length];
      const o = await createOrder(
        ctx,
        {
          customerName: `TEST ${first[n % first.length]} ${last[n % last.length]}`,
          phone: `0500${String(100000 + (n % 900000)).slice(-6)}`,
          phone2: null,
          wilayaId: w,
          commune: communes.length ? communes[n % communes.length][1] : '',
          address: 'Adresse de test',
          isStopdesk: n % 4 === 3,
          channel: 'autre',
          source: 'Test Pilotix',
          items: [{ productId: num(p.id), variantId: p.vid ? num(p.vid) : null, qty: 1 + (n % 2) }],
          discount: 0,
          customerNote: '🧪 Commande de test (à supprimer)',
          confirm: false,
          isExchange: false,
        },
        ctx.db,
        { silent: true },
      );
      made.push({ id: o.id, ref: o.ref });
    }
    ctx.emit({ type: 'orders' });
    return { created: made.length, refs: made.map((m) => m.ref) };
  }),
  /** Removes the test orders still at the confirmation stage (the ones already at the depot are listed to cancel by hand). */
  'admin.testOrders.delete': proc([], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT o.id, o.ref, o.follow_status,
         (EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = o.id) OR EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id) OR EXISTS (SELECT 1 FROM orders x WHERE x.original_order_id = o.id)) AS linked
       FROM orders o WHERE o.source = 'Test Pilotix'`,
    );
    const ok = (r: any) => (!r.follow_status || r.follow_status === 'cancelled') && !r.linked;
    const free = rows.filter(ok).map((r: any) => num(r.id));
    const kept = rows.filter((r: any) => !ok(r)).map((r: any) => String(r.ref));
    if (free.length)
      await ctx.db.tx(async (tx) => {
        await tx.query('DELETE FROM order_events WHERE order_id = ANY($1)', [free]);
        await tx.query('UPDATE stock_movements SET order_id = NULL WHERE order_id = ANY($1)', [free]);
        await tx.query('UPDATE chat_messages SET order_id = NULL WHERE order_id = ANY($1)', [free]);
        await tx.query('DELETE FROM orders WHERE id = ANY($1)', [free]);
      });
    ctx.emit({ type: 'orders' });
    return { deleted: free.length, kept };
  }),
  'admin.testOrders.count': proc([], z.object({}), async (ctx) => ({ count: num((await ctx.db.query("SELECT count(*) AS n FROM orders WHERE source = 'Test Pilotix'"))[0].n) })),
};
