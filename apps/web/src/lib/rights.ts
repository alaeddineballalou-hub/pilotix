// Utilisateurs › Rôles: the person's rights in this boutique (packages/shared/src/rights.ts), kept here like the shop's
// plan (lib/features.ts) so the menu, the router, the tab bars and the buttons can ask without passing the session
// around. Set by the session (lib/session.tsx). The server checks them too: hiding is for the eyes.
import { isRightId, type Role, ROLE_INCLUDES, tabRight } from '@pilotix/shared';
import { useMemo } from 'react';
import { useSession } from './session';

/** null: no limits from rights (an administrator, a partner's own space, not known yet) */
let mine: Set<string> | null = null;

export function setRights(list: readonly string[] | null | undefined) {
  mine = list ? new Set(list) : null;
}

/** The person's roles: all of them (with what each includes, as the session has them) and the ones she was given. */
let given: { all: readonly Role[]; own: readonly Role[] } | null = null;

export function setOwnRoles(all: readonly Role[] | null | undefined, own: readonly Role[] | null | undefined) {
  given = all && own ? { all, own } : null;
}

/**
 * The roles given, from all of them: the person's own (her session), else a role's preview (Utilisateurs › Rôles: one
 * role with what it includes). A community manager's role includes Confirmation (26 Nov 2026): her menu's own lines
 * still tell her from a confirmation agent who is also a community manager.
 */
export const ownRoles = (all: readonly Role[]): readonly Role[] =>
  given && given.all === all ? given.own : all.filter((x) => !all.some((y) => y !== x && (ROLE_INCLUDES[y] ?? []).includes(x)));

/** Has the person this right? A right Pilotix does not list, or no rights known: yes. */
export const rightOn = (id: string | null | undefined) => !id || !mine || !isRightId(id) || mine.has(id);

/** This tab of this page (as the address names it). */
export const tabOn = (page: string, sub: string | undefined | null) => rightOn(tabRight(page, sub));

/** The same, for a component: re-drawn with the session. */
export function useRight(): (id: string) => boolean {
  const { session } = useSession();
  const list = session?.rights;
  return useMemo(() => {
    const set = list ? new Set(list) : null;
    return (id: string) => !set || !isRightId(id) || set.has(id);
  }, [list]);
}
