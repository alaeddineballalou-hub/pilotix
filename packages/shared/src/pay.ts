// Agent pay (Caisse › Paie for the seller, Ma caisse for each agent): the jobs a person is paid for, and the shop's pay
// days. A shop pays on cut days: every week (one weekday), every 15 days (the 1st and the 16th), every month (one day),
// or the days it picks. A period runs from one cut day (00:00 in Algiers) to the next; on that next cut day its money is
// « prête à payer ». Algiers is UTC+1 all year.
import { featureOn } from './features';

export const PAY_TASKS = ['confirmation', 'suivi', 'superviseur', 'depot'] as const;
export type PayTask = (typeof PAY_TASKS)[number];

/**
 * Agent pay runs in a store whose plan has Caisse › Paie. A partner's own space (a confirmation agency, a marketer) pays
 * its people its own way (Facturation, its agents' plans), so there it has no page, no action and no alert.
 */
export function payIsOn(shop: { kind?: string | null; features?: readonly string[] | null } | null | undefined): boolean {
  return (!shop?.kind || shop.kind === 'store') && featureOn(shop?.features, 'caisse/paie');
}

export type PayCalendar = { every: 'week'; weekday: number } | { every: 'half' } | { every: 'month'; day: number } | { every: 'days'; days: number[] };
export const DEFAULT_PAY_CALENDAR: PayCalendar = { every: 'month', day: 1 };

/** Acomptes: at most `max` DA a month (0 = no acompte), asked from day `fromDay` of the month. */
export interface PayAcompte {
  max: number;
  fromDay: number;
}
export const DEFAULT_PAY_ACOMPTE: PayAcompte = { max: 0, fromDay: 1 };

/** The jobs a person MUST have a pay plan for, from the roles given to them (owners and vendeurs are not paid here). */
export function payTasksOf(roles: readonly string[]): PayTask[] {
  if (roles.includes('admin') || roles.includes('vendeur')) return [];
  const out: PayTask[] = [];
  if (roles.includes('confirmation')) out.push('confirmation');
  if (roles.includes('agent_manager')) out.push('superviseur');
  if (roles.includes('suivi')) out.push('suivi');
  if (roles.includes('depot')) out.push('depot');
  return out;
}

/** The jobs a person MAY have a plan for: a supervisor may also confirm orders himself. */
export function payTasksAllowed(roles: readonly string[]): PayTask[] {
  const out = payTasksOf(roles);
  if (out.includes('superviseur') && !out.includes('confirmation')) out.unshift('confirmation');
  return out;
}

/** The role a plan's job needs. */
export const PAY_TASK_ROLE: Record<PayTask, string> = { confirmation: 'confirmation', suivi: 'suivi', superviseur: 'agent_manager', depot: 'depot' };

const H = 3_600_000;
const DAY = 24 * H;
const OFF = H;
const midnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) - OFF;

/** The days of the month a month-based calendar cuts on (sorted, 1–28); null for a weekly one. */
export function payCutDays(cal: PayCalendar): number[] | null {
  if (cal.every === 'week') return null;
  if (cal.every === 'half') return [1, 16];
  if (cal.every === 'month') return [Math.min(28, Math.max(1, Math.round(cal.day)))];
  const days = [...new Set(cal.days.map((d) => Math.min(28, Math.max(1, Math.round(d)))))].sort((a, b) => a - b);
  return days.length ? days : [1];
}

/** The pay period holding the moment t (ms): [from, to), both at 00:00 in Algiers. */
export function payPeriodAt(cal: PayCalendar, t: number): { from: number; to: number } {
  const local = new Date(t + OFF);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  if (cal.every === 'week') {
    const w = ((Math.round(cal.weekday) % 7) + 7) % 7;
    const back = (local.getUTCDay() - w + 7) % 7;
    const from = midnight(y, m, local.getUTCDate() - back);
    return { from, to: from + 7 * DAY };
  }
  const days = payCutDays(cal)!;
  const cuts: number[] = [];
  for (const k of [-1, 0, 1]) for (const d of days) cuts.push(midnight(y, m + k, d));
  cuts.sort((a, b) => a - b);
  let from = cuts[0];
  let to = cuts[cuts.length - 1];
  for (const c of cuts) if (c <= t) from = c;
  for (const c of [...cuts].reverse()) if (c > t) to = c;
  return { from, to };
}

/** Every period from the one holding `start` to the one holding `end` (both included), oldest first. */
export function payPeriods(cal: PayCalendar, start: number, end: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let p = payPeriodAt(cal, start);
  while (p.from <= end && out.length < 600) {
    out.push(p);
    p = payPeriodAt(cal, p.to);
  }
  return out;
}

/** Day of the month in Algiers (1–31). */
export const payLocalDay = (t: number) => new Date(t + OFF).getUTCDate();
/** Start of the calendar month (Algiers) holding t. */
export function payMonthStart(t: number): number {
  const local = new Date(t + OFF);
  return midnight(local.getUTCFullYear(), local.getUTCMonth(), 1);
}
