// Landing pages, the parts other modules call (orders.ts for the menu counts and the Meta Purchase of a confirmed or
// delivered order, catalog.ts for the page made with a new product). Imports no other module of ./modules: no cycle.
import { CONF_DONE_BAD, LANDING_DEFAULT_COLOR, landingSlug } from '@pilotix/shared';
import { Db, num } from '../db';
import { bad, notFound } from '../rpc';
import { getSetting, SettingsMap } from '../settings';

export type LandingSettings = SettingsMap['landing'];
export const landingSettings = (db: Db): Promise<LandingSettings> => getSetting(db, 'landing');

/** A lead is abandoned when nothing moved on its form for this long and the number did not order since. */
export const abandonCutoff = (s: Pick<LandingSettings, 'abandonAfterMin'>, now: number) => new Date(now - Math.max(5, num(s.abandonAfterMin) || 20) * 60_000).toISOString();

/** SQL: lead `a` is an abandoned order now ($cut = abandonCutoff). */
export const ABANDONED = (cut: string) =>
  `(a.status = 'abandoned' OR (a.status = 'open' AND a.last_at < ${cut})) AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.phone = a.phone AND o.created_at >= a.at)`;

/** The menu's landing numbers: blocked orders and abandoned orders to handle, active products without a page. */
export async function landingCounts(db: Db, now: number): Promise<{ blocked: number; abandoned: number; noPage: number }> {
  const s = await landingSettings(db);
  const r = (
    await db.query(
      `SELECT (SELECT count(*)::int FROM landing_blocked WHERE status = 'blocked') AS blocked,
              (SELECT count(*)::int FROM landing_leads a WHERE ${ABANDONED('$1::timestamptz')}) AS abandoned,
              (SELECT count(*)::int FROM products p WHERE p.active AND NOT p.is_service AND NOT (p.id = ANY($2::bigint[]))
                 AND NOT EXISTS (SELECT 1 FROM landing_pages l WHERE l.product_id = p.id)) AS no_page`,
      [abandonCutoff(s, now), s.ignored ?? []],
    )
  )[0];
  return { blocked: num(r?.blocked), abandoned: num(r?.abandoned), noPage: num(r?.no_page) };
}

/**
 * Inside the caller's transaction (or a transaction of its own when there is none, e.g. a landing submit): a problem
 * here never undoes the order's own change.
 */
async function guarded(db: Db, fn: (db: Db) => Promise<unknown>) {
  await db.tx(async (tx) => {
    await tx.query('SAVEPOINT px_landing');
    try {
      await fn(tx);
      await tx.query('RELEASE SAVEPOINT px_landing');
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT px_landing');
      await tx.query('RELEASE SAVEPOINT px_landing');
    }
  });
}

/**
 * Queues the Meta « Purchase » of an order that came from a landing page (sent by the server's job through the
 * Conversions API). Never for an exchange or an order already marked fake / duplicate / wrong number / cancelled; once
 * per order (its event id is the order's reference, the same Meta would see from any other source).
 */
export async function queuePurchase(db: Db, s: LandingSettings, orderId: number, now: number): Promise<void> {
  await guarded(db, async (db) => {
    const o = (
      await db.query(
        `SELECT o.id, o.ref, o.total, o.landing_id, o.conf_status, o.is_exchange, l.pixel_id
         FROM orders o LEFT JOIN landing_pages l ON l.id = o.landing_id WHERE o.id = $1`,
        [orderId],
      )
    )[0];
    if (!o || !o.landing_id || o.is_exchange || (CONF_DONE_BAD as string[]).includes(o.conf_status)) return;
    const pixel = String(o.pixel_id || s.pixelId || '').trim();
    if (!pixel) return;
    const at = new Date(now).toISOString();
    await db.query(
      `INSERT INTO meta_events (pixel_id, event_name, event_id, order_id, landing_id, value, at, send_after) VALUES ($1,'Purchase',$2,$3,$4,$5,$6,$6)
       ON CONFLICT (pixel_id, event_name, event_id) DO NOTHING`,
      [pixel, `purchase-${o.ref}`, o.id, o.landing_id, num(o.total), at],
    );
  });
}

const CONFIRMED = ['confirmed', 'no_stock'];
const DELIVERED = ['delivered', 'exchanged'];

/** setConf: an agent confirmed an order from a landing page (Purchase « at confirmation », the default). */
export async function onLandingConf(db: Db, s: LandingSettings, row: { id: number; landing_id?: unknown; is_exchange?: boolean }, from: string | null, to: string, now: number) {
  if (!row.landing_id || row.is_exchange || s.purchaseAt !== 'confirmed') return;
  if (CONFIRMED.includes(to) && !CONFIRMED.includes(String(from))) await queuePurchase(db, s, num(row.id), now);
}

/** setFollow: an order from a landing page was delivered (Purchase « at delivery »). */
export async function onLandingFollow(db: Db, s: LandingSettings, row: { id: number; landing_id?: unknown; is_exchange?: boolean }, from: string | null, to: string, now: number) {
  if (!row.landing_id || row.is_exchange || s.purchaseAt !== 'delivered') return;
  if (DELIVERED.includes(to) && !DELIVERED.includes(String(from))) await queuePurchase(db, s, num(row.id), now);
}

/** A free page address from a name (or the SKU when the name has no Latin letters, e.g. an Arabic name). */
export async function freeLandingSlug(db: Db, name: string, sku = '', selfId?: number): Promise<string> {
  let base = landingSlug(name);
  if (base === 'produit' && sku) base = landingSlug(sku);
  for (let k = 0; k < 100; k++) {
    const s = k ? `${base}-${k + 1}` : base;
    const r = (await db.query('SELECT id FROM landing_pages WHERE slug = $1', [s]))[0];
    if (!r || num(r.id) === selfId) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Quantity offers as the page's first lines (« 2 قطع بـ 18000 دج »). */
const packLines = (packs: unknown): string => {
  const a = (typeof packs === 'string' ? JSON.parse(packs) : packs) as { qty: number; price: number }[] | null;
  if (!Array.isArray(a) || !a.length) return '';
  return ['# عروض خاصة', ...a.map((p) => `- ${num(p.qty)} قطع بـ **${num(p.price)} دج** فقط`)].join('\n');
};

/**
 * One click: a page for a product, from what Pilotix knows of it (name, photo, quantity offers; variants, price and
 * delivery prices are read live). Returns the product's existing page instead when it has one.
 */
export async function quickCreatePage(db: Db, productId: number, userId: number | null): Promise<{ id: number; created: boolean }> {
  const had = (await db.query('SELECT id FROM landing_pages WHERE product_id = $1 ORDER BY id LIMIT 1', [productId]))[0];
  if (had) return { id: num(had.id), created: false };
  const p = (await db.query('SELECT name, sku, photo, packs, is_service FROM products WHERE id = $1', [productId]))[0];
  if (!p) throw notFound('Produit introuvable');
  if (p.is_service) throw bad('Un service n’a pas de landing page');
  const slug = await freeLandingSlug(db, String(p.name), String(p.sku ?? ''));
  const images = p.photo && /^(https?:|data:image\/)/.test(String(p.photo)) ? [{ url: String(p.photo), w: 960, h: 960 }] : [];
  const r = (
    await db.query(
      `INSERT INTO landing_pages (product_id, slug, title, color, description, images, created_by) VALUES ($1,$2,'',$3,$4,$5,$6) RETURNING id`,
      [productId, slug, LANDING_DEFAULT_COLOR, packLines(p.packs), JSON.stringify(images), userId],
    )
  )[0];
  return { id: num(r.id), created: true };
}
