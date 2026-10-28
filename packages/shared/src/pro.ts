// Pro marketers: a marketer's space that pays Pilotix (by the month, staff turn it on in the control room) shows on
// Pilotix's list of marketers: every store's « Trouver un marketer Pro », and the public page (#/pro). Its card: the
// marketer's own words (niches, ad platforms, city, a few lines) and the numbers Pilotix counts in every store its
// people worked for (ad sets launched, réussies, ratées, en cours, stores, products). The success rate is
// réussies ÷ (réussies + ratées): ad sets still running are not judged yet.

/** The kinds of products a marketer sells best (chosen on its Pro profile, filtered on the search). */
export const PRO_NICHES = [
  'cosmetics',
  'beauty',
  'fashionWomen',
  'fashionMen',
  'kids',
  'home',
  'kitchen',
  'electronics',
  'phones',
  'watches',
  'sport',
  'health',
  'auto',
  'pets',
  'food',
  'other',
] as const;
export type ProNiche = (typeof PRO_NICHES)[number];

/** Where the marketer runs ads. */
export const PRO_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'snapchat', 'google'] as const;
export type ProPlatform = (typeof PRO_PLATFORMS)[number];

/** What the marketer writes about itself. */
export interface ProProfile {
  niches: ProNiche[];
  platforms: ProPlatform[];
  /** its city or wilaya (free text) */
  city: string;
  /** a few lines: what it does best */
  bio: string;
  /** shown on the list (it can hide itself while staying Pro) */
  visible: boolean;
}
export const NO_PRO_PROFILE: ProProfile = { niches: [], platforms: [], city: '', bio: '', visible: true };

/** The numbers Pilotix counts, every store together (the whole life of each ad set). */
export interface ProStats {
  /** ad sets launched */
  adsets: number;
  /** judged « réussi » */
  ok: number;
  /** judged « raté » */
  ko: number;
  /** still running (not judged yet) */
  run: number;
  /** stores its people made ad sets for */
  stores: number;
  /** different products of those ad sets */
  products: number;
}
export const NO_PRO_STATS: ProStats = { adsets: 0, ok: 0, ko: 0, run: 0, stores: 0, products: 0 };

/** Réussies ÷ (réussies + ratées), in %; null when nothing was judged yet. */
export const proRate = (s: Pick<ProStats, 'ok' | 'ko'>): number | null => (s.ok + s.ko > 0 ? Math.round((s.ok * 100) / (s.ok + s.ko)) : null);

/** One marketer's card on the list. */
export interface ProCard {
  id: number;
  code: string;
  name: string;
  profile: ProProfile;
  stats: ProStats;
  rate: number | null;
  /** months since the space was opened on Pilotix */
  months: number;
}

/** Keeps only known niches / platforms, in their list order, and cuts the texts. */
export function cleanProProfile(v: unknown): ProProfile {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pick = <T extends string>(all: readonly T[], x: unknown, max: number): T[] => {
    const a = Array.isArray(x) ? x : [];
    return all.filter((k) => a.includes(k)).slice(0, max);
  };
  return {
    niches: pick(PRO_NICHES, o.niches, 4),
    platforms: pick(PRO_PLATFORMS, o.platforms, 5),
    city: String(o.city ?? '').trim().slice(0, 60),
    bio: String(o.bio ?? '').trim().slice(0, 300),
    visible: o.visible !== false,
  };
}

/** Keeps a stats object whole (counts ≥ 0). */
export function cleanProStats(v: unknown): ProStats {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const n = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0);
  return { adsets: n(o.adsets), ok: n(o.ok), ko: n(o.ko), run: n(o.run), stores: n(o.stores), products: n(o.products) };
}

/** Whole months between two dates (at least 0). */
export const monthsBetween = (from: string | number | Date, to: number): number => {
  const a = new Date(from);
  const b = new Date(to);
  return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0));
};
