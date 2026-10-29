// « Pilot Auto Assign » on the screens: how an order got its company, in one short line, whether this person may change
// it by hand, and whether they write the rules (the same rules as the server: Préférences, strict rules locked).
import { personIs, type PilotRule, readPilotWhy, ruleNumber, type Session, type WhoTicks } from '@pilotix/shared';
import { useRpc } from './query';
import { useSession } from './session';

type T = (k: string, o?: Record<string, unknown>) => string;
type Prefs = { changeCompany: WhoTicks; strictLock: boolean; rulesBy?: WhoTicks };

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
  const manager = p.changeCompany.manager && personIs(s, { confirmation: false, agency: false, depot: false, manager: true });
  if (p.strictLock && o.pilotBy === 'strict') return manager;
  return s.roles.includes('suivi') || personIs(s, p.changeCompany);
}

/** Does this person write the Pilot rules? Admins, and the kinds ticked in Préférences (the menu then shows the page). */
export function useCanRules(): boolean {
  const { session } = useSession();
  const store = !session?.shop?.kind || session.shop.kind === 'store';
  const q = useRpc('prefs.get', {}, { enabled: !!session && !session.isAdmin && store, staleTime: 5 * 60_000 });
  if (!session) return false;
  if (session.isAdmin) return true;
  const by = q.data?.prefs.rulesBy;
  return !!by && personIs(session, by);
}
