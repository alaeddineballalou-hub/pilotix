// Landing pages: is an order fake? Many small signals, each worth points; the total (0–100) decides.
//   allow  → a normal order
//   review → a normal order, but "À vérifier" with the reasons in its note (an agent looks before calling)
//   block  → no order; the customer still sees the thank-you screen, Pilotix lists it in « Commandes bloquées »
// Pure function: the landing module gathers the facts (history, velocity, challenge), this file only weighs them.
// Some signals are certain (a robot's trap, a page that never ran, a device an agent marked « concurrent »): they block
// whatever the rest says. Good signals (a customer who already paid, read the page, came from the ad) lower the score,
// so a real customer is not blocked by one unlucky signal.

export type FraudLevel = 'relaxed' | 'normal' | 'strict';
export type FraudVerdict = 'allow' | 'review' | 'block';

/** points at which an order is put to review / blocked, per strictness */
export const FRAUD_THRESHOLDS: Record<FraudLevel, { review: number; block: number }> = {
  relaxed: { review: 45, block: 100 },
  normal: { review: 30, block: 100 },
  strict: { review: 25, block: 75 },
};

/** certain signals: the order is blocked whatever the good signals say */
export const HARD_CODES = ['honeypot', 'phone_invalid', 'phone_repeat', 'phone_sequence', 'form_invalid', 'too_fast', 'pow_bad', 'pow_replay', 'webdriver', 'device_numbers', 'device_competitor', 'device_fake_again', 'recent_block', 'refuser_blocked'];
/** never « allowed » alone: a person calls first (a customer who refused a parcel, a look-alike of a refuser) */
export const YELLOW_CODES = ['refused_once', 'refused_twice', 'looks_like', 'wilaya_wave'];

/** what the page saw of the visitor (sent by the page with the order; absent for older pages and abandoned orders) */
export interface FraudBehavior {
  /** how far down the page they scrolled, 0–100 */
  scroll: number;
  /** the phone number was pasted, not typed */
  pasted: boolean;
  /** the browser's time zone (Africa/Algiers…) and its number of touch points */
  tz: string;
  touch: number | null;
  /** they came from an ad link (fbclid, utm_source, ad_id) */
  fromAd: boolean;
}

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
  recent: {
    phone24h: number;
    phoneSameProduct24h: number;
    ip10m: number;
    ip1h: number;
    device1h: number;
    /** other phone numbers sent from this device, by its stored id (1 h, 24 h) */
    deviceNumbers1h?: number;
    deviceNumbers24h?: number;
    /** other phone numbers from the same physical device, by its fingerprint (survives a cleared / private browser) */
    deviceNumbersFp1h?: number;
    deviceNumbersFp24h?: number;
    /** other numbers of the last day that differ only in the last two digits (and whether one came from this device / address) */
    nearPhones24h?: number;
    nearSameSource?: boolean;
    /** other numbers that used exactly this full name in this wilaya (7 days) */
    nameOtherPhones7d?: number;
    /** this product, this wilaya: many more orders in the last 30 minutes than usual */
    wilayaWave?: boolean;
    /** devices never seen before, from this very address, in the last 10 minutes */
    newDevicesIp10m?: number;
  };
  /** what agents said of this device before (« fausse commande », « concurrent ») */
  marks?: { competitor: boolean; fake30d: number; victimDevices?: number };
  /** the usual biggest quantity of this product (null: not enough orders to tell) */
  qtyUsual?: number | null;
  /** Cloudflare's invisible check: passed, failed, or not used */
  turnstile?: 'ok' | 'fail' | 'off';
  /** the platform/shop has Turnstile set up, so the check SHOULD have run on this page */
  turnstileExpected?: boolean;
  /** the visitor's network is a known data-center / VPN (server-detected from the ASN; the page cannot fake it) */
  hosting?: boolean;
  behavior?: FraudBehavior | null;
  /** what Pilotix knows of this phone */
  history: {
    blacklisted: boolean;
    orders: number;
    delivered: number;
    returned: number;
    cancelled: number;
    /** blacklisted by Pilotix itself (refused 3 parcels): blocked silently */
    blacklistAuto?: boolean;
    /** parcels refused since the last delivered one (the customer's trust) */
    refusals?: number;
    /** a new number that looks like a refuser (same device, or same name + commune) */
    lookAlike?: boolean;
  };
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

export const BOT_UA = /headless|phantomjs|selenium|webdriver|puppeteer|playwright|bot\b|crawler|spider|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp\/[0-2]\.|axios\/|node-fetch|undici|httpclient|libwww|scrapy|postmanruntime|insomnia/i;
const MASH = /(qwer|wert|asdf|sdfg|zxcv|azer|qsdf|wxcv|hjkl|uiop|poiu|lkjh|mlkj|azert|ytreza|dfgh|fghj|ghjk|tyui|rtyu|ertz)/i;
const LATIN_VOWELS = /[aeiouyéèêàâîôûäëïöü]/i;
/** names a person types to skip the field: never a real customer */
const JUNK_NAMES = new Set(['test', 'testt', 'tester', 'aze', 'azer', 'azerty', 'qwerty', 'qsdf', 'qsdfg', 'asdf', 'asdfg', 'abc', 'abcd', 'abcde', 'sdf', 'ddd', 'fff', 'ggg', 'aaa', 'bbb', 'ccc', 'xxx', 'xxxx', 'zzz', 'nom', 'name', 'client', 'prenom', 'fake', 'faux', 'xyz', 'wxc', 'wxcv', 'blabla', 'bla', 'rien', 'anonyme', 'anonymous', 'user', 'none', 'null', 'na', 'لالا', 'تست', 'فلان']);

/** Name checks: digits, links, one letter repeated, keyboard mashing, consonant soup. */
export function nameSignals(raw: string, newNumber = true): FraudReason[] {
  const out: FraudReason[] = [];
  const name = raw.trim();
  const words = name.split(/\s+/).filter(Boolean);
  const letters = name.replace(/[^\p{L}]/gu, '');
  const flat = letters.toLowerCase();
  if (/(https?:|www\.|@|\.com\b)/i.test(name)) out.push({ code: 'name_link', points: 40 });
  if (/\d/.test(name)) out.push({ code: 'name_digits', points: 25 });
  if (letters.length < 3) out.push({ code: 'name_short', points: 25 });
  // a name typed only to skip the field ("test", "azerty", "xxx"): a sure fake
  if (JUNK_NAMES.has(flat) || words.every((w) => JUNK_NAMES.has(w.toLowerCase()))) out.push({ code: 'name_junk', points: 60 });
  if (/(\p{L})\1{3,}/u.test(name)) out.push({ code: 'name_repeat', points: 25 });
  if (MASH.test(letters)) out.push({ code: 'name_keyboard', points: 35 });
  // latin words: no vowel at all, or 5 consonants in a row ("xkcdfg"); Arabic script is not judged this way
  const latin = words.filter((w) => /^[a-zà-ÿ'-]+$/i.test(w) && w.length >= 4);
  if (latin.some((w) => !LATIN_VOWELS.test(w) || /[bcdfghjklmnpqrstvwxz]{5,}/i.test(w))) out.push({ code: 'name_gibberish', points: 30 });
  if (letters.length >= 3 && new Set(flat).size <= 2) out.push({ code: 'name_repeat', points: 25 });
  // real COD customers give a full name (two words); a single short word from a new number is a soft sign
  if (newNumber && words.length === 1 && letters.length <= 6) out.push({ code: 'name_oneword', points: 15 });
  return dedupe(out);
}

/** Phone checks beyond the format: 0555555555, 0512345678 and the like. */
export function phoneSignals(phone: string): FraudReason[] {
  const d = phone.slice(2); // after 05 / 06 / 07
  const out: FraudReason[] = [];
  if (/(\d)\1{5,}/.test(d)) out.push({ code: 'phone_repeat', points: 35 });
  if ('0123456789012345'.includes(d.slice(0, 7)) || '9876543210987654'.includes(d.slice(0, 7))) out.push({ code: 'phone_sequence', points: 30 });
  if (new Set(d).size <= 2) out.push({ code: 'phone_pattern', points: 25 });
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
  r.push(...nameSignals(f.name, f.history.orders === 0));

  // 2. time and proof that the page really ran
  if (f.servedMs === null) add('no_challenge', 35);
  else if (f.servedMs < 3000) add('too_fast', 100);
  else if (f.servedMs < 8000) add('fast', 30);
  if (f.pow === 'missing') add('pow_missing', 30);
  else if (f.pow === 'bad') add('pow_bad', 45);
  else if (f.pow === 'replay') add('pow_replay', 40);
  if (f.inputs === 0) add('no_typing', 15);
  if (f.turnstile === 'fail') add('turnstile_fail', 40);
  // Turnstile should have protected this page but did not run (Cloudflare off / page not covered / forged request):
  // a small warning only, never enough alone to block a real customer on a bad connection.
  else if (f.turnstile === 'off' && f.turnstileExpected) add('no_turnstile', 20);

  // 3. robots and scripts, and a « mask » that does not fit (a phone with no touch screen…)
  if (!f.userAgent.trim()) add('ua_empty', 40);
  else if (BOT_UA.test(f.userAgent)) add('ua_bot', 50);
  if (f.webdriver) add('webdriver', 100);
  const b = f.behavior;
  if (b) {
    if (b.touch === 0 && /Android|iPhone|Mobile/i.test(f.userAgent)) add('mask_touch', 30);
    if (b.tz && !/^Africa\//.test(b.tz) && f.ipCountry !== null && f.ipCountry === 'DZ') add('mask_tz', 15);
  }

  // 4. the same hands again and again: a device that sends many numbers, numbers in a row, one name for many numbers
  const rc = f.recent;
  if (rc.phoneSameProduct24h > 0) add('duplicate', 40); // often a double tap: an agent checks before calling
  if (rc.phone24h >= 3) add('phone_burst', 35);
  // mobile operators put many customers behind one address (CGNAT): an address alone weighs little
  if (rc.ip10m >= 4) add('ip_burst', 20);
  else if (rc.ip1h >= 8) add('ip_many', 15);
  const dn1 = rc.deviceNumbers1h ?? 0;
  const dn24 = rc.deviceNumbers24h ?? 0;
  // the same physical device, even with a new stored id each time (private browsing, cleared browser): the fingerprint
  const fn1 = rc.deviceNumbersFp1h ?? 0;
  const fn24 = rc.deviceNumbersFp24h ?? 0;
  if (dn1 >= 2 || dn24 >= 4 || fn1 >= 4 || fn24 >= 6) add('device_numbers', 100); // 3 numbers in an hour, 5 in a day, from one phone
  else if (fn1 >= 2 || fn24 >= 4) add('device_numbers_fp', 60); // same fingerprint, a few numbers: a person checks
  else if (dn24 >= 1) add('device_two', 15); // a family orders for two: a small sign only
  else if (rc.device1h >= 3) add('device_burst', 30);
  if ((rc.nearPhones24h ?? 0) >= 2 || ((rc.nearPhones24h ?? 0) >= 1 && rc.nearSameSource)) add('phone_near', 40);
  if ((rc.nameOtherPhones7d ?? 0) >= 2) add('name_reused', 30);
  if (rc.wilayaWave) add('wilaya_wave', 25);
  if ((rc.newDevicesIp10m ?? 0) >= 5) add('device_rain', 30);
  const m = f.marks;
  if (m?.competitor) add('device_competitor', 100);
  else if ((m?.fake30d ?? 0) >= 2) add('device_fake_again', 100);
  else if ((m?.fake30d ?? 0) === 1) add('device_fake', 40);
  // a number fake orders used from two devices or more: maybe someone's real number, used by others: the agent asks
  if ((m?.victimDevices ?? 0) >= 2) add('phone_victim', 30);

  // 5. how they used the page: went straight to the form, pasted the number; or read it, came from the ad
  if (b) {
    if (b.scroll < 10 && f.clientMs !== null && f.clientMs < 15_000) add('no_browse', 15);
    else if (b.scroll >= 40 && f.clientMs !== null && f.clientMs >= 40_000) add('read_page', -10);
    if (b.pasted) add('phone_pasted', 10);
    add(b.fromAd ? 'from_ad' : 'not_from_ad', b.fromAd ? -10 : 10);
  }

  // 6. what Pilotix already knows of this phone
  const h = f.history;
  if (h.blacklisted && h.blacklistAuto) add('refuser_blocked', 100);
  else if (h.blacklisted) add('blacklisted', 60);
  if (h.refusals !== undefined) {
    // the customer's trust from their parcels (a paid delivery forgives: counted since the last one)
    // (3 refusals and no longer blacklisted: a person lifted it, so only checked)
    if (h.refusals >= 2) add('refused_twice', 50);
    else if (h.refusals === 1) add('refused_once', 40);
  } else if (h.returned >= 2 && h.returned >= h.delivered) add('returns_many', 35);
  else if (h.returned >= 1) add('returns_some', 10);
  // learns from deliveries: a number that refused 3+ parcels and never took one is a serial refuser (a person checks)
  if (h.returned >= 3 && h.delivered === 0) add('returns_serial', 50);
  if (h.lookAlike) add('looks_like', 40);
  if (h.cancelled >= 3 && h.delivered === 0) add('cancels_many', 20);
  // a customer who already received and paid: trusted (only a certain signal can block them)
  if (h.delivered >= 1 && (h.refusals ?? h.returned) === 0 && !h.blacklisted && !h.lookAlike) add('good_customer', -100);

  // 7. soft signals: never enough alone
  const newNumber = h.orders === 0;
  if (f.qtyUsual && f.qty >= 3 && f.qty > f.qtyUsual * 2 && newNumber) add(f.qty > 10 ? 'qty_high' : 'qty_unusual', f.qty > 10 ? 50 : 30);
  else if (f.qty > 10) add('qty_high', 20);
  else if (f.qty > 5) add('qty_some', 10);
  // a data-center / VPN network: not where a real COD customer orders from (server-detected, cannot be faked)
  if (f.hosting) add('ip_hosting', 35);
  if (f.ipCountry && f.ipCountry !== 'DZ') add('ip_abroad', 15);
  else if (f.ipWilaya && f.ipWilaya !== f.wilayaId) add('ip_wilaya', 8);

  const reasons = dedupe(r).sort((a, b) => b.points - a.points);
  const hard = reasons.some((x) => HARD_CODES.includes(x.code));
  const score = hard ? 100 : Math.max(0, Math.min(100, reasons.reduce((s, x) => s + x.points, 0)));
  return { score, verdict: verdictOf(score, hard, reasons, level), reasons };
}

export function verdictOf(score: number, hard: boolean, reasons: FraudReason[], level: FraudLevel): FraudVerdict {
  const t = FRAUD_THRESHOLDS[level];
  if (hard || score >= t.block) return 'block';
  if (score >= t.review || reasons.some((x) => YELLOW_CODES.includes(x.code))) return 'review';
  return 'allow';
}
