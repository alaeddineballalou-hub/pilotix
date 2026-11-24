import { CLIENT_LEVELS, CONF_DONE_BAD, normalizePhone, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { ownRowSql, rowScopeSql } from './agencyscope';
import { iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { addEvent } from './orders';
import { CLIENT_FACT_COLS, ClientScore, scoresAll, scoresOf } from './clientscore';
import { shareBlacklist } from './sharedblacklist';
import { readGuide, toFill } from './guide';
import { assignedProductIds } from './productscope';

const id = z.number().int().positive();

export interface CustomerRow {
  id: number;
  name: string;
  phone: string;
  wilayaId: number | null;
  blacklisted: boolean;
  blacklistReason: string | null;
  orders: number;
  delivered: number;
  returned: number;
  cancelled: number;
  lastOrderAt: string | null;
  createdAt: string;
  /** out of 100: what the protection knows about this number (clientscore.ts) */
  score: ClientScore;
  /** WhatsApp offers (Marketing › Campagnes): said yes, said « Stop », or never asked */
  waOffers: 'yes' | 'stop' | null;
  /** the history brought from another app (Clients › « Importer des clients »), apart from Pilotix's own orders */
  imported: ImportedHistory | null;
}

/** A customer's history in the shop's old database (another app, an Excel file…), imported with « Importer des clients ». */
export interface ImportedHistory {
  /** the file it came from (kept for the record; the page calls it « Ancienne base ») */
  source: string;
  orders: number;
  delivered: number;
  returned: number;
  fake: number;
  cancelled: number;
  /** the last order there, when the file said it */
  lastOrderAt: string | null;
  /** when it was imported */
  at: string;
}

// Counts come from the orders themselves (always right, even after edits / merges).
const COLS = `c.*,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id) AS n_orders,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.follow_status IN ('delivered','exchanged')) AS n_delivered,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.follow_status IN ('returning','returned')) AS n_returned,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.conf_status = ANY('{${CONF_DONE_BAD.join(',')}}')) AS n_cancelled,
  (SELECT max(o.created_at) FROM sales o WHERE o.customer_id = c.id) AS last_at,
  ${CLIENT_FACT_COLS}`;

const toCustomer = (r: any, score: ClientScore): CustomerRow => ({
  id: num(r.id),
  name: r.name,
  phone: r.phone,
  wilayaId: numOrNull(r.wilaya_id),
  blacklisted: !!r.blacklisted,
  blacklistReason: r.blacklist_reason ?? null,
  orders: num(r.n_orders),
  delivered: num(r.n_delivered),
  returned: num(r.n_returned),
  cancelled: num(r.n_cancelled),
  lastOrderAt: isoOrNull(r.last_at ?? r.last_order_at),
  createdAt: iso(r.created_at),
  score,
  waOffers: r.wa_optout_at ? 'stop' : r.wa_optin_at ? 'yes' : null,
  imported: r.imp_source
    ? {
        source: String(r.imp_source),
        orders: num(r.imp_orders),
        delivered: num(r.imp_delivered),
        returned: num(r.imp_returned),
        fake: num(r.imp_fake),
        cancelled: num(r.imp_cancelled),
        lastOrderAt: isoOrNull(r.imp_last_at),
        at: iso(r.imp_at ?? r.created_at),
      }
    : null,
});

// ---------------------------------------------------------------- « Importer des clients »
const count = z.number().int().min(0).max(100_000).default(0);
/** one line of the file, as the page read it (the page finds the columns; the server checks the numbers) */
const importRow = z.object({
  phone: z.string().max(60),
  name: z.string().max(300).optional(),
  wilayaId: z.number().int().min(1).max(WILAYAS.length).nullable().optional(),
  orders: count,
  delivered: count,
  returned: count,
  fake: count,
  cancelled: count,
  lastOrderAt: z.string().max(40).nullable().optional(),
  blacklisted: z.boolean().optional(),
});
export type ImportCustomerRow = z.input<typeof importRow>;
/** the most lines one call takes (the page sends a big file in parts) */
export const IMPORT_CUSTOMERS_MAX = 1000;
const isoDay = (s: string | null | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const WHO = ['confirmation', 'suivi'] as const;

/** A customer's order, as the history lists it. */
export interface CustomerOrder {
  id: number;
  ref: string;
  createdAt: string;
  total: number;
  confStatus: string;
  followStatus: string | null;
  attempts: number;
  itemsText: string;
  variantsText: string;
}

/**
 * A customer (by id or phone) with their orders, newest first; null when the number never ordered here. A confirmation
 * agency's agent sees only the agency's own orders of this customer (the store's others are not its business); the
 * store's own confirmation agent, his own orders of this customer.
 */
async function historyOf(ctx: Ctx, i: { id?: number; phone?: string }): Promise<{ customer: CustomerRow; orders: CustomerOrder[] } | null> {
  let r: any;
  if (i.id) r = (await ctx.db.query(`SELECT ${COLS} FROM customers c WHERE c.id = $1`, [i.id]))[0];
  else if (i.phone) {
    const p = normalizePhone(i.phone);
    if (!p) throw bad('Numéro de téléphone algérien invalide');
    r = (await ctx.db.query(`SELECT ${COLS} FROM customers c WHERE c.phone = $1`, [p]))[0];
  } else throw bad('Indiquez le client');
  if (!r) return null;
  const scope = rowScopeSql(ctx);
  const orders = await ctx.db.query(
    `SELECT o.id, o.ref, o.created_at, o.total, o.conf_status, o.follow_status, o.attempts,
       (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name, ' · ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items_text,
       (SELECT CASE WHEN bool_or(i.variant_title <> '') THEN string_agg(CASE WHEN i.variant_title <> '' THEN i.variant_title ELSE '—' END, ' · ' ORDER BY i.id) END FROM order_items i WHERE i.order_id = o.id) AS variants_text
     FROM sales o WHERE (o.customer_id = $1 OR o.phone = $2)${scope ? ` AND ${scope}` : ''} ORDER BY o.created_at DESC LIMIT 100`,
    [r.id, r.phone],
  );
  return {
    customer: toCustomer(r, (await scoresOf(ctx, [r]))[0]),
    orders: orders.map((o: any) => ({
      id: num(o.id), ref: o.ref, createdAt: iso(o.created_at), total: num(o.total), confStatus: o.conf_status, followStatus: o.follow_status ?? null, attempts: num(o.attempts), itemsText: o.items_text ?? '', variantsText: o.variants_text ?? '',
    })),
  };
}

/** A quick reply of a product's sales guide: a question customers ask, or a hesitation, with the shop's answer. */
export interface WaReply {
  kind: 'doubt' | 'faq';
  q: string;
  a: string;
}

/** The Pilotix extension's card on WhatsApp Web (customers.waCard). */
export interface WaCard {
  /** the number as Pilotix writes it (0555…) */
  phone: string;
  /** null: this number never ordered here */
  customer: CustomerRow | null;
  /** their last orders (5 at most) */
  orders: CustomerOrder[];
  /** the product whose quick replies are shown (the one chosen, else the one of their last order with a guide) */
  product: { id: number; name: string } | null;
  /** the products with a sales guide this person may read, to choose from */
  products: { id: number; name: string }[];
  replies: WaReply[];
  /** this person sees only their own customers (an agent): a number that is not one of them shows as unknown */
  scoped: boolean;
}

/**
 * The card of the chat open on WhatsApp Web (the Pilotix extension): who this number is in Pilotix (level, blacklist,
 * last orders) and quick replies from the sales guide (hesitations first, then questions), only the answers written.
 * An agent who sees only their own orders (an agency's, or the store's own confirmation agent) gets the customer only
 * when one of their orders is that number's: any other number shows as unknown (whether it ordered elsewhere or not).
 */
async function waCard(ctx: Ctx, i: { phone: string; productId?: number }): Promise<WaCard> {
  const phone = normalizePhone(i.phone);
  if (!phone) throw bad('Numéro algérien invalide');
  const scoped = !!rowScopeSql(ctx);
  let h = await historyOf(ctx, { phone });
  if (h && scoped && !h.orders.length) h = null;
  const allowed = await assignedProductIds(ctx);
  const products = (
    await ctx.db.query(
      `SELECT p.id, p.name FROM products p JOIN product_guides g ON g.product_id = p.id
       WHERE p.archived_at IS NULL AND ($1::bigint[] IS NULL OR p.id = ANY($1)) ORDER BY p.name LIMIT 60`,
      [allowed],
    )
  ).map((r: any) => ({ id: num(r.id), name: String(r.name) }));
  const has = new Set(products.map((p) => p.id));
  // the product chosen, else the newest of their orders' products that has a guide
  let pid = i.productId && has.has(i.productId) ? i.productId : null;
  if (!pid && h?.orders.length) {
    const ids = h.orders.slice(0, 5).map((o) => o.id);
    const rows = await ctx.db.query(`SELECT i.product_id FROM order_items i WHERE i.order_id = ANY($1) ORDER BY i.order_id DESC, i.id`, [ids]);
    pid = rows.map((r: any) => num(r.product_id)).find((x: number) => has.has(x)) ?? null;
  }
  const g = pid ? await readGuide(ctx.db, pid) : null;
  const real = (x: { q: string; a: string }) => !!x.q.trim() && !toFill(x.a);
  const replies: WaReply[] = g
    ? [...g.guide.doubts.filter(real).map((x) => ({ kind: 'doubt' as const, q: x.q, a: x.a })), ...g.guide.faq.filter(real).map((x) => ({ kind: 'faq' as const, q: x.q, a: x.a }))].slice(0, 16)
    : [];
  return {
    phone,
    customer: h?.customer ?? null,
    orders: h?.orders.slice(0, 5) ?? [],
    product: pid ? (products.find((p) => p.id === pid) ?? null) : null,
    products,
    replies,
    scoped,
  };
}

/** customers procedures: list, order history, blacklist. */
export const customersProcs = {
  'customers.ping': proc(null, z.object({}), async () => ({ ok: true })),

  'customers.list': proc(
    [...WHO],
    z.object({
      q: z.string().max(100).optional(),
      blacklisted: z.boolean().optional(),
      /** only the customers of this score level (Top / Bon / À surveiller / Risqué / Nouveau) */
      level: z.enum(CLIENT_LEVELS).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(500).default(60),
    }),
    async (ctx, f) => {
      const w = new Where();
      const q = f.q?.trim().replace(/[,()"*%]/g, ' ').trim();
      if (q) {
        const digits = q.replace(/\D/g, '');
        if (digits.length >= 3) w.add("(c.name ILIKE '%' || ? || '%' OR c.phone LIKE '%' || ? || '%')", q, digits.replace(/^213/, '0').replace(/^00213/, '0'));
        else w.add("c.name ILIKE '%' || ? || '%'", q);
      }
      if (f.blacklisted) w.add('c.blacklisted');
      // the store's own confirmation agent: the customers of his own orders only
      const own = ownRowSql(ctx);
      if (own) w.add(`EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND ${own})`);
      if (f.level) {
        // the score is not in the database: every matching customer is scored (their facts counted once per table),
        // the level kept, then the page cut in the same order as the list
        const all = (await scoresAll(ctx, w.sql, w.params)).filter((x) => x.score.level === f.level).sort((a, b) => b.lastOrderAt - a.lastOrderAt || b.id - a.id);
        const pageOf = all.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);
        const rows = pageOf.length ? await ctx.db.query(`SELECT ${COLS} FROM customers c WHERE c.id = ANY($1::bigint[])`, [pageOf.map((x) => x.id)]) : [];
        const byId = new Map(rows.map((r: any) => [num(r.id), r]));
        return { rows: pageOf.filter((x) => byId.has(x.id)).map((x) => toCustomer(byId.get(x.id), x.score)), total: all.length, page: f.page, pageSize: f.pageSize };
      }
      const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM customers c ${w.sql}`, w.params))[0]?.n);
      const lim = w.p(f.pageSize);
      const off = w.p((f.page - 1) * f.pageSize);
      const rows = await ctx.db.query(`SELECT ${COLS} FROM customers c ${w.sql} ORDER BY greatest(c.last_order_at, c.imp_last_at) DESC NULLS LAST, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
      const scores = await scoresOf(ctx, rows);
      return { rows: rows.map((r: any, k: number) => toCustomer(r, scores[k])), total, page: f.page, pageSize: f.pageSize };
    },
  ),

  /** A customer (by id or phone) with their orders, newest first. */
  'customers.history': proc([...WHO], z.object({ id: id.optional(), phone: z.string().max(20).optional() }), async (ctx, i) => {
    const h = await historyOf(ctx, i);
    if (!h) throw notFound('Client introuvable');
    return h;
  }),

  /** The Pilotix extension's card on WhatsApp Web: the customer of the chat open there, and quick replies. */
  'customers.waCard': proc([...WHO], z.object({ phone: z.string().max(40), productId: id.optional() }), (ctx, i) => waCard(ctx, i)),

  /**
   * Clients › « Importer des clients » (admin): customers from another app WITH their history there (orders, delivered,
   * refused, fake, cancelled), so their score and level show from the first day. At most 1,000 lines a call (the page
   * sends a big file in parts). A new number becomes a customer; a number already here keeps its name, wilaya and
   * orders: only its imported history is written. Importing again REPLACES that history (it never adds up). A « liste
   * noire » line blacklists the number (never takes one off), and the owner's other boutiques follow. Nothing is deleted.
   */
  'customers.import': proc(
    [],
    z.object({ source: z.string().trim().max(120).optional(), rows: z.array(importRow).min(1).max(IMPORT_CUSTOMERS_MAX) }),
    async (ctx, i) => {
      const at = new Date(ctx.now()).toISOString();
      const byPhone = new Map<string, z.output<typeof importRow>>();
      let invalid = 0;
      for (const r of i.rows) {
        const p = normalizePhone(r.phone);
        if (p) byPhone.set(p, r); // the same number twice: its last line counts
        else invalid++;
      }
      const phones = [...byPhone.keys()];
      if (!phones.length) return { added: 0, updated: 0, invalid, blacklisted: 0, shared: [] as string[] };
      const rows = [...byPhone.values()];
      const source = i.source || 'import';
      const reason = 'Ancienne base';
      const res = await ctx.db.tx(async (tx) => {
        const had = new Set((await tx.query('SELECT phone FROM customers WHERE phone = ANY($1::text[])', [phones])).map((x: any) => String(x.phone)));
        await tx.query(
          `INSERT INTO customers (phone, name, wilaya_id, imp_orders, imp_delivered, imp_returned, imp_fake, imp_cancelled, imp_last_at, imp_source, imp_at)
           SELECT x.p, x.n, x.w, x.o, x.d, x.r, x.f, x.c, x.l, $10, $11
             FROM unnest($1::text[], $2::text[], $3::smallint[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::timestamptz[]) AS x(p, n, w, o, d, r, f, c, l)
           ON CONFLICT (phone) DO UPDATE SET
             imp_orders = EXCLUDED.imp_orders, imp_delivered = EXCLUDED.imp_delivered, imp_returned = EXCLUDED.imp_returned,
             imp_fake = EXCLUDED.imp_fake, imp_cancelled = EXCLUDED.imp_cancelled, imp_last_at = EXCLUDED.imp_last_at,
             imp_source = EXCLUDED.imp_source, imp_at = EXCLUDED.imp_at,
             name = CASE WHEN coalesce(customers.name, '') = '' THEN EXCLUDED.name ELSE customers.name END,
             wilaya_id = coalesce(customers.wilaya_id, EXCLUDED.wilaya_id)`,
          [
            phones,
            rows.map((r) => (r.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)),
            rows.map((r) => r.wilayaId ?? null),
            // a file without an « orders » column still counts the orders it tells about
            rows.map((r) => Math.max(r.orders, r.delivered + r.returned + r.fake + r.cancelled)),
            rows.map((r) => r.delivered),
            rows.map((r) => r.returned),
            rows.map((r) => r.fake),
            rows.map((r) => r.cancelled),
            rows.map((r) => isoDay(r.lastOrderAt)),
            source,
            at,
          ],
        );
        const black = phones.filter((p) => byPhone.get(p)!.blacklisted);
        const newly = black.length
          ? await tx.query(
              `UPDATE customers SET blacklisted = true, blacklist_reason = coalesce(blacklist_reason, $2), blacklist_auto = false, blacklist_shop = NULL
                WHERE phone = ANY($1::text[]) AND NOT blacklisted RETURNING phone, name, wilaya_id`,
              [black, reason],
            )
          : [];
        return { added: phones.filter((p) => !had.has(p)).length, updated: phones.filter((p) => had.has(p)).length, newly };
      });
      // the owner's other boutiques follow (« Liste noire partagée »), as for a number blacklisted by hand
      const shared = res.newly.length
        ? await shareBlacklist(ctx, res.newly.map((r: any) => ({ phone: String(r.phone), name: String(r.name ?? ''), wilayaId: numOrNull(r.wilaya_id) })), true, reason)
        : [];
      ctx.emit({ type: 'orders' });
      return { added: res.added, updated: res.updated, invalid, blacklisted: res.newly.length, shared };
    },
  ),

  /** Put a phone number on (or off) the blacklist. New orders from it then arrive as "À vérifier". */
  'customers.setBlacklist': proc(
    [...WHO],
    z.object({ id: id.optional(), phone: z.string().max(20).optional(), on: z.boolean(), reason: z.string().trim().max(300).nullable().optional() }),
    async (ctx, i) => {
      const phone = i.phone ? normalizePhone(i.phone) : null;
      if (!i.id && !phone) throw bad('Indiquez le client');
      const r = (
        await ctx.db.query(
          `UPDATE customers SET blacklisted = $3, blacklist_reason = CASE WHEN $3 THEN $4 ELSE NULL END, blacklist_auto = false, blacklist_shop = NULL
           WHERE ($1::bigint IS NOT NULL AND id = $1) OR ($1::bigint IS NULL AND phone = $2) RETURNING id, phone, name, wilaya_id`,
          [i.id ?? null, phone, i.on, i.reason || null],
        )
      )[0];
      if (!r) throw notFound('Client introuvable');
      // Leave a trace on their open orders (visible in the order history).
      const open = await ctx.db.query(`SELECT id FROM sales WHERE customer_id = $1 AND (follow_status IS NULL OR follow_status IN ('to_prepare','prepared')) AND conf_status <> ALL($2)`, [r.id, CONF_DONE_BAD]);
      for (const o of open) await addEvent(ctx.db, num(o.id), ctx.session.profile.id, 'note', null, 'event', i.on ? `Client mis en liste noire${i.reason ? ` : ${i.reason}` : ''}` : 'Client retiré de la liste noire');
      // the owner's other boutiques follow (« Liste noire partagée »)
      const shared = await shareBlacklist(ctx, [{ phone: String(r.phone), name: String(r.name ?? ''), wilayaId: numOrNull(r.wilaya_id) }], i.on, i.reason || null);
      ctx.emit({ type: 'orders' });
      return { ok: true, id: num(r.id), blacklisted: i.on, shared };
    },
  ),
};
