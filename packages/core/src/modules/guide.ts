// The sales guide of a product (Produits & stock › a product › Guide de vente). The team writes it in the product form
// or in the tab Produits & stock › Guide de vente (« Écrire avec l'IA » makes a first draft: modules/guidedraft.ts), and
// so do the confirmation agencies for the products they work on; the agents read it during a call (a « Guide » button on
// each product of the order, and in Produits & stock); Dellal reads it in chats (its product_guide tool) and CM AI under
// the comments of the product's posts, so both answer with the shop's real facts.
// Its parts: En bref, Guide des tailles (age and weight for each size, when the product has a size option; a small one,
// the age, the weight and the measures it fits, when it has none: customers ask it), Points forts, Questions & réponses
// (picked from fixed questions or written), Hésitations (what the customer says → what to answer), Vente en plus
// (products picked, and how to say it), À ne jamais promettre. A product without a guide has no row
// (migrations/072_product_guides.ts). Everyone reads it in the app's language (French, Arabic or English): Pilot AI
// translates each line after a save, the team corrects the translations in the editor's tabs, and the original words
// stay one click away (migrations/073_guide_translations.ts). The AI agents read the original.
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad } from '../rpc';

/** The languages a guide is written in (Darija: Algerian, in Latin letters), and the ones the app is read in. */
export const GUIDE_LANGS = ['fr', 'ar', 'dz', 'en'] as const;
export type GuideLang = (typeof GUIDE_LANGS)[number];
export const READ_LANGS = ['fr', 'ar', 'en'] as const;
export type ReadLang = (typeof READ_LANGS)[number];

export interface GuidePair {
  q: string;
  a: string;
}
/** one size of the product (a value of its « Taille » option) with the age and the weight it fits */
export interface GuideSize {
  size: string;
  age: string;
  weight: string;
}
/** the small size guide of a product without a size option: the age and the weight it fits, and how big it is */
export interface GuideFit {
  age: string;
  weight: string;
  measures: string;
}
export interface ProductGuide {
  /** the product in one or two sentences: what it is, for whom */
  brief: string;
  /** what the product changes for the customer, one point per line */
  strengths: string[];
  /** questions customers really ask, with the shop's answer */
  faq: GuidePair[];
  /** what a customer says not to order (« ghali », « nkhamem »…) and what to answer */
  doubts: GuidePair[];
  /** how to offer the products picked below (optional) */
  upsell: string;
  /** the products to offer on top (picked in the shop's catalog) */
  upsellIds: number[];
  /** what nobody may say or promise about this product */
  never: string[];
  /** the size guide: for each size, the age and the weight it fits */
  sizes: GuideSize[];
  /** the small size guide, when the product has no size option (empty texts: not written) */
  fit: GuideFit;
  /** the language it is written in (the team's choice, unless its letters say otherwise) */
  lang: GuideLang;
}

export const GUIDE_LIMITS = {
  brief: 400,
  strengths: 12,
  strength: 200,
  faq: 20,
  question: 200,
  answer: 600,
  doubts: 12,
  doubt: 160,
  upsell: 800,
  upsellIds: 10,
  never: 10,
  neverLine: 200,
  sizes: 40,
  sizeText: 60,
  /** each line of the small size guide (« 60 × 80 × 100 cm, 45 × 60 cm plié ») */
  fitText: 120,
  /** the whole guide (what Dellal reads in one go) */
  total: 15_000,
} as const;

/** An answer the AI could not know (its draft): the team writes it. Agents see it marked; the AI agents never use it. */
export const TO_FILL = '[À compléter]';
const TO_FILL_RE = /\[\s*(?:à|a)\s+compl[ée]ter\s*\]/i;
export const toFill = (s: string) => TO_FILL_RE.test(s) || !s.trim();

/** The option that holds the sizes (Taille, Pointure, Âge, مقاس…): its values get an age and a weight in the guide. */
export const SIZE_OPTION = /taille|size|pointure|mesure|âge|\bage\b|مقاس|القياس|العمر/i;
export const sizeValues = (options: { name: string; values: string[] }[] | null | undefined): string[] =>
  [...new Set((options ?? []).filter((o) => SIZE_OPTION.test(o.name)).flatMap((o) => o.values.map((v) => v.trim()).filter(Boolean)))].slice(0, GUIDE_LIMITS.sizes);

const L = GUIDE_LIMITS;
const pair = (q: number) => z.object({ q: z.string().trim().max(q), a: z.string().trim().max(L.answer) });
export const GuideInput = z.object({
  brief: z.string().trim().max(L.brief).default(''),
  strengths: z.array(z.string().trim().max(L.strength)).max(L.strengths).default([]),
  faq: z.array(pair(L.question)).max(L.faq).default([]),
  doubts: z.array(pair(L.doubt)).max(L.doubts).default([]),
  upsell: z.string().trim().max(L.upsell).default(''),
  upsellIds: z.array(z.number().int().positive()).max(L.upsellIds).default([]),
  never: z.array(z.string().trim().max(L.neverLine)).max(L.never).default([]),
  sizes: z
    .array(z.object({ size: z.string().trim().min(1).max(L.sizeText), age: z.string().trim().max(L.sizeText).default(''), weight: z.string().trim().max(L.sizeText).default('') }))
    .max(L.sizes)
    .default([]),
  fit: z
    .object({ age: z.string().trim().max(L.fitText).default(''), weight: z.string().trim().max(L.fitText).default(''), measures: z.string().trim().max(L.fitText).default('') })
    .default({}),
  lang: z.enum(GUIDE_LANGS).optional(),
});
export type GuideInputT = z.input<typeof GuideInput>;

export const EMPTY_FIT: GuideFit = { age: '', weight: '', measures: '' };
export const EMPTY_GUIDE: ProductGuide = { brief: '', strengths: [], faq: [], doubts: [], upsell: '', upsellIds: [], never: [], sizes: [], fit: EMPTY_FIT, lang: 'fr' };
/** Is something written in the small size guide. */
export const fitFilled = (f: GuideFit | null | undefined) => !!f && !!(f.age || f.weight || f.measures);

/** Trimmed, without empty lines, questions or sizes (an answer may still be to fill). */
export function cleanGuide(g: Partial<ProductGuide> | null | undefined): ProductGuide {
  const s = (v: unknown) => String(v ?? '').trim();
  const lines = (v: unknown) => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
  const pairs = (v: unknown) => (Array.isArray(v) ? v.map((p: any) => ({ q: s(p?.q), a: s(p?.a) })).filter((p) => p.q) : []);
  const ids = Array.isArray(g?.upsellIds) ? [...new Set(g!.upsellIds.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0))] : [];
  const sizes = Array.isArray(g?.sizes)
    ? g!.sizes
        .map((x: any) => ({ size: s(x?.size), age: s(x?.age), weight: s(x?.weight) }))
        .filter((x, k, a) => x.size && (x.age || x.weight) && a.findIndex((y) => y.size.toLowerCase() === x.size.toLowerCase()) === k)
    : [];
  const f: any = g?.fit && typeof g.fit === 'object' ? g.fit : {};
  const fit = { age: s(f.age), weight: s(f.weight), measures: s(f.measures) };
  const base = { brief: s(g?.brief), strengths: lines(g?.strengths), faq: pairs(g?.faq), doubts: pairs(g?.doubts), upsell: s(g?.upsell), upsellIds: ids, never: lines(g?.never), sizes, fit };
  return { ...base, lang: langOf(g?.lang, guideSources(base)) };
}

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F]/g;
const ANY_LETTER = /\p{L}/gu;
/** The guide's language: the one chosen, unless its letters say otherwise (mostly Arabic letters, or none at all). */
function langOf(chosen: unknown, lines: string[]): GuideLang {
  const text = lines.join(' ');
  const letters = text.match(ANY_LETTER)?.length ?? 0;
  const arabic = text.match(ARABIC_LETTER)?.length ?? 0;
  const pick = (GUIDE_LANGS as readonly string[]).includes(chosen as string) ? (chosen as GuideLang) : null;
  if (letters >= 12 && arabic / letters > 0.6) return 'ar';
  if (pick === 'ar' && letters >= 12 && arabic / letters < 0.2) return 'fr';
  return pick ?? 'fr';
}

export const guideEmpty = (g: ProductGuide) =>
  !g.brief && !g.strengths.length && !g.faq.length && !g.doubts.length && !g.upsell && !g.upsellIds.length && !g.never.length && !g.sizes.length && !fitFilled(g.fit);

/** Characters of the whole guide (its limit keeps what Dellal reads at once small). */
export const guideSize = (g: ProductGuide) =>
  g.brief.length +
  g.upsell.length +
  [...g.strengths, ...g.never].reduce((a, x) => a + x.length, 0) +
  [...g.faq, ...g.doubts].reduce((a, p) => a + p.q.length + p.a.length, 0) +
  g.sizes.reduce((a, x) => a + x.size.length + x.age.length + x.weight.length, 0) +
  g.fit.age.length +
  g.fit.weight.length +
  g.fit.measures.length;

/** How many answers are still to write. */
export const guideToFill = (g: ProductGuide) => [...g.faq, ...g.doubts].filter((p) => toFill(p.a)).length;

// ---------------------------------------------------------------- the other reading languages
/** The guide in each other reading language: each of its lines → the translation (Pilot AI's, or the team's). */
export type GuideTr = Partial<Record<ReadLang, Record<string, string>>>;
const TR_LINE = 1500;
const trLines = z.record(z.string().max(800), z.string().max(TR_LINE)).optional();
/** The team's corrections from the editor's tabs: a line → its translation (emptied: Pilot AI translates it again). */
export const TrInput = z.object({ fr: trLines, ar: trLines, en: trLines });
export type TrEdits = z.output<typeof TrInput>;

/** The guide's lines to translate, each once and in order (an answer still to write is not one). */
export function guideSources(g: Pick<ProductGuide, 'brief' | 'strengths' | 'faq' | 'doubts' | 'upsell' | 'never' | 'sizes' | 'fit'>): string[] {
  const all = [
    g.brief,
    ...g.sizes.flatMap((x) => [x.age, x.weight]),
    g.fit.age,
    g.fit.weight,
    g.fit.measures,
    ...g.strengths,
    ...g.faq.flatMap((p) => [p.q, p.a]),
    ...g.doubts.flatMap((p) => [p.q, p.a]),
    g.upsell,
    ...g.never,
  ];
  return [...new Set(all.map((x) => x.trim()).filter((x) => x && !toFill(x)))];
}

/** The reading languages a guide is translated into: all but its own. */
export const trTargets = (g: ProductGuide): ReadLang[] => READ_LANGS.filter((l) => l !== g.lang);

/** Translations kept: the guide's current lines only, in the languages it is translated into. */
export function cleanTr(raw: unknown, g: ProductGuide): GuideTr {
  const src = new Set(guideSources(g));
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const out: GuideTr = {};
  for (const l of trTargets(g)) {
    const m = r[l] && typeof r[l] === 'object' ? r[l] : {};
    const kept = Object.entries(m)
      .map(([k, v]) => [k.trim(), String(v ?? '').trim().slice(0, TR_LINE)] as const)
      .filter(([k, v]) => src.has(k) && v);
    if (kept.length) out[l] = Object.fromEntries(kept);
  }
  return out;
}

/** The lines still without a translation, per language. */
export function trMissing(g: ProductGuide, tr: GuideTr): Partial<Record<ReadLang, string[]>> {
  const src = guideSources(g);
  return Object.fromEntries(trTargets(g).map((l) => [l, src.filter((x) => !tr[l]?.[x])]).filter(([, v]) => v.length));
}

/** A product offered on top (Vente en plus), as the agents and the AI agents see it. */
export interface UpsellProduct {
  id: number;
  name: string;
  price: number;
  photo: string | null;
}

/**
 * The guide as the AI agents read it: plain text in the guide's own words, without the answers still to write (an AI
 * never says « [À compléter] » nor guesses that answer).
 */
export function guideText(g: ProductGuide, upsell: UpsellProduct[] = []): string {
  const real = (x: string) => !toFill(x);
  const faq = g.faq.filter((p) => real(p.a));
  const doubts = g.doubts.filter((p) => real(p.a));
  const strengths = g.strengths.filter(real);
  const never = g.never.filter(real);
  const da = (n: number) => `${n} DA`;
  const offer = [upsell.length ? `propose aussi ${upsell.map((p) => `#${p.id} ${p.name} (${da(p.price)})`).join(', ')}` : '', real(g.upsell) ? g.upsell : ''].filter(Boolean).join(' — ');
  // one size only: who it fits and how big it is
  const fit = g.sizes.length ? [] : [real(g.fit.age) && `- âge : ${g.fit.age}`, real(g.fit.weight) && `- poids : ${g.fit.weight}`, real(g.fit.measures) && `- mesures : ${g.fit.measures}`].filter(Boolean);
  return [
    real(g.brief) ? `EN BREF : ${g.brief}` : '',
    g.sizes.length
      ? `GUIDE DES TAILLES (demande l’âge et le poids si le client ne les donne pas, puis propose la taille qui va) :\n${g.sizes.map((x) => `- ${x.size} : ${[x.age && `âge ${x.age}`, x.weight && `poids ${x.weight}`].filter(Boolean).join(', ')}`).join('\n')}`
      : '',
    fit.length ? `GUIDE DES TAILLES (une seule taille ; réponds avec ceci quand le client demande l’âge, le poids ou les mesures, et dis-le honnêtement si le produit ne lui va pas) :\n${fit.join('\n')}` : '',
    strengths.length ? `POINTS FORTS :\n${strengths.map((x) => `- ${x}`).join('\n')}` : '',
    faq.length ? `QUESTIONS DES CLIENTS ET RÉPONSES DE LA BOUTIQUE :\n${faq.map((p) => `- ${p.q} → ${p.a}`).join('\n')}` : '',
    doubts.length ? `HÉSITATIONS (ce que le client dit → quoi répondre) :\n${doubts.map((p) => `- ${p.q} → ${p.a}`).join('\n')}` : '',
    offer ? `VENTE EN PLUS : ${offer}` : '',
    never.length ? `À NE JAMAIS PROMETTRE NI DIRE :\n${never.map((x) => `- ${x}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface SavedGuide {
  guide: ProductGuide;
  /** the products of Vente en plus still on sale, with their name and price */
  upsell: UpsellProduct[];
  /** the guide in the other reading languages */
  tr: GuideTr;
  updatedAt: string;
  updatedBy: string | null;
}

export async function readGuide(db: Db, productId: number): Promise<SavedGuide | null> {
  const r = (await db.query('SELECT g.guide, g.tr, g.updated_at, u.name AS by_name FROM product_guides g LEFT JOIN profiles u ON u.id = g.updated_by WHERE g.product_id = $1', [productId]))[0];
  if (!r) return null;
  const guide = cleanGuide(json(r.guide));
  if (guideEmpty(guide)) return null;
  const upsell = guide.upsellIds.length
    ? (await db.query('SELECT id, name, price, photo FROM products WHERE id = ANY($1) AND active AND archived_at IS NULL', [guide.upsellIds]))
        .map((p) => ({ id: num(p.id), name: String(p.name), price: num(p.price), photo: (p.photo as string | null) ?? null }))
        .sort((a, b) => guide.upsellIds.indexOf(a.id) - guide.upsellIds.indexOf(b.id))
    : [];
  return { guide, upsell, tr: cleanTr(json(r.tr), guide), updatedAt: iso(r.updated_at), updatedBy: (r.by_name as string | null) ?? null };
}
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

/** A guide from a form (already the right sizes, GuideInput), cleaned, and not too long in all. */
export function checkGuide(input: z.output<typeof GuideInput>): ProductGuide {
  const g = cleanGuide(input);
  const n = guideSize(g);
  if (n > L.total) throw bad(`Guide de vente trop long (${n} caractères, ${L.total} au plus) : raccourcissez les réponses.`);
  return g;
}

/**
 * Saves a product's guide (inside the product's save, or from the Guide de vente tab): an empty guide removes it; the
 * same guide again changes nothing (not even who wrote it last). Vente en plus keeps real products only, never the
 * product itself (`allowed`: the products the writer's work gives them, null: every product). `trEdits`: the team's
 * corrections of the translations (the lines it changed or emptied); the translations of lines no longer in the guide
 * leave with them.
 */
export async function saveGuide(db: Db, productId: number, input: ProductGuide, userId: number | null, allowed: number[] | null = null, trEdits?: TrEdits): Promise<void> {
  let g = input;
  if (g.upsellIds.length) {
    const ok = new Set((await db.query('SELECT id FROM products WHERE id = ANY($1) AND id <> $2 AND archived_at IS NULL', [g.upsellIds, productId])).map((r) => num(r.id)));
    g = { ...g, upsellIds: g.upsellIds.filter((x) => ok.has(x) && (!allowed || allowed.includes(x))) };
  }
  if (guideEmpty(g)) {
    await db.query('DELETE FROM product_guides WHERE product_id = $1', [productId]);
    return;
  }
  const cur = (await db.query('SELECT guide, tr FROM product_guides WHERE product_id = $1', [productId]))[0];
  const old: any = (cur && json(cur.tr)) || {};
  // the team's corrections over the translations there (a line emptied goes back to Pilot AI)
  const merged: Record<string, Record<string, string>> = {};
  for (const l of READ_LANGS) {
    const m: Record<string, string> = { ...(old[l] ?? {}) };
    for (const [k, v] of Object.entries(trEdits?.[l] ?? {})) {
      const val = String(v ?? '').trim();
      if (val) m[k.trim()] = val;
      else delete m[k.trim()];
    }
    merged[l] = m;
  }
  const tr = cleanTr(merged, g);
  if (cur && JSON.stringify(cleanGuide(json(cur.guide))) === JSON.stringify(g) && JSON.stringify(cleanTr(old, g)) === JSON.stringify(tr)) return;
  await db.query(
    `INSERT INTO product_guides (product_id, guide, tr, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (product_id) DO UPDATE SET guide = EXCLUDED.guide, tr = EXCLUDED.tr, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [productId, JSON.stringify(g), JSON.stringify(tr), userId],
  );
}

/** Pilot AI's translations, added where a line has none yet (the team's corrections stay); nobody's name goes on it. */
export async function addTranslations(db: Db, productId: number, add: GuideTr): Promise<void> {
  await db.tx(async (tx) => {
    const cur = (await tx.query('SELECT guide, tr FROM product_guides WHERE product_id = $1 FOR UPDATE', [productId]))[0];
    if (!cur) return;
    const g = cleanGuide(json(cur.guide));
    const old: any = json(cur.tr) || {};
    const merged = Object.fromEntries(READ_LANGS.map((l) => [l, { ...(add[l] ?? {}), ...(old[l] ?? {}) }]));
    await tx.query('UPDATE product_guides SET tr = $2 WHERE product_id = $1', [productId, JSON.stringify(cleanTr(merged, g))]);
  });
}

/** SQL: does this product (alias) have a guide. */
export const HAS_GUIDE = (alias: string) => `EXISTS (SELECT 1 FROM product_guides g WHERE g.product_id = ${alias}.id)`;

/** Ids of the products that have a guide, among these. */
export async function guideIds(db: Db, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  return new Set((await db.query('SELECT product_id FROM product_guides WHERE product_id = ANY($1)', [ids])).map((r) => num(r.product_id)));
}
