// Point de vente: the boutique's counter, off until an administrator turns it on (Management › Modules, shopmodules.ts).
// A sale takes its products out of the dépôt chosen for the counter (Réglages, the default dépôt at first), its money goes
// into « Caisse boutique » (a caisse of the Caisse page, made on first use) or the caisse chosen for its payment, and the
// day ends with the clôture: the cash counted against what the drawer should hold (the opening float + the cash sales).
// Prices are the catalogue's, quantity packs included (the best price for each line, @pilotix/shared packTotal), counted
// here again whatever the page sent. Its tables: migrations/096_pos.ts.
import { normalizePhone, packTotal, POS_METHODS, PosMethod, PosPack } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num } from '../db';
import { bad, Ctx, notFound, proc, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';
import { moveStock } from './catalog';
import { caisseLabelOf } from './cash';
import { CLIENT_FACT_COLS, scoresOf } from './clientscore';
import { requireModule, setModule } from './shopmodules';

/** Every action of the counter starts here: refused while the boutique has not turned the counter on. */
const on = (ctx: Ctx) => requireModule(ctx.db, 'pos');

// ---------------------------------------------------------------- settings
export interface PosSettings {
  /** the dépôt the counter sells from (null: the default dépôt) */
  warehouseId: number | null;
  /** « Caisse boutique », made for the counter on first use */
  caisseId: number | null;
  /** where each payment's money goes: a caisse key (main, bank, c<id>), null: « Caisse boutique » */
  into: Record<PosMethod, string | null>;
  /** the ticket: its title (empty: the boutique's name), phone, address, last line (empty: « Merci de votre visite ») */
  title: string;
  phone: string;
  address: string;
  footer: string;
  /** print the ticket as soon as a sale is paid */
  autoPrint: boolean;
}
const DEFAULTS: PosSettings = { warehouseId: null, caisseId: null, into: { cash: null, baridimob: null, card: null }, title: '', phone: '', address: '', footer: '', autoPrint: false };
export const POS_SETTINGS_KEY = 'pos';
async function settingsOf(db: Db): Promise<PosSettings> {
  const v = await getRaw<Partial<PosSettings>>(db, POS_SETTINGS_KEY, {});
  return { ...DEFAULTS, ...v, into: { ...DEFAULTS.into, ...(v.into ?? {}) } };
}

/** The payments' words in the caisse's notes and the stock's movements (the app shows its own words on screen). */
const METHOD_WORD: Record<PosMethod, string> = { cash: 'Espèces', baridimob: 'BaridiMob', card: 'Carte CIB' };
export const SHOP_CAISSE = 'Caisse boutique';
const ticketNo = (n: number) => String(n).padStart(4, '0');
/** Start of a day in Algiers (UTC+1), as a time (`date`: YYYY-MM-DD, else the day of `now`). */
function dayStart(now: number, date?: string) {
  const d = date ? new Date(`${date}T00:00:00Z`) : new Date(now + 3_600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3_600_000;
}
const canManage = (ctx: Ctx) => ctx.session.isAdmin || ctx.session.roles.includes('vendeur');

/** The dépôt of the counter: the one chosen in Réglages while it is active, else the default dépôt. */
async function depotOf(db: Db, s: PosSettings): Promise<{ id: number; name: string }> {
  const rows = await db.query(`SELECT id, name FROM warehouses WHERE active AND archived_at IS NULL ORDER BY is_default DESC, id`);
  const w: any = rows.find((r: any) => num(r.id) === s.warehouseId) ?? rows[0];
  if (!w) throw bad('Ajoutez un dépôt (Produits › Dépôts) pour vendre en boutique');
  return { id: num(w.id), name: w.name as string };
}

/** « Caisse boutique »: made once (again if the owner removed it), kept in the counter's settings. */
async function shopCaisse(db: Db, s: PosSettings, userId: number): Promise<number> {
  if (s.caisseId && (await db.query('SELECT 1 FROM caisses WHERE id = $1 AND removed_at IS NULL', [s.caisseId]))[0]) return s.caisseId;
  const id = num((await db.query(`INSERT INTO caisses (name, kind, created_by) VALUES ($1, 'cash', $2) RETURNING id`, [SHOP_CAISSE, userId]))[0].id);
  s.caisseId = id;
  await setRaw(db, POS_SETTINGS_KEY, s, userId);
  return id;
}
/** A caisse the counter's money may go into: the main caisse, the bank (unless removed), one the owner made. */
async function usable(db: Db, key: string | null): Promise<boolean> {
  if (!key) return false;
  if (key === 'main') return true;
  if (key === 'bank') return !(await getSetting(db, 'caisses')).bankHidden;
  return /^c\d+$/.test(key) && !!(await db.query('SELECT 1 FROM caisses WHERE id = $1 AND removed_at IS NULL', [Number(key.slice(1))]))[0];
}
/** Where a payment's money goes: its caisse in Réglages while it exists, else « Caisse boutique ». */
async function intoFor(db: Db, s: PosSettings, m: PosMethod, userId: number): Promise<string> {
  return (await usable(db, s.into[m])) ? s.into[m]! : `c${await shopCaisse(db, s, userId)}`;
}

const packsOf = (v: unknown): PosPack[] =>
  ((typeof v === 'string' ? JSON.parse(v) : v ?? []) as any[]).map((k) => ({ qty: num(k?.qty), price: num(k?.price) })).filter((k) => k.qty >= 2 && k.price > 0);

// ---------------------------------------------------------------- the drawer
async function openSession(db: Db) {
  return (await db.query(`SELECT s.*, u.name AS by_name FROM pos_sessions s LEFT JOIN profiles u ON u.id = s.opened_by WHERE s.closed_at IS NULL ORDER BY s.id DESC LIMIT 1`))[0] ?? null;
}
/** the open drawer: when and by whom (`who`) it was opened, its float */
const sessionOut = (r: any) => (r ? { id: num(r.id), openedAt: iso(r.opened_at), who: (r.by_name as string | null) ?? null, opening: num(r.opening) } : null);

/** A drawer's money: its sales by payment (`by`; cancelled ones left out) and the cash it should hold. */
async function drawerOf(db: Db, s: any) {
  const by: Record<PosMethod, number> = { cash: 0, baridimob: 0, card: 0 };
  let sales = 0;
  let items = 0;
  for (const r of await db.query(`SELECT method, count(*)::int AS n, sum(total)::bigint AS v, sum(items)::bigint AS q FROM pos_sales WHERE session_id = $1 AND cancelled_at IS NULL GROUP BY 1`, [s.id])) {
    by[r.method as PosMethod] = num(r.v);
    sales += num(r.n);
    items += num(r.q);
  }
  const total = by.cash + by.baridimob + by.card;
  return { ...sessionOut(s)!, sales, items, total, by, expected: num(s.opening) + by.cash };
}

// ---------------------------------------------------------------- a sale as the page shows it (and prints it)
async function salesOut(db: Db, where: string, params: unknown[]) {
  const rows = await db.query(
    `SELECT s.*, u.name AS seller, c.name AS cname, c.phone AS cphone FROM pos_sales s LEFT JOIN profiles u ON u.id = s.seller_id LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${where} ORDER BY s.at DESC, s.id DESC`,
    params,
  );
  const ids = rows.map((r: any) => num(r.id));
  const lines = ids.length ? await db.query('SELECT * FROM pos_lines WHERE sale_id = ANY($1) ORDER BY id', [ids]) : [];
  const names = new Map<string, string>();
  for (const k of new Set(rows.map((r: any) => String(r.caisse)))) names.set(k, (await caisseLabelOf(db, k)) ?? k);
  return rows.map((r: any) => ({
    id: num(r.id),
    ticket: num(r.ticket),
    no: ticketNo(num(r.ticket)),
    at: iso(r.at),
    method: r.method as PosMethod,
    total: num(r.total),
    saved: num(r.saved),
    items: num(r.items),
    seller: (r.seller as string | null) ?? null,
    customer: r.customer_id ? { id: num(r.customer_id), name: (r.cname as string | null) ?? '', phone: (r.cphone as string | null) ?? '' } : null,
    caisse: { key: String(r.caisse), name: names.get(String(r.caisse)) ?? String(r.caisse) },
    sessionId: num(r.session_id),
    cancelledAt: isoOrNull(r.cancelled_at),
    lines: lines
      .filter((l: any) => num(l.sale_id) === num(r.id))
      .map((l: any) => ({ productId: num(l.product_id), variantId: num(l.variant_id), name: l.name as string, variant: l.variant as string, sku: l.sku as string, qty: num(l.qty), unit: num(l.unit), total: num(l.total) })),
  }));
}
export type PosSale = Awaited<ReturnType<typeof salesOut>>[number];

// ---------------------------------------------------------------- inputs
const Lines = z.array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(999) })).min(1).max(100);
const Phone = z.string().trim().min(6).max(30);
const Key = z.string().regex(/^(main|bank|c\d+)$/).nullable();
const SettingsInput = z.object({
  warehouseId: z.number().int().positive().nullable(),
  into: z.object({ cash: Key, baridimob: Key, card: Key }),
  title: z.string().trim().max(60),
  phone: z.string().trim().max(30),
  address: z.string().trim().max(120),
  footer: z.string().trim().max(120),
  autoPrint: z.boolean(),
});

/** Prices a ticket's lines from the catalogue (the same product twice on the ticket: one line). */
async function priceLines(db: Db, lines: z.infer<typeof Lines>) {
  const want = new Map<number, number>();
  for (const l of lines) want.set(l.variantId, (want.get(l.variantId) ?? 0) + l.qty);
  const rows = await db.query(
    `SELECT v.id, v.title, v.sku, v.price AS vprice, v.active AS vactive, p.id AS pid, p.name, p.price, p.packs, p.active, p.is_service
     FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1)`,
    [[...want.keys()]],
  );
  const V = new Map(rows.map((r: any) => [num(r.id), r]));
  return [...want].map(([variantId, qty]) => {
    const r: any = V.get(variantId);
    if (!r || !r.vactive || !r.active || r.is_service) throw bad('Un article du ticket n’est plus en vente : retirez-le du ticket');
    if (qty > 999) throw bad('Quantité trop grande');
    const unit = num(r.vprice ?? r.price);
    const p = packTotal(unit, qty, packsOf(r.packs));
    return { productId: num(r.pid), variantId, name: r.name as string, variant: r.title as string, sku: r.sku as string, qty, unit, total: p.total, saved: p.saved };
  });
}

/** Records one paid sale (inside a transaction, the counter's lock held): the drawer, its number, the stock, the caisse. */
export async function recordSale(
  db: Db,
  a: { lines: Awaited<ReturnType<typeof priceLines>>; method: PosMethod; customerId: number | null; userId: number; at: string; settings: PosSettings; warehouseId: number },
) {
  let sess = await openSession(db);
  if (!sess) sess = (await db.query('INSERT INTO pos_sessions (opened_at, opened_by, opening) VALUES ($1, $2, 0) RETURNING *', [a.at, a.userId]))[0];
  const ticket = num((await db.query('SELECT COALESCE(max(ticket), 0) + 1 AS n FROM pos_sales'))[0].n);
  const total = a.lines.reduce((s, l) => s + l.total, 0);
  const saved = a.lines.reduce((s, l) => s + l.saved, 0);
  const items = a.lines.reduce((s, l) => s + l.qty, 0);
  const into = await intoFor(db, a.settings, a.method, a.userId);
  const id = num(
    (
      await db.query(
        `INSERT INTO pos_sales (ticket, at, session_id, seller_id, customer_id, method, total, saved, items, warehouse_id, caisse) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [ticket, a.at, sess.id, a.userId, a.customerId, a.method, total, saved, items, a.warehouseId, into],
      )
    )[0].id,
  );
  for (const l of a.lines) {
    await db.query('INSERT INTO pos_lines (sale_id, product_id, variant_id, name, variant, sku, qty, unit, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, l.productId, l.variantId, l.name, l.variant, l.sku, l.qty, l.unit, l.total]);
    await moveStock(db, { variantId: l.variantId, warehouseId: a.warehouseId, delta: -l.qty, reason: 'pos_sale', userId: a.userId, note: `Vente n° ${ticketNo(ticket)}` });
  }
  if (total > 0) {
    const m = await db.query(`INSERT INTO cash_moves (caisse, amount, kind, category, note, created_by, created_at) VALUES ($1,$2,'income','pos',$3,$4,$5) RETURNING id`, [
      into, total, `Vente n° ${ticketNo(ticket)} · ${METHOD_WORD[a.method]}`, a.userId, a.at,
    ]);
    await db.query('UPDATE pos_sales SET cash_move_id = $2 WHERE id = $1', [id, m[0].id]);
  }
  return id;
}

const BUSY = 'Une autre vente est en cours d’enregistrement, réessayez';

// ---------------------------------------------------------------- procedures
export const posProcs = {
  /** The counter's screen: its products with their stock in its dépôt, the drawer, today's sales, its settings. */
  'pos.state': proc(['depot'], z.object({}), async (ctx) => {
    await on(ctx);
    const s = await settingsOf(ctx.db);
    const depot = await depotOf(ctx.db, s);
    const ps = await ctx.db.query(`SELECT id, name, sku, price, packs, photo, barcode FROM products WHERE active AND NOT is_service ORDER BY name, id`);
    const vs = await ctx.db.query(
      `SELECT v.id, v.product_id, v.title, v.sku, v.price, v.photo, COALESCE(st.qty, 0) AS qty FROM product_variants v LEFT JOIN stock st ON st.variant_id = v.id AND st.warehouse_id = $1
       WHERE v.active ORDER BY v.id`,
      [depot.id],
    );
    const byProduct = new Map<number, any[]>();
    for (const v of vs) byProduct.set(num(v.product_id), [...(byProduct.get(num(v.product_id)) ?? []), v]);
    const products = ps
      .filter((p: any) => byProduct.has(num(p.id)))
      .map((p: any) => ({
        id: num(p.id),
        name: p.name as string,
        sku: p.sku as string,
        photo: (p.photo as string | null) ?? null,
        barcode: (p.barcode as string | null) || null,
        price: num(p.price),
        packs: packsOf(p.packs),
        variants: byProduct.get(num(p.id))!.map((v: any) => ({ id: num(v.id), title: v.title as string, sku: v.sku as string, price: num(v.price ?? p.price), photo: (v.photo as string | null) ?? null, stock: num(v.qty) })),
      }));
    const today = { sales: 0, items: 0, total: 0, by: { cash: 0, baridimob: 0, card: 0 } as Record<PosMethod, number> };
    for (const r of await ctx.db.query(`SELECT method, count(*)::int AS n, sum(total)::bigint AS v, sum(items)::bigint AS q FROM pos_sales WHERE at >= $1 AND cancelled_at IS NULL GROUP BY 1`, [iso(dayStart(ctx.now()))])) {
      today.by[r.method as PosMethod] = num(r.v);
      today.sales += num(r.n);
      today.items += num(r.q);
      today.total += num(r.v);
    }
    const shop = await getSetting(ctx.db, 'shop');
    const caisse = s.caisseId && (await ctx.db.query('SELECT name FROM caisses WHERE id = $1 AND removed_at IS NULL', [s.caisseId]))[0];
    const own = caisse ? { key: `c${s.caisseId}`, name: caisse.name as string } : { key: null, name: SHOP_CAISSE };
    const into = {} as Record<PosMethod, { key: string | null; name: string }>;
    for (const m of POS_METHODS) into[m] = (await usable(ctx.db, s.into[m])) ? { key: s.into[m], name: (await caisseLabelOf(ctx.db, s.into[m])) ?? s.into[m]! } : own;
    const caisses = [
      { key: 'main', name: 'Caisse principale' },
      ...((await getSetting(ctx.db, 'caisses')).bankHidden ? [] : [{ key: 'bank', name: 'Banque' }]),
      ...(await ctx.db.query('SELECT id, name FROM caisses WHERE removed_at IS NULL ORDER BY created_at, id')).map((r: any) => ({ key: `c${num(r.id)}`, name: r.name as string })),
    ];
    const sess = await openSession(ctx.db);
    const next = num((await ctx.db.query('SELECT COALESCE(max(ticket), 0) + 1 AS n FROM pos_sales'))[0].n);
    return {
      depot,
      depots: (await ctx.db.query(`SELECT id, name FROM warehouses WHERE active AND archived_at IS NULL ORDER BY is_default DESC, id`)).map((r: any) => ({ id: num(r.id), name: r.name as string })),
      caisse: own,
      into,
      caisses,
      ticket: { title: s.title, phone: s.phone, address: s.address, footer: s.footer, autoPrint: s.autoPrint, shopName: shop.name, shopPhone: shop.savPhone, logo: (await getSetting(ctx.db, 'logo')).url },
      products,
      session: sessionOut(sess),
      today,
      next: ticketNo(next),
      manage: canManage(ctx),
    };
  }),

  /** One paid sale: priced from the catalogue, out of the counter's dépôt, its money into its caisse. Returns its ticket. */
  'pos.sell': proc(['depot'], z.object({ lines: Lines, method: z.enum(POS_METHODS), customerId: z.number().int().positive().nullable().optional() }), async (ctx, i) => {
    await on(ctx);
    const me = ctx.session.profile.id;
    const lines = await priceLines(ctx.db, i.lines);
    if (i.customerId && !(await ctx.db.query('SELECT 1 FROM customers WHERE id = $1', [i.customerId]))[0]) throw bad('Client introuvable');
    const settings = await settingsOf(ctx.db);
    const depot = await depotOf(ctx.db, settings);
    const id = await withActionLock(ctx.db, 'pos:sell', me, BUSY, () =>
      ctx.db.tx((tx) => recordSale(tx, { lines, method: i.method, customerId: i.customerId ?? null, userId: me, at: iso(ctx.now()), settings, warehouseId: depot.id })),
    );
    ctx.emit({ type: 'stock' });
    return (await salesOut(ctx.db, 's.id = $1', [id]))[0];
  }),

  /** A day's sales (today unless `date`, YYYY-MM-DD), the newest first, with what they bring by payment. */
  'pos.sales': proc(['depot'], z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), async (ctx, i) => {
    await on(ctx);
    const from = dayStart(ctx.now(), i.date);
    const sales = await salesOut(ctx.db, 's.at >= $1 AND s.at < $2', [iso(from), iso(from + 86_400_000)]);
    const by: Record<PosMethod, number> = { cash: 0, baridimob: 0, card: 0 };
    let total = 0;
    let items = 0;
    let saved = 0;
    for (const s of sales.filter((x) => !x.cancelledAt)) {
      by[s.method] += s.total;
      total += s.total;
      items += s.items;
      saved += s.saved;
    }
    return { sales, count: sales.filter((x) => !x.cancelledAt).length, cancelled: sales.filter((x) => x.cancelledAt).length, total, items, saved, by };
  }),

  /** The open drawer (what it should hold now) and the last clôtures. */
  'pos.drawer': proc(['depot'], z.object({}), async (ctx) => {
    await on(ctx);
    const sess = await openSession(ctx.db);
    const closed = await ctx.db.query(
      `SELECT s.*, a.name AS by_name, b.name AS closed_name, (SELECT count(*)::int FROM pos_sales x WHERE x.session_id = s.id AND x.cancelled_at IS NULL) AS sales,
              (SELECT COALESCE(sum(total), 0)::bigint FROM pos_sales x WHERE x.session_id = s.id AND x.cancelled_at IS NULL) AS total
       FROM pos_sessions s LEFT JOIN profiles a ON a.id = s.opened_by LEFT JOIN profiles b ON b.id = s.closed_by WHERE s.closed_at IS NOT NULL ORDER BY s.closed_at DESC LIMIT 5`,
    );
    return {
      open: sess ? await drawerOf(ctx.db, sess) : null,
      closed: closed.map((r: any) => ({
        id: num(r.id),
        openedAt: iso(r.opened_at),
        closedAt: iso(r.closed_at),
        who: (r.closed_name as string | null) ?? (r.by_name as string | null) ?? null,
        sales: num(r.sales),
        total: num(r.total),
        expected: num(r.expected),
        counted: num(r.counted),
        gap: num(r.gap),
        note: (r.note as string | null) ?? null,
      })),
    };
  }),

  /** Opens the drawer with its float (the change put in it). */
  'pos.open': proc(['depot'], z.object({ opening: z.number().int().min(0).max(10_000_000) }), async (ctx, i) => {
    await on(ctx);
    return withActionLock(ctx.db, 'pos:sell', ctx.session.profile.id, BUSY, async () => {
      if (await openSession(ctx.db)) throw bad('La caisse est déjà ouverte');
      const r = await ctx.db.query('INSERT INTO pos_sessions (opened_at, opened_by, opening) VALUES ($1, $2, $3) RETURNING id', [iso(ctx.now()), ctx.session.profile.id, i.opening]);
      return { id: num(r[0].id) };
    });
  }),

  /**
   * The clôture: the cash counted (`counts`: how many of each note and coin, kept with it) against what the drawer
   * should hold. A difference is written in the cash's caisse (« Écart de caisse ») and needs a note.
   */
  'pos.close': proc(
    ['depot'],
    z.object({ counted: z.number().int().min(0).max(1_000_000_000), counts: z.record(z.string().regex(/^\d{1,5}$/), z.number().int().min(0).max(100_000)).optional(), note: z.string().trim().max(300).optional() }),
    async (ctx, i) => {
      await on(ctx);
      const me = ctx.session.profile.id;
      if (i.counts && Object.entries(i.counts).reduce((s, [v, n]) => s + Number(v) * n, 0) !== i.counted) throw bad('Le total compté ne correspond pas aux billets et pièces');
      const settings = await settingsOf(ctx.db);
      const out = await withActionLock(ctx.db, 'pos:sell', me, BUSY, () =>
        ctx.db.tx(async (tx) => {
          const sess = await openSession(tx);
          if (!sess) throw bad('La caisse n’est pas ouverte');
          const d = await drawerOf(tx, sess);
          const gap = i.counted - d.expected;
          if (gap && !i.note) throw bad('Écrivez la raison de l’écart avant de clôturer');
          let moveId: number | null = null;
          if (gap) {
            const into = await intoFor(tx, settings, 'cash', me);
            const m = await tx.query(`INSERT INTO cash_moves (caisse, amount, kind, category, note, created_by, created_at) VALUES ($1,$2,$3,'pos_gap',$4,$5,$6) RETURNING id`, [
              into, gap, gap > 0 ? 'income' : 'expense', `Écart à la clôture${i.note ? ` · ${i.note}` : ''}`, me, iso(ctx.now()),
            ]);
            moveId = num(m[0].id);
          }
          await tx.query(`UPDATE pos_sessions SET closed_at = $2, closed_by = $3, expected = $4, counted = $5, gap = $6, counts = $7, note = $8, gap_move_id = $9 WHERE id = $1`, [
            sess.id, iso(ctx.now()), me, d.expected, i.counted, gap, i.counts ? JSON.stringify(i.counts) : null, i.note || null, moveId,
          ]);
          return { ...d, counted: i.counted, gap, closedAt: iso(ctx.now()) };
        }),
      );
      return out;
    },
  ),

  /** Cancels a sale of the open drawer (the owner): its products back in the dépôt, its money out of the caisse. */
  'pos.cancel': proc(['vendeur'], z.object({ id: z.number().int().positive() }), async (ctx, i) => {
    await on(ctx);
    const me = ctx.session.profile.id;
    await withActionLock(ctx.db, 'pos:sell', me, BUSY, () =>
      ctx.db.tx(async (tx) => {
        const s = (await tx.query('SELECT s.*, x.closed_at FROM pos_sales s JOIN pos_sessions x ON x.id = s.session_id WHERE s.id = $1 FOR UPDATE OF s', [i.id]))[0];
        if (!s) throw notFound('Vente introuvable');
        if (s.cancelled_at) throw bad('Cette vente est déjà annulée');
        if (s.closed_at) throw bad('La caisse de cette vente est déjà clôturée');
        for (const l of await tx.query('SELECT variant_id, qty FROM pos_lines WHERE sale_id = $1', [i.id]))
          await moveStock(tx, { variantId: num(l.variant_id), warehouseId: num(s.warehouse_id), delta: num(l.qty), reason: 'pos_cancel', userId: me, note: `Vente n° ${ticketNo(num(s.ticket))} annulée` });
        if (s.cash_move_id) await tx.query('UPDATE cash_moves SET cancelled_at = now() WHERE id = $1', [s.cash_move_id]);
        await tx.query('UPDATE pos_sales SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1', [i.id, me]);
      }),
    );
    ctx.emit({ type: 'stock' });
    return (await salesOut(ctx.db, 's.id = $1', [i.id]))[0];
  }),

  /** Réglages (the owner): the dépôt, where each payment's money goes, the ticket's text. */
  'pos.settings': proc(['vendeur'], SettingsInput, async (ctx, i) => {
    await on(ctx);
    if (i.warehouseId && !(await ctx.db.query('SELECT 1 FROM warehouses WHERE id = $1 AND active AND archived_at IS NULL', [i.warehouseId]))[0]) throw bad('Dépôt inconnu');
    for (const m of POS_METHODS) if (i.into[m] && !(await usable(ctx.db, i.into[m]))) throw bad('Caisse inconnue ou supprimée');
    const s = await settingsOf(ctx.db);
    await setRaw(ctx.db, POS_SETTINGS_KEY, { ...s, ...i }, ctx.session.profile.id);
    return { ok: true };
  }),

  /** The customer at the counter, by phone: his name and how reliable he is (null: not a customer yet). */
  'pos.client': proc(['depot'], z.object({ phone: Phone }), async (ctx, i) => {
    await on(ctx);
    const phone = normalizePhone(i.phone);
    if (!phone) throw bad('Numéro de téléphone invalide');
    const rows = await ctx.db.query(`SELECT c.*, ${CLIENT_FACT_COLS} FROM customers c WHERE c.phone = $1`, [phone]);
    if (!rows[0]) return { phone, customer: null };
    const [score] = await scoresOf(ctx, rows);
    return { phone, customer: { id: num(rows[0].id), name: rows[0].name as string, phone, score: score.score, level: score.level } };
  }),

  /** A new customer met at the counter (his name and phone). */
  'pos.clientNew': proc(['depot'], z.object({ name: z.string().trim().min(2).max(80), phone: Phone }), async (ctx, i) => {
    await on(ctx);
    const phone = normalizePhone(i.phone);
    if (!phone) throw bad('Numéro de téléphone invalide');
    const r = await ctx.db.query(`INSERT INTO customers (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id, name`, [phone, i.name]);
    return { id: num(r[0].id), name: r[0].name as string, phone };
  }),
};

// ---------------------------------------------------------------- the demo shop's counter
/**
 * The counter of the Pilotix preview opened in Claude: turned on, « Caisse boutique », yesterday's drawer closed 100 DA
 * short, today's drawer opened a few hours ago with 5 000 DA and its first sales. Everything is invented.
 */
export async function seedPos(db: Db, now = Date.now()) {
  await setModule(db, 'pos', true);
  if ((await db.query('SELECT 1 FROM pos_sales LIMIT 1'))[0]) return;
  const depotUser = (await db.query(`SELECT id FROM profiles WHERE 'depot' = ANY(roles) ORDER BY id LIMIT 1`))[0];
  const owner = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) ORDER BY id LIMIT 1`))[0];
  if (!owner) return;
  const seller = num((depotUser ?? owner).id);
  const s = await settingsOf(db);
  await shopCaisse(db, s, num(owner.id));
  const depot = await depotOf(db, s);
  const variant = async (sku: string, title = '') =>
    num((await db.query(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.sku = $1 AND v.title = $2`, [sku, title]))[0]?.id);
  const customer = (await db.query('SELECT id FROM customers ORDER BY delivered DESC, id LIMIT 1'))[0];
  type Sale = [minutes: number, method: PosMethod, lines: [sku: string, title: string, qty: number][], customer?: boolean];
  const day = async (start: number, end: number, opening: number, sales: Sale[], close?: { short: number; note: string }) => {
    const sess = num((await db.query('INSERT INTO pos_sessions (opened_at, opened_by, opening) VALUES ($1, $2, $3) RETURNING id', [iso(start), seller, opening]))[0].id);
    for (const [min, method, ls, withCustomer] of sales) {
      const want: { variantId: number; qty: number }[] = [];
      for (const [sku, title, qty] of ls) {
        const v = await variant(sku, title);
        if (v) want.push({ variantId: v, qty });
      }
      if (!want.length) continue;
      const at = Math.min(start + min * 60_000, end);
      await recordSale(db, { lines: await priceLines(db, want), method, customerId: withCustomer && customer ? num(customer.id) : null, userId: seller, at: iso(at), settings: s, warehouseId: depot.id });
    }
    // the stock's movements and the sales of the demo, at the sales' times
    await db.query(`UPDATE stock_movements m SET created_at = x.at FROM pos_sales x WHERE x.session_id = $1 AND m.reason = 'pos_sale' AND m.note = 'Vente n° ' || lpad(x.ticket::text, 4, '0')`, [sess]);
    if (close) {
      const d = await drawerOf(db, (await db.query('SELECT * FROM pos_sessions WHERE id = $1', [sess]))[0]);
      const counted = d.expected - close.short;
      const m = await db.query(`INSERT INTO cash_moves (caisse, amount, kind, category, note, created_by, created_at) VALUES ($1,$2,'expense','pos_gap',$3,$4,$5) RETURNING id`, [
        await intoFor(db, s, 'cash', seller), -close.short, `Écart à la clôture · ${close.note}`, seller, iso(end),
      ]);
      await db.query(`UPDATE pos_sessions SET closed_at = $2, closed_by = $3, expected = $4, counted = $5, gap = $6, note = $7, gap_move_id = $8 WHERE id = $1`, [
        sess, iso(end), seller, d.expected, counted, -close.short, close.note, m[0].id,
      ]);
    }
  };
  const today = dayStart(now);
  // yesterday: 09:00 to 19:00, closed 100 DA short
  const y = today - 86_400_000;
  await day(y + 9 * 3_600_000, y + 19 * 3_600_000, 5000, [
    [25, 'cash', [['PX-BOD', '6 mois', 2]]],
    [70, 'cash', [['PX-POU', 'Bleu marine', 1]]],
    [150, 'baridimob', [['PX-SAC', 'Camel', 1]], true],
    [260, 'cash', [['PX-BIB', '', 3]]],
    [400, 'card', [['PX-CHA', '', 1]]],
  ], { short: 100, note: 'Monnaie rendue en trop' });
  // today: opened a few hours ago (at 09:00 once the morning is over), its first sales since
  const opened = Math.max(today + 60_000, Math.min(today + 9 * 3_600_000, now - 4.5 * 3_600_000));
  const span = Math.max(1, (now - opened) / 60_000);
  const at = (k: number) => Math.round((span * k) / 7);
  await day(opened, now - 60_000, 5000, [
    [at(1), 'cash', [['PX-TAP', '', 1]]],
    [at(2), 'baridimob', [['PX-ENS', '3-6 mois', 2]], true],
    [at(3), 'cash', [['PX-LIT', 'Beige', 1]]],
    [at(4), 'cash', [['PX-BIB', '', 1], ['PX-THE', '', 1]]],
    [at(5), 'card', [['PX-ECH', 'Vert sauge', 1]]],
    [at(6), 'cash', [['PX-CHA', '', 1]]],
  ]);
}
