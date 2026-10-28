/** @jsxRuntime automatic @jsxImportSource react */
// Theme 1 · «Your shop is waiting» — a shop at dusk, shutter half open, the open work waiting behind the counter.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

/** A parcel of a stack (cardboard, tape, a small label). */
const Box = ({ w, s }: { w: number; s?: number }) => (
  <i className="pxn01-bx" style={{ width: `${w}%`, marginInlineStart: `${s ?? 0}%` }} />
);

const Phone = () => (
  <svg className="pxn01-ic pxn01-ring" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.6 3.5h2.6l1.4 4-2 1.5a12 12 0 0 0 6.4 6.4l1.5-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="currentColor" />
  </svg>
);
const Truck = () => (
  <svg className="pxn01-ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3.2v2.8h-7z" fill="currentColor" />
    <circle cx="6.5" cy="16.8" r="2" fill="#1B2A47" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="17" cy="16.8" r="2" fill="#1B2A47" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/** A status tag on top of a stack: the number, the status light, the app's own wording. */
const Tag = ({ k, t, icon }: { k: 1 | 2 | 3; t: T; icon: ReactElement }) => (
  <span className={`pxn01-tag pxn01-t${k}`}>
    <span className="pxn01-halo" />
    <span className="pxn01-ping" />
    <span className="pxn01-tr">
      <b className="pxn01-num">{t(`n${k}`)}</b>
      <span className="pxn01-lamp">{icon}</span>
    </span>
    <span className="pxn01-lbl" dir={t('dir')}>{t(`c${k}`)}</span>
  </span>
);

/** The Pilotix wordmark («Grand sourire»), painted on the shutter. Same paths as PxLogo.tsx, copied (no imports). */
const GL = [
  'M24.6875 120.41015625H41.484375V92.333984375H41.6796875C44.365234375 98.046875 49.443359375 101.123046875 56.23046875 101.123046875C69.755859375 101.123046875 78.49609375 90.4296875 78.49609375 74.12109375C78.49609375 58.349609375 69.4140625 47.314453125 56.376953125 47.314453125C49.6875 47.314453125 44.609375 49.951171875 41.533203125 55.17578125H41.2890625V48.4375H24.6875ZM51.494140625 87.6953125C45.146484375 87.6953125 40.80078125 82.373046875 40.80078125 74.12109375C40.80078125 65.966796875 45.146484375 60.693359375 51.494140625 60.693359375C57.6953125 60.693359375 61.50390625 65.72265625 61.50390625 74.12109375C61.50390625 82.6171875 57.6953125 87.6953125 51.494140625 87.6953125Z',
  'M83.771484375 100.0H100.568359375V48.4375H83.771484375Z',
  'M124.740234375 27.24609375H107.943359375V100.0H124.740234375Z',
  'M157.115234375 101.171875C173.27734375 101.171875 184.21484375 90.576171875 184.21484375 74.21875C184.21484375 57.958984375 173.27734375 47.265625 157.115234375 47.265625C140.953125 47.265625 129.966796875 57.958984375 129.966796875 74.21875C129.966796875 90.576171875 140.953125 101.171875 157.115234375 101.171875ZM157.115234375 87.79296875C151.20703125 87.79296875 147.0078125 82.958984375 147.0078125 74.21875C147.0078125 65.52734375 151.255859375 60.64453125 157.115234375 60.64453125C162.974609375 60.64453125 167.22265625 65.52734375 167.22265625 74.21875C167.22265625 82.958984375 162.974609375 87.79296875 157.115234375 87.79296875Z',
  'M221.912109375 48.4375H211.31640625V34.375H194.470703125V48.4375H185.681640625V61.42578125H194.470703125V85.498046875C194.470703125 95.5078125 200.037109375 100.0 212.390625 100.0H221.912109375V87.01171875H216.1015625C212.341796875 87.01171875 211.31640625 85.986328125 211.31640625 82.666015625V61.42578125H221.912109375Z',
  'M226.650390625 100.0H243.447265625V48.4375H226.650390625Z',
];
const Mark = () => (
  <svg className="pxn01-mark" viewBox="0 18 339 140" aria-hidden="true">
    {GL.map((d, i) => (
      <path key={i} d={d} fill="#FFFFFF" />
    ))}
    <path d="M254.42,55.79 L292.73,92.64" stroke="#FFFFFF" strokeWidth={14.71} strokeLinecap="round" />
    <path d="M64.50,110.00 C138.50,160.00 226.33,120.00 314.82,34.44 C226.33,104.04 138.50,144.04 64.50,110.00 Z" fill="#F7A823" />
    <circle cx={92.17} cy={32.3} r={10.41} fill="#F7A823" />
    <circle cx={235.05} cy={32.3} r={10.41} fill="#F7A823" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'linear-gradient(180deg, #0C1628 0%, #15223B 46%, #1E2C4A 78%, #0B1425 100%)',
  Visual: ({ t }) => (
    <div className="pxn01">
      <span className="pxn01-star s1" /><span className="pxn01-star s2" /><span className="pxn01-star s3" /><span className="pxn01-star s4" />

      <div className="pxn01-copy" dir={t('dir')}>
        <h2 className="pxn01-h">
          {t('a')} <span>{t('b')}</span>
        </h2>
        <p className="pxn01-p">{t('sub')}</p>
      </div>

      {/* the street: the neighbours are closed for the night, the sidewalk catches our light */}
      <div className="pxn01-street" />
      <div className="pxn01-nb pxn01-nb-a"><i /></div>
      <div className="pxn01-nb pxn01-nb-b"><i /></div>
      <div className="pxn01-spill" />

      <div className="pxn01-shop">
        <div className="pxn01-wall" />
        <div className="pxn01-hood"><span className="pxn01-led" /></div>
        <div className="pxn01-door">
          <div className="pxn01-in" />
          <div className="pxn01-glow" />
          <div className="pxn01-shelf" />
          <div className="pxn01-row">
            <div className="pxn01-stk">
              <Tag k={1} t={t} icon={<span className="pxn01-dot" />} />
              <Box w={78} s={8} />
              <Box w={92} />
            </div>
            <div className="pxn01-stk">
              <Tag k={2} t={t} icon={<Phone />} />
              <Box w={70} s={14} />
            </div>
            <div className="pxn01-stk">
              <Tag k={3} t={t} icon={<Truck />} />
              <Box w={88} s={6} />
            </div>
          </div>
          <div className="pxn01-counter" />
          <div className="pxn01-shutter">
            <Mark />
          </div>
        </div>
      </div>
    </div>
  ),
};
export default theme;
