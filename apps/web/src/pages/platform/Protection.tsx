// Pilotix Protection System (#/platform/protection): how the protection every store shares is growing. The network's
// size day by day (stores, the numbers and devices it knows, those 2 sellers agree on), the suspicious orders spotted
// across all stores, and each store's last 30 days. Counts only: the network keeps secret fingerprints, never a phone
// number, a name or an address. The preview (no server) shows a fixed example, marked as such.
import { ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n, pct, since } from '../../lib/format';
import { POut, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { Empty } from './bits';

type Stats = POut<'p.protection'>;
type Day = Stats['days'][number];
type Period = 7 | 30 | 90;
type Pick = 'agreed' | 'phones' | 'devices' | 'sharing' | 'stores';
const PICKS: Pick[] = ['agreed', 'phones', 'devices', 'sharing', 'stores'];
const DAY = 86_400_000;
/** an Algeria day ('YYYY-MM-DD'): Algeria is UTC+1 all year */
const algeriaDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);

export function ProtectionPage({ demo }: { demo?: boolean }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>(30);
  const [pick, setPick] = useState<Pick>('agreed');
  const [allStores, setAllStores] = useState(false);
  const q = usePRpc('p.protection', { days: period }, { enabled: !demo, refetchInterval: 5 * 60_000 });
  const example = useMemo(() => (demo ? demoStats(period) : null), [demo, period]);
  const s = (example ?? q.data) as Stats | undefined;
  if (!demo && q.isLoading) return <Loading />;
  if (!demo && (q.error || !s)) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!s) return null;

  const tt = s.totals;
  const caught = tt.blocked + tt.review;
  const days = s.days;
  // the first day the network's size was recorded inside the window (the network started that day, or before)
  const firstNet = days.findIndex((d) => d.stores !== null);
  const net = s.network;
  // the most targeted store of the last 30 days (enough orders to mean something)
  const worst = [...s.stores].filter((x) => x.orders >= 20).sort((a, b) => (b.blocked + b.review) / b.orders - (a.blocked + a.review) / a.orders)[0];
  const worstRate = worst ? (worst.blocked + worst.review) / worst.orders : 0;
  const stores = allStores ? s.stores : s.stores.slice(0, 8);

  return (
    <div className="pp-stack pp-prot">
      <div className="pp-head">
        <div>
          <h1>
            <Icon name="shield" /> {t('platform.nav.protection')}
          </h1>
          <p className="pp-prot-find">
            {tt.orders ? (
              <>
                {t('platform.prot.find', { count: caught, n: n(caught), orders: n(tt.orders), rate: pct(caught / tt.orders, 1), days: period })}
                {tt.network > 0 && <> {t('platform.prot.findNet', { count: tt.network, n: n(tt.network) })}</>}
              </>
            ) : (
              t('platform.prot.findNone', { days: period })
            )}
          </p>
        </div>
        <div className="pp-prot-when">
          <Tabs
            value={String(period)}
            onChange={(v) => setPeriod(Number(v) as Period)}
            items={([7, 30, 90] as const).map((d) => ({ value: String(d), label: t('platform.prot.period', { count: d }) }))}
          />
          <small className="muted">{s.lastRunAt ? t('platform.prot.updated', { ago: since(s.lastRunAt) }) : t('platform.prot.never')}</small>
        </div>
      </div>
      {demo && <p className="pp-prot-demo">{t('platform.prot.demoNote')}</p>}
      {!net && <p className="pp-warn">{t('platform.prot.starting')}</p>}

      <Kpis>
        <Kpi label={t('platform.prot.kCaught')} value={n(caught)} sub={t('platform.prot.kCaughtSub', { rate: tt.orders ? pct(caught / tt.orders, 1) : '—', orders: n(tt.orders) })} icon="shield" big />
        <Kpi label={t('platform.prot.kBlocked')} value={n(tt.blocked)} sub={t('platform.prot.kBlockedSub')} icon="lock" />
        <Kpi label={t('platform.prot.kReview')} value={n(tt.review)} sub={t('platform.prot.kReviewSub')} icon="eye" />
        <Kpi label={t('platform.prot.kNetwork')} value={n(tt.network)} sub={t('platform.prot.kNetworkSub', { count: s.minSellers })} icon="users" />
        <Kpi label={t('platform.prot.kCampaign')} value={n(tt.campaign)} sub={t('platform.prot.kCampaignSub')} icon="trend" />
      </Kpis>

      <BuyerQuality s={s} period={period} />

      <div className="pp-prot-grid">
        <Card title={t('platform.prot.byDay')} actions={<Legend />} className="pp-prot-days">
          <DayBars days={days} start={firstNet} />
        </Card>
        <Card title={t('platform.prot.net')} help={t('platform.prot.netHelp', { count: s.minSellers })} className="pp-prot-net">
          <ul className="pp-net" role="tablist" aria-label={t('platform.prot.net')}>
            {PICKS.map((k) => {
              const first = days.find((d) => d[k] !== null)?.[k] ?? null;
              const now = net ? net[k] : null;
              return (
                <li key={k}>
                  <button type="button" role="tab" aria-selected={pick === k} className={pick === k ? 'on' : ''} onClick={() => setPick(k)}>
                    <span className="pp-net-l">{t(`platform.prot.n.${k}`, { count: s.minSellers })}</span>
                    <b className="ltr">{n(now)}</b>
                    <small className="ltr">{now !== null && first !== null && firstNet >= 0 && firstNet < days.length - 1 ? delta(now - first) : '—'}</small>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="pp-net-since muted">
            {firstNet < 0 || firstNet >= days.length - 1 ? t('platform.prot.noGrowthYet') : firstNet > 0 ? t('platform.prot.sinceStart', { date: shortDay(days[firstNet].day) }) : t('platform.prot.inDays', { count: period })}
          </p>
          <Growth days={days} pick={pick} label={t(`platform.prot.n.${pick}`, { count: s.minSellers })} />
        </Card>
      </div>

      <Card title={t('platform.prot.stores')} badge={<span className="pp-count">{s.stores.length}</span>} actions={<small className="muted">{t('platform.prot.last30')}</small>}>
        {worst && worstRate >= 0.15 && (
          <p className="pp-prot-worst">
            {t('platform.prot.worst', { rate: pct(worstRate, 1) })}{' '}
            <a href={`#/platform/shops/${worst.id}`}>
              <b>{worst.name}</b>
            </a>
          </p>
        )}
        {s.stores.length ? (
          <div className="tbl-wrap">
            <table className="tbl pp-tbl pp-prot-tbl">
              <thead>
                <tr>
                  <th>{t('platform.prot.cStore')}</th>
                  <th className="num">{t('platform.prot.cOrders')}</th>
                  <th className="num" title={t('platform.prot.qHelp', { count: OPEN_DAYS })}>
                    {t('platform.prot.cGood')}
                  </th>
                  <th className="num">{t('platform.prot.cCaught')}</th>
                  <th className="num">{t('platform.prot.cBlocked')}</th>
                  <th className="num">{t('platform.prot.cReview')}</th>
                  <th className="num">{t('platform.prot.cNetwork')}</th>
                  <th className="num">{t('platform.prot.cCampaign')}</th>
                  <th className="num" title={t('platform.prot.sharedHelp')}>
                    {t('platform.prot.cShared')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {stores.map((x) => {
                  const c = x.blocked + x.review;
                  return (
                    <tr key={x.id}>
                      <td className="wide">
                        <a className="pp-shop" href={`#/platform/shops/${x.id}`}>
                          <b>{x.name}</b>
                        </a>
                      </td>
                      <td className="num ltr" data-l={t('platform.prot.cOrders')}>
                        {n(x.orders)}
                      </td>
                      <td className="num" data-l={t('platform.prot.cGood')}>
                        <span className="pp-two pp-two-r">
                          <span className="ltr">{x.buyers ? pct(x.good / x.buyers, 1) : '—'}</span>
                          <small className="muted ltr">{t('platform.prot.qOf', { n: n(x.good), buyers: n(x.buyers) })}</small>
                        </span>
                      </td>
                      <td className="num" data-l={t('platform.prot.cCaught')}>
                        <span className="pp-two pp-two-r">
                          <span className="ltr">{n(c)}</span>
                          <small className="muted ltr">{x.orders ? pct(c / x.orders, 1) : '—'}</small>
                        </span>
                      </td>
                      <td className="num ltr" data-l={t('platform.prot.cBlocked')}>
                        {n(x.blocked)}
                      </td>
                      <td className="num ltr" data-l={t('platform.prot.cReview')}>
                        {n(x.review)}
                      </td>
                      <td className="num ltr" data-l={t('platform.prot.cNetwork')}>
                        {n(x.network)}
                      </td>
                      <td className="num ltr" data-l={t('platform.prot.cCampaign')}>
                        {n(x.campaign)}
                      </td>
                      <td className="num ltr" data-l={t('platform.prot.cShared')}>
                        {n(x.shared)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{t('platform.prot.noStores')}</Empty>
        )}
        {s.stores.length > 8 && (
          <button type="button" className="btn small pp-prot-more" onClick={() => setAllStores((v) => !v)}>
            {allStores ? t('platform.prot.less') : t('platform.prot.all', { count: s.stores.length })}
          </button>
        )}
      </Card>

      <Card title={t('platform.prot.how')}>
        <ol className="pp-how">
          {(['learn', 'private', 'two', 'owner', 'never', 'forget'] as const).map((k, i) => (
            <li key={k}>
              <span className="pp-how-n ltr">{i + 1}</span>
              <div>
                <b>{t(`platform.prot.rule.${k}`, { count: s.minSellers })}</b>
                <span>{t(`platform.prot.rule.${k}Text`, { count: s.minSellers })}</span>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

const delta = (v: number) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');

function useLoc() {
  const { i18n } = useTranslation();
  return i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR';
}
const shortDayIn = (loc: string, day: string) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'UTC', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(day));
function shortDay(day: string) {
  const lang = document.documentElement.lang;
  return shortDayIn(lang === 'ar' ? 'ar-DZ' : lang === 'en' ? 'en-GB' : 'fr-FR', day);
}

/** drawn at the size it is shown, so its words keep their size (a phone, a half row, a full row) */
function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** round steps from 0 (1, 2, 5, 10, 20…), 4 or 5 of them, the top tick above the highest value */
function ticksFor(max: number): number[] {
  const m = Math.max(3, max);
  let step = 1;
  for (let k = 0; k < 30; k++) {
    step = [1, 2, 5][k % 3] * 10 ** Math.floor(k / 3);
    if (Math.floor(m / step) + 1 <= 5) break;
  }
  const top = (Math.floor(m / step) + 1) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/** which days get a date under the axis: the last one, then every few days back, on one regular step */
function labelStep(count: number, width: number): number {
  const fit = Math.max(2, Math.min(8, Math.floor(width / 64)));
  const raw = Math.ceil(count / fit);
  return [1, 2, 3, 5, 7, 10, 14, 15, 20, 30].find((s) => s >= raw) ?? raw;
}

function Axis({ ticks, y, L, R, W }: { ticks: number[]; y: (v: number) => number; L: number; R: number; W: number }) {
  return (
    <>
      {ticks.map((v, i) => (
        <g key={v}>
          <line className={i === 0 ? 'base' : 'g'} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text className="ax" x={L - 8} y={y(v) + 4} textAnchor="end">
            {n(v)}
          </text>
        </g>
      ))}
    </>
  );
}

function DateLabels({ days, x, iw, L, R, W, Hy }: { days: Day[]; x: (i: number) => number; iw: number; L: number; R: number; W: number; Hy: number }) {
  const loc = useLoc();
  const step = labelStep(days.length, iw);
  return (
    <>
      {days.map((d, i) =>
        (days.length - 1 - i) % step === 0 ? (
          <text key={d.day} className="ax" x={x(i)} y={Hy} textAnchor={x(i) < L + 24 ? 'start' : x(i) > W - R - 24 ? 'end' : 'middle'}>
            {shortDayIn(loc, d.day)}
          </text>
        ) : null,
      )}
    </>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <span className="pp-lg">
      <span>
        <i className="b" /> {t('platform.prot.lBlocked')}
      </span>
      <span>
        <i className="r" /> {t('platform.prot.lReview')}
      </span>
      <span>
        <i className="p" /> {t('platform.prot.lPassed')}
      </span>
    </span>
  );
}

/** a note above the plot, on its own row, with a 1px line down to what it explains (kept inside the frame) */
function Note({ x, row, to, W, text, dashed }: { x: number; row: number; to: number; W: number; text: string; dashed?: boolean }) {
  const right = x > W - 170;
  return (
    <g className={`mk${dashed ? ' dash' : ''}`}>
      <line x1={x} x2={x} y1={row + 4} y2={to} />
      <text x={x + (right ? -6 : 6)} y={row + 2} textAnchor={right ? 'end' : 'start'}>
        {text}
      </text>
    </g>
  );
}

/** every day of the window, all stores added up: passed (grey) at the bottom, to check (amber), blocked (coral) on top */
function DayBars({ days, start }: { days: Day[]; start: number }) {
  const { t, i18n } = useTranslation();
  const loc = useLoc();
  const [box, size] = useBox();
  const [hov, setHov] = useState<number | null>(null);
  // as wide and as tall as its card (the card is as tall as the network beside it)
  const W = Math.max(300, size.w || 720);
  const H = Math.max(240, size.h || 270);
  const mark = start > 0; // the network started inside the window: a dashed line on that day
  // the attack peak: the day with the most blocked orders, when it stands far above a usual day
  const usual = [...days.map((d) => d.blocked)].sort((a, b) => a - b)[Math.floor(days.length / 2)] ?? 0;
  const peakAt = days.reduce((b, d, i) => (d.blocked > days[b].blocked ? i : b), 0);
  const peak = days.length >= 5 && days[peakAt].blocked >= 10 && days[peakAt].blocked >= 2.5 * Math.max(1, usual) ? peakAt : -1;
  const rows = (mark ? 1 : 0) + (peak >= 0 ? 1 : 0);
  const T = 10 + rows * 17;
  const B = 26;
  const L = 44;
  const R = 6;
  const iw = W - L - R;
  const ih = H - T - B;
  const ticks = ticksFor(Math.max(0, ...days.map((d) => d.orders)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => T + ih - (v / top) * ih;
  const slot = iw / days.length;
  const bw = Math.min(34, Math.max(1, slot * (slot > 8 ? 0.7 : 0.78)));
  const x = (i: number) => L + slot * (i + 0.5);
  const seam = bw >= 6 ? 2 : 1;
  const h = hov === null ? null : days[hov];
  const empty = !days.some((d) => d.orders);
  return (
    <div className="pp-chart pp-fill" ref={box} onMouseLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={t('platform.prot.byDay')}>
        <Axis ticks={ticks} y={y} L={L} R={R} W={W} />
        {mark && <Note x={L + slot * start} row={12} to={T + ih} W={W} text={t('platform.prot.started')} dashed />}
        {peak >= 0 && (
          <Note
            x={x(peak)}
            row={12 + (mark ? 17 : 0)}
            to={y(days[peak].orders) - 2}
            W={W}
            text={t('platform.prot.peak', { n: n(days[peak].blocked), date: shortDayIn(loc, days[peak].day) })}
          />
        )}
        {days.map((d, i) => {
          const parts: [string, number][] = [
            ['p', Math.max(0, d.orders - d.blocked - d.review)],
            ['r', d.review],
            ['b', d.blocked],
          ];
          let base = T + ih;
          let below = false;
          const rects: ReactNode[] = [];
          for (const [cls, v] of parts) {
            if (!v) continue;
            const ht = Math.max(2, (v / top) * ih);
            const yTop = base - ht;
            rects.push(<rect key={cls} className={`s-${cls}`} x={x(i) - bw / 2} width={bw} y={yTop} height={Math.max(1, ht - (below ? seam : 0))} />);
            base = yTop;
            below = true;
          }
          return (
            <g key={d.day} className={hov === i ? 'on' : ''}>
              {hov === i && <rect className="hl" x={L + slot * i} width={slot} y={T} height={ih} />}
              {rects}
            </g>
          );
        })}
        <DateLabels days={days} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
        {days.map((d, i) => (
          <rect key={`h${d.day}`} x={L + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
        ))}
      </svg>
      {empty && <p className="pp-chart-empty muted">{t('platform.prot.none')}</p>}
      {h && hov !== null && (
        <div className="pp-tip" dir={i18n.dir()} style={{ left: `${Math.min(82, Math.max(18, (x(hov) / W) * 100))}%` }}>
          <b>{shortDayIn(loc, h.day)}</b>
          <span>
            {t('platform.prot.received')} <b className="ltr">{n(h.orders)}</b>
          </span>
          <span>
            <i className="b" /> {t('platform.prot.lBlocked')} <b className="ltr">{n(h.blocked)}</b>
          </span>
          <span>
            <i className="r" /> {t('platform.prot.lReview')} <b className="ltr">{n(h.review)}</b>
          </span>
          <span>
            <i className="p" /> {t('platform.prot.lPassed')} <b className="ltr">{n(Math.max(0, h.orders - h.blocked - h.review))}</b>
          </span>
          {h.network > 0 && (
            <span className="pp-tip-sub">
              {t('platform.prot.tipNetwork')} <b className="ltr">{n(h.network)}</b>
            </span>
          )}
          {h.campaign > 0 && (
            <span className="pp-tip-sub">
              {t('platform.prot.tipCampaign')} <b className="ltr">{n(h.campaign)}</b>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** the network's size day by day, one figure at a time; nothing before its first day (no made-up zeros) */
function Growth({ days, pick, label }: { days: Day[]; pick: Pick; label: string }) {
  const { t, i18n } = useTranslation();
  const loc = useLoc();
  const [box, size] = useBox();
  const [hov, setHov] = useState<number | null>(null);
  const pts = days.map((d, i) => ({ i, v: d[pick] })).filter((p): p is { i: number; v: number } => p.v !== null);
  const W = Math.max(260, size.w || 380);
  const T = 10;
  const B = 26;
  const L = 44;
  const R = 10;
  const H = 170;
  const iw = W - L - R;
  const ih = H - T - B;
  const ticks = ticksFor(Math.max(0, ...pts.map((p) => p.v)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => T + ih - (v / top) * ih;
  const slot = iw / days.length;
  const x = (i: number) => L + slot * (i + 0.5);
  // straight segments; a day with no record breaks the line
  let path = '';
  let prev = -2;
  for (const p of pts) {
    path += `${p.i === prev + 1 ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`;
    prev = p.i;
  }
  const near = hov === null ? null : pts.reduce<{ i: number; v: number } | null>((b, p) => (!b || Math.abs(p.i - hov) < Math.abs(b.i - hov) ? p : b), null);
  return (
    <div className="pp-chart pp-chart-line" ref={box} onMouseLeave={() => setHov(null)}>
      {pts.length < 2 ? (
        <p className="pp-chart-one muted">{pts.length ? t('platform.prot.oneDay', { date: shortDayIn(loc, days[pts[0].i].day) }) : t('platform.prot.noHistory')}</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
            <Axis ticks={ticks} y={y} L={L} R={R} W={W} />
            <path className="ln" d={path} />
            {near && <circle className="dt" cx={x(near.i)} cy={y(near.v)} r={4} />}
            <DateLabels days={days} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
            {days.map((d, i) => (
              <rect key={d.day} x={L + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
            ))}
          </svg>
          {near && (
            <div className="pp-tip" dir={i18n.dir()} style={{ left: `${Math.min(78, Math.max(22, (x(near.i) / W) * 100))}%` }}>
              <b>{shortDayIn(loc, days[near.i].day)}</b>
              <span>
                {label} <b className="ltr">{n(near.v)}</b>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** the last days are not finished: agents are still confirming their orders */
const OPEN_DAYS = 3;

/** Are the buyers getting better or worse? Of 100 orders received (a customer sending the same order again counts once),
 *  how many came from real buyers: confirmed by an agent, or delivered. Day by day, its 7-day average, and the period
 *  against the one before. */
function BuyerQuality({ s, period }: { s: Stats; period: Period }) {
  const { t } = useTranslation();
  const days = s.days;
  const done = days.slice(0, Math.max(0, days.length - OPEN_DAYS));
  const sum = (list: Day[], k: 'buyers' | 'good' | 'bad') => list.reduce((a, d) => a + d[k], 0);
  const buyers = sum(done, 'buyers');
  const now = buyers ? sum(done, 'good') / buyers : null;
  const pv = s.previous && s.previous.buyers ? s.previous.good / s.previous.buyers : null;
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
  return (
    <Card title={t('platform.prot.q')} help={t('platform.prot.qHelp', { count: OPEN_DAYS })} className="pp-q">
      <div className="pp-q-grid">
        <div className="pp-q-side">
          <div className="pp-q-lead">
            <b className="ltr">{now === null ? '—' : pct(now, 1)}</b>
            <span>{t('platform.prot.qLead')}</span>
          </div>
          {dir ? (
            <p className={`pp-q-trend ${dir}`}>
              <span className="pp-q-dir">
                {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '='} {t(`platform.prot.qDir.${dir}`)}
              </span>{' '}
              <b className="pp-q-pts">
                <span dir="ltr">{pts(delta!)}</span> {t('platform.prot.qPts')}
              </b>{' '}
              {t('platform.prot.qVs', { count: period, prev: pct(pv, 1) })}
            </p>
          ) : (
            <p className="pp-q-trend muted">{t('platform.prot.qNoPrev')}</p>
          )}
          {tt.buyers > 0 && (
            <>
              <div className="pp-q-bar" role="img" aria-label={parts.map((p) => `${t(`platform.prot.qPart.${p.k}`)} ${pct(p.v / tt.buyers)}`).join(', ')}>
                {parts.map((p) => (p.v ? <i key={p.k} className={`q-${p.k}`} style={{ flexGrow: p.v }} /> : null))}
              </div>
              <ul className="pp-q-parts">
                {parts.map((p) => (
                  <li key={p.k}>
                    <i className={`q-${p.k}`} />
                    <span>{t(`platform.prot.qPart.${p.k}`)}</span>
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

/** the buyers' quality day by day (thin grey), its 7-day average (the blue line), the unfinished last days dashed */
function QualityLine({ days }: { days: Day[] }) {
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
        <p className="pp-chart-one muted">{t('platform.prot.qNone')}</p>
      ) : (
        <>
          <span className="pp-lg pp-q-lg">
            {avgOn && (
              <span>
                <i className="qd" /> {t('platform.prot.qDaily')}
              </span>
            )}
            <span>
              <i className="qa" /> {avgOn ? t('platform.prot.qAvg') : t('platform.prot.qDaily')}
            </span>
            <span>
              <i className="qo" /> {t('platform.prot.qOpen')}
            </span>
          </span>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('platform.prot.q')}>
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
                {hov >= open ? ` · ${t('platform.prot.qOpenShort')}` : ''}
              </b>
              <span>
                {t('platform.prot.qPart.good')} <b className="ltr">{h.buyers ? pct(h.good / h.buyers, 1) : '—'}</b>
              </span>
              {avgOn && hov < open && (
                <span className="pp-tip-sub">
                  {t('platform.prot.qAvg')} <b className="ltr">{avg[hov] === null ? '—' : pct(avg[hov], 1)}</b>
                </span>
              )}
              <span className="pp-tip-sub">
                {t('platform.prot.qOf', { n: n(h.good), buyers: n(h.buyers) })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- the preview's example (no server): a fixed, believable platform — about two dozen stores, the network started
// 38 days ago and learns a little every day, two attack days. Marked « Exemple » on the page.
const EXAMPLE_STORES = [
  'Maison Alger', 'Oran Fashion', 'Sétif Électro', 'Bijoux Tlemcen', 'Kids Constantine', 'Béjaïa Beauté', 'Annaba Sport', 'Blida Déco',
  'Tizi Cuisine', 'Batna Shoes', 'Djelfa Parfums', 'Biskra Dattes', 'Mostaganem Bébé', 'Chlef Auto', 'Médéa Montres', 'Skikda Phone',
  'Jijel Maison', 'Bouira Outils', 'Ghardaïa Tapis', 'Tipaza Bio', 'Boumerdès Gym', 'El Oued Voyage', 'Mascara Lunettes', 'Laghouat Sacs',
];

/** splits a total between weights, the parts adding up exactly to the total */
function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

export function demoStats(period: Period, now = Date.now()): Stats {
  let seed = 20261029;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const START = 38;
  const all: Day[] = [];
  for (let k = 179; k >= 0; k--) {
    const day = algeriaDay(now - k * DAY);
    const friday = new Date(`${day}T12:00:00Z`).getUTCDay() === 5;
    const grow = 1 + (179 - k) / 300;
    const orders = Math.round((330 + rnd() * 140) * (friday ? 0.72 : 1) * grow);
    const attack = k === 11 ? 2.7 : k === 47 ? 1.9 : 1;
    const blocked = Math.round(orders * (0.04 + rnd() * 0.018) * attack);
    const review = Math.round(orders * (0.055 + rnd() * 0.02) * (attack > 1 ? 1.5 : 1));
    const live = k <= START;
    const age = START - k; // days since the network started
    const network = live ? Math.round((review + blocked) * Math.min(0.3, 0.05 + age * 0.0065)) : 0;
    const campaign = k === 11 ? Math.round(review * 0.42) : k === 47 ? Math.round(review * 0.3) : Math.round(rnd() * 4);
    // the buyers: a few send the same order again; real ones slowly more (the fakes find fewer ways in), less on attack
    // days; the last days are not finished (agents are still confirming)
    const buyers = orders - Math.round(orders * 0.03);
    const bad = Math.min(buyers, blocked + Math.round(review * 0.45));
    const q = (0.5 + (179 - k) * 0.0008 + (rnd() - 0.5) * 0.05) / (attack > 1 ? 1.12 : 1);
    const unfinished = k === 0 ? 0.5 : k === 1 ? 0.78 : k === 2 ? 0.92 : 1;
    const good = Math.min(buyers - bad, Math.round(buyers * q * unfinished));
    all.push({
      day,
      orders,
      blocked,
      review,
      network,
      campaign,
      buyers,
      good,
      bad,
      stores: live ? 15 + Math.floor(age / 4) : null,
      sharing: live ? 7 + Math.floor(age / 3.8) : null,
      phones: live ? Math.round(160 + age * 27 + age * age * 0.18) : null,
      devices: live ? Math.round(52 + age * 8.5) : null,
      agreed: live ? Math.round(4 + age * 1.15 + age * age * 0.031) : null,
    });
  }
  type Count = Stats['totals'];
  const KEYS: (keyof Count)[] = ['orders', 'blocked', 'review', 'network', 'campaign', 'buyers', 'good', 'bad'];
  const add = (list: Day[]) => {
    const c = Object.fromEntries(KEYS.map((k) => [k, 0])) as unknown as Count;
    for (const d of list) for (const k of KEYS) c[k] += d[k];
    return c;
  };
  const days = all.slice(-period);
  const totals = add(days);
  const previous = add(all.slice(-2 * period, -period));
  const last = all[all.length - 1];
  // each store's last 30 days: the same days, shared out (they add up to the 30-day totals)
  const month = add(all.slice(-30));
  const count = last.stores!;
  const names = EXAMPLE_STORES.slice(0, count);
  const weight = names.map((_, i) => 1 / (1 + i * 0.22));
  const hit = names.map((_, i) => (i === 2 ? 3.4 : i === 9 ? 1.8 : 0.75 + ((i * 37) % 10) / 20));
  const by = (k: keyof Count, w: number[]) => split(month[k], w);
  const per = {
    orders: by('orders', weight),
    blocked: by('blocked', weight.map((w, i) => w * hit[i])),
    review: by('review', weight.map((w, i) => w * hit[i])),
    network: by('network', weight.map((w, i) => w * (i < 6 ? 1.2 : 0.8))),
    campaign: by('campaign', weight.map((w, i) => w * (i === 2 ? 6 : 0.5))),
    buyers: by('buyers', weight),
    good: by('good', weight.map((w, i) => w * (1.12 - 0.12 * hit[i] + ((i * 53) % 7) / 60))),
    bad: by('bad', weight.map((w, i) => w * hit[i])),
  };
  const sharing = last.sharing!;
  const shared = split(Math.round((last.phones! + last.devices!) * 1.12), weight.map((w, i) => (i < sharing ? w : 0)));
  return {
    network: { stores: count, sharing, phones: last.phones!, devices: last.devices!, agreed: last.agreed! },
    totals,
    previous,
    days,
    stores: names
      .map((name, i) => ({ id: 1000 + i, name, slug: name.toLowerCase().replace(/[^a-z]+/g, '-'), shared: shared[i], ...(Object.fromEntries(KEYS.map((k) => [k, per[k][i]])) as unknown as Count) }))
      .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name)),
    minSellers: 2,
    lastRunAt: new Date(now - 12 * 60_000).toISOString(),
  };
}
