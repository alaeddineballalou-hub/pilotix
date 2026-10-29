// « Qualité des acheteurs »: are the buyers getting better or worse? Of 100 orders received (a customer sending the
// same order again counts once), how many came from real buyers — confirmed by an agent, or delivered — day by day, its
// 7-day average, against the period before; and each ad's real buyers. The control room's Pilotix Protection System
// (all stores) and a store's own Protection page use the same pieces.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n, pct } from '../lib/format';
import { DateLabels, shortDayIn, useBox, useLoc } from './chart';
import { Card } from './kit';
import './chart.css';

export interface QualityCount {
  buyers: number;
  good: number;
  bad: number;
}
export interface QualityDay extends QualityCount {
  day: string;
}

/** the last days are not finished: agents are still confirming their orders */
export const OPEN_DAYS = 3;

/** Are the buyers getting better or worse? Of 100 orders received (a customer sending the same order again counts once),
 *  how many came from real buyers: confirmed by an agent, or delivered. Day by day, its 7-day average, and the period
 *  against the one before. */
export function BuyerQuality({ days, previous, period, className = '' }: { days: QualityDay[]; previous: QualityCount | null; period: number; className?: string }) {
  const { t } = useTranslation();
  const done = days.slice(0, Math.max(0, days.length - OPEN_DAYS));
  const sum = (list: QualityDay[], k: 'buyers' | 'good' | 'bad') => list.reduce((a, d) => a + d[k], 0);
  const buyers = sum(done, 'buyers');
  const now = buyers ? sum(done, 'good') / buyers : null;
  const pv = previous && previous.buyers ? previous.good / previous.buyers : null;
  const delta = now !== null && pv !== null ? (now - pv) * 100 : null;
  const dir = delta === null ? null : Math.abs(delta) < 1 ? 'flat' : delta > 0 ? 'up' : 'down';
  // the split, on the same finished days as the figure above it (one number, one meaning)
  const tt = { buyers, good: sum(done, 'good'), bad: sum(done, 'bad') };
  const other = Math.max(0, tt.buyers - tt.good - tt.bad);
  const parts = [
    { k: 'good', v: tt.good },
    { k: 'bad', v: tt.bad },
    { k: 'rest', v: other },
  ] as const;
  const pts = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', document.documentElement.lang === 'en' ? '.' : ',')}`;
  if (days.length <= OPEN_DAYS)
    return (
      <Card title={t('quality.title')} help={t('quality.help', { count: OPEN_DAYS })} className={`pp-q ${className}`}>
        <p className="pp-chart-one muted">{t('quality.short', { count: OPEN_DAYS })}</p>
      </Card>
    );
  return (
    <Card title={t('quality.title')} help={t('quality.help', { count: OPEN_DAYS })} className={`pp-q ${className}`}>
      <div className="pp-q-grid">
        <div className="pp-q-side">
          <div className="pp-q-lead">
            <b className="ltr">{now === null ? '—' : pct(now, 1)}</b>
            <span>{t('quality.lead')}</span>
          </div>
          {dir ? (
            <p className={`pp-q-trend ${dir}`}>
              <span className="pp-q-dir">
                {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '='} {t(`quality.dir.${dir}`)}
              </span>{' '}
              <b className="pp-q-pts">
                <span dir="ltr">{pts(delta!)}</span> {t('quality.pts')}
              </b>{' '}
              {t('quality.vs', { count: period, prev: pct(pv, 1) })}
            </p>
          ) : (
            <p className="pp-q-trend muted">{t('quality.noPrev')}</p>
          )}
          {tt.buyers > 0 && (
            <>
              <div className="pp-q-bar" role="img" aria-label={parts.map((p) => `${t(`quality.part.${p.k}`)} ${pct(p.v / tt.buyers)}`).join(', ')}>
                {parts.map((p) => (p.v ? <i key={p.k} className={`q-${p.k}`} style={{ flexGrow: p.v }} /> : null))}
              </div>
              <ul className="pp-q-parts">
                {parts.map((p) => (
                  <li key={p.k}>
                    <i className={`q-${p.k}`} />
                    <span>{t(`quality.part.${p.k}`)}</span>
                    <b className="ltr">{pct(p.v / tt.buyers, 1)}</b>
                    <small className="ltr">{n(p.v)}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <QualityLine days={days} />
      </div>
    </Card>
  );
}

/** the buyers' quality day by day (thin grey), its 7-day average (the blue line); the unfinished last days shaded */
function QualityLine({ days }: { days: QualityDay[] }) {
  const { t, i18n } = useTranslation();
  const loc = useLoc();
  const [box, size] = useBox();
  const [hov, setHov] = useState<number | null>(null);
  const W = Math.max(280, size.w || 640);
  const H = 220;
  const T = 10;
  const B = 26;
  const L = 44;
  const R = 10;
  const iw = W - L - R;
  const ih = H - T - B;
  const slot = iw / days.length;
  const x = (i: number) => L + slot * (i + 0.5);
  const open = days.length - OPEN_DAYS; // from this index on: not finished
  // each finished day (the unfinished ones are only half counted yet: left out of the grey line)
  const daily = days.map((d, i) => (d.buyers && i < open ? d.good / d.buyers : null));
  const avgOn = days.length >= 14;
  // the 7-day average: the days of the window up to this one (buyers added up, so a busy day weighs more)
  const avg = days.map((_, i) => {
    const w = days.slice(Math.max(0, i - 6), i + 1);
    const b = w.reduce((a, d) => a + d.buyers, 0);
    return b ? w.reduce((a, d) => a + d.good, 0) / b : null;
  });
  // drawn up to the last finished day only: the unfinished days would look like a fall that is not real
  const main = (avgOn ? avg : days.map((d) => (d.buyers ? d.good / d.buyers : null))).map((v, i) => (i < open ? v : null));
  // the scale follows the values (a rate, not a count: a rise of a few points must be seen), in steps of 5 or 10 points
  const seen = [...daily, ...main].filter((v): v is number => v !== null);
  const span = seen.length ? [Math.min(...seen), Math.max(...seen)] : [0, 1];
  const step = span[1] - span[0] > 0.3 ? 0.1 : 0.05;
  const lo = Math.max(0, Math.floor((span[0] - 0.02) / step) * step);
  const hi = Math.min(1, Math.max(lo + 2 * step, Math.ceil((span[1] + 0.02) / step) * step));
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
  const path = (vals: (number | null)[], from: number, to: number) => {
    let d = '';
    let prev = -2;
    for (let i = from; i <= to; i++) {
      const v = vals[i];
      if (v === null || v === undefined) continue;
      d += `${i === prev + 1 ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      prev = i;
    }
    return d;
  };
  const any = daily.some((v) => v !== null);
  const h = hov === null ? null : days[hov];
  return (
    <div className="pp-chart pp-q-chart" ref={box} onMouseLeave={() => setHov(null)}>
      {!any ? (
        <p className="pp-chart-one muted">{t('quality.none')}</p>
      ) : (
        <>
          <span className="pp-lg pp-q-lg">
            {avgOn && (
              <span>
                <i className="qd" /> {t('quality.daily')}
              </span>
            )}
            <span>
              <i className="qa" /> {avgOn ? t('quality.avg') : t('quality.daily')}
            </span>
            <span>
              <i className="qo" /> {t('quality.open')}
            </span>
          </span>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('quality.title')}>
            {ticks.map((v, i) => (
              <g key={i}>
                <line className={i === 0 ? 'base' : 'g'} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
                <text className="ax" x={L - 8} y={y(v) + 4} textAnchor="end">
                  {Math.round(v * 100)} %
                </text>
              </g>
            ))}
            {open > 0 && open < days.length && <rect className="pp-q-open" x={L + slot * open} y={T} width={W - R - (L + slot * open)} height={ih} />}
            {avgOn && <path className="qd" d={path(daily, 0, Math.max(0, open - 1))} />}
            <path className="qa" d={path(main, 0, days.length - 1)} />
            {h && main[hov!] !== null && main[hov!] !== undefined && <circle className="dt q" cx={x(hov!)} cy={y(main[hov!]!)} r={4} />}
            <DateLabels days={days} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
            {days.map((d, i) => (
              <rect key={d.day} x={L + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
            ))}
          </svg>
          {h && hov !== null && (
            <div className="pp-tip" dir={i18n.dir()} style={{ left: `${Math.min(80, Math.max(20, (x(hov) / W) * 100))}%` }}>
              <b>
                {shortDayIn(loc, h.day)}
                {hov >= open ? ` · ${t('quality.openShort')}` : ''}
              </b>
              <span>
                {t('quality.part.good')} <b className="ltr">{h.buyers ? pct(h.good / h.buyers, 1) : '—'}</b>
              </span>
              {avgOn && hov < open && (
                <span className="pp-tip-sub">
                  {t('quality.avg')} <b className="ltr">{avg[hov] === null ? '—' : pct(avg[hov], 1)}</b>
                </span>
              )}
              <span className="pp-tip-sub">
                {t('quality.of', { n: n(h.good), buyers: n(h.buyers) })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export interface AdQualityRow extends QualityCount {
  /** the ad set (else the ad, else the campaign of the link); null: the orders not from an ad */
  key: string | null;
  name: string | null;
  campaign: string | null;
  /** every order of the period (the counts above: its finished days only) */
  orders: number;
  prev: QualityCount;
}

/** fewer buyers than this: the share is shown, not a verdict or a trend */
const AD_MIN = 10;

/** Each ad: its orders, how many came from real buyers and how many were fake, and whether it got better or worse. The
 *  best and the worst ad are named on top (enough buyers), so a bad ad can be stopped. */
export function AdQuality({ ads, period, className = '' }: { ads: AdQualityRow[]; period: number; className?: string }) {
  const { t } = useTranslation();
  const q = (c: QualityCount) => (c.buyers ? c.good / c.buyers : null);
  const ranked = ads.filter((a) => a.key && a.buyers >= 2 * AD_MIN).sort((a, b) => q(b)! - q(a)!);
  const best = ranked.length >= 2 ? ranked[0] : null;
  const worst = ranked.length >= 2 ? ranked[ranked.length - 1] : null;
  const label = (a: AdQualityRow) => a.name ?? t('quality.ads.organic');
  return (
    <Card title={t('quality.ads.title')} help={t('quality.ads.help', { count: OPEN_DAYS })} className={`pp-q-ads ${className}`}>
      {!ads.length ? (
        <p className="pp-chart-one muted">{t('quality.ads.none')}</p>
      ) : (
        <>
          {best && worst && best !== worst && (
            <p className="pp-q-find">
              <span>
                {t('quality.ads.best')} <b dir="auto">{label(best)}</b> <b className="ltr q-good-t">{pct(q(best), 1)}</b>
              </span>
              <span>
                {t('quality.ads.worst')} <b dir="auto">{label(worst)}</b> <b className="ltr q-bad-t">{pct(q(worst), 1)}</b>
                {q(worst)! < 0.5 && <> · {t('quality.ads.stop')}</>}
              </span>
            </p>
          )}
          <div className="tbl-wrap">
            <table className="tbl pp-q-tbl">
              <thead>
                <tr>
                  <th>{t('quality.ads.cAd')}</th>
                  <th className="num">{t('quality.ads.cOrders')}</th>
                  <th className="num">{t('quality.part.good')}</th>
                  <th className="num">{t('quality.ads.cBad')}</th>
                  <th className="num">{t('quality.ads.cTrend', { count: period })}</th>
                </tr>
              </thead>
              <tbody>
                {ads.map((a) => {
                  const now = q(a);
                  const before = q(a.prev);
                  const d = now !== null && before !== null && a.buyers >= AD_MIN && a.prev.buyers >= AD_MIN ? (now - before) * 100 : null;
                  return (
                    <tr key={a.key ?? '-'} className={a.key ? '' : 'pp-q-organic'}>
                      <td className="wide">
                        <span className="pp-q-ad">
                          <b dir="auto">{label(a)}</b>
                          {a.campaign && a.campaign !== a.name && <small dir="auto">{a.campaign}</small>}
                        </span>
                      </td>
                      <td className="num ltr" data-l={t('quality.ads.cOrders')}>
                        {n(a.orders)}
                      </td>
                      <td className="num" data-l={t('quality.part.good')}>
                        <span className="pp-q-two">
                          <span className="ltr">{now === null ? '—' : pct(now, 1)}</span>
                          <small className="ltr">{t('quality.of', { n: n(a.good), buyers: n(a.buyers) })}</small>
                        </span>
                      </td>
                      <td className="num ltr" data-l={t('quality.ads.cBad')}>
                        {a.buyers ? pct(a.bad / a.buyers, 1) : '—'}
                      </td>
                      <td className={`num ${d === null ? '' : Math.abs(d) < 1 ? '' : d > 0 ? 'q-up' : 'q-down'}`} data-l={t('quality.ads.cTrend', { count: period })}>
                        {d === null ? '—' : Math.abs(d) < 1 ? '=' : <span dir="ltr">{`${d > 0 ? '▲ +' : '▼ −'}${Math.abs(d).toFixed(1).replace('.', document.documentElement.lang === 'en' ? '.' : ',')}`}</span>}
                        {d !== null && Math.abs(d) >= 1 && <> {t('quality.pts')}</>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
