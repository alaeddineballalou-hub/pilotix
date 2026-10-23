import { CONF_DONE_BAD, CONF_TODO, FOLLOW_ON_ROAD } from '@pilotix/shared';
import { useMemo } from 'react';
import { useRpc } from '../../lib/query';

/** The orders at each stage: Confirmation (to call), Dépôt, Suivi, Livré, Annulé (cancelled + coming back). */
export function useCounts() {
  const q = useRpc('orders.counts', {}, { refetchInterval: 60_000 });
  return useMemo(() => {
    const c = q.data;
    if (!c) return null;
    const sum = (o: Record<string, number>, keys: readonly string[]) => keys.reduce((s, k) => s + (o[k] ?? 0), 0);
    const cancelledConf = sum(c.conf, CONF_DONE_BAD);
    const back = sum(c.follow, ['returning', 'returned']);
    return {
      raw: c,
      todo: sum(c.conf, CONF_TODO),
      depot: sum(c.follow, ['to_prepare', 'prepared']),
      suivi: sum(c.follow, FOLLOW_ON_ROAD),
      delivered: c.follow.delivered ?? 0,
      all: c.all,
      cancelledConf,
      back,
      returning: c.follow.returning ?? 0,
    };
  }, [q.data]);
}
