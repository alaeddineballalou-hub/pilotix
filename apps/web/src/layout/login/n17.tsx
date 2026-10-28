/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Theme 17 · «متجرك في جيبك، أينما كنت.» — one shop, two screens: a new order lands on the computer and on the
// phone at the same moment, then the phone slides into a jacket pocket that keeps glowing.
// Direction is inherited from the page (<html dir> is set by i18n), never read from a string.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const PcIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </svg>
);
const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 90% at 50% 0%, #243759 0%, #1B2A47 52%, #152239 100%)',
  Visual: ({ t }) => (
    <div className="pxn17">
      <div className="pxn17-head">
        <h2 className="pxn17-h">
          {t('a')} <span>{t('b')}</span>
        </h2>
        <p className="pxn17-sub">{t('sub')}</p>
      </div>

      {/* the computer on the desk */}
      <div className="pxn17-pc">
        <div className="pxn17-mon">
          <div className="pxn17-scr">
            <div className="pxn17-rail">
              <i className="or" />
              <i />
              <i />
              <i />
            </div>
            <div className="pxn17-main">
              <div className="pxn17-top">
                <b>{t('title')}</b>
                <i />
              </div>
              <div className="pxn17-list">
                <div className="pxn17-row pxn17-new">
                  <b>
                    {t('nNew')} · {t('nCity')}
                  </b>
                  <em>{t('now')}</em>
                </div>
                <div className="pxn17-row pxn17-old r1">
                  <b>{t('r1')}</b>
                  <span className="st ok">{t('s1')}</span>
                  <span className="am">{t('a1')}</span>
                </div>
                <div className="pxn17-row pxn17-old r2">
                  <b>{t('r2')}</b>
                  <span className="st bl">{t('s2')}</span>
                  <span className="am">{t('a2')}</span>
                </div>
                <div className="pxn17-row pxn17-old r3">
                  <b>{t('r3')}</b>
                  <span className="st ok">{t('s1')}</span>
                  <span className="am">{t('a3')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="pxn17-neck" />
        <div className="pxn17-foot" />
      </div>
      <div className="pxn17-lab pxn17-lab-pc">
        <span className="pxn17-chip">
          <PcIcon />
          {t('pc')}
        </span>
      </div>

      {/* the phone and the jacket pocket */}
      <div className="pxn17-mob">
        <div className="pxn17-jacket" />
        <div className="pxn17-glow" />
        <div className="pxn17-clip">
          <div className="pxn17-phone">
            <div className="pxn17-pscr">
              <div className="pxn17-notch">
                <i />
              </div>
              <b className="pxn17-pt">{t('title')}</b>
              <div className="pxn17-plist">
                <div className="pxn17-prow pxn17-new">
                  <b>{t('nNew')}</b>
                  <small>
                    {t('nCity')} · <em>{t('now')}</em>
                  </small>
                </div>
                <div className="pxn17-prow pxn17-old r1">
                  <b>{t('r1')}</b>
                  <small>{t('a1')}</small>
                </div>
                <div className="pxn17-prow pxn17-old r2">
                  <b>{t('r2')}</b>
                  <small>{t('a2')}</small>
                </div>
                <div className="pxn17-prow pxn17-old r3">
                  <b>{t('r3')}</b>
                  <small>{t('a3')}</small>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="pxn17-pocket">
          <i />
        </div>
      </div>
      <div className="pxn17-lab pxn17-lab-and">
        <span className="pxn17-chip">
          <PhoneIcon />
          {t('android')}
        </span>
      </div>
    </div>
  ),
};
export default theme;
