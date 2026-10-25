// Landing pages: one public page per product, made in Pilotix (Marketing › Landing pages), and the silent fake-order
// check of what those pages receive. A blocked customer sees the same thank-you screen as everyone; the order waits
// in « Commandes bloquées » with its score and reasons, and can be restored as a real order in one click.
import { CONF_DONE_BAD, communesOf, hmacSha256Hex, isHexColor, LANDING_DEFAULT_COLOR, LandingImage, LandingRender, LandingView, landingSlug, normalizePhone, renderLanding, sha256Hex, WILAYAS, zeroBits } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { clientFee, getSetting } from '../settings';
import { FraudLevel, FraudReason, scoreOrder } from './fraud';
import { addEvent, createOrder } from './orders';

const id = z.number().int().positive();
const WHO = ['marketer'] as const;
const WATCH = ['marketer', 'confirmation'] as const;
/** proof-of-work difficulty: ~8 000 hashes on average, well under a second on a cheap phone */
export const LANDING_POW_BITS = 13;
/** a page older than this is reloaded before ordering, in practice: its challenge then counts as missing */
const CHALLENGE_TTL = 6 * 3600_000;

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
  views: number;
  orders: number;
  blocked: number;
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
const b64 = (s: string) => `data:image/webp;base64,${s}`;

async function imageRows(db: Db, refs: ImgRef[], full: boolean): Promise<Map<number, any>> {
  const ids = refs.filter((r): r is { id: number } => 'id' in r).map((r) => r.id);
  if (!ids.length) return new Map();
  const rows = await db.query(`SELECT id, w, h ${full ? ', t160, w480, w960' : ''} FROM landing_images WHERE id = ANY($1)`, [ids]);
  return new Map(rows.map((r: any) => [num(r.id), r]));
}

async function listPages(db: Db, ids?: number[]): Promise<LandingRow[]> {
  const rows = await db.query(
    `SELECT l.*, p.name AS product_name,
       (SELECT count(*)::int FROM landing_submits s WHERE s.landing_id = l.id AND s.order_id IS NOT NULL) AS n_orders,
       (SELECT count(*)::int FROM landing_blocked b WHERE b.landing_id = l.id) AS n_blocked
     FROM landing_pages l JOIN products p ON p.id = l.product_id ${ids ? 'WHERE l.id = ANY($1)' : ''} ORDER BY l.updated_at DESC`,
    ids ? [ids] : [],
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
      views: num(r.views),
      orders: num(r.n_orders),
      blocked: num(r.n_blocked),
      thumb: !f ? null : 'url' in f ? f.url : T.has(f.id) ? b64(T.get(f.id)) : null,
      updatedAt: iso(r.updated_at),
    };
  });
}

/** What a page needs from its product: price, variants, delivery prices, shop name. */
async function productContext(db: Db, productId: number) {
  const p = (await db.query('SELECT id, name, price, active, fee_grid FROM products WHERE id = $1', [productId]))[0];
  if (!p) throw notFound('Produit introuvable');
  const vars = await db.query(`SELECT id, title, active FROM product_variants WHERE product_id = $1 ORDER BY id`, [productId]);
  const variants = vars.filter((v: any) => v.active && v.title !== '').map((v: any) => ({ id: num(v.id), title: String(v.title) }));
  const plain = vars.find((v: any) => v.title === '');
  const fees: Record<number, number> = {};
  for (let w = 1; w <= 69; w++) {
    const f = await clientFee(db, w, false, p.fee_grid);
    if (f !== null) fees[w] = f;
  }
  const shop = await getSetting(db, 'shop');
  return { name: String(p.name), price: num(p.price), active: !!p.active, variants, plainVariantId: plain ? num(plain.id) : null, fees, shopName: shop.name };
}

// ---------------------------------------------------------------- challenge (signed; proves the page was served, and when)
async function secret(db: Db): Promise<string> {
  const r = (await db.query(`SELECT value FROM settings WHERE key = 'landing_secret'`))[0];
  if (r) return String(typeof r.value === 'string' ? r.value : r.value);
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
  /** where the page sends the order and reads communes (live mode) */
  post: string;
  geo: string;
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

export async function landingHtml(ctx: Ctx, slug: string, o: HtmlOpts): Promise<string> {
  const l = (await ctx.db.query('SELECT * FROM landing_pages WHERE slug = $1', [slug]))[0];
  if (!l || (!l.active && o.mode === 'live')) throw notFound('Page introuvable');
  const pc = await productContext(ctx.db, num(l.product_id));
  if (!pc.active && o.mode === 'live') throw notFound('Page introuvable');
  const refs = readImgs(l.images);
  const view: LandingView = {
    slug,
    title: l.title || pc.name,
    color: l.color,
    price: numOrNull(l.price) ?? pc.price,
    oldPrice: numOrNull(l.old_price),
    description: l.description,
    variantLabel: l.variant_label || 'اللون',
    variants: pc.variants,
    images: viewImages(refs, await imageRows(ctx.db, refs, !o.imgBase), o.imgBase),
    fees: pc.fees,
    shopName: pc.shopName,
  };
  if (o.mode === 'live') await ctx.db.query('UPDATE landing_pages SET views = views + 1 WHERE id = $1', [l.id]);
  return renderLanding(view, { mode: o.mode, post: o.post, geo: o.geo, challenge: await makeChallenge(ctx.db, slug, ctx.now()), bits: LANDING_POW_BITS });
}

/** communes of a wilaya for the page: [French name (kept on the order), Arabic name] */
export const landingCommunes = (wilayaId: number): [string, string][] => communesOf(wilayaId).map((c) => [c[1], c[2]]);

// ---------------------------------------------------------------- an order from a page
const str = (n: number) => z.any().transform((v) => (v === null || v === undefined ? '' : String(v)).slice(0, n));
const int = (d: number | null) => z.any().transform((v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? d : Math.trunc(Number(v))));

/** Everything a page sends. Lenient on purpose: a strange value is a signal for the score, not an error the sender sees. */
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
  meta: z
    .object({ ip: str(64), ua: str(500), country: str(4), city: str(80), region: str(80) })
    .partial()
    .default({}),
});

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
  const t = (ms: number) => new Date(a.now - ms).toISOString();
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

export async function submitOrder(ctx: Ctx, i: z.infer<typeof SubmitInput>): Promise<{ ok: true }> {
  const db = ctx.db;
  const l = (await db.query('SELECT * FROM landing_pages WHERE slug = $1 AND active', [i.slug]))[0];
  if (!l) throw notFound('Page introuvable');
  const productId = num(l.product_id);
  const pc = await productContext(db, productId);
  const now = ctx.now();
  const phoneRaw = arDigits(i.phone);
  const phone = /^0?[567]\d{8}$/.test(phoneRaw.replace(/[^\d+]/g, '').replace(/^(\+|00)213/, '0')) ? normalizePhone(phoneRaw) : null;
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
  // a form the page itself would never send (no wilaya, no commune, no variant when there are some): a script
  if (!wilayaId || !i.commune.trim() || (pc.variants.length && !variant)) {
    result.reasons.unshift({ code: 'form_invalid', points: 100 });
    result.score = 100;
    result.verdict = 'block';
  }
  const unitPrice = numOrNull(l.price) ?? pc.price;
  const variantId = variant?.id ?? (pc.variants.length ? null : pc.plainVariantId);
  const name = i.name.trim().replace(/\s+/g, ' ').slice(0, 120);

  let orderId: number | null = null;
  let blockedId: number | null = null;
  if (result.verdict === 'block') {
    blockedId = num(
      (
        await db.query(
          `INSERT INTO landing_blocked (landing_id, product_id, variant_id, qty, unit_price, customer_name, phone, wilaya_id, commune, score, reasons, ip, user_agent, fp, at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [l.id, productId, variantId, qty, unitPrice, name, phone ?? phoneRaw.slice(0, 20), wilayaId || null, i.commune.trim(), result.score, JSON.stringify(result.reasons), ip || null, (i.meta.ua ?? '').slice(0, 300) || null, device, new Date(now).toISOString()],
        )
      )[0].id,
    );
    ctx.emit({ type: 'orders' });
  } else {
    const review = result.verdict === 'review';
    const o = await createOrder(ctx, {
      customerName: name.length >= 2 ? name : 'Client',
      phone: phone!,
      wilayaId,
      commune: i.commune.trim(),
      address: '',
      isStopdesk: false,
      channel: 'site',
      source: `Landing · ${i.slug}`.slice(0, 120),
      items: [{ productId, variantId, qty, unitPrice }],
      discount: 0,
      confirm: false,
      isExchange: false,
      internalNote: review ? `⚠ Landing page : score anti-fraude ${result.score}/100 — ${reasonsText(result.reasons)}` : null,
    });
    orderId = o.id;
    if (review && o.confStatus === 'new') {
      await db.query(`UPDATE orders SET conf_status = 'to_check', updated_at = now() WHERE id = $1`, [o.id]);
      await addEvent(db, o.id, null, 'conf_status', 'new', 'to_check', `Score anti-fraude ${result.score}/100`);
    }
  }
  await db.query(
    `INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, challenge, verdict, score, order_id, blocked_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [l.id, productId, phone, ip || null, device, servedMs !== null ? i.ch : null, result.verdict, result.score, orderId, blockedId, new Date(now).toISOString()],
  );
  return { ok: true };
}

// ---------------------------------------------------------------- editing
const ImgInput = z.union([z.object({ id }), z.object({ url: z.string().trim().url().max(12_000), w: z.number().int().min(1).max(10000), h: z.number().int().min(1).max(10000) })]);
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
  images: z.array(ImgInput).max(12).default([]),
});

const B64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/=]+$/, 'Image invalide');

export const landingProcs = {
  'landing.list': proc([...WHO], z.object({}), (ctx) => listPages(ctx.db)),

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
    return { ...(await listPages(ctx.db, [id]))[0], images };
  }),

  /** price, variants, delivery prices and shop name of a product (the editor's preview) */
  'landing.context': proc([...WHO], z.object({ productId: id }), async (ctx, { productId }) => {
    const pc = await productContext(ctx.db, productId);
    return { name: pc.name, price: pc.price, variants: pc.variants, fees: pc.fees, shopName: pc.shopName, bits: LANDING_POW_BITS };
  }),

  'landing.freeSlug': proc([...WHO], z.object({ name: z.string().max(200), id: id.optional() }), async (ctx, i) => {
    const base = landingSlug(i.name);
    for (let k = 0; k < 100; k++) {
      const s = k ? `${base}-${k + 1}` : base;
      const r = (await ctx.db.query('SELECT id FROM landing_pages WHERE slug = $1', [s]))[0];
      if (!r || num(r.id) === i.id) return { slug: s };
    }
    return { slug: `${base}-${Date.now().toString(36)}` };
  }),

  'landing.save': proc([...WHO], PageInput, async (ctx, i) => {
    const dup = (await ctx.db.query('SELECT id FROM landing_pages WHERE slug = $1', [i.slug]))[0];
    if (dup && num(dup.id) !== i.id) throw bad(`L’adresse « ${i.slug} » est déjà prise`);
    if (!(await ctx.db.query('SELECT 1 FROM products WHERE id = $1', [i.productId])).length) throw notFound('Produit introuvable');
    const vals = [i.productId, i.slug, i.active, i.title, i.color.toLowerCase(), i.price, i.oldPrice, i.description, i.variantLabel || 'اللون', i.fraudLevel, JSON.stringify(i.images)];
    let pid: number;
    if (i.id) {
      const r = await ctx.db.query(
        `UPDATE landing_pages SET product_id=$2, slug=$3, active=$4, title=$5, color=$6, price=$7, old_price=$8, description=$9, variant_label=$10, fraud_level=$11, images=$12, updated_at=now() WHERE id=$1 RETURNING id`,
        [i.id, ...vals],
      );
      if (!r.length) throw notFound('Page introuvable');
      pid = i.id;
    } else {
      pid = num(
        (
          await ctx.db.query(
            `INSERT INTO landing_pages (product_id, slug, active, title, color, price, old_price, description, variant_label, fraud_level, images, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [...vals, ctx.session.profile.id],
          )
        )[0].id,
      );
    }
    return (await listPages(ctx.db, [pid]))[0];
  }),

  'landing.remove': proc([...WHO], z.object({ id }), async (ctx, { id }) => {
    await ctx.db.query('DELETE FROM landing_pages WHERE id = $1', [id]);
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

  /** products a page can be made for */
  'landing.products': proc([...WHO], z.object({}), async (ctx) =>
    (await ctx.db.query(`SELECT id, name, price FROM products WHERE active AND NOT is_service ORDER BY lower(name)`)).map((r: any) => ({ id: num(r.id), name: String(r.name), price: num(r.price) })),
  ),

  /** the saved page as the customer sees it, inside Pilotix (the order goes to the window around it) */
  'landing.preview': proc([...WHO], z.object({ slug: z.string().max(80) }), async (ctx, i) => ({ html: await landingHtml(ctx, i.slug, { mode: 'parent', post: '', geo: '', imgBase: null }) })),

  // ---------------------------------------------------------------- public side (the server calls these as the system)
  'landing.html': proc([], z.object({ slug: z.string().max(80), mode: z.enum(['live', 'parent', 'preview']), post: z.string().max(500).default(''), geo: z.string().max(500).default(''), imgBase: z.string().max(500).nullable().default(null) }), async (ctx, i) => ({
    html: await landingHtml(ctx, i.slug, i),
  })),

  'landing.image': proc([], z.object({ id, size: z.enum(['160', '480', '960']) }), async (ctx, i) => {
    const col = i.size === '160' ? 't160' : i.size === '480' ? 'w480' : 'w960';
    const r = (await ctx.db.query(`SELECT ${col} AS b FROM landing_images WHERE id = $1`, [i.id]))[0];
    if (!r) throw notFound('Image introuvable');
    return { base64: String(r.b) };
  }),

  'landing.submit': proc([], SubmitInput, (ctx, i) => submitOrder(ctx, i)),

  // ---------------------------------------------------------------- « Commandes bloquées »
  'landing.counts': proc([...WATCH], z.object({}), async (ctx) => {
    const r = (await ctx.db.query(`SELECT count(*) FILTER (WHERE status = 'blocked')::int AS b FROM landing_blocked`))[0];
    return { blocked: num(r?.b) };
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
          reasons: (typeof r.reasons === 'string' ? JSON.parse(r.reasons) : r.reasons) as FraudReason[],
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
    const o = await createOrder(ctx, {
      customerName: String(b.customer_name).length >= 2 ? b.customer_name : 'Client',
      phone,
      wilayaId: num(b.wilaya_id),
      commune: b.commune,
      address: '',
      isStopdesk: false,
      channel: 'site',
      source: slug ? `Landing · ${slug}` : 'Landing',
      items: [{ productId: num(b.product_id), variantId: numOrNull(b.variant_id), qty: num(b.qty), unitPrice: num(b.unit_price) }],
      discount: 0,
      confirm: false,
      isExchange: false,
      internalNote: `Restaurée depuis « Commandes bloquées » (score ${num(b.score)}/100)`,
    });
    await ctx.db.query(`UPDATE landing_blocked SET status = 'restored', order_id = $2, handled_by = $3, handled_at = now() WHERE id = $1`, [id, o.id, ctx.session.profile.id]);
    await ctx.db.query('UPDATE landing_submits SET order_id = $2 WHERE blocked_id = $1', [id, o.id]);
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
    return { ok: true };
  }),
};
