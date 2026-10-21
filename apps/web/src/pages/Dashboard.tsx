import { Language, ORDER_STATUSES } from '@pilotix/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ErrorBox, Loading, StatusPill } from '../components/ui';
import { api } from '../lib/api';
import { formatDZD } from '../lib/i18n';

export function Dashboard() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Language;
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorBox onRetry={() => q.refetch()} />;
  const d = q.data;
  const max = Math.max(1, ...Object.values(d.byStatus).map((n) => n ?? 0));
  const pct = (x: number) => `${Math.round(x * 100)} %`;

  return (
    <>
      <h2>{t('dashboard.today')}</h2>
      <div className="kpis">
        <Kpi label={t('dashboard.created')} value={d.today.created} />
        <Kpi label={t('dashboard.confirmed')} value={d.today.confirmed} />
        <Kpi label={t('dashboard.delivered')} value={d.today.delivered} />
        <Kpi label={t('dashboard.returned')} value={d.today.returned} />
      </div>
      <div className="kpis">
        <Kpi label={t('dashboard.confirmationRate')} value={pct(d.confirmationRate)} />
        <Kpi label={t('dashboard.deliveryRate')} value={pct(d.deliveryRate)} />
        <Kpi label={t('dashboard.revenue')} value={formatDZD(d.revenueDelivered, lang)} />
      </div>
      <section className="card">
        <h2>{t('dashboard.byStatus')}</h2>
        <div className="bars">
          {ORDER_STATUSES.filter((s) => d.byStatus[s]).map((s) => (
            <div className="bar" key={s}>
              <StatusPill status={s} />
              <i style={{ width: `${((d.byStatus[s] ?? 0) / max) * 100}%` }} />
              <b className="num ltr">{d.byStatus[s]}</b>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kpi">
      <span className="l">{label}</span>
      <span className="v ltr">{value}</span>
    </div>
  );
}
