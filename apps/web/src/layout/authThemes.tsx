// The 20 designs of the sign-in and sign-up pages (the control room turns each one on or off; every visit draws one of
// those turned on, at random). A design is the picture beside the form ("split": a panel on one side) or behind it
// ("overlay": the whole page, the form in a card). The pictures are drawn here in CSS (authThemes.css), no images. A
// split picture is drawn on a fixed stage that is scaled to its panel, so it looks the same on a computer and, smaller,
// above the form on a phone.
import { CSSProperties, ReactElement, ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY, signupInfo } from '../lib/backend';
import { BrandBig } from './PxWordmark';
import './authThemes.css';

export type ThemeLayout = 'split' | 'overlay';
export interface AuthTheme {
  id: number;
  layout: ThemeLayout;
  /** split: the picture's side (start = before the form). overlay: where the card sits */
  side: 'start' | 'end' | 'center';
  /** the form card on a dark ground (overlay) */
  dark?: boolean;
  /** the panel's colour (split) */
  panel?: string;
  /** a light picture on the panel (split): the panel's text is dark */
  light?: boolean;
  Visual: (p: { t: T }) => ReactElement;
  /** overlay: words beside the card on a computer */
  Copy?: (p: { t: T }) => ReactElement;
}
type T = (k: string, o?: Record<string, unknown>) => string;

/** The number of designs. */
export const THEME_COUNT = 20;
const ALL = Array.from({ length: THEME_COUNT }, (_, i) => i + 1);
const LOCAL = 'px-login-designs';

/** The designs turned on: the server's list (the control room), or in the preview the one kept on this computer. */
export function localDesigns(): number[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL) || 'null');
    return Array.isArray(v) && v.length ? v.filter((n) => Number.isInteger(n) && n >= 1 && n <= THEME_COUNT) : null;
  } catch {
    return null;
  }
}
export function saveLocalDesigns(list: number[]) {
  try {
    localStorage.setItem(LOCAL, JSON.stringify(list));
  } catch {
    /* private window: the list lasts until the page closes */
  }
}

// one design per page load (the same one while the person goes between sign-in, sign-up and « mot de passe oublié »)
let drawn: number | null = null;
const draw = (list: number[]) => list[Math.floor(Math.random() * list.length)] ?? 1;

/** The design of this visit: drawn once among those turned on (the last known list first, the server's when it answers). */
export function useAuthTheme(): AuthTheme {
  const [id, setId] = useState<number>(() => {
    if (drawn === null) drawn = draw(localDesigns() ?? ALL);
    return drawn;
  });
  useLayoutEffect(() => {
    if (DEMO_ONLY) return;
    let on = true;
    signupInfo().then((r) => {
      if (!on || !r.designs?.length) return;
      saveLocalDesigns(r.designs);
      if (!r.designs.includes(drawn ?? 0)) {
        drawn = draw(r.designs);
        setId(drawn);
      }
    });
    return () => {
      on = false;
    };
  }, []);
  return THEMES.find((x) => x.id === id) ?? THEMES[0];
}

/** The words of the pictures (a plain function: what the designs need). */
function useT(): T {
  const { t } = useTranslation();
  return (k, o) => String(t(k, o as any));
}

/** A fixed drawing (w × h) scaled to fill its box: the same picture on any screen. */
function Stage({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(0.8);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setS(Math.min(r.width / w, r.height / h, 1.3));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <div ref={box} className="pxt-stagebox">
      <div className="pxt-stage" style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${s})` }}>
        {children}
      </div>
    </div>
  );
}

/** The split panel of a design: its colour and its picture. */
export function ThemePanel({ theme }: { theme: AuthTheme }) {
  const t = useT();
  return (
    <aside className={`pxt-vis ${theme.light ? 'pxt-vis-light' : ''}`} style={{ background: theme.panel }} aria-hidden="true">
      <Stage w={560} h={620}>
        <theme.Visual t={t} />
      </Stage>
    </aside>
  );
}

/** The whole-page ground of an overlay design, and its words. */
export function ThemeGround({ theme }: { theme: AuthTheme }) {
  const t = useT();
  return (
    <>
      <div className="pxt-bg" aria-hidden="true">
        <theme.Visual t={t} />
      </div>
      {theme.Copy && (
        <div className="pxt-copy">
          <theme.Copy t={t} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- small drawings used by several designs
const Pkg = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
    <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
    <path d="m3 8 9 5 9-5M12 13v8" />
  </svg>
);
const Truck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
    <path d="M3 7h13v10H3z" />
    <path d="M16 10h4l1 3v4h-5" />
    <circle cx="7" cy="18" r="2" />
    <circle cx="18" cy="18" r="2" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12 5 5L20 7" />
  </svg>
);
const Swap = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 4 3 8l4 4" />
    <path d="M3 8h14" />
    <path d="m17 20 4-4-4-4" />
    <path d="M21 16H7" />
  </svg>
);
/** A parcel box in 3D (the faces of a cube). */
const Cube = ({ size, className = '' }: { size: number; className?: string }) => (
  <div className={`pxt-cube ${className}`} style={{ width: size, height: size, ['--h' as string]: `${size / 2}px` } as CSSProperties}>
    <i />
    <i />
    <i />
    <i />
    <i />
    <i />
  </div>
);
const Bars = ({ n = 7, h = [40, 58, 50, 70, 62, 84, 94] }: { n?: number; h?: number[] }) => (
  <div className="pxt-bars">
    {h.slice(0, n).map((v, k) => (
      <i key={k} style={{ height: `${v}%`, animationDelay: `${k * 0.1}s` }} className={k % 2 ? 'or' : ''} />
    ))}
  </div>
);
const ORDERS: [string, string, string][] = [
  ['Amina B.', 'Sétif', '7 700 DA'],
  ['Yacine K.', 'Oran', '12 600 DA'],
  ['Sara M.', 'Alger', '4 550 DA'],
  ['Nadir H.', 'Blida', '9 300 DA'],
];
/** The map of Algeria (simplified) with its pins. */
const ALGERIA = 'M150 20 L380 14 L430 40 L440 120 L470 220 L500 300 L420 360 L330 430 L270 420 L120 300 L40 250 L30 160 L80 110 L110 60 Z';

const H = ({ a, b, dark }: { a: string; b?: string; dark?: boolean }) => (
  <h2 className={`pxt-h ${dark ? 'on-dark' : ''}`}>
    {a} {b && <span className="pxt-hl">{b}</span>}
  </h2>
);

// ---------------------------------------------------------------- the 20 designs
export const THEMES: AuthTheme[] = [
  // 1 · the old card, with 3D parcels flying around it
  {
    id: 1,
    layout: 'overlay',
    side: 'center',
    Visual: () => (
      <div className="pxt1">
        <div className="pxt-drift" style={{ left: '12%', top: '18%' }}>
          <Cube size={90} className="spin" />
        </div>
        <div className="pxt-drift d2" style={{ left: '18%', top: '68%' }}>
          <Cube size={60} className="spin rev" />
        </div>
        <div className="pxt-drift d3" style={{ right: '14%', top: '24%' }}>
          <Cube size={120} className="spin slow" />
        </div>
        <div className="pxt-drift d1" style={{ right: '22%', bottom: '12%' }}>
          <Cube size={48} className="spin" />
        </div>
      </div>
    ),
  },
  // 2 · the dashboard, tilted and swaying, with a « new order » toast
  {
    id: 2,
    layout: 'split',
    side: 'end',
    panel: '#1B2A47',
    Visual: ({ t }) => (
      <div className="pxt2">
        <H a={t('auth.show1')} b={t('auth.show2')} dark />
        <div className="pxt2-dash">
          <div className="pxt2-nav">
            <span className="or" />
            <span />
            <span />
            <span />
          </div>
          <div className="pxt2-main">
            <div className="pxt-kpis">
              <div>
                <small>{t('auth.k1')}</small>
                <b>128</b>
              </div>
              <div>
                <small>{t('auth.k2')}</small>
                <b className="ok">86 %</b>
              </div>
              <div>
                <small>{t('auth.k3')}</small>
                <b>412 600 DA</b>
              </div>
            </div>
            <Bars />
          </div>
          <div className="pxt-toast">
            <span className="pxt-toast-ic">
              <Pkg />
            </span>
            <span>
              <b>{t('auth.toast', { ref: 'PX01051', city: 'Sétif' })}</b>
              <small>{t('auth.toastNow')}</small>
            </span>
          </div>
        </div>
      </div>
    ),
  },
  // 3 · a big 3D parcel turning
  {
    id: 3,
    layout: 'split',
    side: 'start',
    panel: '#FFF3DF',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt3">
        <div className="pxt3-bob">
          <div className="pxt3-cube">
            <div className="f1">
              <span className="tape" />
              <span className="lbl">PX01051 · Sétif</span>
            </div>
            <div className="f2" />
            <div className="f3">pilotix</div>
            <div className="f4">FRAGILE</div>
            <div className="f5">
              <span className="tape" />
            </div>
            <div className="f6" />
          </div>
        </div>
        <div className="pxt3-shadow" />
        <h2 className="pxt-h center">{t('auth.th.t3')}</h2>
        <p className="pxt-p center">{t('auth.th.t3s')}</p>
      </div>
    ),
  },
  // 4 · Pilotix's tools orbiting around the logo
  {
    id: 4,
    layout: 'split',
    side: 'start',
    panel: '#1B2A47',
    Visual: ({ t }) => (
      <div className="pxt4">
        <div className="pxt4-glow" />
        <div className="pxt4-orb">
          <div className="pxt4-spin">
            <div className="pxt4-ring" />
            {[
              ['230px, 0', 'confirmation'],
              ['71px, 219px', 'delivery'],
              ['-186px, 135px', 'caisse'],
              ['-186px, -135px', 'depot'],
              ['71px, -219px', 'whatsapp'],
            ].map(([p, k]) => (
              <div key={k} className="pxt4-sat" style={{ transform: `translate(${p})` }}>
                <span>{t(`auth.th.tool.${k}`)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="pxt4-logo">
          <BrandBig />
        </div>
        <p className="pxt4-cap">{t('auth.th.t4')}</p>
      </div>
    ),
  },
  // 5 · frosted glass over moving colours
  {
    id: 5,
    layout: 'overlay',
    side: 'end',
    dark: true,
    Visual: () => (
      <div className="pxt5">
        <i className="b1" />
        <i className="b2" />
        <i className="b3" />
      </div>
    ),
    Copy: ({ t }) => (
      <>
        <h2 className="pxt-big on-dark">
          {t('auth.show1')}
          <br />
          {t('auth.show2')}
        </h2>
        <p className="pxt-p on-dark">{t('auth.th.t5s')}</p>
      </>
    ),
  },
  // 6 · a small 3D city with trucks driving
  {
    id: 6,
    layout: 'split',
    side: 'start',
    panel: '#F4F6FA',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt6">
        <H a={t('auth.th.t6a')} b={t('auth.th.t6b')} />
        <p className="pxt-p">{t('auth.th.t6s')}</p>
        <div className="pxt6-plane">
          <div className="road h" />
          <div className="road v" />
          <div className="pxt6-car c1">
            <Bld w={36} d={16} h={16} c="o" />
          </div>
          <div className="pxt6-car c2">
            <Bld w={16} d={30} h={14} c="w" />
          </div>
          <Bld x={30} y={30} w={70} d={70} h={90} c="n" />
          <Bld x={120} y={40} w={56} d={56} h={50} c="s" k={1} />
          <Bld x={270} y={30} w={120} d={70} h={60} c="w" k={2} />
          <Bld x={40} y={280} w={110} d={110} h={40} c="o" k={3} />
          <Bld x={280} y={270} w={60} d={60} h={110} c="n" k={4} />
          <Bld x={360} y={300} w={50} d={90} h={34} c="w" k={5} />
          <div className="pxt6-ping" />
        </div>
      </div>
    ),
  },
  // 7 · a 3D phone with notifications popping
  {
    id: 7,
    layout: 'split',
    side: 'end',
    panel: '#F7A823',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt7">
        <div className="pxt7-ring" />
        <div className="pxt7-phone">
          <div className="back" />
          <div className="body">
            <div className="screen">
              <div className="notch" />
              <b className="ttl">{t('auth.phTitle')}</b>
              <div className="pxt7-two">
                <div>
                  <small>{t('auth.th.new')}</small>
                  <b>42</b>
                </div>
                <div className="or">
                  <small>{t('auth.th.recall')}</small>
                  <b>9</b>
                </div>
              </div>
              {ORDERS.slice(0, 3).map(([n, , v]) => (
                <div key={n} className="row">
                  <b>{n}</b>
                  <span>{v}</span>
                </div>
              ))}
              <div className="cta">{t('auth.th.callNext')}</div>
            </div>
          </div>
          <div className="pxt7-note n1">
            <span className="ic or">
              <Pkg />
            </span>
            <span>
              <b>{t('auth.th.n1')}</b>
              <small>#PX01051 · 7 700 DA</small>
            </span>
          </div>
          <div className="pxt7-note n2">
            <span className="ic ok">
              <Check />
            </span>
            <span>
              <b>{t('auth.th.n2')}</b>
              <small>{t('auth.th.n2s')}</small>
            </span>
          </div>
          <div className="pxt7-note n3">
            <span className="ic bl">
              <Truck />
            </span>
            <span>
              <b>{t('auth.th.n3')}</b>
              <small>{t('auth.th.n3s')}</small>
            </span>
          </div>
        </div>
      </div>
    ),
  },
  // 8 · a conveyor belt carrying parcels
  {
    id: 8,
    layout: 'overlay',
    side: 'end',
    Visual: () => (
      <div className="pxt8">
        <div className="belt" />
        <div className="base" />
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className="pk" style={{ animationDelay: `${-k * 3}s` }}>
            <Cube size={70} className="wob" />
          </div>
        ))}
      </div>
    ),
    Copy: ({ t }) => (
      <>
        <span className="pxt-tag">{t('auth.th.live')}</span>
        <h2 className="pxt-big">{t('auth.th.t8')}</h2>
        <p className="pxt-p">{t('auth.th.t8s')}</p>
      </>
    ),
  },
  // 9 · the map of Algeria, routes drawing themselves
  {
    id: 9,
    layout: 'split',
    side: 'end',
    panel: '#0E1B2E',
    Visual: ({ t }) => (
      <div className="pxt9">
        <H a={t('auth.th.t9a')} b={t('auth.th.t9b')} dark />
        <p className="pxt-p on-dark">{t('auth.th.t9s')}</p>
        <div className="pxt9-map">
          <svg viewBox="0 0 520 440">
            <defs>
              <pattern id="pxt9d" width="12" height="12" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="1.6" fill="#2F4570" />
              </pattern>
            </defs>
            <path d={ALGERIA} fill="url(#pxt9d)" stroke="#3A5280" strokeWidth="2" />
            {['M215 30 Q260 40 300 70', 'M215 30 Q160 40 120 70', 'M215 30 Q250 210 330 380', 'M215 30 Q330 60 400 60', 'M215 30 Q180 150 210 230'].map((d, k) => (
              <path key={k} className="rt" d={d} style={{ animationDelay: `${k * 0.6}s` }} />
            ))}
            <circle cx="215" cy="30" r="8" fill="#F7A823" />
            <circle className="pl" cx="215" cy="30" r="6" />
            {[
              [300, 70, 'Sétif'],
              [120, 70, 'Oran'],
              [330, 380, 'Tamanrasset'],
              [400, 60, 'Annaba'],
              [210, 230, 'Ghardaïa'],
            ].map(([x, y, n], k) => (
              <g key={String(n)}>
                <circle cx={x as number} cy={y as number} r="6" fill="#7EE2A8" />
                {k < 3 && <circle className="pl" cx={x as number} cy={y as number} r="6" style={{ animationDelay: `${0.5 + k * 0.5}s` }} />}
                <text x={(x as number) + 10} y={(y as number) + 18} fill="#C9D2E3" fontSize="12">
                  {n}
                </text>
              </g>
            ))}
            <text x="228" y="26" fill="#fff" fontSize="14" fontWeight="700">
              Alger
            </text>
          </svg>
        </div>
      </div>
    ),
  },
  // 10 · a 3D stack of orders moving forward
  {
    id: 10,
    layout: 'split',
    side: 'start',
    panel: '#E9EDF4',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt10">
        <H a={t('auth.th.t10a')} b={t('auth.th.t10b')} />
        <div className="pxt10-stack">
          {(
            [
              ['new', 'or', 25, 0],
              ['confirmed', 'ok', 50, 1],
              ['delivery', 'bl', 75, 2],
              ['paid', 'nv', 100, 3],
            ] as const
          ).map(([k, c, p, i]) => {
            const [n, w, v] = ORDERS[i];
            return (
              <div key={k} className="pxt10-card" style={{ animationDelay: `${-i * 3}s` }}>
                <span className={`pxt-tagc ${c}`}>{t(`auth.th.st.${k}`)}</span>
                <div className="r">
                  <b>{n}</b>
                  <b>{v}</b>
                </div>
                <small>{w}</small>
                <div className="bar">
                  <i style={{ width: `${p}%` }} className={c === 'nv' ? 'ok' : ''} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ),
  },
  // 11 · night, a glowing sun and a moving grid floor
  {
    id: 11,
    layout: 'overlay',
    side: 'end',
    dark: true,
    Visual: () => (
      <div className="pxt11">
        {[
          [7, 10],
          [17, 22],
          [26, 8],
          [14, 40],
          [79, 11],
          [90, 27],
          [72, 37],
          [94, 8],
          [6, 52],
          [86, 50],
        ].map(([x, y], k) => (
          <i key={k} className="st" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${(k % 4) * 0.6}s` }} />
        ))}
        <div className="sun" />
        <div className="floor">
          <div />
        </div>
      </div>
    ),
    Copy: ({ t }) => (
      <h2 className="pxt-big on-dark">
        {t('auth.th.t11a')}
        <br />
        <span className="or">{t('auth.th.t11b')}</span>
      </h2>
    ),
  },
  // 12 · rolling counters
  {
    id: 12,
    layout: 'split',
    side: 'start',
    panel: '#F7A823',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt12">
        <h2 className="pxt-h">{t('auth.th.t12')}</h2>
        <div className="pxt12-big">
          <Reel to={1} />
          <Reel to={2} delay={0.12} />
          <Reel to={8} delay={0.24} />
        </div>
        <b className="pxt12-l">{t('auth.th.t12a')}</b>
        <div className="pxt12-row">
          <div>
            <div className="pxt12-mid">
              <Reel to={8} delay={0.36} />
              <Reel to={6} delay={0.48} />%
            </div>
            <b className="pxt12-l">{t('auth.th.t12b')}</b>
          </div>
          <div>
            <div className="pxt12-mid">58</div>
            <b className="pxt12-l">{t('auth.th.t12c')}</b>
          </div>
        </div>
      </div>
    ),
  },
  // 13 · animated tiles
  {
    id: 13,
    layout: 'split',
    side: 'end',
    panel: '#EEF1F6',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt13">
        <div className="tile nv wide">
          <small>{t('auth.th.t13a')}</small>
          <b>
            {t('auth.th.t13b')}
            <br />
            <span className="or">{t('auth.th.t13c')}</span>
          </b>
        </div>
        <div className="tile">
          <small>{t('auth.th.tool.confirmation')}</small>
          <div className="pxt13-ring">
            <svg viewBox="0 0 110 110">
              <circle cx="55" cy="55" r="48" fill="none" stroke="#EEF0F4" strokeWidth="12" />
              <circle cx="55" cy="55" r="48" fill="none" stroke="#F7A823" strokeWidth="12" strokeLinecap="round" strokeDasharray="302" transform="rotate(-90 55 55)" />
            </svg>
            <span>
              <b>86 %</b>
              <small>{t('auth.k2')}</small>
            </span>
          </div>
        </div>
        <div className="tile or">
          <small>{t('auth.th.swap')}</small>
          <div className="pxt13-swap">
            <span>
              <Swap />
            </span>
            <b>{t('auth.th.swapText')}</b>
          </div>
        </div>
        <div className="tile">
          <small>{t('auth.k3')}</small>
          <Bars n={5} h={[40, 62, 52, 78, 96]} />
        </div>
        <div className="tile">
          <small>{t('auth.th.tool.caisse')}</small>
          <div className="pxt13-pay">
            <span>+ 128 400 DA</span>
          </div>
        </div>
      </div>
    ),
  },
  // 14 · a card flipping between Boutique and Agence
  {
    id: 14,
    layout: 'split',
    side: 'end',
    panel: '#F3F5F9',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt14">
        <h2 className="pxt-h center">{t('auth.th.t14')}</h2>
        <p className="pxt-p center">{t('auth.th.t14s')}</p>
        <div className="pxt14-float">
          <div className="pxt14-card">
            <div className="face a">
              <span className="pill">{t('auth.th.kindStore')}</span>
              <b>{t('auth.th.t14a')}</b>
              {['li1', 'li2', 'li3', 'li4'].map((k) => (
                <span key={k} className="li">
                  <i>
                    <Check />
                  </i>
                  {t(`auth.th.t14${k}`)}
                </span>
              ))}
            </div>
            <div className="face b">
              <span className="pill">{t('auth.th.kindAgency')}</span>
              <b>{t('auth.th.t14b')}</b>
              {['lj1', 'lj2', 'lj3', 'lj4'].map((k) => (
                <span key={k} className="li">
                  <i>
                    <Check />
                  </i>
                  {t(`auth.th.t14${k}`)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
  },
  // 15 · scrolling bands
  {
    id: 15,
    layout: 'overlay',
    side: 'center',
    Visual: ({ t }) => (
      <div className="pxt15">
        {[1, 2, 3].map((k) => (
          <div key={k} className={`band b${k}`}>
            <div className="row">
              <span>{t(`auth.th.band${k}`)}</span>
              <span>{t(`auth.th.band${k}`)}</span>
            </div>
          </div>
        ))}
      </div>
    ),
  },
  // 16 · an order moving step by step to the caisse
  {
    id: 16,
    layout: 'split',
    side: 'start',
    panel: '#F3F5F9',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt16">
        <H a={t('auth.th.t16a')} b={t('auth.th.t16b')} />
        <div className="pxt16-card">
          <div className="top">
            <b>#PX01051 · Amina B.</b>
            <span>Sétif · 7 700 DA</span>
          </div>
          <div className="line">
            <i />
          </div>
          {[1, 2, 3, 4, 5].map((k) => (
            <div key={k} className="st">
              <span className="dot" style={{ animationDelay: `${(k - 1) * 2}s` }}>
                {k}
              </span>
              <span className="lbl" style={{ animationDelay: `${(k - 1) * 2}s` }}>
                <b>{t(`auth.th.s${k}`)}</b>
                <small>{t(`auth.th.s${k}s`)}</small>
              </span>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  // 17 · Pilotix's tools floating in 3D
  {
    id: 17,
    layout: 'split',
    side: 'end',
    panel: '#1B2A47',
    Visual: ({ t }) => (
      <div className="pxt17">
        <H a={t('auth.th.t17a')} b={t('auth.th.t17b')} dark />
        <div className="pxt17-sway">
          {(
            [
              ['confirmation', 'end', 10, 30, 60, -4],
              ['swap', 'start', 30, 80, 20, 5],
              ['claim', 'end', 70, 190, 90, 3],
              ['payment', 'start', 10, 250, 40, -3],
              ['upsell', 'end', 20, 330, 10, -6],
              ['kpi', 'start', 90, 400, 70, 4],
            ] as const
          ).map(([k, side, off, top, z, r], i) => (
            <span key={k} className="pxt17-chip" style={{ [side === 'end' ? 'insetInlineEnd' : 'insetInlineStart']: off, top, ['--z' as string]: `${z}px`, ['--r' as string]: `${r}deg`, animationDelay: `${-i}s` } as CSSProperties}>
              <i>{i === 1 ? <Swap /> : i === 2 ? <Truck /> : <Check />}</i>
              {t(`auth.th.chip.${k}`)}
            </span>
          ))}
        </div>
      </div>
    ),
  },
  // 18 · the giant logo with orange ripples
  {
    id: 18,
    layout: 'split',
    side: 'start',
    panel: '#1B2A47',
    Visual: ({ t }) => (
      <div className="pxt18">
        <i className="rp" />
        <i className="rp r2" />
        <i className="rp r3" />
        <div className="pxt18-logo">
          <BrandBig />
        </div>
        <p className="pxt18-cap">
          {t('auth.th.t18a')}
          <br />
          <b>{t('auth.th.t18b')}</b>
        </p>
      </div>
    ),
  },
  // 19 · five apps stacked in 3D into one Pilotix
  {
    id: 19,
    layout: 'split',
    side: 'start',
    panel: '#EEF1F6',
    light: true,
    Visual: ({ t }) => (
      <div className="pxt19">
        <H a={t('auth.th.t19a')} b={t('auth.th.t19b')} />
        <div className="pxt19-stack">
          {(['caisse', 'delivery', 'whatsapp', 'confirmation', 'landing'] as const).map((k, i) => (
            <div key={k} className={`ly l${i}`} style={{ ['--i' as string]: i } as CSSProperties}>
              <b>{t(`auth.th.tool.${k}`)}</b>
              <span />
              <span className="s" />
            </div>
          ))}
        </div>
      </div>
    ),
  },
  // 20 · huge bold words changing
  {
    id: 20,
    layout: 'overlay',
    side: 'end',
    Visual: () => (
      <div className="pxt20">
        <div className="pxt20-box">
          <Cube size={110} className="flat" />
        </div>
        <div className="pxt20-shadow" />
      </div>
    ),
    Copy: ({ t }) => (
      <div className="pxt20-words">
        <div>{t('auth.th.w1')}</div>
        <div className="win">
          <div className="roll">
            <div>{t('auth.th.w2')}</div>
            <div>{t('auth.th.w3')}</div>
            <div>{t('auth.th.w4')}</div>
            <div className="wh">Pilotix.</div>
          </div>
        </div>
        <p>{t('auth.th.band1')}</p>
      </div>
    ),
  },
];

/** A building (or a truck) of the 3D city: its top and two sides. */
function Bld({ x, y, w, d, h, c, k = 0 }: { x?: number; y?: number; w: number; d: number; h: number; c: 'n' | 's' | 'w' | 'o'; k?: number }) {
  return (
    <div className={`pxt6-b ${c}`} style={{ left: x, top: y, width: w, height: d, ['--h' as string]: `${h}px`, animationDelay: `${k * 0.1}s` } as CSSProperties}>
      <i className="t" />
      <i className="f" />
      <i className="r" />
    </div>
  );
}

/** A rolling digit: 0…9, 0… down to `to`. */
function Reel({ to, delay = 0 }: { to: number; delay?: number }) {
  const digits = Array.from({ length: 11 + to }, (_, i) => i % 10);
  return (
    <span className="pxt-reel">
      <span style={{ ['--to' as string]: `-${(10 + to) * 1.12}em`, animationDelay: `${delay}s` } as CSSProperties}>
        {digits.map((n, i) => (
          <i key={i}>{n}</i>
        ))}
      </span>
    </span>
  );
}
