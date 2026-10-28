// Theme 2 · «The cancelled parcel finds a new buyer» (framing effect).
// One idea: the railway switch that saves the parcel.
// Stage = 560×620. The scene is drawn once, left-to-right, around a junction at the stage centre
// (x 280, y 490); in Arabic (dir="rtl") the whole scene is mirrored by CSS (--pxn02-x: -1) and every
// word inside it is flipped back (.pxn02-flip), so the drawing needs no second version.
// Every element's resting style is the FINAL frame (used by prefers-reduced-motion); the keyframes
// in theme.css only describe how it gets there. Timeline: see the header of theme.css.
// The pragma below pins this file to React's automatic JSX runtime. esbuild (Vite) and tsx both honour it,
// so it overrides the project's JSX setting for this file. It matches the app's current setup and lets the
// test harness compile the file outside the app's tsconfig. If the app ever changes its JSX runtime or
// jsxImportSource, delete this line so the file follows the project setting again.
/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 90% at 78% 72%, #2A4070 0%, #1B2A47 52%, #131F36 100%)',
  Visual: ({ t }) => (
    <div className="pxn02">
      <div className="pxn02-copy">
        <h2 className="pxn02-h">
          <span className="pxn02-q">{t('q')}</span> <span>{t('a')}</span> <span className="pxn02-or">{t('b')}</span>
        </h2>
        <p className="pxn02-sub">{t('sub')}</p>
      </div>

      <div className="pxn02-zoom">
        <div className="pxn02-scene">
          <svg className="pxn02-svg" viewBox="0 0 560 620" width="560" height="620" aria-hidden="true">
            <defs>
              <radialGradient id="pxn02-halo-g">
                <stop offset="0" stopColor="#F7A823" stopOpacity=".55" />
                <stop offset="1" stopColor="#F7A823" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* the old way: straight on, back to the depot (dims when the switch flips) */}
            <g className="pxn02-old">
              <path d="M280 490 H1240" stroke="#22345A" strokeWidth="46" fill="none" />
              <path d="M300 490 H1240" stroke="#33497A" strokeWidth="2" strokeDasharray="12 12" fill="none" />
              <g className="pxn02-ret" transform="translate(520 490)">
                <circle r="19" fill="#131F36" stroke="#4A5F8E" strokeWidth="2" />
                <path d="M6 -6 H-3 a6 6 0 0 0 0 12 H5 M-1 -11 L-6 -6 L-1 -1" fill="none" stroke="#8D9BB8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            </g>

            {/* the incoming road and the new branch towards the second house */}
            <path d="M-680 490 H280" stroke="#22345A" strokeWidth="46" fill="none" strokeLinecap="round" />
            <path d="M-680 490 H262" stroke="#33497A" strokeWidth="2" strokeDasharray="12 12" fill="none" />
            {/* the switch blade: drawn flat along the old road (x 280 → 478, length 198), CSS swings it
                open around the junction (280, 490) to -29.66deg, so it ends at the new door (452, 392).
                Before the flip it lies on the old road and cannot be seen: the road really splits. */}
            <g className="pxn02-blade">
              {/* phone only: the branch runs on past the top of the band (the house is hidden there) */}
              <path className="pxn02-ext" d="M478 490 H860" stroke="#22345A" strokeWidth="46" fill="none" strokeLinecap="round" />
              <path d="M280 490 H478" stroke="#22345A" strokeWidth="46" fill="none" strokeLinecap="round" />
              <g className="pxn02-new">
                <path d="M280 490 H478" stroke="#F7A823" strokeOpacity=".16" strokeWidth="46" strokeLinecap="round" fill="none" />
                <path d="M301 490 H460" stroke="#F7A823" strokeWidth="5" strokeDasharray="14 10" strokeLinecap="round" fill="none" />
                <path className="pxn02-ext" d="M478 490 H860" stroke="#F7A823" strokeOpacity=".16" strokeWidth="46" fill="none" />
                <path className="pxn02-ext" d="M484 490 H860" stroke="#F7A823" strokeWidth="5" strokeDasharray="14 10" fill="none" />
              </g>
            </g>

            {/* the second house, which lights up */}
            <g className="pxn02-house">
              <circle className="pxn02-halo" cx="452" cy="346" r="118" fill="url(#pxn02-halo-g)" />
              <path d="M402 324 L452 280 L502 324 Z" fill="#F7A823" />
              <rect x="412" y="318" width="80" height="74" rx="6" fill="#EEF2F8" />
              <rect x="440" y="354" width="24" height="38" rx="4" fill="#1B2A47" />
              <rect x="421" y="332" width="16" height="15" rx="3" fill="#C9D2E3" />
              <rect x="467" y="332" width="16" height="15" rx="3" fill="#C9D2E3" />
              <g className="pxn02-lit">
                <rect x="421" y="332" width="16" height="15" rx="3" fill="#F7A823" />
                <rect x="467" y="332" width="16" height="15" rx="3" fill="#F7A823" />
                <rect x="440" y="354" width="24" height="38" rx="4" fill="#FBC45E" />
              </g>
            </g>
          </svg>

          {/* where the parcel was cancelled: a dashed outline and the stamp stay behind (the "before").
              Two layers of the same stamp: the loud red one (now) cross-fades into a quiet, struck-through
              one (the past) once the parcel leaves. Resting = the past one. */}
          <div className="pxn02-ghost" />
          <div className="pxn02-pos pxn02-at-stamp">
            <div className="pxn02-stamp-in">
              <div className="pxn02-flip pxn02-stamps">
                <div className="pxn02-stamp pxn02-now">{t('stamp')}</div>
                <div className="pxn02-stamp pxn02-was">{t('stamp')}</div>
              </div>
            </div>
          </div>

          {/* the switch */}
          <div className="pxn02-knob">
            <i className="pxn02-ring" />
            <svg className="pxn02-arrow" viewBox="-20 -20 40 40" aria-hidden="true">
              <path d="M-11 0 H10 M2 -8 L10 0 L2 8" fill="none" stroke="#B85A0B" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="pxn02-pos pxn02-at-swap">
            <div className="pxn02-chip-in">
              <div className="pxn02-flip pxn02-chip">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 11V5.5a2 2 0 0 1 4 0V11l4.2.9a2 2 0 0 1 1.6 2.2l-.6 4.4A3 3 0 0 1 15.2 21H11a3 3 0 0 1-2.4-1.2L5.4 15.6a1.8 1.8 0 0 1 2.6-2.4L9 14.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{t('swap')}</span>
              </div>
            </div>
          </div>

          <div className="pxn02-pos pxn02-at-buyer">
            <div className="pxn02-buyer-in">
              <div className="pxn02-flip pxn02-chip pxn02-ok">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{t('buyer')}</span>
              </div>
            </div>
          </div>

          {/* the parcel: it rests at the new door */}
          <div className="pxn02-parcel">
            <div className="pxn02-box">
              <svg viewBox="0 0 72 64" aria-hidden="true">
                <path d="M36 4 L68 18 L36 32 L4 18 Z" fill="#FBC45E" />
                <path d="M4 18 L36 32 V62 L4 48 Z" fill="#E39A1C" />
                <path d="M68 18 L36 32 V62 L68 48 Z" fill="#C27B0E" />
                <path d="M20 11 L52 25 V36 L46 38.6 V28 L14 14 Z" fill="#F7E3B8" opacity=".85" />
                <rect x="10" y="33" width="15" height="9" rx="2" transform="skewY(24)" fill="#fff" opacity=".9" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  ),
};
export default theme;
