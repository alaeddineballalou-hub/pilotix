// « Pilot Auto Assign » on the order screens: how an order got its company, in one short line, and whether this person
// may change it by hand (the same rule as the server: Préférences, strict rules locked).
import { type PilotRule, readPilotWhy, ruleNumber, type Session } from '@pilotix/shared';

type T = (k: string, o?: Record<string, unknown>) => string;
type Prefs = { changeCompany: { confirmation: boolean; agency: boolean; depot: boolean; manager: boolean }; strictLock: boolean };

/** Why an order waits for a person (« À attribuer »), or null. */
export function waitWhy(t: T, why: string | null | undefined): string | null {
  const w = readPilotWhy(why);
  if (!w) return null;
  if (w.kind === 'conflict') return t('pilot.why.conflict', { a: w.a, b: w.b });
  return t(`pilot.why.${w.kind}`);
}

/** « Pilot · règle 3 », « société par défaut », « choisie à la main »… (null: nothing known) */
export function pilotLine(t: T, o: { by?: string | null; rule?: string | null; why?: string | null }, rules: PilotRule[]): string | null {
  switch (o.by) {
    case 'rule':
    case 'strict': {
      const n = ruleNumber(rules, o.rule);
      return n ? t(o.by === 'strict' ? 'pilot.by.strict' : 'pilot.by.rule', { n }) : t('pilot.by.ruleGone');
    }
    case 'default':
    case 'hand':
    case 'bureau':
    case 'backup':
      return t(`pilot.by.${o.by}`);
    case 'none':
      return waitWhy(t, o.why) ?? t('pilot.by.none');
    default:
      return null;
  }
}

/** May this person change the order's company by hand? Choosing one for an order that has none always is. */
export function mayChangeCompany(s: Session | null, p: Prefs | undefined, o: { companyId: number | null; pilotBy?: string | null }): boolean {
  if (!s) return false;
  if (s.isAdmin || !o.companyId) return true;
  if (!p) return false;
  const manager = !!s.profile.canAssign && p.changeCompany.manager;
  if (p.strictLock && o.pilotBy === 'strict') return manager;
  const agency = s.profile.agencyId != null;
  return manager || s.roles.includes('suivi') || (s.roles.includes('depot') && p.changeCompany.depot) || (s.roles.includes('confirmation') && (agency ? p.changeCompany.agency : p.changeCompany.confirmation));
}
