/** @jsxRuntime automatic @jsxImportSource react */
// Theme 10 · «مجهودك يظهر في أرقامك» — the agent's player card, and behind it the manager's mirror card with the same numbers.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

/** A number that ticks from `from` to `to` (resting frame = `to`). */
const Tick = ({ from, to }: { from: string; to: string }) => (
  <span className="pxn10-reel">
    <span className="pxn10-reel-in">
      <i>{from}</i>
      <i>{to}</i>
    </span>
  </span>
);

/** One score row: label, value and a bar that fills to `w` (0–1). */
const Stat = ({ label, value, w, k }: { label: string; value: ReactElement | string; w: number; k: 1 | 2 | 3 }) => (
  <div className={`pxn10-stat pxn10-s${k}`}>
    <div className="pxn10-stat-top">
      <span className="pxn10-stat-l">{label}</span>
      <b className="pxn10-num">{value}</b>
    </div>
    <span className="pxn10-track">
      <i className="pxn10-fill" style={{ width: `${w * 100}%` }} />
    </span>
  </div>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 90% at 30% 72%, #263C66 0%, #1B2A47 48%, #121D33 100%)',
  Visual: ({ t }) => {
    const rate = (
      <>
        <Tick from={t('ratePrev')} to={t('rate')} />
        {t('pct')}
      </>
    );
    return (
      <div className="pxn10" dir={t('dir')}>
        <div className="pxn10-head">
          <h2 className="pxn10-h">
            <span>{t('a')}</span> <span className="pxn10-or">{t('b')}</span>
          </h2>
          <p className="pxn10-sub">{t('sub')}</p>
        </div>

        <div className="pxn10-scene">
          <div className="pxn10-glow" />

          {/* the manager's mirror card: the same three numbers, at the same moment */}
          <div className="pxn10-mirror">
            <div className="pxn10-m-head">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              <b>{t('mgr')}</b>
              <span className="pxn10-live">
                <i />
                {t('live')}
              </span>
            </div>
            <p className="pxn10-m-who">{t('mgrWho')}</p>
            <div className="pxn10-m-row pxn10-s1">
              <span>{t('rateLbl')}</span>
              <b className="pxn10-num">{rate}</b>
              <span className="pxn10-track"><i className="pxn10-fill" style={{ width: '68%' }} /></span>
            </div>
            <div className="pxn10-m-row pxn10-s2">
              <span>{t('upLbl')}</span>
              <b className="pxn10-num">{t('up')}</b>
              <span className="pxn10-track"><i className="pxn10-fill" style={{ width: '56%' }} /></span>
            </div>
            <div className="pxn10-m-row pxn10-s3">
              <span>{t('callsLbl')}</span>
              <b className="pxn10-num">{t('calls')}</b>
              <span className="pxn10-track"><i className="pxn10-fill" style={{ width: '78%' }} /></span>
            </div>
            <span className="pxn10-same">
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path d="M4 9h16M4 15h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              {t('same')}
            </span>
          </div>

          {/* the agent's own player card */}
          <div className="pxn10-float">
            <div className="pxn10-card">
              <div className="pxn10-band">
                <div className="pxn10-badge">
                  <b className="pxn10-num">{rate}</b>
                  <small>{t('badge')}</small>
                  <span className="pxn10-plus" dir="ltr">{t('plus')}</span>
                </div>
                <div className="pxn10-who">
                  <b>{t('name')}</b>
                  <small>{t('role')}</small>
                </div>
                <svg className="pxn10-av" viewBox="0 0 64 64" aria-hidden="true">
                  <circle cx="32" cy="32" r="32" fill="#FFF3DC" />
                  <circle cx="32" cy="25" r="11" fill="#1B2A47" />
                  <path d="M11 55c3-11 11-17 21-17s18 6 21 17a32 32 0 0 1-42 0Z" fill="#1B2A47" />
                </svg>
                <span className="pxn10-sheen" />
              </div>
              <div className="pxn10-body">
                <Stat k={1} label={t('rateLbl')} value={rate} w={0.68} />
                <Stat k={2} label={t('upLbl')} value={t('up')} w={0.56} />
                <Stat k={3} label={t('callsLbl')} value={t('calls')} w={0.78} />
              </div>
            </div>
          </div>

        </div>
      </div>
    );
  },
};
export default theme;
