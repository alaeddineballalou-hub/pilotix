// Landing pages: one public page per product, made in Pilotix (Landing pages), and everything that hangs on it:
// - the silent fake-order check of what the pages receive: a blocked customer sees the same thank-you screen as
//   everyone; the order waits in « Commandes bloquées » with its score and reasons, and can be restored in one click;
// - the other orders go straight to Commandes as « Nouvelle » (channel « Landing page », with the ad's UTM / ad set);
// - abandoned orders: what a customer typed (a valid phone first) is kept; with no order after a while it goes to
//   Commandes as « Nouvelle » by itself (the agents call; no message is sent to the customer), and is counted in
//   « Abandonnées » (an incomplete one, without wilaya, waits there for a person);
// - Meta: the page's pixel (PageView, ViewContent, InitiateCheckout in the browser) and the Conversions API from the
//   server: InitiateCheckout for an abandoned order, Purchase only for a real order (received, confirmed or delivered,
//   as chosen), never for a blocked one;
// - the products still without a page (menu badge, one-click page, automatic page for each new product).
import {
  CONF_DONE_BAD,
  communesOf,
  hmacSha256Hex,
  isHexColor,
  LANDING_DEFAULT_COLOR,
  LandingImage,
  LandingRender,
  LandingView,
  normalizePhone,
  renderLanding,
  sha256Hex,
  WILAYAS,
  zeroBits,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { clientFee, getSetting, setSetting } from '../settings';
import { BOT_UA, FraudLevel, FraudReason, scoreOrder } from './fraud';
import { ABANDONED, abandonCutoff, freeLandingSlug, landingCounts, landingSettings, LandingSettings, queuePurchase, quickCreatePage } from './landingquery';
import { sendInPreview } from './notify';
import { createOrder } from './orders';
import { RESERVED } from './stockquery';

const id = z.number().int().positive();
const WHO = ['marketer'] as const;
const WATCH = ['marketer', 'confirmation'] as const;
/** proof-of-work difficulty: ~8 000 hashes on average, well under a second on a cheap phone */
export const LANDING_POW_BITS = 13;
/** a page older than this is reloaded before ordering, in practice: its challenge then counts as missing */
const CHALLENGE_TTL = 6 * 3600_000;
/** the Conversions API token (Events Manager › the pixel › Settings); the ads token is used when it is empty */
export const LANDING_CAPI_SECRET = 'secret_landing_capi_token';
/** the browser preview and the tests have no server: Meta events are only simulated */
const simulated = (ctx: Ctx) => !ctx.server;

export interface LandingRow {
  id: number;
  productId: number;
  productName: string;
  slug: string;
  active: boolean;
  title: string;
  color: string;
  price: number | null;
  oldPrice: number | null;
  description: string;
  variantLabel: string;
  fraudLevel: FraudLevel;
  pixelId: string;
  stockMode: 'off' | 'hide';
  views: number;
  orders: number;
  blocked: number;
  abandoned: number;
  thumb: string | null;
  updatedAt: string;
}

/** a picture as the editor sees it: stored ones come back as data URLs */
export interface LandingImageRow {
  id: number | null;
  url: string | null;
  w: number;
  h: number;
  thumb: string;
  src: string;
}

type ImgRef = { id: number } | { url: string; w: number; h: number };

const readImgs = (v: unknown): ImgRef[] => {
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(a) ? a.filter((x) => x && (x.id || x.url)) : [];
};
const readJson = <T>(v: unknown): T | null => (typeof v === 'string' ? (JSON.parse(v) as T) : ((v as T) ?? null));
const b64 = (s: string) => `data:image/webp;base64,${s}`;
const isoAt = (ms: number) => new Date(ms).toISOString();

async function imageRows(db: Db, refs: ImgRef[], full: boolean): Promise<Map<number, any>> {
  const ids = refs.filter((r): r is { id: number } => 'id' in r).map((r) => r.id);
  if (!ids.length) return new Map();
  const rows = await db.query(`SELECT id, w, h ${full ? ', t160, w480, w960' : ''} FROM landing_images WHERE id = ANY($1)`, [ids]);
  return new Map(rows.map((r: any) => [num(r.id), r]));
}

async function listPages(db: Db, now: number, ids?: number[]): Promise<LandingRow[]> {
  const s = await landingSettings(db);
  const rows = await db.query(
    `SELECT l.*, p.name AS product_name,
       (SELECT count(*)::int FROM orders o WHERE o.landing_id = l.id) AS n_orders,
       (SELECT count(*)::int FROM landing_blocked b WHERE b.landing_id = l.id) AS n_blocked,
       (SELECT count(*)::int FROM landing_leads a WHERE a.landing_id = l.id AND ${ABANDONED('$1::timestamptz')}) AS n_abandoned
     FROM landing_pages l JOIN products p ON p.id = l.product_id ${ids ? 'WHERE l.id = ANY($2)' : ''} ORDER BY l.updated_at DESC`,
    ids ? [abandonCutoff(s, now), ids] : [abandonCutoff(s, now)],
  );
  const firsts = rows.map((r: any) => readImgs(r.images)[0]).filter(Boolean) as ImgRef[];
  const thumbs = await db.query(`SELECT id, t160 FROM landing_images WHERE id = ANY($1)`, [firsts.filter((x): x is { id: number } => 'id' in x).map((x) => x.id)]);
  const T = new Map(thumbs.map((t: any) => [num(t.id), t.t160]));
  return rows.map((r: any) => {
    const f = readImgs(r.images)[0];
    return {
      id: num(r.id),
      productId: num(r.product_id),
      productName: r.product_name,
      slug: r.slug,
      active: !!r.active,
      title: r.title,
      color: r.color,
      price: numOrNull(r.price),
      oldPrice: numOrNull(r.old_price),
      description: r.description,
      variantLabel: r.variant_label,
      fraudLevel: r.fraud_level,
      pixelId: r.pixel_id ?? '',
      stockMode: r.stock_mode === 'hide' ? 'hide' : 'off',
      views: num(r.views),
      orders: num(r.n_orders),
      blocked: num(r.n_blocked),
      abandoned: num(r.n_abandoned),
      thumb: !f ? null : 'url' in f ? f.url : T.has(f.id) ? b64(T.get(f.id)) : null,
      updatedAt: iso(r.updated_at),
    };
  });
}

/**
 * What a page needs from its product: price, variants (their own price, what is left in the depots), delivery prices,
 * shop name. Left = stock − what confirmed orders already promised (the same count as Produits › Stock).
 */
async function productContext(db: Db, productId: number) {
  const p = (await db.query('SELECT id, name, price, active, fee_grid, is_service, fixed_price FROM products WHERE id = $1', [productId]))[0];
  if (!p) throw notFound('Produit introuvable');
  const vars = await db.query(
    `WITH r AS (${RESERVED}),
       s AS (SELECT s.variant_id, sum(s.qty)::int AS qty FROM stock s JOIN warehouses wh ON wh.id = s.warehouse_id AND wh.active GROUP BY 1),
       rv AS (SELECT r.variant_id, sum(r.n)::int AS n FROM r JOIN warehouses wh ON wh.id = r.wid AND wh.active GROUP BY 1)
     SELECT v.id, v.title, v.active, v.price, COALESCE(s.qty, 0) - COALESCE(rv.n, 0) AS available
     FROM product_variants v LEFT JOIN s ON s.variant_id = v.id LEFT JOIN rv ON rv.variant_id = v.id
     WHERE v.product_id = $1 ORDER BY v.id`,
    [productId],
  );
  const service = !!p.is_service;
  const variants = vars
    .filter((v: any) => v.active && v.title !== '')
    .map((v: any) => ({ id: num(v.id), title: String(v.title), price: numOrNull(v.price), available: service ? null : num(v.available) }));
  const plain = vars.find((v: any) => v.title === '');
  const fees: Record<number, number> = {};
  for (let w = 1; w <= 69; w++) {
    const f = await clientFee(db, w, false, p.fee_grid);
    if (f !== null) fees[w] = f;
  }
  const shop = await getSetting(db, 'shop');
  const plainAvailable = service ? null : plain ? num(plain.available) : 0;
  const soldOut = !service && (variants.length ? variants.every((v) => (v.available ?? 1) <= 0) : (plainAvailable ?? 1) <= 0);
  return {
    name: String(p.name),
    price: num(p.price),
    active: !!p.active,
    fixedPrice: !!p.fixed_price,
    variants,
    plainVariantId: plain ? num(plain.id) : null,
    soldOut,
    fees,
    shopName: shop.name,
  };
}
type ProductCtx = Awaited<ReturnType<typeof productContext>>;

/** The price of one piece: the page's own price (a promotion) first, then the variant's, then the product's. */
const unitPriceOf = (pagePrice: number | null, pc: ProductCtx, variantId: number | null) => pagePrice ?? pc.variants.find((v) => v.id === variantId)?.price ?? pc.price;

/** The variants as the page shows them: their price when it is not the page's, sold out ones marked (when asked). */
function viewVariants(l: any, pc: ProductCtx, hide: boolean): LandingView['variants'] {
  const page = numOrNull(l.price);
  const shown = page ?? pc.price;
  return pc.variants.map((v) => {
    const price = unitPriceOf(page, pc, v.id);
    return { id: v.id, title: v.title, ...(price !== shown ? { price } : {}), ...(hide && v.available !== null && v.available <= 0 ? { out: true } : {}) };
  });
}

// ---------------------------------------------------------------- challenge (signed; proves the page was served, and when)
async function secret(db: Db): Promise<string> {
  const r = (await db.query(`SELECT value FROM settings WHERE key = 'landing_secret'`))[0];
  if (r) return String(r.value);
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await db.query(`INSERT INTO settings (key, value) VALUES ('landing_secret', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(s)]);
  return secret(db);
}

export async function makeChallenge(db: Db, slug: string, now: number): Promise<string> {
  const rand = Math.random().toString(36).slice(2, 10);
  const body = `${now.toString(36)}.${rand}`;
  return `${body}.${hmacSha256Hex(await secret(db), `${body}.${slug}`).slice(0, 32)}`;
}

/** ms since the page was served, or null when the challenge is missing, forged, from another page or too old */
export async function checkChallenge(db: Db, ch: string, slug: string, now: number): Promise<number | null> {
  const m = ch.match(/^([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{32})$/);
  if (!m) return null;
  if (hmacSha256Hex(await secret(db), `${m[1]}.${m[2]}.${slug}`).slice(0, 32) !== m[3]) return null;
  const age = now - parseInt(m[1], 36);
  return age < -60_000 || age > CHALLENGE_TTL ? null : Math.max(0, age);
}

// ---------------------------------------------------------------- the public page
export interface HtmlOpts {
  mode: LandingRender['mode'];
  /** where the page sends the order, the abandoned-order data, and reads communes (live mode) */
  post: string;
  geo: string;
  lead?: string;
  /** base address of stored pictures ("…/api/lp/img/"); null = data URLs inside the page (Pilotix preview) */
  imgBase: string | null;
}

function viewImages(refs: ImgRef[], rows: Map<number, any>, imgBase: string | null): LandingImage[] {
  const out: LandingImage[] = [];
  for (const r of refs) {
    if ('url' in r) out.push({ src: r.url, srcset: `${r.url} ${r.w || 960}w`, thumb: r.url, w: r.w || 960, h: r.h || 960 });
    else {
      const x = rows.get(r.id);
      if (!x) continue;
      if (imgBase) out.push({ src: `${imgBase}${r.id}/480.webp`, srcset: `${imgBase}${r.id}/480.webp 480w, ${imgBase}${r.id}/960.webp 960w`, thumb: `${imgBase}${r.id}/160.webp`, w: num(x.w), h: num(x.h) });
      else out.push({ src: b64(x.w480), srcset: `${b64(x.w480)} 480w`, thumb: b64(x.t160), w: num(x.w), h: num(x.h) });
    }
  }
  return out;
}

const randomId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);

export async function landingHtml(ctx: Ctx, slug: string, o: HtmlOpts): Promise<string> {
  const l = (await ctx.db.query('SELECT * FROM landing_pages WHERE slug = $1', [slug]))[0];
  if (!l || (!l.active && o.mode === 'live')) throw notFound('Page introuvable');
  const pc = await productContext(ctx.db, num(l.product_id));
  if (!pc.active && o.mode === 'live') throw notFound('Page introuvable');
  const refs = readImgs(l.images);
  const hide = l.stock_mode === 'hide';
  const s = await landingSettings(ctx.db);
  const view: LandingView = {
    slug,
    title: l.title || pc.name,
    color: l.color,
    price: numOrNull(l.price) ?? pc.price,
    oldPrice: numOrNull(l.old_price),
    description: l.description,
    variantLabel: l.variant_label || 'اللون',
    variants: viewVariants(l, pc, hide),
    soldOut: hide && pc.soldOut,
    images: viewImages(refs, await imageRows(ctx.db, refs, !o.imgBase), o.imgBase),
    fees: pc.fees,
    shopName: pc.shopName,
    // the pixel only on the real page: never in Pilotix (preview, demo), whose visits are not customers
    pixelId: o.mode === 'live' ? String(l.pixel_id || s.pixelId || '').trim() : '',
    productId: num(l.product_id),
  };
  if (o.mode === 'live') await ctx.db.query('UPDATE landing_pages SET views = views + 1 WHERE id = $1', [l.id]);
  return renderLanding(view, {
    mode: o.mode,
    post: o.post,
    geo: o.geo,
    lead: o.lead ?? '',
    viewId: randomId(),
    challenge: await makeChallenge(ctx.db, slug, ctx.now()),
    bits: LANDING_POW_BITS,
  });
}

/** communes of a wilaya for the page: [French name (kept on the order), Arabic name] */
export const landingCommunes = (wilayaId: number): [string, string][] => communesOf(wilayaId).map((c) => [c[1], c[2]]);

// ---------------------------------------------------------------- what a page sends
const str = (n: number) => z.any().transform((v) => (v === null || v === undefined || typeof v === 'object' ? '' : String(v)).slice(0, n));
const int = (d: number | null) => z.any().transform((v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? d : Math.trunc(Number(v))));
/** the ad link's parameters (utm_*, fbclid, ad / ad set / campaign ids): 12 keys at most, short strings only */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'ttclid', 'gclid', 'ad_id', 'adset_id', 'campaign_id', 'placement'];
const utmOf = z.any().transform((v): Record<string, string> | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'string' && x.trim()) out[k] = x.trim().slice(0, k === 'fbclid' || k === 'gclid' || k === 'ttclid' ? 500 : 200);
  }
  return Object.keys(out).length ? out : null;
});
/** what the server knows of the visitor (never from the page itself) */
const Meta = z
  .object({ ip: str(64), ua: str(500), country: str(4), city: str(80), region: str(80), fbp: str(200), fbc: str(600), url: str(500) })
  .partial()
  .default({});

/** Everything a page sends with an order. Lenient on purpose: a strange value is a signal for the score, not an error the sender sees. */
export const SubmitInput = z.object({
  slug: z.string().max(80),
  name: str(200),
  phone: str(40),
  wilaya: int(0),
  commune: str(120),
  variant: int(null),
  qty: int(1),
  hp: str(500),
  ch: str(200),
  pw: str(40),
  t: int(null),
  ki: int(null),
  wd: z.any().transform((v) => v === true),
  fp: str(64),
  did: str(64),
  vid: str(40),
  utm: utmOf,
  fbp: str(200),
  fbc: str(600),
  url: str(500),
  meta: Meta,
});

/** What the page sends while the customer fills the form (a valid phone typed): the abandoned order, if no order follows. */
export const CaptureInput = SubmitInput.pick({ slug: true, name: true, phone: true, wilaya: true, commune: true, variant: true, qty: true, hp: true, fp: true, did: true, vid: true, utm: true, fbp: true, fbc: true, url: true, meta: true });

const arDigits = (s: string) => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0));
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(province|wilaya|of)\b/g, '').replace(/[^a-z]/g, '');
const CITY_ALIAS: Record<string, number> = { algiers: 16, alger: 16, algeria: 16, oran: 31, wahran: 31, constantine: 25, annaba: 23, blida: 9, setif: 19, batna: 5, bejaia: 6, bougie: 6, tlemcen: 13, tiziouzou: 15, biskra: 7, ouargla: 30, djelfa: 17, chlef: 2, skikda: 21, jijel: 18, mostaganem: 27, boumerdes: 35, tipaza: 42, medea: 26, msila: 28, tiaret: 14, mascara: 29 };

/** wilaya of the IP from the host's geolocation headers (city or region), when it can be told */
export function ipWilaya(city: string, region: string): number | null {
  for (const raw of [city, region]) {
    const k = plain(raw || '');
    if (!k) continue;
    if (CITY_ALIAS[k]) return CITY_ALIAS[k];
    const i = WILAYAS.findIndex((w) => plain(w) === k);
    if (i >= 0) return i + 1;
  }
  return null;
}

/** an Algerian mobile number (05/06/07 + 8 digits) as typed, in Western or Arabic digits; null otherwise */
const mobileOf = (raw: string): string | null => {
  const d = arDigits(raw).replace(/[^\d+]/g, '').replace(/^(\+|00)213/, '0');
  return /^0?[567]\d{8}$/.test(d) ? normalizePhone(d) : null;
};

/** the ad set an order came from: the ad link's adset_id (Meta's {{adset.id}}) */
const adsetOf = (utm: Record<string, string> | null) => (utm?.adset_id && /^\d{5,30}$/.test(utm.adset_id) ? utm.adset_id : null);

/** Meta's click id: the _fbc cookie, else made from the ad link's fbclid (fb.1.<ms>.<fbclid>). */
const fbcOf = (cookie: string, sent: string, utm: Record<string, string> | null, now: number) => cookie || sent || (utm?.fbclid ? `fb.1.${now}.${utm.fbclid}` : '');

async function phoneHistory(db: Db, phone: string | null) {
  if (!phone) return { blacklisted: false, orders: 0, delivered: 0, returned: 0, cancelled: 0 };
  const c = (await db.query('SELECT blacklisted FROM customers WHERE phone = $1', [phone]))[0];
  const h = (
    await db.query(
      `SELECT count(*)::int AS n,
         count(*) FILTER (WHERE follow_status IN ('delivered','exchanged'))::int AS d,
         count(*) FILTER (WHERE follow_status IN ('returning','returned'))::int AS r,
         count(*) FILTER (WHERE conf_status = ANY($2))::int AS c
       FROM sales WHERE phone = $1`,
      [phone, CONF_DONE_BAD],
    )
  )[0];
  return { blacklisted: !!c?.blacklisted, orders: num(h?.n), delivered: num(h?.d), returned: num(h?.r), cancelled: num(h?.c) };
}

async function recentCounts(db: Db, a: { phone: string | null; productId: number; ip: string; device: string; now: number }) {
  const t = (ms: number) => isoAt(a.now - ms);
  const H = 3600_000;
  const r = (
    await db.query(
      `SELECT
         (SELECT count(*)::int FROM landing_submits WHERE $1::text IS NOT NULL AND phone = $1 AND at > $4) AS phone24h,
         (SELECT count(*)::int FROM landing_submits WHERE $1::text IS NOT NULL AND phone = $1 AND product_id = $2 AND verdict = 'block' AND at > $4)
           + (SELECT count(*)::int FROM sales o WHERE $1::text IS NOT NULL AND o.phone = $1 AND o.created_at > $4 AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id = $2)) AS dup,
         (SELECT count(*)::int FROM landing_submits WHERE $3 <> '' AND ip = $3 AND at > $5) AS ip10m,
         (SELECT count(*)::int FROM landing_submits WHERE $3 <> '' AND ip = $3 AND at > $6) AS ip1h,
         (SELECT count(*)::int FROM landing_submits WHERE fp = $7 AND at > $6) AS dev1h`,
      [a.phone, a.productId, a.ip, t(24 * H), t(10 * 60_000), t(H), a.device],
    )
  )[0];
  return { phone24h: num(r.phone24h), phoneSameProduct24h: num(r.dup), ip10m: num(r.ip10m), ip1h: num(r.ip1h), device1h: num(r.dev1h) };
}

/** French labels of the reasons, for an order's internal note (the app shows its own translated labels). */
export const FRAUD_LABELS_FR: Record<string, string> = {
  honeypot: 'champ piège rempli', phone_invalid: 'téléphone invalide', phone_repeat: 'téléphone répétitif', phone_sequence: 'téléphone en suite',
  name_link: 'lien dans le nom', name_digits: 'chiffres dans le nom', name_short: 'nom trop court', name_repeat: 'lettres répétées', name_keyboard: 'nom tapé au hasard',
  name_gibberish: 'nom incohérent', no_challenge: 'page non chargée normalement', too_fast: 'envoyé en moins de 3 s', fast: 'envoyé très vite', pow_missing: 'preuve JavaScript absente',
  pow_bad: 'preuve JavaScript fausse', pow_replay: 'preuve déjà utilisée', no_typing: 'aucune saisie au clavier', ua_empty: 'navigateur inconnu', ua_bot: 'robot / navigateur automatisé',
  webdriver: 'navigateur piloté', duplicate: 'même produit déjà commandé (24 h)', phone_burst: 'beaucoup de commandes de ce numéro', ip_burst: 'rafale depuis la même adresse IP',
  ip_many: 'beaucoup de commandes de la même IP', device_burst: 'rafale depuis le même appareil', blacklisted: 'numéro en liste noire', returns_many: 'refuse souvent ses colis',
  returns_some: 'déjà un colis retourné', cancels_many: 'commandes souvent annulées', good_customer: 'bon client (livré)', qty_high: 'quantité très élevée', qty_some: 'quantité élevée',
  ip_abroad: 'IP hors d’Algérie', ip_wilaya: 'IP d’une autre wilaya', form_invalid: 'formulaire incomplet',
};
const reasonsText = (rs: FraudReason[]) => rs.filter((r) => r.points > 0).map((r) => FRAUD_LABELS_FR[r.code] ?? r.code).join(', ');

/** The customer ordered (or was blocked as fake): their abandoned-order data is closed (a fake one's Meta event dropped). */
async function closeLeads(db: Db, phone: string, status: 'converted' | 'blocked', orderId: number | null, cut: string) {
  const leads = await db.query(
    `UPDATE landing_leads SET status = $2, order_id = COALESCE($3, order_id), handled_at = now(),
       abandoned_at = COALESCE(abandoned_at, CASE WHEN last_at < $4::timestamptz THEN last_at END)
     WHERE phone = $1 AND status IN ('open','abandoned') RETURNING id`,
    [phone, status, orderId, cut],
  );
  const ids = leads.map((r: any) => num(r.id));
  if (!ids.length) return;
  // a blocked (fake) submit is not even a start of checkout for Meta
  if (status === 'blocked') await db.query(`UPDATE meta_events SET status = 'skipped', error = 'Commande bloquée (fausse)' WHERE lead_id = ANY($1) AND status = 'queued'`, [ids]);
}

export async function submitOrder(ctx: Ctx, i: z.infer<typeof SubmitInput>): Promise<{ ok: true }> {
  const db = ctx.db;
  const l = (await db.query('SELECT * FROM landing_pages WHERE slug = $1 AND active', [i.slug]))[0];
  if (!l) throw notFound('Page introuvable');
  const productId = num(l.product_id);
  const pc = await productContext(db, productId);
  const s = await landingSettings(db);
  const now = ctx.now();
  const phoneRaw = arDigits(i.phone);
  const phone = mobileOf(i.phone);
  const qty = Math.max(1, Math.min(99, i.qty ?? 1));
  const wilayaId = i.wilaya && i.wilaya >= 1 && i.wilaya <= 69 ? i.wilaya : 0;
  const variant = pc.variants.find((v) => v.id === i.variant) ?? null;
  const ip = i.meta.ip ?? '';
  const device = i.did ? `d:${i.did}` : `f:${i.fp}:${ip}`;
  const servedMs = await checkChallenge(db, i.ch, i.slug, now);
  let pow: 'ok' | 'missing' | 'bad' | 'replay' = 'missing';
  if (i.pw && servedMs !== null) {
    pow = zeroBits(sha256Hex(`${i.ch}:${i.pw}`)) >= LANDING_POW_BITS ? 'ok' : 'bad';
    if (pow === 'ok' && (await db.query('SELECT 1 FROM landing_submits WHERE challenge = $1 LIMIT 1', [i.ch])).length) pow = 'replay';
  } else if (i.pw) pow = 'bad';

  const result = scoreOrder(
    {
      name: i.name,
      phoneRaw,
      phone,
      qty,
      honeypot: i.hp,
      servedMs,
      clientMs: i.t,
      inputs: i.ki,
      pow,
      userAgent: i.meta.ua ?? '',
      webdriver: i.wd,
      recent: await recentCounts(db, { phone, productId, ip, device, now }),
      history: await phoneHistory(db, phone),
      ipCountry: i.meta.country ? i.meta.country.toUpperCase() : null,
      ipWilaya: ipWilaya(i.meta.city ?? '', i.meta.region ?? ''),
      wilayaId,
    },
    (['relaxed', 'normal', 'strict'].includes(l.fraud_level) ? l.fraud_level : 'normal') as FraudLevel,
  );
  // a form the page itself would never send (no wilaya, no commune, no variant when there are some): a script.
  // A variant sold out since the page opened is still a real customer: it is ordered (the agent sets « sans stock »).
  if (!wilayaId || !i.commune.trim() || (pc.variants.length && !variant)) {
    result.reasons.unshift({ code: 'form_invalid', points: 100 });
    result.score = 100;
    result.verdict = 'block';
  }
  const unitPrice = unitPriceOf(numOrNull(l.price), pc, variant?.id ?? null);
  const variantId = variant?.id ?? (pc.variants.length ? null : pc.plainVariantId);
  const name = i.name.trim().replace(/\s+/g, ' ').slice(0, 120);
  const fbc = fbcOf(i.meta.fbc ?? '', i.fbc, i.utm, now);
  const fbp = i.meta.fbp || i.fbp;

  let orderId: number | null = null;
  let blockedId: number | null = null;
  let ref: string | null = null;
  if (result.verdict === 'block') {
    blockedId = num(
      (
        await db.query(
          `INSERT INTO landing_blocked (landing_id, product_id, variant_id, qty, unit_price, customer_name, phone, wilaya_id, commune, score, reasons, ip, user_agent, fp, utm, at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [l.id, productId, variantId, qty, unitPrice, name, phone ?? phoneRaw.slice(0, 20), wilayaId || null, i.commune.trim(), result.score, JSON.stringify(result.reasons), ip || null,
            (i.meta.ua ?? '').slice(0, 300) || null, device, i.utm ? JSON.stringify(i.utm) : null, isoAt(now)],
        )
      )[0].id,
    );
    if (phone) await closeLeads(db, phone, 'blocked', null, abandonCutoff(s, now));
  } else {
    // borderline orders go to « Nouvelle » too, with the reasons in the note (the agent sees them before calling)
    const review = result.verdict === 'review';
    const o = await createOrder(
      ctx,
      {
        customerName: name.length >= 2 ? name : 'Client',
        phone: phone!,
        wilayaId,
        commune: i.commune.trim(),
        address: '',
        isStopdesk: false,
        channel: 'landing',
        source: `Landing · ${i.slug}`.slice(0, 120),
        utm: i.utm,
        items: [{ productId, variantId, qty, unitPrice }],
        discount: 0,
        confirm: false,
        isExchange: false,
        internalNote: review ? `⚠ Landing page : score anti-fraude ${result.score}/100 — ${reasonsText(result.reasons)}` : null,
      },
      db,
      { landingId: num(l.id), adsetId: adsetOf(i.utm) },
    );
    orderId = o.id;
    ref = o.ref;
    await closeLeads(db, phone!, 'converted', o.id, abandonCutoff(s, now));
  }
  await db.query(
    `INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, challenge, verdict, score, order_id, blocked_id, at, ua, fbp, fbc, url, utm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [l.id, productId, phone, ip || null, device, servedMs !== null ? i.ch : null, result.verdict, result.score, orderId, blockedId, isoAt(now),
      (i.meta.ua ?? '').slice(0, 500) || null, fbp || null, fbc || null, (i.meta.url || i.url || '').slice(0, 500) || null, i.utm ? JSON.stringify(i.utm) : null],
  );
  // Meta Purchase « when the order is received »: only a clear order (a borderline one waits for a person to confirm it)
  if (orderId && s.purchaseAt === 'order' && result.verdict === 'allow') await queuePurchase(db, s, orderId, now);
  ctx.emit({ type: 'orders', ...(ref ? { id: orderId!, data: { created: { ref, channel: 'landing' } } } : {}) });
  await afterChange(ctx);
  return { ok: true };
}

/** What a customer typed, saved while they fill the form: their abandoned order if they leave without ordering. */
export async function captureLead(ctx: Ctx, i: z.infer<typeof CaptureInput>): Promise<{ ok: true }> {
  const db = ctx.db;
  const phone = mobileOf(i.phone);
  const ua = i.meta.ua ?? '';
  // robots are not customers: no abandoned order, no Meta event (and the answer is the same: nothing to learn)
  if (!phone || i.hp.trim() || BOT_UA.test(ua) || !ua.trim()) return { ok: true };
  const l = (await db.query('SELECT id, product_id, price, pixel_id FROM landing_pages WHERE slug = $1 AND active', [i.slug]))[0];
  if (!l) return { ok: true };
  const now = ctx.now();
  const ip = i.meta.ip ?? '';
  const device = i.did ? `d:${i.did}` : `f:${i.fp}:${ip}`;
  // a flood from one device or address is not 20 customers
  const flood = (await db.query(`SELECT count(*)::int AS n FROM landing_leads WHERE (device = $1 OR ($2 <> '' AND ip = $2)) AND at > $3`, [device, ip, isoAt(now - 3600_000)]))[0];
  const pc = await productContext(db, num(l.product_id));
  const variant = pc.variants.find((v) => v.id === i.variant) ?? null;
  const unitPrice = unitPriceOf(numOrNull(l.price), pc, variant?.id ?? null);
  const name = i.name.trim().replace(/\s+/g, ' ').slice(0, 120);
  const wilayaId = i.wilaya && i.wilaya >= 1 && i.wilaya <= 69 ? i.wilaya : null;
  const qty = Math.max(1, Math.min(99, i.qty ?? 1));
  const fbc = fbcOf(i.meta.fbc ?? '', i.fbc, i.utm, now);
  const fbp = i.meta.fbp || i.fbp;
  const had = (
    await db.query(`SELECT id FROM landing_leads WHERE phone = $1 AND landing_id = $2 AND status IN ('open','abandoned') AND last_at > $3 ORDER BY id DESC LIMIT 1`, [phone, l.id, isoAt(now - 86_400_000)])
  )[0];
  let leadId: number;
  if (had) {
    leadId = num(had.id);
    await db.query(
      `UPDATE landing_leads SET last_at = $2, status = 'open', customer_name = CASE WHEN $3 <> '' THEN $3 ELSE customer_name END, wilaya_id = COALESCE($4, wilaya_id),
         commune = CASE WHEN $5 <> '' THEN $5 ELSE commune END, variant_id = COALESCE($6, variant_id), qty = $7, unit_price = $8,
         fbp = COALESCE(NULLIF($9, ''), fbp), fbc = COALESCE(NULLIF($10, ''), fbc), utm = COALESCE($11, utm) WHERE id = $1`,
      [leadId, isoAt(now), name, wilayaId, i.commune.trim(), variant?.id ?? null, qty, unitPrice, fbp, fbc, i.utm ? JSON.stringify(i.utm) : null],
    );
  } else {
    if (num(flood?.n) >= 20) return { ok: true };
    leadId = num(
      (
        await db.query(
          `INSERT INTO landing_leads (at, last_at, landing_id, product_id, variant_id, qty, unit_price, customer_name, phone, wilaya_id, commune, device, ip, ua, fbp, fbc, url, utm, view_id)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [isoAt(now), l.id, l.product_id, variant?.id ?? null, qty, unitPrice, name, phone, wilayaId, i.commune.trim(), device, ip || null, ua.slice(0, 500), fbp || null, fbc || null,
            (i.meta.url || i.url || '').slice(0, 500) || null, i.utm ? JSON.stringify(i.utm) : null, i.vid || null],
        )
      )[0].id,
    );
    // Meta: the customer started to order (the browser pixel sends the same event id: counted once). Sent a few
    // minutes later, so the event of a submit found fake meanwhile is dropped.
    const s = await landingSettings(db);
    const pixel = String(l.pixel_id || s.pixelId || '').trim();
    if (pixel)
      await db.query(
        `INSERT INTO meta_events (pixel_id, event_name, event_id, lead_id, landing_id, value, at, send_after) VALUES ($1,'InitiateCheckout',$2,$3,$4,$5,$6,$7)
         ON CONFLICT (pixel_id, event_name, event_id) DO NOTHING`,
        [pixel, i.vid ? `ic-${i.vid}` : `ic-lead-${leadId}`, leadId, l.id, unitPrice * qty, isoAt(now), isoAt(now + 3 * 60_000)],
      );
  }
  return { ok: true };
}

/** An abandoned order becomes a real one (Commandes › Nouvelle): by Pilotix after the chosen time, or by a person. */
async function convertLead(ctx: Ctx, a: any, auto: boolean) {
  const phone = normalizePhone(a.phone);
  if (!phone) throw bad('Numéro de téléphone algérien invalide');
  if (!a.wilaya_id) throw bad('La wilaya n’a pas été choisie : complétez la commande depuis Commandes › Nouvelle commande');
  const slug = a.landing_id ? (await ctx.db.query('SELECT slug FROM landing_pages WHERE id = $1', [a.landing_id]))[0]?.slug : null;
  const utm = readJson<Record<string, string>>(a.utm);
  const o = await createOrder(
    ctx,
    {
      customerName: String(a.customer_name).length >= 2 ? a.customer_name : 'Client',
      phone,
      wilayaId: num(a.wilaya_id),
      commune: a.commune,
      address: '',
      isStopdesk: false,
      channel: 'landing',
      source: `${slug ? `Landing · ${slug}` : 'Landing'} · abandonnée`.slice(0, 120),
      utm,
      items: [{ productId: num(a.product_id), variantId: numOrNull(a.variant_id), qty: Math.max(1, num(a.qty)), unitPrice: num(a.unit_price) }],
      discount: 0,
      confirm: false,
      isExchange: false,
      internalNote: 'Commande abandonnée : le client a laissé son numéro sans valider. Appelez-le pour confirmer.',
    },
    ctx.db,
    // no « we received your order » message: the customer did not send it, the agents call
    { landingId: numOrNull(a.landing_id), adsetId: adsetOf(utm), silent: true },
  );
  await ctx.db.query(
    `UPDATE landing_leads SET status = 'converted', order_id = $2, auto_order = $3, handled_by = $4, handled_at = now(), abandoned_at = COALESCE(abandoned_at, last_at) WHERE id = $1`,
    [a.id, o.id, auto, auto ? null : ctx.session.profile.id],
  );
  return o;
}

/**
 * Every minute on the server (in the preview: when the lists are read): open leads with no news for the chosen time
 * become abandoned orders, added to Commandes as « Nouvelle » (one without wilaya waits in « Abandonnées » for a
 * person); a lead whose number ordered meanwhile (any channel) is closed.
 */
export async function sweepAbandoned(ctx: Ctx): Promise<{ abandoned: number; ordered: number }> {
  const db = ctx.db;
  const s = await landingSettings(db);
  const now = ctx.now();
  const cut = abandonCutoff(s, now);
  await db.query(
    `UPDATE landing_leads a SET status = 'converted', order_id = (SELECT o.id FROM orders o WHERE o.phone = a.phone AND o.created_at >= a.at ORDER BY o.id LIMIT 1), handled_at = now(),
       abandoned_at = COALESCE(a.abandoned_at, CASE WHEN a.last_at < $1::timestamptz THEN a.last_at END)
     WHERE a.status IN ('open','abandoned') AND EXISTS (SELECT 1 FROM orders o WHERE o.phone = a.phone AND o.created_at >= a.at)`,
    [cut],
  );
  // claimed once even when two runs overlap (the job and the cron hook)
  const rows = await db.query(
    `UPDATE landing_leads SET status = 'abandoned', abandoned_at = $2 WHERE id IN (
       SELECT id FROM landing_leads WHERE status = 'open' AND last_at < $1 ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [cut, isoAt(now)],
  );
  let ordered = 0;
  for (const a of rows) {
    if (!a.wilaya_id) continue; // incomplete: stays in « Abandonnées » for a person
    try {
      await convertLead(ctx, a, true);
      ordered++;
    } catch {
      /* a product removed meanwhile…: stays in the list for a person */
    }
  }
  if (rows.length) ctx.emit({ type: 'orders' });
  return { abandoned: rows.length - ordered, ordered };
}

// ---------------------------------------------------------------- Meta Conversions API (the outbox)
const sha = (v: string | null | undefined) => {
  const x = String(v ?? '').trim().toLowerCase();
  return x ? sha256Hex(x) : null;
};
/** Meta's user data: hashed phone (213…), names, commune, wilaya, country and customer id; IP, browser and cookies as they are. */
function userData(r: { phone: string; name: string; commune?: string | null; wilaya?: number | null; customerId?: number | null; ip?: string | null; ua?: string | null; fbp?: string | null; fbc?: string | null }) {
  const words = r.name.trim().split(/\s+/).filter(Boolean);
  const u: Record<string, unknown> = { ph: [sha256Hex(`213${r.phone.replace(/^0/, '')}`)], country: [sha256Hex('dz')] };
  const fn = sha(words[0]);
  const ln = sha(words.slice(1).join(' '));
  if (fn && words.length) u.fn = [fn];
  if (ln) u.ln = [ln];
  const ct = sha((r.commune ?? '').replace(/[^\p{L}]/gu, ''));
  if (ct) u.ct = [ct];
  if (r.wilaya) u.st = [sha(String(r.wilaya).padStart(2, '0'))];
  if (r.customerId) u.external_id = [sha(String(r.customerId))];
  if (r.ip) u.client_ip_address = r.ip;
  if (r.ua) u.client_user_agent = r.ua;
  if (r.fbp) u.fbp = r.fbp;
  if (r.fbc) u.fbc = r.fbc;
  return u;
}

/** The event Meta receives, or why it is not sent anymore. */
async function buildEvent(db: Db, e: any, publicUrl: string): Promise<{ event?: Record<string, unknown>; skip?: string }> {
  const sourceUrl = (slug: string | null, url: string | null) => url || (slug && publicUrl ? `${publicUrl}/api/lp/${slug}` : publicUrl || 'https://pilotix.app');
  if (e.event_name === 'Purchase') {
    const o = (
      await db.query(
        `SELECT o.*, l.slug, s.ip AS s_ip, s.ua AS s_ua, s.fbp AS s_fbp, s.fbc AS s_fbc, s.url AS s_url,
           (SELECT json_agg(json_build_object('id', i.product_id, 'quantity', i.qty, 'item_price', i.unit_price)) FROM order_items i WHERE i.order_id = o.id) AS items
         FROM orders o LEFT JOIN landing_pages l ON l.id = o.landing_id
         LEFT JOIN LATERAL (SELECT * FROM landing_submits x WHERE x.order_id = o.id ORDER BY x.id DESC LIMIT 1) s ON true
         WHERE o.id = $1`,
        [e.order_id],
      )
    )[0];
    if (!o) return { skip: 'Commande supprimée' };
    // an order found fake, a duplicate, a wrong number or cancelled before the event left: never a sale
    if ((CONF_DONE_BAD as string[]).includes(o.conf_status)) return { skip: 'Commande annulée ou fausse : pas de Purchase' };
    const items = (readJson<any[]>(o.items) ?? []).map((x) => ({ id: String(x.id), quantity: num(x.quantity), item_price: num(x.item_price) }));
    return {
      event: {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: e.event_id,
        action_source: 'website',
        event_source_url: sourceUrl(o.slug, o.s_url),
        user_data: userData({ phone: o.phone, name: o.customer_name, commune: o.commune, wilaya: num(o.wilaya_id), customerId: num(o.customer_id), ip: o.s_ip, ua: o.s_ua, fbp: o.s_fbp, fbc: o.s_fbc }),
        custom_data: { currency: 'DZD', value: num(o.total), order_id: o.ref, content_type: 'product', content_ids: items.map((x) => x.id), contents: items, num_items: items.reduce((n, x) => n + x.quantity, 0) },
      },
    };
  }
  const a = (await db.query(`SELECT a.*, l.slug FROM landing_leads a LEFT JOIN landing_pages l ON l.id = a.landing_id WHERE a.id = $1`, [e.lead_id]))[0];
  if (!a) return { skip: 'Commande abandonnée supprimée' };
  if (['blocked', 'dismissed'].includes(a.status)) return { skip: 'Commande bloquée ou rejetée' };
  return {
    event: {
      event_name: 'InitiateCheckout',
      event_time: Math.floor(Date.parse(iso(a.at)) / 1000),
      event_id: e.event_id,
      action_source: 'website',
      event_source_url: sourceUrl(a.slug, a.url),
      user_data: userData({ phone: a.phone, name: a.customer_name, commune: a.commune, wilaya: numOrNull(a.wilaya_id), ip: a.ip, ua: a.ua, fbp: a.fbp, fbc: a.fbc }),
      custom_data: { currency: 'DZD', value: num(e.value), content_type: 'product', content_ids: [String(a.product_id)], num_items: Math.max(1, num(a.qty)) },
    },
  };
}

/** Sends the Meta events that are due (the server's job every minute). In the preview they are only marked « simulé ». */
export async function sendMetaEvents(ctx: Ctx, limit = 100): Promise<{ sent: number; failed: number; skipped: number }> {
  const db = ctx.db;
  const now = ctx.now();
  await db.query(`UPDATE meta_events SET status = 'queued', claimed_at = NULL WHERE status = 'sending' AND claimed_at < $1`, [isoAt(now - 10 * 60_000)]);
  const claimed = await db.query(
    `UPDATE meta_events SET status = 'sending', claimed_at = $1 WHERE status = 'queued' AND id IN (
       SELECT id FROM meta_events WHERE status = 'queued' AND send_after <= $1 ORDER BY send_after, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [isoAt(now), limit],
  );
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (!claimed.length) return out;
  const s = await landingSettings(db);
  const token = String((await db.query(`SELECT value FROM settings WHERE key = $1`, [LANDING_CAPI_SECRET]))[0]?.value ?? '') || String((await db.query(`SELECT value FROM settings WHERE key = 'secret_meta_token'`))[0]?.value ?? '');
  const byPixel = new Map<string, { row: any; event: Record<string, unknown> }[]>();
  for (const e of claimed) {
    const b = await buildEvent(db, e, ctx.server?.publicUrl ?? '');
    if (!b.event) {
      await db.query(`UPDATE meta_events SET status = 'skipped', error = $2, claimed_at = NULL WHERE id = $1`, [e.id, b.skip]);
      out.skipped++;
      continue;
    }
    if (!byPixel.has(e.pixel_id)) byPixel.set(e.pixel_id, []);
    byPixel.get(e.pixel_id)!.push({ row: e, event: b.event });
  }
  for (const [pixelId, list] of byPixel) {
    const ids = list.map((x) => num(x.row.id));
    if (simulated(ctx)) {
      await db.query(`UPDATE meta_events SET status = 'simulated', sent_at = now(), error = NULL, claimed_at = NULL WHERE id = ANY($1)`, [ids]);
      out.sent += ids.length;
      continue;
    }
    if (!token) {
      await db.query(`UPDATE meta_events SET status = 'failed', error = 'Jeton Conversions API manquant (Landing pages › Réglages)', claimed_at = NULL WHERE id = ANY($1)`, [ids]);
      out.failed += ids.length;
      continue;
    }
    try {
      await ctx.server!.meta('capi', { pixelId, token, events: list.map((x) => x.event), testEventCode: s.testEventCode || undefined }, ctx);
      await db.query(`UPDATE meta_events SET status = 'sent', sent_at = now(), error = NULL, claimed_at = NULL WHERE id = ANY($1)`, [ids]);
      out.sent += ids.length;
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? 'Erreur Meta').slice(0, 300);
      // tried again 5 times (10 minutes apart), then left in « échoué » with Meta's message
      await db.query(
        `UPDATE meta_events SET attempts = attempts + 1, error = $2, claimed_at = NULL,
           status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'queued' END, send_after = now() + interval '10 minutes' WHERE id = ANY($1)`,
        [ids, msg],
      );
      out.failed += ids.length;
    }
  }
  return out;
}

/** The landing pages' background work: abandoned orders, then Meta events. */
export async function landingRun(ctx: Ctx) {
  const abandoned = await sweepAbandoned(ctx);
  const meta = await sendMetaEvents(ctx);
  return { abandoned, meta };
}

/** In the preview nothing runs in the background: the work is done when its lists are read, and after a change. */
async function afterChange(ctx: Ctx) {
  if (!simulated(ctx)) return;
  await landingRun(ctx).catch(() => null);
  await sendInPreview(ctx);
}

// ---------------------------------------------------------------- editing
const ImgInput = z.union([z.object({ id }), z.object({ url: z.string().trim().url().max(12_000), w: z.number().int().min(1).max(10000), h: z.number().int().min(1).max(10000) })]);
const PixelId = z.string().trim().max(20).regex(/^\d*$/, 'Pixel Meta : des chiffres (Events Manager › Sources de données)');
export const PageInput = z.object({
  id: id.optional(),
  productId: id,
  slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Adresse : lettres minuscules, chiffres et tirets'),
  active: z.boolean().default(true),
  title: z.string().trim().max(200).default(''),
  color: z.string().refine(isHexColor, 'Couleur invalide').default(LANDING_DEFAULT_COLOR),
  price: z.number().int().min(0).max(100_000_000).nullable().default(null),
  oldPrice: z.number().int().min(0).max(100_000_000).nullable().default(null),
  description: z.string().max(8000).default(''),
  variantLabel: z.string().trim().max(40).default('اللون'),
  fraudLevel: z.enum(['relaxed', 'normal', 'strict']).default('normal'),
  pixelId: PixelId.default(''),
  stockMode: z.enum(['off', 'hide']).default('off'),
  images: z.array(ImgInput).max(12).default([]),
});

const SettingsInput = z.object({
  pixelId: PixelId,
  testEventCode: z.string().trim().max(40).regex(/^[A-Za-z0-9]*$/, 'Code de test : lettres et chiffres (TEST12345)'),
  purchaseAt: z.enum(['order', 'confirmed', 'delivered']),
  abandonAfterMin: z.number().int().min(5).max(24 * 60),
  autoCreate: z.boolean(),
  /** the Conversions API token: a value replaces, '' keeps, null removes (admins only) */
  capiToken: z.string().max(600).nullable().default(''),
});

const B64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/=]+$/, 'Image invalide');
const LEAD_STATUS = ['abandoned', 'converted', 'dismissed', 'all'] as const;

export const landingProcs = {
  'landing.list': proc([...WHO], z.object({}), (ctx) => listPages(ctx.db, ctx.now())),

  'landing.get': proc([...WHO], z.object({ id }), async (ctx, { id }) => {
    const l = (await ctx.db.query('SELECT images FROM landing_pages WHERE id = $1', [id]))[0];
    if (!l) throw notFound('Page introuvable');
    const refs = readImgs(l.images);
    const rows = await imageRows(ctx.db, refs, true);
    const images: LandingImageRow[] = refs.flatMap((r): LandingImageRow[] => {
      if ('url' in r) return [{ id: null, url: r.url, w: r.w, h: r.h, thumb: r.url, src: r.url }];
      const x = rows.get(r.id);
      return x ? [{ id: r.id, url: null, w: num(x.w), h: num(x.h), thumb: b64(x.t160), src: b64(x.w480) }] : [];
    });
    return { ...(await listPages(ctx.db, ctx.now(), [id]))[0], images };
  }),

  /** price, variants (own price, stock), delivery prices and shop name of a product (the editor's preview) */
  'landing.context': proc([...WHO], z.object({ productId: id }), async (ctx, { productId }) => {
    const pc = await productContext(ctx.db, productId);
    return { name: pc.name, price: pc.price, fixedPrice: pc.fixedPrice, variants: pc.variants, soldOut: pc.soldOut, fees: pc.fees, shopName: pc.shopName, bits: LANDING_POW_BITS };
  }),

  'landing.freeSlug': proc([...WHO], z.object({ name: z.string().max(200), sku: z.string().max(120).optional(), id: id.optional() }), async (ctx, i) => ({
    slug: await freeLandingSlug(ctx.db, i.name, i.sku ?? '', i.id),
  })),

  'landing.save': proc([...WHO], PageInput, async (ctx, i) => {
    const dup = (await ctx.db.query('SELECT id FROM landing_pages WHERE slug = $1', [i.slug]))[0];
    if (dup && num(dup.id) !== i.id) throw bad(`L’adresse « ${i.slug} » est déjà prise`);
    if (!(await ctx.db.query('SELECT 1 FROM products WHERE id = $1', [i.productId])).length) throw notFound('Produit introuvable');
    const vals = [i.productId, i.slug, i.active, i.title, i.color.toLowerCase(), i.price, i.oldPrice, i.description, i.variantLabel || 'اللون', i.fraudLevel, JSON.stringify(i.images), i.pixelId, i.stockMode];
    let pid: number;
    if (i.id) {
      const r = await ctx.db.query(
        `UPDATE landing_pages SET product_id=$2, slug=$3, active=$4, title=$5, color=$6, price=$7, old_price=$8, description=$9, variant_label=$10, fraud_level=$11, images=$12,
           pixel_id=$13, stock_mode=$14, updated_at=now() WHERE id=$1 RETURNING id`,
        [i.id, ...vals],
      );
      if (!r.length) throw notFound('Page introuvable');
      pid = i.id;
    } else {
      pid = num(
        (
          await ctx.db.query(
            `INSERT INTO landing_pages (product_id, slug, active, title, color, price, old_price, description, variant_label, fraud_level, images, pixel_id, stock_mode, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [...vals, ctx.session.profile.id],
          )
        )[0].id,
      );
    }
    ctx.emit({ type: 'stock' });
    return (await listPages(ctx.db, ctx.now(), [pid]))[0];
  }),

  'landing.remove': proc([...WHO], z.object({ id }), async (ctx, { id }) => {
    await ctx.db.query('DELETE FROM landing_pages WHERE id = $1', [id]);
    ctx.emit({ type: 'stock' });
    return { ok: true };
  }),

  /** a picture already turned into WebP by the editor (three widths, base64) */
  'landing.addImage': proc(
    [...WHO],
    z.object({ w: z.number().int().min(1).max(10000), h: z.number().int().min(1).max(10000), t160: B64(60_000), w480: B64(400_000), w960: B64(1_200_000) }),
    async (ctx, i) => {
      const r = (await ctx.db.query('INSERT INTO landing_images (w, h, t160, w480, w960, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [i.w, i.h, i.t160, i.w480, i.w960, ctx.session.profile.id]))[0];
      return { id: num(r.id), url: null, w: i.w, h: i.h, thumb: b64(i.t160), src: b64(i.w480) } satisfies LandingImageRow;
    },
  ),

  /** products a page can be made for (with their SKU, for an address when the name is in Arabic) */
  'landing.products': proc([...WHO], z.object({}), async (ctx) =>
    (await ctx.db.query(`SELECT id, name, sku, price FROM products WHERE active AND NOT is_service ORDER BY lower(name)`)).map((r: any) => ({
      id: num(r.id),
      name: String(r.name),
      sku: String(r.sku ?? ''),
      price: num(r.price),
    })),
  ),

  /** the saved page as the customer sees it, inside Pilotix (the order goes to the window around it) */
  'landing.preview': proc([...WHO], z.object({ slug: z.string().max(80) }), async (ctx, i) => ({ html: await landingHtml(ctx, i.slug, { mode: 'parent', post: '', geo: '', lead: 'parent', imgBase: null }) })),

  // ---------------------------------------------------------------- products without a page
  /** active products (not services) with no page yet, newest first, except those set aside */
  'landing.missing': proc([...WHO], z.object({}), async (ctx) => {
    const s = await landingSettings(ctx.db);
    const rows = await ctx.db.query(
      `SELECT p.id, p.name, p.sku, p.price, p.photo, p.created_at,
         (SELECT COALESCE(sum(st.qty), 0)::int FROM stock st JOIN product_variants v ON v.id = st.variant_id WHERE v.product_id = p.id) AS stock
       FROM products p WHERE p.active AND NOT p.is_service AND NOT (p.id = ANY($1::bigint[]))
         AND NOT EXISTS (SELECT 1 FROM landing_pages l WHERE l.product_id = p.id)
       ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
      [s.ignored ?? []],
    );
    return rows.map((r: any) => ({ id: num(r.id), name: String(r.name), sku: String(r.sku ?? ''), price: num(r.price), photo: r.photo ?? null, stock: num(r.stock), createdAt: iso(r.created_at) }));
  }),

  /** One click: a page for a product from what Pilotix knows of it (the product's page when it already has one). */
  'landing.quickCreate': proc([...WHO], z.object({ productId: id }), async (ctx, i) => {
    const r = await quickCreatePage(ctx.db, i.productId, ctx.session.profile.id);
    ctx.emit({ type: 'stock' });
    return { ...r, page: (await listPages(ctx.db, ctx.now(), [r.id]))[0] };
  }),

  /** A product that will never get a page (an accessory…): no alert for it any more (or again). */
  'landing.ignore': proc([...WHO], z.object({ productId: id, on: z.boolean() }), async (ctx, i) => {
    const s = await landingSettings(ctx.db);
    const set = new Set((s.ignored ?? []).map(Number));
    if (i.on) set.add(i.productId);
    else set.delete(i.productId);
    await setSetting(ctx.db, 'landing', { ...s, ignored: [...set] }, ctx.session.profile.id);
    ctx.emit({ type: 'stock' });
    return { ok: true };
  }),

  /** For Produits & stock: the pages of each product (the depot sees which products have none). */
  'landing.coverage': proc(['depot', 'marketer'], z.object({}), async (ctx) => {
    const s = await landingSettings(ctx.db);
    const rows = await ctx.db.query(`SELECT product_id, count(*)::int AS n, count(*) FILTER (WHERE active)::int AS live, min(id) AS first_id FROM landing_pages GROUP BY product_id`);
    return { pages: rows.map((r: any) => ({ productId: num(r.product_id), pages: num(r.n), live: num(r.live), firstId: num(r.first_id) })), ignored: (s.ignored ?? []).map(Number) };
  }),

  // ---------------------------------------------------------------- settings: Meta pixel, abandoned orders, automations
  'landing.settings.get': proc([...WHO], z.object({}), async (ctx) => {
    const s = await landingSettings(ctx.db);
    const own = !!String((await ctx.db.query(`SELECT value FROM settings WHERE key = $1`, [LANDING_CAPI_SECRET]))[0]?.value ?? '');
    const ads = !!String((await ctx.db.query(`SELECT value FROM settings WHERE key = 'secret_meta_token'`))[0]?.value ?? '');
    return {
      settings: { pixelId: s.pixelId, testEventCode: s.testEventCode, purchaseAt: s.purchaseAt, abandonAfterMin: s.abandonAfterMin, autoCreate: s.autoCreate },
      /** the token itself never leaves the server */
      capi: { own, ads },
      demo: simulated(ctx),
      /** what to paste in the ad's « URL parameters » (Meta fills the {{…}}) */
      urlParams: 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}',
    };
  }),

  'landing.settings.save': proc([...WHO], SettingsInput, async (ctx, i) => {
    const { capiToken, ...rest } = i;
    if (capiToken !== '' && !ctx.session.isAdmin) throw forbidden('Seul l’administrateur modifie le jeton Meta');
    const cur = await landingSettings(ctx.db);
    await setSetting(ctx.db, 'landing', { ...cur, ...rest }, ctx.session.profile.id);
    if (capiToken === null) await ctx.db.query(`DELETE FROM settings WHERE key = $1`, [LANDING_CAPI_SECRET]);
    else if (capiToken.trim())
      await ctx.db.query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [LANDING_CAPI_SECRET, JSON.stringify(capiToken.trim()), ctx.session.profile.id],
      );
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),

  /** What was sent to Meta (or not, and why), newest first. */
  'landing.events': proc([...WHO], z.object({ limit: z.number().int().min(1).max(200).default(60) }), async (ctx, i) => {
    await afterChange(ctx);
    const rows = await ctx.db.query(
      `SELECT e.*, o.ref, o.customer_name AS o_name, a.customer_name AS a_name, a.phone AS a_phone, l.slug
       FROM meta_events e LEFT JOIN orders o ON o.id = e.order_id LEFT JOIN landing_leads a ON a.id = e.lead_id LEFT JOIN landing_pages l ON l.id = e.landing_id
       ORDER BY e.at DESC, e.id DESC LIMIT ${i.limit}`,
    );
    const k = (await ctx.db.query(`SELECT status, count(*)::int AS n FROM meta_events WHERE at > now() - interval '30 days' GROUP BY 1`)).reduce(
      (m: Record<string, number>, r: any) => ({ ...m, [r.status]: num(r.n) }),
      {},
    );
    return {
      counts: k as Record<string, number>,
      rows: rows.map((r: any) => ({
        id: num(r.id),
        at: iso(r.at),
        sentAt: isoOrNull(r.sent_at),
        name: r.event_name as 'Purchase' | 'InitiateCheckout',
        pixelId: r.pixel_id,
        status: r.status as 'queued' | 'sending' | 'sent' | 'failed' | 'skipped' | 'simulated',
        error: r.error ?? null,
        value: numOrNull(r.value),
        orderId: numOrNull(r.order_id),
        ref: r.ref ?? null,
        customer: r.o_name ?? r.a_name ?? null,
        phone: r.a_phone ?? null,
        slug: r.slug ?? null,
      })),
    };
  }),

  // ---------------------------------------------------------------- public side (the server calls these as the system)
  'landing.html': proc(
    [],
    z.object({ slug: z.string().max(80), mode: z.enum(['live', 'parent', 'preview']), post: z.string().max(500).default(''), geo: z.string().max(500).default(''), lead: z.string().max(500).default(''), imgBase: z.string().max(500).nullable().default(null) }),
    async (ctx, i) => ({ html: await landingHtml(ctx, i.slug, i) }),
  ),

  'landing.image': proc([], z.object({ id, size: z.enum(['160', '480', '960']) }), async (ctx, i) => {
    const col = i.size === '160' ? 't160' : i.size === '480' ? 'w480' : 'w960';
    const r = (await ctx.db.query(`SELECT ${col} AS b FROM landing_images WHERE id = $1`, [i.id]))[0];
    if (!r) throw notFound('Image introuvable');
    return { base64: String(r.b) };
  }),

  'landing.submit': proc([], SubmitInput, (ctx, i) => submitOrder(ctx, i)),
  'landing.capture': proc([], CaptureInput, async (ctx, i) => {
    const r = await captureLead(ctx, i);
    return r;
  }),
  /** the server's job (every minute) and the cron hook */
  'landing.run': proc([], z.object({}), (ctx) => landingRun(ctx)),

  // ---------------------------------------------------------------- « Commandes bloquées » and « Abandonnées »
  'landing.counts': proc([...WATCH], z.object({}), async (ctx) => {
    await afterChange(ctx);
    return landingCounts(ctx.db, ctx.now());
  }),

  'landing.blocked': proc(
    [...WATCH],
    z.object({ status: z.enum(['blocked', 'restored', 'dismissed', 'all']).default('blocked'), q: z.string().max(100).optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(200).default(50) }),
    async (ctx, f) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (f.status !== 'all') where.push(`b.status = $${params.push(f.status)}`);
      const q = f.q?.trim();
      if (q) where.push(`(b.customer_name ILIKE '%' || $${params.push(q)} || '%' OR b.phone LIKE '%' || $${params.push(q.replace(/\D/g, '') || q)} || '%')`);
      const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM landing_blocked b ${W}`, params))[0]?.n);
      const stats = (
        await ctx.db.query(
          `SELECT count(*) FILTER (WHERE status = 'blocked')::int AS blocked, count(*) FILTER (WHERE status = 'restored')::int AS restored,
                  count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed, count(*) FILTER (WHERE at > now() - interval '7 days')::int AS week,
                  (SELECT count(*)::int FROM landing_submits WHERE at > now() - interval '7 days') AS submits
           FROM landing_blocked`,
        )
      )[0];
      const rows = await ctx.db.query(
        `SELECT b.*, l.slug, p.name AS product_name, v.title AS variant_title, h.name AS handled_name, o.ref AS order_ref
         FROM landing_blocked b LEFT JOIN landing_pages l ON l.id = b.landing_id LEFT JOIN products p ON p.id = b.product_id
         LEFT JOIN product_variants v ON v.id = b.variant_id LEFT JOIN profiles h ON h.id = b.handled_by LEFT JOIN orders o ON o.id = b.order_id
         ${W} ORDER BY b.at DESC LIMIT $${params.push(f.pageSize)} OFFSET $${params.push((f.page - 1) * f.pageSize)}`,
        params,
      );
      return {
        total,
        page: f.page,
        pageSize: f.pageSize,
        stats: { blocked: num(stats?.blocked), restored: num(stats?.restored), dismissed: num(stats?.dismissed), week: num(stats?.week), submits: num(stats?.submits) },
        rows: rows.map((r: any) => ({
          id: num(r.id),
          at: iso(r.at),
          slug: r.slug ?? null,
          productName: r.product_name ?? '—',
          variantTitle: r.variant_title || '',
          qty: num(r.qty),
          unitPrice: num(r.unit_price),
          customerName: r.customer_name,
          phone: r.phone,
          wilayaId: numOrNull(r.wilaya_id),
          commune: r.commune,
          score: num(r.score),
          reasons: (readJson<FraudReason[]>(r.reasons) ?? []) as FraudReason[],
          ip: r.ip ?? null,
          userAgent: r.user_agent ?? null,
          status: r.status as 'blocked' | 'restored' | 'dismissed',
          orderId: numOrNull(r.order_id),
          orderRef: r.order_ref ?? null,
          handledBy: r.handled_name ?? null,
          handledAt: isoOrNull(r.handled_at),
        })),
      };
    },
  ),

  /** a real customer after all: the order is created as if it had passed (« Nouvelle », to confirm by phone) */
  'landing.restore': proc([...WATCH], z.object({ id }), async (ctx, { id }) => {
    const b = (await ctx.db.query('SELECT * FROM landing_blocked WHERE id = $1', [id]))[0];
    if (!b) throw notFound('Commande bloquée introuvable');
    if (b.status === 'restored') throw bad('Déjà restaurée');
    const phone = normalizePhone(b.phone);
    if (!phone) throw bad('Numéro de téléphone algérien invalide : impossible de créer la commande');
    if (!b.wilaya_id) throw bad('Wilaya manquante : impossible de créer la commande');
    const slug = b.landing_id ? (await ctx.db.query('SELECT slug FROM landing_pages WHERE id = $1', [b.landing_id]))[0]?.slug : null;
    const utm = readJson<Record<string, string>>(b.utm);
    const o = await createOrder(
      ctx,
      {
        customerName: String(b.customer_name).length >= 2 ? b.customer_name : 'Client',
        phone,
        wilayaId: num(b.wilaya_id),
        commune: b.commune,
        address: '',
        isStopdesk: false,
        channel: 'landing',
        source: slug ? `Landing · ${slug}` : 'Landing',
        utm,
        items: [{ productId: num(b.product_id), variantId: numOrNull(b.variant_id), qty: num(b.qty), unitPrice: num(b.unit_price) }],
        discount: 0,
        confirm: false,
        isExchange: false,
        internalNote: `Restaurée depuis « Commandes bloquées » (score ${num(b.score)}/100)`,
      },
      ctx.db,
      { landingId: numOrNull(b.landing_id), adsetId: adsetOf(utm) },
    );
    await ctx.db.query(`UPDATE landing_blocked SET status = 'restored', order_id = $2, handled_by = $3, handled_at = now() WHERE id = $1`, [id, o.id, ctx.session.profile.id]);
    await ctx.db.query('UPDATE landing_submits SET order_id = $2 WHERE blocked_id = $1', [id, o.id]);
    // a person decided it is real: with « Purchase when received », it counts now
    const s = await landingSettings(ctx.db);
    if (s.purchaseAt === 'order') await queuePurchase(ctx.db, s, o.id, ctx.now());
    ctx.emit({ type: 'orders' });
    await afterChange(ctx);
    return { ok: true, orderId: o.id, ref: o.ref };
  }),

  /** really fake: kept out of the list (and the number blacklisted when asked) */
  'landing.dismiss': proc([...WATCH], z.object({ id, blacklist: z.boolean().default(false) }), async (ctx, i) => {
    const b = (await ctx.db.query(`UPDATE landing_blocked SET status = 'dismissed', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'blocked' RETURNING phone, customer_name, wilaya_id`, [i.id, ctx.session.profile.id]))[0];
    if (!b) throw notFound('Commande bloquée introuvable');
    const phone = normalizePhone(b.phone);
    if (i.blacklist && phone) {
      await ctx.db.query(
        `INSERT INTO customers (phone, name, wilaya_id, blacklisted, blacklist_reason) VALUES ($1,$2,$3,true,'Fausse commande (landing page)')
         ON CONFLICT (phone) DO UPDATE SET blacklisted = true, blacklist_reason = COALESCE(customers.blacklist_reason, 'Fausse commande (landing page)')`,
        [phone, b.customer_name || 'Client', b.wilaya_id],
      );
    }
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  /** « Abandonnées »: the numbers that did not order (to call), the ones turned into orders, the ones set aside. */
  'landing.leads': proc(
    [...WATCH],
    z.object({ status: z.enum(LEAD_STATUS).default('abandoned'), q: z.string().max(100).optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(200).default(50) }),
    async (ctx, f) => {
      await afterChange(ctx);
      const s = await landingSettings(ctx.db);
      const cut = abandonCutoff(s, ctx.now());
      const params: unknown[] = [cut];
      const where: string[] = [`a.status <> 'blocked'`];
      if (f.status === 'abandoned') where.push(ABANDONED('$1::timestamptz'));
      else if (f.status === 'converted') where.push(`a.status = 'converted' AND a.abandoned_at IS NOT NULL`);
      else if (f.status === 'dismissed') where.push(`a.status = 'dismissed'`);
      else where.push(`(a.abandoned_at IS NOT NULL OR a.status = 'dismissed' OR (a.status = 'open' AND a.last_at < $1::timestamptz))`);
      const q = f.q?.trim();
      if (q) where.push(`(a.customer_name ILIKE '%' || $${params.push(q)} || '%' OR a.phone LIKE '%' || $${params.push(q.replace(/\D/g, '') || q)} || '%')`);
      const W = `WHERE ${where.join(' AND ')}`;
      const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM landing_leads a ${W}`, params))[0]?.n);
      const stats = (
        await ctx.db.query(
          `SELECT count(*) FILTER (WHERE ${ABANDONED('$1::timestamptz')})::int AS abandoned,
                  count(*) FILTER (WHERE a.status = 'converted' AND a.abandoned_at IS NOT NULL)::int AS converted,
                  count(*) FILTER (WHERE a.status = 'converted' AND a.abandoned_at IS NOT NULL AND NOT a.auto_order)::int AS recovered,
                  count(*) FILTER (WHERE a.status = 'dismissed')::int AS dismissed,
                  COALESCE(sum(a.unit_price * a.qty) FILTER (WHERE ${ABANDONED('$1::timestamptz')}), 0)::int AS value
           FROM landing_leads a WHERE a.status <> 'blocked'`,
          [cut],
        )
      )[0];
      const rows = await ctx.db.query(
        `SELECT a.*, l.slug, p.name AS product_name, v.title AS variant_title, h.name AS handled_name, o.ref AS order_ref
         FROM landing_leads a LEFT JOIN landing_pages l ON l.id = a.landing_id LEFT JOIN products p ON p.id = a.product_id
         LEFT JOIN product_variants v ON v.id = a.variant_id LEFT JOIN profiles h ON h.id = a.handled_by LEFT JOIN orders o ON o.id = a.order_id
         ${W} ORDER BY a.last_at DESC LIMIT $${params.push(f.pageSize)} OFFSET $${params.push((f.page - 1) * f.pageSize)}`,
        params,
      );
      return {
        total,
        page: f.page,
        pageSize: f.pageSize,
        abandonAfterMin: s.abandonAfterMin,
        stats: { abandoned: num(stats?.abandoned), converted: num(stats?.converted), recovered: num(stats?.recovered), dismissed: num(stats?.dismissed), value: num(stats?.value) },
        rows: rows.map((r: any) => ({
          id: num(r.id),
          at: iso(r.at),
          lastAt: iso(r.last_at),
          slug: r.slug ?? null,
          productId: numOrNull(r.product_id),
          variantId: numOrNull(r.variant_id),
          productName: r.product_name ?? '—',
          variantTitle: r.variant_title || '',
          qty: num(r.qty),
          unitPrice: num(r.unit_price),
          customerName: r.customer_name,
          phone: r.phone,
          wilayaId: numOrNull(r.wilaya_id),
          commune: r.commune,
          status: (r.status === 'open' ? 'abandoned' : r.status) as 'abandoned' | 'converted' | 'dismissed',
          auto: !!r.auto_order,
          orderId: numOrNull(r.order_id),
          orderRef: r.order_ref ?? null,
          handledBy: r.handled_name ?? null,
          utm: readJson<Record<string, string>>(r.utm),
        })),
      };
    },
  ),

  /** The customer said yes on the phone: their abandoned order becomes a real one (« Nouvelle »). */
  'landing.convertLead': proc([...WATCH], z.object({ id }), async (ctx, { id }) => {
    const a = (await ctx.db.query(`SELECT * FROM landing_leads WHERE id = $1`, [id]))[0];
    if (!a) throw notFound('Commande abandonnée introuvable');
    if (a.status === 'converted') throw bad('Déjà transformée en commande');
    const o = await convertLead(ctx, a, false);
    ctx.emit({ type: 'orders' });
    await afterChange(ctx);
    return { ok: true, orderId: o.id, ref: o.ref };
  }),

  /** Not interested / wrong number: out of the list. */
  'landing.dismissLead': proc([...WATCH], z.object({ id }), async (ctx, { id }) => {
    const r = await ctx.db.query(`UPDATE landing_leads SET status = 'dismissed', handled_by = $2, handled_at = now() WHERE id = $1 AND status IN ('open','abandoned') RETURNING id`, [id, ctx.session.profile.id]);
    if (!r.length) throw notFound('Commande abandonnée introuvable');
    await ctx.db.query(`UPDATE meta_events SET status = 'skipped', error = 'Écartée par une personne' WHERE lead_id = $1 AND status = 'queued'`, [id]);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
};
