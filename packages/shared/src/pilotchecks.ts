// Pilot Automations › Pilot Checks: the cases the shop's owner wrote in his « Pilotix Judge » table (14 Nov 2026) —
// what can go wrong in the offer, the video, the landing page, the page's trust, Meta and the team. Each case has ONE
// number (« this ÷ that », written in the app's texts: checks.c.<id>.kpi), a limit (« bad when »), what to do, the other
// part to fix, a helper and, for some, how much data it waits for before it judges (« en apprentissage »).
//
// The three helpers, from the earliest to the latest:
//   door   = the mistake cannot happen (a button stays locked): only the cases that have a door (`doors`);
//   bell   = it rings early, before money is lost;
//   doctor = it happened: the case is named, with its numbers and what to do.
// A case starts in the earliest helper that can catch it (`level`). The owner changes the limit, the action, the other
// part, the level and the wait in the app; what he did not change stays the value written here.
//
// `data` says what Pilotix has TODAY to count the case (read in the code on 14 Nov 2026, not measured on a real shop):
//   ready      = the data is there;
//   reason     = a reason is missing in the agents' lists (« pas confiance », « pas ma couleur »…);
//   tags       = the videos have no tags yet (angle, first scene, person);
//   tick       = a person has to tick a list (Pilotix cannot read it alone);
//   none       = Pilotix does not have the data (watch curve, scroll, competitor prices, Meta's quality rank);
//   unverified = nobody checked yet that Pilotix keeps it (the ad's id on real orders, the bid cap, call times…).
// This step only keeps the rules: nothing is counted, blocked or rung with them yet.

export const CHECK_PARTS = ['offer', 'video', 'landing', 'trust', 'meta', 'team'] as const;
export type CheckPart = (typeof CHECK_PARTS)[number];

export const CHECK_LEVELS = ['off', 'doctor', 'bell', 'door'] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

/** where a door stands: a price or a cost is saved, an ad is launched, a page is published, an agent's screen */
export type CheckDoor = 'price' | 'ad' | 'page' | 'agent';

/**
 * How the case's number is compared with its limit: under it, over it, « v or more », outside v…v2, lower than the
 * others by v points, or a fixed condition with no number (checks.c.<id>.when).
 */
export type CheckOp = 'lt' | 'gt' | 'gte' | 'out' | 'gap' | 'fixed';
export type CheckUnit = 'pct' | 'pts' | 'n' | 'days' | 'pieces' | 'times' | 'of10' | 'of3';
export type CheckWaitUnit = 'shown' | 'views3s' | 'comments' | 'orders' | 'parcels' | 'weeks' | 'days' | 'videos' | 'cancelled' | 'unconfirmed';
export type CheckData = 'ready' | 'reason' | 'tags' | 'tick' | 'none' | 'unverified';

export interface CheckDef {
  /** O1…O19, V1…V10, L1…L10, P1…P8, M1…M12, T1…T12: the part's letter and the row of the owner's table */
  id: string;
  part: CheckPart;
  /** its first helper */
  level: Exclude<CheckLevel, 'off'>;
  /** the doors it has (none: it cannot block) */
  doors: CheckDoor[];
  op: CheckOp;
  unit: CheckUnit;
  /** the limit (null: a fixed condition) */
  v: number | null;
  /** the upper limit of « outside v…v2 » */
  v2: number | null;
  /** « en apprentissage »: no verdict before this much data (none: it does not wait) */
  wait: { v: number; unit: CheckWaitUnit } | null;
  data: CheckData;
  /** the limit has a condition after its number (checks.c.<id>.tail) */
  tail: boolean;
  /** it names another part to fix (checks.c.<id>.also) */
  also: boolean;
}

type Extra = { v2?: number; doors?: CheckDoor[]; wait?: [number, CheckWaitUnit]; tail?: true; also?: true };
const PART_OF: Record<string, CheckPart> = { O: 'offer', V: 'video', L: 'landing', P: 'trust', M: 'meta', T: 'team' };
const c = (id: string, level: CheckDef['level'], op: CheckOp, unit: CheckUnit, v: number | null, data: CheckData, x: Extra = {}): CheckDef => ({
  id,
  part: PART_OF[id[0]],
  level,
  doors: x.doors ?? [],
  op,
  unit,
  v,
  v2: x.v2 ?? null,
  wait: x.wait ? { v: x.wait[0], unit: x.wait[1] } : null,
  data,
  tail: !!x.tail,
  also: !!x.also,
});

/** every « reason » case waits for this many cancelled orders */
const REASONS: [number, CheckWaitUnit] = [20, 'cancelled'];

export const CHECKS: readonly CheckDef[] = [
  // ---------------------------------------------------------------- offer = product + price + value + market
  c('O1', 'doctor', 'lt', 'pct', 1, 'ready', { tail: true, wait: [3, 'videos'] }),
  c('O2', 'doctor', 'gt', 'pct', 30, 'unverified'),
  c('O3', 'doctor', 'lt', 'pct', 85, 'ready', { tail: true, also: true }),
  c('O4', 'doctor', 'gt', 'pct', 10, 'reason', { wait: REASONS }),
  c('O5', 'doctor', 'gt', 'pct', 20, 'ready', { wait: REASONS, also: true }),
  c('O6', 'doctor', 'gt', 'pct', 15, 'ready', { wait: REASONS, also: true }),
  c('O7', 'doctor', 'gt', 'pct', 10, 'reason', { wait: REASONS, also: true }),
  c('O8', 'door', 'lt', 'pct', 5, 'unverified', { doors: ['price', 'ad'], also: true }),
  c('O9', 'door', 'gt', 'pct', 105, 'ready', { doors: ['price'] }),
  c('O10', 'doctor', 'gt', 'pct', 10, 'ready', { wait: REASONS, also: true }),
  c('O11', 'doctor', 'gt', 'pct', 25, 'reason', { wait: [20, 'unconfirmed'], also: true }),
  c('O12', 'doctor', 'lt', 'pieces', 1.2, 'ready', { also: true }),
  c('O13', 'doctor', 'lt', 'pct', 15, 'ready', { also: true }),
  c('O14', 'door', 'gt', 'pct', 10, 'reason', { doors: ['page'], wait: REASONS, also: true }),
  c('O15', 'doctor', 'gt', 'pct', 10, 'ready', { wait: REASONS, also: true }),
  c('O16', 'door', 'gt', 'pct', 20, 'unverified', { doors: ['page'], also: true }),
  c('O17', 'doctor', 'lt', 'pct', 70, 'unverified', { tail: true }),
  c('O18', 'doctor', 'lt', 'pct', 90, 'none', { tail: true, also: true }),
  c('O19', 'bell', 'gte', 'n', 3, 'ready', { also: true }),
  // ---------------------------------------------------------------- video
  c('V1', 'bell', 'lt', 'pct', 20, 'ready', { wait: [1000, 'shown'] }),
  c('V2', 'bell', 'lt', 'pct', 25, 'ready', { wait: [300, 'views3s'] }),
  c('V3', 'bell', 'lt', 'pct', 50, 'none'),
  c('V4', 'doctor', 'lt', 'pct', 0.8, 'ready', { wait: [3000, 'shown'], also: true }),
  c('V5', 'doctor', 'gt', 'pct', 20, 'ready', { wait: [30, 'comments'] }),
  c('V6', 'doctor', 'gap', 'pts', 10, 'unverified', { wait: [30, 'orders'] }),
  c('V7', 'doctor', 'gap', 'pts', 10, 'unverified', { wait: [30, 'parcels'], also: true }),
  c('V8', 'door', 'fixed', 'n', null, 'tags', { doors: ['ad'], also: true }),
  c('V9', 'bell', 'lt', 'pct', 70, 'ready', { wait: [2, 'weeks'] }),
  c('V10', 'bell', 'lt', 'pct', 20, 'unverified', { wait: [3, 'days'], also: true }),
  // ---------------------------------------------------------------- landing page
  c('L1', 'bell', 'lt', 'pct', 70, 'ready'),
  c('L2', 'door', 'lt', 'pct', 50, 'ready', { doors: ['page'], tail: true }),
  c('L3', 'doctor', 'lt', 'pct', 50, 'unverified', { tail: true, also: true }),
  c('L4', 'door', 'lt', 'pct', 40, 'ready', { doors: ['page'], also: true }),
  c('L5', 'door', 'gt', 'pct', 30, 'unverified', { doors: ['page'], also: true }),
  c('L6', 'doctor', 'lt', 'pct', 50, 'unverified'),
  c('L7', 'doctor', 'gt', 'pct', 10, 'reason', { tail: true, wait: REASONS, also: true }),
  c('L8', 'door', 'lt', 'pct', 60, 'none', { doors: ['page'] }),
  c('L9', 'door', 'lt', 'of10', 6, 'tick', { doors: ['page'] }),
  c('L10', 'bell', 'lt', 'pct', 15, 'ready', { also: true }),
  // ---------------------------------------------------------------- page trust and values
  c('P1', 'bell', 'lt', 'n', 4, 'ready'),
  c('P2', 'bell', 'gt', 'pct', 15, 'ready', { also: true }),
  c('P3', 'bell', 'lt', 'pct', 80, 'unverified'),
  c('P4', 'bell', 'lt', 'n', 10, 'tick'),
  c('P5', 'doctor', 'gt', 'pct', 10, 'reason', { wait: REASONS }),
  c('P6', 'door', 'lt', 'of3', 3, 'tick', { doors: ['ad', 'page'], also: true }),
  c('P7', 'doctor', 'lt', 'pct', 10, 'ready', { also: true }),
  c('P8', 'doctor', 'fixed', 'n', null, 'none', { also: true }),
  // ---------------------------------------------------------------- Meta
  c('M1', 'bell', 'lt', 'pct', 80, 'ready'),
  c('M2', 'bell', 'out', 'pct', 70, 'ready', { v2: 130 }),
  c('M3', 'bell', 'lt', 'n', 5, 'tags', { also: true }),
  c('M4', 'bell', 'gt', 'pct', 50, 'tags', { also: true }),
  c('M5', 'door', 'gte', 'n', 2, 'ready', { doors: ['ad'] }),
  c('M6', 'door', 'gt', 'pct', 100, 'unverified', { doors: ['ad'] }),
  c('M7', 'bell', 'lt', 'pct', 50, 'unverified', { also: true }),
  c('M8', 'bell', 'gt', 'pct', 120, 'ready', { also: true }),
  c('M9', 'bell', 'gt', 'times', 2.5, 'ready'),
  c('M10', 'door', 'gt', 'pct', 20, 'ready', { doors: ['ad'], also: true }),
  c('M11', 'bell', 'gte', 'n', 1, 'unverified'),
  c('M12', 'doctor', 'gt', 'pct', 125, 'ready', { also: true }),
  // ---------------------------------------------------------------- team = confirmation + depot + delivery
  c('T1', 'bell', 'lt', 'pct', 80, 'unverified'),
  c('T2', 'door', 'gt', 'pct', 20, 'ready', { doors: ['agent'] }),
  c('T3', 'doctor', 'gap', 'pts', 10, 'ready'),
  c('T4', 'door', 'gap', 'pts', 10, 'ready', { doors: ['agent'] }),
  c('T5', 'doctor', 'lt', 'pct', 10, 'ready', { also: true }),
  c('T6', 'bell', 'lt', 'pct', 80, 'unverified'),
  c('T7', 'bell', 'lt', 'pct', 90, 'unverified'),
  c('T8', 'doctor', 'gt', 'days', 5, 'unverified'),
  c('T9', 'doctor', 'gap', 'pts', 15, 'ready', { also: true }),
  c('T10', 'bell', 'gt', 'pct', 20, 'unverified'),
  c('T11', 'door', 'gt', 'pct', 3, 'ready', { doors: ['agent'] }),
  c('T12', 'bell', 'lt', 'pct', 80, 'unverified'),
];

const BY_ID = new Map(CHECKS.map((d) => [d.id, d]));
export const checkDef = (id: string): CheckDef | undefined => BY_ID.get(id);

/** The helpers a case can be given: a door only where one stands. */
export const checkLevels = (d: CheckDef): CheckLevel[] => (d.doors.length ? ['off', 'doctor', 'bell', 'door'] : ['off', 'doctor', 'bell']);

/** The limit a number may take, by what it counts (two decimals at most). */
export const CHECK_RANGE: Record<CheckUnit, { min: number; max: number; step: number }> = {
  pct: { min: 0, max: 1000, step: 0.1 },
  pts: { min: 1, max: 100, step: 1 },
  n: { min: 0, max: 1000, step: 1 },
  days: { min: 1, max: 365, step: 1 },
  pieces: { min: 1, max: 100, step: 0.1 },
  times: { min: 1, max: 50, step: 0.1 },
  of10: { min: 0, max: 10, step: 1 },
  of3: { min: 0, max: 3, step: 1 },
};
export const CHECK_WAIT_MAX = 1_000_000;
export const CHECK_TEXT_MAX = 300;

/** A case as the shop has it now: the owner's values where he changed them, the starting ones elsewhere. */
export interface CheckRule {
  id: string;
  v: number | null;
  v2: number | null;
  level: CheckLevel;
  wait: number | null;
  /** his own words (null: the app's text, checks.c.<id>.do / .also) */
  action: string | null;
  other: string | null;
  /** what he changed: 'v' | 'v2' | 'level' | 'wait' | 'action' | 'other' */
  changed: string[];
}

export interface CheckOverride {
  v?: number | null;
  v2?: number | null;
  level?: string | null;
  wait?: number | null;
  action?: string | null;
  other?: string | null;
}

/** The case with the owner's changes on top (a value he never set, or one that is no longer allowed, stays the starting one). */
export function checkRule(d: CheckDef, o: CheckOverride | undefined): CheckRule {
  const changed: string[] = [];
  const pick = <T,>(key: string, mine: T | null | undefined, start: T): T => {
    if (mine === null || mine === undefined || mine === start) return start;
    changed.push(key);
    return mine;
  };
  const level = o?.level && (checkLevels(d) as string[]).includes(o.level) ? (o.level as CheckLevel) : null;
  return {
    id: d.id,
    v: d.v === null ? null : pick('v', o?.v, d.v),
    v2: d.v2 === null ? null : pick('v2', o?.v2, d.v2),
    level: pick<CheckLevel>('level', level, d.level),
    wait: d.wait ? pick('wait', o?.wait, d.wait.v) : null,
    action: pick<string | null>('action', o?.action?.trim() || null, null),
    other: pick<string | null>('other', o?.other?.trim() || null, null),
    changed,
  };
}
