// Control room › Réglages › App Android: the latest phone app GitHub made (its version, when, its size, whether it is
// signed with Pilotix's fixed key, without which it can't replace the app on a phone) and « Mise à jour obligatoire »:
// phones with an older app must update before anything else (lib/appUpdate). « Ne plus obliger » lets them wait again.
import { useTranslation } from 'react-i18next';
import { shortWhen } from '../../lib/format';
import { usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';

export function AppBox({ owner }: { owner: boolean }) {
  const { t, i18n } = useTranslation();
  const q = usePRpc('p.app.get', {});
  const req = usePAction('p.app.require', { success: t('platform.saved') });
  const mb = (bytes: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(bytes / 1048576);
  const d = q.data;
  const latest = d?.latest ?? null;
  const required = !!latest && d!.minBuild > 0 && d!.minBuild >= latest.build;
  return (
    <Card title={t('platform.app.title')} help={t('platform.app.help')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="dr-cf">
          <div className="dr-cf-lock">
            <span className="dr-cf-lock-i" aria-hidden="true">
              <Icon name="phone" />
            </span>
            <div>
              <b>{latest ? t('platform.app.latest', { build: latest.build, when: shortWhen(latest.date), size: mb(latest.size) }) : t('platform.app.unknown')}</b>
              {latest && <small className={latest.fixedKey ? '' : 'form-err'}>{latest.fixedKey ? t('platform.app.keyOk') : t('platform.app.keyMissing')}</small>}
              <small className="muted">{d.minBuild > 0 ? t('platform.app.requiredFrom', { build: d.minBuild }) : t('platform.app.notRequired')}</small>
            </div>
          </div>
          {owner && (
            <div className="row wrap" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={!latest || !latest.fixedKey || required || req.isPending}
                onClick={() => latest && req.mutate({ build: latest.build })}
              >
                {t('platform.app.require', { build: latest?.build ?? '' })}
              </button>
              {d.minBuild > 0 && (
                <button type="button" className="btn ghost" disabled={req.isPending} onClick={() => req.mutate({ build: 0 })}>
                  {t('platform.app.unrequire')}
                </button>
              )}
            </div>
          )}
          {latest && (
            <a className="muted small" href={latest.url} target="_blank" rel="noreferrer">
              {t('platform.app.link')}
            </a>
          )}
        </div>
      )}
    </Card>
  );
}
