/** @jsxRuntime automatic */
// Theme 11 · «A late parcel? One click to claim» — one round button replaces the phone call to the courier.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

// the trail the paper plane leaves (same curve as the plane's keyframes): computer, phone, wide tablet band
const TRAIL = [[245, 283], [264, 251], [283, 232], [303, 217], [324, 206], [344, 201], [366, 199], [387, 202], [409, 210]];
const TRAIL_M = [[287, 153], [312, 134], [335, 120], [358, 112], [380, 109], [401, 112], [422, 120], [441, 134], [460, 153]];
const TRAIL_T = [[384, 149], [415, 142], [446, 138], [477, 139], [508, 143], [539, 151], [569, 163], [600, 179], [630, 199]];

const Box = () => (
  <svg viewBox="0 0 120 110" width="120" height="110">
    <path d="M60 8 110 30 60 52 10 30Z" fill="#F7B850" />
    <path d="M10 30 60 52V104L10 82Z" fill="#E39A1C" />
    <path d="M110 30 60 52V104L110 82Z" fill="#C9820F" />
    <path d="M35 19 85 41V58L75 54V45L25 23Z" fill="#FBE3B4" />
    <path d="M18 60 30 65.5V73L18 67.5Z" fill="#fff" opacity=".75" />
  </svg>
);

const Plane = () => (
  <svg viewBox="0 0 40 40" width="40" height="40">
    <path d="M3 19.5 37 5 27.5 35 19 24.5Z" fill="#FFFFFF" />
    <path d="M19 24.5 37 5 15.5 22Z" fill="#DCE3EF" />
    <path d="M15.5 22 19 24.5 17 31.5Z" fill="#B9C4D6" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 70% at 50% 18%, #26395E 0%, #1B2A47 52%, #14203A 100%)',
  Visual: ({ t }) => (
    <div className="pxn11">
      <div className="pxn11-glow" />

      {/* the order, as the follow-up agent sees it */}
      <div className="pxn11-order" dir={t('dir')}>
        <div className="pxn11-order-top">
          <b>{t('order')}</b>
          <small>{t('customer')}</small>
        </div>
        <div className="pxn11-parcel"><Box /></div>
      </div>

      {/* wide tablet band only: the order card is too big for the band, so the late parcel stands on its own */}
      <div className="pxn11-pbox"><Box /></div>

      {/* the clock above the parcel: it is late */}
      <div className="pxn11-late">
        <div className="pxn11-latepill" dir={t('dir')}>
          <span className="pxn11-clock">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <circle cx="12" cy="12" r="10" fill="#fff" stroke="#B42318" strokeWidth="2" />
              <path d="M12 12V7" stroke="#B42318" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <i className="pxn11-hand" />
          </span>
          <span>{t('late')}</span>
        </div>
      </div>

      {/* the one big button */}
      <div className="pxn11-btnwrap">
        <span className="pxn11-ring" />
        <span className="pxn11-ring pxn11-r2" />
        <div className="pxn11-btn" dir={t('dir')}>{t('claim')}</div>
      </div>

      {/* the old way, crossed out the moment the button is pressed: no call, no waiting */}
      <div className="pxn11-call" dir={t('dir')}>
        <svg className="pxn11-ph" viewBox="0 0 24 24" width="20" height="20">
          <path d="M6.6 3.5 9.4 3l1.5 4.2-2 1.6a12 12 0 0 0 6.3 6.3l1.6-2 4.2 1.5-.5 2.8a2 2 0 0 1-2.1 1.6C10.6 18.4 5.6 13.4 5 6.6a2 2 0 0 1 1.6-2.1Z" fill="none" stroke="#AEB9CE" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        <span>{t('call')}</span>
        <i className="pxn11-strike" />
      </div>

      {/* the courier's depot */}
      <div className="pxn11-depot">
        <svg viewBox="0 0 150 120" width="150" height="120">
          <path d="M10 48 75 12 140 48V112H10Z" fill="#33476F" />
          <path d="M4 50 75 8 146 50" fill="none" stroke="#C9D2E3" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="44" y="62" width="62" height="50" rx="4" fill="#1B2A47" />
          <path d="M44 74H106M44 86H106M44 98H106" stroke="#33476F" strokeWidth="3" />
          <rect x="62" y="30" width="26" height="12" rx="3" fill="#F7A823" />
        </svg>
        <span className="pxn11-depot-name">{t('courier')}</span>
      </div>

      {/* the paper turns into a plane and flies from the order to the depot */}
      <div className="pxn11-flip">
        <svg className="pxn11-trail" viewBox="0 0 560 620" width="560" height="620">
          {TRAIL.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="3.2" style={{ animationDelay: `${(i + 1) * 0.16}s` }} />
          ))}
        </svg>
        <svg className="pxn11-trail pxn11-m" viewBox="0 0 560 620" width="560" height="620">
          {TRAIL_M.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="5" style={{ animationDelay: `${(i + 1) * 0.16}s` }} />
          ))}
        </svg>
        <svg className="pxn11-trail pxn11-tb" viewBox="0 0 560 620" width="560" height="620">
          {TRAIL_T.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="5" style={{ animationDelay: `${(i + 1) * 0.16}s` }} />
          ))}
        </svg>
        <div className="pxn11-sheet">
          <i /><i /><i />
        </div>
        <div className="pxn11-plane"><div><Plane /></div></div>
      </div>

      {/* the cursor that presses */}
      <div className="pxn11-cursor">
        <svg viewBox="0 0 28 32" width="28" height="32">
          <path d="M3 2 25 18 14.5 19.5 20 30 15.5 31.5 10.5 21 3 27Z" fill="#fff" stroke="#1B2A47" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      </div>

      {/* sent */}
      <div className="pxn11-sent" dir={t('dir')}>
        <svg viewBox="0 0 24 24" width="22" height="22">
          <circle cx="12" cy="12" r="11" fill="#15803D" />
          <path d="M7 12.5 10.5 16 17 8.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="pxn11-sent-t">
          <span>{t('sent')}</span> <span className="pxn11-sent-n">{t('courier')}</span>
        </span>
      </div>

      <div className="pxn11-copy" dir={t('dir')}>
        <h2 className="pxn11-h">
          <span>{t('a')}</span>
          <span className="pxn11-or">{t('b')}</span>
        </h2>
        <p className="pxn11-p">{t('sub')}</p>
      </div>
    </div>
  ),
};
export default theme;
