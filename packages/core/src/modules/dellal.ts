// Dellal (دلّال): the AI sales agent. It answers customers on WhatsApp, Messenger, Instagram and TikTok,
// gives prices, variants, stock and delivery fees from Pilotix itself, takes the order (→ Confirmation) and hands the
// conversation to a person when it should. The same rules run on the server (Claude through ctx.server.dellal) and in
// the browser preview (a small rule-based "demo brain" with the same tools, so the demo shows the whole flow).
import { COMMUNES, normalizePhone, SalesChannel, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { Ctx, notFound, proc } from '../rpc';
import { clientFee, getSetting } from '../settings';
import { getRaw, setRaw } from './admin';
import { createOrder } from './orders';

// ---------------------------------------------------------------- settings and secrets
export const DELLAL_CHANNELS = ['whatsapp', 'messenger', 'instagram', 'tiktok', 'test'] as const;
export type DellalChannel = (typeof DELLAL_CHANNELS)[number];
export const DELLAL_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] as const;

export interface DellalSettings {
  enabled: boolean;
  name: string;
  tone: string;
  languages: string;
  /** 'new' → Confirmation › Nouvelles (an agent still calls), 'confirmed' → straight to Dépôt */
  ordersTo: 'new' | 'confirmed';
  model: (typeof DELLAL_MODELS)[number];
  /** may Dellal give a discount (never above the product's max discount) */
  allowDiscount: boolean;
  /** one follow-up when the customer goes quiet, after N hours (0 = off) */
  followUpHours: number;
  /** answer between 23:00 and 08:00 (Algeria) */
  nightReplies: boolean;
  /** shop knowledge: warranty, sizes, FAQ… */
  notes: string;
  /** extra reasons to hand over to a person, one per line */
  handoffTopics: string;
  /** Meta webhook verify token (shown in Réglages, pasted in the Meta app) */
  verifyToken: string;
  messengerPageId: string;
  instagramId: string;
  whatsappPhoneId: string;
}

export const DEFAULT_DELLAL: DellalSettings = {
  enabled: false,
  name: 'Dellal',
  tone: 'Chaleureux et court, tutoie le client, un emoji de temps en temps.',
  languages: 'Darija algérienne, arabe, français (répond dans la langue du client)',
  ordersTo: 'new',
  model: 'claude-sonnet-5-5',
  allowDiscount: false,
  followUpHours: 3,
  nightReplies: true,
  notes: '',
  handoffTopics: 'Réclamation ou colis en retard\nAchat en gros\nLe client demande à parler à une personne',
  verifyToken: '',
  messengerPageId: '',
  instagramId: '',
  whatsappPhoneId: '',
};

/** Secret keys (never returned by any action). */
export const DELLAL_SECRETS = {
  ai: 'secret_dellal_ai_key',
  appSecret: 'secret_dellal_meta_app_secret',
  pageToken: 'secret_dellal_page_token',
  waToken: 'secret_dellal_wa_token',
  tiktokToken: 'secret_dellal_tiktok_token',
} as const;
export type DellalSecret = keyof typeof DELLAL_SECRETS;

export async function dellalSettings(db: Db): Promise<DellalSettings> {
  return { ...DEFAULT_DELLAL, ...(await getRaw<Partial<DellalSettings>>(db, 'dellal', {})) };
}
export async function dellalSecret(db: Db, k: DellalSecret): Promise<string> {
  return (await getRaw<string>(db, DELLAL_SECRETS[k], '')) || '';
}

/** Order channel for a conversation channel. */
const ORDER_CHANNEL: Record<DellalChannel, SalesChannel> = { whatsapp: 'whatsapp', messenger: 'facebook', instagram: 'instagram', tiktok: 'tiktok', test: 'autre' };

// ---------------------------------------------------------------- types for the app
export interface Conversation {
  id: number;
  channel: DellalChannel;
  externalId: string;
  customerName: string | null;
  phone: string | null;
  customerId: number | null;
  mode: 'ai' | 'human' | 'handoff';
  handoffReason: string | null;
  assignedTo: number | null;
  assignedName: string | null;
  orderId: number | null;
  orderRef: string | null;
  ordersCount: number;
  source: string | null;
  lastMessageAt: string;
  lastCustomerAt: string | null;
  lastPreview: string | null;
  unread: number;
}
export interface ConvMessage {
  id: number;
  role: 'customer' | 'agent' | 'staff' | 'tool';
  body: string;
  userName: string | null;
  meta: any;
  sendError: string | null;
  at: string;
}

const CONV_COLS = `c.*, o.ref AS order_ref, p.name AS assigned_name`;
const CONV_FROM = `FROM conversations c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN profiles p ON p.id = c.assigned_to`;
const toConv = (r: any): Conversation => ({
  id: num(r.id),
  channel: r.channel,
  externalId: r.external_id,
  customerName: r.customer_name,
  phone: r.phone,
  customerId: numOrNull(r.customer_id),
  mode: r.mode,
  handoffReason: r.handoff_reason,
  assignedTo: numOrNull(r.assigned_to),
  assignedName: r.assigned_name ?? null,
  orderId: numOrNull(r.order_id),
  orderRef: r.order_ref ?? null,
  ordersCount: num(r.orders_count),
  source: r.source,
  lastMessageAt: iso(r.last_message_at),
  lastCustomerAt: isoOrNull(r.last_customer_at),
  lastPreview: r.last_preview,
  unread: num(r.unread),
});

async function getConv(db: Db, id: number): Promise<Conversation> {
  const r = (await db.query(`SELECT ${CONV_COLS} ${CONV_FROM} WHERE c.id = $1`, [id]))[0];
  if (!r) throw notFound('Conversation introuvable');
  return toConv(r);
}

async function addMessage(db: Db, convId: number, m: { role: ConvMessage['role']; body: string; userId?: number | null; externalId?: string | null; meta?: unknown; sendError?: string | null }) {
  const r = await db.query(
    `INSERT INTO conv_messages (conversation_id, role, body, user_id, external_id, meta, send_error) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING RETURNING id`,
    [convId, m.role, m.body, m.userId ?? null, m.externalId ?? null, m.meta === undefined ? null : JSON.stringify(m.meta), m.sendError ?? null],
  );
  if (!r[0]) return null; // duplicate (same channel message delivered twice)
  if (m.role !== 'tool') {
    await db.query(
      `UPDATE conversations SET last_message_at = now(), last_preview = $2,
         last_customer_at = CASE WHEN $3 = 'customer' THEN now() ELSE last_customer_at END,
         unread = CASE WHEN $3 = 'customer' THEN unread + 1 ELSE unread END,
         followed_up = CASE WHEN $3 = 'customer' THEN false ELSE followed_up END
       WHERE id = $1`,
      [convId, m.body.slice(0, 140), m.role],
    );
  }
  return num(r[0].id);
}

// ---------------------------------------------------------------- receiving
export const IncomingInput = z.object({
  channel: z.enum(DELLAL_CHANNELS),
  externalId: z.string().min(1).max(120),
  accountId: z.string().max(120).nullable().optional(),
  name: z.string().max(120).nullable().optional(),
  text: z.string().min(1).max(4000),
  messageId: z.string().max(200).nullable().optional(),
  source: z.string().max(200).nullable().optional(),
});

/** Stores one customer message (creating the conversation the first time). Returns null for a duplicate. */
export async function receiveMessage(ctx: Ctx, m: z.infer<typeof IncomingInput>): Promise<{ conversationId: number; messageId: number } | null> {
  const phone = m.channel === 'whatsapp' ? normalizePhone(m.externalId) : null;
  const out = await ctx.db.tx(async (tx) => {
    const cust = phone ? (await tx.query('SELECT id FROM customers WHERE phone = $1', [phone]))[0] : null;
    const c = (
      await tx.query(
        `INSERT INTO conversations (channel, external_id, account_id, customer_name, phone, customer_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (channel, external_id) DO UPDATE SET
           customer_name = COALESCE(conversations.customer_name, EXCLUDED.customer_name),
           phone = COALESCE(conversations.phone, EXCLUDED.phone),
           customer_id = COALESCE(conversations.customer_id, EXCLUDED.customer_id),
           account_id = COALESCE(EXCLUDED.account_id, conversations.account_id),
           source = COALESCE(EXCLUDED.source, conversations.source)
         RETURNING id`,
        [m.channel, m.externalId, m.accountId ?? null, m.name ?? null, phone, cust?.id ?? null, m.source ?? null],
      )
    )[0];
    const id = num(c.id);
    const mid = await addMessage(tx, id, { role: 'customer', body: m.text, externalId: m.messageId ?? null });
    return mid ? { conversationId: id, messageId: mid } : null;
  });
  if (out) ctx.emit({ type: 'chat', data: { dellal: out.conversationId } });
  return out;
}

/** Algeria is UTC+1 all year. */
const algeriaHour = (t: number) => (new Date(t).getUTCHours() + 1) % 24;

/** Whether Dellal should answer this conversation now. */
export async function shouldAnswer(ctx: Ctx, convId: number): Promise<{ ok: boolean; why?: string }> {
  const s = await dellalSettings(ctx.db);
  const c = await getConv(ctx.db, convId);
  if (c.channel === 'test') return { ok: true };
  if (!s.enabled) return { ok: false, why: 'Dellal est désactivé' };
  if (c.mode !== 'ai') return { ok: false, why: 'Une personne a repris la conversation' };
  const h = algeriaHour(ctx.now());
  if (!s.nightReplies && (h >= 23 || h < 8)) return { ok: false, why: 'Pas de réponse la nuit' };
  return { ok: true };
}

// ---------------------------------------------------------------- what Dellal knows
const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[''`]/g, ' ')
    .trim();

/** Finds a wilaya by code or name (French or Arabic), or by one of its communes. */
export function findPlace(text: string): { wilayaId: number; wilaya: string; commune: string | null } | null {
  const t = strip(String(text ?? ''));
  if (!t) return null;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= WILAYAS.length) return { wilayaId: n, wilaya: WILAYAS[n - 1], commune: null };
  // longest names first, so "Bordj Bou Arréridj" wins over shorter matches
  const ws = WILAYAS.map((w, i) => ({ id: i + 1, w, k: strip(w) })).sort((a, b) => b.k.length - a.k.length);
  for (const w of ws) if (new RegExp(`(^|[^a-z])${w.k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(t)) return { wilayaId: w.id, wilaya: w.w, commune: null };
  const cs = COMMUNES.map(([wid, fr, ar]) => ({ wid, fr, ar, k: strip(fr) })).filter((c) => c.k.length >= 4).sort((a, b) => b.k.length - a.k.length);
  for (const c of cs) {
    const re = new RegExp(`(^|[^a-z])${c.k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`);
    if (re.test(t) || (c.ar && text.includes(c.ar))) return { wilayaId: c.wid, wilaya: WILAYAS[c.wid - 1], commune: c.fr };
  }
  return null;
}

interface ProductInfo {
  product_id: number;
  name: string;
  price: number;
  max_discount: number | null;
  photo: string | null;
  variants: { variant_id: number; title: string; price: number; available: number }[];
}

/** Active products with their variants and what is really available (stock − promised to confirmed orders). */
export async function searchProducts(db: Db, query?: string | null, limit = 8): Promise<ProductInfo[]> {
  const words = strip(query ?? '')
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((w) => w.length >= 3);
  const prods = await db.query(`SELECT id, name, price, max_discount, photo FROM products WHERE active AND NOT is_service ORDER BY lower(name)`);
  const scored = prods
    .map((p: any) => {
      const k = strip(p.name);
      const score = words.length ? words.filter((w) => k.includes(w) || (w.length >= 4 && k.split(' ').some((x) => x.startsWith(w.slice(0, 4))))).length : 1;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (!scored.length) return [];
  const ids = scored.map((x) => num(x.p.id));
  const vars = await db.query(
    `WITH r AS (
       SELECT i.variant_id, sum(i.qty)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE i.variant_id IS NOT NULL AND o.conf_status IN ('confirmed','no_stock') AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared'))
       GROUP BY 1)
     SELECT v.id, v.product_id, v.title, v.price, COALESCE((SELECT sum(s.qty) FROM stock s WHERE s.variant_id = v.id), 0)::int - COALESCE(r.n, 0) AS available
     FROM product_variants v LEFT JOIN r ON r.variant_id = v.id
     WHERE v.product_id = ANY($1) AND v.active ORDER BY v.id`,
    [ids],
  );
  return scored.map(({ p }) => ({
    product_id: num(p.id),
    name: p.name,
    price: num(p.price),
    max_discount: numOrNull(p.max_discount),
    photo: p.photo ?? null,
    variants: vars
      .filter((v: any) => num(v.product_id) === num(p.id))
      .map((v: any) => ({ variant_id: num(v.id), title: v.title ?? '', price: v.price === null ? num(p.price) : num(v.price), available: Math.max(0, num(v.available)) })),
  }));
}

async function deliveryFee(db: Db, input: { wilaya?: string | number; commune?: string; stopdesk?: boolean }) {
  const place = findPlace(String(input.wilaya ?? '')) ?? (input.commune ? findPlace(input.commune) : null);
  if (!place) return { error: 'Wilaya introuvable : demande la wilaya au client (nom ou numéro).' };
  const home = await clientFee(db, place.wilayaId, false);
  const desk = await clientFee(db, place.wilayaId, true);
  if (home === null && desk === null) return { wilaya_id: place.wilayaId, wilaya: place.wilaya, error: 'Pas de livraison configurée pour cette wilaya : passe la main à l’équipe.' };
  return { wilaya_id: place.wilayaId, wilaya: place.wilaya, commune: place.commune, home_delivery: home, stopdesk: desk, note: 'Paiement à la livraison. Frais en DA.' };
}

async function customerSummary(db: Db, phone: string | null) {
  if (!phone) return null;
  const c = (await db.query('SELECT id, name, wilaya_id, orders, delivered, returned, blacklisted FROM customers WHERE phone = $1', [phone]))[0];
  if (!c) return null;
  return { name: c.name, wilayaId: numOrNull(c.wilaya_id), orders: num(c.orders), delivered: num(c.delivered), returned: num(c.returned), blacklisted: !!c.blacklisted };
}

// ---------------------------------------------------------------- the agent: tools
export const DELLAL_TOOLS = [
  {
    name: 'search_products',
    description: 'Cherche des produits du catalogue (nom, prix, variantes avec la quantité disponible). Sans query : tout le catalogue actif.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'mots du produit, ex. "vélo 16"' } } },
  },
  {
    name: 'delivery_fee',
    description: 'Frais de livraison pour une wilaya (nom, numéro) ou une commune : à domicile et au bureau (stop desk).',
    input_schema: { type: 'object', properties: { wilaya: { type: 'string' }, commune: { type: 'string' } } },
  },
  {
    name: 'create_order',
    description:
      'Crée la commande (paiement à la livraison) quand le client a donné nom, téléphone, wilaya, commune, le produit (et la variante) et domicile ou bureau. Récapitule et fais confirmer AVANT d’appeler.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        wilaya: { type: 'string', description: 'nom ou numéro de la wilaya' },
        commune: { type: 'string' },
        address: { type: 'string' },
        stopdesk: { type: 'boolean', description: 'true = retrait au bureau du transporteur' },
        items: {
          type: 'array',
          items: { type: 'object', properties: { product_id: { type: 'integer' }, variant_id: { type: 'integer' }, qty: { type: 'integer' } }, required: ['product_id', 'qty'] },
        },
        discount: { type: 'integer', description: 'remise totale en DA (seulement si autorisée)' },
        note: { type: 'string', description: 'demande du client (heure de livraison…)' },
      },
      required: ['customer_name', 'phone', 'wilaya', 'commune', 'items'],
    },
  },
  {
    name: 'handoff',
    description: 'Passe la conversation à une personne de l’équipe et arrête de répondre. Utilise-le pour les cas listés ou quand tu n’es pas sûr.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
] as const;

interface ToolCtx {
  ctx: Ctx;
  conv: Conversation;
  settings: DellalSettings;
  test: boolean;
}

async function execTool(t: ToolCtx, name: string, input: any): Promise<any> {
  const { ctx, conv, settings } = t;
  if (name === 'search_products') return { products: await searchProducts(ctx.db, input?.query) };
  if (name === 'delivery_fee') return deliveryFee(ctx.db, input ?? {});
  if (name === 'handoff') {
    const reason = String(input?.reason ?? 'À reprendre').slice(0, 300);
    if (!t.test) await ctx.db.query(`UPDATE conversations SET mode = 'handoff', handoff_reason = $2 WHERE id = $1`, [conv.id, reason]);
    return { ok: true, note: 'Une personne de l’équipe va reprendre. Dis-le au client en une phrase.' };
  }
  if (name === 'create_order') {
    const phone = normalizePhone(String(input?.phone ?? ''));
    if (!phone) return { error: 'Numéro invalide : demande un numéro algérien (05, 06 ou 07…).' };
    const place = findPlace(String(input?.wilaya ?? '')) ?? findPlace(String(input?.commune ?? ''));
    if (!place) return { error: 'Wilaya introuvable : redemande la wilaya.' };
    const items = (Array.isArray(input?.items) ? input.items : []).map((i: any) => ({ productId: Number(i.product_id), variantId: i.variant_id ? Number(i.variant_id) : null, qty: Math.max(1, Math.min(99, Number(i.qty) || 1)) }));
    if (!items.length) return { error: 'Aucun produit dans la commande.' };
    // never sell what the depot does not have
    for (const it of items) {
      const vars = await ctx.db.query('SELECT id, title FROM product_variants WHERE product_id = $1 AND active ORDER BY id', [it.productId]);
      if (!vars.length) return { error: `Produit ${it.productId} introuvable.` };
      if (!it.variantId) {
        if (vars.length > 1) return { error: 'Plusieurs variantes : demande au client laquelle (couleur, taille…).' };
        it.variantId = num(vars[0].id);
      }
      const p = (await searchProducts(ctx.db, null, 1000)).find((x) => x.product_id === it.productId);
      const v = p?.variants.find((x) => x.variant_id === it.variantId);
      if (!p || !v) return { error: 'Variante introuvable ou inactive.' };
      if (v.available < it.qty) return { error: `Plus assez de stock pour ${p.name} ${v.title} (disponible : ${v.available}). Propose une autre variante.` };
    }
    const discount = settings.allowDiscount ? Math.max(0, Math.round(Number(input?.discount) || 0)) : 0;
    const name = String(input?.customer_name ?? '').trim().slice(0, 120) || conv.customerName || 'Client';
    if (t.test) {
      const ps = await searchProducts(ctx.db, null, 1000);
      const sub = items.reduce((s: number, i: any) => s + (ps.find((p) => p.product_id === i.productId)?.variants.find((v) => v.variant_id === i.variantId)?.price ?? 0) * i.qty, 0);
      const fee = (await clientFee(ctx.db, place.wilayaId, !!input?.stopdesk)) ?? 0;
      return { ok: true, test: true, ref: 'TEST', total: sub - discount + fee, delivery_fee: fee, note: 'Mode test : aucune vraie commande créée.' };
    }
    try {
      const o = await createOrder(ctx, {
        customerName: name,
        phone,
        wilayaId: place.wilayaId,
        commune: String(input?.commune ?? place.commune ?? '').slice(0, 120),
        address: String(input?.address ?? '').slice(0, 300),
        isStopdesk: !!input?.stopdesk,
        channel: ORDER_CHANNEL[conv.channel],
        source: `${settings.name} · ${conv.channel}${conv.source ? ` · ${conv.source}` : ''}`.slice(0, 120),
        items,
        discount,
        customerNote: input?.note ? String(input.note).slice(0, 1000) : null,
        internalNote: `Commande prise par ${settings.name} (conversation #${conv.id})`,
        confirm: settings.ordersTo === 'confirmed',
        isExchange: false,
      });
      await ctx.db.query('UPDATE orders SET conversation_id = $2 WHERE id = $1', [o.id, conv.id]);
      await ctx.db.query(
        `UPDATE conversations SET order_id = $2, orders_count = orders_count + 1, phone = COALESCE(phone, $3), customer_name = COALESCE(customer_name, $4),
           customer_id = COALESCE(customer_id, (SELECT id FROM customers WHERE phone = $3)) WHERE id = $1`,
        [conv.id, o.id, phone, name],
      );
      return { ok: true, ref: o.ref, total: o.total, delivery_fee: o.deliveryFee, next: settings.ordersTo === 'new' ? 'Un conseiller va appeler pour confirmer.' : 'La commande part en préparation.' };
    } catch (e: any) {
      return { error: e?.message ?? 'Commande refusée' };
    }
  }
  return { error: `Outil inconnu : ${name}` };
}

// ---------------------------------------------------------------- the agent: prompt and loop
async function systemPrompt(ctx: Ctx, conv: Conversation, s: DellalSettings, followUp: boolean) {
  const shop = await getSetting(ctx.db, 'shop');
  const catalog = (await searchProducts(ctx.db, null, 40)).map((p) => `- #${p.product_id} ${p.name} : ${p.price} DA${p.variants.length > 1 ? ` (${p.variants.map((v) => v.title).filter(Boolean).join(', ')})` : ''}`).join('\n');
  const cust = await customerSummary(ctx.db, conv.phone);
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  return [
    `Tu es ${s.name}, le vendeur de la boutique « ${shop.name} » en Algérie. Tu réponds aux clients sur ${conv.channel === 'test' ? 'une conversation de test' : conv.channel}. Date : ${today}.`,
    `Ton : ${s.tone}`,
    `Langues : ${s.languages}. Réponds toujours dans la langue et le style du client (darija en lettres latines si le client écrit ainsi).`,
    `Règles :`,
    `- Messages courts (2 à 4 phrases), comme une vraie discussion WhatsApp. Pas de listes longues.`,
    `- N'invente jamais un produit, un prix, une couleur, un stock ou un délai : utilise les outils search_products et delivery_fee.`,
    `- Ne vends jamais une variante dont la quantité disponible est 0 : propose une autre variante.`,
    `- Paiement à la livraison (COD) partout. Le client peut choisir domicile ou bureau (stop desk) si le prix existe.`,
    `- Pour commander il faut : nom, téléphone, wilaya, commune, produit + variante + quantité, domicile ou bureau. Demande ce qui manque, une chose à la fois.`,
    `- Avant create_order, récapitule (produit, prix, livraison, total) et attends un « oui ». Après, donne la référence et dis ${s.ordersTo === 'new' ? 'qu’un conseiller va appeler pour confirmer' : 'que la commande part en préparation'}.`,
    s.allowDiscount ? `- Tu peux accorder une petite remise seulement si le client insiste, jamais au-dessus de max_discount du produit.` : `- Pas de remise : les prix sont fixes.`,
    `- Appelle handoff (puis préviens le client en une phrase) dans ces cas :\n${s.handoffTopics
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => `  • ${x}`)
      .join('\n')}\n  • tu ne sais pas répondre ou le client est fâché`,
    s.notes.trim() ? `Informations de la boutique :\n${s.notes.trim()}` : '',
    `Catalogue (résumé, vérifie le stock avec search_products) :\n${catalog || '(vide)'}`,
    cust ? `Client connu : ${cust.name}, ${cust.orders} commande(s), ${cust.delivered} livrée(s), ${cust.returned} retour(s)${cust.blacklisted ? ', SUR LISTE NOIRE : ne prends pas de commande, passe la main' : ''}.` : '',
    followUp ? `Le client ne répond plus depuis un moment : envoie UNE relance courte et aimable, sans insister.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

type AiMsg = { role: 'user' | 'assistant'; content: any };

/** The conversation as the AI sees it: customer = user, Dellal and staff = assistant (merged, starting with the user). */
async function history(db: Db, convId: number): Promise<AiMsg[]> {
  const rows = (await db.query(`SELECT role, body FROM conv_messages WHERE conversation_id = $1 AND role <> 'tool' ORDER BY id DESC LIMIT 40`, [convId])).reverse();
  const out: AiMsg[] = [];
  for (const r of rows) {
    const role = r.role === 'customer' ? 'user' : 'assistant';
    const text = r.role === 'staff' ? `[équipe] ${r.body}` : r.body;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

export interface AiRequest {
  model: string;
  system: string;
  messages: AiMsg[];
  tools: typeof DELLAL_TOOLS;
  max_tokens: number;
}
export interface AiResponse {
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: any })[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
  demo?: boolean;
}

/** Runs Dellal on a conversation: reads it, uses its tools, writes (and sends) its answer. */
export async function runAgent(ctx: Ctx, convId: number, opts: { followUp?: boolean } = {}): Promise<{ reply: string | null; handoff: boolean; orderRef: string | null; demo: boolean; skipped?: string }> {
  const check = await shouldAnswer(ctx, convId);
  if (!check.ok) return { reply: null, handoff: false, orderRef: null, demo: false, skipped: check.why };
  const s = await dellalSettings(ctx.db);
  let conv = await getConv(ctx.db, convId);
  const test = conv.channel === 'test';
  const messages = await history(ctx.db, convId);
  if (opts.followUp) messages.push({ role: 'user', content: '(Note système : le client n’a pas répondu. Envoie une seule relance courte.)' });
  if (!messages.length) return { reply: null, handoff: false, orderRef: null, demo: false, skipped: 'Aucun message' };
  const system = await systemPrompt(ctx, conv, s, !!opts.followUp);
  const useAi = !!ctx.server?.dellal && !!(await dellalSecret(ctx.db, 'ai'));
  const complete = (req: AiRequest): Promise<AiResponse> => (useAi ? (ctx.server!.dellal!('complete', req, ctx) as Promise<AiResponse>) : demoBrain(ctx, req));

  const texts: string[] = [];
  let handoff = false;
  let orderRef: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (let round = 0; round < 6; round++) {
    const res = await complete({ model: s.model, system, messages, tools: DELLAL_TOOLS, max_tokens: 1024 });
    usage = { input_tokens: usage.input_tokens + num(res.usage?.input_tokens), output_tokens: usage.output_tokens + num(res.usage?.output_tokens) };
    const uses = res.content.filter((b): b is Extract<AiResponse['content'][number], { type: 'tool_use' }> => b.type === 'tool_use');
    for (const b of res.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
    if (!uses.length || res.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: res.content });
    const results: any[] = [];
    for (const u of uses) {
      const out = await execTool({ ctx, conv, settings: s, test }, u.name, u.input);
      if (u.name === 'handoff') handoff = true;
      if (u.name === 'create_order' && out?.ok) orderRef = out.ref;
      await addMessage(ctx.db, convId, { role: 'tool', body: toolLine(u.name, u.input, out), meta: { tool: u.name, input: u.input, result: out } });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12_000), is_error: !!out?.error });
    }
    messages.push({ role: 'user', content: results });
    texts.length = 0; // only the text after the last tool round is sent
    conv = await getConv(ctx.db, convId);
  }
  const reply = texts.join('\n\n').trim() || null;
  if (reply) {
    let sendError: string | null = null;
    if (!test && ctx.server?.dellal) {
      try {
        await ctx.server.dellal('send', { conversationId: convId, channel: conv.channel, externalId: conv.externalId, accountId: (await rawConv(ctx.db, convId)).account_id, text: reply }, ctx);
      } catch (e: any) {
        sendError = e?.message ?? 'Envoi impossible';
      }
    }
    await addMessage(ctx.db, convId, { role: 'agent', body: reply, meta: { usage, demo: !useAi, model: useAi ? s.model : null }, sendError });
  }
  if (opts.followUp) await ctx.db.query('UPDATE conversations SET followed_up = true WHERE id = $1', [convId]);
  ctx.emit({ type: 'chat', data: { dellal: convId } });
  return { reply, handoff, orderRef, demo: !useAi };
}

const rawConv = async (db: Db, id: number) => (await db.query('SELECT * FROM conversations WHERE id = $1', [id]))[0];

function toolLine(name: string, input: any, out: any): string {
  if (out?.error) return `${name} → ${out.error}`;
  if (name === 'search_products') return `search_products "${input?.query ?? ''}" → ${(out?.products ?? []).length} produit(s)`;
  if (name === 'delivery_fee') return `delivery_fee ${out?.wilaya ?? ''} → domicile ${out?.home_delivery ?? '—'} DA · bureau ${out?.stopdesk ?? '—'} DA`;
  if (name === 'create_order') return `create_order → ${out?.ref} · ${out?.total} DA`;
  if (name === 'handoff') return `handoff → ${input?.reason ?? ''}`;
  return name;
}

// ---------------------------------------------------------------- demo brain (preview / no AI key)
const PHONE_RE = /(?:\+?213|0)\s?[5-7](?:[\s.-]?\d){8}/;
const HANDOFF_RE = /(gros|grossiste|wholesale|r[ée]clamation|retard|arnaque|rembours|humain|conseill|responsable|parler [àa] quelqu|محتال|بالجملة)/i;
const YES_RE = /^(oui|wah|ih|ok|okey|d'accord|daccord|yes|نعم|واه|صح|c bon|c'est bon|mriguel|sah)\b/i;

/** A small rule-based seller with the same tools, for the demo and for testing without an AI key. */
async function demoBrain(ctx: Ctx, req: AiRequest): Promise<AiResponse> {
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  const say = (text: string): AiResponse => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', demo: true });
  const use = (name: string, input: any): AiResponse => ({ content: [{ type: 'tool_use', id: `demo_${Date.now()}_${name}`, name, input }], stop_reason: 'tool_use', demo: true });

  // after a tool: turn its result into words
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    const prev = msgs[msgs.length - 2].content as any[];
    const tool = prev.find((b) => b.type === 'tool_use');
    const out = JSON.parse(last.content[0].content);
    if (out.error) return say(String(out.error));
    if (tool.name === 'handoff') return say('Je passe ta demande à un conseiller de l’équipe, il te répond très vite 🙏');
    if (tool.name === 'create_order') return say(`C'est noté ✅ Commande ${out.ref} : total ${out.total} DA (livraison ${out.delivery_fee} DA comprise), paiement à la livraison. ${out.next ?? out.note ?? ''}`.trim());
    if (tool.name === 'delivery_fee') {
      if (out.home_delivery === null && out.stopdesk === null) return say(`Pour ${out.wilaya}, je vérifie avec l’équipe.`);
      return say(`Livraison à ${out.commune ? `${out.commune} (${out.wilaya})` : out.wilaya} : ${out.home_delivery ?? '—'} DA à domicile${out.stopdesk ? `, ${out.stopdesk} DA au bureau` : ''}. Paiement à la livraison. Pour réserver, envoie-moi ton nom, ton numéro et ta commune.`);
    }
    if (tool.name === 'search_products') {
      const p = out.products?.[0];
      if (!p) return say('Je n’ai pas trouvé ce produit. Tu cherches quoi exactement ?');
      const avail = p.variants.filter((v: any) => v.available > 0);
      const vs = avail.map((v: any) => v.title).filter(Boolean);
      if (!avail.length) return say(`${p.name} est en rupture pour le moment 😕 Je peux te proposer autre chose ?`);
      return say(`${p.name} est à ${p.price} DA${vs.length ? `, disponible en ${vs.join(', ')}` : ', disponible'}. Tu es de quelle wilaya ? Je te donne le prix de la livraison.`);
    }
  }

  const text = typeof last.content === 'string' ? last.content : '';
  const all = msgs.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string).join('\n');
  if (text.includes('Note système')) return say('Salam 👋 Tu es toujours intéressé(e) ? Je peux te réserver ta commande en une minute.');
  if (HANDOFF_RE.test(text)) return use('handoff', { reason: text.slice(0, 120) });

  // which product was talked about (latest mention wins)
  const products = await searchProducts(ctx.db, null, 1000);
  let product: ProductInfo | null = null;
  for (const line of all.split('\n')) {
    const hits = await searchProducts(ctx.db, line, 1);
    if (hits[0] && strip(line).split(/\s+/).some((w) => w.length >= 4 && strip(hits[0].name).includes(w))) product = hits[0];
  }
  const variant = product ? product.variants.find((v) => v.title && strip(all).includes(strip(v.title))) ?? (product.variants.length === 1 ? product.variants[0] : null) : null;
  const phone = all.match(PHONE_RE)?.[0] ?? null;
  const place = findPlace(all.split('\n').reverse().find((l) => findPlace(l)) ?? '');
  const confirmed = YES_RE.test(strip(text));

  if (product && variant && phone && place) {
    const ph = normalizePhone(phone);
    const before = all.slice(0, all.indexOf(phone)).split('\n').pop() ?? '';
    const name = before.replace(/[^a-zA-Z؀-ۿ\s'-]/g, ' ').trim().split(/\s+/).slice(-2).join(' ') || 'Client';
    const recapped = msgs.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('Je confirme ?'));
    if (!recapped || !confirmed) {
      const fee = (await clientFee(ctx.db, place.wilayaId, /bureau|stop ?desk/i.test(all))) ?? 0;
      return say(`Récap : ${product.name}${variant.title ? ` ${variant.title}` : ''} à ${variant.price} DA + livraison ${fee} DA à ${place.commune ?? place.wilaya} = ${variant.price + fee} DA, au nom de ${name} (${ph}). Je confirme ?`);
    }
    return use('create_order', { customer_name: name, phone: ph, wilaya: String(place.wilayaId), commune: place.commune ?? place.wilaya, stopdesk: /bureau|stop ?desk/i.test(all), items: [{ product_id: product.product_id, variant_id: variant.variant_id, qty: 1 }] });
  }
  if (place && !msgs.some((m) => Array.isArray(m.content)) && /livraison|tawsil|ch7al|combien|prix|التوصيل/i.test(text)) return use('delivery_fee', { wilaya: String(place.wilayaId), commune: place.commune ?? undefined });
  if (product && !variant && product.variants.length > 1) {
    const avail = product.variants.filter((v) => v.available > 0).map((v) => v.title);
    if (strip(text).split(/\s+/).some((w) => w.length >= 4 && strip(product!.name).includes(w))) return use('search_products', { query: product.name });
    return say(`Quelle variante tu veux ? ${avail.join(', ')}.`);
  }
  if (product && strip(text).split(/\s+/).some((w) => w.length >= 4 && strip(product!.name).includes(w))) return use('search_products', { query: product.name });
  if (place && product) return use('delivery_fee', { wilaya: String(place.wilayaId), commune: place.commune ?? undefined });
  if (product && variant && !phone) return say('Parfait 👍 Pour réserver, envoie-moi ton nom, ton numéro de téléphone et ta commune.');
  if (/^(salam|slm|bonjour|bonsoir|cc|coucou|hi|hello|السلام|سلام)/i.test(strip(text)))
    return say(`Wa alikoum salam 👋 Bienvenue ! Tu cherches quoi ? Par exemple : ${products.slice(0, 3).map((p) => p.name).join(', ')}.`);
  return say(`Je peux t’aider à choisir 😊 Nos produits : ${products.slice(0, 4).map((p) => `${p.name} (${p.price} DA)`).join(', ')}. Lequel t’intéresse ?`);
}

// ---------------------------------------------------------------- follow-ups
/** One short follow-up for conversations where Dellal spoke last and the customer went quiet (inside the 24 h window). */
export async function runFollowUps(ctx: Ctx): Promise<{ sent: number }> {
  const s = await dellalSettings(ctx.db);
  if (!s.enabled || !s.followUpHours) return { sent: 0 };
  const rows = await ctx.db.query(
    `SELECT c.id FROM conversations c
     WHERE c.mode = 'ai' AND c.channel <> 'test' AND NOT c.followed_up AND c.order_id IS NULL
       AND c.last_customer_at > now() - interval '23 hours'
       AND c.last_message_at < now() - make_interval(hours => $1)
       AND (SELECT role FROM conv_messages m WHERE m.conversation_id = c.id AND m.role <> 'tool' ORDER BY id DESC LIMIT 1) = 'agent'
     LIMIT 50`,
    [s.followUpHours],
  );
  let sent = 0;
  for (const r of rows) {
    const out = await runAgent(ctx, num(r.id), { followUp: true }).catch(() => null);
    if (out?.reply) sent++;
  }
  return { sent };
}

// ---------------------------------------------------------------- actions
const id = z.number().int().positive();
const SELLERS = ['confirmation'] as const;
const me = (ctx: Ctx) => ctx.session.profile.id;

async function messagesOf(db: Db, convId: number): Promise<ConvMessage[]> {
  const rows = await db.query(
    `SELECT m.*, p.name AS user_name FROM conv_messages m LEFT JOIN profiles p ON p.id = m.user_id WHERE m.conversation_id = $1 ORDER BY m.id DESC LIMIT 300`,
    [convId],
  );
  return rows.reverse().map((r: any) => ({ id: num(r.id), role: r.role, body: r.body, userName: r.user_name ?? null, meta: r.meta ?? null, sendError: r.send_error ?? null, at: iso(r.created_at) }));
}

const SettingsInput = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(2).max(40),
  tone: z.string().max(400),
  languages: z.string().max(200),
  ordersTo: z.enum(['new', 'confirmed']),
  model: z.enum(DELLAL_MODELS),
  allowDiscount: z.boolean(),
  followUpHours: z.number().int().min(0).max(22),
  nightReplies: z.boolean(),
  notes: z.string().max(6000),
  handoffTopics: z.string().max(2000),
  messengerPageId: z.string().trim().max(40).regex(/^\d*$/, 'ID de page (chiffres)'),
  instagramId: z.string().trim().max(40).regex(/^\d*$/, 'ID Instagram (chiffres)'),
  whatsappPhoneId: z.string().trim().max(40).regex(/^\d*$/, 'ID du numéro WhatsApp (chiffres)'),
  /** secrets: a value replaces, '' keeps, null removes */
  secrets: z.record(z.enum(['ai', 'appSecret', 'pageToken', 'waToken', 'tiktokToken']), z.string().max(2000).nullable()).default({}),
});

async function settingsView(db: Db) {
  const s = await dellalSettings(db);
  const has: Record<DellalSecret, boolean> = { ai: false, appSecret: false, pageToken: false, waToken: false, tiktokToken: false };
  for (const k of Object.keys(DELLAL_SECRETS) as DellalSecret[]) has[k] = !!(await dellalSecret(db, k));
  return { settings: s, has, models: DELLAL_MODELS };
}

export const dellalProcs = {
  /** The inbox: conversations of every channel, newest first, with the counts of the tabs. */
  'dellal.inbox': proc(
    [...SELLERS],
    z.object({ tab: z.enum(['all', 'handoff', 'ai', 'orders']).default('all'), channel: z.enum(DELLAL_CHANNELS).optional(), q: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).default(80) }),
    async (ctx, i) => {
      const w: string[] = [`c.channel <> 'test'`];
      const p: unknown[] = [];
      if (i.channel) w.push(`c.channel = $${p.push(i.channel)}`);
      if (i.q?.trim()) w.push(`(c.customer_name ILIKE '%' || $${p.push(i.q.trim())} || '%' OR c.phone LIKE '%' || $${p.length} || '%' OR c.last_preview ILIKE '%' || $${p.length} || '%')`);
      const tabW = i.tab === 'handoff' ? `c.mode = 'handoff'` : i.tab === 'ai' ? `c.mode = 'ai'` : i.tab === 'orders' ? `c.order_id IS NOT NULL` : 'true';
      const rows = await ctx.db.query(`SELECT ${CONV_COLS} ${CONV_FROM} WHERE ${[...w, tabW].join(' AND ')} ORDER BY c.last_message_at DESC LIMIT ${i.limit}`, p);
      const k = (await ctx.db.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE mode = 'handoff')::int AS handoff, count(*) FILTER (WHERE mode = 'ai')::int AS ai,
                count(*) FILTER (WHERE order_id IS NOT NULL)::int AS orders, COALESCE(sum(unread), 0)::int AS unread
         FROM conversations WHERE channel <> 'test'`,
      ))[0];
      const s = await dellalSettings(ctx.db);
      return { rows: rows.map(toConv), counts: { all: num(k.total), handoff: num(k.handoff), ai: num(k.ai), orders: num(k.orders), unread: num(k.unread) }, enabled: s.enabled, name: s.name };
    },
  ),

  /** One conversation with its messages and what we know about the customer (opening it marks it read). */
  'dellal.conversation': proc([...SELLERS], z.object({ id }), async (ctx, { id }) => {
    const conv = await getConv(ctx.db, id);
    if (conv.unread) await ctx.db.query('UPDATE conversations SET unread = 0 WHERE id = $1', [id]);
    const orders = conv.phone
      ? await ctx.db.query(`SELECT id, ref, total, conf_status, follow_status, created_at FROM orders WHERE phone = $1 ORDER BY id DESC LIMIT 5`, [conv.phone])
      : conv.orderId
        ? await ctx.db.query(`SELECT id, ref, total, conf_status, follow_status, created_at FROM orders WHERE id = $1`, [conv.orderId])
        : [];
    return {
      conversation: { ...conv, unread: 0 },
      messages: await messagesOf(ctx.db, id),
      customer: await customerSummary(ctx.db, conv.phone),
      orders: orders.map((o: any) => ({ id: num(o.id), ref: o.ref, total: num(o.total), confStatus: o.conf_status, followStatus: o.follow_status, at: iso(o.created_at) })),
    };
  }),

  /** A person writes to the customer: Dellal pauses on this conversation. */
  'dellal.reply': proc([...SELLERS], z.object({ id, body: z.string().trim().min(1).max(2000) }), async (ctx, i) => {
    const conv = await getConv(ctx.db, i.id);
    let sendError: string | null = null;
    if (conv.channel !== 'test' && ctx.server?.dellal) {
      try {
        await ctx.server.dellal('send', { conversationId: conv.id, channel: conv.channel, externalId: conv.externalId, accountId: (await rawConv(ctx.db, conv.id)).account_id, text: i.body }, ctx);
      } catch (e: any) {
        sendError = e?.message ?? 'Envoi impossible';
      }
    }
    await addMessage(ctx.db, conv.id, { role: 'staff', body: i.body, userId: me(ctx), sendError });
    await ctx.db.query(`UPDATE conversations SET mode = 'human', assigned_to = $2, unread = 0 WHERE id = $1`, [conv.id, me(ctx)]);
    ctx.emit({ type: 'chat', data: { dellal: conv.id } });
    return { ok: !sendError, sendError };
  }),

  /** Take over (human) or give the conversation back to Dellal (ai: it answers the last customer message if needed). */
  'dellal.setMode': proc([...SELLERS], z.object({ id, mode: z.enum(['ai', 'human']) }), async (ctx, i) => {
    await getConv(ctx.db, i.id);
    await ctx.db.query(`UPDATE conversations SET mode = $2, assigned_to = CASE WHEN $2 = 'human' THEN $3::bigint ELSE NULL END, handoff_reason = CASE WHEN $2 = 'ai' THEN NULL ELSE handoff_reason END WHERE id = $1`, [i.id, i.mode, me(ctx)]);
    let answered = false;
    if (i.mode === 'ai') {
      const lastRole = (await ctx.db.query(`SELECT role FROM conv_messages WHERE conversation_id = $1 AND role <> 'tool' ORDER BY id DESC LIMIT 1`, [i.id]))[0]?.role;
      if (lastRole === 'customer') answered = !!(await runAgent(ctx, i.id)).reply;
    }
    ctx.emit({ type: 'chat', data: { dellal: i.id } });
    return { ok: true, answered };
  }),

  /** "Tester Dellal": talk to Dellal as a customer. Orders are only simulated. */
  'dellal.test': proc([...SELLERS], z.object({ body: z.string().trim().max(2000).default(''), reset: z.boolean().default(false) }), async (ctx, i) => {
    const ext = `test-${me(ctx)}`;
    let c = (await ctx.db.query(`SELECT id FROM conversations WHERE channel = 'test' AND external_id = $1`, [ext]))[0];
    if (!c) c = (await ctx.db.query(`INSERT INTO conversations (channel, external_id, customer_name, created_by) VALUES ('test',$1,$2,$3) RETURNING id`, [ext, ctx.session.profile.name, me(ctx)]))[0];
    const cid = num(c.id);
    if (i.reset) await ctx.db.query('DELETE FROM conv_messages WHERE conversation_id = $1', [cid]);
    let out: Awaited<ReturnType<typeof runAgent>> | null = null;
    if (i.body) {
      await addMessage(ctx.db, cid, { role: 'customer', body: i.body });
      out = await runAgent(ctx, cid);
    }
    return { conversationId: cid, messages: await messagesOf(ctx.db, cid), demo: out ? out.demo : !(ctx.server?.dellal && (await dellalSecret(ctx.db, 'ai'))) };
  }),

  /** Dellal's results over the last N days. */
  'dellal.stats': proc([...SELLERS], z.object({ days: z.number().int().min(1).max(365).default(7) }), async (ctx, i) => {
    const k = (await ctx.db.query(
      `SELECT count(*)::int AS conversations,
              count(*) FILTER (WHERE mode = 'handoff' OR mode = 'human')::int AS handed
       FROM conversations WHERE channel <> 'test' AND created_at > now() - make_interval(days => $1)`,
      [i.days],
    ))[0];
    const o = (await ctx.db.query(
      `SELECT count(*)::int AS orders, count(*) FILTER (WHERE follow_status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE conf_status = 'confirmed')::int AS confirmed, COALESCE(sum(total), 0)::bigint AS amount
       FROM orders WHERE conversation_id IS NOT NULL AND created_at > now() - make_interval(days => $1)`,
      [i.days],
    ))[0];
    const msgs = (await ctx.db.query(
      `SELECT count(*) FILTER (WHERE role = 'agent')::int AS agent, count(*) FILTER (WHERE role = 'customer')::int AS customer
       FROM conv_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel <> 'test' AND m.created_at > now() - make_interval(days => $1)`,
      [i.days],
    ))[0];
    const conversations = num(k.conversations);
    const orders = num(o.orders);
    return {
      conversations,
      orders,
      conversion: conversations ? Math.round((orders / conversations) * 1000) / 10 : 0,
      handed: num(k.handed),
      confirmed: num(o.confirmed),
      delivered: num(o.delivered),
      amount: num(o.amount),
      agentMessages: num(msgs.agent),
      customerMessages: num(msgs.customer),
    };
  }),

  'dellal.settings.get': proc([], z.object({}), async (ctx) => {
    const cur = await getRaw<Partial<DellalSettings>>(ctx.db, 'dellal', {});
    if (!cur.verifyToken) await setRaw(ctx.db, 'dellal', { ...DEFAULT_DELLAL, ...cur, verifyToken: randomToken() }, me(ctx));
    return settingsView(ctx.db);
  }),

  'dellal.settings.save': proc([], SettingsInput, async (ctx, i) => {
    const cur = await dellalSettings(ctx.db);
    const { secrets, ...rest } = i;
    const next: DellalSettings = { ...cur, ...rest, verifyToken: cur.verifyToken || randomToken() };
    await setRaw(ctx.db, 'dellal', next, me(ctx));
    for (const [k, v] of Object.entries(secrets) as [DellalSecret, string | null][]) {
      if (v === null) await ctx.db.query('DELETE FROM settings WHERE key = $1', [DELLAL_SECRETS[k]]);
      else if (v.trim()) await setRaw(ctx.db, DELLAL_SECRETS[k], v.trim(), me(ctx));
    }
    let aiTest: { ok: boolean; message?: string } | null = null;
    if (secrets.ai && ctx.server?.dellal) {
      try {
        await ctx.server.dellal('ping', {}, ctx);
        aiTest = { ok: true };
      } catch (e: any) {
        aiTest = { ok: false, message: e?.message ?? 'Clé refusée' };
      }
    }
    ctx.emit({ type: 'settings' });
    return { ...(await settingsView(ctx.db)), aiTest };
  }),

  /** Server: a message arrived on a channel (webhooks). Admin/system only. */
  'dellal.receive': proc([], IncomingInput, (ctx, i) => receiveMessage(ctx, i)),
  /** Server: let Dellal answer a conversation now. */
  'dellal.answer': proc([], z.object({ id }), (ctx, { id }) => runAgent(ctx, id)),
  /** Server (every 15 min): one follow-up for quiet customers. */
  'dellal.followUps': proc([], z.object({}), (ctx) => runFollowUps(ctx)),
  /** Server: the webhook verify token and which channel a page / number id belongs to. */
  'dellal.routing': proc([], z.object({}), async (ctx) => {
    const s = await dellalSettings(ctx.db);
    return { verifyToken: s.verifyToken, messengerPageId: s.messengerPageId, instagramId: s.instagramId, whatsappPhoneId: s.whatsappPhoneId, enabled: s.enabled };
  }),
};

function randomToken() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = 'dellal-';
  for (let i = 0; i < 24; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

