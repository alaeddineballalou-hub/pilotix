// Landing pages, the parts other modules call (orders.ts for the menu counts and the Meta Purchase of a confirmed or
// delivered order, catalog.ts for the page made with a new product). Imports no other module of ./modules: no cycle.
import { CONF_DONE_BAD, LANDING_DEFAULT_COLOR, landingSlug } from '@pilotix/shared';
import { Db, num } from '../db';
import { bad, notFound } from '../rpc';
import { getSetting, SettingsMap } from '../settings';
import { pixelsOf } from './pixels';

export type LandingSettings = SettingsMap['landing'];
export const landingSettings = (db: Db): Promise<LandingSettings> => getSetting(db, 'landing');

/** A lead is abandoned when nothing moved on its form for this long and the number did not order since. */
/** first parts of an address that belong to the app or its server: never a store's name */
export const STORE_RESERVED = ['api', 'live', 'assets', 'lp', 's', 'app', 'admin', 'www', 'static', 'img'];
/** The store's part of the pages' public address (site/<store>/<page>): the one chosen in Réglages, else the shop's name. */
export async function landingStore(db: Db, s?: LandingSettings): Promise<string> {
  const chosen = String((s ?? (await landingSettings(db))).storeSlug ?? '').trim();
  if (chosen) return chosen;
  const made = landingSlug(String((await getSetting(db, 'shop')).name ?? '')).slice(0, 40).replace(/-+$/, '');
  return made === 'produit' || made.length < 2 || STORE_RESERVED.includes(made) ? 'boutique' : made;
}

export const abandonCutoff = (s: Pick<LandingSettings, 'abandonAfterMin'>, now: number) => new Date(now - Math.max(5, num(s.abandonAfterMin) || 20) * 60_000).toISOString();

/** SQL: lead `a` is an abandoned order now ($cut = abandonCutoff): no order of this number for this product around it. */
export const ABANDONED = (cut: string) =>
  `(a.status = 'abandoned' OR (a.status = 'open' AND a.last_at < ${cut}))
   AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.phone = a.phone AND oi.product_id = a.product_id AND o.created_at >= a.at - interval '24 hours')`;

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
        `SELECT o.id, o.ref, o.total, o.landing_id, o.conf_status, o.is_exchange, l.pixel_id, l.meta_pixels, l.tiktok_pixels
         FROM orders o LEFT JOIN landing_pages l ON l.id = o.landing_id WHERE o.id = $1`,
        [orderId],
      )
    )[0];
    if (!o || !o.landing_id || o.is_exchange || (CONF_DONE_BAD as string[]).includes(o.conf_status)) return;
    // the page's Meta pixel and TikTok pixel (TikTok's « CompletePayment »)
    const px = await pixelsOf(db, o, s.pixelId);
    const at = new Date(now).toISOString();
    for (const [platform, pixel] of [...px.meta.map((x) => ['meta', x] as const), ...px.tiktok.map((x) => ['tiktok', x] as const)])
      if (pixel)
        await db.query(
          `INSERT INTO meta_events (pixel_id, event_name, event_id, order_id, landing_id, value, at, send_after, platform) VALUES ($1,'Purchase',$2,$3,$4,$5,$6,$6,$7)
           ON CONFLICT (pixel_id, event_name, event_id) DO NOTHING`,
          [pixel, `purchase-${o.ref}`, o.id, o.landing_id, num(o.total), at, platform],
        );
  });
}

const CONFIRMED = ['confirmed', 'no_stock'];
const DELIVERED = ['delivered', 'exchanged'];

/** the agent's reason says « concurrent » (the 🕵️ chip, or typed in French, English or Arabic) */
export const isCompetitorReason = (reason: string | null | undefined) => /🕵|concurren|competitor|منافس/i.test(String(reason ?? ''));

/**
 * An agent found a landing-page order fake: the device that sent it is marked (its next orders are put to review, the
 * second time in 30 days or once « concurrent » they are blocked). The phone number is noted too, but not punished:
 * it may belong to someone who never ordered (a fake order with a stranger's number).
 */
async function markFake(db: Db, orderId: number, reason: string | null, userId: number | null) {
  await guarded(db, async (db) => {
    const src = (
      await db.query(
        `SELECT o.phone, COALESCE((SELECT fp FROM landing_submits WHERE order_id = o.id ORDER BY id DESC LIMIT 1), (SELECT device FROM landing_leads WHERE order_id = o.id ORDER BY id DESC LIMIT 1)) AS device
         FROM orders o WHERE o.id = $1`,
        [orderId],
      )
    )[0];
    if (!src?.device) return;
    if ((await db.query(`SELECT 1 FROM fraud_marks WHERE order_id = $1 AND NOT lifted LIMIT 1`, [orderId])).length) return;
    await db.query(`INSERT INTO fraud_marks (kind, value, reason, device, phone, order_id, by_user) VALUES ('device', $1, $2, $1, $3, $4, $5)`, [
      src.device,
      isCompetitorReason(reason) ? 'competitor' : 'fake',
      src.phone ?? null,
      orderId,
      userId,
    ]);
  });
}

/** An agent said it was not fake after all (the order is back to a normal status): its mark is lifted. */
async function liftMark(db: Db, orderId: number) {
  await db.query(`UPDATE fraud_marks SET lifted = true WHERE order_id = $1 AND NOT lifted`, [orderId]);
}

/** « Purchase at order »: the sale was already reported; a « Confirmed » event (for the reports) says a person confirmed it. */
async function queueConfirmed(db: Db, s: LandingSettings, orderId: number, now: number) {
  await guarded(db, async (db) => {
    const o = (await db.query(`SELECT o.id, o.ref, o.total, o.landing_id, l.pixel_id, l.meta_pixels, l.tiktok_pixels FROM orders o LEFT JOIN landing_pages l ON l.id = o.landing_id WHERE o.id = $1`, [orderId]))[0];
    // Meta only (TikTok has no such event)
    const pixels = o ? (await pixelsOf(db, o, s.pixelId)).meta : [];
    if (!o?.landing_id) return;
    const at = new Date(now).toISOString();
    for (const pixel of pixels)
      await db.query(
        `INSERT INTO meta_events (pixel_id, event_name, event_id, order_id, landing_id, value, at, send_after) VALUES ($1,'Confirmed',$2,$3,$4,$5,$6,$6)
         ON CONFLICT (pixel_id, event_name, event_id) DO NOTHING`,
        [pixel, `confirmed-${o.ref}`, o.id, o.landing_id, num(o.total), at],
      );
  });
}

/** setConf: an agent confirmed an order from a landing page (Purchase « at confirmation », the default, or « at order »). */
export async function onLandingConf(
  db: Db,
  s: LandingSettings,
  row: { id: number; landing_id?: unknown; is_exchange?: boolean },
  from: string | null,
  to: string,
  now: number,
  reason: string | null = null,
  userId: number | null = null,
) {
  if (!row.landing_id || row.is_exchange) return;
  if (to === 'fake' && from !== 'fake') await markFake(db, num(row.id), reason, userId);
  else if (from === 'fake' && to !== 'fake') await liftMark(db, num(row.id));
  // « at order »: clear orders were reported when received; borderline and abandoned ones count once confirmed
  // (queuePurchase is once per order). « At delivery »: not yet.
  if (s.purchaseAt === 'delivered') return;
  if (CONFIRMED.includes(to) && !CONFIRMED.includes(String(from))) {
    await queuePurchase(db, s, num(row.id), now);
    if (s.purchaseAt === 'order') await queueConfirmed(db, s, num(row.id), now);
  }
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
    if ((!r || num(r.id) === selfId) && !(await db.query('SELECT 1 FROM landing_groups WHERE slug = $1', [s])).length) return s;
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
