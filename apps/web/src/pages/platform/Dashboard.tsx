// The control room's first page: how many shops pay, who is on trial, who is late, money in, what happened last.
import { useTranslation } from 'react-i18next';
import { da, dateOnly, when } from '../../lib/format';
import { POut, Staff, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Kpi, Kpis, Loading } from '../../ui/kit';
import { auditText, Empty, ShopRow, StateBadge } from './bits';

type D = POut<'p.dashboard'>;

export function Dashboard({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.dashboard', {}, { refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data as D;
  const c = d.counts;
  const late = c.grace + c.expired;
  const max = Math.max(1, ...d.revenue.byMonth.map((b) => b.amount));
  // the last 12 months, empty ones included
  const months: { month: string; amount: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    months.push({ month: m, amount: d.revenue.byMonth.find((b) => b.month === m)?.amount ?? 0 });
  }
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.hello', { name: staff.name.split(' ')[0] })}</h1>
          <p className="muted">{t('platform.dashSub')}</p>
        </div>
        {staff.role !== 'support' && (
          <a className="btn primary" href="#/platform/shops/new">
            + {t('platform.newShop')}
          </a>
        )}
      </div>
      <Kpis>
        <Kpi label={t('platform.k.active')} value={c.active} icon="checkcircle" href="#/platform/shops/f/active" sub={t('platform.k.activeSub', { count: c.total })} />
        <Kpi label={t('platform.k.trial')} value={c.trial} icon="clock" href="#/platform/shops/f/trial" tone={c.trial ? 'info' : undefined} sub={t('platform.k.newThisMonth', { count: c.newThisMonth })} />
        <Kpi label={t('platform.k.late')} value={late} icon="alert" href="#/platform/shops/f/late" tone={late ? 'bad' : undefined} sub={t('platform.k.lateSub', { grace: c.grace, expired: c.expired })} />
        <Kpi label={t('platform.k.suspended')} value={c.suspended} icon="pause" href="#/platform/shops/f/suspended" />
        <Kpi label={t('platform.k.month')} value={da(d.revenue.thisMonth)} icon="coins" sub={t('platform.k.lastMonth', { amount: da(d.revenue.lastMonth) })} />
        <Kpi label={t('platform.k.mrr')} value={da(d.mrr)} icon="chart" help={t('platform.k.mrrHelp')} />
      </Kpis>
      <div className="pp-grid">
        <ShopList title={t('platform.d.trialsEnding')} rows={d.trialsEnding} empty={t('platform.d.trialsEndingNone')} />
        <ShopList title={t('platform.d.renewSoon')} rows={d.renewSoon} empty={t('platform.d.renewSoonNone')} />
        <ShopList title={t('platform.d.late')} rows={d.late} empty={t('platform.d.lateNone')} bad />
        <Card title={t('platform.d.revenue')}>
          <div className="pp-bars" role="img" aria-label={t('platform.d.revenue')}>
            {months.map((m) => (
              <div key={m.month} className="pp-bar" title={`${m.month} · ${da(m.amount)}`}>
                <span className="pp-bar-v" style={{ height: `${Math.round((m.amount / max) * 100)}%` }} />
                <small className="ltr">{m.month.slice(5)}</small>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card title={t('platform.d.recent')} actions={staff.role !== 'support' ? <a className="btn small" href="#/platform/journal">{t('platform.d.allJournal')}</a> : undefined}>
        {d.recent.length ? (
          <ul className="pp-log">
            {d.recent.map((a) => (
              <li key={a.id}>
                <span className="muted small">{when(a.at)}</span>
                <span>
                  {a.shop && (
                    <a href={`#/platform/shops/${a.shopId}`}>
                      <b>{a.shop}</b>
                    </a>
                  )}{' '}
                  {auditText(t, a)}
                </span>
                <span className="muted small">{a.staff}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('platform.d.nothingYet')}</Empty>
        )}
      </Card>
    </div>
  );
}

function ShopList({ title, rows, empty, bad }: { title: string; rows: Omit<ShopRow, 'usage' | 'lastPaymentAt'>[]; empty: string; bad?: boolean }) {
  const { t } = useTranslation();
  return (
    <Card title={title} badge={rows.length ? <span className={`pp-count ${bad ? 'bad' : ''}`}>{rows.length}</span> : undefined}>
      {rows.length ? (
        <ul className="pp-mini">
          {rows.slice(0, 8).map((s) => (
            <li key={s.id}>
              <a href={`#/platform/shops/${s.id}`}>
                <b>{s.name}</b>
                <small className="muted">
                  {s.owner.name ?? ''}
                  {s.owner.phone ? ` · ${s.owner.phone}` : ''}
                </small>
              </a>
              <span className="pp-mini-r">
                <StateBadge state={s.state} daysLeft={s.daysLeft} />
                <small className="muted">{s.state === 'trial' ? dateOnly(s.trialEndsAt) : dateOnly(s.paidUntil ?? s.trialEndsAt)}</small>
              </span>
            </li>
          ))}
          {rows.length > 8 && <li className="muted small">{t('platform.d.more', { count: rows.length - 8 })}</li>}
        </ul>
      ) : (
        <Empty>{empty}</Empty>
      )}
    </Card>
  );
}
