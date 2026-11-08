// « Nouvelle version de l'app » in the Pilotix phone app (lib/appUpdate): offered (« Plus tard » allowed), required (from
// the build the control room made obligatoire: nothing closes it), or, in an app made before the updater, how to
// install the new app once by hand. While it downloads, a bar shows how far it is.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allowAppInstalls, AppUpdateState, postpone, runAppUpdate, subscribeAppUpdate } from '../lib/appUpdate';
import { Sheet } from './Sheet';
import './appUpdate.css';

export function AppUpdateHost() {
  const { t, i18n } = useTranslation();
  const [s, setS] = useState<AppUpdateState | null>(null);
  useEffect(() => subscribeAppUpdate(setS), []);
  if (!s) return null;
  const mb = (bytes: number) => t('common.appUpdate.size', { n: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(bytes / 1048576) });
  const required = s.need === 'required';
  const busy = s.phase === 'download';
  const locked = required || busy;
  const title =
    s.phase === 'allow'
      ? t('common.appUpdate.allowTitle')
      : busy
        ? t('common.appUpdate.downloading')
        : required
          ? t('common.appUpdate.titleRequired')
          : s.old
            ? t('common.appUpdate.titleOld')
            : t('common.appUpdate.titleOffer');
  const pct = s.total > 0 ? Math.min(100, Math.round((s.loaded / s.total) * 100)) : 0;
  const later = !required && !busy && (
    <button type="button" className="btn ghost big" onClick={postpone}>
      {t('common.appUpdate.later')}
    </button>
  );
  const foot = busy ? undefined : (
    <div className="au-foot">
      {s.phase === 'allow' ? (
        <button type="button" className="btn primary big" onClick={() => void allowAppInstalls()}>
          {t('common.appUpdate.allowBtn')}
        </button>
      ) : (
        <button type="button" className="btn primary big" onClick={() => void runAppUpdate()}>
          {s.phase === 'failed' ? t('common.appUpdate.retry') : s.old ? t('common.appUpdate.download') : t('common.appUpdate.update')}
        </button>
      )}
      {later}
    </div>
  );
  return (
    <Sheet className={`au-sheet${locked ? ' au-locked' : ''}`} title={title} onClose={() => (locked ? false : postpone())} foot={foot}>
      <div className="au-app">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        <div>
          <b>Pilotix</b>
          <small>{t('common.appUpdate.version', { build: s.latest.build, size: mb(s.latest.size) })}</small>
        </div>
      </div>
      {busy ? (
        <div className="au-load" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="au-bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="au-row">
            <span>{t('common.appUpdate.progress', { done: mb(s.loaded), total: mb(s.total) })}</span>
            <b>{pct} %</b>
          </div>
          <p className="au-then">{t('common.appUpdate.then')}</p>
        </div>
      ) : s.phase === 'allow' ? (
        <p className="au-note">{t('common.appUpdate.allowNote')}</p>
      ) : s.phase === 'failed' ? (
        <p className="au-note bad">{t('common.appUpdate.failed')}</p>
      ) : s.old ? (
        <ol className="au-steps">
          <li>{t('common.appUpdate.old1')}</li>
          <li>{t('common.appUpdate.old2')}</li>
          <li>{t('common.appUpdate.old3')}</li>
        </ol>
      ) : (
        <p className="au-note">{required ? t('common.appUpdate.noteRequired') : t('common.appUpdate.noteOffer')}</p>
      )}
    </Sheet>
  );
}
