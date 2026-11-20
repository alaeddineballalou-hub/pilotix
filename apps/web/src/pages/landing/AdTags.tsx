// Landing pages › Réglages › « Paramètres d’URL »: are they on the shop's ads by themselves? An ad launched from Pilotix
// has them from the start; a new ad made in Meta's Ads Manager gets them from Pilotix in its first hours (a copy of its
// créa with them, on the same ad: Meta checks the ad again). The others are listed with the reason, so the owner pastes
// the line above himself. The owner turns it off or checks now; everything else is core's (ads.tags.*).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n, since } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { adStatusLabel } from '../ads/adStatus';
import '../ads/pilot/pilot.css';

/** how many rows a list shows before « Voir les autres » */
const SHOWN = 4;

export function AdTagsCard() {
  const { t } = useTranslation();
  // a person without Publicité gets no answer: the card is simply not shown
  const q = useRpc('ads.tags.state', {}, { refetchInterval: 120_000, retry: false });
  const save = useAction('ads.tags.save', { success: (r) => (r.on ? t('landing.tags.savedOn') : t('landing.tags.savedOff')) });
  const check = useAction('ads.tags.check', { success: t('landing.tags.checkedNow') });
  const [allFixed, setAllFixed] = useState(false);
  const [allMissing, setAllMissing] = useState(false);
  const d = q.data;
  if (!d) return null;
  const fixed = allFixed ? d.fixed : d.fixed.slice(0, SHOWN);
  const missing = allMissing ? d.missing : d.missing.slice(0, SHOWN);
  return (
    <section className={`pa-hand lp-tags ${d.on ? 'on' : ''}`} aria-labelledby="lp-tags-title">
      <header>
        <span className="pa-aud-ico">
          <Icon name="sparkles" />
        </span>
        <div>
          <h3 id="lp-tags-title">{t('landing.tags.title')}</h3>
          <p>{t('landing.tags.sub', { h: d.fixH })}</p>
        </div>
        <label className="pa-switch" title={d.owner ? '' : t('pilotads.pilot.ownerOnly')}>
          <input type="checkbox" role="switch" checked={d.on} disabled={!d.owner || save.isPending} onChange={(e) => save.mutate({ on: e.target.checked })} aria-label={t('landing.tags.switch')} />
          <i aria-hidden />
        </label>
      </header>

      {!d.on ? (
        <p className="pa-hand-off">{t('landing.tags.off')}</p>
      ) : (
        <>
          {d.error && <p className="pa-err">{t('landing.tags.runError', { why: d.error })}</p>}
          {d.checkedAt && !d.fixed.length && !d.missing.length && (
            <p className="pa-hand-ok">
              <Icon name="checkcircle" /> {t('landing.tags.allGood')}
            </p>
          )}

          {d.fixed.length > 0 && (
            <div className="pa-hand-block">
              <h4>
                <Icon name="checkcircle" /> {t('landing.tags.fixedTitle')} <b className="ltr">{n(d.fixed.length)}</b>
              </h4>
              <ul className="pa-hand-list">
                {fixed.map((f) => (
                  <li key={`${f.id}-${f.at}`}>
                    <span className="pa-hand-name">
                      <b>{f.name}</b>
                      <small>{f.campaign}</small>
                    </span>
                    <span className="pa-hand-tag ok">{t('landing.tags.fixedTag')}</span>
                    <small className="pa-hand-when">{t('pilotads.ago', { d: since(f.at) })}</small>
                  </li>
                ))}
              </ul>
              {d.fixed.length > SHOWN && (
                <button type="button" className="btn small ghost pa-hand-more" onClick={() => setAllFixed(!allFixed)}>
                  {allFixed ? t('landing.tags.less') : t('landing.tags.more', { n: n(d.fixed.length - SHOWN) })}
                </button>
              )}
            </div>
          )}

          {d.missing.length > 0 && (
            <div className="pa-hand-block warn">
              <h4>
                <Icon name="alert" /> {t('landing.tags.missingTitle')} <b className="ltr">{n(d.missing.length)}</b>
              </h4>
              <p className="pa-hand-hint">{t('landing.tags.missingHint')}</p>
              <ul className="pa-hand-list">
                {missing.map((m) => (
                  <li key={m.id}>
                    <span className="pa-hand-name">
                      <b>{m.name}</b>
                      <small>{m.campaign}</small>
                    </span>
                    <span className={`pa-hand-tag ${m.status === 'ACTIVE' ? 'run' : ''}`}>{adStatusLabel(m.status, t)}</span>
                    <small className={`pa-hand-why ${m.why === 'refused' ? 'pa-err' : ''}`}>{t(`landing.tags.why.${m.why}`, { h: d.fixH, why: m.error ?? '' })}</small>
                  </li>
                ))}
              </ul>
              {d.missing.length > SHOWN && (
                <button type="button" className="btn small ghost pa-hand-more" onClick={() => setAllMissing(!allMissing)}>
                  {allMissing ? t('landing.tags.less') : t('landing.tags.more', { n: n(d.missing.length - SHOWN) })}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <footer>
        <small className="muted">{d.checkedAt ? t('landing.tags.checkedAt', { when: t('pilotads.ago', { d: since(d.checkedAt) }) }) : t('landing.tags.never')}</small>
        {d.owner && d.on && (
          <button type="button" className="btn small ghost" disabled={check.isPending} onClick={() => check.mutate({})}>
            <Icon name="refresh" /> {check.isPending ? t('landing.tags.checking') : t('landing.tags.check')}
          </button>
        )}
      </footer>
      {d.demo && <p className="pa-hand-demo muted">{t('landing.tags.demo')}</p>}
    </section>
  );
}
