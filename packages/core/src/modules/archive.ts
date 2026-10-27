// Management › Archives: accounts, products and depots the shop does not need any more leave every list but stay in
// the history (orders, stock, caisse…): archived = closed and hidden. Only what is archived AND was never used (no
// order, no stock movement, no money, no message…) can be deleted for good. An archived thing can come back
// (closed: the administrator opens it again as usual).
import { z } from 'zod';
import { Db, isoOrNull, num } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';

export const ARCHIVE_KINDS = ['users', 'products', 'warehouses'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/** What a thing is linked to (the reason it cannot be deleted). */
export type UseKind = 'orders' | 'stock' | 'cash' | 'delivery' | 'messages' | 'marketing' | 'pages' | 'products' | 'history';

/** Why a thing cannot be archived now. */
export type ArchiveBlock = 'self' | 'owner' | 'parcels' | 'stock' | 'default';

type Ref = readonly [table: string, column: string, use: UseKind];

/** Every column that points to an account (profiles.id): an account found in one of them did some work. */
export const USER_REFS: readonly Ref[] = [
  ['orders', 'agent_id', 'orders'],
  ['orders', 'created_by', 'orders'],
  ['orders', 'follow_agent_id', 'orders'],
  ['orders', 'livreur_id', 'orders'],
  ['orders', 'locked_by', 'orders'],
  ['order_events', 'user_id', 'orders'],
  ['applied_actions', 'user_id', 'orders'],
  ['stock_movements', 'user_id', 'stock'],
  ['purchases', 'created_by', 'stock'],
  ['inventories', 'created_by', 'stock'],
  ['depot_restock', 'updated_by', 'stock'],
  ['pickup_bags', 'created_by', 'delivery'],
  ['parcel_changes', 'created_by', 'delivery'],
  ['claims', 'created_by', 'delivery'],
  ['claims', 'livreur_id', 'delivery'],
  ['complaints', 'created_by', 'delivery'],
  ['complaints', 'satisfaction_by', 'delivery'],
  ['complaints', 'assigned_to', 'delivery'],
  ['livreur_routes', 'profile_id', 'delivery'],
  ['cash_moves', 'created_by', 'cash'],
  ['cash_handovers', 'created_by', 'cash'],
  ['cash_handovers', 'livreur_id', 'cash'],
  ['caisses', 'created_by', 'cash'],
  ['courier_payments', 'imported_by', 'cash'],
  ['chat_messages', 'user_id', 'messages'],
  ['chat_messages', 'livreur_id', 'messages'],
  ['conversations', 'created_by', 'messages'],
  ['conversations', 'assigned_to', 'messages'],
  ['conv_messages', 'user_id', 'messages'],
  ['cm_comments', 'handled_by', 'messages'],
  ['notifications', 'sent_by', 'messages'],
  ['adsets', 'marketer_id', 'marketing'],
  ['ad_month_closes', 'closed_by', 'marketing'],
  ['marketer_prices', 'profile_id', 'marketing'],
  ['mk_payments', 'marketer_id', 'marketing'],
  ['mk_payments', 'paid_by', 'marketing'],
  ['mk_results', 'set_by', 'marketing'],
  ['spy_follow', 'created_by', 'marketing'],
  ['landing_pages', 'created_by', 'pages'],
  ['landing_images', 'created_by', 'pages'],
  ['landing_leads', 'handled_by', 'pages'],
  ['landing_blocked', 'handled_by', 'pages'],
  ['products', 'seller_id', 'products'],
  ['product_changes', 'user_id', 'products'],
];

/** Columns that point to a product (products.id). */
export const PRODUCT_REFS: readonly Ref[] = [
  ['order_items', 'product_id', 'orders'],
  ['landing_pages', 'product_id', 'pages'],
  ['landing_leads', 'product_id', 'pages'],
  ['landing_submits', 'product_id', 'pages'],
  ['landing_blocked', 'product_id', 'pages'],
  ['cm_posts', 'product_id', 'messages'],
  ['depot_pick_pool', 'product_id', 'stock'],
  ['depot_restock', 'product_id', 'stock'],
];
/** Columns that point to one of its variants (product_variants.id): the product is used. */
export const VARIANT_REFS: readonly Ref[] = [
  ['order_items', 'variant_id', 'orders'],
  ['stock_movements', 'variant_id', 'stock'],
  ['purchase_lines', 'variant_id', 'stock'],
  ['landing_leads', 'variant_id', 'pages'],
  ['landing_blocked', 'variant_id', 'pages'],
  ['depot_pick_pool', 'variant_id', 'stock'],
  ['depot_restock', 'variant_id', 'stock'],
];
/** Columns that point to a depot (warehouses.id). */
export const WAREHOUSE_REFS: readonly Ref[] = [
  ['orders', 'warehouse_id', 'orders'],
  ['stock_movements', 'warehouse_id', 'stock'],
  ['purchases', 'warehouse_id', 'stock'],
  ['inventories', 'warehouse_id', 'stock'],
];
/**
 * Columns that look like links but are not history to keep: they go with the thing (its variants, its own change log,
 * its empty stock lines, AI Spy's notes on a product, a password link), or only say who changed a setting.
 */
export const NOT_REFS: readonly string[] = [
  'password_resets.profile_id',
  'action_locks.user_id',
  'settings.updated_by',
  'referrals.referrer_id',
  'product_variants.product_id',
  'product_changes.product_id',
  'stock.variant_id',
  'stock.warehouse_id',
  'spy_watch.product_id',
  'spy_ads.product_id',
  'spy_follow.product_id',
  'spy_events.product_id',
];

const KIND = z.enum(ARCHIVE_KINDS);
const DAY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const ListInput = z.object({
  kind: KIND,
  /** false: what is in use (to archive); true: the archives */
  archived: z.boolean().default(false),
  /** the dates are its creation, or its last activity (its creation when it never did anything) */
  field: z.enum(['created', 'activity']).default('activity'),
  from: DAY,
  to: DAY,
  q: z.string().trim().max(100).optional(),
});
const IdsInput = z.object({ kind: KIND, ids: z.array(z.number().int().positive()).min(1).max(500) });

export interface ArchiveRow {
  id: number;
  name: string;
  /** e-mail, SKU or place */
  detail: string;
  roles: string[];
  wilayaId: number | null;
  createdAt: string | null;
  /** last activity: last login, last order or stock movement */
  lastAt: string | null;
  archivedAt: string | null;
  active: boolean;
  /** what it is linked to: empty = never used (it can be deleted once archived) */
  uses: UseKind[];
  /** why it cannot be archived now */
  blocked: ArchiveBlock | null;
  /** pieces left in stock (products, depots) */
  stock: number;
}

// ---------------------------------------------------------------- what is used
/** For each id, what it is linked to (one query per column for the whole list). */
export async function usesOf(db: Db, kind: ArchiveKind, ids: number[]): Promise<Map<number, UseKind[]>> {
  const out = new Map<number, Set<UseKind>>();
  const mark = (id: unknown, u: UseKind) => {
    const k = num(id);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k)!.add(u);
  };
  if (ids.length) {
    const refs = kind === 'users' ? USER_REFS : kind === 'products' ? PRODUCT_REFS : WAREHOUSE_REFS;
    for (const [tb, col, u] of refs) for (const r of await db.query(`SELECT DISTINCT ${col} AS id FROM ${tb} WHERE ${col} = ANY($1)`, [ids])) mark(r.id, u);
    if (kind === 'products') {
      for (const [tb, col, u] of VARIANT_REFS)
        for (const r of await db.query(`SELECT DISTINCT v.product_id AS id FROM ${tb} t JOIN product_variants v ON v.id = t.${col} WHERE v.product_id = ANY($1)`, [ids])) mark(r.id, u);
      for (const r of await db.query(`SELECT DISTINCT unnest(product_ids) AS id FROM adsets WHERE product_ids && $1::bigint[]`, [ids])) if (ids.includes(num(r.id))) mark(r.id, 'marketing');
      for (const r of await db.query(`SELECT DISTINCT v.product_id AS id FROM stock s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ANY($1) AND s.qty <> 0`, [ids])) mark(r.id, 'stock');
    }
    if (kind === 'warehouses') for (const r of await db.query(`SELECT DISTINCT warehouse_id AS id FROM stock WHERE warehouse_id = ANY($1) AND qty <> 0`, [ids])) mark(r.id, 'stock');
  }
  return new Map(ids.map((id) => [id, [...(out.get(id) ?? [])]]));
}

/** A livreur with parcels on the road or cash to hand over cannot leave: it would vanish from « Doit verser ». */
async function withParcels(db: Db, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db.query(
    `SELECT DISTINCT livreur_id AS id FROM orders
      WHERE livreur_id = ANY($1) AND (follow_status = ANY($2) OR (follow_status = 'delivered' AND NOT cashed))`,
    [ids, ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'returning']],
  );
  return new Set(rows.map((r: any) => num(r.id)));
}

/** Pieces in stock per product / per depot (anything but zero must be moved out first). */
async function stockOf(db: Db, kind: ArchiveKind, ids: number[]): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  if (!ids.length || kind === 'users') return m;
  const rows =
    kind === 'products'
      ? await db.query(`SELECT v.product_id AS id, sum(abs(s.qty))::bigint AS n FROM stock s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ANY($1) GROUP BY 1`, [ids])
      : await db.query(`SELECT warehouse_id AS id, sum(abs(qty))::bigint AS n FROM stock WHERE warehouse_id = ANY($1) GROUP BY 1`, [ids]);
  for (const r of rows) m.set(num(r.id), num(r.n));
  return m;
}

// ---------------------------------------------------------------- the lists
/** « last activity » in SQL, per kind (its creation date stands in when it never did anything). */
const LAST: Record<ArchiveKind, string> = {
  users: 'x.last_seen_at',
  products: `GREATEST((SELECT max(o.created_at) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = x.id),
                      (SELECT max(m.created_at) FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id WHERE v.product_id = x.id))`,
  warehouses: `GREATEST((SELECT max(o.created_at) FROM orders o WHERE o.warehouse_id = x.id), (SELECT max(m.created_at) FROM stock_movements m WHERE m.warehouse_id = x.id))`,
};
const TABLE: Record<ArchiveKind, string> = { users: 'profiles', products: 'products', warehouses: 'warehouses' };

export async function archiveList(ctx: Ctx, i: z.infer<typeof ListInput>): Promise<ArchiveRow[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = [i.archived ? 'x.archived_at IS NOT NULL' : 'x.archived_at IS NULL'];
  const date = i.field === 'created' ? 'x.created_at' : `COALESCE(${LAST[i.kind]}, x.created_at)`;
  if (i.from) where.push(`${date} >= ${p(i.from)}::date`);
  if (i.to) where.push(`${date} < ${p(i.to)}::date + 1`);
  if (i.q) {
    const q = p(i.q);
    where.push(
      i.kind === 'users'
        ? `(x.name ILIKE '%' || ${q} || '%' OR x.email ILIKE '%' || ${q} || '%' OR x.phone ILIKE '%' || ${q} || '%')`
        : i.kind === 'products'
          ? `(x.name ILIKE '%' || ${q} || '%' OR x.sku ILIKE ${q} || '%')`
          : `(x.name ILIKE '%' || ${q} || '%' OR x.commune ILIKE '%' || ${q} || '%')`,
    );
  }
  const cols = i.kind === 'users' ? `x.email AS detail, x.roles, NULL::int AS wilaya_id` : i.kind === 'products' ? `x.sku AS detail, NULL::text[] AS roles, NULL::int AS wilaya_id` : `x.commune AS detail, NULL::text[] AS roles, x.wilaya_id`;
  const rows = await ctx.db.query(
    `SELECT * FROM (
       SELECT x.id, x.name, ${cols}, x.created_at, x.archived_at, x.active, ${LAST[i.kind]} AS last_at ${i.kind === 'warehouses' ? ', x.is_default' : ''}
       FROM ${TABLE[i.kind]} x WHERE ${where.join(' AND ')}
     ) t
     ORDER BY ${i.archived ? 'archived_at DESC' : 'COALESCE(last_at, created_at) ASC NULLS FIRST'}, id LIMIT 300`,
    params,
  );
  const ids = rows.map((r: any) => num(r.id));
  const uses = await usesOf(ctx.db, i.kind, ids);
  const stock = await stockOf(ctx.db, i.kind, ids);
  const parcels = i.kind === 'users' ? await withParcels(ctx.db, ids) : new Set<number>();
  const me = ctx.session.profile.id;
  return rows.map((r: any): ArchiveRow => {
    const id = num(r.id);
    const left = stock.get(id) ?? 0;
    let blocked: ArchiveBlock | null = null;
    if (!r.archived_at) {
      if (i.kind === 'users') blocked = id === me ? 'self' : parcels.has(id) ? 'parcels' : null;
      else if (i.kind === 'warehouses' && r.is_default) blocked = 'default';
      else if (left) blocked = 'stock';
    }
    return {
      id,
      name: r.name ?? '',
      detail: r.detail ?? '',
      roles: (r.roles as string[] | null) ?? [],
      wilayaId: r.wilaya_id === null || r.wilaya_id === undefined ? null : num(r.wilaya_id),
      createdAt: isoOrNull(r.created_at),
      lastAt: isoOrNull(r.last_at),
      archivedAt: isoOrNull(r.archived_at),
      active: !!r.active,
      uses: uses.get(id) ?? [],
      blocked,
      stock: left,
    };
  });
}

// ---------------------------------------------------------------- archive, restore, delete
export interface Skipped {
  id: number;
  name: string;
  reason: ArchiveBlock | 'used' | 'notArchived' | 'missing';
  uses?: UseKind[];
}

async function namesOf(db: Db, kind: ArchiveKind, ids: number[]) {
  const rows = await db.query(`SELECT id, name, archived_at FROM ${TABLE[kind]} WHERE id = ANY($1)`, [ids]);
  return new Map(rows.map((r: any) => [num(r.id), { name: (r.name as string) ?? '', archived: !!r.archived_at }]));
}

/** Archives (closes and hides) what can be: not oneself, no livreur with parcels or cash, no stock left, not the default depot. */
export async function archiveSet(ctx: Ctx, kind: ArchiveKind, ids: number[], archived: boolean): Promise<{ done: number; skipped: Skipped[] }> {
  const ids1 = [...new Set(ids)];
  const names = await namesOf(ctx.db, kind, ids1);
  const skipped: Skipped[] = ids1.filter((id) => !names.has(id)).map((id) => ({ id, name: '', reason: 'missing' as const }));
  let ok = ids1.filter((id) => names.has(id));
  if (archived) {
    ok = ok.filter((id) => !names.get(id)!.archived);
    const skip = (id: number, reason: Skipped['reason']) => skipped.push({ id, name: names.get(id)!.name, reason });
    if (kind === 'users') {
      const parcels = await withParcels(ctx.db, ok);
      ok = ok.filter((id) => (id === ctx.session.profile.id ? (skip(id, 'self'), false) : parcels.has(id) ? (skip(id, 'parcels'), false) : true));
    } else {
      const stock = await stockOf(ctx.db, kind, ok);
      const def = kind === 'warehouses' ? new Set((await ctx.db.query('SELECT id FROM warehouses WHERE is_default AND id = ANY($1)', [ok])).map((r: any) => num(r.id))) : new Set<number>();
      ok = ok.filter((id) => (def.has(id) ? (skip(id, 'default'), false) : stock.get(id) ? (skip(id, 'stock'), false) : true));
    }
    if (ok.length) {
      if (kind === 'users') await ctx.db.query('UPDATE profiles SET archived_at = now(), active = false, token_version = token_version + 1 WHERE id = ANY($1)', [ok]);
      else await ctx.db.query(`UPDATE ${TABLE[kind]} SET archived_at = now(), active = false WHERE id = ANY($1)`, [ok]);
    }
  } else {
    // back from the archives: still closed (opened again as usual, within the plan's accounts)
    ok = ok.filter((id) => names.get(id)!.archived);
    if (ok.length) await ctx.db.query(`UPDATE ${TABLE[kind]} SET archived_at = NULL WHERE id = ANY($1)`, [ok]);
  }
  if (ok.length) ctx.emit({ type: kind === 'users' ? 'settings' : 'stock' });
  return { done: ok.length, skipped };
}

/** Deletes for good what is archived and was never used; the rest stays in the archives. */
export async function archiveDelete(ctx: Ctx, kind: ArchiveKind, ids: number[]): Promise<{ deleted: number; kept: Skipped[] }> {
  const ids1 = [...new Set(ids)];
  const names = await namesOf(ctx.db, kind, ids1);
  const kept: Skipped[] = ids1.filter((id) => !names.has(id)).map((id) => ({ id, name: '', reason: 'missing' as const }));
  const archived = ids1.filter((id) => names.has(id) && (names.get(id)!.archived || (kept.push({ id, name: names.get(id)!.name, reason: 'notArchived' }), false)));
  const uses = await usesOf(ctx.db, kind, archived);
  const free = archived.filter((id) => {
    const u = uses.get(id) ?? [];
    if (u.length) kept.push({ id, name: names.get(id)!.name, reason: 'used', uses: u });
    return !u.length;
  });
  if (free.length)
    await ctx.db.tx(async (tx) => {
      if (kind === 'users') {
        await tx.query('DELETE FROM referrals WHERE referrer_id = ANY($1)', [free]);
        await tx.query('DELETE FROM profiles WHERE id = ANY($1) AND archived_at IS NOT NULL', [free]);
        // the teams (Paie, tableau de bord) forget them
        const teams = await getSetting(tx, 'teams');
        if (teams.some((t) => (t.managerId !== null && free.includes(t.managerId)) || t.agentIds.some((a) => free.includes(a))))
          await setSetting(
            tx,
            'teams',
            teams.map((t) => ({ ...t, managerId: t.managerId !== null && free.includes(t.managerId) ? null : t.managerId, agentIds: t.agentIds.filter((a) => !free.includes(a)) })),
            ctx.session.profile.id,
          );
      } else if (kind === 'products') {
        // other products that offered them as « produits liés » forget them
        await tx.query('UPDATE products SET linked = ARRAY(SELECT x FROM unnest(linked) AS x WHERE NOT (x = ANY($1::bigint[]))) WHERE linked && $1::bigint[]', [free]);
        await tx.query('DELETE FROM products WHERE id = ANY($1) AND archived_at IS NOT NULL', [free]);
      } else {
        await tx.query('DELETE FROM stock WHERE warehouse_id = ANY($1) AND qty = 0', [free]);
        await tx.query('DELETE FROM warehouses WHERE id = ANY($1) AND archived_at IS NOT NULL', [free]);
      }
    });
  if (free.length) ctx.emit({ type: kind === 'users' ? 'settings' : 'stock' });
  return { deleted: free.length, kept };
}

// ---------------------------------------------------------------- procedures (administrators)
export const archiveProcs = {
  'archive.list': proc([], ListInput, (ctx, i) => archiveList(ctx, i)),
  'archive.set': proc([], IdsInput.extend({ archived: z.boolean() }), (ctx, i) => archiveSet(ctx, i.kind, i.ids, i.archived)),
  'archive.delete': proc([], IdsInput, async (ctx, i) => {
    if (i.kind === 'users' && i.ids.includes(ctx.session.profile.id)) throw bad('Vous ne pouvez pas supprimer votre propre compte ici');
    return archiveDelete(ctx, i.kind, i.ids);
  }),
};
