// Pilotix Protection System (#/platform/protection): how the protection every store shares is growing. The network's
// size day by day (stores, the numbers and devices it knows, those 2 sellers agree on), the suspicious orders spotted
// across all stores, and each store's last 30 days. Counts only: the network keeps secret fingerprints, never a phone
// number, a name or an address. The preview (no server) shows a fixed example, marked as such.
import { ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n, pct, since } from '../../lib/format';
import { POut, usePRpc } from '../../lib/platform';
import { Axis, DateLabels, shortDay, shortDayIn, ticksFor, useBox, useLoc } from '../../ui/chart';
import { Card, ErrorBox, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { BuyerQuality, OPEN_DAYS } from '../../ui/quality';
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
      {s.alert && <QualityAlertBox a={s.alert} />}

      <Kpis>
        <Kpi label={t('platform.prot.kCaught')} value={n(caught)} sub={t('platform.prot.kCaughtSub', { rate: tt.orders ? pct(caught / tt.orders, 1) : '—', orders: n(tt.orders) })} icon="shield" big />
        <Kpi label={t('platform.prot.kBlocked')} value={n(tt.blocked)} sub={t('platform.prot.kBlockedSub')} icon="lock" />
        <Kpi label={t('platform.prot.kReview')} value={n(tt.review)} sub={t('platform.prot.kReviewSub')} icon="eye" />
        <Kpi label={t('platform.prot.kNetwork')} value={n(tt.network)} sub={t('platform.prot.kNetworkSub', { count: s.minSellers })} icon="users" />
        <Kpi label={t('platform.prot.kCampaign')} value={n(tt.campaign)} sub={t('platform.prot.kCampaignSub')} icon="trend" />
      </Kpis>

      <BuyerQuality days={days} previous={s.previous} period={period} />

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
                  <th className="num" title={t('quality.help', { count: OPEN_DAYS })}>
                    {t('quality.part.good')}
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
                      <td className="num" data-l={t('quality.part.good')}>
                        <span className="pp-two pp-two-r">
                          <span className="ltr">{x.buyers ? pct(x.good / x.buyers, 1) : '—'}</span>
                          <small className="muted ltr">{t('quality.of', { n: n(x.good), buyers: n(x.buyers) })}</small>
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

/** The buyers' quality fell by 5 points or more this week (the whole platform, or some stores): said on top, in red. */
function QualityAlertBox({ a }: { a: NonNullable<Stats['alert']> }) {
  const { t } = useTranslation();
  const loc = useLoc();
  const fall = (w: { now: number; prev: number }) => `−${((w.prev - w.now) * 100).toFixed(1).replace('.', document.documentElement.lang === 'en' ? '.' : ',')}`;
  return (
    <div className="pp-q-alert" role="alert">
      <b>
        <Icon name="alert" /> {t('quality.alert.title')}
      </b>
      <p>
        {t('quality.alert.week', { from: shortDayIn(loc, a.week.from), to: shortDayIn(loc, a.week.to) })}{' '}
        {a.network && (
          <>
            {t('quality.alert.all', { now: pct(a.network.now, 1), prev: pct(a.network.prev, 1) })} (<span dir="ltr">{fall(a.network)}</span> {t('quality.pts')}).
          </>
        )}
      </p>
      {a.stores.length > 0 && (
        <ul>
          {a.stores.slice(0, 8).map((x) => (
            <li key={x.id}>
              <a href={`#/platform/shops/${x.id}`}>
                <b>{x.name}</b>
              </a>
              <span className="ltr">{pct(x.now, 1)}</span>
              <small>
                <span dir="ltr">{fall(x)}</span> {t('quality.pts')} · {t('quality.alert.buyers', { n: n(x.buyers) })}
              </small>
            </li>
          ))}
        </ul>
      )}
      <small className="pp-q-alert-n">{t('quality.alert.mail')}</small>
    </div>
  );
}

const delta = (v: number) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');

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
    // the example's attacked store: its buyers' quality fell this week
    alert: {
      at: new Date(now - 12 * 60_000).toISOString(),
      week: { from: algeriaDay(now - 9 * DAY), to: algeriaDay(now - 3 * DAY) },
      network: null,
      stores: [{ id: 1002, name: names[2], now: 0.512, prev: 0.588, buyers: 312 }],
      mailedAt: new Date(now - 2 * DAY).toISOString(),
    },
  };
}
