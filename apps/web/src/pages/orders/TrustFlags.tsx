import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';

/** The customer's trust from their parcels: refusals, stop-desk only, look-alike of a refuser. */
export function TrustFlags({ o }: { o: Order }) {
  const { t } = useTranslation();
  if (o.blacklisted) return null;
  return (
    <>
      {o.customerStopdeskOnly ? (
        <span className="flag" title={t('orders.flag.stopdeskHint')}>{t('orders.flag.stopdesk')}</span>
      ) : o.customerRefusals ? (
        <span className="flag dup">{t('orders.flag.refused', { n: o.customerRefusals })}</span>
      ) : null}
      {o.looksLikePhone && (
        <span className="flag dup" title={t('orders.flag.lookHint', { phone: o.looksLikePhone })}>{t('orders.flag.look')}</span>
      )}
    </>
  );
}
