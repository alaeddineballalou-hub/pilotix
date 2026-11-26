// Suivi › Réglages › « Quand une alerte commence » (the owner, 26 Nov 2026: design 1 « Cartes », one choice for every
// delivery company, « À la 2e tentative » the advised one). Each company has its own words: Pilotix sorts each status it
// reads into a failed try (with its number when the company gives one: ZR « Ne répond pas 2 », E-COM « Ne réponde pas
// #2 », Procolis « Appel sans réponse 2 »; else Pilotix counts them), the customer's cancel, or a problem to fix
// (« Commune erronée », « Bloqué », « Suspendu »…). The parcel becomes an alert at the try the shop chose, or only at the
// cancel; a cancel always makes one; a problem goes to Suivi › Erreurs (or with the alerts, if the shop chose so). A status
// that is none of these (« Sortie en livraison », « Reportée », « Rendez-vous client »…) never makes an alert, whatever was
// ticked before in « Alertes du Suivi » (the owner, 26 Nov 2026: « never ever » an alert for a parcel out for delivery).
// Only ZR's words were read on a real account (26 Nov 2026); the others come from each adapter's statuses.
import type { FollowStatus } from '@pilotix/shared';

export const ALERT_STARTS = ['t1', 't2', 't3', 'cancel'] as const;
export type AlertStart = (typeof ALERT_STARTS)[number];
export const PROBLEMS_GO = ['errors', 'alert'] as const;
export type ProblemsGo = (typeof PROBLEMS_GO)[number];
/** the failed try at which an alert starts (null: only when the customer cancels) */
export const START_TRY: Record<AlertStart, number | null> = { t1: 1, t2: 2, t3: 3, cancel: null };
/** an alert that is a problem to fix (Suivi › Erreurs) */
export const SUB_ERREUR = 'alert_erreur';

export type CourierEvent = { kind: 'try'; n: number | null } | { kind: 'cancel' } | { kind: 'problem' };

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** a failed try with its number, in the company's own words */
const NUMBERED_TRY = [/ne repond(?:e)? pas\s*#?\s*(\d+)/, /appel sans reponse\s*#?\s*(\d+)/, /tentative\s*#?\s*(\d+)\s*(?:echouee|ratee)/];
/** the customer said no: « Commande annulée » (ZR), « Annuler par le client », « Annuler x3 », « Annulé »… */
const CANCEL = [/\bcommande annulee\b/, /\bannul/, /\bretour demande/];
/** a problem to fix before the parcel can be delivered (the company's « alert » statuses count too, below) */
const PROBLEM = [/\bcommune erronee\b/, /\bwilaya erronee\b/, /\battend(?:re)? information\b/];

/**
 * What a company's status says. `plain`: what the status means by itself for its company (its adapter's meaning and the
 * shop's own mapping, without the statuses once ticked to go to Alertes): a status that means « failed » is a try, one
 * that means « alert » is a problem.
 */
export function courierEvent(status: string | null | undefined, plain: FollowStatus | null | undefined): CourierEvent | null {
  const s = norm(status ?? '');
  if (!s) return null;
  for (const re of NUMBERED_TRY) {
    const m = s.match(re);
    if (m) return { kind: 'try', n: Math.max(1, Number(m[1]) || 1) };
  }
  if (CANCEL.some((re) => re.test(s))) return { kind: 'cancel' };
  if (PROBLEM.some((re) => re.test(s))) return { kind: 'problem' };
  if (plain === 'failed') return { kind: 'try', n: null };
  if (plain === 'alert') return { kind: 'problem' };
  return null;
}

/** where the parcel is still on its way to the customer: the only place the choice decides */
const ON_WAY: readonly (FollowStatus | null | undefined)[] = [undefined, 'shipped', 'out_for_delivery', 'failed', 'alert'];

export interface AlertDecision {
  to: FollowStatus | null | undefined;
  /** an alert that is a problem to fix (Suivi › Erreurs) */
  problem: boolean;
  /** the failed try this status is (counted by Pilotix when the company does not number it), else null */
  tryN: number | null;
  event: CourierEvent | null;
}

/**
 * What a company's status does with the shop's choice. `to`: what Pilotix had decided (the company's own mapping, the
 * statuses ticked for Alertes, ZR's situations); `plain`: what the status means by itself (none of those); `seen`: the
 * failed tries Pilotix already counted on this parcel (companies that do not number them); `fresh`: the company says
 * something new (not the same status read again).
 */
export function decideAlert(i: {
  to: FollowStatus | null | undefined;
  plain: FollowStatus | null | undefined;
  status: string;
  start: AlertStart;
  problems: ProblemsGo;
  seen: number;
  fresh: boolean;
}): AlertDecision {
  const same: AlertDecision = { to: i.to, problem: false, tryN: null, event: null };
  // an end, a return, an exchange, a status before the company has it: as before
  if (!ON_WAY.includes(i.to) || !ON_WAY.includes(i.plain)) return same;
  const event = courierEvent(i.status, i.plain);
  // what the parcel is when it is not an alert (an alert by the company's own words is a problem, above)
  const notAlert = i.to === 'alert' ? (i.plain === 'alert' ? undefined : i.plain) : i.to;
  if (!event) return { ...same, to: notAlert };
  if (event.kind === 'cancel') return { to: 'alert', problem: false, tryN: null, event };
  if (event.kind === 'problem') return { to: 'alert', problem: i.problems === 'errors', tryN: null, event };
  const n = event.n ?? (i.fresh ? i.seen + 1 : Math.max(i.seen, 1));
  const need = START_TRY[i.start];
  if (need !== null && n >= need) return { to: 'alert', problem: false, tryN: n, event };
  return { to: notAlert, problem: false, tryN: n, event };
}

/** « 1re », « 2e », « 3e »… */
export const ordinalFr = (n: number) => (n === 1 ? '1re' : `${n}e`);
