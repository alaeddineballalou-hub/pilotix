// The sales guide of a product, read and drafted (modules/guide.ts holds what it is):
// - catalog.guide: one product's guide for the people who sell it (agents during a call, the depot, the owner), within
//   the products their work gives them (productscope.ts);
// - catalog.guideDraft: « Écrire avec l'IA » in the product form. Claude writes a first guide from what the shop knows
//   (the product, its variants, packs, linked products and services, its landing page, Dellal's shop notes) and never
//   invents a fact: an answer it cannot know stays « [À compléter] » for the team. Pilotix's key pays (Pilot AI), counted
//   with the shop's Dellal answers. Without the AI (Pilot AI off or today's limit reached, the preview): a simple draft
//   made by rules from the same facts. The team reads and corrects it; nothing is saved before « Enregistrer ».
import { z } from 'zod';
import { num } from '../db';
import { Ctx, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { darijaGuide } from './darijabook';
import { aiKeyed, dellalSettings, pilotOn } from './dellal';
import { cleanGuide, GUIDE_LIMITS as L, ProductGuide, readGuide, TO_FILL } from './guide';
import { requireAssignedProducts } from './productscope';

const id = z.number().int().positive();
const DEPOT = ['depot'] as const;
export const GUIDE_MODEL = 'claude-sonnet-5-5';
export const GUIDE_LANGS = ['fr', 'ar', 'dz', 'en'] as const;
export type GuideLang = (typeof GUIDE_LANGS)[number];

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
    f.variants.length ? `Variantes : ${f.variants.join(', ')}` : '',
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
    '- upsell : quoi proposer en plus (un pack, un produit qui va avec, un service) et la phrase à dire ; vide s’il n’y a rien.',
    '- never : 2 à 5 choses qu’on ne doit jamais dire ou promettre pour ce produit (ce qui n’est pas sûr).',
    '',
    darija ? `Pour écrire la darija :\n${darija}\n` : '',
    'Réponds UNIQUEMENT avec un objet JSON, sans texte autour :',
    '{"brief": "", "strengths": [""], "faq": [{"q": "", "a": ""}], "doubts": [{"q": "", "a": ""}], "upsell": "", "never": [""]}',
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
  const g = cleanGuide({
    brief: cut(raw?.brief, L.brief),
    strengths: list(raw?.strengths, L.strengths, L.strength),
    faq: pairs(raw?.faq, L.faq, L.question),
    doubts: pairs(raw?.doubts, L.doubts, L.doubt),
    upsell: cut(raw?.upsell, L.upsell),
    never: list(raw?.never, L.never, L.neverLine),
  });
  return g.brief || g.strengths.length || g.faq.length ? g : null;
}

/** Without the AI: a plain first guide from the same facts (French), the unknown answers left to fill. */
export function rulesDraft(f: Pick<Facts, 'name' | 'brand' | 'description' | 'variants' | 'packs' | 'linked' | 'services' | 'page'>): ProductGuide {
  // the description's (or the page's) bullet lines are the strengths; its first plain sentence is the brief
  const MARK = /^\s*(?:[-•*✅✔]|\d+[.)])\uFE0F?\s*/u;
  const lines = [f.description ?? '', f.page?.description ?? ''].join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines
    .filter((l) => MARK.test(l))
    .map((l) => l.replace(MARK, '').trim())
    .filter((l, k, a) => l.length >= 4 && l.length <= L.strength && a.indexOf(l) === k);
  const first = (f.description ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !MARK.test(l) && !l.startsWith('#'))[0]?.split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
  return cleanGuide({
    brief: (first ? `${f.name}${f.brand ? ` (${f.brand})` : ''} : ${first}` : `${f.name}${f.brand ? ` (${f.brand})` : ''}.`).slice(0, L.brief),
    strengths: bullets.length ? bullets.slice(0, 5) : [TO_FILL],
    faq: [
      { q: 'Je paie comment ?', a: 'À la livraison, en espèces, quand vous recevez le colis.' },
      ...(f.variants.length ? [{ q: 'Quelles couleurs ou tailles ?', a: `Disponible en : ${f.variants.slice(0, 12).join(', ')}.` }] : []),
      { q: 'Combien coûte la livraison ?', a: 'Selon la wilaya, à domicile ou au bureau (stop desk) : je vous donne le prix exact.' },
      { q: 'Il y a une garantie ?', a: TO_FILL },
      { q: 'Je peux l’échanger ?', a: TO_FILL },
    ],
    doubts: [
      { q: '« Ghali »', a: f.packs.length ? `Le pack est plus avantageux : ${f.packs.map((p) => `${p.qty} pour ${da(p.price)}`).join(', ')}. Et vous payez seulement à la livraison.` : 'Vous payez seulement à la livraison : pas d’avance, pas de risque.' },
      { q: '« Nkhamem »', a: 'Pas de souci. Je peux vous le réserver maintenant, et vous ne payez qu’à la livraison.' },
      { q: '« Ma nthiqch fi l’internet »', a: 'Vous ne payez rien avant : vous payez au livreur quand le colis arrive.' },
    ],
    upsell: [
      f.packs.length ? `Proposez le pack : ${f.packs.map((p) => `${p.qty} pour ${da(p.price)}`).join(', ')}.` : '',
      f.linked.length ? `Proposez aussi : ${f.linked.slice(0, 4).join(', ')}.` : '',
      f.services.length ? `Service en plus : ${f.services.map((s) => `${s.name} (${da(s.price)})`).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, L.upsell),
    never: ['Un délai de livraison précis : il dépend de la wilaya.', 'Une garantie, un échange ou un cadeau qui ne sont pas écrits dans ce guide.'],
  });
}

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
  const f = await factsOf(ctx, i);
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

export const guideProcs = {
  /** One product's sales guide (read only), within the products this person's work gives them. */
  'catalog.guide': proc(['confirmation', 'suivi', 'depot'], z.object({ id }), async (ctx, { id }) => {
    await requireAssignedProducts(ctx, [id]);
    const p = (await ctx.db.query('SELECT id, name, photo FROM products WHERE id = $1', [id]))[0];
    if (!p) throw notFound('Produit introuvable');
    const g = await readGuide(ctx.db, id);
    return { id: num(p.id), name: String(p.name), photo: (p.photo as string | null) ?? null, guide: g?.guide ?? null, updatedAt: g?.updatedAt ?? null, updatedBy: g?.updatedBy ?? null };
  }),

  /** « Écrire avec l'IA » in the product form: a first guide to correct (nothing saved). */
  'catalog.guideDraft': proc([...DEPOT], DraftInput, (ctx, i) => draftGuide(ctx, i)),
};
