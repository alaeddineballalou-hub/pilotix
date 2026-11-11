// Referral › Code promo: a welcome code for the people who come from a post or an ad the seller marked « Awareness 🎁 »
// (a comment under a marked Facebook / Instagram post, or a Messenger / Instagram chat started from a marked ad or an
// m.me ?ref= link). The code is sent by a FIXED RULE that runs before Dellal: Dellal's AI never makes or gives a code,
// and the message is not an AI message (nothing is counted in the AI usage). Rules:
//   - one code per Facebook / Instagram account, ever (asked again: the same code); old clients too
//   - Instagram: only to a person who follows the boutique's account (otherwise « follow us first, then send CODE »)
//   - a unique code (BJ-7K3P), a % or an amount in DA off the PRODUCTS' total (not the delivery), a minimum order checked
//     before the discount, 90 days after it is sent, one order one time (any products, any quantity)
//   - it may go above a product's maximum discount (the welcome code only: any other discount keeps the limit)
//   - usable on the landing page, in the Dellal chat and by phone with the confirmation agent; the order is « Awareness »
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';

export type PromoLang = 'darija' | 'fr' | 'ar';
export interface PromoSettings {
  enabled: boolean;
  /** the code's first letters (BJ for Baby Joy) */
  prefix: string;
  kind: 'pct' | 'da';
  value: number;
  /** the products' total needed, before the discount (0: none) */
  minOrder: number;
  days: number;
  /** which of the three texts is sent */
  lang: PromoLang;
  /** with {code}, {remise}, {min}, {date} */
  message: Record<PromoLang, string>;
  /** Instagram, the person does not follow the page yet: with {mot} (the word to send again) */
  follow: Record<PromoLang, string>;
  /** the word the person sends to get the code again (Instagram, after following) */
  word: string;
}

export const DEFAULT_PROMO: PromoSettings = {
  enabled: false,
  prefix: '',
  kind: 'pct',
  value: 10,
  minOrder: 0,
  days: 90,
  lang: 'darija',
  message: {
    darija: 'Mar7ba bik 🎁 Hada code ta3ek : {code} — {remise} 3la les produits{min}. Sal7 7ta {date}, mara wa7da. 9olna 3lih ki tcommandi 😊',
    fr: 'Bienvenue 🎁 Voici votre code : {code} — {remise} sur les produits{min}. Valable jusqu’au {date}, une seule fois. Donnez-le en commandant 😊',
    ar: 'مرحبا بك 🎁 هذا كود الخصم تاعك: {code} — {remise} على المنتجات{min}. صالح حتى {date}، مرة واحدة. قولنا عليه كي تطلب 😊',
  },
  follow: {
    darija: 'Bach tkhed code ta3ek 🎁 tab3 page ta3na 9bel, w ba3d ab3atlna « {mot} » mara okhra 😊',
    fr: 'Pour recevoir votre code 🎁 suivez d’abord notre page, puis renvoyez « {mot} » 😊',
    ar: 'باش تاخذ الكود تاعك 🎁 تابع الصفحة تاعنا قبل، ومن بعد ابعثلنا « {mot} » مرة أخرى 😊',
  },
  word: 'CODE',
};

const TXT = z.string().trim().min(5).max(800);
const Texts = z.object({ darija: TXT, fr: TXT, ar: TXT });
export const PromoInput = z.object({
  enabled: z.boolean(),
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{0,4}$/, 'Début du code : 0 à 4 lettres ou chiffres'),
  kind: z.enum(['pct', 'da']),
  value: z.number().int().min(1).max(1_000_000),
  minOrder: z.number().int().min(0).max(10_000_000),
  days: z.number().int().min(1).max(365),
  lang: z.enum(['darija', 'fr', 'ar']),
  message: Texts,
  follow: Texts,
  word: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,12}$/, 'Mot à renvoyer : 2 à 12 lettres'),
});

export async function promoSettings(db: Db): Promise<PromoSettings> {
  const raw = await getRaw<Partial<PromoSettings>>(db, 'promo', {});
  return { ...DEFAULT_PROMO, ...raw, message: { ...DEFAULT_PROMO.message, ...(raw.message ?? {}) }, follow: { ...DEFAULT_PROMO.follow, ...(raw.follow ?? {}) } };
}

/** The code's first letters: the setting, else the boutique's initials (Baby Joy → BJ). */
async function prefixOf(db: Db, s: PromoSettings): Promise<string> {
  if (s.prefix) return s.prefix;
  const name = String((await getSetting(db, 'shop')).name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ini = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
  return ini || 'PX';
}

// letters and digits that cannot be confused (no 0/O, 1/I/L)
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(prefix: string): string {
  const b = new Uint8Array(4);
  globalThis.crypto.getRandomValues(b);
  return `${prefix}-${Array.from(b, (x) => ALPHA[x % ALPHA.length]).join('')}`;
}
/** A code nobody has in this boutique. */
async function newCode(db: Db, prefix: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const c = randomCode(prefix);
    if (!(await db.query('SELECT 1 FROM promo_codes WHERE code = $1', [c])).length) return c;
  }
  throw new Error('Impossible de créer un code unique');
}
export const normCode = (raw: unknown) =>
  String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[–—_]/g, '-')
    .slice(0, 20);

/** « 10% » / « 500 DA » */
export const remiseText = (r: { pct?: number | null; amount?: number | null }) => (r.pct ? `-${r.pct}%` : `-${num(r.amount)} DA`);
const dayText = (at: string | null) => {
  if (!at) return '';
  const d = new Date(at);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const MIN_TXT: Record<PromoLang, (n: number) => string> = {
  darija: (n) => ` (min ${n} DA)`,
  fr: (n) => ` (dès ${n} DA d’achat)`,
  ar: (n) => ` (ابتداءً من ${n} دج)`,
};
export function fill(text: string, row: { code: string; pct?: number | null; amount?: number | null; min_order?: number; expires_at?: string | null }, lang: PromoLang, word = 'CODE') {
  const min = num(row.min_order);
  return text
    .replace(/\{code\}/g, row.code)
    .replace(/\{remise\}/g, remiseText(row))
    .replace(/\{min\}/g, min > 0 ? MIN_TXT[lang](min) : '')
    .replace(/\{date\}/g, dayText(row.expires_at ?? null))
    .replace(/\{mot\}/g, word);
}
const AGAIN: Record<PromoLang, string> = { darija: 'Hada code ta3ek mara okhra 🎁 ', fr: 'Voici à nouveau votre code 🎁 ', ar: 'هذا الكود تاعك مرة أخرى 🎁 ' };
const USED: Record<PromoLang, (c: string) => string> = {
  darija: (c) => `Code ta3ek ${c} déjà sta3maltih f commande, ma ynajemch yetkhdem mara okhra 🙏`,
  fr: (c) => `Votre code ${c} a déjà servi pour une commande : il ne marche qu’une fois 🙏`,
  ar: (c) => `الكود تاعك ${c} استعملته في طلبية، يخدم مرة وحدة برك 🙏`,
};
const EXPIRED: Record<PromoLang, (c: string) => string> = {
  darija: (c) => `Code ta3ek ${c} fat wa9to (expiré) 🙏`,
  fr: (c) => `Votre code ${c} a expiré 🙏`,
  ar: (c) => `الكود تاعك ${c} انتهت صلاحيته 🙏`,
};

// ---------------------------------------------------------------- where a person comes from
/** « pub <ad id> » or « ref:<value> » that the seller marked « Awareness 🎁 »: the mark, else null. */
export async function awareMark(db: Db, source: string | null | undefined): Promise<{ kind: 'ad' | 'ref'; id: string; label: string | null } | null> {
  const src = String(source ?? '');
  const ad = src.match(/^pub (\d{4,30})\b/)?.[1];
  const ref = !ad && src.startsWith('ref:') ? src.slice(4).trim() : '';
  if (!ad && !ref) return null;
  const kind = ad ? 'ad' : 'ref';
  const id = ad || ref;
  const r = (await db.query('SELECT label FROM promo_marks WHERE kind = $1 AND lower(ref_id) = lower($2)', [kind, id]))[0];
  if (!r) return null;
  let label = (r.label as string | null) ?? null;
  if (!label && kind === 'ad') label = ((await db.query('SELECT name FROM ads WHERE id = $1', [id]))[0]?.name as string | undefined) ?? null;
  return { kind, id, label };
}

/** The person asks for their code (or sends the word again after following). */
export const ASKS_CODE = /\b(code|kod|cod|promo|coupon|r[eé]duc|remise|t5fid|tkhfid|takhfid|cadeau|hdiya|hadiya)\b|كود|كوود|بروموا?|تخفيض|هدية|خصم/i;
/** Only the code asked (a greeting at most): the fixed message answered it, Dellal adds nothing. */
export function onlyAsksCode(text: string, word = 'CODE', greetingToo = false): boolean {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(new RegExp(word.toLowerCase(), 'g'), ' code ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || (!greetingToo && !ASKS_CODE.test(t))) return false;
  const rest = t
    .replace(new RegExp(ASKS_CODE.source, 'gi'), ' ')
    .replace(/\b(salam|slm|salem|bonjour|bonsoir|cc|coucou|hi|hello|svp|stp|please|3afak|3fak|lah|yr7mk|yrhmk|merci|chokran|saha|ok|wach|ana|bghit|nheb|n7eb|nhab|ndir|le|la|les|mon|ma|mes|de|du|un|une|send|ab3at|ab3atli|3tini|atini|3tili|bien|svp|the|my|please|je|veux|voudrais|le|mon|ta3i|dyali|mta3i)\b/g, ' ')
    .replace(/السلام|عليكم|سلام|مرحبا|من فضلك|عافاك|ابعثلي|اعطيني|عطيني|نحب|بغيت|الكود|تاعي|شكرا|واش/g, ' ')
    .replace(/\s+/g, '')
    .trim();
  return rest.length <= 3;
}

// ---------------------------------------------------------------- the person's code
export interface PromoRow {
  id: number;
  code: string;
  channel: string;
  externalId: string;
  authorId: string | null;
  name: string | null;
  conversationId: number | null;
  sourceKind: 'post' | 'ad' | 'ref';
  sourceId: string;
  sourceLabel: string | null;
  status: 'waiting_follow' | 'sent' | 'used' | 'expired';
  orderId: number | null;
  orderRef: string | null;
  pct: number | null;
  amount: number | null;
  minOrder: number;
  discount: number | null;
  sends: number;
  createdAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  usedAt: string | null;
}
const toRow = (r: any, now = Date.now()): PromoRow => {
  const expired = r.status === 'sent' && r.expires_at && Date.parse(r.expires_at) <= now;
  return {
    id: num(r.id),
    code: r.code,
    channel: r.channel,
    externalId: r.external_id,
    authorId: r.author_id ?? null,
    name: r.name ?? null,
    conversationId: numOrNull(r.conversation_id),
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    sourceLabel: r.source_label ?? null,
    status: expired ? 'expired' : r.status,
    orderId: numOrNull(r.order_id),
    orderRef: r.order_ref ?? null,
    pct: numOrNull(r.pct),
    amount: numOrNull(r.amount),
    minOrder: num(r.min_order),
    discount: numOrNull(r.discount),
    sends: num(r.sends),
    createdAt: iso(r.created_at),
    sentAt: isoOrNull(r.sent_at),
    expiresAt: isoOrNull(r.expires_at),
    usedAt: isoOrNull(r.used_at),
  };
};

/** The code of this account (one per account, ever), found by its chat id, the commenter's id or the conversation. */
export async function codeOfPerson(db: Db, p: { channel: string; externalId?: string | null; authorId?: string | null; conversationId?: number | null }): Promise<any | null> {
  const ch = p.channel === 'facebook' ? 'messenger' : p.channel;
  return (
    (
      await db.query(
        `SELECT * FROM promo_codes WHERE channel = $1 AND (
           ($2::text IS NOT NULL AND (external_id = $2 OR author_id = $2)) OR ($3::text IS NOT NULL AND (author_id = $3 OR external_id = $3))
           OR ($4::bigint IS NOT NULL AND conversation_id = $4)) ORDER BY id LIMIT 1`,
        [ch, p.externalId ?? null, p.authorId ?? null, p.conversationId ?? null],
      )
    )[0] ?? null
  );
}

type Decision = { kind: 'code' | 'again' | 'follow' | 'used' | 'expired'; text: string; row: any };
/**
 * The fixed rule (no AI): what to send this person, if anything. `aware`: they come from a marked post / ad now;
 * `asks`: they ask for their code (or send the word). Creates the code (status waiting_follow on Instagram when they do
 * not follow yet). The text is sent by the caller; `markSent` then records it.
 */
async function decide(
  ctx: Ctx,
  s: PromoSettings,
  p: {
    channel: 'messenger' | 'instagram';
    externalId: string;
    authorId?: string | null;
    conversationId?: number | null;
    name?: string | null;
    aware: { kind: 'post' | 'ad' | 'ref'; id: string; label: string | null } | null;
    asks: boolean;
  },
): Promise<Decision | null> {
  const db = ctx.db;
  const L = s.lang;
  let row = await codeOfPerson(db, p);
  if (!row && !p.aware) return null;
  if (row && !p.aware && !p.asks) return null;
  if (row?.status === 'used') return p.asks ? { kind: 'used', text: USED[L](row.code), row } : null;
  if (row?.status === 'sent' && row.expires_at && Date.parse(row.expires_at) <= ctx.now()) return p.asks ? { kind: 'expired', text: EXPIRED[L](row.code), row } : null;
  if (row?.status === 'sent') return { kind: 'again', text: AGAIN[L] + fill(s.message[L], row, L, s.word), row };
  // Instagram: the code only to a person who follows the boutique's account
  let follows: boolean | null = true;
  if (p.channel === 'instagram') {
    follows = null;
    if (ctx.server?.dellal) {
      const r: any = await ctx.server.dellal('igFollows', { externalId: p.externalId }, ctx).catch((e: any) => ({ follows: null, error: String(e?.message ?? e) }));
      follows = typeof r?.follows === 'boolean' ? r.follows : null;
    } else follows = !/nofollow|non-abonne/i.test(String(p.name ?? '') + p.externalId); // the preview: everyone follows, but a « nofollow » test account
  }
  if (!row) {
    const code = await newCode(db, await prefixOf(db, s));
    row = (
      await db.query(
        `INSERT INTO promo_codes (code, channel, external_id, author_id, name, conversation_id, source_kind, source_id, source_label, status, pct, amount, min_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting_follow',$10,$11,$12)
         ON CONFLICT (channel, external_id) DO NOTHING RETURNING *`,
        [
          code,
          p.channel,
          p.externalId,
          p.authorId ?? null,
          p.name ?? null,
          p.conversationId ?? null,
          p.aware!.kind,
          p.aware!.id,
          p.aware!.label,
          s.kind === 'pct' ? Math.min(100, s.value) : null,
          s.kind === 'da' ? s.value : null,
          s.minOrder,
        ],
      )
    )[0];
    if (!row) return null; // another message of the same person made it at the same moment
  }
  if (follows !== true) return { kind: 'follow', text: fill(s.follow[L], row, L, s.word), row };
  return { kind: 'code', text: fill(s.message[L], { ...row, expires_at: new Date(ctx.now() + s.days * 86_400_000).toISOString() }, L, s.word), row };
}

/** The text went: the code counts from now (90 days), its conversation and the person's chat id are kept. */
async function markSent(ctx: Ctx, s: PromoSettings, d: Decision, o: { conversationId?: number | null; externalId?: string | null }) {
  const first = d.kind === 'code';
  await ctx.db.query(
    `UPDATE promo_codes SET sends = sends + 1,
       status = CASE WHEN $2::boolean THEN 'sent' ELSE status END,
       sent_at = CASE WHEN $2::boolean THEN now() ELSE sent_at END,
       expires_at = CASE WHEN $2::boolean THEN now() + make_interval(days => $3::int) ELSE expires_at END,
       conversation_id = COALESCE(conversation_id, $4::bigint),
       external_id = CASE WHEN $5::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM promo_codes x WHERE x.channel = promo_codes.channel AND x.external_id = $5 AND x.id <> promo_codes.id) THEN $5 ELSE external_id END
     WHERE id = $1`,
    [d.row.id, first, s.days, o.conversationId ?? null, o.externalId ?? null],
  );
  if (first) {
    // the text said the date: fill it once the code counts
    const r = (await ctx.db.query('SELECT * FROM promo_codes WHERE id = $1', [d.row.id]))[0];
    d.text = fill(s.message[s.lang], r, s.lang, s.word);
  }
}

// ---------------------------------------------------------------- a chat (Messenger / Instagram)
/**
 * A customer's message (or a referral without message) just arrived: the fixed rule, before Dellal. Sends the code,
 * the « follow first » text or the same code again, and writes it in the conversation (not an AI message).
 */
export async function promoOnMessage(ctx: Ctx, convId: number, m: { text: string; source?: string | null }): Promise<{ kind: Decision['kind']; code: string } | null> {
  const s = await promoSettings(ctx.db);
  if (!s.enabled) return null;
  const c = (await ctx.db.query('SELECT id, channel, external_id, account_id, customer_name FROM conversations WHERE id = $1', [convId]))[0];
  if (!c || (c.channel !== 'messenger' && c.channel !== 'instagram')) return null;
  const mark = await awareMark(ctx.db, m.source);
  const text = String(m.text ?? '');
  const asks = ASKS_CODE.test(text) || (!!s.word && new RegExp(`(^|\\W)${s.word}(\\W|$)`, 'i').test(text));
  const d = await decide(ctx, s, {
    channel: c.channel,
    externalId: String(c.external_id),
    conversationId: convId,
    name: c.customer_name ?? null,
    aware: mark ? { kind: mark.kind, id: mark.id, label: mark.label } : null,
    asks,
  });
  if (!d) return null;
  // a « follow first » already said in the last minute: not twice in a row
  if (d.kind === 'follow') {
    const last = (await ctx.db.query(`SELECT 1 FROM conv_messages WHERE conversation_id = $1 AND meta->'promo'->>'kind' = 'follow' AND created_at > now() - interval '1 minute'`, [convId])).length;
    if (last) return null;
  }
  if (d.kind === 'code') await markSent(ctx, s, d, { conversationId: convId });
  let sendError: string | null = null;
  if (ctx.server?.dellal) {
    try {
      await ctx.server.dellal('send', { conversationId: convId, channel: c.channel, externalId: c.external_id, accountId: c.account_id ?? null, text: d.text }, ctx);
    } catch (e: any) {
      sendError = String(e?.message ?? e).slice(0, 300);
    }
  }
  if (d.kind !== 'code') await markSent(ctx, s, d, { conversationId: convId });
  const { addMessage } = await import('./dellal');
  await addMessage(ctx.db, convId, { role: 'agent', body: d.text, meta: { promo: { kind: d.kind, code: d.row.code } }, sendError });
  ctx.emit({ type: 'chat', data: { dellal: convId } });
  return { kind: d.kind, code: d.row.code };
}

/**
 * Dellal reads this (never makes a code): the code this chat's person has, and whether it still works. In the system
 * prompt, and applied by create_order.
 */
export async function promoForConversation(db: Db, convId: number, now = Date.now()): Promise<PromoRow | null> {
  const r = (await db.query(`SELECT * FROM promo_codes WHERE conversation_id = $1 AND status <> 'waiting_follow' ORDER BY id LIMIT 1`, [convId]))[0];
  return r ? toRow(r, now) : null;
}
export function promoPromptLine(p: PromoRow | null): string {
  if (!p) return '- Codes promo : tu ne crées ni ne donnes JAMAIS de code. Si le client en demande un, dis-lui que la boutique n’en a pas pour lui.';
  if (p.status === 'used') return `- Code de bienvenue du client : ${p.code}, déjà utilisé (une seule fois). Ne crée jamais d’autre code.`;
  if (p.status === 'expired') return `- Code de bienvenue du client : ${p.code}, expiré. Ne crée jamais d’autre code.`;
  return `- Code de bienvenue du client : ${p.code} (${remiseText(p)} sur les produits, pas sur la livraison${p.minOrder ? `, dès ${p.minOrder} DA de produits` : ''}, valable jusqu’au ${p.expiresAt?.slice(0, 10)}). La boutique le lui a déjà envoyé. Tu ne crées ni ne donnes jamais d’autre code. create_order l’applique tout seul : dis au client le total après la remise que l’outil te donne.`;
}

// ---------------------------------------------------------------- a comment under a marked post
/**
 * Pilot Comments decided its answer to a comment: under a post marked « Awareness 🎁 », the private message becomes the
 * fixed code message (or « follow first », or the same code again). Never for spam / insults, a hidden comment, TikTok,
 * a comment too old for a private reply. Returns the text to send in private, or null (the decision stays).
 */
export async function promoForComment(
  ctx: Ctx,
  c: { channel: string; postId: number | null; authorId: string | null; authorName: string | null; body: string; intent: string; hide: boolean; tooOld: boolean; alreadyPrivate: boolean },
): Promise<{ text: string; decision: Decision; settings: PromoSettings } | null> {
  if (c.channel !== 'facebook' && c.channel !== 'instagram') return null;
  if (!c.postId || !c.authorId || c.hide || c.tooOld || c.alreadyPrivate || c.intent === 'spam' || c.intent === 'insult') return null;
  const s = await promoSettings(ctx.db);
  if (!s.enabled) return null;
  const post = (await ctx.db.query('SELECT external_id, caption, awareness FROM cm_posts WHERE id = $1', [c.postId]))[0];
  if (!post?.awareness) return null;
  const channel = c.channel === 'facebook' ? 'messenger' : 'instagram';
  const d = await decide(ctx, s, {
    channel,
    externalId: c.authorId,
    authorId: c.authorId,
    name: c.authorName,
    aware: { kind: 'post', id: String(post.external_id), label: post.caption ? String(post.caption).slice(0, 80) : null },
    asks: true,
  });
  if (!d || d.kind === 'used' || d.kind === 'expired') return d ? { text: d.text, decision: d, settings: s } : null;
  return { text: d.text, decision: d, settings: s };
}
/** The private message went (its conversation, the person's chat id when Meta gave it). */
export async function promoCommentSent(ctx: Ctx, r: { decision: Decision; settings: PromoSettings }, o: { conversationId: number | null; recipientId: string | null }) {
  await markSent(ctx, r.settings, r.decision, { conversationId: o.conversationId, externalId: o.recipientId });
}

// ---------------------------------------------------------------- the code on an order
export type PromoCheck =
  | { ok: true; code: string; discount: number; pct: number | null; amount: number | null; minOrder: number; expiresAt: string | null }
  | { ok: false; code: string; reason: 'unknown' | 'used' | 'expired' | 'small' | 'waiting'; minOrder?: number; orderRef?: string | null };

/** Is this code good for an order whose products cost `subtotal` (before the discount)? What it takes off. */
export async function checkPromo(db: Db, raw: string, subtotal: number, now = Date.now(), forOrder?: number | null): Promise<PromoCheck> {
  const code = normCode(raw);
  const r = (await db.query('SELECT p.*, o.ref AS order_ref FROM promo_codes p LEFT JOIN orders o ON o.id = p.order_id WHERE p.code = $1', [code]))[0];
  if (!r) return { ok: false, code, reason: 'unknown' };
  if (r.status === 'used' && !(forOrder && num(r.order_id) === forOrder)) return { ok: false, code, reason: 'used', orderRef: r.order_ref ?? null };
  if (r.status === 'waiting_follow' || !r.sent_at) return { ok: false, code, reason: 'waiting' };
  if (r.status !== 'used' && r.expires_at && Date.parse(r.expires_at) <= now) return { ok: false, code, reason: 'expired' };
  const min = num(r.min_order);
  if (subtotal < min) return { ok: false, code, reason: 'small', minOrder: min };
  const pct = numOrNull(r.pct);
  const amount = numOrNull(r.amount);
  const discount = Math.max(0, Math.min(subtotal, pct ? Math.round((subtotal * pct) / 100) : num(amount)));
  return { ok: true, code, discount, pct, amount, minOrder: min, expiresAt: isoOrNull(r.expires_at) };
}
export const PROMO_REASON: Record<string, string> = {
  unknown: 'Code inconnu',
  used: 'Code déjà utilisé',
  expired: 'Code expiré',
  small: 'Commande trop petite pour ce code',
  waiting: 'Code pas encore donné (le client doit suivre la page Instagram)',
};

/** The order took the code: used (once). Inside the order's transaction; refused when another order took it meanwhile. */
export async function takePromo(db: Db, code: string, orderId: number, discount: number) {
  const r = await db.query(
    `UPDATE promo_codes SET status = 'used', order_id = $2::bigint, used_at = COALESCE(used_at, now()), discount = $3::int
      WHERE code = $1 AND (status = 'sent' OR (status = 'used' AND order_id = $2::bigint)) RETURNING id`,
    [code, orderId, discount],
  );
  if (!r.length) throw bad('Code déjà utilisé');
}

// ---------------------------------------------------------------- the app
const WHO = ['marketer', 'vendeur'] as const;
const id = z.number().int().positive();

async function listCodes(db: Db, i: { status?: string; q?: string; limit: number }, now: number) {
  const rows = await db.query(
    `SELECT p.*, o.ref AS order_ref FROM promo_codes p LEFT JOIN orders o ON o.id = p.order_id
      WHERE ($1::text IS NULL OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%' OR o.ref ILIKE '%' || $1 || '%')
      ORDER BY p.id DESC LIMIT $2`,
    [i.q?.trim() || null, i.limit],
  );
  const list = rows.map((r: any) => toRow(r, now));
  return i.status ? list.filter((x) => x.status === i.status) : list;
}

async function stats(db: Db, days: number, now: number) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const t = (
    await db.query(
      `SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent, count(*) FILTER (WHERE status = 'used')::int AS used,
              count(*) FILTER (WHERE status = 'waiting_follow')::int AS waiting,
              count(*) FILTER (WHERE status = 'sent' AND expires_at <= now())::int AS expired
         FROM promo_codes WHERE created_at > $1`,
      [since],
    )
  )[0];
  const o = (
    await db.query(
      `SELECT count(*)::int AS orders, COALESCE(sum(total), 0)::bigint AS money, COALESCE(sum(promo_discount), 0)::bigint AS given,
              count(*) FILTER (WHERE conf_status IN ('confirmed', 'no_stock'))::int AS confirmed
         FROM orders WHERE awareness AND created_at > $1`,
      [since],
    )
  )[0];
  const by = await db.query(
    `SELECT p.source_kind, p.source_id, max(p.source_label) AS label, count(*) FILTER (WHERE p.sent_at IS NOT NULL)::int AS sent,
            count(*) FILTER (WHERE p.status = 'used')::int AS used, COALESCE(sum(o.total), 0)::bigint AS money
       FROM promo_codes p LEFT JOIN orders o ON o.id = p.order_id WHERE p.created_at > $1
      GROUP BY p.source_kind, p.source_id ORDER BY sent DESC LIMIT 50`,
    [since],
  );
  return {
    sent: num(t?.sent),
    used: num(t?.used),
    waiting: num(t?.waiting),
    expired: num(t?.expired),
    orders: num(o?.orders),
    confirmed: num(o?.confirmed),
    money: num(o?.money),
    given: num(o?.given),
    bySource: by.map((r: any) => ({ kind: r.source_kind as 'post' | 'ad' | 'ref', id: String(r.source_id), label: (r.label as string | null) ?? null, sent: num(r.sent), used: num(r.used), money: num(r.money) })),
  };
}

export const promoProcs = {
  'promo.settings.get': proc([...WHO], z.object({}), async (ctx) => {
    const s = await promoSettings(ctx.db);
    return { ...s, prefixShown: await prefixOf(ctx.db, s) };
  }),
  'promo.settings.save': proc([...WHO], PromoInput, async (ctx, i) => {
    if (i.kind === 'pct' && i.value > 90) throw bad('Remise en % : 90 % au plus');
    for (const l of ['darija', 'fr', 'ar'] as const) if (!i.message[l].includes('{code}')) throw bad('Le message doit contenir {code} (le code de la personne)');
    await setRaw(ctx.db, 'promo', i, ctx.session.profile.id);
    return { ok: true };
  }),
  /** The marked ads and ?ref= links, and the ads Pilotix knows (Marketing › Publicité) to mark one. */
  'promo.marks': proc([...WHO], z.object({}), async (ctx) => {
    const marks = await ctx.db.query(`SELECT m.kind, m.ref_id, COALESCE(m.label, a.name) AS label, m.created_at FROM promo_marks m LEFT JOIN ads a ON m.kind = 'ad' AND a.id = m.ref_id ORDER BY m.created_at DESC`);
    const ads = await ctx.db.query(`SELECT id, name, status FROM ads ORDER BY updated_at DESC LIMIT 200`);
    const on = new Set(marks.filter((m: any) => m.kind === 'ad').map((m: any) => String(m.ref_id)));
    const posts = num((await ctx.db.query('SELECT count(*)::int AS n FROM cm_posts WHERE awareness'))[0]?.n);
    return {
      marks: marks.map((m: any) => ({ kind: m.kind as 'ad' | 'ref', id: String(m.ref_id), label: (m.label as string | null) ?? null, at: iso(m.created_at) })),
      ads: ads.map((a: any) => ({ id: String(a.id), name: String(a.name), status: (a.status as string | null) ?? null, awareness: on.has(String(a.id)) })),
      posts,
    };
  }),
  /** « 🎁 Awareness: gives a code » on an ad (its Meta id) or an m.me ?ref= value. */
  'promo.mark': proc(
    [...WHO],
    z.object({
      kind: z.enum(['ad', 'ref']),
      id: z.string().trim().min(1).max(120),
      on: z.boolean(),
      label: z.string().trim().max(120).optional(),
    }),
    async (ctx, i) => {
      const rid = i.kind === 'ad' ? i.id.replace(/\D/g, '') : i.id;
      if (i.kind === 'ad' && rid.length < 4) throw bad('ID de la pub : des chiffres (Gestionnaire de publicités › la pub › ID)');
      if (i.kind === 'ref' && !/^[\w.-]{1,120}$/.test(rid)) throw bad('Valeur ?ref= : lettres, chiffres, tirets');
      if (i.on) await ctx.db.query('INSERT INTO promo_marks (kind, ref_id, label) VALUES ($1,$2,$3) ON CONFLICT (kind, ref_id) DO UPDATE SET label = COALESCE(EXCLUDED.label, promo_marks.label)', [i.kind, rid, i.label || null]);
      else await ctx.db.query('DELETE FROM promo_marks WHERE kind = $1 AND ref_id = $2', [i.kind, rid]);
      return { ok: true };
    },
  ),
  /** Pilot Comments › Publications: « 🎁 Awareness: gives a code » on a post. */
  'promo.markPost': proc([...WHO], z.object({ id, on: z.boolean() }), async (ctx, i) => {
    const r = await ctx.db.query('UPDATE cm_posts SET awareness = $2 WHERE id = $1 RETURNING id', [i.id, i.on]);
    if (!r.length) throw bad('Publication introuvable');
    return { ok: true };
  }),
  'promo.codes': proc(
    [...WHO, 'confirmation'],
    z.object({ status: z.enum(['waiting_follow', 'sent', 'used', 'expired']).optional(), q: z.string().max(60).optional(), limit: z.number().int().min(1).max(500).default(200) }),
    async (ctx, i) => ({ rows: await listCodes(ctx.db, i, ctx.now()) }),
  ),
  'promo.stats': proc([...WHO], z.object({ days: z.number().int().min(1).max(365).default(30) }), async (ctx, i) => stats(ctx.db, i.days, ctx.now())),
  /** The order screen / Confirmation: the badge of a code typed (✅ valid / ❌ used / ❌ expired / ❌ order too small). */
  'promo.check': proc(null, z.object({ code: z.string().max(30), subtotal: z.number().int().min(0).max(100_000_000), orderId: id.optional() }), async (ctx, i) => {
    const r = await checkPromo(ctx.db, i.code, i.subtotal, ctx.now(), i.orderId ?? null);
    return r.ok ? r : { ...r, message: PROMO_REASON[r.reason] };
  }),
};
