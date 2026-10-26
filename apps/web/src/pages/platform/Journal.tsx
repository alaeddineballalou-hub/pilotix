// The journal: every action taken in the control room (who, when, on which shop).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime } from '../../lib/format';
import { prpc, usePRpc } from '../../lib/platform';
import { ErrorBox, Loading } from '../../ui/kit';
import { AuditRow, auditText, Empty } from './bits';

export function Journal() {
  const { t } = useTranslation();
  const q = usePRpc('p.audit.list', { limit: 80 });
  const [more, setMore] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [end, setEnd] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const rows = [...(q.data ?? []), ...more];
  const loadMore = async () => {
    setBusy(true);
    try {
      const next = await prpc('p.audit.list', { limit: 80, before: rows[rows.length - 1]?.id });
      if (next.length < 80) setEnd(true);
      setMore((m) => [...m, ...next]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.journal')}</h1>
          <p className="muted">{t('platform.journalSub')}</p>
        </div>
      </div>
      <div className="card">
        {rows.length ? (
          <ul className="pp-log pp-log-full">
            {rows.map((a) => (
              <li key={a.id}>
                <span className="muted small">{dateTime(a.at)}</span>
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
        {rows.length >= 80 && !end && (
          <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
            <button type="button" className="btn" disabled={busy} onClick={loadMore}>
              {t('platform.more')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
