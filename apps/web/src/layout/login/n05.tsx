/** @jsxRuntime automatic */ /** @jsxImportSource react */
// Theme 5 · «Fake orders will not fool your ads» — a shield in the stream of orders: real buyers pass to the
// Meta Pixel and count as purchases; the fake one (masked face) bounces off and dissolves.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

/** A buyer's face; `mask` draws the masked one (the fake order). */
const Face = ({ mask }: { mask?: boolean }) => (
  <svg viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="20" className="pxn05-av-bg" />
    <circle cx="20" cy="16" r="7.5" className="pxn05-av-fg" />
    <path d="M6.5 34.5c2.6-6.2 7.6-9.5 13.5-9.5s10.9 3.3 13.5 9.5A19.9 19.9 0 0 1 20 40a19.9 19.9 0 0 1-13.5-5.5z" className="pxn05-av-fg" />
    {mask && (
      <>
        <path d="M9 13.2c3.6-1.6 7.3-1 11 .6 3.7-1.6 7.4-2.2 11-.6.6 3-1 6.4-4.6 6.6-2.6.2-4.4-1.4-6.4-1.4s-3.8 1.6-6.4 1.4C9.9 19.6 8.4 16.2 9 13.2z" className="pxn05-av-mask" />
        <ellipse cx="15.2" cy="15.6" rx="2.2" ry="1.4" className="pxn05-av-eye" />
        <ellipse cx="24.8" cy="15.6" rx="2.2" ry="1.4" className="pxn05-av-eye" />
      </>
    )}
  </svg>
);

/** One order card in the stream. On phones a real card becomes a mini card (face, two lines, a green tick). */
const Order = ({ t, n, fake }: { t: T; n: string; fake?: boolean }) => (
  <div className={`pxn05-mv pxn05-${n}`}>
    <div className="pxn05-pos">
      <div className={`pxn05-card${fake ? ' pxn05-fake' : ''}`} dir={t('dir')}>
        <i className="pxn05-av">
          <Face mask={fake} />
          {!fake && (
            <svg className="pxn05-tick" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="8" />
              <path d="m4.6 8.2 2.3 2.3 4.6-4.8" />
            </svg>
          )}
        </i>
        <span className="pxn05-tx">
          <b>{t(`${n}.name`)}</b>
          <small>{t(`${n}.meta`)}</small>
        </span>
        {!fake && (
          <span className="pxn05-sk" aria-hidden="true">
            <i />
            <i />
          </span>
        )}
        <span className="pxn05-chips">
          <em className="pxn05-chip pxn05-new">{t('chip.new')}</em>
          {fake ? (
            <em className="pxn05-chip pxn05-bad">
              <span>{t('chip.fake1')}</span> <span className="pxn05-bad2">{t('chip.fake2')}</span>
            </em>
          ) : (
            <em className="pxn05-chip pxn05-ok">{t('chip.real')}</em>
          )}
        </span>
        {fake && (
          <span className="pxn05-dust" aria-hidden="true">
            <i style={{ ['--dx' as string]: '-46px', ['--dy' as string]: '-30px' }} />
            <i style={{ ['--dx' as string]: '-20px', ['--dy' as string]: '-44px' }} />
            <i style={{ ['--dx' as string]: '18px', ['--dy' as string]: '-38px' }} />
            <i style={{ ['--dx' as string]: '44px', ['--dy' as string]: '-14px' }} />
            <i style={{ ['--dx' as string]: '30px', ['--dy' as string]: '30px' }} />
            <i style={{ ['--dx' as string]: '-34px', ['--dy' as string]: '26px' }} />
          </span>
        )}
      </div>
    </div>
  </div>
);

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'overlay',
  side: 'end',
  // The words beside the card on a computer. They live in Copy (not in the aria-hidden picture), so screen readers get them.
  Copy: ({ t }) => (
    <div className="pxn05-cp" dir={t('dir')}>
      <div className="pxn05-cp-in">
        <p className="pxn05-eye">
          <i className="pxn05-eye-ic" aria-hidden="true">
            <Face mask />
          </i>
          {t('eyebrow')}
        </p>
        <h2 className="pxn05-h">
          {t('a')} <span>{t('b')}</span>
        </h2>
        <p className="pxn05-sub">{t('sub')}</p>
      </div>
    </div>
  ),
  Visual: ({ t }) => (
    <div className="pxn05" dir={t('dir')}>
      <div className="pxn05-scrim" />
      <div className="pxn05-zone">
        {/* computer only: the orders come from the whole page and run into the stream (before the shield, so none skips it) */}
        <svg className="pxn05-field" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path className="pxn05-f1" d="M5 0 C 8 10, 15 18, 30 23" />
          <path className="pxn05-f2" d="M19 0 C 21 9, 25 17, 34 23.6" />
          <path className="pxn05-f3" d="M33 0 C 33 8, 34 15, 38 22.5" />
          <path className="pxn05-f4" d="M0 52 C 3 40, 11 29, 27 25.4" />
          <path className="pxn05-f2" d="M0 78 C 2 55, 7 35, 25 26.3" />
          <path className="pxn05-f3" d="M0 99 C 1.5 66, 5 40, 24 27.2" />
        </svg>
        <div className="pxn05-lane">
          {/* computer only: after the pixel the counted stream curves around the card, beside it, never under it */}
          <svg className="pxn05-arc pxn05-arc-up" viewBox="0 0 40 100" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 100 C 26 98, 34 62, 30 0" />
          </svg>
          <svg className="pxn05-arc pxn05-arc-dn" viewBox="0 0 40 100" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 0 C 26 2, 36 38, 33 100" />
          </svg>
          <svg className="pxn05-flow" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 6 C 22 8, 34 40, 47 47 S 70 50, 100 50" />
            <path d="M0 28 C 20 30, 34 44, 47 48.5 S 72 50, 100 50" />
            <path d="M0 50 L 100 50" />
            <path d="M0 72 C 20 70, 34 56, 47 51.5 S 72 50, 100 50" />
            <path d="M0 94 C 22 92, 34 60, 47 53 S 70 50, 100 50" />
          </svg>
          <div className="pxn05-beam" />

          <Order t={t} n="c1" />
          <Order t={t} n="c2" />
          <Order t={t} n="c3" />
          <Order t={t} n="c4" fake />

          {/* phones only: the sign on the far side of the shield, it lights up each time a real order passes */}
          <em className="pxn05-gate" dir={t('dir')}>{t('chip.real')}</em>

          <div className="pxn05-shield">
            <i className="pxn05-shield-glow" />
            <svg viewBox="0 0 100 120" aria-hidden="true">
              <defs>
                <linearGradient id="pxn05-sg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#FBC45E" />
                  <stop offset="1" stopColor="#E8890E" />
                </linearGradient>
              </defs>
              <path d="M50 4 92 19v38c0 29-19 49-42 59C27 106 8 86 8 57V19z" fill="url(#pxn05-sg)" />
              <path d="M50 15 82 26.5v30.3c0 22.6-14.4 38.4-32 46.6-17.6-8.2-32-24-32-46.6V26.5z" className="pxn05-shield-in" />
              <path d="m35 58 10.5 10.5L67 47" className="pxn05-shield-ck" />
            </svg>
            <b className="pxn05-shield-lb" dir={t('dir')}>{t('shield')}</b>
          </div>

          <div className="pxn05-target">
            <i className="pxn05-ring pxn05-r1" />
            <i className="pxn05-ring pxn05-r2" />
            <i className="pxn05-ring pxn05-r3" />
            <i className="pxn05-dot" />
            <i className="pxn05-rp pxn05-c1" />
            <i className="pxn05-rp pxn05-c2" />
            <i className="pxn05-rp pxn05-c3" />
            <em className="pxn05-pop pxn05-c1" dir={t('dir')}>{t('pop')}</em>
            <em className="pxn05-pop pxn05-c2" dir={t('dir')}>{t('pop')}</em>
            <em className="pxn05-pop pxn05-c3" dir={t('dir')}>{t('pop')}</em>
            <b className="pxn05-px" dir="ltr">{t('pixel')}</b>
          </div>
        </div>

        {/* phones only: the host hides Copy there, so the headline sits under the shield, in the band above the card */}
        <p className="pxn05-ph" dir={t('dir')}>
          {t('a')} <span>{t('b')}</span>
        </p>
      </div>
    </div>
  ),
};
export default theme;
