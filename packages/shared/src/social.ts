// AI social media manager: what the post editor and the server both use.
//  - postScore: a post's score out of 10 (what makes a post sell in Algeria: a first line that stops the thumb, the price,
//    delivery to 58 wilayas, payment on delivery, how to order, hashtags, a photo or a video, its quality, a good hour,
//    its product linked so CM AI agent answers its comments with the right price)
//  - dzEvents: the Algerian calendar's days worth a post (fixed days, Islamic days from the Umm al-Qura calendar: a day
//    off is possible, the moon decides in Algeria)
//  - nextSlot: the shop's fixed posting times (Algeria, UTC+1 all year)

export const SCORE_KEYS = ['hook', 'price', 'delivery', 'cod', 'cta', 'hashtags', 'media', 'quality', 'hour', 'product'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

/** What fixes a failed check: one click (the caption, the hour), or the person (a photo, the product). */
export const SCORE_FIX: Record<ScoreKey, 'caption' | 'hour' | 'media' | 'product'> = {
  hook: 'caption',
  price: 'caption',
  delivery: 'caption',
  cod: 'caption',
  cta: 'caption',
  hashtags: 'caption',
  media: 'media',
  quality: 'media',
  hour: 'hour',
  product: 'product',
};

export interface ScoreInput {
  kind?: 'post' | 'story';
  caption: string;
  media: readonly { kind: 'photo' | 'video'; w: number; h: number }[];
  /** the linked product's price; null: no product linked */
  price: number | null;
  /** when it goes out (ISO); null: no day yet */
  at: string | null;
  /** the shop's good hours in Algeria (0-23), best first */
  hours: readonly number[];
}
export interface Score {
  score: number;
  checks: { key: ScoreKey; ok: boolean }[];
}

const TAGS = /(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu;
const PRICE = /\d[\d\s.,]*\s*(?:da|dzd|dinars?|دج|د\.ج|دينار)(?![\p{L}])/iu;
const DELIVERY = /\b58\b|wilaya|ولاي|livraison|livrons|توصيل|delivery/iu;
const COD = /(?:paiement|payez|payer|paye)\s+(?:à|a)\s+la\s+(?:livraison|réception|reception)|عند\s+(?:ال)?(?:استلام|إستلام)|cash\s+on\s+delivery|\bcod\b/iu;
const CTA = /comment|écri|ecri|message|inbox|\bdm\b|privé|prive|appel|command|علّق|علق|ابعث|راسل|اطلب|اكتب|كوموند|ميساج|تواصل|\border\b|\bwrite\b/iu;

/** Minutes after midnight in Algeria (UTC+1, no summer time). */
const algMinutes = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(((t + 3_600_000) % 86_400_000) / 60_000);
};

/** A good hour: within an hour of one of the shop's best hours, else the evening (19:00-23:00) or lunch (12:00-14:00). */
export function goodHour(iso: string | null, hours: readonly number[]): boolean {
  const m = iso ? algMinutes(iso) : null;
  if (m === null) return false;
  if (hours.length) return hours.some((h) => Math.min(Math.abs(m - h * 60), 1440 - Math.abs(m - h * 60)) <= 60);
  return (m >= 19 * 60 && m <= 23 * 60) || (m >= 12 * 60 && m <= 14 * 60);
}

/** The post's score out of 10 and each check (a story has no caption: only its picture, its hour and its product). */
export function postScore(p: ScoreInput): Score {
  const story = p.kind === 'story';
  const cap = p.caption.trim();
  const first = cap.split('\n').find((l) => l.trim())?.trim() ?? '';
  const tags = (cap.match(TAGS) ?? []).length;
  const digits = cap.replace(/[\s.,]/g, '');
  const media = p.media.length > 0;
  const sharp = media && p.media.every((m) => (m.kind === 'video' ? Math.min(m.w, m.h) >= 720 : m.w >= 1080));
  const all: { key: ScoreKey; ok: boolean }[] = [
    { key: 'hook', ok: first.length >= 8 && first.length <= 90 },
    // a post for the shop (no product): its price is not asked
    { key: 'price', ok: p.price === null || PRICE.test(cap) || (p.price > 0 && digits.includes(String(p.price))) },
    { key: 'delivery', ok: DELIVERY.test(cap) },
    { key: 'cod', ok: COD.test(cap) },
    { key: 'cta', ok: CTA.test(cap) },
    { key: 'hashtags', ok: tags >= 2 && tags <= 10 },
    { key: 'media', ok: media },
    { key: 'quality', ok: sharp },
    { key: 'hour', ok: goodHour(p.at, p.hours) },
    { key: 'product', ok: p.price !== null },
  ];
  const checks = story ? all.filter((c) => SCORE_FIX[c.key] !== 'caption') : all;
  return { score: Math.round((10 * checks.filter((c) => c.ok).length) / checks.length), checks };
}

// ---------------------------------------------------------------- the Algerian calendar
export const DZ_EVENT_KEYS = ['newyear', 'yennayer', 'valentine', 'women', 'ramadan', 'fitr', 'adha', 'hijri', 'achoura', 'mawlid', 'independence', 'school', 'revolution', 'blackfriday'] as const;
export type DzEventKey = (typeof DZ_EVENT_KEYS)[number];
export interface DzEvent {
  key: DzEventKey;
  /** its day (YYYY-MM-DD) */
  date: string;
  /** an Islamic day: the moon may move it by a day */
  approx: boolean;
  /** how many days before it the posts start (customers buy ahead: clothes for the Aïd, school bags) */
  lead: number;
}

const FIXED: { key: DzEventKey; m: number; d: number; lead: number }[] = [
  { key: 'newyear', m: 1, d: 1, lead: 7 },
  { key: 'yennayer', m: 1, d: 12, lead: 5 },
  { key: 'valentine', m: 2, d: 14, lead: 7 },
  { key: 'women', m: 3, d: 8, lead: 5 },
  { key: 'independence', m: 7, d: 5, lead: 3 },
  { key: 'school', m: 9, d: 1, lead: 14 },
  { key: 'revolution', m: 11, d: 1, lead: 2 },
];
const HIJRI: { key: DzEventKey; month: number; day: number; lead: number }[] = [
  { key: 'ramadan', month: 9, day: 1, lead: 7 },
  { key: 'fitr', month: 10, day: 1, lead: 10 },
  { key: 'adha', month: 12, day: 10, lead: 10 },
  { key: 'hijri', month: 1, day: 1, lead: 2 },
  { key: 'achoura', month: 1, day: 10, lead: 2 },
  { key: 'mawlid', month: 3, day: 12, lead: 3 },
];

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const byYear = new Map<number, DzEvent[]>();

/** The year's days worth a post, in order. */
export function dzYear(year: number): DzEvent[] {
  const hit = byYear.get(year);
  if (hit) return hit;
  const out: DzEvent[] = FIXED.map((f) => ({ key: f.key, date: ymd(Date.UTC(year, f.m - 1, f.d)), approx: false, lead: f.lead }));
  // Black Friday: the day after the fourth Thursday of November
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  out.push({ key: 'blackfriday', date: ymd(Date.UTC(year, 10, 1 + ((4 - nov1 + 7) % 7) + 21 + 1)), approx: false, lead: 7 });
  try {
    const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'numeric' });
    for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86_400_000) {
      const parts = f.formatToParts(t);
      const month = Number(parts.find((x) => x.type === 'month')?.value);
      const day = Number(parts.find((x) => x.type === 'day')?.value);
      const h = HIJRI.find((x) => x.month === month && x.day === day);
      if (h && !out.some((e) => e.key === h.key && Math.abs(Date.parse(e.date) - t) < 300 * 86_400_000)) out.push({ key: h.key, date: ymd(t), approx: true, lead: h.lead });
    }
  } catch {
    // no Islamic calendar in this engine: the fixed days only
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  byYear.set(year, out);
  return out;
}

/** The days between two dates (YYYY-MM-DD, both included). */
export function dzEvents(from: string, to: string): DzEvent[] {
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  const out: DzEvent[] = [];
  for (let y = y0; y <= y1; y++) for (const e of dzYear(y)) if (e.date >= from && e.date <= to) out.push(e);
  return out;
}

// ---------------------------------------------------------------- fixed posting times
export interface Slot {
  /** the days it applies to: 0 = Sunday … 6 = Saturday (Friday 5 and Saturday 6 are Algeria's weekend) */
  days: number[];
  /** HH:MM in Algeria */
  time: string;
}

const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

/**
 * The next fixed time after `after` (ms) that no post takes yet (none within 30 minutes of it), looking `days` ahead.
 * null: no fixed time set, or all of them taken.
 */
export function nextSlot(slots: readonly Slot[], after: number, taken: readonly number[] = [], days = 31): number | null {
  const OFF = 3_600_000;
  const DAY = 86_400_000;
  const first = Math.floor((after + OFF) / DAY);
  for (let d = first; d < first + days; d++) {
    const wd = new Date(d * DAY).getUTCDay();
    const times = [...new Set(slots.filter((s) => s.days.includes(wd)).map((s) => minutesOf(s.time)))].filter((m): m is number => m !== null).sort((a, b) => a - b);
    for (const m of times) {
      const t = d * DAY - OFF + m * 60_000;
      if (t <= after || taken.some((x) => Math.abs(x - t) < 30 * 60_000)) continue;
      return t;
    }
  }
  return null;
}
