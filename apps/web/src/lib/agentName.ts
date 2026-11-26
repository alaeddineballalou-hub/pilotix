import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { useRpc } from './query';
import { useSession } from './session';

type Who = Pick<Order, 'confAgencyId' | 'followAgencyId' | 'agentName' | 'followAgentName'>;

/**
 * Who works an order, as the screens name it. The seller and his own team never see the agents of their confirmation
 * agency (owner's rule, 26 Nov 2026): an order the agency confirms or follows shows the agency's name (« The Closer »),
 * whoever its agent is. Inside an agency (its own space, or its people's accounts in the store) its people keep their
 * names.
 */
export function useAgentName() {
  const { t } = useTranslation();
  const { session } = useSession();
  const storeSide = !!session && !session.profile.agencyId && (session.shop?.kind ?? 'store') === 'store';
  const names = useRpc('orders.agencyNames', {}, { enabled: storeSide, staleTime: 10 * 60_000, retry: false });
  const agency = (id: number) => names.data?.find((a) => a.id === id)?.name || t('agency.badge');
  return {
    /** the store's side (the agency's agents are hidden there) */
    storeSide,
    /** the agency holding the order's confirmation, for the store's side (null: its own team) */
    confAgency: (o: Pick<Order, 'confAgencyId'>) => (storeSide && o.confAgencyId ? agency(o.confAgencyId) : null),
    /** the name for the confirmation (null: nobody yet) */
    conf: (o: Who) => (storeSide && o.confAgencyId ? agency(o.confAgencyId) : (o.agentName ?? null)),
    /** the name for the suivi (null: nobody yet) */
    follow: (o: Who) => (storeSide && o.followAgencyId ? agency(o.followAgencyId) : (o.followAgentName ?? null)),
  };
}
