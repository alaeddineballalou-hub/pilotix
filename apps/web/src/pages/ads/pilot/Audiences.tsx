// « Audiences »: the shop's own customers as Meta audiences. Left out of the ads: who returned a parcel, who gave a
// fake order; optional: the delivered customers, and people who look like them (a lookalike, 100 customers at least).
// Nothing goes to Meta before the owner turns one on; the phones are hashed on the server (SHA-256) before they leave.
import { useTranslation } from 'react-i18next';
import { n, since } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { ErrorBox, Icon, Loading } from '../../../ui/kit';

const ICON: Record<string, string> = { returners: 'undo', fake: 'ban', buyers: 'checkcircle', lookalike: 'users' };

export function Audiences() {
  const { t } = useTranslation();
  const q = useRpc('ads.aud.list', {});
  const save = useAction('ads.aud.save', { success: t('pilotads.aud.saved') });
  const sync = useAction('ads.aud.sync', { success: t('pilotads.aud.synced') });
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  return (
    <div className="pa-aud">
      <section className="card pa-aud-head">
        <div>
          <h2>{t('pilotads.aud.title')}</h2>
          <p className="muted">{t('pilotads.aud.sub')}</p>
        </div>
        {d.owner && (
          <button type="button" className="btn" disabled={sync.isPending || !d.list.some((a) => a.on)} onClick={() => sync.mutate({})}>
            <Icon name="refresh" /> {t('pilotads.aud.sync')}
          </button>
        )}
      </section>
      <div className="pa-aud-grid">
        {d.list.map((a) => (
          <article key={a.kind} className={`card pa-aud-card ${a.on ? 'on' : ''}`}>
            <header>
              <span className="pa-aud-ico">
                <Icon name={ICON[a.kind] ?? 'users'} />
              </span>
              <div>
                <h3>{t(`pilotads.aud.${a.kind}.name`)}</h3>
                <span className={`badge t-${a.kind === 'lookalike' || a.kind === 'buyers' ? 'mid' : 'bad'}`}>{t(a.kind === 'lookalike' ? 'pilotads.aud.include' : 'pilotads.aud.exclude')}</span>
                {a.recommended && <span className="badge t-ok">{t('pilotads.aud.recommended')}</span>}
              </div>
              <label className="pa-switch" title={d.owner ? '' : t('pilotads.pilot.ownerOnly')}>
                <input type="checkbox" role="switch" checked={a.on} disabled={!d.owner || save.isPending} onChange={(e) => save.mutate({ kind: a.kind, on: e.target.checked })} aria-label={t(`pilotads.aud.${a.kind}.name`)} />
                <i aria-hidden />
              </label>
            </header>
            <p>{t(`pilotads.aud.${a.kind}.text`)}</p>
            <footer>
              <span>
                <b className="ltr">{n(a.size)}</b> {t('pilotads.aud.people')}
              </span>
              <span className={`pa-aud-st s-${a.status}`}>{t(`pilotads.aud.st.${a.status}`, { defaultValue: a.status })}</span>
              {a.syncedAt && <small className="muted">{t('pilotads.aud.syncedAt', { when: t('pilotads.ago', { d: since(a.syncedAt) }) })}</small>}
            </footer>
            {a.error && <p className="pa-err">{a.error}</p>}
          </article>
        ))}
      </div>
      <p className="note pa-privacy">
        <Icon name="lock" /> {t('pilotads.aud.privacy')}
      </p>
    </div>
  );
}
