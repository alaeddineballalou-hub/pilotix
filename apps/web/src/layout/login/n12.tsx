/** @jsxRuntime automatic @jsxImportSource react */
// Theme 12 · «An agency gets its own account» — the agency's own control tower, its client shops around it.
import type { ReactElement, CSSProperties } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

// isometric projection (world x, y on the ground, z up) -> SVG user units
const K = 0.866;
const sx = (x: number, y: number) => K * (x - y);
const sy = (x: number, y: number, z: number) => 0.5 * (x + y) - z;
const pt = (x: number, y: number, z: number) => `${sx(x, y).toFixed(1)},${sy(x, y, z).toFixed(1)}`;
const quad = (a: number[][]) => a.map(([x, y, z]) => pt(x, y, z)).join(' ');
/** a box: x0..x1, y0..y1, z0..z1 -> its 3 visible faces */
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => ({
  top: quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),
  fx: quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]),
  fy: quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]),
});
// the visible box of the scene, in user units
const VB = { x: -350, y: -322, w: 700, h: 560 };
const at = (X: number, Y: number): CSSProperties => ({ left: `${(((X - VB.x) / VB.w) * 100).toFixed(2)}%`, top: `${(((Y - VB.y) / VB.h) * 100).toFixed(2)}%` });

// the client shops: screen position of the base centre, on an iso ring around the tower.
// Shops 0-2 stay on phones; 3 and 4 (and their lines, pulses and agents) are hidden there by the CSS.
const SHOPS = [
  { X: -262, Y: -42, label: 'shop1' },
  { X: 262, Y: -36, label: 'shop2' },
  { X: 0, Y: 172 },
  { X: -236, Y: 112 },
  { X: 238, Y: 118 },
];
const HUB = { X: 0, Y: -150 }; // where the order lines enter the tower
const SW = 34, SD = 28, SH = 34; // shop half-width, half-depth, height
const ROOF = 220; // height of the tower's roof deck
const RING = 46; // radius of the ring of agents on the roof (world units)
const AGENTS = Array.from({ length: 8 }, (_, k) => {
  const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
  const x = RING * Math.cos(a), y = RING * Math.sin(a);
  return { X: sx(x, y), Y: sy(x, y, ROOF) };
});
// the ground: an iso grid every 70 units
const GRID = Array.from({ length: 13 }, (_, i) => -420 + i * 70).flatMap((v) => [
  `M${pt(v, -420, 0)}L${pt(v, 420, 0)}`,
  `M${pt(-420, v, 0)}L${pt(420, v, 0)}`,
]);
// which agent picks the order of each shop
const PICK = [5, 1, 3, 6, 0];

const Shop = ({ X, Y, k }: { X: number; Y: number; k: number }) => {
  const cx = (X / K + 2 * Y) / 2, cy = (2 * Y - X / K) / 2; // back to world
  const x0 = cx - SW, x1 = cx + SW, y0 = cy - SD, y1 = cy + SD;
  const b = box(x0, x1, y0, y1, 0, SH);
  const roofB = box(x0 - 2, x1 + 2, y0 - 2, y1 + 2, SH, SH + 4);
  const parapet = quad([[x0 + 4, y0 + 4, SH + 4], [x1 - 4, y0 + 4, SH + 4], [x1 - 4, y1 - 4, SH + 4], [x0 + 4, y1 - 4, SH + 4]]);
  // the awning over the shop front (y face): 6 stripes sloping out
  const n = 6;
  const st = Array.from({ length: n }, (_, i) => {
    const xa = x0 + 2 + (i * (2 * SW - 4)) / n, xb = x0 + 2 + ((i + 1) * (2 * SW - 4)) / n;
    return { d: quad([[xa, y1, SH - 7], [xb, y1, SH - 7], [xb, y1 + 11, SH - 15], [xa, y1 + 11, SH - 15]]), o: i % 2 === 0 };
  });
  const board = quad([[x0 + 8, y1, SH - 2], [x1 - 8, y1, SH - 2], [x1 - 8, y1, SH - 6], [x0 + 8, y1, SH - 6]]);
  const door = quad([[cx + 8, y1, 0], [cx + 20, y1, 0], [cx + 20, y1, 16], [cx + 8, y1, 16]]);
  const win1 = quad([[x0 + 8, y1, 5], [cx + 2, y1, 5], [cx + 2, y1, 16], [x0 + 8, y1, 16]]);
  const win2 = quad([[x1, y0 + 10, 8], [x1, y1 - 10, 8], [x1, y1 - 10, 20], [x1, y0 + 10, 20]]);
  // the agency's old seat: a guest inside this shop (ghost)
  const gx = sx(cx + SW + 14, cy + SD + 14), gy = sy(cx + SW + 14, cy + SD + 14, 0) - 13;
  return (
    <g className={`pxn12-shop pxn12-s${k}`}>
      <ellipse cx={X} cy={Y + 10} rx={66} ry={30} className="pxn12-shadow" />
      <polygon points={b.fy} className="pxn12-sw-y" />
      <polygon points={b.fx} className="pxn12-sw-x" />
      <polygon points={roofB.fy} className="pxn12-sr-y" />
      <polygon points={roofB.fx} className="pxn12-sr-x" />
      <polygon points={roofB.top} className="pxn12-sr-t" />
      <polygon points={parapet} className="pxn12-sr-in" />
      <polygon points={win1} className="pxn12-win" />
      <polygon points={win2} className="pxn12-win pxn12-dim" />
      <polygon points={door} className="pxn12-door" />
      <polygon points={board} className="pxn12-board" />
      {st.map((s, i) => (
        <polygon key={i} points={s.d} className={s.o ? `pxn12-aw-a${k % 2}` : 'pxn12-aw-w'} />
      ))}
      <g className="pxn12-ghost" transform={`translate(${gx.toFixed(1)} ${gy.toFixed(1)})`}>
        <g className="pxn12-ghost-in">
          <circle r={13} className="pxn12-gh-c" />
          <circle cy={-3.5} r={4.4} className="pxn12-gh-f" />
          <path d="M-7.5 8.5a7.5 6.5 0 0 1 15 0" className="pxn12-gh-f" />
        </g>
      </g>
    </g>
  );
};

// a round shape of radius r (world units) seen in the iso view: an ellipse, rx = r * 1.2247, ry = r * 0.7071
const RX = (r: number) => r * 1.2247, RY = (r: number) => r * 0.7071;
/** the visible side of an upright round section: radius r0 at height z0, radius r1 at height z1 */
const drum = (r0: number, z0: number, r1: number, z1: number) => {
  const a0 = RX(r0), b0 = RY(r0), a1 = RX(r1), b1 = RY(r1);
  return `M${(-a0).toFixed(1)} ${-z0}A${a0.toFixed(1)} ${b0.toFixed(1)} 0 0 0 ${a0.toFixed(1)} ${-z0}L${a1.toFixed(1)} ${-z1}A${a1.toFixed(1)} ${b1.toFixed(1)} 0 0 1 ${(-a1).toFixed(1)} ${-z1}Z`;
};
// the tower: a slim round white shaft, a flared skirt, a glass cab all round, a navy roof deck with the agents.
// (round and light on purpose: it must read as an airport-style control tower, never as a dark cube)
const Tower = () => {
  const R = 24; // shaft radius
  const slits = [26, 58, 90, 122];
  return (
    <g className="pxn12-tower">
      <path d={drum(R, 0, R, 150)} fill="url(#pxn12-shaft)" />
      <rect x={-7} y={-22 + RY(R)} width={14} height={22} rx={3} className="pxn12-door" />
      {slits.map((z) => (
        <rect key={z} x={-3} y={-z - 14 + RY(R)} width={6} height={14} rx={3} className="pxn12-slit" />
      ))}
      <path d={drum(R, 150, 60, 176)} fill="url(#pxn12-skirt)" />
      <path d={drum(60, 176, 60, 180)} className="pxn12-c-ring" />
      <path d={drum(60, 180, 66, 210)} fill="url(#pxn12-glass)" />
      {[-0.66, -0.33, 0, 0.33, 0.66].map((f) => (
        <line key={f} x1={(RX(60) * f).toFixed(1)} y1={(-180 + RY(60) * Math.sqrt(1 - f * f)).toFixed(1)} x2={(RX(66) * f).toFixed(1)} y2={(-210 + RY(66) * Math.sqrt(1 - f * f)).toFixed(1)} className="pxn12-mull" />
      ))}
      <path d={drum(68, 210, 68, ROOF)} className="pxn12-rim" />
      <ellipse cx={0} cy={-ROOF} rx={RX(68)} ry={RY(68)} className="pxn12-deck" />
      <ellipse cx={0} cy={-ROOF} rx={RX(RING)} ry={RY(RING)} className="pxn12-ringline" />
    </g>
  );
};

const Agent = ({ X, Y, k, lit }: { X: number; Y: number; k: number; lit: number }) => (
  <g className="pxn12-ag" style={{ ['--i' as string]: k } as CSSProperties}>
    <g className="pxn12-ag-in" transform={`translate(${X.toFixed(1)} ${(Y - 4).toFixed(1)})`}>
      <circle r={12} className="pxn12-ag-bg" />
      <circle cy={-3} r={4.2} className="pxn12-ag-fg" />
      <path d="M-7 7.5a7 6 0 0 1 14 0z" className="pxn12-ag-fg" />
      {lit >= 0 && (
        <g className={`pxn12-lit pxn12-l${lit}`}>
          <circle r={20} className="pxn12-halo" />
          <circle r={12} className="pxn12-ag-on" />
          <circle cy={-3} r={4.2} className="pxn12-ag-onfg" />
          <path d="M-7 7.5a7 6 0 0 1 14 0z" className="pxn12-ag-onfg" />
        </g>
      )}
    </g>
  </g>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'end',
  // the visible words live inside Visual (not Copy) so that the headline and the scene share one column and can never overlap,
  // whatever the language and the window size; on phones the same column shows the tower, then the headline.
  Visual: ({ t }) => {
    const back = SHOPS.map((s, k) => ({ ...s, k })).filter((s) => s.Y < 0);
    const front = SHOPS.map((s, k) => ({ ...s, k })).filter((s) => s.Y >= 0);
    return (
      <div className="pxn12">
        <div className="pxn12-ground" />
        <div className="pxn12-scrim" />
        <div className="pxn12-col">
          <div className="pxn12-words" dir={t('dir')}>
            <h2 className="pxn12-h">
              {t('h1')} <span>{t('h2')}</span>
            </h2>
            <p className="pxn12-p">{t('sub')}</p>
            <div className="pxn12-vs">
              <span className="pxn12-was">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="9.5" r="3" />
                  <path d="M6.8 17.5a5.6 4.6 0 0 1 10.4 0" />
                </svg>
                {t('before')}
              </span>
              <svg viewBox="0 0 24 24" className="pxn12-arr" aria-hidden="true">
                <path d="M5 12h14m-5-5 5 5-5 5" />
              </svg>
              <span className="pxn12-now">{t('after')}</span>
            </div>
          </div>
          <div className="pxn12-scene">
            <div className="pxn12-crop">
              <div className="pxn12-world">
                <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} className="pxn12-svg" aria-hidden="true">
                  <defs>
                    <radialGradient id="pxn12-fade" cx="50%" cy="58%" r="52%">
                      <stop offset="0" stopColor="#fff" stopOpacity="1" />
                      <stop offset="1" stopColor="#fff" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id="pxn12-shaft" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="#FFFFFF" />
                      <stop offset=".55" stopColor="#E3E9F1" />
                      <stop offset="1" stopColor="#B7C2D3" />
                    </linearGradient>
                    <linearGradient id="pxn12-skirt" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="#F4F7FB" />
                      <stop offset="1" stopColor="#AFBBCD" />
                    </linearGradient>
                    <linearGradient id="pxn12-glass" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="#BFD8FA" />
                      <stop offset=".5" stopColor="#8DB5EC" />
                      <stop offset="1" stopColor="#5E86C2" />
                    </linearGradient>
                    <mask id="pxn12-mask">
                      <rect x={VB.x} y={VB.y} width={VB.w} height={VB.h} fill="url(#pxn12-fade)" />
                    </mask>
                  </defs>
                  <g className="pxn12-grid" mask="url(#pxn12-mask)">
                    {GRID.map((d, i) => (
                      <path key={i} d={d} />
                    ))}
                  </g>
                  <ellipse cx={0} cy={6} rx={150} ry={86} className="pxn12-plot" />
                  <ellipse cx={0} cy={6} rx={112} ry={64} className="pxn12-plot2" />
                  {SHOPS.map((s, k) => (
                    <line key={k} x1={s.X} y1={s.Y - SH} x2={HUB.X} y2={HUB.Y} className={`pxn12-line pxn12-s${k}`} />
                  ))}
                  {SHOPS.map((s, k) => (
                    <g
                      key={k}
                      className={`pxn12-pulse pxn12-p${k} pxn12-s${k}`}
                      style={{ ['--dx' as string]: `${HUB.X - s.X}px`, ['--dy' as string]: `${HUB.Y - (s.Y - SH)}px` } as CSSProperties}
                    >
                      <circle cx={s.X} cy={s.Y - SH} r={13} className="pxn12-pulse-o" />
                      <circle cx={s.X} cy={s.Y - SH} r={5.5} className="pxn12-pulse-i" />
                    </g>
                  ))}
                  {back.map((s) => (
                    <Shop key={s.k} X={s.X} Y={s.Y} k={s.k} />
                  ))}
                  <Tower />
                  {AGENTS.map((a, k) => (
                    <Agent key={k} X={a.X} Y={a.Y} k={k} lit={PICK.indexOf(k)} />
                  ))}
                  <line x1={0} y1={-ROOF} x2={0} y2={-ROOF - 50} className="pxn12-mast" />
                  <circle cx={0} cy={-ROOF - 54} r={15} className="pxn12-beacon-glow" />
                  <circle cx={0} cy={-ROOF - 54} r={6} className="pxn12-beacon" />
                  {front.map((s) => (
                    <Shop key={s.k} X={s.X} Y={s.Y} k={s.k} />
                  ))}
                </svg>
                <div className="pxn12-plate" style={at(0, -112)}>
                  <span className="pxn12-badge" dir={t('dir')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 2.5 4 6v6c0 4.6 3.4 8.4 8 9.5 4.6-1.1 8-4.9 8-9.5V6z" />
                      <path d="m8.5 12 2.5 2.5 4.5-5" className="pxn12-ck" />
                    </svg>
                    {t('badge')}
                  </span>
                  <span className="pxn12-stamp" />
                  <b dir="ltr">{t('name')}</b>
                </div>
                <div className="pxn12-chip pxn12-agents" style={at(118, -282)} dir={t('dir')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="9" cy="8" r="3.2" />
                    <path d="M3 19a6 6 0 0 1 12 0zM15.5 5.2a3 3 0 1 1 0 5.6M17 13.4A6 6 0 0 1 21 19h-3.5" />
                  </svg>
                  {t('agents', { n: 8 })}
                </div>
                {SHOPS.filter((s) => s.label).map((s) => (
                  <div key={s.label} className={`pxn12-chip pxn12-shopname pxn12-sn-${s.label}`} style={at(s.X, s.Y - SH - 34)} dir={t('dir')}>
                    {t(s.label as string)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
  // Copy carries the same words for screen readers only (Visual sits in an aria-hidden layer); it is never seen.
  Copy: ({ t }) => (
    <div className="pxn12-a11y" dir={t('dir')}>
      <h2>
        {t('h1')} {t('h2')}
      </h2>
      <p>{t('sub')}</p>
      <p>
        {t('was')} {t('before')}
      </p>
      <p>
        {t('now')} {t('after')}
      </p>
    </div>
  ),
};
export default theme;
