// The sales guide of a product (Produits & stock › a product › Guide de vente). The team writes it in the product form
// (« Écrire avec l'IA » makes a first draft: modules/guidedraft.ts); the confirmation agents read it during a call (a
// « Guide » button on each product of the order, and in Produits & stock); Dellal reads it in chats (its product_guide
// tool) and CM AI under the comments of the product's posts, so both answer with the shop's real facts.
// Six parts: En bref, Points forts, Questions & réponses, Hésitations (what the customer says → what to answer),
// Vente en plus, À ne jamais promettre. A product without a guide has no row (migrations/072_product_guides.ts).
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad } from '../rpc';

export interface GuidePair {
  q: string;
  a: string;
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
  /** what to offer on top (a pack, a product that goes with it) and how to say it */
  upsell: string;
  /** what nobody may say or promise about this product */
  never: string[];
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
  never: 10,
  neverLine: 200,
  /** the whole guide (what Dellal reads in one go) */
  total: 15_000,
} as const;

/** An answer the AI could not know (its draft): the team writes it. Agents see it marked; the AI agents never use it. */
export const TO_FILL = '[À compléter]';
const TO_FILL_RE = /\[\s*(?:à|a)\s+compl[ée]ter\s*\]/i;
export const toFill = (s: string) => TO_FILL_RE.test(s) || !s.trim();

const L = GUIDE_LIMITS;
const pair = (q: number) => z.object({ q: z.string().trim().max(q), a: z.string().trim().max(L.answer) });
export const GuideInput = z.object({
  brief: z.string().trim().max(L.brief).default(''),
  strengths: z.array(z.string().trim().max(L.strength)).max(L.strengths).default([]),
  faq: z.array(pair(L.question)).max(L.faq).default([]),
  doubts: z.array(pair(L.doubt)).max(L.doubts).default([]),
  upsell: z.string().trim().max(L.upsell).default(''),
  never: z.array(z.string().trim().max(L.neverLine)).max(L.never).default([]),
});
export type GuideInputT = z.input<typeof GuideInput>;

export const EMPTY_GUIDE: ProductGuide = { brief: '', strengths: [], faq: [], doubts: [], upsell: '', never: [] };

/** Trimmed, without empty lines or questions (an answer may still be to fill). */
export function cleanGuide(g: Partial<ProductGuide> | null | undefined): ProductGuide {
  const s = (v: unknown) => String(v ?? '').trim();
  const lines = (v: unknown) => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
  const pairs = (v: unknown) => (Array.isArray(v) ? v.map((p: any) => ({ q: s(p?.q), a: s(p?.a) })).filter((p) => p.q) : []);
  return { brief: s(g?.brief), strengths: lines(g?.strengths), faq: pairs(g?.faq), doubts: pairs(g?.doubts), upsell: s(g?.upsell), never: lines(g?.never) };
}

export const guideEmpty = (g: ProductGuide) => !g.brief && !g.strengths.length && !g.faq.length && !g.doubts.length && !g.upsell && !g.never.length;

/** Characters of the whole guide (its limit keeps what Dellal reads at once small). */
export const guideSize = (g: ProductGuide) =>
  g.brief.length + g.upsell.length + [...g.strengths, ...g.never].reduce((a, x) => a + x.length, 0) + [...g.faq, ...g.doubts].reduce((a, p) => a + p.q.length + p.a.length, 0);

/** How many answers are still to write. */
export const guideToFill = (g: ProductGuide) => [...g.faq, ...g.doubts].filter((p) => toFill(p.a)).length;

/**
 * The guide as the AI agents read it: plain text in the guide's own words, without the answers still to write (an AI
 * never says « [À compléter] » nor guesses that answer).
 */
export function guideText(g: ProductGuide): string {
  const real = (x: string) => !toFill(x);
  const faq = g.faq.filter((p) => real(p.a));
  const doubts = g.doubts.filter((p) => real(p.a));
  const strengths = g.strengths.filter(real);
  const never = g.never.filter(real);
  return [
    real(g.brief) ? `EN BREF : ${g.brief}` : '',
    strengths.length ? `POINTS FORTS :\n${strengths.map((x) => `- ${x}`).join('\n')}` : '',
    faq.length ? `QUESTIONS DES CLIENTS ET RÉPONSES DE LA BOUTIQUE :\n${faq.map((p) => `- ${p.q} → ${p.a}`).join('\n')}` : '',
    doubts.length ? `HÉSITATIONS (ce que le client dit → quoi répondre) :\n${doubts.map((p) => `- ${p.q} → ${p.a}`).join('\n')}` : '',
    real(g.upsell) ? `VENTE EN PLUS : ${g.upsell}` : '',
    never.length ? `À NE JAMAIS PROMETTRE NI DIRE :\n${never.map((x) => `- ${x}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface SavedGuide {
  guide: ProductGuide;
  updatedAt: string;
  updatedBy: string | null;
}

export async function readGuide(db: Db, productId: number): Promise<SavedGuide | null> {
  const r = (await db.query('SELECT g.guide, g.updated_at, u.name AS by_name FROM product_guides g LEFT JOIN profiles u ON u.id = g.updated_by WHERE g.product_id = $1', [productId]))[0];
  if (!r) return null;
  const guide = cleanGuide(typeof r.guide === 'string' ? JSON.parse(r.guide) : r.guide);
  return guideEmpty(guide) ? null : { guide, updatedAt: iso(r.updated_at), updatedBy: (r.by_name as string | null) ?? null };
}

/** A guide from a form (already the right sizes, GuideInput), cleaned, and not too long in all. */
export function checkGuide(input: z.output<typeof GuideInput>): ProductGuide {
  const g = cleanGuide(input);
  const n = guideSize(g);
  if (n > L.total) throw bad(`Guide de vente trop long (${n} caractères, ${L.total} au plus) : raccourcissez les réponses.`);
  return g;
}

/**
 * Saves a product's guide (inside the product's save): an empty guide removes it; the same guide again changes
 * nothing (not even who wrote it last).
 */
export async function saveGuide(db: Db, productId: number, g: ProductGuide, userId: number | null): Promise<void> {
  if (guideEmpty(g)) {
    await db.query('DELETE FROM product_guides WHERE product_id = $1', [productId]);
    return;
  }
  const cur = (await db.query('SELECT guide FROM product_guides WHERE product_id = $1', [productId]))[0];
  if (cur && JSON.stringify(cleanGuide(typeof cur.guide === 'string' ? JSON.parse(cur.guide) : cur.guide)) === JSON.stringify(g)) return;
  await db.query(
    `INSERT INTO product_guides (product_id, guide, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (product_id) DO UPDATE SET guide = EXCLUDED.guide, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [productId, JSON.stringify(g), userId],
  );
}

/** SQL: does this product (alias) have a guide. */
export const HAS_GUIDE = (alias: string) => `EXISTS (SELECT 1 FROM product_guides g WHERE g.product_id = ${alias}.id)`;

/** Ids of the products that have a guide, among these. */
export async function guideIds(db: Db, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  return new Set((await db.query('SELECT product_id FROM product_guides WHERE product_id = ANY($1)', [ids])).map((r) => num(r.product_id)));
}
