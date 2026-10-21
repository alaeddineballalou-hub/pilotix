import type { OrderStatus } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';

const P = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.split('|').map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

export const Icon = {
  dashboard: () => P('M3 3h7v9H3z|M14 3h7v5h-7z|M14 12h7v9h-7z|M3 16h7v5H3z'),
  orders: () => P('M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z|M3 6h18|M16 10a4 4 0 0 1-8 0'),
  products: () => P('M21 8 12 3 3 8l9 5 9-5z|M3 8v8l9 5 9-5V8|M12 13v8'),
  team: () => P('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8|M22 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75'),
  settings: () => P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
  logout: () => P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9'),
  menu: () => P('M3 6h18|M3 12h18|M3 18h18'),
  phone: () => P('M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z'),
  message: () => P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'),
  plus: () => P('M12 5v14|M5 12h14'),
  close: () => P('M18 6 6 18|M6 6l12 12'),
};

const tone: Record<OrderStatus, string> = {
  new: 't-info',
  confirmed: 't-ok',
  callback: 't-warn',
  no_answer: 't-warn',
  postponed: 't-warn',
  cancelled: 't-bad',
  duplicate: 't-off',
  assigned: 't-info',
  shipped: 't-info',
  delivered: 't-ok',
  returning: 't-bad',
  returned: 't-bad',
};

export function StatusPill({ status }: { status: OrderStatus }) {
  const { t } = useTranslation();
  return <span className={`pill ${tone[status]}`}>{t(`status.${status}`)}</span>;
}

export function Loading() {
  const { t } = useTranslation();
  return <div className="loading">{t('common.loading')}</div>;
}

export function ErrorBox({ onRetry }: { onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="empty">
      <p>{t('common.error')}</p>
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
