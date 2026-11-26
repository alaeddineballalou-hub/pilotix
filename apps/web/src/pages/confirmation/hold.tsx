// One order = one agent: an order opened in Confirmation (a list's row, the phone card, « Commande suivante ») is kept
// for this agent 10 minutes (confirmation.hold), renewed while it stays open, given back when it closes.
// Another agent has it: the name comes back, the card says so, and the server refuses his clicks (setConf). Whoever is
// above the agents (useMayOverrideHold) is told the name too, and may still change it.
import { CONF_TODO, Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentName } from '../../lib/agentName';
import { rpc } from '../../lib/backend';
import { useScope } from '../../lib/seller';
import { useSession } from '../../lib/session';

const RENEW_MS = 4 * 60_000;

/** The name of the agent who has this order, when it is not me (null: it is mine, or nobody holds it). */
export function useHold(order: Order): string | null {
  const { has, me } = useSession();
  const seller = useScope();
  const can = has('confirmation') && CONF_TODO.includes(order.confStatus);
  // what the list already knew (shown at once, before the answer)
  const known = order.lockedBy && order.lockedBy.id !== me ? order.lockedBy.name : null;
  const [by, setBy] = useState<string | null>(known);
  useEffect(() => {
    if (!can) return;
    let mine = false;
    let gone = false;
    const take = () =>
      rpc('confirmation.hold', { id: order.id }, seller)
        .then((r) => {
          if (gone) {
            if (r.ok) rpc('confirmation.release', { id: order.id }, seller).catch(() => {});
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
      if (mine) rpc('confirmation.release', { id: order.id }, seller).catch(() => {});
    };
  }, [order.id, can, seller]);
  return can ? by : null;
}

/**
 * May I still change an order another agent has open (to unblock it)? Whoever is above the agents: a store's owner,
 * administrators and agent managers; in an agency's space (AgentView) its chief and its chefs d'équipe. The same rule
 * as the server's (orders.ts: mayOverrideHold; agencyscope.ts: agencyLead). Only a plain agent just looks at it.
 */
export function useMayOverrideHold(): boolean {
  const { session, has } = useSession();
  return has('agent_manager', 'vendeur') || !!session?.profile.agencyLead;
}

/** In a list: « 🔒 Samira » next to the customer, when another agent has the order open (the store's side: the agency's
 *  name, never its agent's — owner's rule, 26 Nov 2026). */
export function HeldChip({ o }: { o: Pick<Order, 'lockedBy' | 'confAgencyId'> }) {
  const { me } = useSession();
  const mgr = useMayOverrideHold();
  const who = useAgentName();
  const { t } = useTranslation();
  if (!o.lockedBy || o.lockedBy.id === me) return null;
  const name = who.confAgency(o) ?? (o.lockedBy.name || '?');
  return (
    <span className="badge t-warn px-held" title={t(mgr ? 'confirmation.hold.mgr' : 'confirmation.hold.by', { name })}>
      {t('confirmation.hold.chip', { name })}
    </span>
  );
}
