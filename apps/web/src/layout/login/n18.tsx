/** @jsxRuntime automatic */
// Theme 18 · « إعلانات منافسيك مكشوفة أمامك. » — a dark wall of blurred ads; the AI Spy lens drifts over it and
// every ad under the lens is sharp (product + « إعلان نشط »). The lens is a window: it moves by +d and the sharp copy of
// the wall inside it moves by -d (transform only), so the ad under the lens centre sits on its blurred twin; the copy is
// magnified x1.1 like a real loupe, so content near the rim is pushed out by up to 0.1 R.
import type { CSSProperties, ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

// days each sample ad has been running (all between 11 and 99, so the Arabic « يومًا » form is always right)
const DAYS = [23, 41, 18, 31, 14, 45, 27, 60];
// which product sits on tile (i, j): side and diagonal neighbours never repeat, so the 4 tiles the lens stops on
// (0,0) (1,0) (0,1) (1,1) show 4 different products; tile (0, 0), under the lens at rest, is the kids' product
const kind = (i: number, j: number) => (((i * 3 + j * 2) % 8) + 8) % 8;
const pos = (i: number, j: number) => ({ '--i': i, '--j': j }) as CSSProperties;

/** The eight sample products, flat drawings on a 64×64 grid. */
function Prod({ k }: { k: number }) {
  const s = { viewBox: '0 0 64 64', 'aria-hidden': true } as const;
  switch (k) {
    case 0: // teddy bear (kids)
      return (
        <svg {...s}>
          <circle cx="19" cy="17" r="7" fill="#B9773A" /><circle cx="45" cy="17" r="7" fill="#B9773A" />
          <ellipse cx="32" cy="47" rx="15" ry="12" fill="#C98A4B" />
          <circle cx="32" cy="28" r="14" fill="#C98A4B" />
          <ellipse cx="32" cy="33" rx="7" ry="5" fill="#F1D3AE" />
          <circle cx="27" cy="25" r="2" fill="#1B2A47" /><circle cx="37" cy="25" r="2" fill="#1B2A47" /><circle cx="32" cy="31.5" r="2" fill="#1B2A47" />
          <path d="M26 42h12l-6 5z" fill="#F7A823" />
        </svg>
      );
    case 1: // sneaker
      return (
        <svg {...s}>
          <path d="M8 40c0-8 3-16 8-18l8 6c4 3 10 4 16 5 9 1 16 4 16 9v4H8z" fill="#2F5BD3" />
          <path d="M8 44h48v5a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z" fill="#FFFFFF" stroke="#1B2A47" strokeWidth="2" />
          <path d="M22 30l4 3M27 27l4 3M32 31l3 2" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case 2: // watch
      return (
        <svg {...s}>
          <rect x="24" y="4" width="16" height="56" rx="6" fill="#1B2A47" />
          <circle cx="32" cy="32" r="15" fill="#FFFFFF" stroke="#33415C" strokeWidth="4" />
          <path d="M32 24v8l6 4" stroke="#B85A0B" strokeWidth="3" strokeLinecap="round" fill="none" />
        </svg>
      );
    case 3: // perfume
      return (
        <svg {...s}>
          <rect x="27" y="6" width="10" height="9" rx="2" fill="#1B2A47" />
          <rect x="24" y="14" width="16" height="6" rx="2" fill="#C9D2E3" />
          <rect x="14" y="20" width="36" height="38" rx="10" fill="#E58FB0" />
          <rect x="21" y="30" width="22" height="14" rx="4" fill="#FFFFFF" opacity=".85" />
        </svg>
      );
    case 4: // blender
      return (
        <svg {...s}>
          <path d="M18 8h28l-4 34H22z" fill="#CFEAF7" stroke="#2F5BD3" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M21 26h22" stroke="#2F5BD3" strokeWidth="2" />
          <rect x="16" y="42" width="32" height="16" rx="5" fill="#1B2A47" />
          <circle cx="32" cy="50" r="3.5" fill="#F7A823" />
        </svg>
      );
    case 5: // handbag
      return (
        <svg {...s}>
          <path d="M23 24v-5a9 9 0 0 1 18 0v5" fill="none" stroke="#7A3A08" strokeWidth="4" strokeLinecap="round" />
          <path d="M12 24h40l-4 32H16z" fill="#B85A0B" />
          <rect x="28" y="32" width="8" height="6" rx="2" fill="#F7A823" />
        </svg>
      );
    case 6: // sunglasses
      return (
        <svg {...s}>
          <path d="M6 26h52" stroke="#1B2A47" strokeWidth="3" strokeLinecap="round" />
          <path d="M9 26h19v6a9 9 0 0 1-19 0zM36 26h19v6a9 9 0 0 1-19 0z" fill="#1B2A47" />
          <path d="M13 30l6-3M40 30l6-3" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" opacity=".6" />
        </svg>
      );
    default: // cream jar
      return (
        <svg {...s}>
          <rect x="14" y="18" width="36" height="10" rx="4" fill="#15803D" />
          <rect x="16" y="27" width="32" height="27" rx="7" fill="#FFFFFF" stroke="#C9D2E3" strokeWidth="2" />
          <path d="M24 40h16" stroke="#15803D" strokeWidth="3" strokeLinecap="round" />
        </svg>
      );
  }
}

/** One ad, sharp (inside the lens). */
function Ad({ t, i, j }: { t: T; i: number; j: number }) {
  const k = kind(i, j);
  const hero = i === 0 && j === 0;
  return (
    <div className={`pxn18-t pxn18-ad pxn18-k${k}`} style={pos(i, j)}>
      <div className="pxn18-ad-hd">
        <i />
        <span dir={t('dir')}>
          <b>{t(`shop${k}`)}</b>
          <small>{t('since', { n: DAYS[k] })}</small>
        </span>
      </div>
      <div className="pxn18-ad-im">
        <Prod k={k} />
        {hero && (
          <em className="pxn18-cat" dir={t('dir')}>
            {t('kids')}
          </em>
        )}
        <b className="pxn18-price" dir={t('dir')}>
          {t(`price${k}`)}
        </b>
      </div>
      <div className="pxn18-ad-ft" dir={t('dir')}>
        <span className="pxn18-chip">
          <i />
          {t('active')}
        </span>
      </div>
    </div>
  );
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, n) => a + n);

/** The lens: a moving window (+d) on a sharp copy of the wall that moves back (-d), magnified ×1.1 at its centre. */
function Lens({ t, cls, children }: { t: T; cls: string; children: ReactElement | ReactElement[] }) {
  return (
    <div className={`pxn18-lx ${cls}`}>
      <div className="pxn18-ly">
        <div className="pxn18-glass">
          <div className="pxn18-mag">
            <div className="pxn18-cx">
              <div className="pxn18-cy">{children}</div>
            </div>
          </div>
        </div>
        <div className="pxn18-rim" />
        <div className="pxn18-badge" dir="ltr">
          <i />
          {t('spy')}
        </div>
      </div>
    </div>
  );
}

/** Phone tile: the product on top, the « إعلان نشط » chip centred under it. */
function PhAd({ t, i, j, k, sharp }: { t: T; i: number; j: number; k: number; sharp?: boolean }) {
  const st = { '--i': i, '--j': j } as CSSProperties;
  return sharp ? (
    <div className={`pxn18-pt pxn18-r${j} pxn18-pad pxn18-k${k}`} style={st}>
      <Prod k={k} />
      <span className="pxn18-chip" dir={t('dir')}>
        <i />
        {t('active')}
      </span>
    </div>
  ) : (
    <i className={`pxn18-pt pxn18-r${j} pxn18-b pxn18-k${k}`} style={st} />
  );
}
const PH: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 2],
  [0, 1, 1],
  [1, 1, 3],
];

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'end',
  Visual: ({ t }) => (
    <div className="pxn18">
      {/* computer: the whole wall, blurred (no text in it: what is blurred is really hidden) */}
      <div className="pxn18-wall">
        <div className="pxn18-org">
          {range(-7, 7).map((i) =>
            range(-2, 7).map((j) => <i key={`${i}.${j}`} className={`pxn18-t pxn18-b pxn18-k${kind(i, j)}`} style={pos(i, j)} />),
          )}
        </div>
      </div>
      <div className="pxn18-scr" />
      <div className="pxn18-cscr" />
      <Lens t={t} cls="pxn18-dl">
        <div className="pxn18-org">{range(-3, 3).map((i) => range(-3, 3).map((j) => <Ad key={`${i}.${j}`} t={t} i={i} j={j} />))}</div>
      </Lens>
      {/* phone without :has(): a still, text-free emblem inside the shell's top 12vh */}
      <div className="pxn18-mini" aria-hidden="true">
        <i />
        <b>
          <Prod k={0} />
        </b>
        <i />
      </div>
      {/* phone: the lens over a grid of 4 ads, the headline under it */}
      <div className="pxn18-ph">
        <div className="pxn18-pbox">
          <div className="pxn18-pst">
            <div className="pxn18-porg">
              {PH.map(([i, j, k]) => (
                <PhAd key={`${i}${j}`} t={t} i={i} j={j} k={k} />
              ))}
            </div>
            <Lens t={t} cls="pxn18-pl">
              <div className="pxn18-porg pxn18-pin">
                {PH.map(([i, j, k]) => (
                  <PhAd key={`${i}${j}`} t={t} i={i} j={j} k={k} sharp />
                ))}
              </div>
            </Lens>
          </div>
        </div>
        <p className="pxn18-ph-h" dir={t('dir')}>
          {t('a')} <span>{t('b')}</span>
        </p>
      </div>
    </div>
  ),
  Copy: ({ t }) => (
    <div className="pxn18-copy" dir={t('dir')}>
      <span className="pxn18-tag" dir="ltr">
        <i />
        {t('spy')}
      </span>
      <h2 className="pxn18-h">
        {t('a')} <span>{t('b')}</span>
      </h2>
      <p className="pxn18-p">{t('sub')}</p>
    </div>
  ),
};
export default theme;
