/** @jsxRuntime automatic @jsxImportSource react */
// Theme 6 · «كل دينار، تعرف أين هو.» — every dinar has its drawer.
// Coins fly from each source (courier van, rider's scooter) into its own labelled drawer of one cash box, and each
// landing moves that drawer's total one step up. Then the money comes to you: «طلب الدفع» is pressed on the ZR drawer,
// a bundle leaves the drawer for the box header («وصلك +184 500 دج»), and the drawer drains to 0; the rider hands over
// his cash the same way. So every change of every total has a visible cause, including the return to the loop start.
// Expenses (desktop only) fly OUT of their drawer to a receipt, once, and stay spent.
// CSS: theme.css (prefix pxn06-).
// To change the sample data: drawer names AND amounts live in strings.json (keys zr, zr_0…zr_3, …);
// DRAWERS below only says which source feeds which drawer and in which direction the money moves.
import type { CSSProperties, ReactElement } from 'react';

type T = (k: string, o?: Record<string, unknown>) => string;

type Source = 'van' | 'scooter' | 'receipt';
type Drawer = {
  key: string; // strings.json key of the drawer name; its amounts are `${key}_0` … `${key}_3` (`_0` = the empty drawer)
  source: Source; // the object the money flies from (or, with out, to)
  out?: boolean; // money leaves the box (expenses): coins fly from the drawer to the source, ONCE, and the total stays spent.
  //                Rows without `out` loop: 3 coins in, then the drawer is settled (its money flies to the box header) and drains to `_0`.
  pay?: boolean; // shows the «طلب الدفع» button on this drawer; it is pressed just before the drawer is settled
  secondary?: boolean; // dropped on phones (rule: the cash box + two drawers)
};
const DRAWERS: Drawer[] = [
  { key: 'zr', source: 'van', pay: true },
  { key: 'rider', source: 'scooter' },
  { key: 'exp', source: 'receipt', out: true, secondary: true },
];
// The rolling total shows STEPS values: the first one, then one more after each of the 3 coins/notes (see .pxn06-reel).
const STEPS = [0, 1, 2, 3];
// What flies for each source, one by one: c = coin, n = banknote. Exactly STEPS.length - 1 items.
const LOAD: Record<Source, ('c' | 'n')[]> = { van: ['n', 'c', 'n'], scooter: ['c', 'n', 'c'], receipt: ['c', 'n', 'c'] };

const vars = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`--pxn06-${k}`, v])) as CSSProperties;

// Icons are drawn facing the cash box in Arabic (box on the right); theme.css mirrors them in French/English.
// van = a delivery company, scooter = a rider, receipt = an expense paid out of the box.
const Icon = ({ s }: { s: Source }) =>
  s === 'van' ? (
    <svg viewBox="0 0 64 44" fill="none" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path d="M4 8h32v26H4z" fill="#33476E" stroke="#fff" />
      <path d="M36 16h12l10 10v8H36z" fill="#33476E" stroke="#fff" />
      <path d="M40 19h7l6 7H40z" fill="#9FB3D6" stroke="none" />
      <path d="M8 16h22" stroke="#F7A823" />
      <circle cx="15" cy="36" r="5" fill="#1B2A47" stroke="#fff" />
      <circle cx="48" cy="36" r="5" fill="#1B2A47" stroke="#fff" />
    </svg>
  ) : s === 'scooter' ? (
    <svg viewBox="0 0 64 44" fill="none" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path d="M6 12h18v14H6z" fill="#F7A823" stroke="#fff" />
      <path d="M10 34h26l6-20h8" stroke="#fff" />
      <path d="M44 14l-2-6h-6" stroke="#fff" />
      <path d="M18 26c0 4 2 8 8 8" stroke="#fff" />
      <circle cx="12" cy="35" r="6" fill="#1B2A47" stroke="#fff" />
      <circle cx="50" cy="35" r="6" fill="#1B2A47" stroke="#fff" />
    </svg>
  ) : (
    <svg viewBox="0 0 64 44" fill="none" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path d="M18 3h28v38l-4.7-3-4.7 3-4.6-3-4.7 3-4.6-3L18 41z" fill="#33476E" stroke="#fff" />
      <path d="M24 12h16M24 19h16M24 26h9" stroke="#9FB3D6" />
      <path d="M36 27h6" stroke="#F7A823" />
    </svg>
  );

const Money = ({ kind }: { kind: 'c' | 'n' }) =>
  kind === 'c' ? (
    <svg viewBox="0 0 30 30">
      <circle cx="15" cy="15" r="14" fill="#F7A823" />
      <circle cx="15" cy="15" r="9.5" fill="none" stroke="#B85A0B" strokeWidth="2" />
      <path d="M11 12.5h8M11 17.5h8" stroke="#B85A0B" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 44 26">
      <rect x="1" y="1" width="42" height="24" rx="4" fill="#E7F6EC" stroke="#15803D" strokeWidth="2" />
      <circle cx="22" cy="13" r="5.5" fill="none" stroke="#15803D" strokeWidth="2" />
      <path d="M6 7v12M38 7v12" stroke="#15803D" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );

// a small stack of notes: the drawer's money on its way to you
const Bundle = () => (
  <svg viewBox="0 0 48 34">
    <rect x="5" y="1" width="42" height="24" rx="4" fill="#D5EFDD" stroke="#15803D" strokeWidth="2" />
    <rect x="1" y="9" width="42" height="24" rx="4" fill="#E7F6EC" stroke="#15803D" strokeWidth="2" />
    <circle cx="22" cy="21" r="5.5" fill="none" stroke="#15803D" strokeWidth="2" />
  </svg>
);

const PayIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 90% at 85% 0%, #2A3D63 0%, #1B2A47 52%, #142038 100%)',
  // every text block takes the language's own direction (strings.json "dir": rtl in Arabic), never dir="auto",
  // so an Arabic line that starts with a Latin name (ZR Express …) still reads right to left; numbers are always ltr
  Visual: ({ t }) => (
    <div className="pxn06" dir={t('dir')}>
      <div className="pxn06-head">
        <h2 className="pxn06-h" dir={t('dir')}>
          {t('a')} <span>{t('b')}</span>
        </h2>
        <p className="pxn06-sub" dir={t('dir')}>{t('sub')}</p>
      </div>

      <div className="pxn06-scene">
        <div className="pxn06-box" />
        <div className="pxn06-boxtop">
          <span className="pxn06-lock" />
          <b dir={t('dir')}>{t('box')}</b>
          {DRAWERS.map((d, r) =>
            d.out ? null : (
              <span key={d.key} className="pxn06-toast" style={vars({ r })}>
                <Check />
                <span dir={t('dir')}>{t('got')}</span>
                <b dir="ltr">+{t(`${d.key}_3`)}</b>
                <em dir={t('dir')}>{t('cur')}</em>
              </span>
            ),
          )}
        </div>
        {DRAWERS.map((d, r) => (
          <div key={d.key} className={`pxn06-row${d.secondary ? ' pxn06-sec' : ''}${d.out ? ' pxn06-out' : ''}`} style={vars({ r })}>
            <div className="pxn06-drawer">
              <div className="pxn06-meta">
                <small dir={t('dir')}>{t(d.key)}</small>
                {d.pay && (
                  <span className="pxn06-pay" dir={t('dir')}>
                    <PayIcon />
                    {t('pay')}
                    <i className="pxn06-ring" />
                  </span>
                )}
              </div>
              <div className="pxn06-amt">
                <span className="pxn06-reel">
                  <span>
                    {STEPS.map((i) => (
                      <b key={i} dir="ltr">{t(`${d.key}_${i}`)}</b>
                    ))}
                  </span>
                </span>
                <em dir={t('dir')}>{t('cur')}</em>
              </div>
              {!d.out && (
                <span className="pxn06-bundle">
                  <Bundle />
                </span>
              )}
              <i className="pxn06-handle" />
            </div>
            <div className="pxn06-flight">
              <svg className="pxn06-lane" viewBox="0 0 166 80" preserveAspectRatio="none">
                <path d="M0 70Q83-50 166 70" />
              </svg>
              {LOAD[d.source].map((k, i) => (
                <span key={i} className={`pxn06-fly pxn06-${k}`} style={vars({ i })}>
                  <span className="pxn06-arc">
                    <Money kind={k} />
                  </span>
                </span>
              ))}
            </div>
            <div className="pxn06-src">
              <Icon s={d.source} />
            </div>
          </div>
        ))}
      </div>
    </div>
  ),
};
export default theme;
