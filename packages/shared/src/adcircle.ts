// Marketing › Stratégies › « Life ad circle »: one ad strategy drawn as a circle of five steps (test, judge, scale,
// watch, start again). Each step has its own settings, which the shop changes; the defaults are the plan as written
// with its first shop. Pilotix only keeps the numbers here: nothing is launched or judged from them yet.

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
  { key: 'testBidCap', step: 'test', kind: 'bool', def: false },

  { key: 'judgeDay', step: 'judge', kind: 'day', def: 3 },
  { key: 'judgeWin', step: 'judge', kind: 'int', def: 5, min: 1, max: 1000 },
  { key: 'judgeCut', step: 'judge', kind: 'int', def: 2, min: 0, max: 1000 },
  { key: 'judgeCutCost', step: 'judge', kind: 'num', def: 1.5, min: 1, max: 10 },
  { key: 'judgeMoreDays', step: 'judge', kind: 'int', def: 3, min: 1, max: 30 },

  { key: 'scaleGroups', step: 'scale', kind: 'int', def: 3, min: 1, max: 10 },
  { key: 'scaleBudget', step: 'scale', kind: 'num', def: 15, min: 0, max: 1000000 },
  { key: 'scaleKeepAds', step: 'scale', kind: 'int', def: 2, min: 1, max: 20 },
  { key: 'scaleDay', step: 'scale', kind: 'day', def: null, optional: true },

  { key: 'watchChecks', step: 'watch', kind: 'int', def: 2, min: 1, max: 7 },
  { key: 'watchGrow', step: 'watch', kind: 'int', def: 20, min: 1, max: 100 },
  { key: 'watchBack', step: 'watch', kind: 'int', def: 20, min: 1, max: 100 },
  { key: 'watchGoodDays', step: 'watch', kind: 'int', def: 3, min: 1, max: 30 },
  { key: 'watchBadDays', step: 'watch', kind: 'int', def: 3, min: 1, max: 30 },
  { key: 'watchBrakeDays', step: 'watch', kind: 'int', def: 3, min: 1, max: 30 },

  { key: 'againVideoDay', step: 'again', kind: 'day', def: 6 },
  { key: 'againVideos', step: 'again', kind: 'int', def: 3, min: 0, max: 20 },
  { key: 'againWeeks', step: 'again', kind: 'int', def: 2, min: 1, max: 12 },
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
