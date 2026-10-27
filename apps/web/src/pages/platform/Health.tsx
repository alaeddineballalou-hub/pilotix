// Backups: the last nightly backups, the database's size and each store's (numbers only). The machine itself (disk,
// memory, jobs, e-mail settings) is in Doctor.
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { dateTime, n, when } from '../../lib/format';
import { serverHealth } from '../../lib/platform';
import { Card, ErrorBox, Kpi, Kpis, Loading } from '../../ui/kit';
import { Empty } from './bits';

/** 1 234 567 → « 1,2 Mo » */
export function bytes(v: number): string {
  if (v < 1024) return `${v} o`;
  const u = ['Ko', 'Mo', 'Go', 'To'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toLocaleString('fr-FR', { maximumFractionDigits: x < 10 ? 1 : 0 })} ${u[i]}`;
}

export function HealthPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['p-health'], queryFn: serverHealth, refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error as Error} onRetry={() => q.refetch()} />;
  const h = q.data!;
  const last = h.backups.last;
  const lastAge = last ? (Date.now() - Date.parse(last.at)) / 3_600_000 : null;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.health')}</h1>
          <p className="muted">{t('platform.h.sub')}</p>
        </div>
      </div>
      <Kpis>
        <Kpi label={t('platform.h.db')} value={bytes(h.db.total)} icon="database" sub={t('platform.h.stores', { count: h.db.shops.length })} />
        <Kpi
          label={t('platform.h.lastBackup')}
          value={last ? when(last.at) : '—'}
          icon="archive"
          tone={lastAge === null || lastAge > 30 ? 'bad' : undefined}
          sub={last ? `${bytes(last.bytes)} · ${t('platform.h.backups', { count: h.backups.count })}` : t('platform.h.noBackup')}
        />
      </Kpis>
      {lastAge !== null && lastAge > 30 && <p className="pp-warn">{t('platform.h.oldBackup')}</p>}
      <div className="pp-grid">
        <Card title={t('platform.h.byStore')} help={t('platform.h.byStoreHelp')}>
          <ul className="pp-mini">
            {h.db.shops.slice(0, 30).map((s) => (
              <li key={s.id}>
                <a href={`#/platform/shops/${s.id}`}>{s.name}</a>
                <span className="pp-mini-r ltr">{bytes(s.bytes)}</span>
              </li>
            ))}
            <li className="muted small">
              {t('platform.h.platform')} <span className="ltr">{bytes(h.db.platform)}</span>
            </li>
          </ul>
        </Card>
        <Card title={t('platform.h.recent')}>
          {h.backups.recent.length ? (
            <ul className="pp-mini">
              {h.backups.recent.map((b) => (
                <li key={b.name}>
                  <span className="ltr small">{b.name}</span>
                  <span className="pp-mini-r ltr">
                    {bytes(b.bytes)} · {dateTime(b.at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('platform.h.noBackup')}</Empty>
          )}
          <p className="small muted">{t('platform.h.server', { n: n(h.backups.count) })}</p>
        </Card>
      </div>
    </div>
  );
}
