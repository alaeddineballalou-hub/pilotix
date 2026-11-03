// The sales guide of a product, read, listed, saved and drafted (modules/guide.ts holds what it is):
// - catalog.guide: one product's guide for the people who sell it (agents during a call, the depot, the owner), within
//   the products their work gives them (productscope.ts);
// - catalog.guides: Produits & stock › Guide de vente, every product with where its guide stands (none, written, answers
//   still to write), the same products only; catalog.saveGuide writes one there, catalog.guideFacts gives its writer what
//   the shop knows of the product (the AI draft, the fixed questions' answers, the sizes: one line per size, or the small
//   size guide of a product with one size only). Who writes: the owner and the depot team, and a confirmation agency's
//   people for the products the agency works on (guideWriter);
// - catalog.guideDraft: « Écrire avec l'IA » in the product form. Claude writes a first guide from what the shop knows
//   (the product, its variants, packs, linked products and services, its landing page, Dellal's shop notes) and never
//   invents a fact: an answer it cannot know stays « [À compléter] » for the team. Pilotix's key pays (Pilot AI), counted
//   with the shop's Dellal answers. Without the AI (Pilot AI off or today's limit reached, the preview): a simple draft
//   made by rules from the same facts. The team reads and corrects it; nothing is saved before « Enregistrer »;
// - catalog.translateGuide: after a save, Pilot AI translates the lines still without a translation into the other
//   reading languages (French, Arabic, English); the team's corrections stay. Without the AI they wait for the next save.
import { z } from 'zod';
import { iso, num } from '../db';
import { Ctx, forbidden, hasRole, notFound, proc, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { darijaGuide } from './darijabook';
import { aiKeyed, dellalSettings, pilotOn } from './dellal';
import {
  addTranslations,
  checkGuide,
  cleanGuide,
  EMPTY_FIT,
  fitFilled,
  GUIDE_LANGS,
  GUIDE_LIMITS as L,
  guideEmpty,
  GuideFit,
  GuideInput,
  GuideLang,
  guideSources,
  guideToFill,
  GuideTr,
  ProductGuide,
  READ_LANGS,
  ReadLang,
  readGuide,
  saveGuide,
  sizeValues,
  TO_FILL,
  toFill,
  TrInput,
  trMissing,
} from './guide';
import { agencyOf } from './agencyscope';
import { assignedProductIds, requireAssignedProducts } from './productscope';

const id = z.number().int().positive();
/** the people who may write a guide (the procs check guideWriter): the depot side, and the agencies' people */
const WRITERS = ['depot', 'confirmation', 'suivi'] as const;

/**
 * May this person write guides, and on which products: the owner, the administrators and the depot team on every
 * product (null); a confirmation agency's person on the products the agency works on. Everybody else reads only.
 */
export async function guideWriter(ctx: Ctx): Promise<number[] | null> {
  if (ctx.session.isAdmin || hasRole(ctx.session, 'depot')) return null;
  if (agencyOf(ctx) === null) throw forbidden('Seuls la boutique et ses agences de confirmation écrivent les guides de vente');
  return (await assignedProductIds(ctx)) ?? [];
}
async function writerOf(ctx: Ctx, productId?: number): Promise<number[] | null> {
  const allowed = await guideWriter(ctx);
  if (allowed && productId !== undefined && !allowed.includes(productId)) throw forbidden('Ce produit ne vous est pas confié');
  return allowed;
}
export const GUIDE_MODEL = 'claude-sonnet-5-5';
export { GUIDE_LANGS, type GuideLang };

export const DraftInput = z.object({
  /** the saved product (its landing page is read too); missing for a product not saved yet */
  productId: id.optional(),
  lang: z.enum(GUIDE_LANGS).default('fr'),
  name: z.string().trim().min(1).max(200),
  brand: z.string().trim().max(120).optional(),
  description: z.string().trim().max(5000).optional(),
  price: z.number().int().min(0).max(100_000_000).optional(),
  variants: z.array(z.string().trim().max(120)).max(200).default([]),
  packs: z.array(z.object({ qty: z.number().int().min(2).max(1000), price: z.number().int().min(0).max(100_000_000) })).max(20).default([]),
  linked: z.array(z.string().trim().max(200)).max(50).default([]),
  services: z.array(z.object({ name: z.string().trim().max(120), price: z.number().int().min(0).max(100_000_000) })).max(20).default([]),
  /** Taille, Couleur…: the sizes get an age and a weight in the guide */
  options: z.array(z.object({ name: z.string().trim().max(40), values: z.array(z.string().trim().max(60)).max(60) })).max(5).default([]),
  /** the products that go with it (Produits liés): the draft's Vente en plus picks them */
  linkedIds: z.array(id).max(50).default([]),
});
export type DraftIn = z.infer<typeof DraftInput>;

interface Facts extends DraftIn {
  shop: string;
  page: { title: string; description: string } | null;
  notes: string;
}

async function factsOf(ctx: Ctx, i: DraftIn): Promise<Facts> {
  const shop = (await getSetting(ctx.db, 'shop')).name;
  const page = i.productId
    ? (await ctx.db.query(`SELECT title, description FROM landing_pages WHERE product_id = $1 ORDER BY active DESC, updated_at DESC LIMIT 1`, [i.productId]))[0]
    : null;
  const notes = (await dellalSettings(ctx.db)).notes.trim();
  return { ...i, shop, page: page ? { title: String(page.title ?? ''), description: String(page.description ?? '').slice(0, 4000) } : null, notes: notes.slice(0, 3000) };
}

const da = (n: number) => `${n.toLocaleString('fr-FR').replace(/\s/g, ' ')} DA`;

function factsText(f: Facts): string {
  return [
    `Boutique : ${f.shop} (Algérie, vente en ligne, paiement à la livraison).`,
    `Produit : ${f.name}${f.brand ? ` (marque ${f.brand})` : ''}${f.price ? ` · prix ${da(f.price)}` : ''}`,
    f.options.length ? f.options.filter((o) => o.values.length).map((o) => `${o.name} : ${o.values.join(', ')}`).join('\n') : f.variants.length ? `Variantes : ${f.variants.join(', ')}` : '',
    sizeValues(f.options).length
      ? `Tailles (pour le guide des tailles) : ${sizeValues(f.options).join(', ')}`
      : 'Pas d’option de taille : une seule taille (le petit guide des tailles dit l’âge, le poids et les mesures, si les informations les donnent).',
    f.packs.length ? `Packs : ${f.packs.map((p) => `${p.qty} pour ${da(p.price)}`).join(', ')}` : '',
    f.linked.length ? `Produits qui vont avec : ${f.linked.join(', ')}` : '',
    f.services.length ? `Services en plus : ${f.services.map((s) => `${s.name} (${da(s.price)})`).join(', ')}` : '',
    f.description ? `Description de la fiche produit :\n${f.description}` : 'Description de la fiche produit : (vide)',
    f.page ? `Page de vente (landing page) « ${f.page.title} » :\n${f.page.description || '(sans texte)'}` : '',
    f.notes ? `Informations de la boutique (garantie, échange, livraison…) :\n${f.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const LANG_TEXT: Record<GuideLang, string> = {
  fr: 'en français simple',
  ar: 'en arabe simple, que les Algériens lisent facilement (pas d’arabe littéraire compliqué)',
  dz: 'en darija algérienne écrite en lettres latines avec les chiffres 3, 7 et 9, comme un conseiller la parle au téléphone',
  en: 'in simple English',
};

/** Claude's instructions for a first guide. */
export function draftSystem(lang: GuideLang, darija = ''): string {
  return [
    'Tu écris le « guide de vente » d’un produit pour une boutique algérienne en ligne (paiement à la livraison).',
    'Il est lu par les conseillers pendant leurs appels de confirmation, et par les vendeurs IA de la boutique (messages et commentaires).',
    '',
    'Règles :',
    '- N’invente AUCUN fait : matière, dimensions, âge, poids maximum, garantie, échange, délai, origine, avis de clients… Utilise seulement les informations données.',
    `- Une question que les clients posent souvent pour ce genre de produit, mais dont la réponse n’est pas dans les informations : écris la question, et comme réponse exactement « ${TO_FILL} » (l’équipe la complétera).`,
    '- Court et concret : des phrases simples qu’un conseiller peut dire au téléphone. Pas de titres, pas d’emojis, pas de gras.',
    `- Langue : ${LANG_TEXT[lang]}. Le marqueur « ${TO_FILL} » reste toujours écrit ainsi.`,
    '',
    'Les parties :',
    '- brief : le produit en une ou deux phrases (ce que c’est, pour qui).',
    '- strengths : 3 à 6 points forts, ce que le produit change pour le client (des bénéfices), un point par élément.',
    '- faq : 4 à 8 questions que les clients posent vraiment (taille, âge, matière, utilisation, garantie, échange, livraison…), chacune avec la réponse de la boutique.',
    '- doubts : 3 à 5 phrases que les clients disent pour ne pas commander (« ghali », « nkhamem », « ma nthiqch fi l’internet », « nchouf m3a rajli »…), chacune avec une réponse honnête et courte qui rassure sans mentir.',
    '- upsell : la phrase courte pour proposer en plus les produits qui vont avec, un pack ou un service (les produits eux-mêmes sont choisis dans le catalogue) ; vide s’il n’y a rien.',
    '- sizes : seulement si le produit a des tailles (listées) : pour chaque taille, l’âge (age) et le poids (weight) qui vont, SEULEMENT si l’information est donnée ou si le nom de la taille la dit (« 3-6 mois » → âge « 3 à 6 mois ») ; sinon laisse age et weight vides. Jamais une taille qui n’est pas listée.',
    '- fit : seulement si le produit n’a PAS de tailles listées (une seule taille) : en quelques mots, l’âge pour lequel il va (age, ex. « 6 mois à 3 ans »), le poids qu’il supporte (weight, ex. « jusqu’à 15 kg ») et ses mesures (measures : dimensions ou contenance, ex. « 120 × 60 cm »), SEULEMENT si l’information est donnée ; sinon laisse le texte vide (jamais le marqueur ici).',
    '- never : 2 à 5 choses qu’on ne doit jamais dire ou promettre pour ce produit (ce qui n’est pas sûr).',
    '',
    darija ? `Pour écrire la darija :\n${darija}\n` : '',
    'Réponds UNIQUEMENT avec un objet JSON, sans texte autour :',
    '{"brief": "", "strengths": [""], "faq": [{"q": "", "a": ""}], "doubts": [{"q": "", "a": ""}], "upsell": "", "never": [""], "sizes": [{"size": "", "age": "", "weight": ""}], "fit": {"age": "", "weight": "", "measures": ""}}',
  ]
    .filter((x, k, a) => x !== '' || a[k - 1] !== '')
    .join('\n');
}

/** Claude's JSON as a guide, cut to the guide's sizes (a long draft is shortened, never refused). */
export function readDraft(text: string): ProductGuide | null {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
  const cut = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const list = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.slice(0, max).map((x) => cut(x, n)) : []);
  const pairs = (v: unknown, max: number, q: number) => (Array.isArray(v) ? v.slice(0, max).map((p: any) => ({ q: cut(p?.q, q), a: cut(p?.a, L.answer) })) : []);
  // a line of the small size guide the AI could not know stays empty (never the « to fill » marker there)
  const fitLine = (k: keyof GuideFit) => ((v) => (toFill(v) ? '' : v))(cut(raw?.fit?.[k], L.fitText));
  const g = cleanGuide({
    brief: cut(raw?.brief, L.brief),
    strengths: list(raw?.strengths, L.strengths, L.strength),
    faq: pairs(raw?.faq, L.faq, L.question),
    doubts: pairs(raw?.doubts, L.doubts, L.doubt),
    upsell: cut(raw?.upsell, L.upsell),
    never: list(raw?.never, L.never, L.neverLine),
    sizes: Array.isArray(raw?.sizes) ? raw.sizes.slice(0, L.sizes).map((x: any) => ({ size: cut(x?.size, L.sizeText), age: cut(x?.age, L.sizeText), weight: cut(x?.weight, L.sizeText) })) : [],
    fit: { age: fitLine('age'), weight: fitLine('weight'), measures: fitLine('measures') },
  });
  return g.brief || g.strengths.length || g.faq.length ? g : null;
}

// the small size guide from the shop's own words only: an age range, the weight it holds, its measures
const UNIT_AGE = '(?:mois|ans?|months?|years?)';
const NUM = '\\d+(?:[.,]\\d+)?';
const AGE_RANGE = new RegExp(`(?:(?:dès|des|de|from)\\s+)?(?:la\\s+)?(?:naissance|${NUM}\\s*${UNIT_AGE}?)\\s*(?:à|a|-|–|au|jusqu['’]?(?:à|a)|to)\\s*${NUM}\\s*${UNIT_AGE}\\b`, 'i');
const AGE_FROM = new RegExp(`(?:dès|à partir de|a partir de|from)\\s+(?:la\\s+)?(?:naissance|${NUM}\\s*${UNIT_AGE}\\b)`, 'i');
const AGE_UPTO = new RegExp(`jusqu['’]?(?:à|a)\\s+${NUM}\\s*${UNIT_AGE}\\b`, 'i');
const WEIGHT_MAX = new RegExp(`(?:jusqu['’]?(?:à|a)|max(?:imum)?\\.?\\s*:?|supporte|charge\\s+max(?:imale)?\\s*:?)\\s*${NUM}\\s*kg\\b|${NUM}\\s*kg\\s*max(?:imum)?\\b|${NUM}\\s*(?:à|-|–)\\s*${NUM}\\s*kg\\b`, 'i');
const MEASURES = new RegExp(`${NUM}\\s*(?:cm|mm|m)?\\s*[x×*]\\s*${NUM}(?:\\s*(?:cm|mm|m)?\\s*[x×*]\\s*${NUM})?\\s*(?:cm|mm|m)\\b|\\b${NUM}\\s*(?:ml|cl|litres?)\\b`, 'i');
export function fitFrom(...texts: (string | null | undefined)[]): GuideFit {
  const all = texts.filter(Boolean).join('\n');
  const hit = (re: RegExp) => (all.match(re)?.[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, L.fitText);
  return {
    // « de 6 mois à 3 ans » → « 6 mois à 3 ans »; « de la naissance à 3 ans » stays
    age: (hit(AGE_RANGE) || hit(AGE_FROM) || hit(AGE_UPTO)).replace(/^de\s+(?=\d)/i, ''),
    weight: hit(WEIGHT_MAX),
    measures: hit(MEASURES),
  };
}

/** Without the AI: a plain first guide from the same facts (French), the unknown answers left to fill. */
export function rulesDraft(f: Pick<Facts, 'name' | 'brand' | 'description' | 'variants' | 'packs' | 'linked' | 'services' | 'page'> & { options?: DraftIn['options']; linkedIds?: number[] }): ProductGuide {
  // the description's (or the page's) bullet lines are the strengths; its first plain sentence is the brief
  const MARK = /^\s*(?:[-•*✅✔]|\d+[.)])\uFE0F?\s*/u;
  const lines = [f.description ?? '', f.page?.description ?? ''].join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines
    .filter((l) => MARK.test(l))
    .map((l) => l.replace(MARK, '').trim())
    .filter((l, k, a) => l.length >= 4 && l.length <= L.strength && a.indexOf(l) === k);
  const first = (f.description ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !MARK.test(l) && !l.startsWith('#'))[0]?.split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
  const sizes = sizeValues(f.options);
  return cleanGuide({
    brief: (first ? `${f.name}${f.brand ? ` (${f.brand})` : ''} : ${first}` : `${f.name}${f.brand ? ` (${f.brand})` : ''}.`).slice(0, L.brief),
    strengths: bullets.length ? bullets.slice(0, 5) : [TO_FILL],
    faq: [
      { q: 'Je paie comment ?', a: 'À la livraison, en espèces, quand vous recevez le colis.' },
      ...(f.variants.length ? [{ q: 'Quelles couleurs ou tailles ?', a: `Disponible en : ${f.variants.slice(0, 12).join(', ')}.` }] : []),
      ...(sizes.length ? [{ q: 'Quelle taille choisir ?', a: 'Dites-moi l’âge et le poids de l’enfant : je vous donne la bonne taille.' }] : []),
      { q: 'Combien coûte la livraison ?', a: 'Selon la wilaya, à domicile ou au bureau (stop desk) : je vous donne le prix exact.' },
      { q: 'Il y a une garantie ?', a: TO_FILL },
      { q: 'Je peux l’échanger ?', a: TO_FILL },
    ],
    doubts: [
      { q: '« Ghali »', a: f.packs.length ? `Le pack est plus avantageux : ${f.packs.map((p) => `${p.qty} pour ${da(p.price)}`).join(', ')}. Et vous payez seulement à la livraison.` : 'Vous payez seulement à la livraison : pas d’avance, pas de risque.' },
      { q: '« Nkhamem »', a: 'Pas de souci. Je peux vous le réserver maintenant, et vous ne payez qu’à la livraison.' },
      { q: '« Ma nthiqch fi l’internet »', a: 'Vous ne payez rien avant : vous payez au livreur quand le colis arrive.' },
    ],
    // the products that go with it are picked (Vente en plus); the words only say the pack and the services
    upsell: [
      f.packs.length ? `Proposez le pack : ${f.packs.map((p) => `${p.qty} pour ${da(p.price)}`).join(', ')}.` : '',
      f.services.length ? `Service en plus : ${f.services.map((s) => `${s.name} (${da(s.price)})`).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, L.upsell),
    upsellIds: (f.linkedIds ?? []).slice(0, L.upsellIds),
    never: ['Un délai de livraison précis : il dépend de la wilaya.', 'Une garantie, un échange ou un cadeau qui ne sont pas écrits dans ce guide.'],
    // a size that says its age (« 3-6 mois ») gets it; the weights are the team's
    sizes: sizes.filter((x) => AGE_IN_NAME.test(x)).map((x) => ({ size: x, age: x, weight: '' })),
    // one size only: the age, the weight and the measures its own words give
    fit: sizes.length ? EMPTY_FIT : fitFrom(f.name, f.description, f.page?.description),
  });
}
const AGE_IN_NAME = /\d\s*(?:mois|ans?|months?|years?|m\b|y\b)|naissance|newborn|شهر|أشهر|سنة|سنوات/i;

export interface Draft {
  guide: ProductGuide;
  /** ai: Claude wrote it; rules: the plain draft (no AI now) */
  by: 'ai' | 'rules';
}

/** « Écrire avec l'IA »: a first guide for the form (not saved). */
export async function draftGuide(ctx: Ctx, i: DraftIn): Promise<Draft> {
  if (i.productId) {
    const p = (await ctx.db.query('SELECT id FROM products WHERE id = $1', [i.productId]))[0];
    if (!p) throw notFound('Produit introuvable');
  }
  const allowed = await writerOf(ctx, i.productId);
  if (allowed && !i.productId) throw forbidden('Ce produit ne vous est pas confié');
  const f = await factsOf(ctx, { ...i, linkedIds: i.linkedIds.filter((x) => x !== i.productId && (!allowed || allowed.includes(x))) });
  const g = await draftOf(ctx, i, f);
  // Vente en plus: the products that go with it (Produits liés); the sizes: only the product's own, and the small size
  // guide only for a product with one size
  const sizes = new Set(sizeValues(i.options).map((x) => x.toLowerCase()));
  return {
    by: g.by,
    guide: {
      ...g.guide,
      upsellIds: g.guide.upsellIds.length ? g.guide.upsellIds : f.linkedIds.slice(0, L.upsellIds),
      sizes: g.guide.sizes.filter((x) => sizes.has(x.size.toLowerCase())),
      fit: sizes.size ? EMPTY_FIT : g.guide.fit,
      // the language it was written in (the plain draft is French)
      lang: g.by === 'ai' ? i.lang : 'fr',
    },
  };
}

async function draftOf(ctx: Ctx, i: DraftIn, f: Facts): Promise<Draft> {
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  if (!inPage && !(await aiKeyed(ctx))) return { guide: rulesDraft(f), by: 'rules' };
  const system = draftSystem(i.lang, i.lang === 'dz' ? await darijaGuide(ctx.t?.platform ?? null) : '');
  const messages = [{ role: 'user' as const, content: `Écris le guide de vente de ce produit.\n\n${factsText(f)}` }];
  const pilot = !inPage && (await pilotOn(ctx));
  const res: any = inPage
    ? await inPage({ model: GUIDE_MODEL, system, messages, tools: [], max_tokens: 2500, runTool: async () => ({ error: 'Pas d’outil ici' }) })
    : await ctx.server!.dellal!('complete', { model: GUIDE_MODEL, system, messages, tools: [], max_tokens: 2500, feature: 'dellal', pilot }, ctx);
  const text = (res?.content ?? []).map((b: any) => (b?.type === 'text' ? String(b.text) : '')).join('');
  const guide = readDraft(text);
  return guide ? { guide, by: 'ai' } : { guide: rulesDraft(f), by: 'rules' };
}

// ---------------------------------------------------------------- the other reading languages
const FROM: Record<GuideLang, string> = { fr: 'du français', ar: 'de l’arabe', dz: 'de la darija algérienne', en: 'de l’anglais' };
const TO: Record<ReadLang, string> = { fr: 'le français', ar: 'l’arabe', en: 'l’anglais' };

/** Claude's instructions to translate a guide's lines (the same lines back, in the same order, nothing added). */
export function translateSystem(from: GuideLang, to: ReadLang): string {
  return [
    `Tu traduis le « guide de vente » d’un produit ${FROM[from]} vers ${TO[to]}, pour une boutique algérienne en ligne (paiement à la livraison). Les conseillers le lisent pendant leurs appels.`,
    '',
    'Règles :',
    '- Traduis chaque ligne, dans le même ordre, sans rien ajouter ni enlever : pas de fait, de promesse ni d’explication en plus.',
    `- Garde les mêmes nombres, les mêmes prix (DA) et les mêmes unités (aucune conversion), les noms de produits et de marques tels quels, et le marqueur « ${TO_FILL} ».`,
    '- Les mots entre « » sont ce que dit le client (souvent en darija) : garde-les tels quels, et ajoute leur sens entre parenthèses.',
    `- Langue : ${LANG_TEXT[to]}.`,
    '',
    'Tu reçois {"lines": [...]}. Réponds UNIQUEMENT avec un objet JSON, sans texte autour : {"lines": ["…"]}, autant de lignes que reçues, dans le même ordre.',
  ].join('\n');
}

/** Claude's translated lines, by position (a missing or empty one: null). */
export function readLines(text: string, n: number): (string | null)[] {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let raw: any = null;
  try {
    raw = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
  } catch {
    raw = null;
  }
  const lines: unknown[] = Array.isArray(raw?.lines) ? raw.lines : [];
  return Array.from({ length: n }, (_, k) => {
    const v = typeof lines[k] === 'string' ? (lines[k] as string).trim() : '';
    return v ? v.slice(0, 1500) : null;
  });
}

/** Lines in batches small enough for one answer each. */
function batches(lines: string[], size = 2500): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (const x of lines) {
    if (cur.length && n + x.length > size) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(x);
    n += x.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Pilot AI translates these lines (null: no AI here). A batch that fails stays untranslated. */
async function translateLines(ctx: Ctx, lines: string[], from: GuideLang, to: ReadLang): Promise<{ out: (string | null)[]; error: string | null } | null> {
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  if (!inPage && !(await aiKeyed(ctx))) return null;
  const system = translateSystem(from, to);
  const pilot = !inPage && (await pilotOn(ctx));
  let error: string | null = null;
  const parts = await Promise.all(
    batches(lines).map(async (part) => {
      const messages = [{ role: 'user' as const, content: JSON.stringify({ lines: part }) }];
      // Arabic takes more room than French: enough for the longest
      const max_tokens = Math.min(8000, 400 + Math.ceil(part.join('').length * 1.5));
      try {
        const res: any = inPage
          ? await inPage({ model: GUIDE_MODEL, system, messages, tools: [], max_tokens, runTool: async () => ({ error: 'Pas d’outil ici' }) })
          : await ctx.server!.dellal!('complete', { model: GUIDE_MODEL, system, messages, tools: [], max_tokens, feature: 'dellal', pilot }, ctx);
        const text = (res?.content ?? []).map((b: any) => (b?.type === 'text' ? String(b.text) : '')).join('');
        return readLines(text, part.length);
      } catch (e) {
        error = (e as Error).message || 'Traduction impossible';
        return part.map(() => null);
      }
    }),
  );
  return { out: parts.flat(), error };
}

export interface TrResult {
  /** ai: Pilot AI translated what was missing; done: nothing was missing; none: no AI here (nothing changed) */
  by: 'ai' | 'done' | 'none';
  /** the lines still without a translation, per language */
  missing: Partial<Record<ReadLang, number>>;
  error: string | null;
}
const counts = (m: Partial<Record<ReadLang, string[]>>) => Object.fromEntries(Object.entries(m).map(([l, v]) => [l, v!.length])) as Partial<Record<ReadLang, number>>;

/** After a save: Pilot AI translates the guide's lines still without a translation, in each other reading language. */
export async function translateGuide(ctx: Ctx, productId: number): Promise<TrResult> {
  const saved = await readGuide(ctx.db, productId);
  if (!saved) return { by: 'done', missing: {}, error: null };
  const todo = Object.entries(trMissing(saved.guide, saved.tr)) as [ReadLang, string[]][];
  if (!todo.length) return { by: 'done', missing: {}, error: null };
  return withActionLock(ctx.db, `guide-tr:${productId}`, ctx.session.profile.id, 'La traduction de ce guide est déjà en cours', async () => {
    let error: string | null = null;
    const add: GuideTr = {};
    let none = false;
    await Promise.all(
      todo.map(async ([l, lines]) => {
        const r = await translateLines(ctx, lines, saved.guide.lang, l);
        if (!r) return void (none = true);
        error ??= r.error;
        add[l] = Object.fromEntries(lines.map((x, k) => [x, r.out[k]] as const).filter((p): p is readonly [string, string] => !!p[1]));
      }),
    );
    if (none) return { by: 'none', missing: counts(trMissing(saved.guide, saved.tr)), error: null };
    await addTranslations(ctx.db, productId, add);
    const after = await readGuide(ctx.db, productId);
    return { by: 'ai', missing: after ? counts(trMissing(after.guide, after.tr)) : {}, error };
  });
}

export const guideProcs = {
  /**
   * One product's sales guide (read only), within the products this person's work gives them. lang: the reader's
   * language; tr: the guide's lines in it (null: the guide is written in it), trMissing: the lines not translated yet.
   */
  'catalog.guide': proc(['confirmation', 'suivi', 'depot'], z.object({ id, lang: z.enum(READ_LANGS).optional() }), async (ctx, { id, lang }) => {
    await requireAssignedProducts(ctx, [id]);
    const p = (await ctx.db.query('SELECT id, name, photo FROM products WHERE id = $1', [id]))[0];
    if (!p) throw notFound('Produit introuvable');
    const g = await readGuide(ctx.db, id);
    const other = !!g && !!lang && lang !== g.guide.lang;
    return {
      id: num(p.id),
      name: String(p.name),
      photo: (p.photo as string | null) ?? null,
      guide: g?.guide ?? null,
      upsell: g?.upsell ?? [],
      tr: other ? (g!.tr[lang!] ?? {}) : null,
      trMissing: other ? (trMissing(g!.guide, g!.tr)[lang!]?.length ?? 0) : 0,
      updatedAt: g?.updatedAt ?? null,
      updatedBy: g?.updatedBy ?? null,
    };
  }),

  /** « Écrire avec l'IA » (the product form, the Guide de vente tab): a first guide to correct (nothing saved). */
  'catalog.guideDraft': proc([...WRITERS], DraftInput, (ctx, i) => draftGuide(ctx, i)),

  /**
   * What the shop knows of a product, for its guide's writer (« Écrire avec l'IA », the fixed questions' answers, the
   * sizes of the size guide): no price paid, no stock.
   */
  'catalog.guideFacts': proc([...WRITERS], z.object({ id }), async (ctx, { id }) => {
    const allowed = await writerOf(ctx, id);
    const p = (await ctx.db.query('SELECT id, name, brand, description, price, packs, linked, services, options FROM products WHERE id = $1', [id]))[0];
    if (!p) throw notFound('Produit introuvable');
    const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? []);
    const linkedIds = ((p.linked ?? []) as unknown[]).map(num).filter((x) => x > 0 && x !== id && (!allowed || allowed.includes(x)));
    const names = linkedIds.length ? new Map((await ctx.db.query('SELECT id, name FROM products WHERE id = ANY($1)', [linkedIds])).map((r) => [num(r.id), String(r.name)] as const)) : new Map<number, string>();
    const variants = (await ctx.db.query(`SELECT title FROM product_variants WHERE product_id = $1 AND active AND title <> '' ORDER BY id`, [id])).map((r) => String(r.title));
    return {
      productId: id,
      name: String(p.name),
      brand: (p.brand as string | null) ?? undefined,
      description: (p.description as string | null) ?? undefined,
      price: num(p.price) || undefined,
      variants: variants.slice(0, 200),
      packs: (j(p.packs) as any[]).map((x) => ({ qty: num(x.qty), price: num(x.price) })).filter((x) => x.qty > 1 && x.price > 0),
      linked: linkedIds.map((x) => names.get(x)).filter((x): x is string => !!x),
      linkedIds,
      services: (j(p.services) as any[]).map((x) => ({ name: String(x.name), price: num(x.price) })),
      options: (j(p.options) as any[]).map((o) => ({ name: String(o.name), values: (o.values ?? []).map(String) })),
      /** the guide's translations, for the editor's language tabs */
      guideTr: (await readGuide(ctx.db, id))?.tr ?? {},
    };
  }),

  /** Produits & stock › Guide de vente: the products (not the services) and where each one's guide stands. */
  'catalog.guides': proc(['confirmation', 'suivi', 'depot'], z.object({}), async (ctx) => {
    const allowed = await assignedProductIds(ctx);
    const rows = await ctx.db.query(
      `SELECT p.id, p.name, p.sku, p.photo, p.active, g.guide, g.updated_at, u.name AS by_name
       FROM products p LEFT JOIN product_guides g ON g.product_id = p.id LEFT JOIN profiles u ON u.id = g.updated_by
       WHERE p.archived_at IS NULL AND NOT p.is_service${allowed ? ' AND p.id = ANY($1)' : ''}
       ORDER BY p.active DESC, lower(p.name), p.id LIMIT 3000`,
      allowed ? [allowed] : [],
    );
    const out = rows.map((r) => {
      const g = r.guide ? cleanGuide(typeof r.guide === 'string' ? JSON.parse(r.guide) : r.guide) : null;
      const has = !!g && !guideEmpty(g);
      return {
        id: num(r.id),
        name: String(r.name),
        sku: String(r.sku),
        photo: (r.photo as string | null) ?? null,
        active: !!r.active,
        hasGuide: has,
        /** answers still to write (and points still to fill) */
        toFill: has ? guideToFill(g!) + g!.strengths.filter((x) => toFill(x)).length : 0,
        brief: has ? g!.brief.slice(0, 160) : '',
        parts: has ? { strengths: g!.strengths.length, faq: g!.faq.length, doubts: g!.doubts.length, never: g!.never.length, upsell: g!.upsell || g!.upsellIds.length ? 1 : 0, sizes: g!.sizes.length || (fitFilled(g!.fit) ? 1 : 0) } : null,
        updatedAt: has && r.updated_at ? iso(r.updated_at) : null,
        updatedBy: has ? ((r.by_name as string | null) ?? null) : null,
        seller: null as { id: number; name: string } | null,
      };
    });
    return { rows: out, total: out.length, page: 1, pageSize: out.length };
  }),

  /**
   * Produits & stock › Guide de vente › Modifier: only the guide (the rest of the product is the product form's). The
   * depot side on every product, an agency's people on the agency's products (and Vente en plus among them).
   */
  'catalog.saveGuide': proc([...WRITERS], z.object({ id, guide: GuideInput, tr: TrInput.optional() }), async (ctx, i) => {
    const allowed = await writerOf(ctx, i.id);
    const p = (await ctx.db.query('SELECT id FROM products WHERE id = $1', [i.id]))[0];
    if (!p) throw notFound('Produit introuvable');
    const g = checkGuide(i.guide);
    await ctx.db.tx((tx) => saveGuide(tx, i.id, g, ctx.session.profile.id, allowed, i.tr));
    const saved = await readGuide(ctx.db, i.id);
    return {
      id: i.id,
      guide: saved?.guide ?? null,
      upsell: saved?.upsell ?? [],
      tr: saved?.tr ?? {},
      /** lines to translate now (the client asks catalog.translateGuide) */
      trMissing: saved ? counts(trMissing(saved.guide, saved.tr)) : {},
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
    };
  }),

  /** After a save (the tab, the product form): Pilot AI translates the lines still without a translation. */
  'catalog.translateGuide': proc([...WRITERS], z.object({ id }), async (ctx, { id }) => {
    await writerOf(ctx, id);
    return translateGuide(ctx, id);
  }),
};
