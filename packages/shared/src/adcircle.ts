// Marketing › Stratégies › « Life ad circle »: one ad strategy drawn as a circle of five steps (test, judge, scale,
// watch, start again). Each step tells its rules in plain words (CIRCLE_RULES) and has its own settings, which the
// shop changes; the defaults are the plan as written with its first shop.
//
// One place for each number. The rhythm of the week and what a test is made of are the circle's own settings
// (CIRCLE_FIELDS). Every number that judges an ad — the lines of the cost, how sure before a stop, the budget steps,
// when a winner gets its own ad set… — is set in Pilot Checks (pilotchecks.ts): the circle shows them (CircleChecks)
// and never keeps a copy, so the two pages cannot disagree.
//
// Pilotix only keeps the numbers here: nothing is launched or judged from them yet.

/** The row of the shop's settings that keeps the circle's values. */
export const CIRCLE_SETTING = 'ad_circle';

export type CircleStep = 'test' | 'judge' | 'scale' | 'watch' | 'again';
export const CIRCLE_STEPS: readonly CircleStep[] = ['test', 'judge', 'scale', 'watch', 'again'];

/** day: 0 Sunday … 6 Saturday. A null day or number = not chosen yet. */
export type CircleKind = 'day' | 'int' | 'num' | 'bool';
export interface CircleField {
  key: string;
  step: CircleStep;
  kind: CircleKind;
  def: number | boolean | null;
  min?: number;
  max?: number;
  /** may be left empty */
  optional?: boolean;
}

export const CIRCLE_FIELDS: readonly CircleField[] = [
  { key: 'testDay', step: 'test', kind: 'day', def: 2 },
  { key: 'testPerWeek', step: 'test', kind: 'int', def: null, min: 1, max: 500, optional: true },
  { key: 'testVideos', step: 'test', kind: 'int', def: 3, min: 0, max: 20 },
  { key: 'testImages', step: 'test', kind: 'int', def: 1, min: 0, max: 20 },
  { key: 'testBuys', step: 'test', kind: 'int', def: 50, min: 1, max: 1000 },
  { key: 'testDays', step: 'test', kind: 'int', def: 7, min: 1, max: 30 },

  // the verdict's numbers (how many orders win, how sure before « not a winner ») are Pilot Checks'
  { key: 'judgeDay', step: 'judge', kind: 'day', def: 3 },

  // « scale » and « watch » have no setting of their own: the winners enter on the verdict day, and every number
  // these two steps read is a line or a general setting of Pilot Checks

  { key: 'againVideoDay', step: 'again', kind: 'day', def: 6 },
  // the one exception to « a lost product gets no ad »: on, the rule that says so is shown right under it
  { key: 'againMessages', step: 'again', kind: 'bool', def: true },
  { key: 'againAlways', step: 'again', kind: 'bool', def: true },
];

export type CircleValue = number | boolean | null;
export type CircleValues = Record<string, CircleValue>;

const BY_KEY = new Map(CIRCLE_FIELDS.map((f) => [f.key, f]));
export const circleField = (key: string): CircleField | undefined => BY_KEY.get(key);

/** Why a value cannot be kept for this field, or null when it can. */
export function circleBad(f: CircleField, v: unknown): 'empty' | 'kind' | 'range' | null {
  if (v === null || v === undefined || v === '') return f.optional ? null : 'empty';
  if (f.kind === 'bool') return typeof v === 'boolean' ? null : 'kind';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'kind';
  if (f.kind === 'day') return Number.isInteger(v) && v >= 0 && v <= 6 ? null : 'range';
  if (f.kind === 'int' && !Number.isInteger(v)) return 'kind';
  if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return 'range';
  return null;
}

/** The shop's values: what it saved where that is still valid, the defaults everywhere else. */
export function circleValues(saved: unknown): CircleValues {
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const out: CircleValues = {};
  for (const f of CIRCLE_FIELDS) {
    const has = Object.prototype.hasOwnProperty.call(s, f.key);
    out[f.key] = has && circleBad(f, s[f.key]) === null ? ((s[f.key] ?? null) as CircleValue) : f.def;
  }
  return out;
}

/**
 * The numbers the circle's rules take from Pilot Checks: these general settings (CHECK_SETTINGS keys), and a few lines
 * of its KPIs — the cost of a confirmed order against the bid limit (D1: good, bad, stop), the account brake (D7),
 * the days of stock under which a product's ads pause (O20), the big edits that freeze an ad set (M5) and the ideas
 * kept live (M3).
 */
export const CIRCLE_FROM_SETTINGS = ['judgeDays', 'proofPct', 'budgetStep', 'budgetCuts', 'budgetBase', 'groupBand', 'ownOrders', 'testAds', 'winOrders', 'pendingHours', 'freezeDays', 'brakeDays', 'awarenessBudget'] as const;
export type CircleFromSetting = (typeof CIRCLE_FROM_SETTINGS)[number];
export interface CircleChecks {
  set: Record<CircleFromSetting, number | null>;
  good: number | null;
  bad: number | null;
  stop: number | null;
  brakeAt: number | null;
  stockStop: number | null;
  freezeEdits: number | null;
  ideasMin: number | null;
  /** the confirmed orders an ad set needs before its budget moves (D1's wait) */
  budgetWait: number | null;
}

/** The rules of each step, in reading order (their words: strat.circle.r.<key> in the app's texts). */
export const CIRCLE_RULES: Readonly<Record<CircleStep, readonly string[]>> = {
  test: ['bidLimit', 'noMargin', 'launch', 'testCap', 'testBudget', 'handsOff', 'adId'],
  judge: ['verdict', 'winner', 'notWinner', 'undecided', 'pending', 'after'],
  scale: ['batch', 'keep', 'group', 'own', 'startBudget'],
  watch: ['lines', 'budgetWait', 'budgetUp', 'budgetDown', 'proof', 'stock', 'freeze', 'brake', 'noData'],
  again: ['round', 'videoDay', 'newIdea', 'copy', 'lost', 'messages', 'always', 'noRule'],
};

/** A rule whose words follow a choice of the shop: every text it can take (the first is the default's). */
export const CIRCLE_RULE_FORMS: Readonly<Record<string, readonly string[]>> = {
  launch: ['launch', 'launchVideos', 'launchImages'],
  handsOff: ['handsOff', 'handsOffNow'],
  proof: ['proof', 'proofNow'],
  round: ['round', 'roundN'],
  always: ['always', 'alwaysBudget'],
};

/** Every text a rule can show (for the check that the three languages have them all). */
export const CIRCLE_RULE_TEXTS: readonly string[] = CIRCLE_STEPS.flatMap((st) => CIRCLE_RULES[st].flatMap((k) => CIRCLE_RULE_FORMS[k] ?? [k]));

/**
 * The texts of a step's rules as this shop reads them: a rule follows the shop's choices (a test of videos only, a
 * number of products per week or none…), and a rule about something the shop switched off is left out.
 */
export function circleRules(step: CircleStep, v: CircleValues, c: CircleChecks): string[] {
  const out: string[] = [];
  // 0 day of waiting: an ad can be judged from its first hour, and the rule says so
  const wait = (c.set.judgeDays ?? 0) > 0;
  const n = (key: string) => (typeof v[key] === 'number' ? (v[key] as number) : 0);
  for (const k of CIRCLE_RULES[step]) {
    if (k === 'launch') out.push(n('testImages') === 0 ? 'launchVideos' : n('testVideos') === 0 ? 'launchImages' : 'launch');
    else if (k === 'handsOff') out.push(wait ? 'handsOff' : 'handsOffNow');
    else if (k === 'proof') out.push(wait ? 'proof' : 'proofNow');
    else if (k === 'round') out.push(typeof v.testPerWeek === 'number' ? 'roundN' : 'round');
    else if (k === 'messages') { if (v.againMessages === true) out.push(k); }
    else if (k === 'always') { if (v.againAlways === true) out.push(c.set.awarenessBudget !== null ? 'alwaysBudget' : 'always'); }
    else out.push(k);
  }
  return out;
}

/** The ads a test holds: its videos and its images. */
export function circleTestAds(v: CircleValues): number {
  return (typeof v.testVideos === 'number' ? v.testVideos : 0) + (typeof v.testImages === 'number' ? v.testImages : 0);
}

/**
 * Why a test cannot hold these ads, or null when it can: a test has one ad at least, and never more than Pilot Checks
 * allows in a test ad set (max; null = no limit known). A test already over the limit (Pilot Checks' number was
 * lowered since) may still lose ads: a change that takes some out is kept (before = the values it replaces).
 */
export function circleTestAdsBad(next: CircleValues, max: number | null, before?: CircleValues): 'none' | 'over' | null {
  const have = circleTestAds(next);
  if (have < 1) return 'none';
  if (max !== null && have > max && !(before && have < circleTestAds(before))) return 'over';
  return null;
}
