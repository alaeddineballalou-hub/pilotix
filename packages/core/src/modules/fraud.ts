// Landing pages: is an order fake? Many small signals, each worth points; the total (0–100) decides.
//   allow  → a normal order
//   review → a normal order, but "À vérifier" with the reasons in its note (an agent looks before calling)
//   block  → no order; the customer still sees the thank-you screen, Pilotix lists it in « Commandes bloquées »
// Pure function: the landing module gathers the facts (history, velocity, challenge), this file only weighs them.

export type FraudLevel = 'relaxed' | 'normal' | 'strict';
export type FraudVerdict = 'allow' | 'review' | 'block';

/** points at which an order is put to review / blocked, per strictness */
export const FRAUD_THRESHOLDS: Record<FraudLevel, { review: number; block: number }> = {
  relaxed: { review: 55, block: 85 },
  normal: { review: 40, block: 70 },
  strict: { review: 30, block: 55 },
};

export interface FraudFacts {
  name: string;
  /** as typed (after Arabic digits → 0-9); the normalized form or null when it is not an Algerian mobile */
  phoneRaw: string;
  phone: string | null;
  qty: number;
  /** honeypot field (hidden from people): bots fill it */
  honeypot: string;
  /** ms between the page being served (signed challenge) and the order; null when the challenge is missing / forged */
  servedMs: number | null;
  /** ms the page itself measured, and how many real input events it saw */
  clientMs: number | null;
  inputs: number | null;
  /** proof-of-work: ok, missing, wrong, or a challenge already used */
  pow: 'ok' | 'missing' | 'bad' | 'replay';
  userAgent: string;
  webdriver: boolean;
  /** recent submits (all landing pages), not counting this one */
  recent: { phone24h: number; phoneSameProduct24h: number; ip10m: number; ip1h: number; device1h: number };
  /** what Pilotix knows of this phone */
  history: { blacklisted: boolean; orders: number; delivered: number; returned: number; cancelled: number };
  /** soft: country / wilaya from the IP when the host gives them (Cloudflare headers…) */
  ipCountry: string | null;
  ipWilaya: number | null;
  wilayaId: number;
}

export interface FraudReason {
  code: string;
  points: number;
}

export interface FraudResult {
  score: number;
  verdict: FraudVerdict;
  reasons: FraudReason[];
}

const BOT_UA = /headless|phantomjs|selenium|webdriver|puppeteer|playwright|bot\b|crawler|spider|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp\/[0-2]\.|axios\/|node-fetch|undici|httpclient|libwww|scrapy|postmanruntime|insomnia/i;
const MASH = /(qwer|wert|asdf|sdfg|zxcv|azer|qsdf|wxcv|hjkl|uiop|poiu|lkjh|mlkj|azert|ytreza)/i;
const LATIN_VOWELS = /[aeiouyéèêàâîôûäëïöü]/i;

/** Name checks: digits, links, one letter repeated, keyboard mashing, consonant soup. */
export function nameSignals(raw: string): FraudReason[] {
  const out: FraudReason[] = [];
  const name = raw.trim();
  const letters = name.replace(/[^\p{L}]/gu, '');
  if (/(https?:|www\.|@|\.com\b)/i.test(name)) out.push({ code: 'name_link', points: 40 });
  if (/\d/.test(name)) out.push({ code: 'name_digits', points: 25 });
  if (letters.length < 3) out.push({ code: 'name_short', points: 25 });
  if (/(\p{L})\1{3,}/u.test(name)) out.push({ code: 'name_repeat', points: 25 });
  if (MASH.test(letters)) out.push({ code: 'name_keyboard', points: 30 });
  else {
    // latin words: no vowel at all, or 5 consonants in a row ("xkcdfg"); Arabic script is not judged this way
    const latin = name.split(/\s+/).filter((w) => /^[a-zà-ÿ'-]+$/i.test(w) && w.length >= 4);
    if (latin.some((w) => !LATIN_VOWELS.test(w) || /[bcdfghjklmnpqrstvwxz]{5,}/i.test(w))) out.push({ code: 'name_gibberish', points: 25 });
  }
  if (letters.length >= 3 && new Set(letters.toLowerCase()).size <= 2) out.push({ code: 'name_repeat', points: 20 });
  return dedupe(out);
}

/** Phone checks beyond the format: 0555555555, 0512345678 and the like. */
export function phoneSignals(phone: string): FraudReason[] {
  const d = phone.slice(2); // after 05 / 06 / 07
  const out: FraudReason[] = [];
  if (/(\d)\1{5,}/.test(d)) out.push({ code: 'phone_repeat', points: 35 });
  if ('0123456789012345'.includes(d.slice(0, 7)) || '9876543210987654'.includes(d.slice(0, 7))) out.push({ code: 'phone_sequence', points: 30 });
  if (new Set(d).size <= 2) out.push({ code: 'phone_repeat', points: 25 });
  return dedupe(out);
}

function dedupe(rs: FraudReason[]): FraudReason[] {
  const best = new Map<string, FraudReason>();
  for (const r of rs) if (!best.has(r.code) || best.get(r.code)!.points < r.points) best.set(r.code, r);
  return [...best.values()];
}

export function scoreOrder(f: FraudFacts, level: FraudLevel = 'normal'): FraudResult {
  const r: FraudReason[] = [];
  const add = (code: string, points: number) => r.push({ code, points });

  // 1. traps only a robot falls into
  if (f.honeypot.trim()) add('honeypot', 100);
  if (!f.phone) add('phone_invalid', 100); // the page checks the format first: only a script sends a wrong one
  else r.push(...phoneSignals(f.phone));
  r.push(...nameSignals(f.name));

  // 2. time and proof that the page really ran
  if (f.servedMs === null) add('no_challenge', 35);
  else if (f.servedMs < 3000) add('too_fast', 45);
  else if (f.servedMs < 7000) add('fast', 15);
  if (f.pow === 'missing') add('pow_missing', 30);
  else if (f.pow === 'bad') add('pow_bad', 45);
  else if (f.pow === 'replay') add('pow_replay', 40);
  if (f.inputs === 0) add('no_typing', 15);

  // 3. robots and scripts
  if (!f.userAgent.trim()) add('ua_empty', 40);
  else if (BOT_UA.test(f.userAgent)) add('ua_bot', 50);
  if (f.webdriver) add('webdriver', 40);

  // 4. the same person again and again
  if (f.recent.phoneSameProduct24h > 0) add('duplicate', 40); // often a double tap: an agent checks before calling
  if (f.recent.phone24h >= 3) add('phone_burst', 35);
  // mobile operators put many customers behind one address (CGNAT): an address alone weighs little
  if (f.recent.ip10m >= 4) add('ip_burst', 20);
  else if (f.recent.ip1h >= 8) add('ip_many', 15);
  if (f.recent.device1h >= 3) add('device_burst', 30);

  // 5. what Pilotix already knows of this phone
  const h = f.history;
  if (h.blacklisted) add('blacklisted', 60);
  if (h.returned >= 2 && h.returned >= h.delivered) add('returns_many', 35);
  else if (h.returned >= 1) add('returns_some', 10);
  if (h.cancelled >= 3 && h.delivered === 0) add('cancels_many', 20);
  if (h.delivered >= 1 && h.returned === 0 && !h.blacklisted) add('good_customer', -25);

  // 6. soft signals: never enough alone
  if (f.qty > 10) add('qty_high', 20);
  else if (f.qty > 5) add('qty_some', 10);
  if (f.ipCountry && f.ipCountry !== 'DZ') add('ip_abroad', 15);
  else if (f.ipWilaya && f.ipWilaya !== f.wilayaId) add('ip_wilaya', 8);

  const reasons = dedupe(r).sort((a, b) => b.points - a.points);
  const score = Math.max(0, Math.min(100, reasons.reduce((s, x) => s + x.points, 0)));
  const t = FRAUD_THRESHOLDS[level];
  return { score, verdict: score >= t.block ? 'block' : score >= t.review ? 'review' : 'allow', reasons };
}
