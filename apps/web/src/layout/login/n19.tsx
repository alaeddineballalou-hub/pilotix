/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Theme 19 · «صفحة الهبوط تبنيها بنفسك.» (IKEA effect: people value what they build themselves).
// The picture: a tray of three page blocks and an empty phone. The blocks are carried, one by one, into the phone
// (a cursor holds each one), they snap in, then the Meta Pixel dot lights up.
// Each block exists ONCE: it sits at its place in the phone (the finished frame, which is also the reduced-motion
// still) and its keyframes start it in the tray, shrunk to a thumbnail. The tray shows a ticked ghost of every block
// once it has left (two spare blocks wait beside them), so the still frame reads "you chose and placed these".
// Text direction comes from the page itself (:dir(rtl) in theme.css), no string key is needed for it.
// All geometry lives in theme.css (one table of numbers at the top).
import type { ReactElement } from 'react';

type T = (k: string, o?: Record<string, unknown>) => string;

/** The arrow cursor that carries a block (hidden except while that block is moving). */
const Cursor = () => (
  <svg className="pxn19-cur" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 3l14 7.6-6.2 1.6 3.6 6.6-2.6 1.4-3.6-6.6L5.6 18z" fill="#1B2A47" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

/** A small round tick (ghost slots and the pixel chip). */
const Tick = ({ c }: { c: string }) => (
  <svg className={c} viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r="10" />
    <path d="M5.8 10.4l2.7 2.7 5.7-5.9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The small icons of the two spare blocks and their "+" handle. */
const Stars = () => (
  <svg className="pxn19-ico" viewBox="0 0 60 12" aria-hidden="true">
    {[0, 1, 2, 3, 4].map((i) => (
      <path key={i} transform={`translate(${i * 12} 0)`} d="M6 .6l1.6 3.4 3.7.4-2.8 2.5.8 3.7L6 8.7 2.7 10.6l.8-3.7L.7 4.4l3.7-.4z" fill="#F7A823" />
    ))}
  </svg>
);
const Play = () => (
  <svg className="pxn19-ico pxn19-ico-p" viewBox="0 0 20 20" aria-hidden="true">
    <rect width="20" height="20" rx="6" fill="#1B2A47" />
    <path d="M8 6l6 4-6 4z" fill="#F7A823" />
  </svg>
);
const Plus = () => (
  <svg className="pxn19-plus" viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r="9.2" fill="#fff" stroke="#BDB3A1" strokeWidth="1.4" />
    <path d="M10 6v8M6 10h8" stroke="#1B2A47" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** The product photo: a drawn watch (sample product). */
const Photo = () => (
  <svg className="pxn19-art" viewBox="0 0 194 118" aria-hidden="true">
    <circle cx="97" cy="59" r="50" fill="#FBD9A0" />
    <rect x="80" y="6" width="34" height="106" rx="12" fill="#1B2A47" />
    <circle cx="97" cy="59" r="31" fill="#1B2A47" />
    <circle cx="97" cy="59" r="25" fill="#fff" />
    <circle cx="97" cy="59" r="25" fill="none" stroke="#F7A823" strokeWidth="4" strokeDasharray="110 200" transform="rotate(-90 97 59)" />
    <path d="M97 59V44M97 59l9 6" stroke="#1B2A47" strokeWidth="3" strokeLinecap="round" />
    <circle cx="97" cy="59" r="2.6" fill="#F7A823" />
    <rect x="128" y="55" width="4" height="9" rx="2" fill="#1B2A47" />
  </svg>
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
  side: 'start',
  // a warm work-table with a faint dot grid (the builder's canvas)
  panel: 'radial-gradient(circle, #DCD4C4 1.3px, transparent 1.6px) 0 0 / 22px 22px, #F6F2EA',
  light: true,
  Visual: ({ t }) => (
    <div className="pxn19-root">
      <div className="pxn19-head">
        <p className="pxn19-h">
          {t('a')} <span>{t('b')}</span>
        </p>
        <p className="pxn19-sub">{t('sub')}</p>
      </div>

      <div className="pxn19-ws">
        {/* the tray: ticked ghosts of the three blocks it gave, and two spare blocks still to pick */}
        <div className="pxn19-tray">
          <span className="pxn19-tray-t">{t('tray')}</span>
          <div className="pxn19-ghost pxn19-g1">
            <Tick c="pxn19-tick" />
            <span>{t('slotPhoto')}</span>
          </div>
          <div className="pxn19-ghost pxn19-g2">
            <Tick c="pxn19-tick" />
            <span>{t('slotPrice')}</span>
          </div>
          <div className="pxn19-ghost pxn19-g3">
            <Tick c="pxn19-tick" />
            <span>{t('slotForm')}</span>
          </div>
          <div className="pxn19-spare pxn19-sp1">
            <span className="pxn19-spare-t">
              <b>{t('spareReviews')}</b>
              <Stars />
            </span>
            <Plus />
          </div>
          <div className="pxn19-spare pxn19-sp2">
            <span className="pxn19-spare-t">
              <Play />
              <b>{t('spareVideo')}</b>
            </span>
            <Plus />
          </div>
        </div>

        {/* the phone: frame, address bar with the pixel dot, three empty dashed slots */}
        <div className="pxn19-phone">
          <div className="pxn19-screen">
            <i className="pxn19-notch" />
            <div className="pxn19-bar">
              <span className="pxn19-dot">
                <i className="pxn19-off" />
                <i className="pxn19-on" />
                <i className="pxn19-halo" />
              </span>
              <span className="pxn19-url">{t('page')}</span>
            </div>
            <i className="pxn19-slot pxn19-s1" />
            <i className="pxn19-slot pxn19-s2" />
            <i className="pxn19-slot pxn19-s3" />
          </div>
        </div>

        {/* the three blocks (drawn at their place in the phone) */}
        <div className="pxn19-b pxn19-b1">
          <i className="pxn19-lift" />
          <div className="pxn19-face pxn19-photo">
            <Photo />
          </div>
          <i className="pxn19-ring" />
          <Cursor />
        </div>
        <div className="pxn19-b pxn19-b2">
          <i className="pxn19-lift" />
          <div className="pxn19-face pxn19-price">
            <b className="pxn19-name">{t('product')}</b>
            <span className="pxn19-row">
              <b className="pxn19-now">{t('price')}</b>
              <s>{t('oldPrice')}</s>
            </span>
          </div>
          <i className="pxn19-ring" />
          <Cursor />
        </div>
        <div className="pxn19-b pxn19-b3">
          <i className="pxn19-lift" />
          <div className="pxn19-face pxn19-form">
            <span className="pxn19-in">{t('fName')}</span>
            <span className="pxn19-in">{t('fPhone')}</span>
            <span className="pxn19-btn">{t('order')}</span>
          </div>
          <i className="pxn19-ring" />
          <Cursor />
        </div>

        {/* lit once the page is complete */}
        <div className="pxn19-chip">
          <Tick c="pxn19-ok" />
          <span>
            <b>{t('pixel')}</b>
            <small>{t('capi')}</small>
          </span>
        </div>
      </div>
    </div>
  ),
};

export default theme;
