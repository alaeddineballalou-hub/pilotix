import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { Icon } from './kit';

/**
 * A customer's number, or « Numéro caché »: 3 days after an order is over, only the seller and the admins see it (owner,
 * 25 Nov 2026; the server leaves it out: packages/core/src/modules/oldphones.ts).
 */
export function PhoneOf({ o, small, className = '' }: { o: Pick<Order, 'phone' | 'phoneHidden'>; small?: boolean; className?: string }) {
  const { t } = useTranslation();
  if (o.phoneHidden)
    return (
      <span className={`px-ph-hid ${className}`} title={t('orders.phoneHiddenS')}>
        <Icon name="lock" />
        {t('orders.phoneHidden')}
      </span>
    );
  return small ? <small className={`ltr ${className}`}>{o.phone}</small> : <span className={`ltr ${className}`}>{o.phone}</span>;
}
