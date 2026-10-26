import type { Db } from '../db';
import { num } from '../db';

// Demo data for AI Spy: competitors' Facebook ads for three demo products (stroller, travel cot, high chair), as the
// extension or a paid source would bring them, already read by Claude, plus the shop's own ads, two followed pages and
// their alerts. All pages, people, numbers and ad ids are invented; the pictures are drawn in SVG.

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const GLYPH: Record<string, string> = {
  pou: '<path d="M12 12c11 0 20 9 20 20H10z"/><path d="M32 32h18l-5 12H19l-9-12"/><path d="M50 32l5-14h5"/><circle cx="21" cy="53" r="5"/><circle cx="44" cy="53" r="5"/>',
  lit: '<rect x="8" y="20" width="48" height="28" rx="3"/><path d="M8 29h48M16 29v19M24 29v19M32 29v19M40 29v19M48 29v19M12 48v8M52 48v8"/>',
  cha: '<path d="M23 6h18v22H23z"/><path d="M17 28h30v7H17z"/><path d="M22 35l-6 24M42 35l6 24M19 48h26"/>',
};
/** A creative drawn in SVG: colours, the product, the headline, the price sticker, a play button for videos. */
const creative = (c: [string, string], glyph: string, head: string, price: number | null, old: number | null, video: boolean) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs>` +
      `<rect width="400" height="500" fill="url(#g)"/><rect width="400" height="500" fill="#000" opacity=".08"/>` +
      `<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" transform="translate(80 110) scale(3.75)">${GLYPH[glyph]}</g>` +
      `<text x="200" y="66" text-anchor="middle" direction="rtl" font-family="Cairo,Tahoma,Arial,sans-serif" font-size="27" font-weight="700" fill="#fff">${esc(head)}</text>` +
      (video ? `<circle cx="200" cy="250" r="34" fill="#000" opacity=".45"/><path d="M189 232 L217 250 L189 268Z" fill="#fff"/>` : '') +
      (price
        ? `<g transform="rotate(-5 300 410)"><rect x="214" y="372" width="170" height="${old ? 76 : 58}" rx="14" fill="#FFD23F"/>` +
          (old ? `<text x="299" y="397" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#555" text-decoration="line-through">${old} دج</text>` : '') +
          `<text x="299" y="${old ? 434 : 412}" text-anchor="middle" font-family="Arial,sans-serif" font-size="29" font-weight="800" fill="#1B1B1B">${price} دج</text></g>`
        : '') +
      `<rect y="466" width="400" height="34" fill="#000" opacity=".55"/><text x="200" y="489" text-anchor="middle" direction="rtl" font-family="Cairo,Tahoma,Arial,sans-serif" font-size="15" fill="#fff">التوصيل لكل الولايات · الدفع عند الاستلام</text></svg>`,
  );

interface DemoAd {
  sku: string;
  glyph: 'pou' | 'lit' | 'cha';
  page: string;
  pageId: string;
  own?: boolean;
  days: number;
  seenDays?: number;
  copies: number;
  platforms: string[];
  video: boolean;
  price: number | null;
  old?: number | null;
  head: string;
  body: string;
  link: string | null;
  linkType: 'site' | 'messenger' | 'whatsapp' | 'instagram';
  platform?: string;
  cta: string;
  same: boolean;
  colors: [string, string];
  ai: { hook: string; angle: string; offer: string; keep: string; weak: string };
  site?: { price: number | null; oldPrice: number | null; wilayas: number | null; stopdesk: boolean; whatsapp: boolean };
}

const ADS: DemoAd[] = [
  // ---------------- Poussette canne pliable (12 900 DA)
  { sku: 'PX-POU', glyph: 'pou', page: 'Bébé Confort DZ', pageId: '900000000000101', days: 52, copies: 4, platforms: ['FACEBOOK', 'INSTAGRAM'], video: true, price: 11900, old: 16000, head: 'تتطوى بيد وحدة 💪',
    body: 'عربة الأطفال تتطوى بيد وحدة 💪 تدخل في صندوق الطوموبيل.\n11900 دج بدل 16000 دج والدفع عند الاستلام\n🚚 التوصيل لـ 58 ولاية', link: 'https://bebeconfort-dz.youcan.store/products/poussette', linkType: 'site', platform: 'YouCan', cta: 'Commander', same: true, colors: ['#F7A823', '#E8730C'],
    ai: { hook: 'Pliage à une main montré dès la première seconde', angle: 'Pratique en voiture', offer: '11 900 DA au lieu de 16 000, paiement à la livraison', keep: 'Le coffre de voiture dans la vidéo : le client voit le gain de place', weak: 'Parle encore de 58 wilayas' },
    site: { price: 11900, oldPrice: 16000, wilayas: 58, stopdesk: true, whatsapp: true } },
  { sku: 'PX-POU', glyph: 'pou', page: 'Kids Store 213', pageId: '900000000000102', days: 45, copies: 3, platforms: ['FACEBOOK', 'INSTAGRAM', 'MESSENGER'], video: true, price: 12900, head: 'خفيفة وتطلع بيها في الطرامواي',
    body: 'Poussette t9der t’tla3 biha f tobis w tramway 🚋\nخفيفة 6 كيلو برك، livraison 58 wilaya', link: 'https://kidsstore213.mylightfunnels.com/poussette', linkType: 'site', platform: 'LightFunnels', cta: 'Acheter', same: true, colors: ['#3B3B98', '#1B1464'],
    ai: { hook: 'Montée dans le tramway avec la poussette', angle: 'Légère pour les transports', offer: '12 900 DA', keep: 'Une situation de vie réelle (bus, tramway)', weak: 'Le prix n’apparaît pas dans la vidéo' },
    site: { price: 12900, oldPrice: null, wilayas: 58, stopdesk: false, whatsapp: false } },
  { sku: 'PX-POU', glyph: 'pou', page: 'Maison Bébé Algérie', pageId: '900000000000103', days: 38, copies: 2, platforms: ['FACEBOOK', 'INSTAGRAM'], video: false, price: 13900, head: 'Poussette canne 6,2 kg',
    body: 'Poussette canne ultra-légère 6,2 kg, pliage compact ✅\n13 900 DA, livraison 58 wilayas, paiement à la livraison', link: 'https://maisonbebe-dz.myshopify.com/products/poussette-canne', linkType: 'site', platform: 'Shopify', cta: 'Voir l’offre', same: true, colors: ['#C05C7E', '#7A2E4C'],
    ai: { hook: 'Le poids précis (6,2 kg) en titre', angle: 'Légèreté en ville', offer: '13 900 DA', keep: 'Un chiffre précis rassure plus que « légère »', weak: 'Texte seulement en français' },
    site: { price: 13900, oldPrice: null, wilayas: 58, stopdesk: true, whatsapp: false } },
  { sku: 'PX-POU', glyph: 'pou', page: 'Prix Choc Bébé', pageId: '900000000000104', days: 6, copies: 7, platforms: ['FACEBOOK', 'INSTAGRAM', 'MESSENGER'], video: false, price: 10900, old: 14900, head: 'تخفيض كبير 🔥',
    body: 'تخفيض كبير 🔥 عربة أطفال 10900 دج بدل 14900 دج\nالكمية محدودة، التوصيل لجميع الولايات', link: 'https://prixchoc.foorweb.store/poussette', linkType: 'site', platform: 'Foorweb', cta: 'Commander', same: true, colors: ['#2E7D6B', '#174F45'],
    ai: { hook: 'Grosse réduction en titre', angle: 'Le prix le plus bas', offer: '10 900 DA au lieu de 14 900', keep: 'Le prix barré bien visible', weak: 'Guerre des prix : marge très faible' },
    site: { price: 10900, oldPrice: 14900, wilayas: 69, stopdesk: true, whatsapp: true } },
  { sku: 'PX-POU', glyph: 'pou', page: 'Baby Shop Sétif', pageId: '900000000000105', days: 21, copies: 1, platforms: ['FACEBOOK'], video: true, price: 12500, head: 'خفيفة بزاف 🪶',
    body: 'poussette khfifa bezzaf 🪶 12500 دج\nكونتاكتينا واتساب', link: 'https://wa.me/213555000105', linkType: 'whatsapp', cta: 'WhatsApp', same: true, colors: ['#6D28D9', '#3B1580'],
    ai: { hook: 'Le poids montré sur une balance', angle: 'Légèreté', offer: '12 500 DA', keep: 'La balance comme preuve', weak: 'Commande seulement par WhatsApp' } },
  { sku: 'PX-POU', glyph: 'pou', page: 'Votre boutique (démo)', pageId: '900000000000199', own: true, days: 19, copies: 6, platforms: ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP'], video: true, price: 12900, head: 'عربة خفيفة بـ 12900 دج',
    body: '🍼 عربة أطفال خفيفة وتتطوى بيد وحدة\nبسعر 12900 دج فقط 🔥\n📦 الدفع عند الاستلام · 🚚 69 ولاية', link: 'https://demo.pilotix.dz/p/poussette', linkType: 'site', platform: 'Pilotix', cta: 'Commander', same: true, colors: ['#1B2A47', '#304B7C'],
    ai: { hook: 'Le prix en première ligne', angle: 'Légère et pliable', offer: '12 900 DA, livraison 69 wilayas', keep: '6 copies en 19 jours : votre pub tient', weak: 'Pas de preuve (avis, vidéo d’usage)' } },

  // ---------------- Lit parapluie (15 900 DA)
  { sku: 'PX-LIT', glyph: 'lit', page: 'Bébé Confort DZ', pageId: '900000000000101', days: 74, copies: 6, platforms: ['FACEBOOK', 'INSTAGRAM'], video: true, price: 12900, old: 18000, head: 'يتطوى في ثانية!',
    body: 'سرير الأطفال القابل للطي 🔥 يتطوى في ثانية ويدخل في شكارة!\nالتوصيل لـ 58 ولاية والدفع عند الاستلام\n12900 دج بدل 18000 دج', link: 'https://bebeconfort-dz.youcan.store/products/lit-parapluie', linkType: 'site', platform: 'YouCan', cta: 'Commander', same: true, colors: ['#F7A823', '#E8730C'],
    ai: { hook: 'Démo du pliage en une seconde', angle: 'Gain de place et voyages en famille', offer: '12 900 DA au lieu de 18 000, livraison gratuite', keep: 'La démo de pliage dans les 3 premières secondes', weak: 'Prix barré de 18 000 DA peu crédible' },
    site: { price: 12900, oldPrice: 18000, wilayas: 58, stopdesk: true, whatsapp: true } },
  { sku: 'PX-LIT', glyph: 'lit', page: 'Prix Choc Bébé', pageId: '900000000000104', days: 63, copies: 9, platforms: ['FACEBOOK', 'INSTAGRAM', 'MESSENGER'], video: false, price: 13500, old: 16900, head: 'ناموسية هدية 🎁',
    body: 'عرض محدود ⏳ سرير + ناموسية هدية 🎁\n13500 دج فقط بدل 16900 دج — الخلاص عند الاستلام', link: 'https://prixchoc.foorweb.store/lit', linkType: 'site', platform: 'Foorweb', cta: 'Commander', same: true, colors: ['#2E7D6B', '#174F45'],
    ai: { hook: 'Le cadeau (moustiquaire) en gros', angle: 'Bonne affaire, offre limitée', offer: '13 500 DA + moustiquaire offerte', keep: 'Un cadeau qui fait monter la valeur', weak: 'Aucune preuve : photo produit seule' },
    site: { price: 13500, oldPrice: 16900, wilayas: 69, stopdesk: true, whatsapp: true } },
  { sku: 'PX-LIT', glyph: 'lit', page: 'Maison Bébé Algérie', pageId: '900000000000103', days: 41, copies: 3, platforms: ['FACEBOOK', 'INSTAGRAM'], video: false, price: 14500, head: '2 en 1 · matelas offert',
    body: 'Lit parapluie 2 en 1 avec matelas offert ✅\nLivraison 58 wilayas, paiement à la livraison. 14 500 DA', link: 'https://maisonbebe-dz.myshopify.com/products/lit-parapluie', linkType: 'site', platform: 'Shopify', cta: 'Voir l’offre', same: true, colors: ['#C05C7E', '#7A2E4C'],
    ai: { hook: 'Le 2 en 1 dans le titre', angle: 'Confort, clientèle plus aisée', offer: '14 500 DA + matelas offert', keep: 'Un carrousel qui montre chaque détail', weak: 'Texte seulement en français' },
    site: { price: 14500, oldPrice: null, wilayas: 58, stopdesk: true, whatsapp: false } },
  { sku: 'PX-LIT', glyph: 'lit', page: 'Mama Store Oran', pageId: '900000000000106', days: 18, copies: 1, platforms: ['FACEBOOK', 'MESSENGER'], video: true, price: null, head: 'خفيف وساهل للحمل 👶',
    body: 'سرير الرحلات للبيبي 👶 خفيف وساهل للحمل\nابعثلنا ميساج', link: null, linkType: 'messenger', cta: 'Envoyer un message', same: true, colors: ['#E5735A', '#A23E2A'],
    ai: { hook: 'Un bébé qui dort dedans', angle: 'Le sommeil de bébé en voyage', offer: 'Prix en privé', keep: 'L’émotion du bébé qui dort', weak: 'Pas de prix : il faut écrire en privé' } },
  { sku: 'PX-LIT', glyph: 'lit', page: 'Douceur Bébé', pageId: '900000000000107', days: 2, copies: 2, platforms: ['FACEBOOK', 'INSTAGRAM'], video: true, price: 16500, old: 19900, head: 'ضمان 6 أشهر ✅',
    body: 'سرير أطفال قابل للطي بجودة عالية ✅ ضمان 6 أشهر\n16500 دج بدل 19900 دج', link: 'https://douceurbebe.dzbuild.app/product/lit', linkType: 'site', platform: 'DZBuild', cta: 'Commander', same: true, colors: ['#5A8F3E', '#2F5A1E'],
    ai: { hook: 'La garantie de 6 mois', angle: 'Qualité et durée', offer: '16 500 DA, garantie 6 mois', keep: 'Une garantie écrite, rare chez les autres', weak: 'Trop récent pour juger' },
    site: { price: 16500, oldPrice: 19900, wilayas: 69, stopdesk: true, whatsapp: true } },
  { sku: 'PX-LIT', glyph: 'lit', page: 'Douceur Bébé', pageId: '900000000000107', days: 2, copies: 1, platforms: ['FACEBOOK'], video: false, price: 16500, head: 'سرير البيبي للسفر',
    body: 'سرير البيبي للسفر، متين وخفيف\n16500 دج · التوصيل 69 ولاية', link: 'https://douceurbebe.dzbuild.app/product/lit', linkType: 'site', platform: 'DZBuild', cta: 'Commander', same: true, colors: ['#4C7A34', '#244515'],
    ai: { hook: 'Le voyage avec bébé', angle: 'Solidité', offer: '16 500 DA', keep: '—', weak: 'Image produit seule' },
    site: { price: 16500, oldPrice: 19900, wilayas: 69, stopdesk: true, whatsapp: true } },

  // ---------------- Chaise haute évolutive (8 900 DA)
  { sku: 'PX-CHA', glyph: 'cha', page: 'Maison Bébé Algérie', pageId: '900000000000103', days: 66, copies: 5, platforms: ['FACEBOOK', 'INSTAGRAM'], video: true, price: 7900, old: 9900, head: '3 في 1 · يكبر مع البيبي',
    body: 'Chaise haute évolutive 3 en 1 ✅ كرسي يكبر مع البيبي\n7 900 DA au lieu de 9 900', link: 'https://maisonbebe-dz.myshopify.com/products/chaise-haute', linkType: 'site', platform: 'Shopify', cta: 'Commander', same: true, colors: ['#C05C7E', '#7A2E4C'],
    ai: { hook: 'Les 3 positions en accéléré', angle: 'Un seul achat jusqu’à 3 ans', offer: '7 900 DA au lieu de 9 900', keep: 'Montrer les 3 positions en 5 secondes', weak: '—' },
    site: { price: 7900, oldPrice: 9900, wilayas: 58, stopdesk: true, whatsapp: false } },
  { sku: 'PX-CHA', glyph: 'cha', page: 'Hanout Bébé', pageId: '900000000000108', days: 12, copies: 1, platforms: ['FACEBOOK'], video: false, price: 6900, head: '6900 دج فقط',
    body: 'كرسي أكل للبيبي 6900 دج فقط\nاطلب عبر الواتساب', link: 'https://wa.me/213555000108', linkType: 'whatsapp', cta: 'WhatsApp', same: false, colors: ['#6B7A8F', '#3E4A5C'],
    ai: { hook: 'Le prix bas', angle: 'Le moins cher', offer: '6 900 DA', keep: '—', weak: 'Chaise simple, pas évolutive : produit proche' } },
  { sku: 'PX-CHA', glyph: 'cha', page: 'Mama Store Oran', pageId: '900000000000106', days: 29, copies: 2, platforms: ['FACEBOOK', 'INSTAGRAM'], video: true, price: 8500, head: 'وقت الماكلة ولا ساهل 😋',
    body: 'وقت الماكلة ولا ساهل مع هاد الكرسي 😋\n8500 دج، ابعثي ميساج', link: null, linkType: 'messenger', cta: 'Envoyer un message', same: true, colors: ['#E5735A', '#A23E2A'],
    ai: { hook: 'Un bébé qui mange seul et rit', angle: 'Des repas sans stress', offer: '8 500 DA', keep: 'L’émotion du repas', weak: 'Commande seulement en message' } },
];

const KEYWORDS: Record<string, { q: string; lang: string; count: number }[]> = {
  'PX-POU': [
    { q: 'poussette', lang: 'fr', count: 58 },
    { q: 'عربة أطفال', lang: 'ar', count: 22 },
    { q: 'كروسة البيبي', lang: 'darija', count: 6 },
    { q: 'poussette canne', lang: 'fr', count: 9 },
    { q: '12900 دج', lang: 'price', count: 3 },
  ],
  'PX-LIT': [
    { q: 'lit parapluie', lang: 'fr', count: 7 },
    { q: 'سرير قابل للطي', lang: 'ar', count: 14 },
    { q: 'سرير البيبي', lang: 'darija', count: 11 },
    { q: 'lit pliant bébé', lang: 'fr', count: 4 },
  ],
  'PX-CHA': [
    { q: 'chaise haute', lang: 'fr', count: 12 },
    { q: 'كرسي أكل للأطفال', lang: 'ar', count: 9 },
    { q: 'كرسي البيبي', lang: 'darija', count: 8 },
  ],
};

const BRIEFS: Record<string, { summary: string; hooks: { ar: string; fr: string }[]; offer: string; page: string }> = {
  'PX-POU': {
    summary: 'Prix Choc Bébé pousse fort : 7 copies de la même pub en 6 jours à 10 900 DA. Bébé Confort DZ tient depuis 52 jours à 11 900 DA avec la démo de pliage à une main. À 12 900 DA vous êtes dans la moyenne, et votre pub tient (6 copies en 19 jours).',
    hooks: [
      { ar: 'تتطوى بيد وحدة وتدخل في صندوق أي طوموبيل', fr: 'Pliage à une main + coffre de voiture, l’angle qui dure le plus' },
      { ar: '6 كيلو برك، تطلعي بيها في الطرامواي بلا تعب', fr: 'Le poids exact et la vie en ville' },
      { ar: 'عربة + غطاء المطر هدية، والتوصيل لـ 69 ولاية', fr: 'Un cadeau plutôt qu’une baisse de prix' },
    ],
    offer: 'Ne suivez pas 10 900 DA. Gardez 12 900 DA avec un cadeau (protection pluie) : vous restez au-dessus de votre coût.',
    page: 'Montrez le poids et la taille pliée en haut de la page, et gardez les 69 wilayas dans le formulaire.',
  },
  'PX-LIT': {
    summary: 'Le lit parapluie se vend bien en ce moment : Bébé Confort DZ tient depuis 74 jours (6 copies) à 12 900 DA et Prix Choc Bébé depuis 63 jours (9 copies) avec une moustiquaire offerte. À 15 900 DA vous êtes parmi les plus chers, sans cadeau ni garantie.',
    hooks: [
      { ar: 'شوفي كيفاش يتطوى بيد وحدة ويدخل في الشنطة', fr: 'La démo de pliage dans les 3 premières secondes' },
      { ar: 'سرير البيبي + ماطلة هدية، والتوصيل لباب الدار', fr: 'Un cadeau face à la moustiquaire de Prix Choc' },
      { ar: 'ضمان 6 أشهر: إذا تكسر نبدلوهولك', fr: 'La garantie, que seul Douceur Bébé met en avant' },
    ],
    offer: 'Gardez 15 900 DA en ajoutant le matelas offert, ou passez à 13 900 DA sans cadeau.',
    page: 'Formulaire avec les 69 wilayas, choix domicile ou bureau, avis clients en photo.',
  },
  'PX-CHA': {
    summary: 'Maison Bébé Algérie tient depuis 66 jours (5 copies) avec les 3 positions montrées en accéléré, à 7 900 DA. À 8 900 DA vous êtes au plus haut des chaises évolutives.',
    hooks: [
      { ar: 'كرسي واحد يكبر مع البيبي حتى 3 سنين', fr: 'Un seul achat jusqu’à 3 ans' },
      { ar: 'وقت الماكلة ولا راحة للماما', fr: 'Des repas sans stress' },
      { ar: 'يتنظف في دقيقة، ماكانش وسخ', fr: 'Le nettoyage rapide, que personne ne montre' },
    ],
    offer: 'Passez à 7 900 DA, ou gardez 8 900 DA avec un bavoir offert.',
    page: 'La vidéo des 3 positions en haut de la page, avant le formulaire.',
  },
};

export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const ids = new Map<string, number>();
  for (const sku of Object.keys(KEYWORDS)) {
    const id = num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id);
    if (id) ids.set(sku, id);
  }
  if (!ids.size) return;
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
  let n = 0;
  for (const a of ADS) {
    const productId = ids.get(a.sku);
    if (!productId) continue;
    n++;
    const adId = `9${String(100000000000000 + n * 7919)}`;
    const adIds = Array.from({ length: Math.min(a.copies, 12) }, (_, k) => `9${String(100000000000000 + n * 7919 + k * 13)}`);
    const site = a.site ? { checkedAt: day(1), ok: true, platform: a.platform ?? null, title: null, ...a.site } : null;
    await db.query(
      `INSERT INTO spy_ads (product_id, gkey, ad_id, ad_ids, source, page_id, page_name, body, link_url, link_type, platform, cta, platforms, is_video, media,
                            copies, started_at, first_seen, last_seen, active, own, keyword, price, old_price, relevant, same, ai, site)
       VALUES ($1,$2,$3,$4,'demo',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,$19,$20,$21,$22,true,$23,$24,$25) ON CONFLICT DO NOTHING`,
      [
        productId,
        `${a.pageId}#demo${n}`,
        adId,
        adIds,
        a.pageId,
        a.page,
        a.body,
        a.link,
        a.linkType,
        a.platform ?? null,
        a.cta,
        a.platforms,
        a.video,
        creative(a.colors, a.glyph, a.head, a.price, a.old ?? null, a.video),
        a.copies,
        day(a.days),
        day(Math.min(a.days, 3)),
        day(0),
        !!a.own,
        KEYWORDS[a.sku][0].q,
        a.price,
        a.old ?? null,
        a.same,
        JSON.stringify(a.ai),
        site ? JSON.stringify(site) : null,
      ],
    );
  }
  for (const [sku, productId] of ids) {
    const b = BRIEFS[sku];
    await db.query(`INSERT INTO spy_watch (product_id, keywords, watch, brief, brief_at, scanned_at) VALUES ($1, $2, true, $3, $4, $4) ON CONFLICT (product_id) DO NOTHING`, [
      productId,
      JSON.stringify(KEYWORDS[sku].map((k) => ({ ...k, at: day(0) }))),
      JSON.stringify({ ...b, at: day(0), demo: true }),
      day(0),
    ]);
  }
  // two followed competitors and what they did lately
  const pou = ids.get('PX-POU') ?? null;
  const lit = ids.get('PX-LIT') ?? null;
  await db.query(
    `INSERT INTO spy_follow (page_key, page_name, product_id, created_by, created_at) VALUES ('900000000000104', 'Prix Choc Bébé', $1, $3, $4), ('900000000000101', 'Bébé Confort DZ', $2, $3, $4) ON CONFLICT DO NOTHING`,
    [pou, lit, users.marketer ?? null, day(9)],
  );
  await db.query(
    `INSERT INTO spy_events (at, kind, page_name, product_id, data) VALUES
       ($1, 'new_ad', 'Prix Choc Bébé', $4, '{"price":10900}'),
       ($2, 'price', 'Bébé Confort DZ', $5, '{"from":14500,"to":12900}'),
       ($3, 'stopped', 'Prix Choc Bébé', $5, '{}')`,
    [day(6), day(1), day(3), pou, lit],
  );
}
