// Pilot Automations › Pilot Checks: the shop's KPI list for its ads — the 83 checks the owner settled on 18 Nov 2026
// (his « Pilotix Judge » table of 14 Nov and his KPI sheet, merged, then debated and tested): money, leads and parcels,
// offer, video, landing page, page trust, Meta and the team. Each check has ONE number (« this ÷ that », written in the
// app's texts: checks.c.<id>.kpi) and up to three lines on it:
//   g = « good » (only the KPI with four levels: good, average, bad, stop);
//   v = « bad »: fix it;
//   s = worse than bad: « stop » (something is switched off) or « urgent » (fix first).
// A stop marked `proof` never fires on luck: only when the app is sure, and never before the ad is 2 days old (the
// general settings below: judgeDays, proofPct).
//
// The three helpers, from the earliest to the latest:
//   door   = the mistake cannot happen (a button stays locked): only the checks that have a door (`doors`);
//   bell   = it rings early, before money is lost;
//   doctor = it happened: the check is named, with its numbers and what to do.
// A check starts in the earliest helper that can catch it (`level`). The owner changes the lines, the action, the other
// part, the helper and the wait in the app; what he did not change stays the value written here.
//
// `data` says what Pilotix has TODAY to count the check (read in the code, not measured on a real shop):
//   ready      = the data is there;
//   reason     = a reason is missing in the agents' lists (« pas confiance », « pas ma couleur »…);
//   tags       = the videos have no tags yet (angle, first scene, person);
//   tick       = a person has to do or tick something (Pilotix cannot read it alone);
//   none       = Pilotix does not have the data (scroll, competitor prices, Meta's quality rank);
//   unverified = nobody checked yet that Pilotix keeps it (the ad's id on real orders, the bid cap, call times…).
// This step only keeps the rules: nothing is counted, blocked or rung with them yet.

export const CHECK_PARTS = ['money', 'leads', 'offer', 'video', 'landing', 'trust', 'meta', 'team'] as const;
export type CheckPart = (typeof CHECK_PARTS)[number];

export const CHECK_LEVELS = ['off', 'doctor', 'bell', 'door'] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

/** where a door stands: a price or a cost is saved, an ad is launched, a page is published, an agent's screen */
export type CheckDoor = 'price' | 'ad' | 'page' | 'agent';

/**
 * How the check's number is compared with its lines: under them, over them, « v or more », outside v…v2, lower than the
 * others by v points, or a fixed condition with no number (checks.c.<id>.when).
 */
export type CheckOp = 'lt' | 'gt' | 'gte' | 'out' | 'gap' | 'fixed';
/** x = « times the bid limit » (1.33 = a third over it); da = dinars */
export type CheckUnit = 'pct' | 'pts' | 'n' | 'days' | 'pieces' | 'of10' | 'x' | 'da';
export type CheckWaitUnit =
  | 'shown' | 'views3s' | 'comments' | 'orders' | 'parcels' | 'weeks' | 'days' | 'videos' | 'cancelled' | 'unconfirmed'
  | 'confirmed' | 'delivered' | 'leads' | 'realleads' | 'products' | 'views' | 'clicks' | 'forms' | 'units' | 'messages' | 'customers' | 'calls' | 'unreachable'
  // parcels delivered or refused at the door, parcels still with the courier, parcels sent back
  | 'decided' | 'shipping' | 'returned';
export type CheckData = 'ready' | 'reason' | 'tags' | 'tick' | 'none' | 'unverified';
/** how often Pilotix looks: every day, every week, every month, or once before an ad is launched */
export type CheckEvery = 'day' | 'week' | 'month' | 'launch';
export const CHECK_EVERY: readonly CheckEvery[] = ['day', 'week', 'month', 'launch'];

export interface CheckDef {
  /** D1…D7, Q1…Q4, O1…O20, V1…V10, L1…L12, P1…P8, M1…M13, T1…T14: the part's letter and the row of the owner's list */
  id: string;
  part: CheckPart;
  /** its first helper */
  level: Exclude<CheckLevel, 'off'>;
  /** the doors it has (none: it cannot block) */
  doors: CheckDoor[];
  every: CheckEvery;
  op: CheckOp;
  unit: CheckUnit;
  /** the « bad » line (null: a fixed condition) */
  v: number | null;
  /** the upper limit of « outside v…v2 » */
  v2: number | null;
  /** the « good » line of a KPI with four levels (null: none) */
  g: number | null;
  /** the second line, worse than `v` (null: none), and what it is */
  s: number | null;
  sKind: 'stop' | 'urgent' | null;
  /** its stop fires only when the app is sure (never on luck, never before the ad is 2 days old) */
  proof: boolean;
  /** it can switch something off: an ad, a product, a wilaya, or new products */
  stops: boolean;
  /** no verdict before this much data (none: it does not wait) */
  wait: { v: number; unit: CheckWaitUnit } | null;
  data: CheckData;
  /** the line has a condition after its number (checks.c.<id>.tail) */
  tail: boolean;
  /** it names another part to fix (checks.c.<id>.also) */
  also: boolean;
}

type Extra = { v2?: number; g?: number; s?: number; sKind?: 'stop' | 'urgent'; proof?: true; stops?: true; doors?: CheckDoor[]; wait?: [number, CheckWaitUnit]; tail?: true; also?: true };
const PART_OF: Record<string, CheckPart> = { D: 'money', Q: 'leads', O: 'offer', V: 'video', L: 'landing', P: 'trust', M: 'meta', T: 'team' };
const c = (id: string, level: CheckDef['level'], every: CheckEvery, op: CheckOp, unit: CheckUnit, v: number | null, data: CheckData, x: Extra = {}): CheckDef => ({
  id,
  part: PART_OF[id[0]],
  level,
  doors: x.doors ?? [],
  every,
  op,
  unit,
  v,
  v2: x.v2 ?? null,
  g: x.g ?? null,
  s: x.s ?? null,
  sKind: x.s === undefined ? null : (x.sKind ?? 'urgent'),
  proof: !!x.proof,
  stops: !!x.stops,
  wait: x.wait ? { v: x.wait[0], unit: x.wait[1] } : null,
  data,
  tail: !!x.tail,
  also: !!x.also,
});

/** every « reason » check waits for this many cancelled orders */
const REASONS: [number, CheckWaitUnit] = [20, 'cancelled'];

export const CHECKS: readonly CheckDef[] = [
  // ---------------------------------------------------------------- money: what a confirmed order costs in ads
  c('D1', 'bell', 'day', 'gt', 'x', 1.33, 'unverified', { g: 1, s: 1.58, sKind: 'stop', proof: true, stops: true, wait: [10, 'confirmed'], tail: true, also: true }),
  c('D7', 'bell', 'day', 'gt', 'x', 1.33, 'unverified', { stops: true, tail: true }),
  c('D2', 'doctor', 'week', 'gt', 'x', 1.9, 'unverified', { g: 1.43, wait: [20, 'delivered'] }),
  c('D3', 'doctor', 'week', 'gt', 'x', 0.8, 'unverified', { g: 0.6, wait: [20, 'leads'] }),
  c('D4', 'doctor', 'month', 'lt', 'da', 0, 'unverified', { stops: true, wait: [100, 'delivered'] }),
  c('D5', 'doctor', 'month', 'fixed', 'n', null, 'unverified'),
  c('D6', 'doctor', 'week', 'lt', 'pct', 30, 'unverified', { s: 15, sKind: 'stop', proof: true, stops: true, wait: [10, 'products'] }),
  // ---------------------------------------------------------------- leads and parcels, per ad
  c('Q1', 'bell', 'week', 'lt', 'pct', 90, 'unverified', { g: 95, s: 85, sKind: 'stop', proof: true, stops: true, wait: [30, 'leads'] }),
  c('Q2', 'bell', 'week', 'lt', 'pct', 60, 'unverified', { g: 65, s: 55, sKind: 'stop', proof: true, stops: true, wait: [30, 'realleads'], also: true }),
  c('Q3', 'bell', 'week', 'lt', 'pct', 90, 'unverified', { g: 95, s: 85, sKind: 'stop', proof: true, stops: true, wait: [30, 'parcels'] }),
  c('Q4', 'bell', 'week', 'lt', 'pct', 75, 'unverified', { g: 80, s: 70, sKind: 'stop', proof: true, stops: true, wait: [30, 'decided'], also: true }),
  // ---------------------------------------------------------------- offer = product + price + value + market
  c('O20', 'bell', 'day', 'lt', 'days', 7, 'unverified', { s: 3, sKind: 'stop', stops: true }),
  c('O1', 'doctor', 'week', 'lt', 'pct', 1, 'ready', { stops: true, tail: true, wait: [3, 'videos'] }),
  c('O2', 'doctor', 'week', 'gt', 'pct', 10, 'unverified', { s: 20, sKind: 'stop', proof: true, stops: true, wait: [30, 'delivered'] }),
  c('O3', 'doctor', 'week', 'lt', 'pct', 85, 'ready', { tail: true, also: true, wait: [100, 'leads'] }),
  c('O4', 'doctor', 'week', 'gt', 'pct', 10, 'reason', { wait: REASONS }),
  c('O5', 'doctor', 'week', 'gt', 'pct', 20, 'ready', { wait: REASONS, also: true }),
  c('O6', 'doctor', 'week', 'gt', 'pct', 15, 'ready', { wait: REASONS, also: true }),
  c('O7', 'doctor', 'week', 'gt', 'pct', 10, 'reason', { wait: REASONS, also: true }),
  c('O9', 'door', 'month', 'gt', 'pct', 105, 'ready', { doors: ['price'], wait: [10, 'units'] }),
  c('O10', 'doctor', 'week', 'gt', 'pct', 10, 'ready', { wait: REASONS, also: true }),
  c('O11', 'doctor', 'week', 'gt', 'pct', 25, 'reason', { wait: [20, 'unconfirmed'], also: true }),
  c('O12a', 'doctor', 'week', 'lt', 'pieces', 1.2, 'ready', { also: true, wait: [50, 'orders'] }),
  c('O12b', 'doctor', 'week', 'lt', 'pct', 15, 'ready', { also: true, wait: [50, 'orders'] }),
  c('O14', 'door', 'week', 'gt', 'pct', 10, 'reason', { doors: ['page'], wait: REASONS, also: true }),
  c('O15', 'doctor', 'week', 'gt', 'pct', 10, 'ready', { wait: REASONS, also: true }),
  c('O16', 'door', 'week', 'gt', 'pct', 20, 'unverified', { doors: ['page'], also: true, wait: [30, 'confirmed'] }),
  c('O17', 'doctor', 'month', 'lt', 'pct', 70, 'unverified', { tail: true, wait: [50, 'leads'] }),
  c('O18', 'doctor', 'week', 'lt', 'pct', 90, 'none', { tail: true, also: true }),
  c('O19', 'bell', 'week', 'gte', 'n', 3, 'tick', { also: true }),
  // ---------------------------------------------------------------- video
  c('V1', 'bell', 'week', 'lt', 'pct', 25, 'ready', { s: 20, wait: [1000, 'shown'] }),
  c('V2', 'bell', 'week', 'lt', 'pct', 20, 'ready', { s: 15, wait: [300, 'views3s'] }),
  c('V3', 'bell', 'week', 'lt', 'pct', 50, 'unverified', { wait: [300, 'views3s'] }),
  c('V4', 'doctor', 'week', 'lt', 'pct', 1, 'ready', { wait: [3000, 'shown'], tail: true, also: true }),
  c('V5a', 'doctor', 'week', 'gt', 'pct', 20, 'ready', { wait: [30, 'comments'] }),
  c('V5b', 'doctor', 'week', 'gt', 'pct', 20, 'reason', { wait: REASONS }),
  c('V8', 'door', 'launch', 'fixed', 'n', null, 'tags', { doors: ['ad'], also: true }),
  c('V9', 'bell', 'week', 'lt', 'pct', 70, 'ready', { wait: [2, 'weeks'], tail: true }),
  c('V10', 'bell', 'day', 'lt', 'pct', 10, 'unverified', { wait: [3, 'days'], tail: true }),
  // ---------------------------------------------------------------- landing page
  c('L11', 'bell', 'week', 'lt', 'pct', 1.5, 'ready', { s: 1, wait: [200, 'views'] }),
  c('L1', 'bell', 'day', 'lt', 'pct', 70, 'ready', { s: 60, wait: [50, 'clicks'] }),
  c('L2', 'door', 'week', 'lt', 'pct', 50, 'ready', { doors: ['page'], tail: true, wait: [200, 'views'] }),
  c('L3', 'doctor', 'week', 'lt', 'pct', 50, 'unverified', { tail: true, also: true, wait: [200, 'views'] }),
  c('L4', 'door', 'week', 'lt', 'pct', 40, 'ready', { doors: ['page'], also: true, wait: [50, 'forms'] }),
  c('L5', 'door', 'week', 'gt', 'pct', 30, 'unverified', { doors: ['page'], also: true, wait: [50, 'forms'] }),
  c('L8', 'door', 'week', 'lt', 'pct', 60, 'none', { doors: ['page'], wait: [200, 'views'] }),
  c('L9', 'door', 'month', 'lt', 'of10', 6, 'tick', { doors: ['page'] }),
  c('L12', 'bell', 'day', 'gte', 'n', 3, 'unverified', { stops: true, tail: true }),
  // ---------------------------------------------------------------- page trust and values
  c('P1', 'bell', 'month', 'lt', 'n', 8, 'ready'),
  c('P2', 'bell', 'week', 'gt', 'pct', 15, 'ready', { also: true, wait: [30, 'comments'] }),
  c('P3', 'bell', 'week', 'lt', 'pct', 80, 'unverified', { wait: [30, 'messages'] }),
  c('P4a', 'bell', 'month', 'lt', 'n', 10, 'tick'),
  c('P4b', 'bell', 'month', 'lt', 'n', 10, 'tick'),
  c('P5', 'doctor', 'week', 'gt', 'pct', 10, 'reason', { wait: REASONS }),
  c('P7', 'doctor', 'month', 'lt', 'pct', 5, 'ready', { s: 2, also: true, wait: [100, 'customers'] }),
  c('P8', 'doctor', 'week', 'fixed', 'n', null, 'none', { also: true, wait: [500, 'shown'] }),
  // ---------------------------------------------------------------- Meta
  c('M1', 'bell', 'day', 'lt', 'pct', 80, 'ready', { wait: [50, 'leads'] }),
  c('M2', 'bell', 'day', 'out', 'pct', 80, 'ready', { v2: 130, wait: [20, 'confirmed'] }),
  c('M13', 'bell', 'week', 'lt', 'of10', 6, 'unverified'),
  c('M3', 'bell', 'week', 'lt', 'n', 5, 'tags', { also: true }),
  c('M4', 'bell', 'week', 'gt', 'pct', 50, 'tags', { also: true, tail: true }),
  c('M5', 'door', 'day', 'gte', 'n', 2, 'ready', { doors: ['ad'] }),
  c('M6', 'door', 'day', 'gt', 'pct', 100, 'unverified', { doors: ['ad'] }),
  c('M7', 'bell', 'day', 'lt', 'pct', 50, 'unverified', { also: true, wait: [3, 'days'] }),
  c('M8', 'bell', 'week', 'gt', 'pct', 120, 'ready', { s: 130, also: true, wait: [10000, 'shown'] }),
  c('M11', 'bell', 'day', 'gte', 'n', 1, 'unverified'),
  c('M12', 'doctor', 'day', 'gt', 'pct', 125, 'ready', { also: true, wait: [5, 'confirmed'] }),
  // ---------------------------------------------------------------- team = confirmation + depot + delivery
  c('T14', 'bell', 'day', 'lt', 'pct', 95, 'unverified', { wait: [50, 'calls'] }),
  c('T13', 'bell', 'day', 'gap', 'pts', 10, 'unverified', { wait: [30, 'realleads'] }),
  c('T1', 'bell', 'day', 'lt', 'pct', 80, 'unverified', { wait: [30, 'leads'] }),
  c('T2', 'door', 'week', 'gt', 'pct', 20, 'ready', { doors: ['agent'], wait: [20, 'unreachable'] }),
  c('T3', 'doctor', 'week', 'gap', 'pts', 5, 'ready', { s: 10, wait: [30, 'realleads'] }),
  c('T4', 'door', 'week', 'gap', 'pts', 10, 'ready', { doors: ['agent'], wait: [30, 'decided'] }),
  c('T5', 'doctor', 'week', 'lt', 'pct', 5, 'ready', { s: 2, also: true, wait: [30, 'confirmed'] }),
  c('T6a', 'bell', 'day', 'lt', 'pct', 80, 'unverified', { wait: [20, 'forms'] }),
  c('T6b', 'bell', 'week', 'lt', 'pct', 15, 'ready', { wait: [30, 'forms'] }),
  c('T7', 'bell', 'day', 'lt', 'pct', 90, 'unverified', { wait: [20, 'confirmed'] }),
  c('T8a', 'doctor', 'week', 'gt', 'days', 3, 'unverified', { wait: [100, 'delivered'] }),
  c('T8b', 'doctor', 'week', 'gt', 'days', 5, 'unverified', { wait: [20, 'delivered'] }),
  c('T9', 'doctor', 'month', 'lt', 'pct', 60, 'ready', { s: 50, sKind: 'stop', proof: true, stops: true, also: true, wait: [30, 'parcels'] }),
  c('T10', 'bell', 'day', 'gt', 'pct', 20, 'unverified', { wait: [10, 'shipping'] }),
  c('T11', 'door', 'day', 'gte', 'n', 1, 'ready', { doors: ['agent'] }),
  c('T12', 'bell', 'week', 'lt', 'pct', 80, 'unverified', { wait: [20, 'returned'] }),
];

const BY_ID = new Map(CHECKS.map((d) => [d.id, d]));
export const checkDef = (id: string): CheckDef | undefined => BY_ID.get(id);

/** The helpers a check can be given: a door only where one stands. */
export const checkLevels = (d: CheckDef): CheckLevel[] => (d.doors.length ? ['off', 'doctor', 'bell', 'door'] : ['off', 'doctor', 'bell']);

/** The number a line may take, by what it counts (two decimals at most). */
export const CHECK_RANGE: Record<CheckUnit, { min: number; max: number; step: number }> = {
  pct: { min: 0, max: 1000, step: 0.1 },
  pts: { min: 1, max: 100, step: 1 },
  n: { min: 0, max: 1000, step: 1 },
  days: { min: 0, max: 365, step: 1 },
  pieces: { min: 1, max: 100, step: 0.1 },
  of10: { min: 0, max: 10, step: 1 },
  x: { min: 0.1, max: 20, step: 0.01 },
  da: { min: -10_000_000, max: 10_000_000, step: 1 },
};
export const CHECK_WAIT_MAX = 1_000_000;
export const CHECK_TEXT_MAX = 300;

/**
 * The lines of a check in the order they must keep, from the best to the worst: for « under » the numbers go down
 * (good 95, bad 90, stop 85), for « over » and « points below » they go up (good 1, bad 1.33, stop 1.58).
 */
export function checkLinesInOrder(d: CheckDef, g: number | null, v: number | null, s: number | null): boolean {
  const xs = [g, v, s].filter((x): x is number => x !== null);
  const down = d.op === 'lt';
  return xs.every((x, i) => i === 0 || (down ? xs[i - 1] > x : xs[i - 1] < x));
}

/** A check as the shop has it now: the owner's values where he changed them, the starting ones elsewhere. */
export interface CheckRule {
  id: string;
  v: number | null;
  v2: number | null;
  g: number | null;
  s: number | null;
  level: CheckLevel;
  wait: number | null;
  /** his own words (null: the app's text, checks.c.<id>.do / .also) */
  action: string | null;
  other: string | null;
  /** what he changed: 'v' | 'v2' | 'g' | 's' | 'level' | 'wait' | 'action' | 'other' */
  changed: string[];
}

export interface CheckOverride {
  v?: number | null;
  v2?: number | null;
  g?: number | null;
  s?: number | null;
  level?: string | null;
  wait?: number | null;
  action?: string | null;
  other?: string | null;
}

/** The check with the owner's changes on top (a value he never set, or one that is no longer allowed, stays the starting one). */
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
    g: d.g === null ? null : pick('g', o?.g, d.g),
    s: d.s === null ? null : pick('s', o?.s, d.s),
    level: pick<CheckLevel>('level', level, d.level),
    wait: d.wait ? pick('wait', o?.wait, d.wait.v) : null,
    action: pick<string | null>('action', o?.action?.trim() || null, null),
    other: pick<string | null>('other', o?.other?.trim() || null, null),
    changed,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The general settings: the numbers that belong to no single check (how long before an ad is judged, how sure the app
// must be before a stop, the budget steps, the test, the time limits…). The owner changes them in the app like a check;
// `def` null = no starting value: he fills it in (the app invents no amount for him).

export const CHECK_SETTING_GROUPS = ['judge', 'bid', 'budget', 'scale', 'test', 'time', 'freeze', 'brake', 'outside'] as const;
export type CheckSettingGroup = (typeof CHECK_SETTING_GROUPS)[number];
/** money = an amount in the ad account's currency (a daily budget); da = dinars */
export type CheckSettingUnit = 'days' | 'hours' | 'pct' | 'n' | 'orders' | 'da' | 'money';

export interface CheckSettingDef {
  key: string;
  group: CheckSettingGroup;
  def: number | null;
  min: number;
  max: number;
  unit: CheckSettingUnit;
}

const st = (key: string, group: CheckSettingGroup, def: number | null, min: number, max: number, unit: CheckSettingUnit): CheckSettingDef => ({ key, group, def, min, max, unit });

export const CHECK_SETTINGS: readonly CheckSettingDef[] = [
  // when an ad may be judged
  st('judgeDays', 'judge', 2, 0, 14, 'days'),
  st('proofPct', 'judge', 5, 1, 25, 'pct'),
  // the bid limit: what a confirmed order may cost in ads
  st('keepGood', 'bid', 40, 1, 90, 'pct'),
  st('delivered', 'bid', 70, 10, 100, 'pct'),
  st('returnCost', 'bid', 300, 0, 5000, 'da'),
  st('limitMove', 'bid', 5, 0, 50, 'pct'),
  // the budget of an ad set
  st('budgetStep', 'budget', 20, 5, 50, 'pct'),
  st('budgetCuts', 'budget', 3, 1, 10, 'n'),
  st('budgetBase', 'budget', 15, 1, 100000, 'money'),
  // SCALE
  st('groupBand', 'scale', 20, 0, 100, 'pct'),
  st('ownOrders', 'scale', 25, 1, 1000, 'orders'),
  st('batchWait', 'scale', 2, 0, 10, 'n'),
  // TEST
  st('testAds', 'test', 4, 1, 10, 'n'),
  st('winOrders', 'test', 5, 1, 100, 'orders'),
  // nothing waits forever
  st('pendingHours', 'time', 48, 1, 240, 'hours'),
  st('postponeDays', 'time', 14, 1, 60, 'days'),
  st('parcelDays', 'time', 15, 3, 60, 'days'),
  // the freeze after too many edits (how many edits: the check M5's own line)
  st('freezeDays', 'freeze', 3, 1, 14, 'days'),
  // the account brake and the daily list
  st('brakeDays', 'brake', 3, 1, 14, 'days'),
  st('listTop', 'brake', 5, 1, 20, 'n'),
  // outside the checks: the owner's own amount
  st('awarenessBudget', 'outside', null, 0, 1_000_000, 'money'),
];

const SETTING_BY_KEY = new Map(CHECK_SETTINGS.map((d) => [d.key, d]));
export const checkSettingDef = (key: string): CheckSettingDef | undefined => SETTING_BY_KEY.get(key);

/** A general setting as the shop has it now (v null: not filled in yet). */
export interface CheckSetting {
  key: string;
  v: number | null;
  changed: boolean;
}

/** The setting with the owner's value on top (a value out of its range stays the starting one). */
export function checkSetting(d: CheckSettingDef, mine: number | null | undefined): CheckSetting {
  const ok = mine !== null && mine !== undefined && isFinite(mine) && mine >= d.min && mine <= d.max;
  const v = ok ? mine : d.def;
  return { key: d.key, v, changed: v !== d.def };
}
