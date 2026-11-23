import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';

const STAFF = ['admin', 'vendeur', 'agent_manager', 'confirmation', 'suivi', 'depot'];

/** People who can be responsible for a ticket (the original lists the office team). */
export function useStaff() {
  const users = useRpc('users.list', { activeOnly: true }).data ?? [];
  const { session } = useSession();
  return users.filter((u) => session?.shop?.kind === 'agency' ? u.roles.includes('sav') : u.roles.some((r) => STAFF.includes(r)));
}
