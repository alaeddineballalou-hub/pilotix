// Theme 8 of 20 — «Sell where you sell»: three shop stalls that never move, each with a pipe already
// laid under it; a buyer taps «اطلب», the order drops into the pipe and pops out right beside the form.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;
type Ch = 'fb' | 'tt' | 'sh';

const Glyph = ({ k }: { k: Ch }) => (
  <svg className="pxn08-gl" viewBox="0 0 24 24" aria-hidden="true">
    {k === 'fb' && (
      <path fill="currentColor" d="M13.4 21v-7.3h2.5l.4-2.9h-2.9V9c0-.8.3-1.4 1.5-1.4h1.5V5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.1H8v2.9h2.5V21z" />
    )}
    {k === 'tt' && (
      <path fill="currentColor" d="M15.6 3c.3 2.3 1.7 3.8 4 4v3a7.2 7.2 0 0 1-4-1.3v6.4a5.6 5.6 0 1 1-5.6-5.6l.9.1v3.1a2.6 2.6 0 1 0 1.8 2.4V3z" />
    )}
    {k === 'sh' && (
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
        <path d="M5.5 8.5h13l-1.2 12h-10.6z" />
        <path d="M9 8.5V6.8a3 3 0 0 1 6 0v1.7" />
      </g>
    )}
  </svg>
);

const scallops = 'M0 88' + ' a12.5 12.5 0 0 0 25 0'.repeat(8) + ' V40 H0 Z';

const Stall = ({ t, k }: { t: T; k: Ch }) => (
  <div className={`pxn08-stall pxn08-st-${k}`}>
    <svg className="pxn08-st-svg" viewBox="0 0 200 240" preserveAspectRatio="none" aria-hidden="true">
      <rect className="pxn08-st-post" x="14" y="80" width="7" height="160" rx="3" />
      <rect className="pxn08-st-post" x="179" y="80" width="7" height="160" rx="3" />
      <rect className="pxn08-st-wall" x="21" y="92" width="158" height="86" />
      <rect className="pxn08-st-shelf" x="30" y="132" width="140" height="3" rx="1.5" />
      <rect className="pxn08-st-good a" x="36" y="112" width="22" height="20" rx="4" />
      <rect className="pxn08-st-good b" x="62" y="118" width="16" height="14" rx="3" />
      <rect className="pxn08-st-good c" x="120" y="108" width="20" height="24" rx="4" />
      <rect className="pxn08-st-good a" x="144" y="116" width="20" height="16" rx="4" />
      <rect className="pxn08-st-good b" x="44" y="150" width="26" height="22" rx="4" />
      <rect className="pxn08-st-good c" x="128" y="154" width="30" height="18" rx="4" />
      <rect className="pxn08-st-cord" x="99.2" y="88" width="1.6" height="12" />
      <circle className="pxn08-st-bulb" cx="100" cy="104" r="4.5" />
      <g className="pxn08-st-awn">
        <path className="pxn08-st-awn-a" d={scallops} />
        {[1, 3, 5, 7].map((i) => (
          <rect key={i} className="pxn08-st-awn-b" x={i * 25} y="40" width="25" height="48" />
        ))}
        {[1, 3, 5, 7].map((i) => (
          <path key={`s${i}`} className="pxn08-st-awn-b" d={`M${i * 25} 88 a12.5 12.5 0 0 0 25 0z`} />
        ))}
        <rect className="pxn08-st-awn-top" x="0" y="36" width="200" height="8" rx="4" />
      </g>
      <rect className="pxn08-st-counter" x="6" y="178" width="188" height="62" rx="6" />
      <rect className="pxn08-st-lip" x="2" y="174" width="196" height="9" rx="4.5" />
    </svg>
    <div className="pxn08-sign" dir="auto">
      <Glyph k={k} />
      <span>{t(`ch_${k}`)}</span>
    </div>
    <div className="pxn08-btn-at">
      <span className="pxn08-ripple" />
      <span className="pxn08-btn">{t('order')}</span>
      <svg className="pxn08-finger" viewBox="0 0 40 52" aria-hidden="true">
        <path d="M15 30V8.5a4.5 4.5 0 0 1 9 0V24l8.2 2.3a5 5 0 0 1 3.6 5.6L34.4 42A9 9 0 0 1 25.5 50H20a9 9 0 0 1-7.4-3.9L6.2 36.8a3.6 3.6 0 0 1 5.4-4.7z" />
      </svg>
    </div>
    <span className="pxn08-hatch" />
    <span className="pxn08-ticket" />
  </div>
);

const Arrival = ({ t, n, k }: { t: T; n: '1' | '2' | '3' | 'p2'; k: Ch }) => (
  <div className={`pxn08-arr pxn08-arr${n} pxn08-src-${k}`} dir={t('dir')}>
    <span className="pxn08-arr-src">
      <Glyph k={k} />
    </span>
    <span className="pxn08-arr-txt">
      <span className="pxn08-chip">{t(`arr${n}`)}</span>
      <span className="pxn08-item">{t(`item${n}`)}</span>
    </span>
  </div>
);

// a pellet that runs along a pipe: the wrapper spans the pipe, the child slides by 100% of it
const Run = ({ n, cls }: { n: 1 | 2 | 3; cls: string }) => (
  <span className={`pxn08-run ${cls}`}>
    <span className={`pxn08-runx pxn08-x${n}`}>
      <span className={`pxn08-pel pxn08-d${n}`} />
    </span>
  </span>
);
const Rise = ({ ns }: { ns: (1 | 2 | 3)[] }) => (
  <span className="pxn08-riser">
    <span className="pxn08-riser-cap" />
    {ns.map((n) => (
      <span key={n} className={`pxn08-risey pxn08-y${n}`}>
        <span className="pxn08-pel" />
      </span>
    ))}
  </span>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'center',
  Visual: ({ t }) => (
    <div className="pxn08" dir={t('dir')} aria-hidden="true">
      <div className="pxn08-under" />
      <div className="pxn08-scrim" />

      {/* start side: the words, the Facebook stall, its pipe and the riser beside the form */}
      <div className="pxn08-side pxn08-s">
        <div className="pxn08-copy">
          <p className="pxn08-h">
            {t('a')} <span>{t('b')}</span>
          </p>
          <p className="pxn08-sub">{t('sub')}</p>
          <p className="pxn08-keep">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8.4l2.9 2.8 6.1-6.4" />
            </svg>
            {t('keep')}
          </p>
        </div>
        <div className="pxn08-lane">
          <span className="pxn08-pipe pxn08-pipe-h" />
          <span className="pxn08-pipe pxn08-pipe-v pxn08-v1" />
          <div className="pxn08-at pxn08-at1 pxn08-c1"><Stall t={t} k="fb" /></div>
          <Run n={1} cls="pxn08-run1" />
          <Rise ns={[1]} />
          <Arrival t={t} n="1" k="fb" />
        </div>
      </div>

      {/* end side: TikTok and Shopify stalls, the other sources, the second riser */}
      <div className="pxn08-side pxn08-e">
        <div className="pxn08-post" dir={t('dir')}>
          <span className="pxn08-post-t">{t('more')}</span>
          {['src_ig', 'src_lp', 'src_yc', 'src_wc', 'src_gs', 'src_api'].map((k) => (
            <span key={k} className="pxn08-board">
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 1.5L3 5l3.5 3.5" /></svg>
              <span>{t(k)}</span>
            </span>
          ))}
        </div>
        <div className="pxn08-lane">
          <span className="pxn08-pipe pxn08-pipe-h" />
          <span className="pxn08-pipe pxn08-pipe-v pxn08-v2" />
          <span className="pxn08-pipe pxn08-pipe-v pxn08-v3" />
          <div className="pxn08-at pxn08-at2 pxn08-c2"><Stall t={t} k="tt" /></div>
          <div className="pxn08-at pxn08-at3 pxn08-c3"><Stall t={t} k="sh" /></div>
          <Run n={2} cls="pxn08-run2" />
          <Run n={3} cls="pxn08-run3" />
          <Rise ns={[2, 3]} />
          <Arrival t={t} n="2" k="tt" />
          <Arrival t={t} n="3" k="sh" />
        </div>
      </div>

      {/* phone & tablet: one stall, its pipe and the arriving card; the headline sits under them */}
      <div className="pxn08-ph">
        <div className="pxn08-ph-in">
          <span className="pxn08-pipe pxn08-ph-pipe" />
          <div className="pxn08-ph-stall pxn08-cp"><Stall t={t} k="fb" /></div>
          <Run n={1} cls="pxn08-ph-run" />
          <div className="pxn08-ph-arr">
            <Arrival t={t} n="1" k="fb" />
            <Arrival t={t} n="p2" k="fb" />
          </div>
        </div>
        <p className="pxn08-ph-head">
          {t('a')} <span>{t('b')}</span>
        </p>
      </div>
    </div>
  ),
  // the picture layer is aria-hidden by the platform; this copy gives the angle's words to screen readers
  // (theme.css keeps it visually hidden, because the card is centred and the words are drawn in the picture)
  Copy: ({ t }) => (
    <div className="pxn08-sr" dir={t('dir')}>
      <p>{t('a')} {t('b')}</p>
      <p>{t('sub')}</p>
    </div>
  ),
};
export default theme;
