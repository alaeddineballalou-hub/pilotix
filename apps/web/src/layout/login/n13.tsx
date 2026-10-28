/** @jsxRuntime automatic @jsxImportSource react */
// Theme 13 · «Made for cash on delivery»: at an Algerian tiled doorway, a parcel goes in and a dinar note comes out.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

// An 8-point zellige star (16 points) centred on 0,0, as an SVG points list.
const star = (R: number, r: number) =>
  Array.from({ length: 16 }, (_, i) => {
    const a = (Math.PI / 8) * i - Math.PI / 2;
    const d = i % 2 ? r : R;
    return `${(Math.cos(a) * d).toFixed(2)},${(Math.sin(a) * d).toFixed(2)}`;
  }).join(' ');

// The stars that draw themselves around the doorway: along the arch, then down both jambs.
const ARCH = [180, 150, 120, 90, 60, 30, 0].map((deg): [number, number] => [370 + 68 * Math.cos((deg * Math.PI) / 180), 148 - 68 * Math.sin((deg * Math.PI) / 180)]);
// A hand held out palm up, fingers to the right (the customer's is the same hand, mirrored).
const HAND = 'M148 207C160 203 176 203 188 206C197 208 203 212 203 218C203 223 198 226 191 226L172 228C165 234 157 236 148 235Z';
const STARS: [number, number][] = [[302, 290], [302, 240], [302, 192], ...ARCH, [438, 192], [438, 240], [438, 290]];
// The tile ring that draws itself around the two hands, on the street side (the door frame closes it on the other side).
const ringAt = (deg: number): [number, number] => [232 + 146 * Math.cos((deg * Math.PI) / 180), 200 - 146 * Math.sin((deg * Math.PI) / 180)];
const RING = [112, 124, 136, 148, 160, 172, 184, 196, 208, 220].map(ringAt);
const [r0x, r0y] = ringAt(104);
const [r1x, r1y] = ringAt(228);
const RING_ARC = `M${r0x.toFixed(1)} ${r0y.toFixed(1)}A146 146 0 0 0 ${r1x.toFixed(1)} ${r1y.toFixed(1)}`;
// The thumb that closes over what each hand holds.
const THUMB = 'M158 207C163 199 175 196 184 199C188 200 188 205 184 206C177 207 170 209 165 213Z';

// One zellige tile (48 px): a navy star with an orange heart, terracotta diamonds at the corners.
function Tile({ id }: { id: string }) {
  return (
    <pattern id={id} width="48" height="48" patternUnits="userSpaceOnUse">
      <rect width="48" height="48" fill="#F1DEC3" />
      <polygon points={star(17, 10)} transform="translate(24 24)" fill="#1B2A47" />
      <polygon points={star(8, 5)} transform="translate(24 24)" fill="#F7A823" />
      {([[0, 0], [48, 0], [0, 48], [48, 48]] as [number, number][]).map(([x, y]) => (
        <rect key={`${x}${y}`} x={x - 6} y={y - 6} width="12" height="12" transform={`rotate(45 ${x} ${y})`} fill="#C8643B" />
      ))}
    </pattern>
  );
}

// The handover scene (viewBox 460 × 340). Drawn twice (computer block, phone band), so ids carry a prefix.
function Scene({ t, id }: { t: T; id: string }) {
  return (
    <div className="pxn13-scene" aria-hidden="true">
      <svg viewBox="0 0 460 340" className="pxn13-svg">
        <defs>
          <radialGradient id={`${id}g`}>
            <stop offset="0" stopColor="#F7A823" stopOpacity=".55" />
            <stop offset="1" stopColor="#F7A823" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}s`} x1="300" x2="424" y1="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset=".72" stopColor="#FFF8EC" />
            <stop offset="1" stopColor="#1B2A47" />
          </linearGradient>
          <linearGradient id={`${id}l`} x1="0" x2="0" y1="100" y2="312" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F7A823" stopOpacity="0" />
            <stop offset="1" stopColor="#F7A823" stopOpacity=".28" />
          </linearGradient>
          <linearGradient id={`${id}f`} x1="0" x2="90" y1="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" />
          </linearGradient>
          <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="460" height="340">
            <rect width="460" height="340" fill={`url(#${id}f)`} />
          </mask>
        </defs>

        {/* warm light where the hands meet, breathing during the hold */}
        <circle className="pxn13-glow" cx="232" cy="196" r="128" fill={`url(#${id}g)`} />
        {/* floor and threshold */}
        <g mask={`url(#${id}m)`}>
          <rect x="0" y="318" width="460" height="16" fill="#EBD3B0" />
          {Array.from({ length: 23 }, (_, i) => (
            <rect key={i} x={i * 20 + 6} y="320" width="8" height="8" transform={`rotate(45 ${i * 20 + 10} 326)`} fill={i % 2 ? '#C8643B' : '#1B2A47'} opacity=".75" />
          ))}
        </g>
        <rect x="280" y="310" width="180" height="12" rx="3" fill="#E2C59C" />
        <ellipse cx="226" cy="306" rx="120" ry="9" fill="#1B2A47" opacity=".08" />

        {/* the doorway: the dark hall, warm light from the house, the green door leaf open inside */}
        <path d="M312 312V152a58 58 0 0 1 116 0v160z" fill="#1B2A47" />
        <path d="M322 312V158a48 48 0 0 1 96 0v154z" fill={`url(#${id}l)`} />
        <path d="M402 312V140l26 14v158z" fill="#2F7D62" />
        {[176, 206, 236, 266, 296].map((y) => (
          <circle key={y} cx="415" cy={y} r="2.2" fill="#F6E7CF" opacity=".8" />
        ))}

        {/* the customer's arm comes out of the door */}
        <g className="pxn13-armc">
          <rect x="296" y="193" width="132" height="30" rx="13" fill={`url(#${id}s)`} />
          <path d="M318 196v24M334 196v24" stroke="#E6D3B4" strokeWidth="2" strokeLinecap="round" />
          <rect x="296" y="193" width="10" height="30" rx="3" fill="#C8643B" />
          <path d={HAND} transform="translate(450 -12) scale(-1 1)" fill="#D39A6A" />
          <path d={THUMB} transform="translate(450 -12) scale(-1 1)" fill="#C58A5B" />
          <path d="M274 203h-17M276 209h-17" stroke="#A9714A" strokeWidth="1.8" strokeLinecap="round" opacity=".55" />
        </g>

        {/* the tiled frame of the door (Algerian zellige), its stars draw themselves */}
        <path d="M292 312V148a78 78 0 0 1 156 0v164h-20V152a58 58 0 0 0-116 0v160z" fill="#C8643B" />
        {STARS.map(([x, y], i) => (
          <g key={i} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
            <polygon className="pxn13-st" style={{ animationDelay: `${i * 55}ms` }} points={star(8, 4.6)} fill={i % 2 ? '#F6E7CF' : '#1B2A47'} />
          </g>
        ))}

        <path className="pxn13-arc" d={RING_ARC} fill="none" stroke="#C8643B" strokeWidth="18" strokeLinecap="round" strokeOpacity=".16" />
        <path className="pxn13-arc" d={RING_ARC} fill="none" stroke="#C8643B" strokeWidth="1.5" strokeDasharray="2 6" strokeOpacity=".5" />
        {RING.map(([x, y], i) => (
          <g key={`r${i}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
            <polygon className="pxn13-st pxn13-rs" style={{ animationDelay: `${700 + i * 60}ms` }} points={star(7, 4)} fill={i % 2 ? '#1B2A47' : '#C8643B'} />
          </g>
        ))}

        {/* the dinar note (rests in the courier's hand) */}
        <g transform="translate(172 238)">
          <g className="pxn13-note">
            <rect x="-36" y="-18" width="72" height="36" rx="4" fill="#2F7D62" />
            <rect x="-31" y="-13" width="62" height="26" rx="3" fill="none" stroke="#9FD3BC" strokeWidth="1.4" />
            <circle cx="-22" cy="0" r="5.5" fill="#9FD3BC" opacity=".6" />
            <text x="9" y="7.5" textAnchor="middle" className="pxn13-cur">
              {t('cur')}
            </text>
          </g>
        </g>
        {/* the courier's arm comes in from the street (faded at the edge) */}
        <g mask={`url(#${id}m)`}>
          <g className="pxn13-armk">
            <rect x="-150" y="205" width="304" height="30" rx="13" fill="#1B2A47" />
            <rect x="138" y="205" width="12" height="30" rx="3" fill="#F7A823" />
            <path d="M60 209v22M90 209v22" stroke="#2C3D60" strokeWidth="2" strokeLinecap="round" />
            <path d={HAND} fill="#B77A4F" />
            <path d={THUMB} fill="#A66C43" />
            <path d="M178 214h17M176 220h17" stroke="#8E5A36" strokeWidth="1.8" strokeLinecap="round" opacity=".55" />
          </g>
        </g>

        {/* the parcel (rests on the customer's hand) */}
        <g transform="translate(282 160)">
          <g className="pxn13-parcel">
            <path d="M-35-28l10-10h70l-10 10z" fill="#FBC45E" />
            <path d="M35-28l10-10v56l-10 10z" fill="#C27B0E" />
            <rect x="-35" y="-28" width="70" height="56" rx="3" fill="#F7A823" />
            <rect x="-5" y="-28" width="10" height="56" fill="#D98C12" />
            <rect x="-28" y="-2" width="26" height="20" rx="3" fill="#fff" />
            <path d="M-24 4h18M-24 10h12" stroke="#1B2A47" strokeWidth="2" strokeLinecap="round" />
          </g>
        </g>

      </svg>
      {/* the two picture labels, shown once the swap is done */}
      <span className="pxn13-chip pxn13-chip1" dir={t('dir')}>
        {t('cod')}
      </span>
      <span className="pxn13-chip pxn13-chip2" dir={t('dir')}>
        {t('cash')}
      </span>
    </div>
  );
}

function Headline({ t }: { t: T }) {
  return (
    <h2 className="pxn13-h" dir={t('dir')}>
      <span>{t('a')}</span> <span className="pxn13-hl">{t('b')}</span>
    </h2>
  );
}

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'end',
  // The whole page: warm ground, a zellige band along the start edge, a flat quiet zone under the card, and the scene
  // with its words. No Copy: the words sit in the Visual so they are centred on the first screen, not on the page height.
  Visual: ({ t }) => (
    <div className="pxn13-root">
      <div className="pxn13-sun" />
      <svg className="pxn13-field" aria-hidden="true">
        <defs>
          <Tile id="pxn13-tf" />
        </defs>
        <rect width="100%" height="100%" fill="url(#pxn13-tf)" />
      </svg>
      <svg className="pxn13-band pxn13-band-v" aria-hidden="true">
        <defs>
          <Tile id="pxn13-tv" />
        </defs>
        <rect width="100%" height="100%" fill="url(#pxn13-tv)" />
      </svg>
      <div className="pxn13-quiet" />
      {/* computer: the handover above the words, centred in the free space beside the card and on the first screen */}
      <div className="pxn13-desk">
        <div className="pxn13-col">
          <Scene t={t} id="pxn13-d" />
          <Headline t={t} />
          <p className="pxn13-sub" dir={t('dir')}>
            {t('sub')}
          </p>
          <div className="pxn13-proof" dir={t('dir')}>
            <span className="pxn13-pill">{t('langs')}</span>
            <span className="pxn13-couriers">{t('couriers')}</span>
          </div>
        </div>
      </div>
      {/* phones and tablets: the handover and the headline in a band above the card */}
      <div className="pxn13-ph">
        <Scene t={t} id="pxn13-p" />
        <Headline t={t} />
      </div>
    </div>
  ),
};
export default theme;
