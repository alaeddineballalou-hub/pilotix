/** @jsxRuntime automatic */
// Theme 4 · «اعرف ما يتعطّل قبل أن يكلّفك» — a calm cockpit, one dial turns orange, Co-Pilot says what to fix.
import type { ReactElement } from 'react';
type T = (k: string, o?: Record<string, unknown>) => string;

/* One gauge: a 270° track, ticks, a red zone at the end and a needle. `alert` adds the orange and green layers. */
const TICKS = Array.from({ length: 11 }, (_, i) => -135 + i * 27);
function Dial({ label, value, alert, t }: { label: string; value?: string; alert?: boolean; t: T }): ReactElement {
  return (
    <div className={`pxn04-dial${alert ? ' pxn04-dial-alert' : ''}`}>
      <div className="pxn04-face">
        {alert && <i className="pxn04-halo" />}
        <svg viewBox="0 0 160 160" className="pxn04-svg">
          <circle cx="80" cy="80" r="74" className="pxn04-bezel" />
          <circle cx="80" cy="80" r="58" pathLength={100} className="pxn04-track" transform="rotate(135 80 80)" />
          <circle cx="80" cy="80" r="58" pathLength={100} className="pxn04-zone" transform="rotate(135 80 80)" />
          {!alert && <circle cx="80" cy="80" r="58" pathLength={100} className="pxn04-val" transform="rotate(135 80 80)" />}
          {alert && <circle cx="80" cy="80" r="58" pathLength={100} className="pxn04-val-or" transform="rotate(135 80 80)" />}
          {alert && <circle cx="80" cy="80" r="58" pathLength={100} className="pxn04-val-ok" transform="rotate(135 80 80)" />}
          {TICKS.map((a) => (
            <line key={a} x1="80" y1="14" x2="80" y2="21" className="pxn04-tick" transform={`rotate(${a} 80 80)`} />
          ))}
          <g className="pxn04-needle">
            <path d="M80 30 L84 80 L76 80 Z" />
            <circle cx="80" cy="80" r="7" />
          </g>
        </svg>
        {alert ? (
          <>
            <b className="pxn04-num pxn04-num-or">{t('n')}</b>
            <b className="pxn04-num pxn04-num-ok">{t('dNumOk')}</b>
            <small className="pxn04-unit">{t('dUnit')}</small>
          </>
        ) : (
          <b className="pxn04-num">{value}</b>
        )}
      </div>
      <span className="pxn04-cap">
        <i className="pxn04-led">{alert && <i className="pxn04-led-or" />}</i>
        {label}
      </span>
    </div>
  );
}

const theme: {
  layout: 'split' | 'overlay'; side: 'start' | 'end' | 'center'; panel?: string; light?: boolean; dark?: boolean;
  Visual: (p: { t: T }) => ReactElement; Copy?: (p: { t: T }) => ReactElement;
} = {
  layout: 'split',
  side: 'end',
  panel: 'radial-gradient(120% 90% at 50% 38%, #24375C 0%, #1B2A47 48%, #111C31 100%)',
  Visual: ({ t }) => (
    <div className="pxn04">
      <div className="pxn04-head" dir={t('dir')}>
        <h2 className="pxn04-h">
          <span>{t('a')}</span> <span className="pxn04-or">{t('b')}</span>
        </h2>
        <p className="pxn04-p">{t('sub')}</p>
      </div>

      <div className="pxn04-dials">
        <Dial t={t} label={t('d1')} value={t('d1v')} />
        <Dial t={t} label={t('d2')} alert />
        <Dial t={t} label={t('d3')} value={t('d3v')} />
      </div>

      <div className="pxn04-cardwrap">
        <div className="pxn04-card" dir={t('dir')}>
          {/* the same Co-Pilot, one view per role: the owner's warning is open, the other roles have their own */}
          <div className="pxn04-roles">
            <span className="pxn04-rt pxn04-rt-on">{t('r1')}</span>
            <span className="pxn04-rt">{t('r2')} <bdi className="pxn04-rn">{t('r2n')}</bdi></span>
            <span className="pxn04-rt pxn04-rt3">{t('r3')} <bdi className="pxn04-rn">{t('r3n')}</bdi></span>
          </div>
          <div className="pxn04-faces">
          {/* warning face: shown for most of the loop */}
          <div className="pxn04-warn">
            <div className="pxn04-top">
              <span className="pxn04-pilot">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" /></svg>
                <bdi>{t('pilot')}</bdi>
              </span>
              <span className="pxn04-tag">{t('alert')}</span>
            </div>
            <b className="pxn04-title">{t('stuck', { n: t('n') })}</b>
            <small className="pxn04-detail">
              <bdi dir="ltr" className="pxn04-nw">{t('amount')}</bdi> {t('detailA')} <bdi className="pxn04-nw">{t('courier')}</bdi> {t('detailB')}
            </small>
            <span className="pxn04-btn">{t('fix')}</span>
          </div>
          {/* fixed face: the final state (also the reduced-motion still) */}
          <div className="pxn04-ok">
            <svg className="pxn04-check" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" /><path d="M7 12.5l3.2 3.2L17 9" /></svg>
            <div className="pxn04-oktext">
              <span className="pxn04-tag pxn04-tag-ok">{t('okTag')}</span>
              <b className="pxn04-title">{t('okTitle', { n: t('n') })}</b>
              <small className="pxn04-detail"><bdi dir="ltr" className="pxn04-nw">{t('amount')}</bdi> {t('okDetail')}</small>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  ),
};
export default theme;
