// Confirmation › the customer who does not answer (the owner's rule, 24 Nov 2026).
// - « Messages client » (Management › Statuts): the shop's two texts, read and saved here (confirmation.messages.*).
//   setConf (orders.ts) asks the agent to send the first one at the try the shop chose (« Message au client à la
//   tentative », 3 at the start), and the cancel one, with the reactivation link, at « Annuler après N appels sans
//   réponse ».
// - orders.customerMessage: one order's text, as the agent sends it from his own WhatsApp or SMS (before a cancel, with
//   a one-time reactivation link: the customer opens it and the order comes back « Nouvelle »). Since 25 Nov 2026 a
//   short link on the shop's own domain (https://babyjoydz.net/r/<10 letters>, like its pages' links: Réglages ›
//   « Liens des pages »), whose page shows the product's main photo (WhatsApp shows it in its preview). The older long
//   links (/reorder/<order>/<64 hex>) keep working.
// - An order already at N unanswered tries or more and still waiting for a call (an order from before this rule, or N
//   lowered by the shop) is cancelled by itself, with no message and no link (cancelOverLimit): when the shop saves N,
//   and every 10 minutes (the job « noanswer-sweep »). It reads like the cancel of the Nth call: « Pas de réponse », an
//   attack in the statistics (attackOf), never the team's fault. Not touched: an order an agent has open right now
//   (the next round takes it), an order at the depot or gone, a SAV exchange.
import {
  CUSTOMER_MESSAGE_MAX, type CustomerMessageOrder, customerMessageValues, DEFAULT_CUSTOMER_MESSAGES, fillCustomerMessage, messageTry, REACTIVATION_VAR,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { Ctx, notFound, proc, publicApi } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { tellAgencyOrderStatus } from './agencybell';
import { mainProductPhoto } from './dellalphotos';
import { firstName } from './notify';
import { addEvent, getOrder, newReorderCode, reorderHash, reorderLinkOrder } from './orders';
import { pageLinks } from './pagelinks';

const id = z.number().int().positive();
/** A call nobody answered leaves the order « Pas de réponse » (or « Occupé », counted as a try before 24 Nov 2026). */
const UNANSWERED = ['no_answer', 'busy'];
/** written on every order cancelled here: the words attackOf (confirmation.ts) reads, then why there was no message */
export const OVER_LIMIT_NOTE = (attempts: number) => `Pas de réponse — Annulée automatiquement après ${attempts} appels sans réponse — ancienne commande, sans message`;

/** What one order's message says: the customer's first name, the shop, the products (their Arabic option when the
 *  product has it), the delivery and the total. */
export async function customerMessageOrder(db: Db, orderId: number): Promise<CustomerMessageOrder> {
  const o = (await db.query('SELECT ref, customer_name, delivery_fee, total FROM orders WHERE id = $1', [orderId]))[0];
  if (!o) throw notFound('Commande introuvable');
  const items = await db.query(
    `SELECT i.qty, i.name, i.variant_title, COALESCE(v.title_ar, '') AS title_ar
       FROM order_items i LEFT JOIN product_variants v ON v.id = i.variant_id WHERE i.order_id = $1 ORDER BY i.id`,
    [orderId],
  );
  return {
    name: firstName(o.customer_name, 'ar'),
    shop: (await getSetting(db, 'shop')).name,
    ref: String(o.ref),
    items: items.map((r: any) => ({ qty: num(r.qty), name: String(r.name).trim(), option: String(r.title_ar || r.variant_title || '').trim() || undefined })),
    delivery: num(o.delivery_fee),
    total: num(o.total),
  };
}

/** The orders at the shop's limit or above, still waiting for a call: cancelled, no message (see the top). */
export async function cancelOverLimit(ctx: Ctx): Promise<{ cancelled: number; refs: string[] }> {
  const limit = Math.round(Number((await getSetting(ctx.db, 'calls')).cancelAfterNoAnswer) || 0);
  if (limit <= 0) return { cancelled: 0, refs: [] };
  const done: { id: number; ref: string; agency: boolean }[] = [];
  await ctx.db.tx(async (tx) => {
    const rows = await tx.query(
      `SELECT id, ref, conf_status, attempts, next_call_at, conf_agency_id FROM orders
        WHERE conf_status = ANY($1) AND attempts >= $2 AND shipped_at IS NULL AND NOT is_exchange
          AND (follow_status IS NULL OR follow_status = 'cancelled') AND (locked_until IS NULL OR locked_until < now())
          -- (its last try is an « Occupé » on a « Nouvelle » order: never cancelled by itself — the owner's rule, 25 Nov 2026)
          AND COALESCE((SELECT e.data->>'busy' FROM order_events e WHERE e.order_id = orders.id AND e.kind = 'conf_status'
                         ORDER BY e.at DESC, e.id DESC LIMIT 1), '') <> 'true'
        ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [UNANSWERED, limit],
    );
    for (const r of rows) {
      const oid = num(r.id);
      await tx.query(
        `UPDATE orders SET conf_status = 'cancelled', next_call_at = NULL, locked_by = NULL, locked_until = NULL,
           updated_at = now(), version = version + 1 WHERE id = $1`,
        [oid],
      );
      await addEvent(tx, oid, null, 'conf_status', r.conf_status, 'cancelled', OVER_LIMIT_NOTE(num(r.attempts)), {
        att: num(r.attempts), nca: r.next_call_at ? iso(r.next_call_at) : null, overLimit: limit,
      });
      await tx.query(
        `UPDATE notifications SET status = 'skipped', error = 'Commande annulée : pas de réponse'
          WHERE order_id = $1 AND kind = 'no_answer' AND status IN ('queued', 'manual', 'failed')`,
        [oid],
      );
      done.push({ id: oid, ref: String(r.ref), agency: r.conf_agency_id != null });
    }
  });
  for (const d of done) if (d.agency) await tellAgencyOrderStatus(ctx, d.id, 'cancelled', null).catch(() => {});
  if (done.length) ctx.emit({ type: 'orders', orderIds: done.map((d) => d.id) });
  return { cancelled: done.length, refs: done.map((d) => d.ref) };
}

const Text = z.string().trim().min(1).max(CUSTOMER_MESSAGE_MAX);

/**
 * Where a short link lives: the shop's own domain while its page links use it (ready, still reaching the server, not
 * switched to Pilotix's address: pagelinks.ts), else the platform's address. null: no public address (the preview: the
 * agent's screen puts its own in front of `path`).
 */
export async function reorderUrl(ctx: Ctx, code: string): Promise<string | null> {
  const links = await pageLinks(ctx).catch(() => null);
  if (links?.usesOwn && links.ownPrefix) return `${links.ownPrefix}r/${code}`;
  const api = publicApi(ctx);
  return api ? `${api}/r/${code}` : null;
}

/** A new short link for this order's cancel message (one each time the message opens; one never sent goes in 2 days). */
async function newReorderLink(ctx: Ctx, orderId: number) {
  const code = newReorderCode();
  await ctx.db.query(`DELETE FROM reorder_links WHERE sent_at IS NULL AND created_at < now() - interval '2 days'`);
  await ctx.db.query('INSERT INTO reorder_links (hash, order_id) VALUES ($1, $2)', [await reorderHash(code), orderId]);
  return { code, path: `/api${ctx.shop?.slug ? `/s/${ctx.shop.slug}` : ''}/r/${code}`, url: await reorderUrl(ctx, code) };
}

/** The JPEG copy WhatsApp's preview reads: 800 px at most (light: WhatsApp shows no picture above 300 KB on some phones). */
export const REORDER_PHOTO_SIDE = 800;

/**
 * A short link's page (the server's, public): its order's first product, by name, and its main photo (never its
 * colour's: dellalphotos.ts › mainProductPhoto) as a public JPEG copy. Never the customer, the order or a price. Read
 * when WhatsApp makes its preview, before the order is cancelled: the link only has to exist.
 */
export async function reorderPage(ctx: Ctx, code: string): Promise<{ found: boolean; photo: string | null; product: string | null }> {
  const orderId = await reorderLinkOrder(ctx.db, code);
  if (!orderId) return { found: false, photo: null, product: null };
  const item = (
    await ctx.db.query(
      `SELECT i.product_id, i.name FROM order_items i LEFT JOIN products p ON p.id = i.product_id
        WHERE i.order_id = $1 ORDER BY coalesce(p.is_service, false), i.id LIMIT 1`,
      [orderId],
    )
  )[0];
  if (!item) return { found: true, photo: null, product: null };
  const product = String(item.name ?? '').trim() || null;
  const src = await mainProductPhoto(ctx.db, num(item.product_id)).catch(() => null);
  if (!src || !ctx.server?.dellal || !publicApi(ctx)) return { found: true, photo: null, product };
  // a photo that cannot be made: the page without it (the button still works)
  const r: any = await ctx.server.dellal('photoLinks', { photos: [src], side: REORDER_PHOTO_SIDE }, ctx).catch(() => null);
  const photo = Array.isArray(r?.urls) && typeof r.urls[0] === 'string' ? r.urls[0] : null;
  return { found: true, photo, product };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** only our own photos' addresses go in the page (https, nothing that leaves the attribute) */
const safeUrl = (u: unknown) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{8,1900}$/i.test(u) ? u : null);

/**
 * The reactivation link's page (short and long links alike). `message`: an answer (restored, a link that no longer
 * works) in place of the button. `photo`: the product's main photo, above the title, and WhatsApp's preview picture
 * (og:image). Plain HTML: nothing runs; the button posts to the same address.
 */
export function reorderPageHtml(p: { message?: string | null; photo?: string | null; product?: string | null } = {}): string {
  const photo = safeUrl(p.photo);
  const product = String(p.product ?? '').trim();
  const og = photo
    ? `<meta property="og:type" content="website"><meta property="og:title" content="إعادة تفعيل طلبي"><meta property="og:image" content="${esc(photo)}"><meta property="og:image:secure_url" content="${esc(photo)}"><meta property="og:image:type" content="image/jpeg">${product ? `<meta property="og:image:alt" content="${esc(product)}">` : ''}<meta name="twitter:card" content="summary_large_image">`
    : '';
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow">
      <title>إعادة تفعيل طلبي</title>${og}<style>body{font:1rem/1.65 system-ui;color:#172340;background:#f4f2ef;margin:0;padding:24px}main{max-width:420px;margin:${photo ? 'clamp(0px,5vh,48px)' : '72px'} auto;background:white;border-radius:16px;padding:26px}img{display:block;width:100%;height:auto;max-height:min(420px,46vh);object-fit:contain;border-radius:12px;margin:0 0 6px;background:#f4f2ef}button{background:#ff9b12;color:#172340;border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:700}</style>
      <main>${photo ? `<img src="${esc(photo)}" alt="${esc(product)}">` : ''}<h1>إعادة تفعيل طلبي</h1>${p.message ? `<p>${esc(p.message)}</p>` :
        '<p>تم إلغاء طلبك. يمكنك إعادة تفعيله وسنتواصل معك لتأكيده.</p><form method="post" enctype="text/plain"><button type="submit">إعادة تفعيل طلبي</button></form>'}</main></html>`;
}

export const noAnswerProcs = {
  /** Management › Statuts › « Messages client »: the two texts, the tries they go at and the shop's name (the preview). */
  'confirmation.messages.get': proc([], z.object({}), async (ctx) => {
    const [texts, calls, shop] = await Promise.all([getSetting(ctx.db, 'customerMessages'), getSetting(ctx.db, 'calls'), getSetting(ctx.db, 'shop')]);
    return {
      attempt: texts.attempt || DEFAULT_CUSTOMER_MESSAGES.attempt,
      cancel: texts.cancel || DEFAULT_CUSTOMER_MESSAGES.cancel,
      defaults: DEFAULT_CUSTOMER_MESSAGES,
      messageAtTry: messageTry(calls),
      cancelAfterNoAnswer: calls.cancelAfterNoAnswer,
      shopName: shop.name,
    };
  }),
  'confirmation.messages.save': proc([], z.object({ attempt: Text, cancel: Text }), async (ctx, i) => {
    await setSetting(ctx.db, 'customerMessages', { attempt: i.attempt, cancel: i.cancel }, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),
  /**
   * One order's message as the agent sends it; before a cancel, with a new one-time reactivation link: `url` the short
   * link (the shop's own domain, else the platform's address; null in the preview), `path` the same on the platform's
   * address (an older screen puts the site's address in front of it).
   */
  'orders.customerMessage': proc(['confirmation'], z.object({ id, kind: z.enum(['attempt', 'cancel']), draft: z.string().uuid().optional() }), async (ctx, i) => {
    await getOrder(ctx, i.id);
    const [texts, order] = await Promise.all([getSetting(ctx.db, 'customerMessages'), customerMessageOrder(ctx.db, i.id)]);
    const values = customerMessageValues(order);
    // (the first message has no link: a {رابط_إعادة_التفعيل} written there is left out)
    const text = fillCustomerMessage(texts[i.kind] || DEFAULT_CUSTOMER_MESSAGES[i.kind], i.kind === 'attempt' ? { ...values, [REACTIVATION_VAR]: '' } : values);
    if (i.kind === 'attempt') return { text, token: null, path: null, url: null };
    const link = await newReorderLink(ctx, i.id);
    return { text, token: link.code, path: link.path, url: link.url };
  }),
  /** The short link's page, for its public address (apps/server): read by the server only (admin = the system). */
  'orders.reorderPage': proc([], z.object({ code: z.string().max(20) }), (ctx, i) => reorderPage(ctx, i.code)),
  /** The job « noanswer-sweep » (every 10 minutes): the orders over the shop's limit, cancelled with no message. */
  'confirmation.noAnswerSweep': proc([], z.object({}), (ctx) => cancelOverLimit(ctx)),
};

