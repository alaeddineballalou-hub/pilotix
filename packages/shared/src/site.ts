// The shop's website (Landing pages › Website): one site per boutique, its home made of blocks the shop taps and
// changes on a phone (the « Phone first » editor), in Arabic, French and English. renderSite draws it as ONE small HTML
// file, like the landing pages: no framework, no script on the live site, the products' own landing pages behind each
// card (their order form, their pixel, their fake-order check).
// A service's site (a training centre) shows its sessions instead (the « Sessions » block, from Pilotix › Rendez-vous):
// how many seats are left, a plain form to book one, and the person's ticket after (renderTicket).
import { algiersParts, RDV_MAX_SEATS } from './rdv';

export const SITE_LANGS = ['ar', 'fr', 'en'] as const;
export type SiteLang = (typeof SITE_LANGS)[number];
/** a text in each language the site has ('' or missing: not written yet in that language) */
export type SiteText = Partial<Record<SiteLang, string>>;

/** the colours a site can take: ground, ink, the shop's colour and the soft tints under the banner and the photos */
export const SITE_PALETTES = {
  candy: { bg: '#F4FAFF', ink: '#1E2B45', muted: '#4A5878', accent: '#C93A63', onAccent: '#FFFFFF', soft: '#FFE8EF', tile: '#FFF3F6', card: '#FFFFFF', line: '#E6EEF7' },
  sky: { bg: '#FFFFFF', ink: '#13294B', muted: '#47597A', accent: '#1D5FC9', onAccent: '#FFFFFF', soft: '#DCEEFF', tile: '#EEF6FF', card: '#FFFFFF', line: '#E3EBF5' },
  mint: { bg: '#F5FBF8', ink: '#16362C', muted: '#46685D', accent: '#1F7A5A', onAccent: '#FFFFFF', soft: '#DDF2E9', tile: '#ECF7F2', card: '#FFFFFF', line: '#DCEBE4' },
  sand: { bg: '#FBF7F1', ink: '#2F2A24', muted: '#6A5F52', accent: '#A4480A', onAccent: '#FFFFFF', soft: '#F3E6D3', tile: '#F8EFE3', card: '#FFFFFF', line: '#EADFCF' },
  night: { bg: '#0F172A', ink: '#F1F5F9', muted: '#A8B3C7', accent: '#F7A823', onAccent: '#1B2A47', soft: '#1E293B', tile: '#172033', card: '#1A2234', line: '#26324A' },
  // a school's blue (the « Académie » design, 24 Nov 2026)
  academy: { bg: '#F5F7FC', ink: '#14213D', muted: '#4A5672', accent: '#2F4BD6', onAccent: '#FFFFFF', soft: '#E6EBFF', tile: '#EEF1F8', card: '#FFFFFF', line: '#DFE5F2' },
} as const;
export type SitePalette = keyof typeof SITE_PALETTES;
export const SITE_PALETTE_KEYS = Object.keys(SITE_PALETTES) as SitePalette[];

/** the letters: the phone's own (fastest), or one of three faces made for Arabic and Latin */
export const SITE_FONTS = {
  system: { css: 'system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif', google: '' },
  round: { css: '"Baloo Bhaijaan 2",system-ui,sans-serif', google: 'family=Baloo+Bhaijaan+2:wght@500;700;800' },
  clean: { css: 'Tajawal,system-ui,sans-serif', google: 'family=Tajawal:wght@400;500;700;800' },
  simple: { css: 'Almarai,system-ui,sans-serif', google: 'family=Almarai:wght@400;700;800' },
} as const;
export type SiteFont = keyof typeof SITE_FONTS;
export const SITE_FONT_KEYS = Object.keys(SITE_FONTS) as SiteFont[];

export const SITE_CORNERS = { square: 4, soft: 12, round: 22 } as const;
export type SiteCorners = keyof typeof SITE_CORNERS;
export const SITE_CORNER_KEYS = Object.keys(SITE_CORNERS) as SiteCorners[];

export const SITE_TRUST_ICONS = ['cash', 'truck', 'chat', 'check', 'swap', 'clock'] as const;
export type SiteTrustIcon = (typeof SITE_TRUST_ICONS)[number];

interface BlockBase {
  /** its name in the site (a few letters): the editor finds the block the shop tapped by it */
  id: string;
  /** kept in the site, not shown to customers (the editor still shows it, faded) */
  hidden?: boolean;
}
export type SiteBlock = BlockBase &
  (
    | { type: 'header'; phone: boolean }
    /** layout « plain »: the words alone (a service with no product photo); link « sessions »: the booking form */
    | { type: 'hero'; layout: 'side' | 'center' | 'plain'; title: SiteText; text: SiteText; button: SiteText; link: 'products' | 'whatsapp' | 'sessions'; productId: number | null }
    | { type: 'trust'; items: { icon: SiteTrustIcon; text: SiteText }[] }
    | { type: 'best'; title: SiteText; count: number; oldPrice: boolean; button: SiteText }
    | { type: 'products'; title: SiteText; button: SiteText }
    /** the sessions of Pilotix › Rendez-vous: the next one big (its seats left), the others, the booking form */
    | { type: 'sessions'; title: SiteText; text: SiteText; button: SiteText }
    | { type: 'why'; title: SiteText; points: SiteText[] }
    | { type: 'faq'; title: SiteText; items: { q: SiteText; a: SiteText }[] }
    | { type: 'whatsapp'; text: SiteText }
    | { type: 'footer'; text: SiteText }
  );
export type SiteBlockType = SiteBlock['type'];
export const SITE_BLOCK_TYPES: SiteBlockType[] = ['header', 'hero', 'sessions', 'trust', 'best', 'products', 'why', 'faq', 'whatsapp', 'footer'];
/** the most a site holds (blocks on the home, items in a list, letters in a text) */
export const SITE_LIMITS = { blocks: 30, items: 8, title: 120, text: 400, count: 12 } as const;

export interface SiteDoc {
  v: 1;
  /** the design it started from (Website › designs) */
  design: string;
  theme: { palette: SitePalette; font: SiteFont; corners: SiteCorners };
  /** its languages, the main one first (what a visitor sees when he did not choose) */
  langs: SiteLang[];
  home: SiteBlock[];
}

// ---------------------------------------------------------------- the designs (each niche gets its own, about 10 each)
const T = (ar: string, fr: string, en: string): SiteText => ({ ar, fr, en });
const COD = T('الدفع عند الاستلام · توصيل لكل الولايات', 'Paiement à la livraison · livraison dans toutes les wilayas', 'Cash on delivery · delivery to every wilaya');
const ORDER = T('اطلب الآن', 'Commander', 'Order now');
const BEST = T('الأكثر طلبًا', 'Les plus commandés', 'Best sellers');
const SEAT = () => T('احجز مقعدك', 'Réserver ma place', 'Book my seat');
const TRUST = (): { icon: SiteTrustIcon; text: SiteText }[] => [
  { icon: 'cash', text: T('الدفع عند الاستلام', 'Paiement à la livraison', 'Cash on delivery') },
  { icon: 'truck', text: T('توصيل لكل الولايات', 'Livraison partout en Algérie', 'Delivery to every wilaya') },
  { icon: 'chat', text: T('نجيبك على واتساب', 'Réponse sur WhatsApp', 'We answer on WhatsApp') },
];
const FAQ = (): { q: SiteText; a: SiteText }[] => [
  { q: T('كيف أطلب؟', 'Comment commander ?', 'How do I order?'), a: T('اختر المنتج واملأ الاستمارة، ثم نتصل بك لتأكيد الطلب.', 'Choisissez le produit, remplissez le formulaire : nous vous appelons pour confirmer.', 'Pick the product and fill in the form: we call you to confirm.') },
  { q: T('كيف أدفع؟', 'Comment payer ?', 'How do I pay?'), a: T('تدفع نقدًا عند استلام طلبك.', 'Vous payez en espèces à la livraison.', 'You pay cash when your order arrives.') },
  { q: T('متى يصلني الطلب؟', 'Quand arrive ma commande ?', 'When will my order arrive?'), a: T('حسب ولايتك، نخبرك عند تأكيد الطلب.', 'Selon votre wilaya : nous vous le disons à la confirmation.', 'It depends on your wilaya: we tell you when we confirm.') },
];
const WHY = (): SiteText[] => [
  T('الدفع عند الاستلام في كل الولايات', 'Paiement à la livraison dans toutes les wilayas', 'Cash on delivery in every wilaya'),
  T('نتصل بك لتأكيد الطلب قبل الإرسال', 'Nous vous appelons pour confirmer avant l’envoi', 'We call you to confirm before we ship'),
  T('خدمة الزبائن على واتساب', 'Un service client sur WhatsApp', 'Customer service on WhatsApp'),
];

export interface SiteDesign {
  key: string;
  niche: string;
  name: string;
  theme: SiteDoc['theme'];
  home: () => SiteBlock[];
}
export const SITE_DESIGNS: SiteDesign[] = [
  {
    key: 'candy',
    niche: 'baby',
    name: 'Candy',
    theme: { palette: 'candy', font: 'round', corners: 'round' },
    home: () => [
      { id: 'hd', type: 'header', phone: true },
      { id: 'hr', type: 'hero', layout: 'side', title: T('كل ما يحتاجه طفلك، حتى باب الدار', 'Tout pour votre bébé, livré chez vous', 'Everything for your baby, at your door'), text: COD, button: T('تسوق الآن', 'Voir les produits', 'See the products'), link: 'products', productId: null },
      { id: 'tr', type: 'trust', items: TRUST() },
      { id: 'bs', type: 'best', title: BEST, count: 4, oldPrice: true, button: ORDER },
      { id: 'wy', type: 'why', title: T('لماذا تختارنا؟', 'Pourquoi nous choisir ?', 'Why choose us?'), points: WHY() },
      { id: 'fq', type: 'faq', title: T('أسئلة متكررة', 'Questions fréquentes', 'Questions'), items: FAQ() },
      { id: 'wa', type: 'whatsapp', text: T('تحدث معنا على واتساب', 'Écrivez-nous sur WhatsApp', 'Message us on WhatsApp') },
      { id: 'ft', type: 'footer', text: T('شكرًا لثقتكم', 'Merci de votre confiance', 'Thank you for your trust') },
    ],
  },
  {
    key: 'cloud',
    niche: 'baby',
    name: 'Cloud',
    theme: { palette: 'sky', font: 'clean', corners: 'soft' },
    home: () => [
      { id: 'hd', type: 'header', phone: true },
      { id: 'hr', type: 'hero', layout: 'center', title: T('راحة طفلك أولًا', 'Le confort de votre bébé d’abord', 'Your baby’s comfort first'), text: COD, button: T('اكتشف المنتجات', 'Découvrir', 'Discover'), link: 'products', productId: null },
      { id: 'bs', type: 'best', title: BEST, count: 6, oldPrice: true, button: ORDER },
      { id: 'tr', type: 'trust', items: TRUST() },
      { id: 'pr', type: 'products', title: T('كل المنتجات', 'Tous les produits', 'All products'), button: ORDER },
      { id: 'fq', type: 'faq', title: T('أسئلة متكررة', 'Questions fréquentes', 'Questions'), items: FAQ() },
      { id: 'ft', type: 'footer', text: T('شكرًا لثقتكم', 'Merci de votre confiance', 'Thank you for your trust') },
    ],
  },
  // a training centre (owner's choice, 24 Nov 2026: the first service niche): the sessions and their seats left first
  {
    key: 'academie',
    niche: 'training',
    name: 'Académie',
    theme: { palette: 'academy', font: 'clean', corners: 'soft' },
    home: () => [
      { id: 'hd', type: 'header', phone: true },
      {
        id: 'hr',
        type: 'hero',
        layout: 'plain',
        title: T('تكوين حضوري، تطبيقي من أول يوم', 'Une formation sur place, pratique dès le premier jour', 'In-person training, hands-on from day one'),
        text: T('مقاعد محدودة في كل دورة · تدفع يوم الدورة', 'Places limitées à chaque session · paiement le jour même', 'Limited seats in every session · pay on the day'),
        button: SEAT(),
        link: 'sessions',
        productId: null,
      },
      { id: 'ss', type: 'sessions', title: T('الدورات القادمة', 'Prochaines sessions', 'Upcoming sessions'), text: T('نتصل بك لتأكيد مقعدك قبل الدورة.', 'Nous vous appelons pour confirmer votre place avant la session.', 'We call you to confirm your seat before the session.'), button: SEAT() },
      {
        id: 'wy',
        type: 'why',
        title: T('كيف تجري الدورة؟', 'Comment se passe la formation ?', 'How does the training work?'),
        points: [
          T('تطبيق عملي طوال اليوم', 'De la pratique toute la journée', 'Hands-on practice all day'),
          T('مجموعات صغيرة، أسئلتك لها وقت', 'De petits groupes : vos questions ont leur temps', 'Small groups: your questions get time'),
          T('تحجز بالاسم والهاتف، وتدفع يوم الدورة', 'Vous réservez avec votre nom et votre téléphone, vous payez le jour même', 'Book with your name and phone, pay on the day'),
        ],
      },
      {
        id: 'fq',
        type: 'faq',
        title: T('أسئلة متكررة', 'Questions fréquentes', 'Questions'),
        items: [
          { q: T('كيف أحجز؟', 'Comment réserver ?', 'How do I book?'), a: T('اختر الدورة، اكتب اسمك ورقم هاتفك، ثم نتصل بك لتأكيد المقعد.', 'Choisissez la session, écrivez votre nom et votre numéro : nous vous appelons pour confirmer la place.', 'Pick the session, write your name and phone: we call you to confirm your seat.') },
          { q: T('كيف أدفع؟', 'Comment payer ?', 'How do I pay?'), a: T('تدفع يوم الدورة، عند الدخول.', 'Vous payez le jour de la formation, à l’entrée.', 'You pay on the day, at the door.') },
          { q: T('ماذا أحضر معي؟', 'Que faut-il apporter ?', 'What should I bring?'), a: T('حاسوبك إن كان لديك، وتذكرتك (الرمز الذي يظهر بعد الحجز).', 'Votre ordinateur si vous en avez un, et votre billet (le code donné après la réservation).', 'Your laptop if you have one, and your ticket (the code you get after booking).') },
        ],
      },
      { id: 'wa', type: 'whatsapp', text: T('سؤال؟ تحدث معنا على واتساب', 'Une question ? Écrivez-nous sur WhatsApp', 'A question? Message us on WhatsApp') },
      { id: 'ft', type: 'footer', text: T('نراك في الدورة', 'À bientôt en formation', 'See you at the training') },
    ],
  },
];
export const siteDesign = (key: string): SiteDesign | undefined => SITE_DESIGNS.find((d) => d.key === key);

/** a new site from a design, in these languages (main first) */
export function siteFromDesign(key: string, langs: SiteLang[] = ['ar', 'fr']): SiteDoc {
  const d = siteDesign(key) ?? SITE_DESIGNS[0];
  return { v: 1, design: d.key, theme: { ...d.theme }, langs: [...new Set(langs)].filter((l) => (SITE_LANGS as readonly string[]).includes(l)) as SiteLang[], home: d.home() };
}

/** a new block of this kind, ready to change (its texts in the three languages) */
export function newSiteBlock(type: SiteBlockType, id: string): SiteBlock {
  const d = SITE_DESIGNS[0].home();
  const ready = d.find((b) => b.type === type);
  if (ready) return { ...JSON.parse(JSON.stringify(ready)), id };
  if (type === 'products') return { id, type: 'products', title: T('كل المنتجات', 'Tous les produits', 'All products'), button: ORDER };
  if (type === 'sessions') {
    const ready2 = siteDesign('academie')?.home().find((b) => b.type === 'sessions');
    if (ready2) return { ...ready2, id };
  }
  return { id, type: 'footer', text: T('شكرًا لثقتكم', 'Merci de votre confiance', 'Thank you for your trust') };
}

// ---------------------------------------------------------------- what the page shows
export interface SiteProduct {
  id: number;
  /** its landing page's address part: the card opens it */
  slug: string;
  title: string;
  price: number;
  oldPrice: number | null;
  img: { src: string; srcset?: string } | null;
}
/** a session of the boutique's Rendez-vous that takes bookings (Pilotix › Rendez-vous › Sessions) */
export interface SiteSession {
  id: number;
  /** what is taught */
  title: string;
  city: string;
  place: string;
  startsAt: string;
  endsAt: string | null;
  seats: number;
  free: number;
  price: number;
  note: string;
}
/** a booking's ticket (the website's /?billet=…): « todo » until the team confirms it, « done » once the day is over */
export interface SiteTicket {
  code: string;
  name: string;
  seats: number;
  status: 'todo' | 'ok' | 'cancelled' | 'done';
  price: number;
  note: string;
  session: { title: string; city: string; place: string; startsAt: string; endsAt: string | null };
}
export interface SiteView {
  doc: SiteDoc;
  lang: SiteLang;
  shop: { name: string; logo: string | null; phone: string; whatsapp: string };
  /** the products with a page online, newest first */
  products: SiteProduct[];
  /** products by delivered orders (the last 90 days), the most first */
  best: number[];
  /** the sessions still open (Rendez-vous), soonest first; `rdv`: the boutique has turned Rendez-vous on */
  sessions?: SiteSession[];
  rdv?: boolean;
}
export interface SiteRender {
  mode: 'live' | 'edit';
  /** what a product's page address starts with ('/' on the shop's own domain) */
  base: string;
  /** edit: the block shown chosen */
  selected?: string | null;
  /** live: each language's address of this page */
  langHref?: Partial<Record<SiteLang, string>>;
  /** live: this page's own address */
  url?: string;
  /** edit: the editor's words for what the customer never sees (empty blocks, hidden blocks) */
  hints?: { noProducts: string; noWhatsapp: string; hidden: string; noSessions?: string };
  /** edit: where the page was scrolled before it was drawn again (it opens there, not at the top) */
  scrollY?: number;
  year?: number;
  /**
   * the Sessions block's form: where it posts (live; the editor's posts nowhere), why the last booking was refused
   * (full, phone, name, closed, retry) and the session chosen (?s=…)
   */
  book?: { action: string; err?: string | null; pick?: number | null };
  /** the time the page is drawn (the countdown « in 11 days », the form's time) */
  now?: number;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const LANG_NAME: Record<SiteLang, string> = { ar: 'العربية', fr: 'Français', en: 'English' };
/** the same, short (a phone's header) */
const LANG_SHORT: Record<SiteLang, string> = { ar: 'عربي', fr: 'FR', en: 'EN' };

/** a text in this language, else in the site's main language, else in any (so a page is never blank) */
export function siteText(t: SiteText | undefined, lang: SiteLang, langs: readonly SiteLang[] = SITE_LANGS): string {
  if (!t) return '';
  const own = (t[lang] ?? '').trim();
  if (own) return own;
  for (const l of [...langs, ...SITE_LANGS]) {
    const v = (t[l] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * 12950 → « 12 950 دج » (Arabic) or « 12 950 DA ». The spaces never break; in Arabic the number is kept left to right
 * (an isolate), or the page would show « 950 12 ».
 */
export function sitePrice(v: number, lang: SiteLang): string {
  const n = String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return lang === 'ar' ? `\u2066${n}\u2069\u00a0دج` : `${n}\u00a0DA`;
}

// ---------------------------------------------------------------- a service's sessions, its form and its ticket
const DAY_LOCALE: Record<SiteLang, string> = { ar: 'ar-DZ', fr: 'fr-DZ', en: 'en-GB' };
/** « السبت، 5 ديسمبر », « samedi 5 décembre », « Saturday 5 December » (Algiers time; `short`: « sam. 5 déc. ») */
export function siteDay(at: string, lang: SiteLang, short = false): string {
  try {
    return new Intl.DateTimeFormat(DAY_LOCALE[lang], { weekday: short ? 'short' : 'long', day: 'numeric', month: short ? 'short' : 'long', timeZone: 'Africa/Algiers' }).format(new Date(at));
  } catch {
    return algiersParts(at).date;
  }
}
/** « 09:00 – 16:00 » (or « 09:00 ») */
const hours = (s: { startsAt: string; endsAt: string | null }) => `${algiersParts(s.startsAt).time}${s.endsAt ? ` – ${algiersParts(s.endsAt).time}` : ''}`;

/** Arabic counts: 1, 2, 3 to 10, 11 and more take different words */
const arN = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}`);

/** the words of the Sessions block and the ticket, in each language (the shop writes only the titles) */
const W = {
  ar: {
    next: 'الدورة القادمة',
    others: 'دورات أخرى',
    left: (n: number) => (n <= 0 ? 'مكتمل' : `بقي ${arN(n, 'مقعد واحد', 'مقعدان', 'مقاعد', 'مقعدًا')}`),
    ring: (n: number) => (n === 1 ? 'مقعد متبقٍّ' : n === 2 ? 'مقعدان متبقيان' : n >= 3 && n <= 10 ? 'مقاعد متبقية' : 'مقعدًا متبقيًا'),
    outOf: (n: number) => `من ${arN(n, 'مقعد واحد', 'مقعدين', 'مقاعد', 'مقعدًا')}`,
    starts: (d: number) => (d <= 0 ? 'تبدأ اليوم' : d === 1 ? 'تبدأ غدًا' : `تبدأ بعد ${arN(d, 'يوم', 'يومين', 'أيام', 'يومًا')}`),
    payDay: 'تدفع يوم الدورة',
    free: 'مجانًا',
    full: 'مكتمل',
    form: 'احجز مقعدك',
    pick: 'اختر الدورة',
    name: 'الاسم الكامل',
    namePh: 'مثال: أمين بلقاسم',
    phone: 'رقم الهاتف',
    seats: 'عدد المقاعد',
    send: 'تأكيد الحجز',
    pay: (p: string) => `تدفع يوم الدورة: <b>${p}</b>. نتصل بك لتأكيد الحجز.`,
    payLater: 'تدفع يوم الدورة. نتصل بك لتأكيد الحجز.',
    call: 'نتصل بك لتأكيد الحجز.',
    bar: 'الاسم ورقم الهاتف فقط · نتصل بك للتأكيد',
    none: 'لا توجد دورات مفتوحة للحجز الآن.',
    err: { full: 'لم تبق مقاعد كافية في هذه الدورة: اختر عددًا أقل أو دورة أخرى.', phone: 'اكتب رقم هاتف جوال صحيح (05، 06 أو 07).', name: 'اكتب اسمك الكامل.', closed: 'هذه الدورة لم تعد مفتوحة للحجز.', retry: 'لم يتم الحجز، حاول مرة أخرى.' },
    t: {
      todo: ['تم حجز مقعدك', 'نتصل بك قريبًا لتأكيد الحجز.'],
      ok: ['مقعدك مؤكد', 'نراك يوم الدورة.'],
      cancelled: ['تم إلغاء هذا الحجز', 'إن كان هذا خطأ، تحدث معنا.'],
      done: ['شكرًا لحضورك', 'نتمنى أن تكون الدورة قد أفادتك.'],
    },
    date: 'التاريخ',
    place: 'المكان',
    who: 'الاسم',
    seatsT: 'المقاعد',
    pays: 'الدفع',
    payOn: (p: string) => `${p} يوم الدورة`,
    code: 'أظهر هذا الرمز عند الدخول',
    wa: 'احفظ التذكرة على واتساب',
    cal: 'أضف إلى التقويم',
    back: 'العودة إلى الموقع',
    lost: ['لم نجد هذه التذكرة', 'ربما تغيّر الرابط. تحدث معنا لنجد حجزك.'],
    ticket: 'تذكرتي',
  },
  fr: {
    next: 'Prochaine session',
    others: 'Autres sessions',
    left: (n: number) => (n <= 0 ? 'Complet' : n === 1 ? '1 place restante' : `${n} places restantes`),
    ring: (n: number) => (n === 1 ? 'place restante' : 'places restantes'),
    outOf: (n: number) => `sur ${n} place${n > 1 ? 's' : ''}`,
    starts: (d: number) => (d <= 0 ? 'Aujourd’hui' : d === 1 ? 'Demain' : `Dans ${d} jours`),
    payDay: 'à payer le jour de la formation',
    free: 'Gratuit',
    full: 'Complet',
    form: 'Réservez votre place',
    pick: 'Choisissez la session',
    name: 'Nom complet',
    namePh: 'Ex. : Amine Belkacem',
    phone: 'Téléphone',
    seats: 'Nombre de places',
    send: 'Réserver',
    pay: (p: string) => `Vous payez le jour de la formation : <b>${p}</b>. Nous vous appelons pour confirmer.`,
    payLater: 'Vous payez le jour de la formation. Nous vous appelons pour confirmer.',
    call: 'Nous vous appelons pour confirmer.',
    bar: 'Nom et téléphone seulement · nous vous appelons',
    none: 'Aucune session ouverte pour le moment.',
    err: {
      full: 'Il ne reste pas assez de places dans cette session : moins de places, ou une autre session.',
      phone: 'Écrivez un numéro de mobile valide (05, 06 ou 07).',
      name: 'Écrivez votre nom complet.',
      closed: 'Cette session n’est plus ouverte.',
      retry: 'La réservation n’est pas passée : réessayez.',
    },
    t: {
      todo: ['Votre place est réservée', 'Nous vous appelons bientôt pour la confirmer.'],
      ok: ['Votre place est confirmée', 'À bientôt, le jour de la formation.'],
      cancelled: ['Cette réservation est annulée', 'Si c’est une erreur, écrivez-nous.'],
      done: ['Merci d’être venu', 'Nous espérons que la formation vous a plu.'],
    },
    date: 'Date',
    place: 'Lieu',
    who: 'Nom',
    seatsT: 'Places',
    pays: 'Paiement',
    payOn: (p: string) => `${p}, le jour même`,
    code: 'Montrez ce code à l’entrée',
    wa: 'Garder le billet sur WhatsApp',
    cal: 'Ajouter au calendrier',
    back: 'Retour au site',
    lost: ['Billet introuvable', 'Le lien a peut-être changé : écrivez-nous, nous retrouverons votre réservation.'],
    ticket: 'Mon billet',
  },
  en: {
    next: 'Next session',
    others: 'Other sessions',
    left: (n: number) => (n <= 0 ? 'Full' : n === 1 ? '1 seat left' : `${n} seats left`),
    ring: (n: number) => (n === 1 ? 'seat left' : 'seats left'),
    outOf: (n: number) => `of ${n} seat${n > 1 ? 's' : ''}`,
    starts: (d: number) => (d <= 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`),
    payDay: 'paid on the day',
    free: 'Free',
    full: 'Full',
    form: 'Book your seat',
    pick: 'Choose the session',
    name: 'Full name',
    namePh: 'e.g. Amine Belkacem',
    phone: 'Phone',
    seats: 'Seats',
    send: 'Book',
    pay: (p: string) => `You pay on the day: <b>${p}</b>. We call you to confirm.`,
    payLater: 'You pay on the day. We call you to confirm.',
    call: 'We call you to confirm.',
    bar: 'Name and phone only · we call you to confirm',
    none: 'No session open for booking right now.',
    err: { full: 'Not enough seats left in this session: fewer seats, or another session.', phone: 'Write a valid mobile number (05, 06 or 07).', name: 'Write your full name.', closed: 'This session is no longer open.', retry: 'The booking did not go through: try again.' },
    t: {
      todo: ['Your seat is booked', 'We will call you soon to confirm it.'],
      ok: ['Your seat is confirmed', 'See you on the day.'],
      cancelled: ['This booking is cancelled', 'If this is a mistake, message us.'],
      done: ['Thank you for coming', 'We hope you enjoyed the training.'],
    },
    date: 'Date',
    place: 'Place',
    who: 'Name',
    seatsT: 'Seats',
    pays: 'Payment',
    payOn: (p: string) => `${p}, on the day`,
    code: 'Show this code at the door',
    wa: 'Keep the ticket on WhatsApp',
    cal: 'Add to calendar',
    back: 'Back to the site',
    lost: ['Ticket not found', 'The link may have changed: message us and we will find your booking.'],
    ticket: 'My ticket',
  },
} satisfies Record<SiteLang, unknown>;

/** the texts a site still misses in one of its languages (the editor shows them) */
export function siteMissing(doc: SiteDoc): { lang: SiteLang; blocks: string[] }[] {
  const out: { lang: SiteLang; blocks: string[] }[] = [];
  for (const lang of doc.langs) {
    const blocks: string[] = [];
    for (const b of doc.home) if (!b.hidden && blockTexts(b).some((t) => !(t[lang] ?? '').trim())) blocks.push(b.id);
    if (blocks.length) out.push({ lang, blocks });
  }
  return out;
}
/** every text a block shows */
export function blockTexts(b: SiteBlock): SiteText[] {
  switch (b.type) {
    case 'header':
      return [];
    case 'hero':
      return [b.title, b.text, b.button];
    case 'trust':
      return b.items.map((x) => x.text);
    case 'best':
      return [b.title, b.button];
    case 'products':
      return [b.title, b.button];
    case 'sessions':
      return [b.title, b.text, b.button];
    case 'why':
      return [b.title, ...b.points];
    case 'faq':
      return [b.title, ...b.items.flatMap((x) => [x.q, x.a])];
    case 'whatsapp':
      return [b.text];
    case 'footer':
      return [b.text];
  }
}

const ICON: Record<SiteTrustIcon | 'wa' | 'phone' | 'ok' | 'x' | 'cal', string> = {
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  truck: '<path d="M3 6.5h11v10H3z"/><path d="M14 10h4l3 3v3.5h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  check: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.3-7.5 9.5-4.3-1.2-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  swap: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wa: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9.5 8.8c0 3 2.6 5.7 5.7 5.7l1.1-1.4-2-1-.8.8a4 4 0 0 1-2.4-2.4l.8-.8-1-2z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  cal: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
};
const svg = (k: keyof typeof ICON) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

const CSS = (doc: SiteDoc) => {
  const p = SITE_PALETTES[doc.theme.palette] ?? SITE_PALETTES.candy;
  const f = SITE_FONTS[doc.theme.font] ?? SITE_FONTS.system;
  const r = SITE_CORNERS[doc.theme.corners] ?? SITE_CORNERS.soft;
  const btn = doc.theme.corners === 'round' ? '999px' : `${Math.max(4, r - 4)}px`;
  return `:root{--bg:${p.bg};--ink:${p.ink};--mu:${p.muted};--ac:${p.accent};--on:${p.onAccent};--soft:${p.soft};--tile:${p.tile};--card:${p.card};--line:${p.line};--r:${r}px;--rb:${btn}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}body{margin:0;font:16px/1.55 ${f.css};color:var(--ink);background:var(--bg)}
img{max-width:100%;display:block}a{color:inherit}h1,h2{margin:0;line-height:1.2;letter-spacing:-.01em}
.w{max-width:1120px;margin:0 auto;padding:0 16px}
.b{padding:28px 0}.b h2{font-size:24px;font-weight:800;margin-bottom:16px}
.hd{padding:0;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.hd .w{display:flex;align-items:center;gap:12px;min-height:60px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-size:19px;color:var(--ac);min-width:0}
.brand img{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none}.brand span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd .sp{flex:1}.langs{display:flex;gap:4px;flex:none}.langs a{font-size:13px;text-decoration:none;padding:6px 9px;border-radius:999px;color:var(--mu)}.langs a.on{background:var(--soft);color:var(--ink);font-weight:700}
.tel{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:15px;direction:ltr;white-space:nowrap;flex:none}
.langs .ls{display:none}
@media(max-width:480px){.hd .w{gap:8px}.langs a{padding:6px 8px}.langs .ln{display:none}.langs .ls{display:inline}.tel .tn{display:none}.tel{justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--soft);color:var(--ink)}}
.tel svg,.tr svg,.why svg,.wab svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;flex:none}
.hero .in{background:var(--soft);border-radius:var(--r);padding:22px;display:grid;gap:18px;align-items:center}
.hero h1{font-size:clamp(26px,6.4vw,46px);font-weight:800}.hero p{margin:10px 0 0;color:var(--mu);font-size:17px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;border-radius:var(--rb);background:var(--ac);color:var(--on);font-weight:800;text-decoration:none;font-size:16px;margin-top:18px}
.hp{border-radius:calc(var(--r) - 4px);overflow:hidden;background:var(--card);aspect-ratio:4/5;max-height:360px;display:flex;align-items:center;justify-content:center}
.hp img{width:100%;height:100%;object-fit:cover}.hp .mono{font-size:64px;font-weight:800;color:var(--ac)}
.hero.center .in{text-align:center;justify-items:center}.hero.center .hp{width:min(280px,70%)}
.tr ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tr li{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;font-weight:600;font-size:15px}
.tr li span{width:36px;height:36px;border-radius:50%;background:var(--soft);color:var(--ac);display:flex;align-items:center;justify-content:center;flex:none}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.card{display:flex;flex-direction:column;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:8px 8px 12px;text-decoration:none;color:inherit}
.card .ph{aspect-ratio:4/5;border-radius:calc(var(--r) - 4px);overflow:hidden;background:var(--tile)}.card .ph img{width:100%;height:100%;object-fit:cover}
.card .nm{font-weight:700;font-size:15px;line-height:1.35;padding:0 4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .pr{display:flex;align-items:baseline;gap:8px;padding:0 4px;flex-wrap:wrap}.card .pr b{color:var(--ac);font-size:17px}.card .pr s{color:var(--mu);font-size:13px}
.card .cta{margin:4px 4px 0;min-height:42px;border-radius:var(--rb);background:var(--ac);color:var(--on);font-weight:800;display:flex;align-items:center;justify-content:center;font-size:15px}
.why .in{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px}.why ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.why li{display:flex;gap:12px;align-items:flex-start;font-size:17px;font-weight:600}.why li span{width:30px;height:30px;border-radius:50%;background:var(--ac);color:var(--on);display:flex;align-items:center;justify-content:center;flex:none}
.why li span svg{width:16px;height:16px}
.faq details{background:var(--card);border:1px solid var(--line);border-radius:var(--r);margin-bottom:10px;padding:0 16px}
.faq summary{cursor:pointer;font-weight:700;padding:15px 0;list-style:none}.faq summary::-webkit-details-marker{display:none}.faq summary::after{content:"+";float:inline-end;font-weight:800;color:var(--ac)}
.faq details[open] summary::after{content:"–"}.faq p{margin:0 0 16px;color:var(--mu)}
.wab{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;border-radius:var(--rb);background:#1F8F4E;color:#fff;font-weight:800;font-size:17px;text-decoration:none}
.ft{background:var(--card);border-top:1px solid var(--line);margin-top:20px}.ft .w{display:flex;flex-direction:column;gap:6px;align-items:center;text-align:center;color:var(--mu);font-size:14px}.ft b{color:var(--ink);font-size:17px}
.empty{border:2px dashed var(--line);border-radius:var(--r);padding:22px;text-align:center;color:var(--mu);font-weight:600}
@media (min-width:641px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.hero.side .in{grid-template-columns:1.2fr 1fr;padding:34px}}
@media (min-width:1025px){.cards{grid-template-columns:repeat(4,minmax(0,1fr))}.b{padding:40px 0}.b h2{font-size:30px}.hero .in{padding:44px}.hp{max-height:420px}}
/* the sessions of a service (Rendez-vous): the next one with its seats left, the others, the form, the bar on phones */
.ses .lede{color:var(--mu);margin:-8px 0 16px}.ses h3{font-size:17px;font-weight:800;margin:22px 0 10px}
.ses .nx{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 16px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}
.ses .chip{font-size:12px;font-weight:700;color:var(--ac);background:var(--soft);border-radius:999px;padding:4px 10px}.ses .tt{font-size:19px;font-weight:800;line-height:1.3}
.ring{width:150px;height:150px;border-radius:50%;display:grid;place-items:center;margin:8px 0}
.ring>span{width:118px;height:118px;border-radius:50%;background:var(--card);display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring b{font-size:40px;line-height:1;font-weight:800}.ring small{font-size:13px;color:var(--mu)}
.ses .wh{font-weight:800;font-size:17px}.ses .mu{color:var(--mu);font-size:14px}.ses .pr{font-weight:800;font-size:16px}.ses .pr small{font-weight:500;color:var(--mu);font-size:13px}
.os{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;text-decoration:none;margin-bottom:8px}
.os b{display:block;font-size:15px}.os small{color:var(--mu);font-size:13px}.os .lf{font-size:13px;font-weight:700;color:var(--ac);white-space:nowrap}.os.full{opacity:.6}.os.full .lf{color:var(--mu)}
.none{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px;color:var(--mu);margin:0}
.bk{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 16px;margin-top:18px;display:grid;gap:14px;scroll-margin-top:76px}
.bk h3{margin:0;font-size:20px}.bk fieldset{border:0;margin:0;padding:0;display:grid;gap:8px;min-width:0}.bk legend{font-weight:700;font-size:14px;padding:0;margin-bottom:8px}
.bk .opt{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:calc(var(--r) - 4px);padding:10px 12px;cursor:pointer}
.bk .opt input{width:20px;height:20px;accent-color:var(--ac);flex:none;margin:0}.bk .opt:has(input:checked){border-color:var(--ac);box-shadow:0 0 0 1px var(--ac)}
.bk .opt span{display:flex;flex-direction:column;min-width:0}.bk .opt small{color:var(--mu);font-size:13px}.bk .opt.full{opacity:.55;cursor:default}
.bk .f{display:grid;gap:6px;font-weight:700;font-size:14px}
.bk input[type=text],.bk input[type=tel],.bk select{font:inherit;font-weight:500;min-height:50px;border:1px solid var(--line);border-radius:calc(var(--r) - 4px);padding:0 14px;background:var(--bg);color:var(--ink);width:100%}
[dir=rtl] .bk input[type=tel]{text-align:right}.bk input:focus,.bk select:focus{outline:2px solid var(--ac);outline-offset:1px}
.bk .note{margin:0;color:var(--mu);font-size:14px}.bk .note b{color:var(--ink)}.bk .btn{margin:0;width:100%;min-height:52px;border:0;font:inherit;font-weight:800;cursor:pointer}
.bkerr{margin:0;background:#FFF1E0;color:#7A3306;border-radius:calc(var(--r) - 4px);padding:12px 14px;font-weight:600;font-size:14px}
.hpf{position:absolute!important;inset-inline-start:-9999px;width:1px;height:1px;overflow:hidden}
.bkbar{display:none}
@media(max-width:760px){.bkbar{display:flex;flex-direction:column;gap:4px;position:fixed;left:0;right:0;bottom:0;z-index:8;background:var(--card);border-top:1px solid var(--line);padding:10px 16px calc(12px + env(safe-area-inset-bottom));text-decoration:none;text-align:center;box-shadow:0 -8px 20px rgba(20,33,61,.08)}
.bkbar .btn{margin:0;width:100%}.bkbar small{color:var(--mu);font-size:12.5px}body.has-bk{padding-bottom:104px}#reserver:target~.bkbar{display:none}}
@media(min-width:761px){.ses .two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}.ses .two .bk{margin-top:0}}
.hero.plain .in{text-align:center;justify-items:center;padding-block:34px}.hero.plain .hx{max-width:720px}
/* a booking's ticket */
.tk{max-width:560px;margin:0 auto;padding:24px 16px 40px;display:flex;flex-direction:column;gap:16px}
.tk-top{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}.tk-top h1{font-size:24px;font-weight:800}.tk-top p{margin:0;color:var(--mu)}
.tk-ic{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:#E3F5EA;color:#137A3B}.tk-ic.wait{background:var(--soft);color:var(--ac)}.tk-ic.off{background:#FDECEC;color:#B42318}
.tk svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;flex:none}.tk-ic svg{width:28px;height:28px;stroke-width:2.2}
.tkc{background:var(--card);border:1px solid var(--line);border-radius:calc(var(--r) + 2px)}.tkc .in{padding:16px;display:flex;flex-direction:column;gap:10px}.tkc .tt{font-size:17px;font-weight:800}
.trow{display:flex;justify-content:space-between;gap:14px;font-size:14.5px}.trow span{color:var(--mu);flex:none}.trow b{text-align:end;font-weight:700}
.cut{position:relative;border-top:2px dashed var(--line)}.cut::before,.cut::after{content:"";position:absolute;top:-11px;width:20px;height:20px;border-radius:50%;background:var(--bg);border:1px solid var(--line)}.cut::before{left:-11px}.cut::after{right:-11px}
.tkc .cd{padding:14px 16px 18px;display:flex;flex-direction:column;align-items:center;gap:4px}.tkc .cd span{font-size:13px;color:var(--mu)}.tkc .cd b{font-size:30px;font-weight:800;letter-spacing:.06em;color:var(--ac)}
.tk .btn{margin:0;width:100%;gap:10px}.btn2{display:flex;align-items:center;justify-content:center;gap:10px;min-height:48px;border-radius:var(--rb);border:1px solid var(--line);background:var(--card);color:var(--ink);font-weight:700;text-decoration:none}
.tk .back{align-self:center;color:var(--mu);font-size:14px;padding:8px}
::selection{background:var(--ac);color:var(--on)}`;
};

const EDIT_CSS = (sel: string | null | undefined) =>
  `.b{cursor:pointer;position:relative}.b:hover{box-shadow:inset 0 0 0 2px rgba(242,139,30,.55)}.b.off{opacity:.42}
.b.off::before{content:attr(data-off);position:absolute;top:8px;inset-inline-start:8px;z-index:6;background:#1B2A47;color:#fff;font:600 12px system-ui;padding:3px 8px;border-radius:6px}
${sel && /^[a-z0-9]{1,12}$/.test(sel) ? `[data-b="${sel}"]{box-shadow:inset 0 0 0 3px #F28B1E!important}` : ''}`;

/** in the editor: a tap on a block names it to the editor; links lead nowhere; the chosen block comes into view */
const EDIT_JS = (sel: string | null | undefined, y: number | undefined) =>
  `<script>(function(){` +
  // a tap chooses that part of the page (its links and buttons do nothing in the editor)
  `document.addEventListener("click",function(e){var b=e.target.closest("[data-b]");e.preventDefault();e.stopPropagation();if(b)parent.postMessage({lp:"site",tap:b.getAttribute("data-b")},"*")},true);` +
  // the page is drawn again as the shop types: it opens where it was; the chosen part is brought to the middle only when
  // it is out of sight. Its own window scrolls, never Pilotix around it. Now, and again once the pictures are in.
  `var y=${Math.max(0, Math.round(Number(y) || 0))},s=${sel && /^[a-z0-9]{1,12}$/.test(sel) ? `'[data-b="${sel}"]'` : 'null'},moved=0;` +
  `function go(){if(moved)return;if(y)scrollTo(0,y);var b=s&&document.querySelector(s);if(!b)return;var r=b.getBoundingClientRect();if(r.bottom<8||r.top>innerHeight-8)scrollTo(0,Math.max(0,scrollY+r.top-Math.max(16,(innerHeight-r.height)/2)))}` +
  `go();addEventListener("load",go);["wheel","touchstart","keydown"].forEach(function(k){addEventListener(k,function(){moved=1},{passive:true})});` +
  // where the shop scrolled to, for the next drawing
  `var t;addEventListener("scroll",function(){clearTimeout(t);t=setTimeout(function(){parent.postMessage({lp:"site",y:Math.round(scrollY)},"*")},150)},{passive:true})` +
  `})()</script>`;

/** the site's home page, as customers see it (live) or as the editor shows it (edit) */
export function renderSite(v: SiteView, r: SiteRender): string {
  const { doc, lang } = v;
  const langs = doc.langs.length ? doc.langs : (['ar'] as SiteLang[]);
  const tx = (t: SiteText | undefined) => esc(siteText(t, lang, langs));
  const edit = r.mode === 'edit';
  const byId = new Map(v.products.map((p) => [p.id, p]));
  const best = [...v.best.map((id) => byId.get(id)).filter((p): p is SiteProduct => !!p), ...v.products.filter((p) => !v.best.includes(p.id))];
  const visible = doc.home.filter((b) => edit || !b.hidden);
  const hasHero = visible.some((b) => b.type === 'hero' && !b.hidden);
  const wa = v.shop.whatsapp;
  const card = (p: SiteProduct, oldPrice: boolean, button: SiteText) =>
    `<a class="card" href="${esc(r.base + p.slug)}"><span class="ph">${p.img ? `<img src="${esc(p.img.src)}"${p.img.srcset ? ` srcset="${esc(p.img.srcset)}" sizes="(min-width:1025px) 260px,(min-width:641px) 30vw,46vw"` : ''} alt="${esc(p.title)}" loading="lazy" decoding="async">` : ''}</span>` +
    `<span class="nm">${esc(p.title)}</span><span class="pr"><b>${sitePrice(p.price, lang)}</b>${oldPrice && p.oldPrice && p.oldPrice > p.price ? `<s>${sitePrice(p.oldPrice, lang)}</s>` : ''}</span>` +
    `${siteText(button, lang, langs) ? `<span class="cta">${tx(button)}</span>` : ''}</a>`;
  const empty = (text: string | undefined) => (edit ? `<div class="empty">${esc(text ?? '')}</div>` : '');
  const open = (b: SiteBlock, cls: string, extra = '') =>
    `<section class="b ${cls}${b.hidden ? ' off' : ''}"${edit ? ` data-b="${esc(b.id)}"${b.hidden ? ` data-off="${esc(r.hints?.hidden ?? '')}"` : ''}` : ''}${extra}>`;
  const firstImg = (id: number | null) => (id ? byId.get(id)?.img : null) ?? best[0]?.img ?? null;
  let hero1 = false;
  /** a Sessions block with a seat to book: phones get the « book » bar at the bottom */
  let hasBar = false;

  const html = visible
    .map((b) => {
      switch (b.type) {
        case 'header': {
          const links =
            langs.length > 1
              ? `<nav class="langs" aria-label="Langue">${langs.map((l) => `<a href="${esc(edit ? '#' : (r.langHref?.[l] ?? '#'))}" lang="${l}" class="${l === lang ? 'on' : ''}"><span class="ln">${LANG_NAME[l]}</span><span class="ls">${LANG_SHORT[l]}</span></a>`).join('')}</nav>`
              : '';
          const name = `<span>${esc(v.shop.name)}</span>`;
          return (
            `<header class="b hd${b.hidden ? ' off' : ''}"${edit ? ` data-b="${esc(b.id)}"${b.hidden ? ` data-off="${esc(r.hints?.hidden ?? '')}"` : ''}` : ''}><div class="w">` +
            `<a class="brand" href="#top">${v.shop.logo ? `<img src="${esc(v.shop.logo)}" alt="">` : ''}${hasHero ? name : `<h1 style="font-size:inherit">${name}</h1>`}</a><span class="sp"></span>${links}` +
            `${b.phone && v.shop.phone ? `<a class="tel" href="tel:${esc(v.shop.phone.replace(/[^\d+]/g, ''))}" aria-label="${esc(v.shop.phone)}">${svg('phone')}<span class="tn">${esc(v.shop.phone)}</span></a>` : ''}</div></header>`
          );
        }
        case 'hero': {
          const img = firstImg(b.productId);
          const pic =
            b.layout === 'plain'
              ? ''
              : `<div class="hp">${img ? `<img src="${esc(img.src)}"${img.srcset ? ` srcset="${esc(img.srcset)}" sizes="(min-width:641px) 40vw,90vw"` : ''} alt="" fetchpriority="high">` : `<span class="mono">${esc((v.shop.name || '·').slice(0, 1))}</span>`}</div>`;
          const href = b.link === 'whatsapp' && wa ? `https://wa.me/${wa}` : b.link === 'sessions' ? '#sessions' : '#produits';
          const h = hero1 ? 'h2' : 'h1';
          hero1 = true;
          return (
            `${open(b, `hero ${b.layout}`)}<div class="w"><div class="in"><div class="hx"><${h}>${tx(b.title)}</${h}>${siteText(b.text, lang, langs) ? `<p>${tx(b.text)}</p>` : ''}` +
            `${siteText(b.button, lang, langs) ? `<a class="btn" href="${esc(href)}">${tx(b.button)}</a>` : ''}</div>${pic}</div></div></section>`
          );
        }
        case 'trust':
          return `${open(b, 'tr')}<div class="w"><ul>${b.items.map((x) => `<li><span>${svg(x.icon)}</span>${tx(x.text)}</li>`).join('')}</ul></div></section>`;
        case 'best': {
          const list = best.slice(0, Math.max(1, Math.min(SITE_LIMITS.count, b.count)));
          if (!list.length && !edit) return '';
          return `${open(b, 'grid', ' id="produits"')}<div class="w"><h2>${tx(b.title)}</h2>${list.length ? `<div class="cards">${list.map((p) => card(p, b.oldPrice, b.button)).join('')}</div>` : empty(r.hints?.noProducts)}</div></section>`;
        }
        case 'products': {
          if (!v.products.length && !edit) return '';
          return `${open(b, 'grid', best.length && visible.some((x) => x.type === 'best' && !x.hidden) ? '' : ' id="produits"')}<div class="w"><h2>${tx(b.title)}</h2>${v.products.length ? `<div class="cards">${v.products.map((p) => card(p, true, b.button)).join('')}</div>` : empty(r.hints?.noProducts)}</div></section>`;
        }
        case 'sessions': {
          const w = W[lang];
          const list = v.sessions ?? [];
          const head = `<h2>${tx(b.title)}</h2>${siteText(b.text, lang, langs) ? `<p class="lede">${tx(b.text)}</p>` : ''}`;
          if (!list.length)
            return `${open(b, 'ses', ' id="sessions"')}<div class="w">${head}${edit ? empty(r.hints?.noSessions) : `<p class="none">${esc(w.none)}</p>`}</div></section>`;
          const now = r.now ?? Date.now();
          const dayNo = (t: number) => Math.floor((t + 3_600_000) / 86_400_000);
          const priceOf = (x: SiteSession) => (x.price > 0 ? sitePrice(x.price, lang) : esc(w.free));
          const nx = list.find((x) => x.free > 0) ?? list[0];
          const taken = nx.seats > 0 ? Math.min(100, Math.round(((nx.seats - nx.free) / nx.seats) * 100)) : 100;
          const days = Math.max(0, dayNo(new Date(nx.startsAt).getTime()) - dayNo(now));
          const next =
            `<div class="nx"><span class="chip">${esc(w.next)}</span>${nx.title ? `<b class="tt">${esc(nx.title)}</b>` : ''}` +
            `<div class="ring" role="img" aria-label="${esc(`${w.left(nx.free)} · ${w.outOf(nx.seats)}`)}" style="background:conic-gradient(var(--ac) 0 ${taken}%,var(--soft) ${taken}% 100%)"><span><b>${Math.max(0, nx.free)}</b><small>${esc(nx.free > 0 ? w.ring(nx.free) : w.full)}</small></span></div>` +
            `<b class="wh">${esc(nx.city)}${nx.city ? ' · ' : ''}${esc(siteDay(nx.startsAt, lang))}</b><span class="mu">${hours(nx)}${nx.place ? ` · ${esc(nx.place)}` : ''}</span>` +
            `<span class="mu">${esc(w.outOf(nx.seats))} · ${esc(w.starts(days))}</span><span class="pr">${priceOf(nx)}${nx.price > 0 ? ` <small>${esc(w.payDay)}</small>` : ''}</span>${nx.note ? `<span class="mu">${esc(nx.note)}</span>` : ''}</div>`;
          // the page's own address with « this session chosen » (a full reload: the live site has no script)
          const pickHref = (id: number) => (edit ? '#' : `?${lang !== langs[0] ? `lang=${lang}&` : ''}s=${id}#reserver`);
          const others = list.filter((x) => x.id !== nx.id);
          // several trainings: each line says which one
          const oneTitle = new Set(list.map((x) => x.title.trim())).size === 1;
          const what = (x: SiteSession) => (oneTitle || !x.title ? esc(x.city) : `${esc(x.title)}${x.city ? ` · ${esc(x.city)}` : ''}`);
          const rows = others
            .map((x) => {
              const inner = `<span><b>${what(x)}</b><small>${esc(siteDay(x.startsAt, lang))} · ${hours(x)}</small></span><span class="lf">${esc(w.left(x.free))}</span>`;
              return x.free > 0 ? `<a class="os" href="${esc(pickHref(x.id))}">${inner}</a>` : `<div class="os full">${inner}</div>`;
            })
            .join('');
          const open1 = list.filter((x) => x.free > 0);
          const pick = open1.find((x) => x.id === r.book?.pick) ?? open1[0];
          const samePrice = new Set(list.map((x) => x.price)).size === 1;
          const err = r.book?.err ? (w.err as Record<string, string>)[r.book.err] ?? w.err.retry : '';
          const note = samePrice ? (list[0].price > 0 ? w.pay(sitePrice(list[0].price, lang)) : `${esc(w.free)}. ${esc(w.call)}`) : esc(w.payLater);
          const form = open1.length
            ? `<form class="bk" id="reserver" method="post" action="${esc(edit ? '#' : (r.book?.action ?? '#'))}"${edit ? ' onsubmit="return false"' : ''}><h3>${esc(w.form)}</h3>${err ? `<p class="bkerr" role="alert">${esc(err)}</p>` : ''}` +
              `<fieldset><legend>${esc(w.pick)}</legend>${list
                .map(
                  (x) =>
                    `<label class="opt${x.free > 0 ? '' : ' full'}"><input type="radio" name="session" value="${x.id}"${x.id === pick?.id ? ' checked' : ''}${x.free > 0 ? '' : ' disabled'} required>` +
                    `<span><b>${what(x)}${x.city || !oneTitle ? ' · ' : ''}${esc(siteDay(x.startsAt, lang, true))}</b><small>${hours(x)}${samePrice ? '' : ` · ${priceOf(x)}`} · ${esc(w.left(x.free))}</small></span></label>`,
                )
                .join('')}</fieldset>` +
              `<label class="f">${esc(w.name)}<input type="text" name="name" required minlength="2" maxlength="80" autocomplete="name" placeholder="${esc(w.namePh)}"></label>` +
              `<label class="f">${esc(w.phone)}<input type="tel" name="phone" required inputmode="tel" autocomplete="tel" maxlength="20" dir="ltr" placeholder="05 50 12 34 56"></label>` +
              `<label class="f">${esc(w.seats)}<select name="seats">${Array.from({ length: RDV_MAX_SEATS }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('')}</select></label>` +
              `<input class="hpf" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="t" value="${Math.round(now)}">` +
              `<p class="note">${note}</p><button class="btn" type="submit">${esc(w.send)}</button></form>`
            : '';
          if (open1.length) hasBar = true;
          const bar = open1.length && siteText(b.button, lang, langs) ? `<a class="bkbar" href="#reserver"><span class="btn">${tx(b.button)}</span><small>${esc(w.bar)}</small></a>` : '';
          return (
            `${open(b, 'ses', ' id="sessions"')}<div class="w">${head}<div class="two"><div>${next}${rows ? `<h3>${esc(w.others)}</h3>${rows}` : ''}</div>${form}${bar}</div></div></section>`
          );
        }
        case 'why':
          return `${open(b, 'why')}<div class="w"><div class="in"><h2>${tx(b.title)}</h2><ul>${b.points.map((x) => `<li><span>${svg('ok')}</span>${tx(x)}</li>`).join('')}</ul></div></div></section>`;
        case 'faq':
          return `${open(b, 'faq')}<div class="w"><h2>${tx(b.title)}</h2>${b.items.map((x) => `<details${edit ? ' open' : ''}><summary>${tx(x.q)}</summary><p>${tx(x.a)}</p></details>`).join('')}</div></section>`;
        case 'whatsapp':
          if (!wa) return edit ? `${open(b, 'wa')}<div class="w">${empty(r.hints?.noWhatsapp)}</div></section>` : '';
          return `${open(b, 'wa')}<div class="w"><a class="wab" href="https://wa.me/${esc(wa)}">${svg('wa')}${tx(b.text)}</a></div></section>`;
        case 'footer':
          return (
            `${open(b, 'ft')}<div class="w"><b>${esc(v.shop.name)}</b>${siteText(b.text, lang, langs) ? `<span>${tx(b.text)}</span>` : ''}` +
            `${v.shop.phone ? `<a class="tel" href="tel:${esc(v.shop.phone.replace(/[^\d+]/g, ''))}">${esc(v.shop.phone)}</a>` : ''}<small>© ${r.year ?? new Date().getFullYear()} ${esc(v.shop.name)}</small></div></section>`
          );
      }
    })
    .join('');

  const hero = visible.find((b) => b.type === 'hero' && !b.hidden);
  const desc = hero && hero.type === 'hero' ? siteText(hero.text, lang, langs) || siteText(hero.title, lang, langs) : v.shop.name;
  const font = SITE_FONTS[doc.theme.font]?.google;
  const fonts = font
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${font}&display=swap">`
    : '';
  const alt = !edit && r.langHref && langs.length > 1 ? langs.map((l) => (r.langHref?.[l] ? `<link rel="alternate" hreflang="${l}" href="${esc(r.langHref[l])}">` : '')).join('') : '';
  return (
    `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(v.shop.name)}</title><meta name="description" content="${esc(desc.slice(0, 300))}"><meta name="theme-color" content="${(SITE_PALETTES[doc.theme.palette] ?? SITE_PALETTES.candy).accent}">` +
    `${!edit && r.url ? `<link rel="canonical" href="${esc(r.url)}">` : ''}${alt}${v.shop.logo && !edit ? `<link rel="icon" href="${esc(v.shop.logo)}">` : ''}${fonts}` +
    `<style>${CSS(doc)}${edit ? EDIT_CSS(r.selected) : ''}</style></head><body id="top"${hasBar ? ' class="has-bk"' : ''}>${html}${edit ? EDIT_JS(r.selected, r.scrollY) : ''}</body></html>`
  );
}

/**
 * Three sessions to show a training design before the shop has any (the design picker only, never the shop's site):
 * the next two Saturdays and a Friday, 09:00 to 16:00, a few seats left.
 */
export function siteSampleSessions(now: number, lang: SiteLang): SiteSession[] {
  const day = (n: number, h: number) => {
    const d = new Date(now + 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
    return new Date(`${d}T${String(h).padStart(2, '0')}:00:00+01:00`).toISOString();
  };
  const sat = ((6 - new Date(now + 3_600_000).getUTCDay() + 7) % 7 || 7) + 7;
  const city = { ar: ['الجزائر العاصمة', 'وهران', 'قسنطينة'], fr: ['Alger', 'Oran', 'Constantine'], en: ['Algiers', 'Oran', 'Constantine'] }[lang];
  const title = { ar: 'التجارة الإلكترونية من الصفر إلى أول بيع', fr: 'E-commerce de zéro à la première vente', en: 'E-commerce from zero to the first sale' }[lang];
  const s = (k: number, n: number, seats: number, free: number): SiteSession => ({ id: -1 - k, title, city: city[k], place: '', startsAt: day(n, 9), endsAt: day(n, 16), seats, free, price: 6000, note: '' });
  return [s(0, sat, 20, 5), s(1, sat + 7, 25, 12), s(2, sat + 13, 15, 0)];
}

/**
 * A booking's ticket on the website (/?billet=…), in the site's look: where it stands (booked, confirmed, cancelled,
 * over), the session, the person, the code to show at the door, and two ways to keep it (WhatsApp, the calendar).
 * `t` null: no such ticket (an old or mistyped link).
 */
export function renderTicket(v: SiteView, t: SiteTicket | null, r: SiteRender): string {
  const { doc, lang } = v;
  const langs = doc.langs.length ? doc.langs : (['ar'] as SiteLang[]);
  const w = W[lang];
  const home = r.base || '/';
  const links =
    langs.length > 1
      ? `<nav class="langs" aria-label="Langue">${langs.map((l) => `<a href="${esc(r.langHref?.[l] ?? '#')}" lang="${l}" class="${l === lang ? 'on' : ''}"><span class="ln">${LANG_NAME[l]}</span><span class="ls">${LANG_SHORT[l]}</span></a>`).join('')}</nav>`
      : '';
  const header =
    `<header class="b hd"><div class="w"><a class="brand" href="${esc(home)}">${v.shop.logo ? `<img src="${esc(v.shop.logo)}" alt="">` : ''}<span>${esc(v.shop.name)}</span></a><span class="sp"></span>${links}` +
    `${v.shop.phone ? `<a class="tel" href="tel:${esc(v.shop.phone.replace(/[^\d+]/g, ''))}" aria-label="${esc(v.shop.phone)}">${svg('phone')}<span class="tn">${esc(v.shop.phone)}</span></a>` : ''}</div></header>`;
  let body: string;
  if (!t) {
    body =
      `<main class="tk"><div class="tk-top"><span class="tk-ic off">${svg('x')}</span><h1>${esc(w.lost[0])}</h1><p>${esc(w.lost[1])}</p></div>` +
      `${v.shop.whatsapp ? `<a class="btn" href="https://wa.me/${esc(v.shop.whatsapp)}">${svg('wa')}WhatsApp</a>` : ''}<a class="back" href="${esc(home)}">${esc(w.back)}</a></main>`;
  } else {
    const s = t.session;
    const [title, sub] = w.t[t.status];
    const ic = t.status === 'cancelled' ? `<span class="tk-ic off">${svg('x')}</span>` : t.status === 'todo' ? `<span class="tk-ic wait">${svg('clock')}</span>` : `<span class="tk-ic">${svg('ok')}</span>`;
    const when = `${siteDay(s.startsAt, lang)} · ${hours(s)}`;
    const where = [s.city, s.place].filter(Boolean).join(' · ');
    const total = t.price * t.seats;
    const row = (k: string, val: string) => `<div class="trow"><span>${esc(k)}</span><b>${val}</b></div>`;
    const card =
      `<div class="tkc"><div class="in">${s.title ? `<b class="tt">${esc(s.title)}</b>` : ''}${row(w.date, esc(when))}${where ? row(w.place, esc(where)) : ''}${row(w.who, esc(t.name))}` +
      `${row(w.seatsT, String(t.seats))}${row(w.pays, total > 0 ? esc(w.payOn(sitePrice(total, lang))) : esc(w.free))}${t.note ? `<span class="trow"><span>${esc(t.note)}</span></span>` : ''}</div>` +
      `${t.status === 'cancelled' ? '' : `<div class="cut"></div><div class="cd"><span>${esc(w.code)}</span><b dir="ltr">${esc(t.code)}</b></div>`}</div>`;
    const keep = [s.title, when, where, `${w.code} : ${t.code}`, r.url ?? ''].filter(Boolean).join('\n');
    const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const end = s.endsAt ?? new Date(new Date(s.startsAt).getTime() + 2 * 3_600_000).toISOString();
    const cal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(s.title || v.shop.name)}&dates=${stamp(new Date(s.startsAt).toISOString())}/${stamp(new Date(end).toISOString())}&location=${encodeURIComponent(where)}&details=${encodeURIComponent(`${t.code}${r.url ? ` · ${r.url}` : ''}`)}`;
    const ways =
      t.status === 'cancelled'
        ? `${v.shop.whatsapp ? `<a class="btn" href="https://wa.me/${esc(v.shop.whatsapp)}">${svg('wa')}WhatsApp</a>` : ''}`
        : t.status === 'done'
          ? ''
          : `<a class="btn" href="https://wa.me/?text=${encodeURIComponent(keep)}">${svg('wa')}${esc(w.wa)}</a><a class="btn2" href="${esc(cal)}" target="_blank" rel="noopener">${svg('cal')}${esc(w.cal)}</a>`;
    body = `<main class="tk"><div class="tk-top">${ic}<h1>${esc(title)}</h1><p>${esc(sub)}</p></div>${card}${ways}<a class="back" href="${esc(home)}">${esc(w.back)}</a></main>`;
  }
  const font = SITE_FONTS[doc.theme.font]?.google;
  const fonts = font
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${font}&display=swap">`
    : '';
  return (
    `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${esc(`${w.ticket} · ${v.shop.name}`)}</title><meta name="theme-color" content="${(SITE_PALETTES[doc.theme.palette] ?? SITE_PALETTES.candy).accent}">${v.shop.logo ? `<link rel="icon" href="${esc(v.shop.logo)}">` : ''}${fonts}` +
    `<style>${CSS(doc)}</style></head><body>${header}${body}</body></html>`
  );
}
