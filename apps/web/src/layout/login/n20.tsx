// Theme 20 · « One sign-in, your whole shop » — one key turns, one door opens onto one tidy room:
// computer: the sign-in card is the door and the room beside it holds the order list with the four modules around it;
// phone: the small door and its key, while the scattered tabs fade away.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

const Ic = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PHONE = 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2';
const TRUCK = 'M2 6h12v10H2zM14 10h4l4 4v2h-8M6 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z';
const BOX = 'M3 7.5 12 3l9 4.5-9 4.5-9-4.5zM3 7.5v9L12 21l9-4.5v-9M12 12v9';
const CASH = 'M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9v.01M18 15v.01';

// the one lock, with the one key (drawn twice: on the card's door frame on a computer, beside the small door on a phone)
const Lock = ({ cls }: { cls: string }) => (
  <div className={`pxn20-lock ${cls}`}>
    <i className="pxn20-led pxn20-off" />
    <i className="pxn20-led pxn20-on" />
    <i className="pxn20-hole" />
    <span className="pxn20-keybox">
      <svg className="pxn20-key" viewBox="0 0 72 32">
        <rect x="2" y="13" width="46" height="6" rx="3" />
        <rect x="8" y="18" width="5" height="8" rx="1.5" />
        <rect x="17" y="18" width="5" height="6" rx="1.5" />
        <circle cx="58" cy="16" r="10" fill="none" strokeWidth="6" />
      </svg>
    </span>
  </div>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'end',
  Visual: ({ t }) => (
    <div className="pxn20" dir={t('dir')}>
      <div className="pxn20-floor" />
      <div className="pxn20-scrim" />
      {/* computer: the sign-in card is the door. Its frame, its open leaf and its lock are drawn around it, never under it */}
      <div className="pxn20-frame" aria-hidden="true" />
      <div className="pxn20-dleaf" aria-hidden="true" />
      <div className="pxn20-spill" aria-hidden="true" />
      <div className="pxn20-dlock" aria-hidden="true">
        <Lock cls="pxn20-lock-d" />
      </div>
      <div className="pxn20-scene">
        <div className="pxn20-box">
        <div className="pxn20-room" aria-hidden="true">
          <div className="pxn20-glow" />
          {/* the order list in the middle of the room (on a phone it sits behind a small door that opens) */}
          <div className="pxn20-door">
            <div className="pxn20-list">
              <b className="pxn20-lhead">{t('list')}</b>
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className={`pxn20-row pxn20-r${n}`}>
                  <i />
                  <span className="pxn20-who">
                    <b>{t(`r${n}n`)}</b>
                    <small>{t(`r${n}c`)}</small>
                  </span>
                  <span className="pxn20-amt">{t(`r${n}a`)}</span>
                </div>
              ))}
            </div>
            <div className="pxn20-leaf">
              <i />
              <i />
            </div>
          </div>
          {/* the scattered tabs of the old way: they dissolve when the door opens */}
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <span key={n} className={`pxn20-tab pxn20-t${n}`}>
              <i />
              {t(`tab${n}`)}
              <b>×</b>
            </span>
          ))}
          {/* phone: the lock beside the small door */}
          <Lock cls="pxn20-lock-m" />
          {/* the four modules, settled around the list */}
          {(
            [
              [1, PHONE],
              [2, TRUCK],
              [3, BOX],
              [4, CASH],
            ] as const
          ).map(([n, d]) => (
            <div key={n} className={`pxn20-win pxn20-w${n}`}>
              <div className="pxn20-wtop">
                <span className="pxn20-ic">
                  <Ic d={d} />
                </span>
                <b>{t(`w${n}`)}</b>
              </div>
              <small>{t(`w${n}v`)}</small>
              <span className="pxn20-bar">
                <i />
              </span>
            </div>
          ))}
        </div>
        </div>
        <div className="pxn20-text">
          <h2 className="pxn20-h">
            {t('a')} <span>{t('b')}</span>
          </h2>
          <p className="pxn20-sub">{t('sub')}</p>
          <p className="pxn20-proof">{t('proof')}</p>
        </div>
      </div>
    </div>
  ),
};
export default theme;
