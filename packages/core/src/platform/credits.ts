// AI credits (Espace créateur): each shop's plan gives credits every month (control room › Crédits IA), and a shop buys
// more by packs (« J'ai payé » with the receipt, checked like a subscription payment: platform/claims.ts, months = 0).
// An AI tool (subtitles, the changing part of a post text…) costs credits; the control room turns each tool and each ad
// strategy on or off, changes its price and its words, and adds new ones, without a new version of Pilotix.
//
// The month's credits are used first (they do not carry over), then the bought ones (they stay). Everything is on the
// seller's paying shop (their first boutique), as their plan is.
import { isoOrNull, num } from '../db';
import type { Tenancy } from './tenancy';

export const CREDIT_UNITS = ['minute', 'post', 'ten', 'video', 'image'] as const;
export type CreditUnit = (typeof CREDIT_UNITS)[number];
/** the editing styles Pilotix knows how to draw (in the browser); a strategy picks one of them */
export const CREDIT_STYLES = ['ugly', 'clean'] as const;
export type CreditStyle = (typeof CREDIT_STYLES)[number];
export const STRATEGY_KINDS = ['style', 'recipe'] as const;
/** the tools the code uses by their key (a new tool added in the control room is listed, but nothing calls it yet) */
export const TOOL_WORDS = 'subtitles';
export const TOOL_TEXT = 'posttext';
export const TOOL_HOOKS = 'hookideas';
/** Studio photo: one product photo made by the AI on the shop's background (each version, and each one made again) */
export const TOOL_PHOTO = 'studiophoto';

export interface CreditTool {
  key: string;
  name: string;
  /** what the shop reads under its name */
  desc: string;
  /** the AI model (free text: the control room's choice, e.g. « gemini-flash-lite-latest », « claude-haiku-5-5 ») */
  model: string;
  /** credits per unit */
  credits: number;
  unit: CreditUnit;
  on: boolean;
  /** the AI's own instructions, added to Pilotix's */
  prompt: string;
  /** the most units a shop may use in one day (0: no limit) */
  dayLimit: number;
}

export interface CreditStrategy {
  key: string;
  name: string;
  kind: (typeof STRATEGY_KINDS)[number];
  /** how the video is drawn */
  style: CreditStyle;
  desc: string;
  /** credits per ad made with it (0: free) */
  credits: number;
  trend: boolean;
  on: boolean;
  /** the idea given to the AI when it writes the changing part of the post */
  idea: string;
  /** the product types it fits best: 1 the shop's own product (nobody else sells it), 2 like a competitor's (similar,
   *  not the same), 3 exactly a competitor's (Marketing › Stratégies recommends with it) */
  types: ProductType[];
  /** the funnel stages it fits: « top » people who don't know the shop yet (awareness), « middle » people who watched
   *  or clicked without buying, « bottom » people ready to buy */
  stages: FunnelStage[];
}

export const FUNNEL_STAGES = ['top', 'middle', 'bottom'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
/** Each default strategy's stages (a saved strategy without stages takes its default's, or all three). */
const DEFAULT_STAGES: Record<string, FunnelStage[]> = {
  ugly: ['top', 'middle', 'bottom'],
  propre: ['top', 'middle', 'bottom'],
  probleme: ['top'],
  temoignage: ['middle'],
  pov: ['top', 'middle'],
  resultat: ['top', 'middle'],
  unboxing: ['middle'],
  fidele: ['middle', 'bottom'],
  demo: ['top'],
  comparaison: ['middle'],
  erreur: ['top'],
  coulisses: ['middle'],
  livraison: ['middle', 'bottom'],
  microtrottoir: ['top'],
  tutoriel: ['top', 'middle'],
  offre: ['bottom'],
  captures: ['middle', 'bottom'],
  details: ['middle'],
};

export const PRODUCT_TYPES = [1, 2, 3] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
/** The library's version: a saved config older than it gets the new default strategies and tools once (one the owner
 *  removed afterwards stays removed: the saved config then carries this version). 3: the Studio photo tool. */
export const STRATEGIES_VERSION = 3;

export interface CreditPack {
  key: string;
  name: string;
  credits: number;
  /** DA */
  price: number;
  on: boolean;
  /** « Le plus choisi » */
  best: boolean;
}

export interface CreditsConfig {
  /** the credits are counted (off: every AI tool is free and unlimited) */
  on: boolean;
  /** credits per month, by plan id (as a string); -1 = unlimited; a plan not listed gets `defaultCredits` */
  planCredits: Record<string, number>;
  defaultCredits: number;
  packs: CreditPack[];
  tools: CreditTool[];
  strategies: CreditStrategy[];
  /** STRATEGIES_VERSION when it was saved */
  version: number;
}

export const DEFAULT_CREDITS: CreditsConfig = {
  on: true,
  planCredits: {},
  defaultCredits: 100,
  packs: [
    { key: 'small', name: 'Petit pack', credits: 100, price: 500, on: true, best: false },
    { key: 'medium', name: 'Pack moyen', credits: 500, price: 2000, on: true, best: true },
    { key: 'big', name: 'Gros pack', credits: 2000, price: 6000, on: true, best: false },
  ],
  tools: [
    {
      key: TOOL_WORDS,
      name: 'Sous-titres IA',
      desc: 'L’IA écoute vos morceaux et écrit les sous-titres.',
      model: 'gemini-flash-lite-latest',
      credits: 2,
      unit: 'minute',
      on: true,
      prompt: '',
      dayLimit: 0,
    },
    { key: TOOL_TEXT, name: 'Texte du post IA', desc: 'L’IA écrit la partie qui change de chaque post.', model: 'claude-haiku-5-5', credits: 1, unit: 'post', on: true, prompt: '', dayLimit: 0 },
    { key: TOOL_HOOKS, name: 'Idées de hooks IA', desc: '10 idées de phrases pour le début de vos vidéos.', model: 'claude-haiku-5-5', credits: 1, unit: 'ten', on: true, prompt: '', dayLimit: 0 },
    {
      key: TOOL_PHOTO,
      name: 'Studio photo IA',
      desc: 'L’IA pose votre produit dans votre boutique (votre fond), comme une vraie photo.',
      model: 'gemini-3.1-flash-image-preview',
      credits: 10,
      unit: 'image',
      on: true,
      prompt: '',
      dayLimit: 60,
    },
  ],
  strategies: [
    {
      key: 'ugly',
      name: 'Ugly ads',
      kind: 'style',
      style: 'ugly',
      desc: 'Gros texte blanc, look fait au téléphone.',
      credits: 0,
      trend: true,
      on: true,
      idea: 'Ton direct et simple, comme un client qui parle.',
      types: [1, 2, 3],
      stages: [],
    },
    {
      key: 'probleme',
      name: 'Problème → Solution',
      kind: 'recipe',
      style: 'ugly',
      desc: 'Le hook montre le problème, le corps le produit qui le règle.',
      credits: 0,
      trend: false,
      on: true,
      idea: 'Commence par le problème du client, puis la solution avec le produit.',
      types: [1, 2, 3],
      stages: [],
    },
    {
      key: 'temoignage',
      name: 'Témoignage client',
      kind: 'recipe',
      style: 'clean',
      desc: 'Une personne parle du produit, avec sous-titres.',
      credits: 1,
      trend: true,
      on: true,
      idea: 'Comme un client content qui raconte son expérience.',
      types: [1, 2, 3],
      stages: [],
    },
    { key: 'propre', name: 'Propre', kind: 'style', style: 'clean', desc: 'Texte fin avec une ombre, look plus « marque ».', credits: 0, trend: false, on: true, idea: 'Ton soigné, rassurant.', types: [1, 2, 3], stages: [] },
    // the video formats (version 2): what each video shows, and the product types it fits best
    ...(
      [
        ['pov', 'POV', 'ugly', 'Filmé avec les yeux du client : « POV : tu as enfin trouvé… ».', 'Écris comme si le client vivait le moment lui-même : « POV : … ».', [1, 2, 3], true],
        ['resultat', 'Avant / Après', 'ugly', 'Le problème, puis le résultat avec le produit.', 'Montre le changement : avant le produit, puis après.', [1, 2], true],
        ['unboxing', 'Unboxing / réaction', 'ugly', 'Le client ouvre le colis et réagit.', 'La joie de recevoir et d’ouvrir le colis, la vraie réaction.', [2, 3], true],
        ['fidele', 'Client fidèle', 'clean', '« C’est ma 3e commande » : un client qui revient.', 'Un client qui revient : il fait confiance à la boutique.', [3], false],
        ['demo', 'Démo / test', 'ugly', 'Le produit marche devant la caméra : test d’eau, de chute, de force.', 'Prouve que ça marche, sans exagérer.', [1, 2], true],
        ['comparaison', 'Comparaison', 'clean', 'Le nôtre à côté d’un « normal » (sans nom de marque).', 'Montre pourquoi le nôtre est meilleur, avec des détails visibles. Ne nomme jamais une autre marque.', [2], false],
        ['erreur', 'Mythe ou erreur', 'ugly', '« Arrête de faire ça ❌, fais ça ✅ ».', 'Corrige une erreur courante, puis montre la bonne façon avec le produit.', [1, 2], false],
        ['coulisses', 'Coulisses', 'ugly', 'On emballe les commandes, les colis partent, l’équipe travaille.', 'Rassure : une vraie équipe, des colis préparés avec soin, envoyés vite.', [3], false],
        ['livraison', 'Preuve de livraison', 'ugly', 'Le livreur remet le colis, le client paie à la livraison.', 'Enlève la peur : on paie à la livraison, on vérifie avant de payer.', [3], false],
        ['microtrottoir', 'Micro-trottoir / quiz', 'ugly', 'Des gens dans la rue essaient le produit ou devinent le prix.', 'Curiosité et surprise : les vrais avis des gens.', [1], false],
        ['tutoriel', 'Tutoriel', 'clean', '« Comment l’utiliser en 3 étapes ».', 'Explique simplement, étape par étape.', [1], false],
        ['offre', 'Vidéo offre', 'clean', 'Gros texte : le prix, le pack, la date limite.', 'L’offre claire et l’urgence : le prix, ce qu’on gagne, jusqu’à quand.', [1, 2, 3], false],
        ['captures', 'Captures WhatsApp', 'clean', 'Les messages des clients contents, en captures.', 'Des preuves réelles : les mots des clients.', [2, 3], false],
        ['details', 'Zoom détails', 'clean', 'Gros plans : matière, coutures, poids, boîte.', 'La qualité qu’on voit : chaque détail compte.', [2], false],
      ] as const
    ).map(([key, name, style, desc, idea, types, trend]) => ({ key, name, kind: 'recipe' as const, style, desc, credits: 0, trend, on: true, idea, types: [...types] as ProductType[], stages: [] as FunnelStage[] })),
  ],
  version: STRATEGIES_VERSION,
};
for (const x of DEFAULT_CREDITS.strategies) x.stages = [...(DEFAULT_STAGES[x.key] ?? FUNNEL_STAGES)];

// ---------------------------------------------------------------- the control room's settings
const SETTING = 'ai_credits';
const clip = (x: unknown, max: number) =>
  String(x ?? '')
    .trim()
    .slice(0, max);
const int = (x: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
/** the product types a strategy fits (none given: all three) */
const typesOf = (x: unknown): ProductType[] => {
  const got = PRODUCT_TYPES.filter((n) => Array.isArray(x) && x.some((y) => Number(y) === n));
  return got.length ? [...got] : [...PRODUCT_TYPES];
};
/** the funnel stages a strategy fits (none given: its default's, or all three) */
const stagesOf = (x: unknown, key: string): FunnelStage[] => {
  const got = FUNNEL_STAGES.filter((n) => Array.isArray(x) && x.includes(n));
  return [...(got.length ? got : (DEFAULT_STAGES[key] ?? FUNNEL_STAGES))];
};
const keyOk = (x: unknown) => /^[a-z0-9-]{1,40}$/.test(String(x ?? ''));
/** a key from a name (« Avant / Après » → « avant-apres »), unique in the list */
export function creditKey(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'item';
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}-${n}`;
  return k;
}

function uniq<T extends { key: string; name: string }>(list: T[]): T[] {
  const taken = new Set<string>();
  return list.map((x) => {
    const key = keyOk(x.key) && !taken.has(x.key) ? x.key : creditKey(x.name, taken);
    taken.add(key);
    return { ...x, key };
  });
}

/** Whatever was saved (or sent by the control room), made safe. */
export function cleanCredits(v: any): CreditsConfig {
  const d = DEFAULT_CREDITS;
  if (!v || typeof v !== 'object') return structuredClone(d);
  const planCredits: Record<string, number> = {};
  for (const [k, n] of Object.entries(v.planCredits ?? {})) if (/^\d{1,9}$/.test(k)) planCredits[k] = int(n, -1, 1_000_000, 0);
  const packs = Array.isArray(v.packs)
    ? v.packs
        .slice(0, 12)
        .map((p: any) => ({
          key: clip(p?.key, 40),
          name: clip(p?.name, 60) || 'Pack',
          credits: int(p?.credits, 1, 1_000_000, 100),
          price: int(p?.price, 0, 10_000_000, 0),
          on: p?.on !== false,
          best: !!p?.best,
        }))
    : d.packs;
  const tools: CreditTool[] = Array.isArray(v.tools)
    ? v.tools
        .slice(0, 30)
        .map((x: any) => ({
          key: clip(x?.key, 40),
          name: clip(x?.name, 60) || 'Outil',
          desc: clip(x?.desc, 200),
          model: clip(x?.model, 80),
          credits: int(x?.credits, 0, 10_000, 1),
          unit: (CREDIT_UNITS as readonly string[]).includes(x?.unit) ? (x.unit as CreditUnit) : 'post',
          on: x?.on !== false,
          prompt: clip(x?.prompt, 2000),
          dayLimit: int(x?.dayLimit, 0, 1_000_000, 0),
        }))
    : d.tools;
  const strategies: CreditStrategy[] = Array.isArray(v.strategies)
    ? v.strategies
        .slice(0, 40)
        .map((x: any) => ({
          key: clip(x?.key, 40),
          name: clip(x?.name, 60) || 'Stratégie',
          kind: x?.kind === 'recipe' ? ('recipe' as const) : ('style' as const),
          style: (CREDIT_STYLES as readonly string[]).includes(x?.style) ? (x.style as CreditStyle) : 'ugly',
          desc: clip(x?.desc, 200),
          credits: int(x?.credits, 0, 10_000, 0),
          trend: !!x?.trend,
          on: x?.on !== false,
          idea: clip(x?.idea, 600),
          types: typesOf(x?.types),
          stages: stagesOf(x?.stages, clip(x?.key, 40)),
        }))
    : structuredClone(d.strategies);
  // a config saved before the newer default tools: they are added once (at the end)
  if (Array.isArray(v.tools) && int(v.version, 0, 1000, 1) < STRATEGIES_VERSION) {
    const have = new Set(tools.map((x: CreditTool) => x.key));
    for (const x of d.tools) if (!have.has(x.key)) tools.push(structuredClone(x));
  }
  // a config saved before the newer default strategies: they are added once (at the end, on as the defaults are)
  if (Array.isArray(v.strategies) && int(v.version, 0, 1000, 1) < STRATEGIES_VERSION) {
    const have = new Set(strategies.map((x) => x.key));
    for (const x of d.strategies) if (!have.has(x.key)) strategies.push(structuredClone(x));
  }
  return {
    on: v.on !== false,
    planCredits,
    defaultCredits: int(v.defaultCredits, -1, 1_000_000, d.defaultCredits),
    packs: uniq(packs),
    tools: uniq(tools),
    strategies: uniq(strategies).slice(0, 40),
    version: STRATEGIES_VERSION,
  };
}

export async function creditsConfig(t: Tenancy): Promise<CreditsConfig> {
  const r = (await t.platform.query<{ value: unknown }>('SELECT value FROM platform.settings WHERE key = $1', [SETTING]).catch(() => []))[0];
  const v = typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value;
  return cleanCredits(v ?? null);
}

export async function saveCreditsConfig(t: Tenancy, c: CreditsConfig): Promise<CreditsConfig> {
  const clean = cleanCredits(c);
  await t.platform.query(`INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SETTING, JSON.stringify(clean)]);
  return clean;
}

// ---------------------------------------------------------------- the shop's wallet
export const CREDITS_SQL = `
CREATE TABLE IF NOT EXISTS platform.ai_wallets (
  shop_id    integer PRIMARY KEY REFERENCES platform.shops(id),
  month      text    NOT NULL,
  used       integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  bonus      integer NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform.ai_credit_log (
  id         serial PRIMARY KEY,
  shop_id    integer NOT NULL REFERENCES platform.shops(id),
  at         timestamptz NOT NULL DEFAULT now(),
  delta      integer NOT NULL,
  kind       text    NOT NULL CHECK (kind IN ('use', 'refund', 'pack', 'gift')),
  tool       text,
  units      integer NOT NULL DEFAULT 0,
  note       text
);
CREATE INDEX IF NOT EXISTS ai_credit_log_shop ON platform.ai_credit_log (shop_id, at DESC);
ALTER TABLE platform.payment_claims ADD COLUMN IF NOT EXISTS credits integer CHECK (credits IS NULL OR credits > 0);
ALTER TABLE platform.payment_claims ADD COLUMN IF NOT EXISTS pack_key text;
ALTER TABLE platform.payment_claims DROP CONSTRAINT IF EXISTS payment_claims_months_check;
ALTER TABLE platform.payment_claims ADD CONSTRAINT payment_claims_months_check CHECK (months IN (0, 1, 12));
DROP INDEX IF EXISTS platform.payment_claims_one_pending;
CREATE UNIQUE INDEX IF NOT EXISTS payment_claims_one_pending ON platform.payment_claims (shop_id, (credits IS NOT NULL)) WHERE status = 'pending';
`;

/** Algeria's month « 2026-11 ». */
export const creditMonth = (now: number) => new Date(now + 3_600_000).toISOString().slice(0, 7);

/** The month's credits of a plan (-1: unlimited). */
export function planAllowance(c: CreditsConfig, planId: number | null | undefined): number {
  const k = planId == null ? '' : String(planId);
  return k && k in c.planCredits ? c.planCredits[k] : c.defaultCredits;
}

export interface Wallet {
  /** credits counted (off: free) */
  on: boolean;
  month: string;
  /** -1 = unlimited */
  allowance: number;
  used: number;
  /** bought (they stay) */
  bonus: number;
  /** what may still be spent (-1 = unlimited) */
  left: number;
}

async function row(t: Tenancy, shopId: number, month: string): Promise<{ used: number; bonus: number }> {
  // a new month: the month's credits start again (the bought ones stay)
  const r = await t.platform.query(
    `INSERT INTO platform.ai_wallets (shop_id, month) VALUES ($1, $2)
     ON CONFLICT (shop_id) DO UPDATE SET month = EXCLUDED.month, used = CASE WHEN platform.ai_wallets.month = EXCLUDED.month THEN platform.ai_wallets.used ELSE 0 END
     RETURNING used, bonus`,
    [shopId, month],
  );
  return { used: num(r[0].used), bonus: num(r[0].bonus) };
}

export async function wallet(t: Tenancy, shop: { id: number; planId: number | null }, now: number, c?: CreditsConfig): Promise<Wallet> {
  const cfg = c ?? (await creditsConfig(t));
  const month = creditMonth(now);
  const w = await row(t, shop.id, month);
  const allowance = planAllowance(cfg, shop.planId);
  const left = !cfg.on || allowance < 0 ? -1 : Math.max(0, allowance - w.used) + w.bonus;
  return { on: cfg.on, month, allowance, used: w.used, bonus: w.bonus, left };
}

export interface Spent {
  month: number;
  bonus: number;
}

/**
 * Takes `credits` from the shop (the month's first, then the bought ones). Null: not enough left. The tool and the
 * units are kept in the log. Two spends at the same moment never take the same credit (the row is checked as it was).
 */
export async function spendCredits(t: Tenancy, shop: { id: number; planId: number | null }, credits: number, a: { tool: string; units: number; now: number; note?: string }): Promise<Spent | null> {
  const cfg = await creditsConfig(t);
  if (!cfg.on || credits <= 0) return { month: 0, bonus: 0 };
  const allowance = planAllowance(cfg, shop.planId);
  const month = creditMonth(a.now);
  for (let tries = 0; tries < 5; tries++) {
    const w = await row(t, shop.id, month);
    const fromMonth = allowance < 0 ? credits : Math.min(credits, Math.max(0, allowance - w.used));
    const fromBonus = credits - fromMonth;
    if (fromBonus > w.bonus) return null;
    const ok = await t.platform.query(
      `UPDATE platform.ai_wallets SET used = used + $4, bonus = bonus - $5, updated_at = now() WHERE shop_id = $1 AND month = $2 AND used = $3 AND bonus = $6 RETURNING shop_id`,
      [shop.id, month, w.used, fromMonth, fromBonus, w.bonus],
    );
    if (ok.length) {
      await t.platform.query(`INSERT INTO platform.ai_credit_log (shop_id, delta, kind, tool, units, note) VALUES ($1, $2, 'use', $3, $4, $5)`, [shop.id, -credits, a.tool, a.units, a.note ?? null]);
      return { month: fromMonth, bonus: fromBonus };
    }
  }
  throw new Error('Crédits occupés : réessayez');
}

/** Gives back what a failed AI answer took. */
export async function refundCredits(t: Tenancy, shopId: number, s: Spent, tool: string, now: number): Promise<void> {
  const n = s.month + s.bonus;
  if (!n) return;
  await t.platform.query(
    `UPDATE platform.ai_wallets SET used = CASE WHEN month = $4 THEN greatest(0, used - $2) ELSE used END, bonus = bonus + CASE WHEN month = $4 THEN $3 ELSE $3 + $2 END, updated_at = now() WHERE shop_id = $1`,
    [shopId, s.month, s.bonus, creditMonth(now)],
  );
  await t.platform.query(`INSERT INTO platform.ai_credit_log (shop_id, delta, kind, tool) VALUES ($1, $2, 'refund', $3)`, [shopId, n, tool]);
}

/** Credits that stay (a pack paid, or a gift of Pilotix). */
export async function addCredits(t: Tenancy, shopId: number, credits: number, kind: 'pack' | 'gift', now: number, note?: string): Promise<void> {
  await row(t, shopId, creditMonth(now));
  await t.platform.query(`UPDATE platform.ai_wallets SET bonus = greatest(0, bonus + $2), updated_at = now() WHERE shop_id = $1`, [shopId, credits]);
  await t.platform.query(`INSERT INTO platform.ai_credit_log (shop_id, delta, kind, note) VALUES ($1, $2, $3, $4)`, [shopId, credits, kind, note ?? null]);
}

/** Units of a tool used today (its day limit). */
export async function usedToday(t: Tenancy, shopId: number, tool: string): Promise<number> {
  const r = await t.platform.query(
    `SELECT coalesce(sum(units), 0) AS n FROM platform.ai_credit_log WHERE shop_id = $1 AND tool = $2 AND kind = 'use' AND (at AT TIME ZONE 'Africa/Algiers')::date = (now() AT TIME ZONE 'Africa/Algiers')::date`,
    [shopId, tool],
  );
  return num(r[0]?.n);
}

/** The last moves of a shop's credits (control room and the shop's « Historique »). */
export async function creditLog(t: Tenancy, shopId: number, limit = 30) {
  const r = await t.platform.query(`SELECT id, at, delta, kind, tool, units, note FROM platform.ai_credit_log WHERE shop_id = $1 ORDER BY id DESC LIMIT $2`, [shopId, limit]);
  return r.map((x: any) => ({
    id: num(x.id),
    at: isoOrNull(x.at)!,
    delta: num(x.delta),
    kind: String(x.kind),
    tool: (x.tool as string | null) ?? null,
    units: num(x.units),
    note: (x.note as string | null) ?? null,
  }));
}

/** What `units` of a tool cost. */
export const toolCost = (tool: CreditTool, units: number) => Math.max(0, Math.ceil(units)) * tool.credits;
