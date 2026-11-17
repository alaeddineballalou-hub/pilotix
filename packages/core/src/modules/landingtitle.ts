// « Écrire avec l'IA » next to « Titre affiché » (Landing pages › a page): Claude writes the page's title in Algerian
// Darija (Arabic letters, 1 or 2 emojis), from what the shop knows of the product: its name and options, the page's
// points and text as typed in the editor (even unsaved), the product sheet and its sales guide.
// - One click shows one title. Claude writes 3 at once (3 angles, the best first): the editor keeps the other two for
//   the next clicks, then asks again, telling Claude the titles already shown so it writes new ones.
// - Pilotix pays (Pilot AI's key, or the shop's own key without it), like « Écrire avec l'IA » of the sales guide.
// - Every title is checked before it is shown (titleProblem): no number the shop's words do not give, no price, no
//   discount, no fake urgency or rarity, no « free », guarantee or « original » the shop did not write, no big word
//   without proof, no health promise, no payment or delivery talk (the page shows them), Arabic letters, at most 2
//   emojis, and Dellal's Darija check (darija.ts). A refused title is never shown.
// - Nothing is saved here: the editor's « Enregistrer » does that, after the seller read it.
// The preview without Claude gives example titles made from the product's name (by: 'rules').
// The instructions are built from the skills Pilotix's owner uses for selling (Algerian cash-on-delivery selling,
// marketing psychology, copywriting, content creation) and Pilotix's Darija book (darijabook.ts), shared with Dellal.
import { landingDescriptionText } from '@pilotix/shared';
import { z } from 'zod';
import { bad, Ctx, notFound, proc } from '../rpc';
import { checkDarija } from './darija';
import { darijaGuide } from './darijabook';
import { aiKeyed, pilotOn } from './dellal';
import { readGuide, toFill } from './guide';
import { lahjaAvoid, lahjaBlocks, lahjaFor } from './lahja';
import { splitOptions, WHO } from './landing';

export const TITLE_MODEL = 'claude-sonnet-5-5';
/** max: the length asked for (2 lines on a phone); hard: longer is refused; ask: titles per answer; avoid: shown ones sent back; rounds: tries */
export const TITLE = { max: 60, hard: 70, min: 12, emojis: 2, ask: 3, avoid: 12, rounds: 3 } as const;
export const NO_AI = 'L’IA n’est pas disponible maintenant : réessayez dans un moment.';
export const NO_SAFE_TITLE = 'L’IA n’a pas donné de titre sûr cette fois : recliquez pour réessayer.';

/** Claude's instructions (the same for every shop: the server keeps them in cache). */
export const TITLE_PROMPT = `Tu es le meilleur rédacteur publicitaire e-commerce d’Algérie : 10 ans de pages de vente et de pubs Facebook, Instagram et TikTok qui vendent en paiement à la livraison, dans toutes les wilayas. Tu écris le TITRE d’une landing page : la grande phrase en haut de la page, juste au-dessus du prix et du bouton de commande.

Où ce titre se voit (il doit marcher partout) :
- en gros sur le téléphone, au-dessus du prix : 2 lignes au maximum ;
- dans l’onglet du navigateur et dans l’aperçu du lien sur Facebook, Messenger et WhatsApp ;
- comme nom du produit dans le résumé de la commande et dans le message WhatsApp que le client envoie à la boutique.
Donc le client doit TOUJOURS comprendre quel produit il commande : chaque titre nomme le produit, avec les mots d’un client algérien.

Qui lit : un Algérien sur son téléphone, venu d’une pub. Il décide en 3 secondes. Il achète sur le désir et sur la confiance. Il connaît les arnaques (produit différent de la photo, fausses promos, « quantité limitée ») et il refuse le colis quand la page a promis plus que le produit : un colis refusé coûte cher à la boutique. Ton but : donner envie tout de suite, sans jamais promettre plus que le produit.

Comment écrire un titre qui fait acheter :
1. Le produit + ce qu’il change pour le client (le bénéfice, pas la fiche technique) : on n’achète pas une perceuse, on achète le trou.
2. Une image que le client voit dans sa tête : ses enfants en voiture, sa cuisine propre, sa tenue pour la fête.
3. Le point fort le plus concret et VRAI des informations : un chiffre, une matière, un usage (« 6 كغ », « 12 جيب », « بيد وحدة »). Un détail précis vaut mieux qu’un grand mot (« جودة عالية », « رائع »). Quand les informations ne donnent aucun chiffre (âge, poids, taille, nombre), n’en écris aucun : prends un usage ou une image à la place.
4. Le bénéfice tout de suite, au présent : ce que le client gagne dès qu’il l’a.
5. Une seule idée par titre. Court : 4 à 9 mots, 25 à 55 caractères (60 au maximum), émojis compris.
6. Le test du concurrent : si une autre boutique pouvait écrire exactement le même titre pour un autre produit, ajoute un détail vrai qui n’est qu’à celui-ci.
7. Le test « دركا تقدر » : en le lisant, le client doit se dire « avec ça, je peux enfin… ».

Écris 3 titres, 3 angles différents, ton meilleur en premier :
- le bénéfice : ce que le client gagne ;
- le problème : la gêne de tous les jours que le produit enlève (une vraie gêne, jamais un défaut du corps de la personne) ;
- l’émotion : la famille, la fierté, le cadeau, la tranquillité.
Si un angle ne va pas à ce produit, prends-en un autre, mais jamais deux titres qui disent la même chose.

La langue : la darija algérienne en lettres arabes, comme les meilleurs vendeurs algériens l’écrivent dans leurs pubs : simple, chaleureuse, comprise d’Oran à Annaba et dans le Sud.
- Des mots algériens que tout le monde comprend : ولادك، دارك، حوايج، بلاصة، ساهل، مليح، بزاف، ڨاع، دركا، تاع، باش، كيما، خلي، ما تبقاش.
- Jamais l’arabe classique de service client ou de pub du Moyen-Orient : pas « منتجنا الرائع »، « اكتشف »، « استمتع بـ »، « عزيزي العميل »، « نقدم لكم »، « يرجى ».
- Jamais de mots du Maroc, de Tunisie, d’Égypte, du Levant ou du Golfe : pas « دابا »، « ديال »، « مزيان »، « برشا »، « توا »، « كتير »، « هلق »، « أوي »، « ده »، « وايد ».
- Le nom du produit peut être mal écrit (copié d’un fournisseur, ex. « مقعد جلوس للاطفال سيارة ») : dis-le comme un client algérien le dit (« كرسي السيارة للأطفال »), sans changer ce qu’est le produit.
- Lettres latines seulement pour une marque ou un modèle écrit ainsi dans les informations (Xiaomi, USB-C). Les chiffres en 0-9.
- Tu parles au client avec « ك » (ولادك، دارك، ليك) : c’est pareil pour un homme et une femme. Un verbe qui change avec le genre (تحب / تحبي) : au féminin seulement si le produit est clairement pour les femmes, sinon au pluriel ou une tournure qui va aux deux.

Les émojis : 1 ou 2 par titre, jamais 0, jamais 3.
- Un émoji qui montre le produit ou son bénéfice (🚗 voiture, 👶 bébé, 🍼 biberon, 🎒 sac, ✨ propreté ou beauté, ⌚ montre, 🎁 cadeau).
- Après les mots du produit ou à la fin, jamais au milieu d’un mot, jamais deux fois le même.
- Pas de 🔥💯🤑⚠️❌‼️, pas de drapeau, pas de signe religieux.

Interdit (Pilotix refuse le titre s’il en a un) :
- Un fait qui n’est pas dans les informations : matière, taille, poids, âge, nombre de pièces, garantie, échange, cadeau, livraison gratuite, origine, « أصلي », avis de clients. Chaque chiffre du titre est écrit dans les informations.
- Le prix, une réduction ou un pourcentage (la page les montre juste en dessous, et ils changent) : pas « تخفيض »، « برومو »، « -50% »، « مجانا ».
- Le paiement et la livraison : la page les montre déjà.
- La fausse urgence et la fausse rareté : « كمية محدودة »، « آخر قطع »، « العرض ينتهي »، « اليوم برك »، « سارع » : les Algériens y voient une arnaque.
- Les grands mots sans preuve : « الأفضل »، « رقم 1 »، « الأكثر مبيعا »، « 100% »، « ما كانش كيفو ».
- « مضمون »، « ضمان » (garanti) quand les informations ne le disent pas, même pour la sécurité : écris « أمان »، « مرتاح البال »، « محمي » sans « مضمون ».
- La santé et le corps : guérir, soigner, maigrir, « قبل و بعد », et toute question sur un défaut du corps (« راك سمين؟ ») : Meta et TikTok refusent ces pubs.
- Le nom d’une autre marque que celle du produit.
- Ce que le guide de vente range dans « à ne jamais dire ».
- « ! » ou « ؟ » plus d’une fois, les guillemets, les hashtags, les tirets longs (—).

Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{"titles": ["…", "…", "…"]}`;

export const TitleInput = z.object({
  productId: z.number().int().positive(),
  /** the editor's words now (maybe not saved yet) */
  title: z.string().max(200).default(''),
  description: z.string().max(8000).default(''),
  price: z.number().int().min(0).max(100_000_000).nullable().default(null),
  oldPrice: z.number().int().min(0).max(100_000_000).nullable().default(null),
  /** the titles this editor already showed: the next ones say something else */
  avoid: z.array(z.string().max(200)).max(TITLE.avoid).default([]),
});
export type TitleIn = z.infer<typeof TitleInput>;

/** What a title is checked against: the shop's own words (a number or a « guarantee » must be there), the prices. */
export interface TitleCheck {
  allow: string;
  price: number | null;
  oldPrice: number | null;
}
export interface TitleFacts extends TitleCheck {
  name: string;
  /** Claude's question (the facts) */
  text: string;
}

const cut = (s: unknown, n: number) => String(s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, n);
const da = (n: number) => `${n.toLocaleString('fr-FR').replace(/\s/g, ' ')} DA`;

/** The facts Claude writes from (the product, the page as typed, the sales guide), and what the titles are checked against. */
export async function titleFactsOf(ctx: Ctx, i: TitleIn): Promise<TitleFacts> {
  const p = (await ctx.db.query('SELECT name, brand, description, price, options FROM products WHERE id = $1', [i.productId]))[0];
  if (!p) throw notFound('Produit introuvable');
  const vars = (await ctx.db.query(`SELECT title FROM product_variants WHERE product_id = $1 AND active AND title <> '' ORDER BY id`, [i.productId])).map((r) => String(r.title));
  const opts = splitOptions(p.options, vars.map((title) => ({ title })));
  const saved = await readGuide(ctx.db, i.productId).catch(() => null);
  const g = saved?.guide ?? null;
  const filled = (x: string) => !toFill(x);
  const name = cut(p.name, 200);
  const brand = cut(p.brand, 120);
  const sheet = cut(p.description, 3000);
  const page = cut(landingDescriptionText(i.description ?? ''), 4000);
  const options = opts?.length
    ? opts.map((o) => `${o.name} (${o.values.length}) : ${o.values.join(', ')}`)
    : vars.length
      ? [`Variantes (${vars.length}) : ${vars.slice(0, 40).join(', ')}`]
      : [];
  const strengths = (g?.strengths ?? []).filter(filled).slice(0, 8);
  const never = (g?.never ?? []).filter(filled).slice(0, 8);
  const price = i.price ?? (p.price === null || p.price === undefined ? null : Number(p.price));
  // the words a title may build on: never the guide's « à ne jamais dire » lines (they name what must not be said)
  const allow = [name, brand, ...options, i.title, page, sheet, g?.brief ?? '', ...strengths].join('\n');
  const text = [
    `Produit : ${name}${brand ? ` (marque ${brand})` : ''}`,
    ...options,
    price ? `Prix : ${da(price)} (pour le ton seulement : jamais dans le titre)` : '',
    `Titre actuel de la page : ${i.title.trim() || '(vide)'}`,
    `Points et texte de la page :\n${page || '(vide)'}`,
    sheet && sheet !== page ? `Fiche du produit :\n${sheet}` : '',
    g?.brief?.trim() ? `Guide de vente, en bref : ${cut(g.brief, 600)}` : '',
    strengths.length ? `Guide de vente, points forts :\n${strengths.map((x) => `- ${cut(x, 300)}`).join('\n')}` : '',
    never.length ? `Guide de vente, à ne jamais dire :\n${never.map((x) => `- ${cut(x, 300)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { name, text, allow, price, oldPrice: i.oldPrice };
}

/** Claude's question: the facts, and the titles already shown (never again, not even reworded). */
export function titleQuestion(f: Pick<TitleFacts, 'text'>, avoid: string[]): string {
  const shown = [...new Set(avoid.map((x) => x.trim()).filter(Boolean))].slice(0, TITLE.avoid);
  return [
    'Écris 3 titres pour cette landing page.',
    '',
    f.text,
    shown.length ? `\nDéjà proposés au vendeur : ne les répète pas et ne les reformule pas, prends d’autres angles et d’autres mots.\n${shown.map((x) => `- ${x}`).join('\n')}` : '',
  ]
    .filter((x, k) => x !== '' || k === 1)
    .join('\n');
}

// ---------------------------------------------------------------- the checks
const EMOJI = /\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu;
/** Arabic-Indic digits as 0-9 */
const latinDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
/** the numbers written in a text (12 900 and 12.900 are one number) */
const numbersIn = (s: string): string[] => [...latinDigits(s).matchAll(/\d(?:[\d   .,]*\d)?/g)].map((m) => m[0].replace(/[^\d]/g, '')).filter(Boolean);

/** The words a title may say only when the shop's own words say them. */
const ONLY_IF_SAID: { why: string; re: RegExp }[] = [
  { why: 'urgence', re: /كمية\s*محدود|محدودة|آخر\s*(?:قطع|حبات|فرصة)|اخر\s*(?:قطع|حبات|فرصة)|ينتهي|اليوم\s*(?:برك|فقط)|سارع|ما\s*تضيعش|limité|dernières?\s*pièces?|stock\s*limit/iu },
  { why: 'gratuit', re: /مجان|فابور|gratuit|\bfree\b/iu },
  { why: 'garantie', re: /ضمان|مضمون|garanti/iu },
  { why: 'original', re: /أصلي|اصلي|original/iu },
  { why: 'superlatif', re: /الأفضل|الافضل|رقم\s*(?:1|١|واحد)|الأكثر\s*مبيع|الاكثر\s*مبيع|ما\s*كانش\s*كيف|best[-\s]?seller|n°\s*1/iu },
  // « طبي » (medical) as a word, never inside « طبيعي » (natural)
  { why: 'santé', re: /يعالج|علاج|يشفي|شفاء|تنحيف|ينحف|الكرش|(?<!\p{L})(?:ال)?طبي(?:ة)?(?!\p{L})|médical|maigr/iu },
];
/** Never in a title: the page shows the price, the discount, the payment and the delivery just under it. */
const NEVER: { why: string; re: RegExp }[] = [
  { why: 'prix', re: /%|٪|دج|دينار|\bDA\b|\bDZD\b|تخفيض|برومو|promo|solde|réduction|remise|بسعر|السعر/iu },
  { why: 'livraison', re: /التوصيل|توصيل|يوصلك|لباب\s*الدار|الدفع|الخلاص|عند\s*الاستلام|livraison|paiement/iu },
  { why: 'avant-après', re: /قبل\s*و\s*بعد|avant\s*\/?\s*apr[eè]s/iu },
];

/** A title as Claude wrote it, tidied: no quotes, hashtags or long dashes, one space between words, at most 2 emojis. */
export function tidyTitle(raw: unknown): string {
  let n = 0;
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/[«»"“”„]/g, ' ')
    .replace(/[—–]/g, ' ')
    .replace(EMOJI, (m) => (++n <= TITLE.emojis ? m : ' '))
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,،:;\-]+|[\s.,،:;\-]+$/gu, '')
    .trim();
}

/** The same title whatever its emojis, spaces, short vowels and punctuation (to find a repeat). */
export const titleKey = (t: string) =>
  latinDigits(String(t ?? ''))
    .replace(EMOJI, '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();

/** Why a title cannot be shown (null: it can). `words`: the Darija the shop's lessons forbid. */
export function titleProblem(t: string, f: TitleCheck, words: { term: string; use?: string }[] = []): string | null {
  const len = [...t].length;
  if (len < TITLE.min) return 'trop court';
  if (len > TITLE.hard) return 'trop long';
  const arabic = (t.match(/\p{Script=Arabic}/gu) ?? []).length;
  const latin = (t.match(/\p{Script=Latin}/gu) ?? []).length;
  if (arabic < 6 || latin > arabic) return 'pas en lettres arabes';
  if ((t.match(/[!！]/g) ?? []).length > 1 || (t.match(/[?؟]/g) ?? []).length > 1) return 'ponctuation';
  for (const r of NEVER) if (r.re.test(t)) return r.why;
  for (const r of ONLY_IF_SAID) if (r.re.test(t) && !r.re.test(f.allow)) return r.why;
  // every number from the shop's words, and never a price
  const known = new Set(numbersIn(f.allow));
  for (const x of numbersIn(t)) {
    if ((f.price && x === String(f.price)) || (f.oldPrice && x === String(f.oldPrice))) return 'prix';
    if (!known.has(x)) return 'chiffre inventé';
  }
  if (checkDarija(t, { avoid: words }).length) return 'darija';
  return null;
}

/** Claude's answer as the titles that can be shown, the best first, none already shown (`avoid`). */
export function readTitles(text: string, f: TitleCheck, o: { avoid?: string[]; words?: { term: string; use?: string }[] } = {}): { titles: string[]; refused: { title: string; why: string }[] } {
  const raw = String(text ?? '').replace(/```(?:json)?/g, '');
  let list: unknown[] = [];
  for (const m of [raw.match(/\{[\s\S]*\}/)?.[0], raw.match(/\[[\s\S]*\]/)?.[0]]) {
    if (!m || list.length) continue;
    try {
      const j = JSON.parse(m);
      list = Array.isArray(j) ? j : Array.isArray(j?.titles) ? j.titles : typeof j?.title === 'string' ? [j.title] : [];
    } catch {
      /* not JSON: nothing from this part */
    }
  }
  const seen = new Set((o.avoid ?? []).map(titleKey).filter(Boolean));
  const titles: string[] = [];
  const refused: { title: string; why: string }[] = [];
  for (const x of list.slice(0, 6)) {
    if (typeof x !== 'string') continue;
    const t = tidyTitle(x);
    const why = titleProblem(t, f, o.words) ?? (seen.has(titleKey(t)) ? 'déjà proposé' : null);
    if (why) {
      refused.push({ title: t, why });
      continue;
    }
    seen.add(titleKey(t));
    titles.push(t);
  }
  return { titles: titles.slice(0, TITLE.ask), refused };
}

// ---------------------------------------------------------------- without Claude (the preview): examples
const EMOJI_OF: [RegExp, string][] = [
  [/سيار|طوموبيل|voiture|auto\b|car\b/i, '🚗'],
  [/حقيب|ساك|sac\b|bag/i, '🎒'],
  [/رضاع|بيبرون|biberon|bottle/i, '🍼'],
  [/ساع|montre|watch/i, '⌚'],
  [/مطبخ|cuisine|kitchen/i, '🍳'],
  [/بيبي|أطفال|اطفال|طفل|bébé|bebe|enfant|baby|kid|poussette|عرب/i, '👶'],
];
/** Example titles from the product's name only (they claim nothing about it). */
export function rulesTitles(name: string, avoid: string[] = []): string[] {
  const n = tidyTitle(name).slice(0, 40) || 'المنتج';
  const e = EMOJI_OF.find(([re]) => re.test(name))?.[1] ?? '✨';
  const all = [`${n} ${e} دركا عندنا`, `${n} ${e} ليك ولعايلتك`, `${n} 🎁 هدية تفرّح اللي تحبهم`];
  const seen = new Set(avoid.map(titleKey));
  const left = all.filter((x) => !seen.has(titleKey(x)));
  return left.length ? left : all;
}

// ---------------------------------------------------------------- the action
/** Why a title was refused, told to Claude for its second try (what to write instead). */
const TOLD: Record<string, string> = {
  'chiffre inventé': 'un chiffre que les informations ne donnent pas : n’écris aucun chiffre qui n’y est pas (âge, poids, taille, nombre)',
  prix: 'le prix, une réduction ou un pourcentage',
  livraison: 'le paiement ou la livraison',
  urgence: 'une fausse urgence ou une fausse rareté',
  gratuit: '« gratuit » que la boutique n’a pas écrit',
  garantie: 'une garantie que la boutique n’a pas écrite (« مضمون »، « ضمان ») : pour la sécurité, dis « أمان » ou « مرتاح البال » sans « مضمون »',
  original: '« original » que la boutique n’a pas écrit',
  superlatif: 'un grand mot sans preuve (le meilleur, n° 1…)',
  santé: 'une promesse de santé ou un mot médical',
  'avant-après': '« avant / après »',
  darija: 'des mots que les règles de darija refusent',
  'trop long': 'trop long : 60 caractères au plus, émojis compris',
  'trop court': 'trop court : au moins 4 mots',
  'pas en lettres arabes': 'pas en lettres arabes',
  ponctuation: 'plus d’un « ! » ou d’un « ؟ »',
  'déjà proposé': 'déjà proposé au vendeur',
};
/** The main reason all the titles were refused, told to the seller with what to do. */
const SELLER: Record<string, string> = {
  '': 'sa réponse était illisible. Recliquez pour réessayer.',
  prix: 'ses titres parlaient du prix ou d’une réduction (la page les montre déjà). Recliquez pour réessayer.',
  livraison: 'ses titres parlaient de livraison ou de paiement (la page les montre déjà). Recliquez pour réessayer.',
  urgence: 'ses titres avaient une fausse urgence (« كمية محدودة »، « ينتهي »…). Recliquez pour réessayer.',
  gratuit: 'ses titres disaient « gratuit » sans que la page le dise. Recliquez pour réessayer.',
  garantie: 'ses titres disaient « مضمون / ضمان » (garanti) sans que la page le dise. Écrivez la garantie dans le texte de la page si elle existe, ou recliquez.',
  original: 'ses titres disaient « أصلي » (original) sans que la page le dise. Recliquez pour réessayer.',
  superlatif: 'ses titres avaient des grands mots sans preuve (الأفضل، رقم 1…). Recliquez pour réessayer.',
  'avant-après': 'ses titres disaient « avant / après ». Recliquez pour réessayer.',
  'trop long': 'ses titres étaient trop longs. Recliquez pour réessayer.',
  'trop court': 'ses titres étaient trop courts. Recliquez pour réessayer.',
  'pas en lettres arabes': 'ses titres n’étaient pas en lettres arabes. Recliquez pour réessayer.',
  ponctuation: 'ses titres avaient trop de « ! » ou de « ؟ ». Recliquez pour réessayer.',
  'chiffre inventé': 'ses titres avaient des chiffres que la page ne donne pas (âge, poids, taille…). Écrivez-les dans le texte de la page, puis recliquez.',
  santé: 'ses titres promettaient quelque chose sur la santé. Recliquez pour réessayer.',
  darija: 'ses titres avaient des mots que vos règles de darija refusent. Recliquez pour réessayer.',
  'déjà proposé': 'il ne trouve plus de nouveau titre. Changez le texte de la page, puis recliquez.',
};

/** What Pilotix tells Claude after refusing every title it wrote: each title and why, and what to write instead. */
export function retryQuestion(refused: { title: string; why: string }[], f: TitleCheck, words: { term: string; use?: string }[] = []): string {
  if (!refused.length) return 'Ta réponse n’était pas le JSON demandé. Réponds UNIQUEMENT avec {"titles": ["…", "…", "…"]}.';
  const known = new Set(numbersIn(f.allow));
  const lines = refused.slice(0, 6).map(({ title, why }) => {
    let detail = TOLD[why] ?? why;
    if (why === 'chiffre inventé') {
      const extra = [...new Set(numbersIn(title).filter((x) => !known.has(x)))];
      if (extra.length) detail += ` (ici : ${extra.join(', ')})`;
    }
    if (why === 'darija') {
      const found = checkDarija(title, { avoid: words }).map((x) => `${x.found}${x.use ? ` → ${x.use}` : ''}`);
      if (found.length) detail += ` (${found.join(' ; ')})`;
    }
    return `- « ${title} » : ${detail}`;
  });
  return `Pilotix a refusé ces titres :\n${lines.join('\n')}\nÉcris 3 nouveaux titres sans ces problèmes, avec seulement ce que disent les informations. Réponds UNIQUEMENT avec le JSON.`;
}

/** The error when no title could be shown: why (the most frequent reason), and what the seller can do. */
export function noSafeTitle(refused: { why: string }[]): string {
  if (!refused.length) return `L’IA n’a pas donné de titre sûr : ${SELLER['']}`;
  const count = new Map<string, number>();
  for (const r of refused) count.set(r.why, (count.get(r.why) ?? 0) + 1);
  const main = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const say = main ? SELLER[main] : undefined;
  return say ? `L’IA n’a pas donné de titre sûr : ${say}` : NO_SAFE_TITLE;
}

export async function aiTitles(ctx: Ctx, i: TitleIn): Promise<{ titles: string[]; by: 'ai' | 'rules' }> {
  const f = await titleFactsOf(ctx, i);
  const avoid = [...i.avoid, i.title].filter((x) => x.trim());
  // the preview opened in Claude: Claude through the page (the viewer's own account); elsewhere the server's key
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  if (!inPage && !ctx.server?.dellal) return { titles: rulesTitles(f.name, avoid), by: 'rules' };
  if (!inPage && !(await aiKeyed(ctx))) throw bad(NO_AI);
  const platform = ctx.t?.platform ?? null;
  const lessons = await lahjaFor(ctx.db, platform, ctx.shop?.id ?? null).catch(() => ({ all: [], own: [] }));
  const lb = lahjaBlocks(lessons);
  // three blocks the server caches one by one: the instructions and the Darija book (every shop), this shop's lessons
  const blocks = [
    TITLE_PROMPT,
    `RÈGLES DE DARIJA DE PILOTIX (écrites pour les messages des clients ; pour un titre, toujours en lettres arabes) :\n${await darijaGuide(platform)}`,
    [lb.shared, lb.own].filter(Boolean).join('\n\n'),
  ].filter(Boolean);
  const system = blocks.join('\n\n');
  const words = lahjaAvoid([...lessons.all, ...lessons.own]);
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: titleQuestion(f, avoid) }];
  let pilot: boolean | undefined;
  const ask = async (): Promise<string> => {
    try {
      if (pilot === undefined) pilot = !inPage && (await pilotOn(ctx));
      const res: any = inPage
        ? await inPage({ model: TITLE_MODEL, system, messages, tools: [], max_tokens: 500, runTool: async () => ({ error: 'Pas d’outil ici' }) })
        : await ctx.server!.dellal!('complete', { model: TITLE_MODEL, system, systemBlocks: blocks, messages, tools: [], max_tokens: 500, feature: 'cm', pilot }, ctx);
      if (res?.demo) throw new Error(NO_AI);
      return (res?.content ?? []).map((b: any) => (b?.type === 'text' ? String(b.text) : '')).join('');
    } catch (e) {
      throw bad(`L’IA n’a pas pu écrire le titre : ${(e as Error)?.message ?? 'réessayez'}`);
    }
  };
  // every title Claude wrote is checked; when none can be shown, Claude is told why and writes 3 more (twice at most)
  const refused: { title: string; why: string }[] = [];
  for (let round = 0; round < TITLE.rounds; round++) {
    const text = await ask();
    const r = readTitles(text, f, { avoid, words });
    if (r.titles.length) return { titles: r.titles, by: 'ai' };
    refused.push(...r.refused);
    messages.push({ role: 'assistant', content: text.trim() || '(vide)' }, { role: 'user', content: retryQuestion(r.refused, f, words) });
  }
  // the server's log keeps what was refused and why (to see it and improve the rules)
  console.warn(`[landing.aiTitle] shop ${ctx.shop?.id ?? '?'} product ${i.productId}: no safe title — ${refused.length ? refused.map((r) => `« ${r.title} » (${r.why})`).join(' | ') : 'answer not JSON'}`);
  throw bad(noSafeTitle(refused));
}

export const landingTitleProcs = {
  /** « Écrire avec l'IA » next to « Titre affiché »: 1 to 3 titles, the best first (nothing saved) */
  'landing.aiTitle': proc([...WHO], TitleInput, aiTitles),
};
