// "Agents en ligne": En appel / En ligne / Hors ligne, from the heartbeat (users presence) and today's calls.
import { useTranslation } from 'react-i18next';
import { dur } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { ErrorBox, Loading } from '../../ui/kit';

const ago = (iso: string | null, t: (k: string, o?: any) => string) => {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return ms < 60_000 ? t('dashboard.pres.justNow') : t('dashboard.pres.ago', { d: dur(ms) });
};

export function Presence({ showTeam = true }: { showTeam?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('stats.presence', {}, { refetchInterval: 30_000 });
  const d = q.data;
  const time = d ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Algiers' }).format(Date.parse(d.at)) : '';
  return (
    <section className="card bjt-pres">
      <div className="card-head">
        <h2>{t('dashboard.pres.title')}</h2>
        {d && (
          <div className="row">
            <span className="badge t-ok">● {t('dashboard.pres.online', { n: d.online })}{d.inCall ? t('dashboard.pres.inCall', { n: d.inCall }) : ''}</span>
            <span className="badge t-warn">● {t('dashboard.pres.idle', { count: d.idle })}</span>
            <span className="badge t-off">● {t('dashboard.pres.offline', { n: d.offline })}</span>
            <span className="muted small">{t('dashboard.pres.updated', { t: time })}</span>
          </div>
        )}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d?.agents.length ? (
        <p className="muted">{t('dashboard.pres.none')}</p>
      ) : (
        <div className="bjt-pgrid">
          {d.agents.map((a) => {
            const k = a.presence === 'online' ? 'on' : a.presence === 'offline' ? 'off' : a.presence;
            const calls = t('dashboard.pres.calls', { count: a.callsToday });
            const lastCall = a.lastCallAt ? t('dashboard.pres.lastCall', { a: ago(a.lastCallAt, t) }) : t('dashboard.pres.noCall');
            const detail =
              a.presence === 'call'
                ? [a.orderRef ? t('dashboard.pres.order', { ref: a.orderRef }) : null, calls, a.lastCallAt ? t('dashboard.pres.last', { a: ago(a.lastCallAt, t) }) : null]
                : a.presence === 'offline'
                  ? [a.lastSeenAt ? t('dashboard.pres.seen', { a: ago(a.lastSeenAt, t) }) : t('dashboard.pres.never'), calls]
                  : [lastCall, calls];
            return (
              <div key={a.id} className={`bjt-pa ${k}`}>
                <span className={`bjt-dot ${k}`} aria-hidden="true" />
                <div className="bjt-pi">
                  <b>{a.name}</b>
                  <span className="bjt-ps">{t(`dashboard.pres.state.${a.presence}`)}</span>
                  <small>{detail.filter(Boolean).join(' · ')}</small>
                  {showTeam && a.team && <small className="bjt-pt">{a.team}</small>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
