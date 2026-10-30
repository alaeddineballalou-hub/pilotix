// One order = one agent: an order opened in Confirmation (a list's row, the phone card, « Commande suivante ») is kept
// for this agent 10 minutes (confirmation.hold), renewed while it stays open, given back when it closes.
// Another agent has it: the name comes back, the card says so, and the server refuses his clicks (setConf).
import { CONF_TODO, Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useSession } from '../../lib/session';

const RENEW_MS = 4 * 60_000;

/** The name of the agent who has this order, when it is not me (null: it is mine, or nobody holds it). */
export function useHold(order: Order): string | null {
  const { has, me } = useSession();
  const can = has('confirmation') && CONF_TODO.includes(order.confStatus);
  // what the list already knew (shown at once, before the answer)
  const known = order.lockedBy && order.lockedBy.id !== me ? order.lockedBy.name : null;
  const [by, setBy] = useState<string | null>(known);
  useEffect(() => {
    if (!can) return;
    let mine = false;
    let gone = false;
    const take = () =>
      rpc('confirmation.hold', { id: order.id })
        .then((r) => {
          if (gone) {
            if (r.ok) rpc('confirmation.release', { id: order.id }).catch(() => {});
            return;
          }
          mine = r.ok;
          setBy(r.ok ? null : r.by ?? '');
        })
        .catch(() => {});
    take();
    const tm = setInterval(take, RENEW_MS);
    return () => {
      gone = true;
      clearInterval(tm);
      if (mine) rpc('confirmation.release', { id: order.id }).catch(() => {});
    };
  }, [order.id, can]); // eslint-disable-line react-hooks/exhaustive-deps
  return can ? by : null;
}

/** In a list: « 🔒 Samira » next to the customer, when another agent has the order open. */
export function HeldChip({ o }: { o: Pick<Order, 'lockedBy'> }) {
  const { me } = useSession();
  const { t } = useTranslation();
  if (!o.lockedBy || o.lockedBy.id === me) return null;
  const name = o.lockedBy.name || '?';
  return (
    <span className="badge t-warn px-held" title={t('confirmation.hold.by', { name })}>
      {t('confirmation.hold.chip', { name })}
    </span>
  );
}
