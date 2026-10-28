/** @jsxRuntime automatic @jsxImportSource react */
// Theme 14 · Your courier, your choice. A loading bay: one door per courier, plus one for your own rider.
// The turntable turns the parcel to each door in turn and it leaves through every one; hover (or tap) a door and it leaves through yours.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const Van = () => (
  <svg className="pxn14-veh" viewBox="0 0 88 70" aria-hidden="true">
    <rect className="pxn14-body" x="8" y="4" width="72" height="54" rx="14" />
    <rect x="16" y="12" width="56" height="20" rx="6" fill="#0E1B2E" opacity=".85" />
    <rect x="21" y="16" width="16" height="4" rx="2" fill="#fff" opacity=".28" />
    <circle cx="20" cy="43" r="5.5" fill="#FFF3D1" />
    <circle cx="68" cy="43" r="5.5" fill="#FFF3D1" />
    <rect x="34" y="40" width="20" height="7" rx="3.5" fill="#0E1B2E" opacity=".3" />
    <rect x="6" y="54" width="76" height="8" rx="4" fill="#0E1B2E" />
    <rect x="14" y="60" width="14" height="10" rx="3" fill="#060C18" />
    <rect x="60" y="60" width="14" height="10" rx="3" fill="#060C18" />
  </svg>
);

// your own rider: a delivery scooter seen from the side (two wheels, seat, top box, handlebar, helmeted rider)
const Rider = () => (
  <svg className="pxn14-veh" viewBox="0 0 88 70" aria-hidden="true">
    <rect x="9" y="17" width="23" height="19" rx="4" fill="#E9EEF7" />
    <rect x="9" y="24" width="23" height="4" fill="#C27B0E" />
    <path d="M38 36 L45 18" stroke="#DDE3EE" strokeWidth="7" strokeLinecap="round" />
    <path d="M45 20 L60 24" stroke="#B8C4DA" strokeWidth="5" strokeLinecap="round" />
    <circle className="pxn14-body" cx="46" cy="11" r="8" />
    <path d="M49 8 h5 a3 3 0 0 1 0 6 h-5 z" fill="#0E1B2E" />
    <path className="pxn14-body" d="M10 52 C10 41 18 37 30 37 H46 L44 52 Z" />
    <rect className="pxn14-body" x="42" y="47" width="20" height="5" rx="2" />
    <path className="pxn14-col" d="M59 51 L65 24" />
    <path d="M60 23 L71 21" stroke="#DDE3EE" strokeWidth="4" strokeLinecap="round" />
    <circle cx="68" cy="31" r="3.5" fill="#FFF3D1" />
    <circle cx="22" cy="59" r="10" fill="#060C18" />
    <circle cx="22" cy="59" r="3.5" fill="#8597B8" />
    <circle cx="66" cy="59" r="10" fill="#060C18" />
    <circle cx="66" cy="59" r="3.5" fill="#8597B8" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'linear-gradient(165deg, #22355A 0%, #1B2A47 48%, #131F36 100%)',
  Visual: ({ t }) => (
    <div className="pxn14">
      <h2 className="pxn14-h" dir={t('dir')}><span>{t('h_a')}</span> <em>{t('h_b')}</em></h2>
      <p className="pxn14-p" dir={t('dir')}>{t('sub')}</p>
      <div className="pxn14-wall" />
      <div className="pxn14-floor" />
      <div className="pxn14-doors">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={`pxn14-door pxn14-d${i}`}>
            <b className="pxn14-sign" dir={t('dir')}>{t(`d${i}`)}</b>
            <div className="pxn14-open">
              {i === 4 ? <Rider /> : <Van />}
              <i className="pxn14-shut" />
            </div>
          </div>
        ))}
      </div>
      <div className="pxn14-tt">
        <i className="pxn14-glow" />
        {[1, 2, 3, 4].map((i) => <i key={i} className={`pxn14-trk pxn14-k${i}`}><i className="pxn14-lit" /></i>)}
        <i className="pxn14-disc" />
        <div className="pxn14-turn"><i className="pxn14-tip" /><i className="pxn14-box pxn14-roll" /></div>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={`pxn14-pk pxn14-pk${i}`}><i className="pxn14-tip" /><i className="pxn14-box pxn14-out" /></div>
        ))}
      </div>
    </div>
  ),
};
export default theme;
