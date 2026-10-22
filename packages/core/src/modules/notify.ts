// Delivery AI agent: tells each customer where their order is — received, confirmed, shipped, with the livreur today,
// waiting at the desk, a failed attempt, cancelled by the livreur, delivered — by WhatsApp, or by SMS when the number has
// no WhatsApp, or in a list to send by hand when no SMS sender is set. Messages are queued when the order is created or
// its status changes (a person, the livreur's app or the couriers' sync) and sent by the server's job every minute; in
// the preview, sending is simulated. The customer's answers land in Message AI agent, where Dellal knows the order.
//
// This module imports no other module of ./modules (orders.ts calls it): no import cycle.
import { normalizePhone, phoneIntl, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getSetting } from '../settings';

// ---------------------------------------------------------------- the cases and their texts
export const NOTIFY_KINDS = ['created', 'confirmed', 'shipped', 'out_for_delivery', 'stopdesk', 'failed', 'returning', 'delivered'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export const NOTIFY_LANGS = ['dz', 'fr', 'ar'] as const;
export type NotifyLang = (typeof NOTIFY_LANGS)[number];
export const NOTIFY_STATUSES = ['queued', 'sending', 'whatsapp', 'sms', 'manual', 'done', 'failed', 'skipped'] as const;
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number];
/** What a text may contain. */
export const NOTIFY_VARS = ['nom', 'boutique', 'ref', 'produits', 'total', 'societe', 'suivi', 'bureau', 'commune', 'wilaya'] as const;
export type NotifyVars = Record<(typeof NOTIFY_VARS)[number], string>;

/**
 * The default messages. Darija in Latin letters by default (it reads like the shop's own chat, and a Latin SMS costs 2 to
 * 3 times less than an Arabic one). No emoji, no curly apostrophe, no À / ç / ê: any of them would turn every SMS into the
 * expensive kind. Each text starts and ends with words, as WhatsApp templates must.
 */
export const DEFAULT_TEXTS: Record<NotifyKind, Record<NotifyLang, string>> = {
  created: {
    dz: 'Salam {nom}, m3akom {boutique}. La commande ta3kom {ref} wslatna : {produits}, {total} DA. Ra7 n3ayetoulkom bach nconfirmiw m3akom, khalliw le téléphone ma7loul.',
    fr: 'Bonjour {nom}, ici {boutique}. Votre commande {ref} est bien enregistrée : {produits}, {total} DA. Nous allons vous appeler pour la confirmer, gardez votre téléphone allumé.',
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الكوموند تاعكم {ref} وصلاتنا: {produits}، {total} دج. راح نعيطولكم باش نأكدو معاكم، خليو التيليفون محلول.',
  },
  confirmed: {
    dz: 'Salam {nom}, m3akom {boutique}. La commande ta3kom {ref} tconfirmat : {produits}, {total} DA m3a la livraison. Ra7 nwajdouha w nab3touhalkom f a9rab wa9t.',
    fr: "Bonjour {nom}, ici {boutique}. Votre commande {ref} est confirmée : {produits}, {total} DA livraison comprise. Nous la préparons et vous l'envoyons très vite.",
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الكوموند تاعكم {ref} تأكدت: {produits}، {total} دج مع التوصيل. راح نوجدوها ونبعثوهالكم في أقرب وقت.',
  },
  shipped: {
    dz: 'Salam {nom}, m3akom {boutique}. La commande ta3kom {ref} kherjet m3a {societe}, tousel normalement bin 24 w 72 sa3a. Tkhallsou {total} DA ki testalmou. Numéro de suivi : {suivi}.',
    fr: 'Bonjour {nom}, ici {boutique}. Votre commande {ref} est expédiée avec {societe}, livraison en 24 à 72 h. Paiement à la livraison : {total} DA. Numéro de suivi : {suivi}.',
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الكوموند تاعكم {ref} خرجت مع {societe} وتوصل عادة بين 24 و72 ساعة. تخلصو {total} دج كي تستلمو. رقم التتبع: {suivi}.',
  },
  out_for_delivery: {
    dz: 'Salam {nom}, m3akom {boutique}. La commande ta3kom {ref} rahi m3a le livreur lyoum. Khalliw le téléphone ma7loul bach y3ayetlkom, w tkhallsou {total} DA ki testalmou.',
    fr: "Bonjour {nom}, ici {boutique}. Votre commande {ref} est avec le livreur aujourd'hui : gardez votre téléphone allumé, il va vous appeler. Montant à payer : {total} DA.",
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الكوموند تاعكم {ref} راهي مع الليفرور اليوم. خليو التيليفون محلول باش يعيطلكم، وتخلصو {total} دج كي تستلمو.',
  },
  stopdesk: {
    dz: 'Salam {nom}, m3akom {boutique}. La commande ta3kom {ref} rahi testennakom f le bureau {bureau}. Jibou {total} DA bach testalmouha.',
    fr: 'Bonjour {nom}, ici {boutique}. Votre commande {ref} vous attend au bureau {bureau}. Venez la récupérer avec {total} DA.',
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الكوموند تاعكم {ref} راهي تستناكم في البيرو {bureau}. جيبو {total} دج باش تستلموها.',
  },
  failed: {
    dz: 'Salam {nom}, m3akom {boutique}. Le livreur ma9derch ywasselkom la commande {ref}. Mazal t7abouha ? Jawbouna 3la had le message w nab3touhalkom 3awed.',
    fr: "Bonjour {nom}, ici {boutique}. Le livreur n'a pas pu vous livrer la commande {ref}. Vous la voulez toujours ? Répondez à ce message et nous la renvoyons.",
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الليفرور ما قدرش يوصلكم الكوموند {ref}. مازال تحبوها؟ جاوبونا على هاد الميساج ونبعثوهالكم عاود.',
  },
  returning: {
    dz: 'Salam {nom}, m3akom {boutique}. La commande ta3kom {ref} tannulat 3and le livreur. Ida mazal t7abouha, jawbouna dorka w nab3touhalkom 3awed.',
    fr: 'Bonjour {nom}, ici {boutique}. Votre commande {ref} a été annulée par le livreur. Si vous la voulez toujours, répondez vite à ce message et nous vous la renvoyons.',
    ar: 'السلام عليكم {nom}، معاكم {boutique}. الكوموند تاعكم {ref} تانيلات عند الليفرور. إذا مازال تحبوها، جاوبونا دركا ونبعثوهالكم عاود.',
  },
  delivered: {
    dz: 'Salam {nom}, m3akom {boutique}. Bessaha 3likom la commande {ref} ! Ida kayen ay mouchkil, jawbouna 3la had le message. Ya3tikom saha.',
    fr: 'Bonjour {nom}, ici {boutique}. Merci pour votre commande {ref} ! Un souci ? Répondez à ce message, nous sommes là.',
    ar: 'السلام عليكم {nom}، معاكم {boutique}. بالصحة عليكم الكوموند {ref}! إذا كاين أي مشكل جاوبونا على هاد الميساج. يعطيكم الصحة.',
  },
};

/** WhatsApp template language for each text language (Darija in Latin letters is declared as French). */
export const TEMPLATE_LANG: Record<NotifyLang, string> = { dz: 'fr', fr: 'fr', ar: 'ar' };
/** Without a usable first name: "Salam 3likom," / "Bonjour Madame, Monsieur," / "السلام عليكم زبوننا العزيز،". */
const NAME_FALLBACK: Record<NotifyLang, string> = { dz: '3likom', fr: 'Madame, Monsieur', ar: 'زبوننا العزيز' };
/** Order confirmation calls not made yet. */
const WAITING_CALL = ['new', 'no_answer', 'busy', 'callback', 'postponed'];
/** Sent once per order; the other cases (with the livreur, at the desk, failed attempt) at most once a day. */
const ONCE: NotifyKind[] = ['created', 'confirmed', 'shipped', 'returning', 'delivered'];
const CONF_KINDS: NotifyKind[] = ['created', 'confirmed'];

// ---------------------------------------------------------------- settings
export interface NotifyTemplate {
  /** name at Meta (pilotix_shipped_dz, then _v2… when the text changes) */
  name: string;
  /** the text sent to Meta for approval */
  text: string;
  /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED */
  status: string;
  version: number;
  reason?: string | null;
}

export interface NotifySettings {
  enabled: boolean;
  lang: NotifyLang;
  cases: Record<NotifyKind, boolean>;
  /** the shop's own texts (missing = the default text) */
  texts: Partial<Record<NotifyKind, Partial<Record<NotifyLang, string>>>>;
  /** send by WhatsApp when Message AI agent's WhatsApp number is connected */
  whatsapp: boolean;
  /** when there is no WhatsApp: an SMS sender (gateway), a list to send by hand, or nothing */
  sms: 'gateway' | 'manual' | 'off';
  /** 'android' = the "SMS Gateway for Android" app on a phone with the shop's SIM; 'http' = any service taking { to, text } */
  smsProvider: 'android' | 'http';
  smsUrl: string;
  smsUser: string;
  /** no message between these hours (Algeria): they leave at the end of the night */
  quietFrom: number;
  quietTo: number;
  /** WhatsApp Business Account id (to send the texts to Meta for approval) */
  wabaId: string;
  templates: Record<string, NotifyTemplate>;
  /** key of the SMS gateway webhook (/api/hooks/sms?key=…) */
  hookKey: string;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: false,
  lang: 'dz',
  cases: { created: true, confirmed: true, shipped: true, out_for_delivery: true, stopdesk: true, failed: true, returning: true, delivered: false },
  texts: {},
  whatsapp: true,
  sms: 'manual',
  smsProvider: 'android',
  smsUrl: 'https://api.sms-gate.app',
  smsUser: '',
  quietFrom: 22,
  quietTo: 8,
  wabaId: '',
  templates: {},
  hookKey: '',
};

export const NOTIFY_SMS_SECRET = 'secret_notify_sms';

async function raw<T>(db: Db, key: string, def: T): Promise<T> {
  const r = await db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return r[0] ? r[0].value : def;
}
async function saveRaw(db: Db, key: string, value: unknown, userId?: number) {
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId ?? null],
  );
}

export async function notifySettings(db: Db): Promise<NotifySettings> {
  const r = await raw<Partial<NotifySettings>>(db, 'notify', {});
  return { ...DEFAULT_NOTIFY, ...r, cases: { ...DEFAULT_NOTIFY.cases, ...(r.cases ?? {}) }, texts: r.texts ?? {}, templates: r.templates ?? {} };
}

/** Message AI agent's WhatsApp number is connected (the same number sends these messages). */
async function waConnected(db: Db): Promise<boolean> {
  const d = await raw<{ whatsappPhoneId?: string }>(db, 'dellal', {});
  return !!d.whatsappPhoneId && !!(await raw<string>(db, 'secret_dellal_wa_token', ''));
}

/** The text of a case in a language: the shop's own, or the default. */
export const textOf = (s: Pick<NotifySettings, 'texts'>, kind: NotifyKind, lang: NotifyLang) => s.texts?.[kind]?.[lang]?.trim() || DEFAULT_TEXTS[kind][lang];
const templateKey = (kind: NotifyKind, lang: NotifyLang) => `${kind}_${lang}`;

// ---------------------------------------------------------------- texts
const money = (n: number) => n.toLocaleString('fr-FR').replace(/[  ]/g, ' ');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
export const fill = (text: string, v: Partial<NotifyVars>) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String((v as any)[k] ?? '') : m));
/** A text with the order's values, as the customer reads it. */
export const render = (text: string, v: Partial<NotifyVars>) =>
  fill(text, v)
    .replace(/[ \t]+([,،.])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
/** WhatsApp template body: {nom} → {{1}}, in order of appearance (a variable used twice is two parameters). */
export const templateBody = (text: string) => {
  let i = 0;
  return text.replace(/\{(\w+)\}/g, () => `{{${++i}}}`);
};
/** WhatsApp template parameters: never empty, one line. */
export const templateParams = (text: string, v: Partial<NotifyVars>) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => oneLine(String((v as any)[m[1]] ?? '')) || '-');

/** Problems of a text: unknown variables, a variable at the very start or end (WhatsApp refuses it), too short. */
export function textProblems(text: string): string[] {
  const out: string[] = [];
  const t = text.trim();
  for (const m of t.matchAll(/\{(\w*)\}/g)) if (!(NOTIFY_VARS as readonly string[]).includes(m[1])) out.push(`Variable inconnue {${m[1]}}`);
  if (/^\{\w+\}/.test(t) || /\{\w+\}$/.test(t)) out.push('Le texte ne peut pas commencer ou finir par une variable (WhatsApp le refuse) : ajoutez un mot ou un point');
  if (t.length < 20) out.push('Texte trop court');
  return out;
}

/** SMS parts: 160 characters of the GSM alphabet per SMS (153 when split), 70 (67) as soon as one character is not in it. */
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsParts(text: string): { parts: number; unicode: boolean; length: number } {
  const unicode = !GSM.test(text);
  const length = unicode ? [...text].length : [...text].reduce((n, c) => n + ('^{}\\[~]|€'.includes(c) ? 2 : 1), 0);
  const one = unicode ? 70 : 160;
  const many = unicode ? 67 : 153;
  return { parts: length <= one ? 1 : Math.ceil(length / many), unicode, length };
}

/** "amina boudiaf" → "Amina"; "Om Yasmine" → "Om Yasmine"; "client", "X", digits → the polite fallback. */
export function firstName(full: string | null | undefined, lang: NotifyLang): string {
  const words = String(full ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}'-]/gu, ''))
    .filter(Boolean);
  let w = words[0] ?? '';
  if (/^(om|oum|umm|abou|abu|abo|ben|bel|el|al|ait|aït)$/i.test(w) && words[1]) w = `${w} ${words[1]}`;
  if (w.length < 2 || /^(client|cliente|clt|mme|mr|madame|monsieur|mademoiselle|mlle|test|x+|inconnu|null|undefined|anonyme|nom|sans|khouya|khti|زبون|زبونة)$/i.test(w)) return NAME_FALLBACK[lang];
  const arabic = /[؀-ۿ]/.test(w);
  // an Arabic name would make a Latin SMS cost 2 to 3 times more
  if (arabic && lang !== 'ar') return NAME_FALLBACK[lang];
  return arabic ? w : w.replace(/\p{L}+/gu, (x) => x[0].toUpperCase() + x.slice(1).toLowerCase());
}

/** The values of an order for its messages (and the order itself). */
export async function orderVars(db: Db, orderId: number, lang: NotifyLang, shopName?: string): Promise<{ vars: NotifyVars; row: any } | null> {
  const r = (
    await db.query(
      `SELECT o.*, c.name AS company_name, d.name AS desk_name, d.address AS desk_address, v.channel AS conv_channel,
         (SELECT string_agg(i.name || CASE WHEN COALESCE(i.variant_title, '') <> '' THEN ' ' || i.variant_title ELSE '' END || CASE WHEN i.qty > 1 THEN ' x' || i.qty ELSE '' END, ', ' ORDER BY i.id)
          FROM order_items i WHERE i.order_id = o.id) AS products
       FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id LEFT JOIN stopdesks d ON d.id = o.stopdesk_id
       LEFT JOIN conversations v ON v.id = o.conversation_id
       WHERE o.id = $1`,
      [orderId],
    )
  )[0];
  if (!r) return null;
  const shop = shopName ?? (await getSetting(db, 'shop')).name;
  const company = r.company_name || shop;
  const wilaya = WILAYAS[num(r.wilaya_id) - 1] ?? '';
  const desk = [r.desk_name, r.desk_address].filter(Boolean).join(', ');
  let products = oneLine(String(r.products ?? ''));
  if (products.length > 70) products = `${products.slice(0, 67).replace(/[ ,]+$/, '')}...`;
  return {
    row: r,
    vars: {
      nom: firstName(r.customer_name, lang),
      boutique: shop,
      ref: r.ref,
      produits: products || '-',
      total: money(num(r.total)),
      societe: company,
      suivi: r.tracking || r.ref,
      bureau: oneLine(desk || `${company} ${r.commune || wilaya}`),
      commune: r.commune || wilaya,
      wilaya,
    },
  };
}

// ---------------------------------------------------------------- which case, when
/** The case a delivery status asks for (null: no message). */
export function kindFor(row: { is_stopdesk?: boolean; conf_status?: string | null }, to: string | null): NotifyKind | null {
  if (to === 'shipped') return 'shipped';
  if (to === 'out_for_delivery') return row.is_stopdesk ? 'stopdesk' : 'out_for_delivery';
  if (to === 'failed') return 'failed';
  // the customer cancelled with the shop: "cancelled by the livreur" would be wrong
  if (to === 'returning') return row.conf_status === 'cancelled' ? null : 'returning';
  if (to === 'delivered') return 'delivered';
  return null;
}

/** Whether a message still fits the order now: it may have moved on while the message waited (the night). */
export function stillFits(kind: NotifyKind, row: { conf_status?: string | null; follow_status?: string | null; is_stopdesk?: boolean }): boolean {
  if (kind === 'created') return WAITING_CALL.includes(String(row.conf_status)) && !row.follow_status;
  if (kind === 'confirmed') return row.conf_status === 'confirmed' && (!row.follow_status || row.follow_status === 'to_prepare' || row.follow_status === 'prepared');
  return kindFor(row, row.follow_status ?? null) === kind;
}

/** Algeria is UTC+1 all year. During the quiet hours a message waits for their end. */
export function sendTime(now: number, s: Pick<NotifySettings, 'quietFrom' | 'quietTo'>): number {
  const from = num(s.quietFrom);
  const to = num(s.quietTo);
  if (from === to) return now;
  const h = (new Date(now).getUTCHours() + 1) % 24;
  const quiet = from > to ? h >= from || h < to : h >= from && h < to;
  if (!quiet) return now;
  const d = new Date(now + 3_600_000); // the Algeria clock
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), to) - 3_600_000;
  return next > now ? next : next + 86_400_000;
}
const isQuiet = (now: number, s: Pick<NotifySettings, 'quietFrom' | 'quietTo'>) => sendTime(now, s) !== now;

/** The last moment the gateway phone may still send an SMS: before the next quiet hours, 6 hours at most. */
export function smsValidUntil(now: number, s: Pick<NotifySettings, 'quietFrom' | 'quietTo'>): number {
  const max = now + 6 * 3_600_000;
  const from = num(s.quietFrom);
  if (from === num(s.quietTo)) return max;
  const d = new Date(now + 3_600_000);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), from) - 3_600_000;
  if (start <= now) start += 86_400_000;
  return Math.max(now + 15 * 60_000, Math.min(max, start));
}

/** What a status change needs, read once per action (not once per order of a courier's sync). */
export interface NotifyCtx {
  s: NotifySettings;
  shop: string;
}
export async function notifyContext(db: Db): Promise<NotifyCtx> {
  const s = await notifySettings(db);
  return { s, shop: s.enabled ? (await getSetting(db, 'shop')).name : '' };
}

/**
 * Queueing runs inside the caller's transaction (creating, confirming, shipping orders) behind a savepoint: a problem
 * here never undoes the change of the order itself.
 */
async function guarded(db: Db, fn: () => Promise<void>) {
  await db.query('SAVEPOINT px_notify');
  try {
    await fn();
    await db.query('RELEASE SAVEPOINT px_notify');
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT px_notify');
    await db.query('RELEASE SAVEPOINT px_notify');
  }
}

const CHAT_SKIP = 'Commande prise dans la conversation WhatsApp : le client a déjà la réponse';

/** Queues the message of a case for an order (inside the caller's transaction), unless it is off or already sent. */
async function queue(db: Db, nc: NotifyCtx, row: any, kind: NotifyKind, now: number): Promise<void> {
  const { s } = nc;
  if (!s.enabled || !s.cases[kind]) return;
  if (row.is_exchange && CONF_KINDS.includes(kind)) return; // SAV exchanges: the SAV team talks to the customer
  await guarded(db, async () => {
    const before = (
      await db.query(`SELECT 1 FROM notifications WHERE order_id = $1 AND kind = $2 AND ($3 OR created_at > to_timestamp($4 / 1000.0) - interval '20 hours') LIMIT 1`, [row.id, kind, ONCE.includes(kind), now])
    )[0];
    if (before) return;
    // a newer step replaces this order's messages still waiting (the night, or several statuses in one sync)
    await db.query(`UPDATE notifications SET status = 'skipped', error = 'Remplacé par un message plus récent' WHERE order_id = $1 AND status = 'queued'`, [row.id]);
    const phone = normalizePhone(String(row.phone ?? ''));
    const ov = await orderVars(db, num(row.id), s.lang, nc.shop);
    const body = ov ? render(textOf(s, kind, s.lang), ov.vars) : '';
    // taken by Message AI agent in the customer's WhatsApp chat: the answer is already there
    const why = !phone ? 'Numéro de téléphone invalide' : CONF_KINDS.includes(kind) && ov?.row.conv_channel === 'whatsapp' ? CHAT_SKIP : null;
    await db.query(
      `INSERT INTO notifications (order_id, kind, status, phone, lang, body, send_after, error, created_at) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7 / 1000.0),$8,to_timestamp($9 / 1000.0))`,
      [row.id, kind, why ? 'skipped' : 'queued', phone ?? String(row.phone ?? ''), s.lang, body, sendTime(now, s), why, now],
    );
  });
}

/** createOrder: "we received your order" (or "confirmed" when it is created confirmed). */
export async function onOrderCreated(db: Db, row: { id: number; phone: string; conf_status: string; is_exchange?: boolean }, now: number) {
  const nc = await notifyContext(db);
  if (!nc.s.enabled) return;
  if (row.conf_status === 'confirmed') await queue(db, nc, row, 'confirmed', now);
  else if (row.conf_status === 'new') await queue(db, nc, row, 'created', now);
}

/** setConf: the order is confirmed. */
export async function onConfChange(db: Db, nc: NotifyCtx, row: any, from: string | null, to: string, now: number) {
  if (to === 'confirmed' && from !== 'confirmed') await queue(db, nc, row, 'confirmed', now);
}

/**
 * setFollow: the delivery status changed (a person, the livreur's app, a courier's sync). Not for an order whose last
 * step was more than 15 days ago: a courier's first sync must not message old customers. A parcel leaving now always.
 */
export async function onFollowChange(db: Db, nc: NotifyCtx, row: any, from: string | null, to: string, now: number) {
  if (!nc.s.enabled || from === to) return;
  const kind = kindFor(row, to);
  if (!kind) return;
  if (to !== 'shipped') {
    const last = Math.max(...[row.shipped_at, row.prepared_at, row.confirmed_at, row.created_at].filter(Boolean).map((v) => Date.parse(iso(v))));
    if (Number.isFinite(last) && last < now - 15 * 86_400_000) return;
  }
  await queue(db, nc, row, kind, now);
}

// ---------------------------------------------------------------- sending
/** WhatsApp errors worth trying again in a few minutes (limits, Meta busy, network). */
const WA_RETRY = new Set([130429, 131056, 131000, 131016, 2]);
const errText = (e: any) => oneLine(String(e?.message ?? e ?? 'Erreur')).slice(0, 300);

/** Whether this preview has a server (otherwise sending is simulated: numbers ending in 3 or 7 have no WhatsApp). */
const simulated = (ctx: Ctx) => !ctx.server?.dellal;
export const simulatedHasWhatsApp = (phone: string) => !/[37]$/.test(phone);

async function addHistory(db: Db, orderId: number, channel: string, kind: string, note: string, userId: number | null = null) {
  await db.query('INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,$4,$5,$6)', [orderId, userId, 'chat', channel, kind, note.slice(0, 500)]);
}

/** A problem before anything was handed over: tried again in 10 minutes, 3 times; then it waits in Problems. */
async function retryOrFail(ctx: Ctx, n: any, error: string) {
  const attempts = num(n.attempts) + 1;
  if (attempts < 3)
    await ctx.db.query(`UPDATE notifications SET status = 'queued', attempts = $2, error = $3, send_after = now() + interval '10 minutes', claimed_at = NULL, sending_at = NULL WHERE id = $1`, [n.id, attempts, error]);
  else await ctx.db.query(`UPDATE notifications SET status = 'failed', attempts = $2, error = $3, claimed_at = NULL WHERE id = $1`, [n.id, attempts, error]);
}

/** The moment a message is handed to WhatsApp or the SMS sender: after a crash it is never sent again blindly. */
async function handing(ctx: Ctx, n: any) {
  await ctx.db.query(`UPDATE notifications SET sending_at = now() WHERE id = $1`, [n.id]);
}

/** Sends one message by SMS (gateway), or puts it in the list to send by hand. `why`: why not WhatsApp. */
async function viaSms(ctx: Ctx, s: NotifySettings, n: any, body: string, why: string | null): Promise<void> {
  if (s.sms === 'gateway') {
    let r: any = { id: `sim-sms-${n.id}` };
    if (!simulated(ctx)) {
      await handing(ctx, n);
      try {
        r = await ctx.server!.dellal!('sms', { to: n.phone, text: body, validUntil: new Date(smsValidUntil(ctx.now(), s)).toISOString() }, ctx);
      } catch (e) {
        const m = errText(e);
        return retryOrFail(ctx, n, /^(SMS|Service SMS)/i.test(m) ? m : `SMS : ${m}`);
      }
    }
    n.handed = true;
    await ctx.db.query(
      `UPDATE notifications SET status = 'sms', channel = 'sms', sms_id = $2, sms_status = $3, body = $4, sent_at = now(), error = $5, claimed_at = NULL,
         delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END WHERE id = $1`,
      [n.id, r?.id ? String(r.id) : null, simulated(ctx) ? 'delivered' : 'queued', body, why],
    );
    await addHistory(ctx.db, num(n.order_id), 'sms', n.kind, body);
    return;
  }
  if (s.sms === 'manual') {
    await ctx.db.query(`UPDATE notifications SET status = 'manual', channel = 'manual', body = $2, error = $3, claimed_at = NULL WHERE id = $1`, [n.id, body, why]);
    return;
  }
  await ctx.db.query(`UPDATE notifications SET status = 'failed', body = $2, error = $3, claimed_at = NULL WHERE id = $1`, [n.id, body, why ?? 'Ni WhatsApp ni SMS : rien pour envoyer']);
}

/**
 * Sends one claimed message: WhatsApp (approved template) first, else SMS or the list to send by hand. A message whose
 * WhatsApp did not reach the customer (it has a WhatsApp id) goes by SMS only: the WhatsApp is never sent twice.
 */
async function sendOne(ctx: Ctx, s: NotifySettings, n: any): Promise<void> {
  const lang = (NOTIFY_LANGS as readonly string[]).includes(n.lang) ? (n.lang as NotifyLang) : s.lang;
  const ov = await orderVars(ctx.db, num(n.order_id), lang);
  const fallback = !!n.wa_id;
  const skip = (why: string) =>
    fallback
      ? ctx.db.query(`UPDATE notifications SET status = 'whatsapp', error = $2, claimed_at = NULL WHERE id = $1`, [n.id, `Pas de SMS : ${why.toLowerCase()}`])
      : ctx.db.query(`UPDATE notifications SET status = 'skipped', error = $2, claimed_at = NULL WHERE id = $1`, [n.id, why]);
  if (!ov) return void (await skip('Commande supprimée'));
  if (!stillFits(n.kind, ov.row)) return void (await skip('Le statut de la commande a changé avant l’envoi'));
  if (CONF_KINDS.includes(n.kind) && ov.row.conv_channel === 'whatsapp') return void (await skip(CHAT_SKIP));
  // the number may have been corrected since the message was queued
  const phone = normalizePhone(String(ov.row.phone ?? '')) ?? n.phone;
  if (phone !== n.phone) {
    await ctx.db.query(`UPDATE notifications SET phone = $2 WHERE id = $1`, [n.id, phone]);
    n.phone = phone;
  }
  const text = textOf(s, n.kind, lang);
  const body = render(text, ov.vars);
  if (fallback) return viaSms(ctx, s, n, body, n.error && !/^(SMS|Service SMS)/i.test(n.error) ? n.error : 'WhatsApp pas reçu');
  const sentWa = async (waId: string | null, delivered: boolean) => {
    n.handed = true;
    await ctx.db.query(
      `UPDATE notifications SET status = 'whatsapp', channel = 'whatsapp', wa_id = $2, wa_status = $3, body = $4, sent_at = now(), error = NULL, claimed_at = NULL,
         delivered_at = CASE WHEN $5 THEN now() ELSE delivered_at END WHERE id = $1`,
      [n.id, waId, delivered ? 'delivered' : 'sent', body, delivered],
    );
    await addHistory(ctx.db, num(n.order_id), 'whatsapp', n.kind, body);
    // a status Meta sent before the id was stored
    const early = waId ? (await ctx.db.query(`DELETE FROM notification_early_statuses WHERE wa_id = $1 RETURNING *`, [waId]))[0] : null;
    if (early) await onWhatsAppStatus(ctx, { id: String(waId), status: early.status, code: numOrNull(early.code), title: early.title });
  };
  if (!s.whatsapp) return viaSms(ctx, s, n, body, null);
  if (simulated(ctx)) return simulatedHasWhatsApp(phone) ? sentWa(`sim-wa-${n.id}`, true) : viaSms(ctx, s, n, body, 'Pas de WhatsApp sur ce numéro');
  if (!(await waConnected(ctx.db))) return viaSms(ctx, s, n, body, null);
  const tpl = s.templates[templateKey(n.kind, lang)];
  // only the text Meta approved can be sent: a text changed since goes by SMS until the new one is approved
  if (tpl?.status !== 'APPROVED' || tpl.text !== text)
    return viaSms(ctx, s, n, body, !tpl ? 'Texte pas encore envoyé à Meta pour WhatsApp' : tpl.text !== text ? 'Texte modifié : en attente de validation WhatsApp' : `Modèle WhatsApp ${tpl.status === 'PENDING' ? 'en attente de validation' : 'refusé ou en pause'}`);
  await handing(ctx, n);
  let r: any;
  try {
    r = await ctx.server!.dellal!('waTemplate', { to: phoneIntl(phone), name: tpl.name, lang: TEMPLATE_LANG[lang], params: templateParams(text, ov.vars) }, ctx);
  } catch (e: any) {
    const code = num(e?.metaCode);
    if ((WA_RETRY.has(code) || !code) && num(n.attempts) < 2) {
      await ctx.db.query(`UPDATE notifications SET status = 'queued', attempts = attempts + 1, error = $2, send_after = now() + interval '10 minutes', claimed_at = NULL, sending_at = NULL WHERE id = $1`, [n.id, `WhatsApp : ${errText(e)}`]);
      return;
    }
    return viaSms(ctx, s, n, body, `WhatsApp : ${errText(e)}`);
  }
  await sentWa(r?.id ? String(r.id) : null, false);
}

/** Messages "to send by hand" whose order moved on: no outdated news. */
async function expireManual(db: Db) {
  const rows = await db.query(`SELECT n.id, n.kind, o.conf_status, o.follow_status, o.is_stopdesk FROM notifications n JOIN orders o ON o.id = n.order_id WHERE n.status = 'manual'`);
  for (const r of rows)
    if (!stillFits(r.kind, r)) await db.query(`UPDATE notifications SET status = 'skipped', error = 'Le statut de la commande a changé avant l’envoi' WHERE id = $1 AND status = 'manual'`, [r.id]);
}

/** Runs one claimed message; a problem before it was handed over is tried again later, never one after. */
async function runOne(ctx: Ctx, s: NotifySettings, n: any): Promise<boolean> {
  try {
    await sendOne(ctx, s, n);
    return true;
  } catch (e) {
    // already handed to WhatsApp or the SMS sender (a database problem just after): not sent again blindly, the lease
    // below puts it in Problems for a person to check
    if (!n.handed) await retryOrFail(ctx, n, errText(e)).catch(() => null);
    return false;
  }
}

/** Sends the messages due now (the server's job every minute; in the preview after each change). */
export async function runQueue(ctx: Ctx, limit = 50): Promise<{ sent: number; fallback: number }> {
  const s = await notifySettings(ctx.db);
  if (!s.enabled) return { sent: 0, fallback: 0 };
  const now = ctx.now();
  // a run that died (restart, crash): what it had not handed over goes back to the queue; what it had handed over is
  // not sent again blindly, it waits in Problems
  await ctx.db.query(`UPDATE notifications SET status = 'queued', claimed_at = NULL WHERE status = 'sending' AND sending_at IS NULL AND claimed_at < to_timestamp($1 / 1000.0) - interval '10 minutes'`, [now]);
  await ctx.db.query(
    `UPDATE notifications SET status = 'failed', claimed_at = NULL, error = 'Envoi interrompu : vérifiez avec le client avant de renvoyer' WHERE status = 'sending' AND sending_at IS NOT NULL AND claimed_at < to_timestamp($1 / 1000.0) - interval '10 minutes'`,
    [now],
  );
  await ctx.db.query(`DELETE FROM notification_early_statuses WHERE at < now() - interval '1 day'`);
  await expireManual(ctx.db);
  // the night: nothing leaves (retries and SMS fallbacks included); what is due waits for the morning
  if (isQuiet(now, s)) {
    await ctx.db.query(`UPDATE notifications SET send_after = to_timestamp($1 / 1000.0) WHERE status = 'queued' AND send_after < to_timestamp($1 / 1000.0)`, [sendTime(now, s)]);
    return { sent: 0, fallback: 0 };
  }
  // A WhatsApp still not received an hour later (WhatsApp exists but nobody uses it: a changed phone…): it goes by SMS,
  // through the normal queue (the order and the number are checked again; the WhatsApp is not sent again).
  let fallback = 0;
  if (!simulated(ctx) && s.sms !== 'off') {
    const stale = await ctx.db.query(
      `UPDATE notifications SET status = 'queued', send_after = to_timestamp($1 / 1000.0), attempts = 0, error = 'WhatsApp pas reçu après 1 h', claimed_at = NULL, sending_at = NULL
       WHERE status = 'whatsapp' AND id IN (
         SELECT id FROM notifications WHERE status = 'whatsapp' AND wa_status = 'sent' AND delivered_at IS NULL AND sms_id IS NULL AND error IS NULL
           AND sent_at < to_timestamp($1 / 1000.0) - interval '1 hour' AND sent_at > to_timestamp($1 / 1000.0) - interval '2 days' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [now, limit],
    );
    fallback = stale.length;
  }
  // claimed once even when two runs overlap (the job and the cron hook)
  const claimed = await ctx.db.query(
    `UPDATE notifications SET status = 'sending', claimed_at = to_timestamp($1 / 1000.0), sending_at = NULL WHERE status = 'queued' AND id IN (
       SELECT id FROM notifications WHERE status = 'queued' AND send_after <= to_timestamp($1 / 1000.0) ORDER BY send_after, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [now, limit],
  );
  let sent = 0;
  for (const n of claimed) if (await runOne(ctx, s, n)) sent++;
  if (claimed.length || fallback) ctx.emit({ type: 'chat', data: { notify: true } });
  return { sent, fallback };
}

/** In the preview nothing runs in the background: a status change sends its message at once (simulated). */
export async function sendInPreview(ctx: Ctx) {
  if (simulated(ctx)) await runQueue(ctx).catch(() => null);
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** A WhatsApp status from Meta's webhook: delivered, read, or failed → SMS (once, through the queue). */
export async function onWhatsAppStatus(ctx: Ctx, ev: { id: string; status: string; code?: number | null; title?: string | null }) {
  const n = (await ctx.db.query(`SELECT * FROM notifications WHERE wa_id = $1`, [ev.id]))[0];
  if (!n) {
    // our message whose id is not stored yet (Meta can be faster than us), or a chat message: kept a day
    const cur = RANK[ev.status] ? (await ctx.db.query(`SELECT status FROM notification_early_statuses WHERE wa_id = $1`, [ev.id]))[0] : null;
    if (RANK[ev.status] && (!cur || RANK[ev.status] > (RANK[cur.status] ?? 0)))
      await ctx.db.query(
        `INSERT INTO notification_early_statuses (wa_id, status, code, title) VALUES ($1,$2,$3,$4)
         ON CONFLICT (wa_id) DO UPDATE SET status = EXCLUDED.status, code = EXCLUDED.code, title = EXCLUDED.title, at = now()`,
        [ev.id, ev.status, ev.code ?? null, ev.title ?? null],
      );
    return { ok: false };
  }
  if (ev.status === 'delivered') await ctx.db.query(`UPDATE notifications SET wa_status = CASE WHEN wa_status = 'read' THEN 'read' ELSE 'delivered' END, delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [n.id]);
  else if (ev.status === 'read') await ctx.db.query(`UPDATE notifications SET wa_status = 'read', read_at = COALESCE(read_at, now()), delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [n.id]);
  else if (ev.status === 'failed') {
    // not received on WhatsApp (no WhatsApp on this number, Meta limits…): the customer gets it by SMS. Taken only from
    // 'whatsapp', so a status sent twice by Meta, or the 1-hour fallback at the same moment, gives one SMS.
    const s = await notifySettings(ctx.db);
    const why = `WhatsApp : ${ev.title || 'non livré'}${ev.code ? ` (${ev.code})` : ''}`;
    if (s.sms === 'off') await ctx.db.query(`UPDATE notifications SET wa_status = 'failed', status = 'failed', error = $2 WHERE id = $1 AND status = 'whatsapp'`, [n.id, why]);
    else
      await ctx.db.query(
        `UPDATE notifications SET wa_status = 'failed', status = 'queued', send_after = to_timestamp($2 / 1000.0), attempts = 0, error = $3, claimed_at = NULL, sending_at = NULL WHERE id = $1 AND status = 'whatsapp'`,
        [n.id, sendTime(ctx.now(), s), why],
      );
    await ctx.db.query(`UPDATE notifications SET wa_status = 'failed' WHERE id = $1`, [n.id]);
    await sendInPreview(ctx);
  }
  ctx.emit({ type: 'chat', data: { notify: true } });
  return { ok: true };
}

/** An SMS gateway event: sent, delivered, failed, or an SMS received from a customer (their answer). */
export async function onSmsEvent(ctx: Ctx, ev: { event: string; id?: string | null; phone?: string | null; text?: string | null; reason?: string | null }) {
  if (ev.event === 'received') {
    const phone = ev.phone ? normalizePhone(ev.phone) : null;
    const id = phone && ev.text ? await markReply(ctx.db, phone, ev.text, 'sms') : null;
    if (id) ctx.emit({ type: 'chat', data: { notify: true } });
    return { ok: !!id };
  }
  const n = ev.id ? (await ctx.db.query(`SELECT id FROM notifications WHERE sms_id = $1`, [ev.id]))[0] : null;
  if (!n) return { ok: false };
  if (ev.event === 'sent') await ctx.db.query(`UPDATE notifications SET sms_status = CASE WHEN sms_status = 'delivered' THEN sms_status ELSE 'sent' END WHERE id = $1`, [n.id]);
  if (ev.event === 'delivered') await ctx.db.query(`UPDATE notifications SET sms_status = 'delivered', delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [n.id]);
  if (ev.event === 'failed') await ctx.db.query(`UPDATE notifications SET sms_status = 'failed', status = 'failed', error = $2 WHERE id = $1`, [n.id, `SMS : ${ev.reason || 'non livré'}`]);
  ctx.emit({ type: 'chat', data: { notify: true } });
  return { ok: true };
}

// ---------------------------------------------------------------- the customer's answers (Message AI agent)
/** The latest message sent to this number in the last 5 days (what the customer is answering). */
async function lastSent(db: Db, phone: string) {
  return (
    await db.query(
      `SELECT n.*, o.ref FROM notifications n JOIN orders o ON o.id = n.order_id
       WHERE n.phone = $1 AND n.status IN ('whatsapp','sms','done') AND n.sent_at > now() - interval '5 days' ORDER BY n.sent_at DESC, n.id DESC LIMIT 1`,
      [phone],
    )
  )[0];
}

/** The customer answered (WhatsApp or SMS) within 5 days of a message: noted on it (the first answer) and in the order's history. */
export async function markReply(db: Db, phone: string, text: string, via: 'whatsapp' | 'sms'): Promise<number | null> {
  const n = await lastSent(db, phone);
  if (!n) return null;
  if (n.replied_at) return num(n.id);
  await db.query(`UPDATE notifications SET replied_at = now(), reply = $2 WHERE id = $1`, [n.id, text.slice(0, 1000)]);
  await addHistory(db, num(n.order_id), via, 'reply', text);
  return num(n.id);
}

/**
 * The message to show before the customer's first answer in their WhatsApp conversation: the latest one sent to this
 * number in the last 5 days, newer than everything in the conversation, and not shown yet.
 */
export async function noticeForConversation(db: Db, phone: string, convId: number): Promise<{ id: number; kind: NotifyKind; body: string; ref: string; channel: string; sentAt: string } | null> {
  const n = await lastSent(db, phone);
  if (!n) return null;
  const seen = (
    await db.query(
      `SELECT (SELECT max(created_at) FROM conv_messages WHERE conversation_id = $1) AS last,
              EXISTS (SELECT 1 FROM conv_messages WHERE conversation_id = $1 AND meta->>'notifyId' = $2) AS shown`,
      [convId, String(n.id)],
    )
  )[0];
  if (seen?.shown || (seen?.last && Date.parse(iso(seen.last)) > Date.parse(iso(n.sent_at)))) return null;
  return { id: num(n.id), kind: n.kind, body: n.body, ref: n.ref, channel: n.channel ?? 'manual', sentAt: iso(n.sent_at) };
}

const CONF_WORDS: Record<string, string> = {
  to_check: 'à vérifier par l’équipe',
  new: 'pas encore confirmée (un conseiller va appeler)',
  no_answer: 'pas encore confirmée (appel sans réponse)',
  busy: 'pas encore confirmée (ligne occupée)',
  callback: 'pas encore confirmée (rappel prévu)',
  postponed: 'reportée à la demande du client',
  no_stock: 'confirmée, en attente de stock',
  confirmed: 'confirmée',
  cancelled: 'annulée',
  duplicate: 'annulée (doublon)',
  wrong_number: 'annulée (mauvais numéro)',
  fake: 'annulée',
};
const FOLLOW_WORDS: Record<string, string> = {
  to_prepare: 'confirmée, en préparation',
  prepared: 'prête, pas encore expédiée',
  shipped: 'expédiée, en route vers sa wilaya',
  out_for_delivery: 'avec le livreur, livraison aujourd’hui',
  failed: 'tentative de livraison échouée',
  alert: 'problème signalé par la société de livraison',
  in_exchange: 'échange en cours',
  delivered: 'livrée',
  returning: 'annulée par le livreur, retour en cours',
  returned: 'revenue au dépôt',
  exchanged: 'échangée',
  lost: 'perdue par la société de livraison',
  cancelled: 'annulée',
};

export const KIND_FR: Record<NotifyKind, string> = {
  created: 'Commande reçue',
  confirmed: 'Commande confirmée',
  shipped: 'Expédiée',
  out_for_delivery: 'Avec le livreur',
  stopdesk: 'Au bureau',
  failed: 'Livraison échouée',
  returning: 'Annulée par le livreur',
  delivered: 'Livrée',
};

/** "22/10 14:05", Algeria time (UTC+1). */
const dzTime = (v: unknown) => {
  const d = new Date(Date.parse(iso(v)) + 3_600_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/**
 * The customer's recent orders, for Dellal (what the delivery messages told them, and where each order is): the orders
 * of the WhatsApp number writing (WhatsApp proves the number), or the orders taken in this conversation. A number typed
 * in a Messenger or Instagram chat proves nothing, so it gives nothing.
 */
export async function ordersForDellal(db: Db, phone: string | null, convId: number | null): Promise<string> {
  if (!phone && !convId) return '';
  const rows = await db.query(
    `SELECT o.id, o.ref, o.conf_status, o.follow_status, o.is_stopdesk, o.total, o.tracking, c.name AS company_name,
       (SELECT string_agg(i.name || CASE WHEN i.qty > 1 THEN ' x' || i.qty ELSE '' END, ', ') FROM order_items i WHERE i.order_id = o.id) AS products,
       (SELECT n.kind FROM notifications n WHERE n.order_id = o.id AND n.status IN ('whatsapp','sms','done') ORDER BY n.sent_at DESC LIMIT 1) AS last_kind,
       (SELECT n.sent_at FROM notifications n WHERE n.order_id = o.id AND n.status IN ('whatsapp','sms','done') ORDER BY n.sent_at DESC LIMIT 1) AS last_at
     FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
     WHERE (o.phone = $1 OR o.conversation_id = $2) AND NOT o.is_exchange AND o.created_at > now() - interval '45 days' ORDER BY o.created_at DESC LIMIT 5`,
    [phone, convId],
  );
  if (!rows.length) return '';
  const lines = rows.map((r: any) => {
    const status = r.follow_status === 'out_for_delivery' && r.is_stopdesk ? 'arrivée au bureau, à récupérer' : FOLLOW_WORDS[r.follow_status] ?? CONF_WORDS[r.conf_status] ?? r.conf_status;
    const kind = r.last_kind as NotifyKind | null;
    const at = r.last_at ? dzTime(r.last_at) : '';
    return (
      `- ${r.ref} (${String(r.products ?? '').slice(0, 80)}) : ${status}, ${money(num(r.total))} DA à payer à la livraison` +
      (r.company_name && r.follow_status && !['to_prepare', 'prepared', 'cancelled'].includes(r.follow_status) ? `, avec ${r.company_name}` : '') +
      (r.tracking ? `, suivi ${r.tracking}` : '') +
      (kind ? ` — dernier message automatique : « ${KIND_FR[kind] ?? kind} » le ${at}` : '')
    );
  });
  return [
    `Commandes récentes de ce client :\n${lines.join('\n')}`,
    `Messages de suivi (le client répond souvent à un message automatique de la boutique) :`,
    `- Question sur sa commande : réponds avec ces informations (statut, société, numéro de suivi, total à payer), en une ou deux phrases. N’invente jamais une date ou une heure de livraison.`,
    `- Il veut toujours une commande que le livreur n’a pas pu livrer ou a annulée : remercie-le, dis que l’équipe la renvoie, et passe la main (handoff, raison « renvoyer <référence> »).`,
    `- Il confirme une commande pas encore confirmée (« wah », « oui ») : remercie-le et passe la main (handoff, raison « confirme <référence> par message »).`,
    `- Changement d’adresse, de date ou de produit, annulation, plainte sur le livreur : passe la main (handoff) avec la référence.`,
    `- Un simple merci : réponds en quelques mots, sans passer la main.`,
  ].join('\n');
}

// ---------------------------------------------------------------- the list for the app
export interface NotifyRow {
  id: number;
  orderId: number;
  ref: string;
  customerName: string;
  phone: string;
  kind: NotifyKind;
  status: NotifyStatus;
  channel: 'whatsapp' | 'sms' | 'manual' | null;
  waStatus: string | null;
  smsStatus: string | null;
  body: string;
  error: string | null;
  sendAfter: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  reply: string | null;
  sentBy: string | null;
  followStatus: string | null;
  confStatus: string | null;
  conversationId: number | null;
  sms: { parts: number; unicode: boolean; length: number };
  at: string;
}

const toRow = (r: any): NotifyRow => ({
  id: num(r.id),
  orderId: num(r.order_id),
  ref: r.ref,
  customerName: r.customer_name,
  phone: r.phone,
  kind: r.kind,
  status: r.status,
  channel: r.channel ?? null,
  waStatus: r.wa_status ?? null,
  smsStatus: r.sms_status ?? null,
  body: r.body,
  error: r.error ?? null,
  sendAfter: iso(r.send_after),
  sentAt: isoOrNull(r.sent_at),
  deliveredAt: isoOrNull(r.delivered_at),
  readAt: isoOrNull(r.read_at),
  repliedAt: isoOrNull(r.replied_at),
  reply: r.reply ?? null,
  sentBy: r.sent_by_name ?? null,
  followStatus: r.follow_status ?? null,
  confStatus: r.conf_status ?? null,
  conversationId: numOrNull(r.conversation_id),
  sms: smsParts(String(r.body ?? '')),
  at: iso(r.created_at),
});

const COLS = `n.*, o.ref, o.customer_name, o.follow_status, o.conf_status, p.name AS sent_by_name,
  (SELECT v.id FROM conversations v WHERE v.channel = 'whatsapp' AND v.phone = n.phone ORDER BY v.id DESC LIMIT 1) AS conversation_id`;
const FROM = `FROM notifications n JOIN orders o ON o.id = n.order_id LEFT JOIN profiles p ON p.id = n.sent_by`;

/** Example values for the texts when no order is chosen. */
const exampleVars = (shop: string, lang: NotifyLang): NotifyVars => ({
  nom: lang === 'ar' ? 'أمينة' : 'Amina',
  boutique: shop,
  ref: 'PX2041',
  produits: 'Poussette Confort Gris',
  total: '13 200',
  societe: 'Yalidine',
  suivi: 'YAL-48213',
  bureau: 'Yalidine Bab Ezzouar',
  commune: 'Bab Ezzouar',
  wilaya: 'Alger',
});

async function settingsView(ctx: Ctx) {
  const s = await notifySettings(ctx.db);
  const shop = (await getSetting(ctx.db, 'shop')).name;
  const ex = exampleVars(shop, s.lang);
  const { templates, ...rest } = s;
  return {
    settings: rest,
    cases: NOTIFY_KINDS.map((kind) => {
      const text = textOf(s, kind, s.lang);
      const t = templates[templateKey(kind, s.lang)];
      const example = render(text, ex);
      return {
        kind,
        on: s.cases[kind],
        text,
        custom: !!s.texts?.[kind]?.[s.lang]?.trim(),
        defaultText: DEFAULT_TEXTS[kind][s.lang],
        example,
        sms: smsParts(example),
        template: t ? { name: t.name, status: t.text === text ? t.status : 'CHANGED', reason: t.reason ?? null } : null,
      };
    }),
    vars: NOTIFY_VARS,
    meta: {
      whatsappConnected: simulated(ctx) ? true : await waConnected(ctx.db),
      /** without the Meta app secret, WhatsApp delivery reports are not trusted (not signed) */
      appSecret: simulated(ctx) ? true : !!(await raw<string>(ctx.db, 'secret_dellal_meta_app_secret', '')),
      smsSecret: !!(await raw<string>(ctx.db, NOTIFY_SMS_SECRET, '')),
      demo: simulated(ctx),
    },
  };
}
export type NotifySettingsView = Awaited<ReturnType<typeof settingsView>>;

// ---------------------------------------------------------------- actions
const id = z.number().int().positive();
/** The delivery follow-up team, and the sellers who confirm the orders. */
const ROLES = ['suivi', 'confirmation'] as const;
const me = (ctx: Ctx) => ctx.session.profile.id;

const SettingsInput = z.object({
  enabled: z.boolean(),
  lang: z.enum(NOTIFY_LANGS),
  cases: z.object(Object.fromEntries(NOTIFY_KINDS.map((k) => [k, z.boolean()])) as Record<NotifyKind, z.ZodBoolean>),
  texts: z.record(z.enum(NOTIFY_KINDS), z.record(z.enum(NOTIFY_LANGS), z.string().max(700))).default({}),
  whatsapp: z.boolean(),
  sms: z.enum(['gateway', 'manual', 'off']),
  smsProvider: z.enum(['android', 'http']),
  smsUrl: z.string().trim().max(300),
  smsUser: z.string().trim().max(120),
  quietFrom: z.number().int().min(0).max(23),
  quietTo: z.number().int().min(0).max(23),
  wabaId: z.string().trim().max(40).regex(/^\d*$/, 'ID du compte WhatsApp Business : des chiffres'),
  /** the SMS gateway's password or token: a value replaces, '' keeps, null removes */
  smsSecret: z.string().max(500).nullable().default(''),
});

function randomKey() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = (globalThis as any).crypto.getRandomValues(new Uint8Array(24)) as Uint8Array;
  return 'sms-' + Array.from(bytes, (b) => a[b % a.length]).join('');
}

export const notifyProcs = {
  /** The messages, newest first, with the counts of the tabs. */
  'notify.feed': proc(
    [...ROLES],
    z.object({
      tab: z.enum(['all', 'todo', 'waiting', 'whatsapp', 'sms', 'problems', 'replies']).default('all'),
      kind: z.enum(NOTIFY_KINDS).optional(),
      q: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(300).default(100),
    }),
    async (ctx, i) => {
      await sendInPreview(ctx);
      const w: string[] = [];
      const p: unknown[] = [];
      if (i.kind) w.push(`n.kind = $${p.push(i.kind)}`);
      if (i.q?.trim()) w.push(`(o.ref ILIKE '%' || $${p.push(i.q.trim())} || '%' OR o.customer_name ILIKE '%' || $${p.length} || '%' OR n.phone LIKE '%' || $${p.length} || '%')`);
      const tab: Record<typeof i.tab, string> = {
        all: 'true',
        todo: `n.status = 'manual'`,
        waiting: `n.status IN ('queued','sending')`,
        whatsapp: `n.channel = 'whatsapp'`,
        sms: `n.channel = 'sms'`,
        problems: `n.status = 'failed'`,
        replies: `n.replied_at IS NOT NULL`,
      };
      w.push(tab[i.tab]);
      const rows = await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE ${w.join(' AND ')} ORDER BY n.created_at DESC, n.id DESC LIMIT ${i.limit}`, p);
      const k = (
        await ctx.db.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'manual')::int AS todo, count(*) FILTER (WHERE status IN ('queued','sending'))::int AS waiting,
                  count(*) FILTER (WHERE channel = 'whatsapp')::int AS whatsapp, count(*) FILTER (WHERE channel = 'sms')::int AS sms,
                  count(*) FILTER (WHERE status = 'failed')::int AS problems, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replies
           FROM notifications`,
        )
      )[0];
      const s = await notifySettings(ctx.db);
      return {
        rows: rows.map(toRow),
        counts: { all: num(k.total), todo: num(k.todo), waiting: num(k.waiting), whatsapp: num(k.whatsapp), sms: num(k.sms), problems: num(k.problems), replies: num(k.replies) },
        enabled: s.enabled,
        sms: s.sms,
        demo: simulated(ctx),
      };
    },
  ),

  /** A message sent by hand (from the "to send" list): done. */
  'notify.markSent': proc([...ROLES], z.object({ id, via: z.enum(['whatsapp', 'sms']).default('sms') }), async (ctx, i) => {
    const n = (await ctx.db.query(`UPDATE notifications SET status = 'done', channel = 'manual', sent_at = now(), sent_by = $2, error = NULL, claimed_at = NULL WHERE id = $1 AND status IN ('manual','failed','queued') RETURNING *`, [i.id, me(ctx)]))[0];
    if (!n) throw notFound('Message introuvable ou déjà envoyé');
    await addHistory(ctx.db, num(n.order_id), `manual_${i.via}`, n.kind, n.body, me(ctx));
    ctx.emit({ type: 'chat', data: { notify: true } });
    return { ok: true };
  }),

  /** Send now (a message waiting for the morning), or again (a failed or skipped one). */
  'notify.sendNow': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const n = (
      await ctx.db.query(
        `UPDATE notifications SET status = 'sending', send_after = now(), attempts = 0, claimed_at = to_timestamp($2 / 1000.0), sending_at = NULL WHERE id = $1 AND status IN ('queued','failed','skipped','manual') RETURNING *`,
        [i.id, ctx.now()],
      )
    )[0];
    if (!n) throw notFound('Message introuvable ou déjà envoyé');
    await runOne(ctx, await notifySettings(ctx.db), n);
    ctx.emit({ type: 'chat', data: { notify: true } });
    return toRow((await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE n.id = $1`, [i.id]))[0]);
  }),

  /** Do not send this one. */
  'notify.skip': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    await ctx.db.query(`UPDATE notifications SET status = 'skipped', error = 'Annulé par une personne', sent_by = $2 WHERE id = $1 AND status IN ('queued','manual','failed')`, [i.id, me(ctx)]);
    ctx.emit({ type: 'chat', data: { notify: true } });
    return { ok: true };
  }),

  /** A text for an order (or the example), as the customer would read it, with its WhatsApp template form. */
  'notify.preview': proc(
    [...ROLES],
    z.object({ kind: z.enum(NOTIFY_KINDS), ref: z.string().trim().max(40).optional(), lang: z.enum(NOTIFY_LANGS).optional(), text: z.string().max(700).optional() }),
    async (ctx, i) => {
      const s = await notifySettings(ctx.db);
      const lang = i.lang ?? s.lang;
      const o = i.ref ? (await ctx.db.query(`SELECT id FROM orders WHERE ref = $1`, [i.ref.toUpperCase()]))[0] : null;
      if (i.ref && !o) throw notFound('Commande introuvable');
      const ov = o ? await orderVars(ctx.db, num(o.id), lang) : null;
      const vars = ov?.vars ?? exampleVars((await getSetting(ctx.db, 'shop')).name, lang);
      const text = i.text?.trim() || textOf(s, i.kind, lang);
      const body = render(text, vars);
      return { body, template: templateBody(text), params: templateParams(text, vars), sms: smsParts(body), problems: textProblems(text), phone: ov?.row.phone ?? null, ref: ov?.row.ref ?? null };
    },
  ),

  /** Sends one case to a phone number, to try (nothing is stored on an order). Admins only: each one is billed. */
  'notify.test': proc([], z.object({ phone: z.string().min(9).max(20), kind: z.enum(NOTIFY_KINDS), ref: z.string().trim().max(40).optional() }), async (ctx, i) => {
    const phone = normalizePhone(i.phone);
    if (!phone) throw bad('Numéro algérien invalide');
    const s = await notifySettings(ctx.db);
    const o = i.ref ? (await ctx.db.query(`SELECT id FROM orders WHERE ref = $1`, [i.ref.toUpperCase()]))[0] : null;
    const ov = o ? await orderVars(ctx.db, num(o.id), s.lang) : null;
    const vars = ov?.vars ?? exampleVars((await getSetting(ctx.db, 'shop')).name, s.lang);
    const text = textOf(s, i.kind, s.lang);
    const body = render(text, vars);
    if (simulated(ctx)) {
      const channel = s.whatsapp && simulatedHasWhatsApp(phone) ? 'whatsapp' : s.sms === 'gateway' ? 'sms' : s.sms === 'manual' ? 'manual' : 'none';
      return { channel, body, demo: true, error: null as string | null };
    }
    const tpl = s.templates[templateKey(i.kind, s.lang)];
    let error: string | null = null;
    if (s.whatsapp && (await waConnected(ctx.db))) {
      if (tpl?.status === 'APPROVED' && tpl.text === text) {
        try {
          await ctx.server!.dellal!('waTemplate', { to: phoneIntl(phone), name: tpl.name, lang: TEMPLATE_LANG[s.lang], params: templateParams(text, vars) }, ctx);
          return { channel: 'whatsapp', body, demo: false, error: null };
        } catch (e) {
          error = `WhatsApp : ${errText(e)}`;
        }
      } else error = 'WhatsApp : texte pas encore validé par Meta';
    }
    if (s.sms === 'gateway') {
      await ctx.server!.dellal!('sms', { to: phone, text: body }, ctx);
      return { channel: 'sms', body, demo: false, error };
    }
    return { channel: 'manual', body, demo: false, error: error ?? 'Pas d’envoi automatique : à envoyer à la main' };
  }),

  /** Results over the last N days. */
  'notify.stats': proc([...ROLES], z.object({ days: z.number().int().min(1).max(365).default(7) }), async (ctx, i) => {
    const k = (
      await ctx.db.query(
        `SELECT count(*) FILTER (WHERE status IN ('whatsapp','sms','done'))::int AS sent,
                count(*) FILTER (WHERE status = 'whatsapp')::int AS whatsapp,
                count(*) FILTER (WHERE status = 'sms')::int AS sms,
                count(*) FILTER (WHERE status = 'done')::int AS manual_done,
                count(*) FILTER (WHERE status = 'manual')::int AS todo,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE read_at IS NOT NULL)::int AS read,
                count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
                count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
                count(*) FILTER (WHERE status = 'sms' AND wa_id IS NOT NULL)::int AS fallback
         FROM notifications WHERE created_at > now() - make_interval(days => $1)`,
        [i.days],
      )
    )[0];
    const byKind = await ctx.db.query(
      `SELECT kind, count(*) FILTER (WHERE status IN ('whatsapp','sms','done'))::int AS n, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS r
       FROM notifications WHERE created_at > now() - make_interval(days => $1) GROUP BY 1`,
      [i.days],
    );
    // orders saved: the customer was told about a failed attempt or a cancellation, and the parcel was delivered after all
    const saved = (
      await ctx.db.query(
        `SELECT count(*)::int AS n, COALESCE(sum(total), 0)::bigint AS amount FROM orders o
         WHERE o.follow_status = 'delivered' AND EXISTS (SELECT 1 FROM notifications n WHERE n.order_id = o.id AND n.kind IN ('failed','returning')
           AND n.status IN ('whatsapp','sms','done') AND n.created_at > now() - make_interval(days => $1))`,
        [i.days],
      )
    )[0];
    return {
      sent: num(k.sent),
      whatsapp: num(k.whatsapp),
      sms: num(k.sms),
      manualDone: num(k.manual_done),
      todo: num(k.todo),
      failed: num(k.failed),
      read: num(k.read),
      delivered: num(k.delivered),
      replied: num(k.replied),
      fallback: num(k.fallback),
      saved: num(saved.n),
      savedAmount: num(saved.amount),
      byKind: Object.fromEntries(byKind.map((r: any) => [r.kind, { sent: num(r.n), replied: num(r.r) }])) as Partial<Record<NotifyKind, { sent: number; replied: number }>>,
    };
  }),

  /** The cases and their texts, for everyone who sees the agent (the settings themselves are for admins). */
  'notify.cases': proc([...ROLES], z.object({}), async (ctx) => {
    const v = await settingsView(ctx);
    return { enabled: v.settings.enabled, lang: v.settings.lang, sms: v.settings.sms, whatsapp: v.settings.whatsapp, quietFrom: v.settings.quietFrom, quietTo: v.settings.quietTo, cases: v.cases, vars: v.vars, meta: v.meta };
  }),

  'notify.settings.get': proc([], z.object({}), async (ctx) => {
    const s = await notifySettings(ctx.db);
    if (!s.hookKey) await saveRaw(ctx.db, 'notify', { ...s, hookKey: randomKey() }, me(ctx));
    return settingsView(ctx);
  }),

  'notify.settings.save': proc([], SettingsInput, async (ctx, i) => {
    const cur = await notifySettings(ctx.db);
    const { smsSecret, ...rest } = i;
    // texts equal to the default are not kept (a better default later reaches the shop)
    const texts: NotifySettings['texts'] = {};
    for (const k of NOTIFY_KINDS)
      for (const l of NOTIFY_LANGS) {
        const t = rest.texts?.[k]?.[l]?.trim();
        if (!t || t === DEFAULT_TEXTS[k][l]) continue;
        const problems = textProblems(t);
        if (problems.length) throw bad(`${KIND_FR[k]} : ${problems[0]}`);
        (texts[k] ??= {})[l] = t;
      }
    if (rest.sms === 'gateway' && !rest.smsUrl) throw bad('Adresse du service SMS manquante');
    await saveRaw(ctx.db, 'notify', { ...cur, ...rest, texts, hookKey: cur.hookKey || randomKey() }, me(ctx));
    // stopped: what was waiting is not sent later
    if (cur.enabled && !rest.enabled) await ctx.db.query(`UPDATE notifications SET status = 'skipped', error = 'Delivery AI agent arrêté' WHERE status = 'queued'`);
    if (smsSecret === null) await ctx.db.query('DELETE FROM settings WHERE key = $1', [NOTIFY_SMS_SECRET]);
    else if (smsSecret?.trim()) await saveRaw(ctx.db, NOTIFY_SMS_SECRET, smsSecret.trim(), me(ctx));
    ctx.emit({ type: 'settings' });
    return settingsView(ctx);
  }),

  /** Sends the texts of the cases that are on to Meta for approval (WhatsApp templates, category Utility). */
  'notify.templates.submit': proc([], z.object({}), async (ctx) => {
    const s = await notifySettings(ctx.db);
    const ex = exampleVars((await getSetting(ctx.db, 'shop')).name, s.lang);
    const results: { kind: NotifyKind; ok: boolean; message?: string }[] = [];
    const updates: Record<string, NotifyTemplate> = {};
    if (!simulated(ctx) && !s.wabaId) throw bad('Ajoutez l’ID du compte WhatsApp Business (Réglages)');
    for (const kind of NOTIFY_KINDS) {
      if (!s.cases[kind]) continue;
      const key = templateKey(kind, s.lang);
      const text = textOf(s, kind, s.lang);
      const cur = s.templates[key];
      if (cur && cur.text === text && !['REJECTED', 'DISABLED'].includes(cur.status)) continue;
      const version = cur ? cur.version + 1 : 1;
      const name = `pilotix_${kind}_${s.lang}${version > 1 ? `_v${version}` : ''}`;
      try {
        if (!simulated(ctx)) await ctx.server!.dellal!('waCreateTemplate', { wabaId: s.wabaId, name, lang: TEMPLATE_LANG[s.lang], body: templateBody(text), example: templateParams(text, ex) }, ctx);
        updates[key] = { name, text, status: 'PENDING', version, reason: null };
        results.push({ kind, ok: true });
      } catch (e) {
        results.push({ kind, ok: false, message: errText(e) });
      }
    }
    const latest = await notifySettings(ctx.db);
    await saveRaw(ctx.db, 'notify', { ...latest, templates: { ...latest.templates, ...updates } }, me(ctx));
    return { results, view: await settingsView(ctx) };
  }),

  /** Reads the templates' approval at Meta (in the preview, Meta "approves" at once). */
  'notify.templates.check': proc([], z.object({}), async (ctx) => {
    const s = await notifySettings(ctx.db);
    let list: { name: string; status: string; reason?: string | null }[] = [];
    if (simulated(ctx)) list = Object.values(s.templates).map((t) => ({ name: t.name, status: t.status === 'PENDING' ? 'APPROVED' : t.status, reason: t.reason ?? null }));
    else {
      if (!s.wabaId) throw bad('Ajoutez l’ID du compte WhatsApp Business (Réglages)');
      list = (await ctx.server!.dellal!('waTemplates', { wabaId: s.wabaId }, ctx)) as typeof list;
    }
    // read again after Meta answered: only the templates' approval is written back
    const latest = await notifySettings(ctx.db);
    for (const t of Object.values(latest.templates)) {
      const m = list.find((x) => x.name === t.name);
      if (m) {
        t.status = m.status;
        t.reason = m.reason ?? null;
      }
    }
    await saveRaw(ctx.db, 'notify', latest, me(ctx));
    return settingsView(ctx);
  }),

  /** Connects the SMS gateway's delivery reports and the customers' SMS answers to this server. */
  'notify.smsHooks': proc([], z.object({ baseUrl: z.string().url().max(300) }), async (ctx, i) => {
    const s = await notifySettings(ctx.db);
    if (s.smsProvider !== 'android') throw bad('Seulement pour SMS Gateway for Android');
    const key = s.hookKey || randomKey();
    if (!s.hookKey) await saveRaw(ctx.db, 'notify', { ...s, hookKey: key }, me(ctx));
    const url = `${i.baseUrl.replace(/\/+$/, '')}/api/hooks/sms?key=${encodeURIComponent(key)}`;
    if (simulated(ctx)) return { ok: true, url, demo: true };
    await ctx.server!.dellal!('smsHooks', { url }, ctx);
    return { ok: true, url, demo: false };
  }),

  /** Server: send what is due (every minute). */
  'notify.run': proc([], z.object({}), (ctx) => runQueue(ctx)),
  /** Server: a WhatsApp status from Meta's webhook. */
  'notify.waStatus': proc([], z.object({ id: z.string().min(1).max(200), status: z.string().max(20), code: z.number().int().nullable().optional(), title: z.string().max(300).nullable().optional() }), (ctx, i) =>
    onWhatsAppStatus(ctx, i),
  ),
  /** Server: an SMS gateway event (sent, delivered, failed, received). */
  'notify.smsEvent': proc(
    [],
    z.object({ event: z.enum(['sent', 'delivered', 'failed', 'received']), id: z.string().max(200).nullable().optional(), phone: z.string().max(30).nullable().optional(), text: z.string().max(2000).nullable().optional(), reason: z.string().max(300).nullable().optional() }),
    (ctx, i) => onSmsEvent(ctx, i),
  ),
  /** Server: the SMS webhook key. */
  'notify.hookKey': proc([], z.object({}), async (ctx) => ({ hookKey: (await notifySettings(ctx.db)).hookKey })),
};
