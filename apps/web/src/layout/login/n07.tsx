/** @jsxRuntime automatic @jsxImportSource react */
// Theme 7 · «زبونك يعرف أين طرده، خطوة بخطوة.» — the parcel and the message travel together.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const Box = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4z" fill="#F7A823" />
    <path d="M3.5 7.4 12 12l8.5-4.6M12 12v9.2" fill="none" stroke="#B85A0B" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="m7.6 5.1 8.6 4.6" stroke="#FFD58A" strokeWidth="1.6" />
  </svg>
);

const Warehouse = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path d="M6 19 24 9l18 10v21H6z" fill="#2A3C61" />
    <path d="M6 19 24 9l18 10" fill="none" stroke="#F7A823" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
    <rect x="14" y="25" width="20" height="15" rx="1.5" fill="#0F1B2E" />
    <path d="M14 29.5h20M14 34h20" stroke="#3A4F78" strokeWidth="1.6" />
  </svg>
);

// The door is a warm lit doorway; the navy leaf swings open (scaleX) to show it.
const House = () => (
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M10 28 32 11l22 17v26H10z" fill="#FFFFFF" />
    <path d="M7 30 32 10.5 57 30" fill="none" stroke="#F7A823" strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round" />
    <rect x="24" y="34" width="16" height="20" rx="2" fill="#FFC765" />
    <rect className="pxn07-door" x="24" y="34" width="16" height="20" rx="2" fill="#1B2A47" />
    <rect x="43" y="34" width="7" height="7" rx="1.5" fill="#C9D2E3" />
  </svg>
);

const Tick = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6.5 12.5 3.6 3.6 7.4-8" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Typing = ({ n }: { n: number }) => (
  <span className={`pxn07-typing y${n}`}><i /><i /><i /></span>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 80% at 50% 62%, #233658 0%, #1B2A47 48%, #121E35 100%)',
  Visual: ({ t }) => (
    <div className="pxn07">
      {/* computer: headline, long horizontal route, the customer's phone */}
      <div className="pxn07-d">
        <div className="pxn07-head" dir={t('dir')}>
          <span className="pxn07-chip">{t('chip')}</span>
          <h2 className="pxn07-h"><span className="pxn07-l1">{t('h1')}</span>{' '}<span className="pxn07-l2">{t('h2')}</span></h2>
          <p className="pxn07-sub">{t('sub')}</p>
        </div>

        <div className="pxn07-route">
          <i className="pxn07-ghost" />
          <i className="pxn07-fill" />
          <span className="pxn07-wh"><Warehouse /></span>
          <span className="pxn07-stop s1"><i /></span>
          <span className="pxn07-stop s2"><i /></span>
          <span className="pxn07-fly f1" />
          <span className="pxn07-fly f2" />
          <span className="pxn07-fly f3" />
          <span className="pxn07-home"><i className="pxn07-ring" /><House /><b className="pxn07-tick"><Tick /></b></span>
          <span className="pxn07-pk"><Box /></span>
          <span className="pxn07-lbl a">{t('from')}</span>
          <span className="pxn07-lbl b">{t('to')}</span>
        </div>

        <div className="pxn07-phone" dir={t('dir')}>
          <div className="pxn07-bar">
            <span className="pxn07-av">{t('shopInitial')}</span>
            <span className="pxn07-who"><b>{t('shop')}</b><small>{t('channel')}</small></span>
          </div>
          <div className="pxn07-chat">
            <div className="pxn07-slot"><div className="pxn07-msg m1"><b>{t('m1')}</b><small>{t('m1s')}</small><time>{t('t1')}</time></div><Typing n={1} /></div>
            <div className="pxn07-slot"><div className="pxn07-msg m2"><b>{t('m2')}</b><small>{t('m2s')}</small><time>{t('t2')}</time></div><Typing n={2} /></div>
            <div className="pxn07-slot"><div className="pxn07-msg m3"><b>{t('m3')}</b><small>{t('m3s')}</small><time>{t('t3')}</time></div><Typing n={3} /></div>
          </div>
        </div>
      </div>

      {/* phone / tablet band: vertical route with three stops, big house at the end, headline under it */}
      <div className="pxn07-m">
        <div className="pxn07-vr" dir={t('dir')}>
          <i className="pxn07-vghost" />
          <i className="pxn07-vfill" />
          <span className="pxn07-vstop v1"><i /></span>
          <span className="pxn07-vstop v2"><i /></span>
          <span className="pxn07-vhome"><i className="pxn07-ring" /><House /><b className="pxn07-tick"><Tick /></b></span>
          <span className="pxn07-vpk"><Box /></span>
          <span className="pxn07-vb v1"><i>{t('m1')}</i><b>{t('m1')}</b></span>
          <span className="pxn07-vb v2"><i>{t('m2')}</i><b>{t('m2')}</b></span>
          <span className="pxn07-vb v3"><i>{t('m3')}</i><b>{t('m3')}</b></span>
        </div>
        <h2 className="pxn07-mh" dir={t('dir')}><span className="pxn07-l1">{t('h1')}</span>{' '}<span className="pxn07-l2">{t('h2')}</span></h2>
      </div>
    </div>
  ),
};
export default theme;
