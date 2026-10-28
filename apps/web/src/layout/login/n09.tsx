/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Theme 9 · «نفس المكالمة، طلبية أكبر.» — one confirmation call, one order card that grows.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const Phone = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Watch = () => (
  <svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true">
    <rect x="17" y="3" width="14" height="9" rx="3" fill="#C9CFDA" />
    <rect x="17" y="36" width="14" height="9" rx="3" fill="#C9CFDA" />
    <rect x="11" y="10" width="26" height="28" rx="8" fill="#1B2A47" />
    <rect x="15" y="14" width="18" height="20" rx="5" fill="#2F4470" />
    <path d="M24 19v5l3 2" fill="none" stroke="#F7A823" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
const Strap = () => (
  <svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true">
    <path d="M18 4h12v40H18z" fill="#B85A0B" />
    <path d="M18 4h12v40H18z" fill="none" stroke="#8A4A10" strokeWidth="1.5" strokeDasharray="2 3" />
    <rect x="15" y="20" width="18" height="8" rx="2" fill="none" stroke="#1B2A47" strokeWidth="2.6" />
    <circle cx="24" cy="34" r="1.6" fill="#FFF1E0" /><circle cx="24" cy="39" r="1.6" fill="#FFF1E0" />
  </svg>
);
const Arrow = () => (
  <svg className="pxn09-arrow" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M4 12h15m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 75% at 50% 28%, #2A3D63 0%, #1B2A47 52%, #131F36 100%)',
  Visual: ({ t }) => (
    <div className="pxn09" dir={t('dir')}>
      <div className="pxn09-glow" />
      <div className="pxn09-wrap">
        {/* the call: rings pulse beside the card; the pill shows who speaks and what is said */}
        <div className="pxn09-rings"><i /><i /><i /></div>
        <div className="pxn09-call">
          <span className="pxn09-ph"><Phone /></span>
          <span className="pxn09-pill" dir={t('dir')}>
            <span className="pxn09-voice"><i /><i /><i /><i /><i /></span>
            {/* three turns of the same call: customer yes → agent's small offer → customer yes again */}
            <span className="pxn09-who">
              <small className="pxn09-w1">{t('who_c')}</small>
              <small className="pxn09-w2">{t('who_a')}</small>
              <small className="pxn09-w3">{t('who_c')}</small>
            </span>
            <span className="pxn09-says">
              <b className="pxn09-s1">{t('say_1')}</b>
              <b className="pxn09-s2 pxn09-ask">{t('ask')}</b>
              <b className="pxn09-s3">{t('say_2')}</b>
            </span>
          </span>
        </div>

        {/* the empty slot under the one-item card: room for the second ask. The card grows into it. */}
        <div className="pxn09-slot"><span>+</span></div>

        {/* the order card: the same card, it grows */}
        <div className="pxn09-card">
          <div className="pxn09-bgtop" />
          <div className="pxn09-bgbot">
            <div className="pxn09-foot">
              <span className="pxn09-tl">{t('total')}</span>
              <span className="pxn09-sum">
                <s className="pxn09-was">{t('was')}</s>
                <Arrow />
                <span className="pxn09-roll">
                  <span className="pxn09-strip">
                    <b>{t('was')}</b>
                    <b className="pxn09-now">{t('now')}</b>
                  </span>
                </span>
              </span>
            </div>
          </div>
          <div className="pxn09-head">
            <span className="pxn09-id">
              <b>{t('order')}</b>
              <small>{t('cust')}</small>
            </span>
            <span className="pxn09-stamp"><Check />{t('ok')}</span>
          </div>
          <div className="pxn09-row pxn09-r1">
            <span className="pxn09-th"><Watch /></span>
            <span className="pxn09-nm"><b>{t('p1')}</b><small>{t('p1_meta')}</small></span>
            <b className="pxn09-pr">{t('p1_price')}</b>
          </div>
          <div className="pxn09-row pxn09-r2">
            <span className="pxn09-th or"><Strap /></span>
            <span className="pxn09-nm"><b>{t('p2')}</b><small className="pxn09-chip">{t('upsell')}</small></span>
            <b className="pxn09-pr">{t('p2_price')}</b>
          </div>
        </div>
      </div>

      <div className="pxn09-copy">
        <h2 className="pxn09-h" dir={t('dir')}><span>{t('h_a')}</span> <span className="pxn09-b">{t('h_b')}</span></h2>
        <p className="pxn09-sub" dir={t('dir')}>{t('sub')}</p>
      </div>
    </div>
  ),
};
export default theme;
