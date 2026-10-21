import { useRpc } from '../../lib/query';

const STAFF = ['admin', 'vendeur', 'agent_manager', 'confirmation', 'suivi', 'depot'];

/** People who can be responsible for a ticket (the original lists the office team). */
export function useStaff() {
  const users = useRpc('users.list', { activeOnly: true }).data ?? [];
  return users.filter((u) => u.roles.some((r: string) => STAFF.includes(r)));
}
