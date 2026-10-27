// Sign-ups: people who signed up and did not open their e-mail yet, and the stores their owners made lately (which of
// them pay). The control room sees the e-mail and the store's name — never what is inside a store.
import { useTranslation } from 'react-i18next';
import { dateOnly, when } from '../../lib/format';
import { usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Loading } from '../../ui/kit';
import { Empty } from './bits';

export function Signups() {
  const { t } = useTranslation();
  const q = usePRpc('p.signups.list', {}, { refetchInterval: 60_000 });
  const d = usePRpc('p.dashboard', {});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const s = d.data?.signups;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.signups')}</h1>
          <p className="muted">{t('platform.su.sub')}</p>
        </div>
      </div>
      {s && (
        <p className="pp-preview">
          {t('platform.su.summary', { week: s.week, month: s.month, pending: s.pending })} {s.rate !== null && t('platform.su.rate', { rate: s.rate, paid: s.paid90, made: s.made90 })}
        </p>
      )}
      <div className="pp-grid">
        <Card title={t('platform.su.pending')} help={t('platform.su.pendingHelp')}>
          {q.data!.pending.length ? (
            <ul className="pp-mini">
              {q.data!.pending.map((p) => (
                <li key={p.id}>
                  <span className="pp-two">
                    <b>{p.store}</b>
                    <small className="muted ltr">
                      {p.name} · {p.email}
                    </small>
                  </span>
                  <span className="pp-mini-r">
                    <small className="muted">{when(p.at)}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('platform.su.noPending')}</Empty>
          )}
        </Card>
        <Card title={t('platform.su.made')}>
          {q.data!.made.length ? (
            <ul className="pp-mini">
              {q.data!.made.map((m) => (
                <li key={m.id}>
                  <a href={`#/platform/shops/${m.id}`} className="pp-two">
                    <b>{m.name}</b>
                    <small className="muted ltr">{m.status === 'deleted' ? t('platform.state.deleted') : m.email ?? ''}</small>
                  </a>
                  <span className="pp-mini-r">
                    <span className={`chip ${m.paid ? 'pp-chip-ok' : ''}`}>{m.paid ? t('platform.su.paid') : t('platform.su.trial')}</span>
                    <small className="muted">{dateOnly(m.at)}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('platform.su.noneMade')}</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
