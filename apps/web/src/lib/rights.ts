// Utilisateurs › Rôles: the person's rights in this boutique (packages/shared/src/rights.ts), kept here like the shop's
// plan (lib/features.ts) so the menu, the router, the tab bars and the buttons can ask without passing the session
// around. Set by the session (lib/session.tsx). The server checks them too: hiding is for the eyes.
import { isRightId, tabRight } from '@pilotix/shared';
import { useMemo } from 'react';
import { useSession } from './session';

/** null: no limits from rights (an administrator, a partner's own space, not known yet) */
let mine: Set<string> | null = null;

export function setRights(list: readonly string[] | null | undefined) {
  mine = list ? new Set(list) : null;
}

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
