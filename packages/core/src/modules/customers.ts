import { CLIENT_LEVELS, CONF_DONE_BAD, normalizePhone } from '@pilotix/shared';
import { z } from 'zod';
import { iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, notFound, proc } from '../rpc';
import { addEvent } from './orders';
import { CLIENT_FACT_COLS, ClientScore, scoresAll, scoresOf } from './clientscore';

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
});

const WHO = ['confirmation', 'suivi'] as const;

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
      const rows = await ctx.db.query(`SELECT ${COLS} FROM customers c ${w.sql} ORDER BY c.last_order_at DESC NULLS LAST, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
      const scores = await scoresOf(ctx, rows);
      return { rows: rows.map((r: any, k: number) => toCustomer(r, scores[k])), total, page: f.page, pageSize: f.pageSize };
    },
  ),

  /** A customer (by id or phone) with their orders, newest first. */
  'customers.history': proc([...WHO], z.object({ id: id.optional(), phone: z.string().max(20).optional() }), async (ctx, i) => {
    let r: any;
    if (i.id) r = (await ctx.db.query(`SELECT ${COLS} FROM customers c WHERE c.id = $1`, [i.id]))[0];
    else if (i.phone) {
      const p = normalizePhone(i.phone);
      if (!p) throw bad('Numéro de téléphone algérien invalide');
      r = (await ctx.db.query(`SELECT ${COLS} FROM customers c WHERE c.phone = $1`, [p]))[0];
    } else throw bad('Indiquez le client');
    if (!r) throw notFound('Client introuvable');
    const orders = await ctx.db.query(
      `SELECT o.id, o.ref, o.created_at, o.total, o.conf_status, o.follow_status, o.attempts,
         (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name, ' · ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items_text,
         (SELECT CASE WHEN bool_or(i.variant_title <> '') THEN string_agg(CASE WHEN i.variant_title <> '' THEN i.variant_title ELSE '—' END, ' · ' ORDER BY i.id) END FROM order_items i WHERE i.order_id = o.id) AS variants_text
       FROM sales o WHERE o.customer_id = $1 OR o.phone = $2 ORDER BY o.created_at DESC LIMIT 100`,
      [r.id, r.phone],
    );
    return {
      customer: toCustomer(r, (await scoresOf(ctx, [r]))[0]),
      orders: orders.map((o: any) => ({
        id: num(o.id), ref: o.ref, createdAt: iso(o.created_at), total: num(o.total), confStatus: o.conf_status, followStatus: o.follow_status ?? null, attempts: num(o.attempts), itemsText: o.items_text ?? '', variantsText: o.variants_text ?? '',
      })),
    };
  }),

  /** Put a phone number on (or off) the blacklist. New orders from it then arrive as "À vérifier". */
  'customers.setBlacklist': proc(
    [...WHO],
    z.object({ id: id.optional(), phone: z.string().max(20).optional(), on: z.boolean(), reason: z.string().trim().max(300).nullable().optional() }),
    async (ctx, i) => {
      const phone = i.phone ? normalizePhone(i.phone) : null;
      if (!i.id && !phone) throw bad('Indiquez le client');
      const r = (
        await ctx.db.query(
          `UPDATE customers SET blacklisted = $3, blacklist_reason = CASE WHEN $3 THEN $4 ELSE NULL END, blacklist_auto = false
           WHERE ($1::bigint IS NOT NULL AND id = $1) OR ($1::bigint IS NULL AND phone = $2) RETURNING id, phone`,
          [i.id ?? null, phone, i.on, i.reason || null],
        )
      )[0];
      if (!r) throw notFound('Client introuvable');
      // Leave a trace on their open orders (visible in the order history).
      const open = await ctx.db.query(`SELECT id FROM sales WHERE customer_id = $1 AND (follow_status IS NULL OR follow_status IN ('to_prepare','prepared')) AND conf_status <> ALL($2)`, [r.id, CONF_DONE_BAD]);
      for (const o of open) await addEvent(ctx.db, num(o.id), ctx.session.profile.id, 'note', null, 'event', i.on ? `Client mis en liste noire${i.reason ? ` : ${i.reason}` : ''}` : 'Client retiré de la liste noire');
      ctx.emit({ type: 'orders' });
      return { ok: true, id: num(r.id), blacklisted: i.on };
    },
  ),
};
