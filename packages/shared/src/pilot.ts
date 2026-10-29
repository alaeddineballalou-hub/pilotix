// « Pilot Auto Assign »: the seller's rules that choose who delivers each order. Shared by the server (which applies
// them) and the screen (which shows clashes while a rule is written, and tests an order).
//  - A rule = one or many wilayas (or « toutes sauf… »), some of their communes, and/or products → a company or
//    « Livraison privée » (a company of kind 'own': our livreurs). Each rule is strict or soft.
//  - An order matches a rule when its place is covered and (no product in the rule, or) one of its products is in it.
//  - Several rules match: strict ones first (strict always beats soft). Same company: no fight. Different companies:
//    the answer the seller gave when saving (« X gagne », or « À attribuer »).
//  - Two rules clash when they can catch the same order with different companies and are both strict or both soft;
//    products never keep two rules apart (an order can hold both products), only places do.
export interface PilotRule {
  /** stable id ('r1', 'r2'…); the number shown is the rule's place in the list */
  id: string;
  /** [] = every wilaya */
  wilayas: number[];
  /** every wilaya except `wilayas` */
  except: boolean;
  /** some communes of the chosen wilayas: such a wilaya is covered only there (others stay whole) */
  communes: { w: number; c: string }[];
  /** [] = every product */
  products: number[];
  /** the company that delivers (kind 'own': « Livraison privée ») */
  to: number;
  strict: boolean;
  on: boolean;
}
/** The seller's answer to a clash: the rule that wins, or « À attribuer » (a person chooses). */
export interface ClashAnswer {
  a: string;
  b: string;
  win: string;
}
export const CLASH_ASSIGN = 'assign';
export interface PilotConfig {
  mode: 'auto' | 'manual';
  rules: PilotRule[];
  clashes: ClashAnswer[];
}
export const PILOT_DEFAULT: PilotConfig = { mode: 'manual', rules: [], clashes: [] };

/** How an order got its company (shown on the order). */
export type PilotBy = 'rule' | 'strict' | 'default' | 'bureau' | 'hand' | 'backup' | 'none';

/** Quick buttons of the rule editor. */
export const REGIONS: Record<'ouest' | 'centre' | 'est' | 'sud', number[]> = {
  ouest: [13, 14, 20, 22, 27, 29, 31, 46, 48, 63, 64],
  centre: [2, 6, 9, 10, 15, 16, 26, 35, 38, 42, 44, 67],
  est: [4, 5, 12, 18, 19, 21, 23, 24, 25, 28, 34, 36, 40, 41, 43, 60, 62, 68],
  sud: [1, 3, 7, 8, 11, 17, 30, 32, 33, 37, 39, 45, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 61, 65, 66, 69],
};
/** The 69 wilayas (2026). */
export const ALL_WILAYAS: number[] = Array.from({ length: 69 }, (_, i) => i + 1);

/** A commune's name for comparing: no accents, case, spaces, dashes or apostrophes. */
export function normCommune(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]/g, '');
}

/** Where a rule reaches in one wilaya: nothing, the whole wilaya, or some communes. */
function reach(r: PilotRule, w: number): null | 'all' | Map<string, string> {
  const inW = r.except ? !r.wilayas.includes(w) : !r.wilayas.length || r.wilayas.includes(w);
  if (!inW) return null;
  const cs = r.except ? [] : r.communes.filter((x) => x.w === w);
  if (!cs.length) return 'all';
  return new Map(cs.map((x) => [normCommune(x.c), x.c]));
}

/** Does the rule cover this place? (a bureau order without commune counts on the wilaya) */
export function coversPlace(r: PilotRule, wilayaId: number, commune: string | null | undefined): boolean {
  const m = reach(r, wilayaId);
  if (!m) return false;
  if (m === 'all') return true;
  return m.has(normCommune(commune));
}

export interface PilotOrder {
  wilayaId: number;
  commune: string | null;
  productIds: number[];
}

export function ruleMatches(r: PilotRule, o: PilotOrder): boolean {
  if (!r.on || !coversPlace(r, o.wilayaId, o.commune)) return false;
  return !r.products.length || o.productIds.some((p) => r.products.includes(p));
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface Clash {
  a: string;
  b: string;
  /** 'ask': both strict or both soft — the seller says who wins; 'strict': the strict rule wins by itself */
  kind: 'ask' | 'strict';
  /** an order both rules catch */
  example: { wilayaId: number; commune: string | null; products: number[] };
  /** the seller's answer (an 'ask' clash): a rule id or 'assign' */
  win: string | null;
}

/** A place both rules reach (the first in wilaya order), or null: they never meet. */
function meeting(a: PilotRule, b: PilotRule): { wilayaId: number; commune: string | null } | null {
  for (const w of ALL_WILAYAS) {
    const x = reach(a, w);
    const y = reach(b, w);
    if (!x || !y) continue;
    if (x === 'all' && y === 'all') return { wilayaId: w, commune: null };
    if (x === 'all') return { wilayaId: w, commune: [...(y as Map<string, string>).values()][0] };
    if (y === 'all') return { wilayaId: w, commune: [...x.values()][0] };
    for (const [k, c] of x) if (y.has(k)) return { wilayaId: w, commune: c };
  }
  return null;
}

/** Every pair of rules (switched on) that can catch the same order with different companies. */
export function clashesOf(cfg: Pick<PilotConfig, 'rules' | 'clashes'>): Clash[] {
  const answers = new Map(cfg.clashes.map((c) => [pairKey(c.a, c.b), c.win]));
  const on = cfg.rules.filter((r) => r.on);
  const out: Clash[] = [];
  for (let i = 0; i < on.length; i++)
    for (let j = i + 1; j < on.length; j++) {
      const a = on[i];
      const b = on[j];
      if (a.to === b.to) continue;
      const at = meeting(a, b);
      if (!at) continue;
      const shared = a.products.filter((p) => b.products.includes(p));
      const products = a.products.length && b.products.length ? (shared.length ? [shared[0]] : [a.products[0], b.products[0]]) : a.products.length ? [a.products[0]] : b.products.length ? [b.products[0]] : [];
      const kind = a.strict === b.strict ? 'ask' : 'strict';
      const win = kind === 'ask' ? (answers.get(pairKey(a.id, b.id)) ?? null) : null;
      // an answer naming a rule of another pair (an old one) does not count
      out.push({ a: a.id, b: b.id, kind, example: { ...at, products }, win: win && (win === a.id || win === b.id || win === CLASH_ASSIGN) ? win : null });
    }
  return out;
}

export type PickResult = { rule: PilotRule } | { conflict: [string, string] } | { none: true };

/**
 * The rule that decides for this order. `usable`: the rule's company can take the order (it delivers there); a rule
 * whose company cannot is skipped, and the next ones decide.
 */
export function pickRule(cfg: Pick<PilotConfig, 'rules' | 'clashes'>, o: PilotOrder, usable: (r: PilotRule) => boolean = () => true): PickResult {
  const m = cfg.rules.filter((r) => ruleMatches(r, o) && usable(r));
  if (!m.length) return { none: true };
  const pool = m.some((r) => r.strict) ? m.filter((r) => r.strict) : m;
  if (new Set(pool.map((r) => r.to)).size === 1) return { rule: pool[0] };
  const answers = new Map(cfg.clashes.map((c) => [pairKey(c.a, c.b), c.win]));
  const winner = (x: PilotRule, y: PilotRule) => answers.get(pairKey(x.id, y.id));
  for (const r of pool) if (pool.every((s) => s.to === r.to || winner(r, s) === r.id)) return { rule: r };
  for (const r of pool)
    for (const s of pool) {
      if (r.to === s.to) continue;
      const w = winner(r, s);
      if (w !== r.id && w !== s.id) return { conflict: [r.id, s.id] };
    }
  return { conflict: [pool[0].id, pool[1].id] };
}

/** The number a rule shows (its place in the list), 0 when it is gone. */
export const ruleNumber = (rules: PilotRule[], id: string | null | undefined) => rules.findIndex((r) => r.id === id) + 1;

/** A fresh id for a new rule. */
export function newRuleId(rules: PilotRule[]): string {
  const n = rules.reduce((m, r) => Math.max(m, Number(r.id.replace(/\D/g, '')) || 0), 0);
  return `r${n + 1}`;
}

/** The Préférences' ticks of people (who changes the company by hand, who changes the rules); admins always may. */
export interface WhoTicks {
  confirmation: boolean;
  agency: boolean;
  depot: boolean;
  manager: boolean;
}
/**
 * Is this person one of the ticked kinds? Managers: the « Agent manager » role or the « Peut attribuer » tick; agency
 * agents: people of a confirmation agency; agents: the « Confirmation » role.
 */
export function personIs(s: { isAdmin: boolean; roles: readonly string[]; profile: { canAssign?: boolean; agencyId?: number | null } }, who: WhoTicks): boolean {
  if (s.isAdmin) return true;
  const manager = s.roles.includes('agent_manager') || !!s.profile.canAssign;
  const agency = s.profile.agencyId != null;
  return (manager && who.manager) || (s.roles.includes('depot') && who.depot) || (s.roles.includes('confirmation') && (agency ? who.agency : who.confirmation));
}

/** Why an order waits for a person (orders.pilot_why), as saved: 'conflict:2,4' | 'nobody' | 'manual'. */
export function readPilotWhy(v: string | null | undefined): { kind: 'conflict'; a: number; b: number } | { kind: 'nobody' | 'manual' } | null {
  if (!v) return null;
  if (v === 'nobody' || v === 'manual') return { kind: v };
  const m = /^conflict:(\d+),(\d+)$/.exec(v);
  return m ? { kind: 'conflict', a: Number(m[1]), b: Number(m[2]) } : null;
}
