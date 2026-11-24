import { CONF_DONE_BAD, CONF_TODO, FOLLOW_ON_ROAD } from '@pilotix/shared';
import { useMemo } from 'react';
import { useRpc } from '../../lib/query';

/**
 * The orders at each stage: Confirmation (to call), Dépôt, Suivi, Livré, Annulé (cancelled + coming back). Dépôt, Suivi,
 * Toutes les commandes, Livré and Annulé count the orders the person's lists show (`lists`: each one his own, an agent
 * manager his team's); Confirmation, the person's calls to make. A server older than `lists`: the shop's numbers.
 */
export function useCounts() {
  const q = useRpc('orders.counts', {}, { refetchInterval: 60_000 });
  return useMemo(() => {
    const c = q.data;
    if (!c) return null;
    const sum = (o: Record<string, number>, keys: readonly string[]) => keys.reduce((s, k) => s + (o[k] ?? 0), 0);
    const l = c.lists as typeof c.lists | undefined;
    const cancelledConf = l ? l.cancelledConf : sum(c.conf, CONF_DONE_BAD);
    const back = l ? l.returning + l.returned : sum(c.follow, ['returning', 'returned']);
    return {
      raw: c,
      /** the orders of each delivery status (Toutes les commandes' tabs), in the person's lists */
      follow: (l ? l.follow : c.follow) as Record<string, number>,
      todo: sum(c.conf, CONF_TODO),
      depot: l ? l.depot : sum(c.follow, ['to_prepare', 'prepared']),
      suivi: l ? l.road : sum(c.follow, FOLLOW_ON_ROAD),
      delivered: l ? l.delivered : c.follow.delivered ?? 0,
      all: l ? l.all : c.all,
      cancelledConf,
      back,
      returning: l ? l.returning : c.follow.returning ?? 0,
    };
  }, [q.data]);
}
