import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { SellerScope, setSeller } from '../../lib/seller';
import { useSellers } from '../../lib/sellers';
import { Empty } from '../../ui/kit';

export type TicketRowScope = Out<'sav.list'>['rows'][number] & { seller?: { id: number; name: string } };
export const ticketKey = (ticket: TicketRowScope) => `${ticket.seller?.id ?? 0}:${ticket.id}`;

export function TicketScope({ seller, children }: { seller?: TicketRowScope['seller']; children: ReactNode }) {
  return seller ? <SellerScope seller={seller.id}>{children}</SellerScope> : <>{children}</>;
}

export function ChooseSavSeller() {
  const { t } = useTranslation();
  const work = useSellers();
  return <Empty>{t('agency.alerts.pickSav')}
    {work.list.filter((item) => item.tasks.includes('sav')).map((item) => (
      <button key={item.id} type="button" className="btn" onClick={() => setSeller(item.id)}>{item.name}</button>
    ))}
  </Empty>;
}
