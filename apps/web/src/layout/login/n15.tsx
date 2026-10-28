/** @jsxRuntime automatic @jsxImportSource react */
// Theme 15 · «انتهت المكالمة؟ التالية جاهزة.» — a deck of order cards: the top card is stamped «مؤكدة ✓» and slides
// away, the next one rises on its own with its call button ready. CSS: theme.css (pxn15-*). Words: strings.json.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const Phone = () => (
  <svg className="pxn15-ic" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"
      fill="currentColor"
    />
  </svg>
);

const Arrow = () => (
  <svg className="pxn15-arr" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// c0 = on top now (Samir), c1 and c2 wait under it, c3 = the order just confirmed (it leaves, then comes back at the bottom)
const Card = ({ t, n }: { t: T; n: 0 | 1 | 2 | 3 }) => (
  <div className={`pxn15-c pxn15-c${n}`}>
    <div className="pxn15-top">
      <span className="pxn15-next">
        <Arrow />
        {t('next')}
      </span>
    </div>
    <div className="pxn15-who">
      <span className="pxn15-av">{t(`ini${n}`)}</span>
      <span className="pxn15-txt">
        <b className="pxn15-name">{t(`name${n}`)}</b>
        <small className="pxn15-prod">
          {t(`prod${n}`)} <span className="pxn15-amt">· {t(`amt${n}`)}</span>
        </small>
      </span>
    </div>
    <span className="pxn15-call">
      <i className="pxn15-ring" />
      <Phone />
      {t('call')}
    </span>
    <span className="pxn15-shade" />
    <span className="pxn15-stamp">{t('done')}</span>
  </div>
);

const theme: {
  layout: 'split' | 'overlay';
  side: 'start' | 'end' | 'center';
  panel?: string;
  light?: boolean;
  dark?: boolean;
  Visual: (p: { t: T }) => ReactElement;
  Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 80% at 50% 78%, #263B63 0%, #1B2A47 52%, #142036 100%)',
  Visual: ({ t }) => (
    <div className="pxn15" dir={t('dir')}>
      <div className="pxn15-head">
        <h2 className="pxn15-h">
          <span className="pxn15-ha">{t('a')}</span> <span className="pxn15-hb">{t('b')}</span>
        </h2>
        <p className="pxn15-sub">{t('sub')}</p>
      </div>
      <div className="pxn15-deck">
        <i className="pxn15-glow" />
        <Card t={t} n={2} />
        <Card t={t} n={1} />
        <Card t={t} n={0} />
        <Card t={t} n={3} />
      </div>
    </div>
  ),
};
export default theme;
