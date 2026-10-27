// A confirmation agency's sellers (the picker at the top of its space) and the work they give it.
import type { AgencyTask } from '@pilotix/shared';
import { useRpcFor } from './query';
import { useSeller } from './seller';

/** The person's sellers, the one chosen (null: all of them), and the tasks there (all of them: any seller's). */
export function useSellers(enabled = true) {
  const seller = useSeller();
  const q = useRpcFor(null, 'agency.sellers', {}, { staleTime: 60_000, refetchInterval: 120_000, enabled });
  const list = q.data ?? [];
  const one = seller === 'all' ? null : (list.find((s) => s.id === seller) ?? null);
  const tasks = new Set<AgencyTask>((one ? [one] : list).flatMap((s) => s.tasks));
  return { seller, list, one, tasks, loaded: !!q.data };
}
