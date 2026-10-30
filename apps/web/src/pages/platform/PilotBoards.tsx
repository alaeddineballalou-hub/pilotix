// Pilot AI › Dellal AI, CM AI and Spy AI: what each of the shops' AI agents did over the last 7, 30 or 90 days, every
// shop together or one (and, for Dellal, one of its products). Dellal is judged on the chats that started in the period:
// of 100 chats, how many ended with an order (conversion), how many with a parcel delivered and paid (real sales, its true
// win: counted only once the parcels had about a week to arrive). One finding in words with what it is compared to, the
// figures as type, the trend as two lines on one scale, then each shop, product or channel.
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, pct } from '../../lib/format';
import { POut, usePRpc } from '../../lib/platform';
import { DateLabels, shortDayIn, ticksFor, Axis, useBox, useLoc } from '../../ui/chart';
import { Card, ErrorBox, Loading, Tabs } from '../../ui/kit';

export type BoardDays = 7 | 30 | 90;
type Dellal = POut<'p.dellal.board'>;
type Cm = POut<'p.cm.board'>;
type Spy = POut<'p.spy.board'>;
type Pt = Dellal['series'][number];

/** a rate given in % (24.3) as « 24,3 % » */
const rate = (v: number | null | undefined) => (v === null || v === undefined ? '—' : pct(v / 100, 1));
/** a figure inside a sentence: kept in one piece, left to right, in an Arabic sentence too */
const keep = (s: string) => `\u2066${s.replace(/ /g, '\u00a0')}\u2069`;
const usd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x > 0 && x < 0.01 ? '< 0.01 $' : `${x.toFixed(2)} $`);
/** a small amount (an AI answer, an order): three or four decimals, never rounded down to « 0.01 $ » */
const usdSmall = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x >= 0.1 ? `${x.toFixed(2)} $` : x >= 0.001 ? `${x.toFixed(3)} $` : x > 0 ? '< 0.001 $' : '0 $');
const comma = (v: number) => Math.abs(v).toFixed(1).replace('.', document.documentElement.lang === 'en' ? '.' : ',');

/** a change against the period before: in points for a rate, in % for a count; « = » under half a point / 1 %; null
 *  when there is nothing to compare with */
function delta(t: (k: string) => string, now: number | null, before: number | null, o: { pts?: boolean; goodDown?: boolean } = {}) {
  if (now === null || before === null || (!o.pts && before === 0)) return null;
  const d = o.pts ? now - before : ((now - before) / before) * 100;
  const flat = o.pts ? Math.abs(d) < 0.5 : Math.abs(d) < 1;
  const good = flat ? null : d > 0 !== !!o.goodDown;
  return (
    <span className={`pb-delta ${good === null ? 'flat' : good ? 'good' : 'bad'}`} title={t('platform.pilot.board.vsPrev')}>
      <span dir="ltr">
        {flat ? '=' : d > 0 ? '▲ +' : '▼ −'}
        {flat ? '' : o.pts ? comma(d) : Math.round(Math.abs(d))}
      </span>
      {flat ? ` ${t('platform.pilot.board.dir.flat')}` : o.pts ? ` ${t('platform.pilot.board.pts')}` : ' %'}
    </span>
  );
}
/** the small line under a figure: its pieces joined by « · », the empty ones left out */
function parts(...items: React.ReactNode[]) {
  const list = items.filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return list.length ? list.map((x, i) => (
    <Fragment key={i}>
      {i > 0 && ' · '}
      {x}
    </Fragment>
  )) : null;
}

/** one figure, set as type: what it is, the number, then what it is compared to */
function Fig({ label, value, sub, help }: { label: string; value: string; sub?: React.ReactNode; help?: string }) {
  return (
    <div className="pb-fig" title={help}>
      <span className="pb-fig-l">{label}</span>
      <b className="pb-fig-v ltr">{value}</b>
      {sub && <span className="pb-fig-s">{sub}</span>}
    </div>
  );
}

/** the period (7, 30, 90 days), the shop and, for Dellal, the product: in one row above everything they change */
export function BoardBar({
  days,
  onDays,
  shops,
  shopId,
  onShop,
  products,
  productId,
  onProduct,
  busy,
}: {
  days: BoardDays;
  onDays: (d: BoardDays) => void;
  shops: { id: number; name: string }[];
  shopId: number | null;
  onShop: (id: number | null) => void;
  products?: { id: number; name: string }[];
  productId?: number | null;
  onProduct?: (id: number | null) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="pb-bar" aria-busy={busy}>
      <Tabs value={String(days)} onChange={(v) => onDays(Number(v) as BoardDays)} items={([7, 30, 90] as const).map((d) => ({ value: String(d), label: t('platform.pilot.board.days', { days: d }) }))} />
      <select className="pb-sel" value={shopId ?? ''} onChange={(e) => onShop(e.target.value ? Number(e.target.value) : null)} aria-label={t('platform.pilot.board.shop')}>
        <option value="">{t('platform.pilot.board.allShops', { n: shops.length })}</option>
        {shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {onProduct && (
        <select
          className="pb-sel"
          value={productId ?? ''}
          disabled={!shopId}
          title={shopId ? undefined : t('platform.pilot.board.productNeedsShop')}
          onChange={(e) => onProduct(e.target.value ? Number(e.target.value) : null)}
          aria-label={t('platform.pilot.board.product')}
        >
          <option value="">{shopId ? t('platform.pilot.board.allProducts') : t('platform.pilot.board.productNeedsShop')}</option>
          {(products ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {busy && <span className="pb-busy muted small">{t('platform.pilot.board.loading')}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- Dellal
export function DellalBoard({ days, onDays, shopId, onShop, manager, aside }: { days: BoardDays; onDays: (d: BoardDays) => void; shopId: number | null; onShop: (id: number | null) => void; manager: boolean; aside?: React.ReactNode }) {
  const { t } = useTranslation();
  const [productId, setProductId] = useState<number | null>(null);
  const q = usePRpc('p.dellal.board', { days, ...(shopId ? { shopId } : {}), ...(shopId && productId ? { productId } : {}) }, { refetchInterval: 5 * 60_000 });
  const d = q.data;
  const pickShop = (id: number | null) => {
    setProductId(null);
    onShop(id);
  };
  const scope = !d ? '' : d.productId ? d.products.find((p) => p.id === d.productId)?.name ?? '' : d.shopId ? d.shops.find((s) => s.id === d.shopId)?.name ?? '' : t('platform.pilot.board.everyShop');
  return (
    <>
    <Card title={t('platform.pilot.board.title')} help={t('platform.pilot.board.help', { days: d?.saleDays ?? 7 })} className="pb-card">
      <BoardBar days={days} onDays={onDays} shops={d?.shops ?? []} shopId={shopId} onShop={pickShop} products={d?.products} productId={productId} onProduct={setProductId} busy={q.isFetching && !!d} />
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {!!d.skipped.length && <p className="warnbox small">{t('platform.pilot.board.skipped', { names: d.skipped.join(', ') })}</p>}
          <Finding d={d} scope={scope} />
          <div className="pb-figs">
            <Fig label={t('platform.pilot.board.k.chats')} value={n(d.kpi.chats)} sub={parts(delta(t, d.kpi.chats, d.prev.chats))} />
            <Fig
              label={t('platform.pilot.board.k.conversion')}
              value={rate(d.kpi.conversion)}
              sub={parts(delta(t, d.kpi.conversion, d.prev.conversion, { pts: true }), t('platform.pilot.board.k.ofChats', { n: n(d.kpi.ordered), of: n(d.kpi.chats) }))}
              help={t('platform.pilot.board.k.conversionHelp')}
            />
            <Fig
              label={t('platform.pilot.board.k.realSales')}
              value={rate(d.kpi.realSales)}
              sub={d.kpi.realSales === null ? t('platform.pilot.board.k.tooEarly', { days: d.saleDays }) : parts(delta(t, d.kpi.realSales, d.prev.realSales, { pts: true }), t('platform.pilot.board.k.ofChats', { n: n(d.kpi.ripeSold), of: n(d.kpi.ripeChats) }))}
              help={t('platform.pilot.board.k.realSalesHelp', { days: d.saleDays })}
            />
            <Fig
              label={t('platform.pilot.board.k.deliveredRate')}
              value={rate(d.kpi.deliveredRate)}
              sub={parts(delta(t, d.kpi.deliveredRate, d.prev.deliveredRate, { pts: true }), t('platform.pilot.board.k.ended', { ok: n(d.kpi.delivered), lost: n(d.kpi.lost) }))}
              help={t('platform.pilot.board.k.deliveredRateHelp')}
            />
            <Fig label={t('platform.pilot.board.k.revenue')} value={da(d.kpi.revenue)} sub={t('platform.pilot.board.k.pending', { count: d.kpi.pending, n: n(d.kpi.pending) })} />
            <Fig label={t('platform.pilot.board.k.basket')} value={d.kpi.basket === null ? '—' : da(d.kpi.basket)} sub={parts(delta(t, d.kpi.basket, d.prev.basket))} />
            <Fig
              label={t('platform.pilot.board.k.handed')}
              value={rate(d.kpi.handedRate)}
              sub={parts(delta(t, d.kpi.handedRate, d.prev.handedRate, { pts: true, goodDown: true }), t('platform.pilot.board.k.handedN', { count: d.kpi.handed, n: n(d.kpi.handed) }))}
              help={t('platform.pilot.board.k.handedHelp')}
            />
            {manager && d.cost && !d.productId && (
              <Fig
                label={d.cost.perOrder === null ? t('platform.pilot.board.k.costAll') : t('platform.pilot.board.k.cost')}
                value={d.cost.perOrder === null ? usd(d.cost.usd) : usdSmall(d.cost.perOrder)}
                sub={d.cost.perOrder === null ? t('platform.pilot.board.k.costTotal') : t('platform.pilot.board.k.costOf', { usd: usd(d.cost.usd) })}
                help={t('platform.pilot.board.k.costHelp')}
              />
            )}
          </div>
          <RateChart d={d} />
          <Breakdown d={d} onShop={pickShop} onProduct={setProductId} />
        </>
      )}
    </Card>
      <div className="pp-grid">
        {d ? <WhyCard d={d} /> : null}
        {aside}
      </div>
    </>
  );
}

/** the one sentence on top: the conversion of the period and where it goes, against the period just before it */
function Finding({ d, scope }: { d: Dellal; scope: string }) {
  const { t } = useTranslation();
  if (!d.kpi.chats) return <p className="pb-find muted">{t('platform.pilot.board.none', { days: d.days, scope })}</p>;
  const now = d.kpi.conversion!;
  const was = d.prev.conversion;
  const diff = was === null ? null : now - was;
  const dir = diff === null ? null : Math.abs(diff) < 0.5 ? 'flat' : diff > 0 ? 'up' : 'down';
  return (
    <p className="pb-find">
      {t('platform.pilot.board.find', { days: d.days, scope, rate: keep(rate(now)) })}{' '}
      {dir === null ? (
        <span className="muted">{t('platform.pilot.board.findNoPrev', { days: d.days })}</span>
      ) : (
        <span className={`pb-find-${dir}`}>
          <b>
            {dir === 'flat' ? t('platform.pilot.board.dir.flat') : t(`platform.pilot.board.dir.${dir}`, { pts: keep(comma(diff!)) })}
          </b>{' '}
          {t('platform.pilot.board.findVs', { days: d.days, rate: keep(rate(was)) })}
        </span>
      )}
    </p>
  );
}

/** conversion and real sales, one point a day (a week for 90 days; a 7-day average for 30 days), on one % scale */
function RateChart({ d }: { d: Dellal }) {
  const { t, i18n } = useTranslation();
  const loc = useLoc();
  const [box, size] = useBox();
  const [hov, setHov] = useState<number | null>(null);
  const pts = d.series;
  const W = Math.max(300, size.w || 720);
  const H = 250;
  const T = 14;
  const B = 26;
  const L = 44;
  const R = 92;
  const iw = W - L - R;
  const ih = H - T - B;
  const slot = iw / pts.length;
  const x = (i: number) => L + slot * (i + 0.5);
  // 30 days: each point is the 7 days up to it (chats added up, a busy day weighs more), so a small shop's line is readable
  const smooth = d.bucket === 'day' && pts.length >= 14;
  const win = (i: number) => (smooth ? pts.slice(Math.max(0, i - 6), i + 1) : [pts[i]]);
  const sum = (list: Pt[], k: 'chats' | 'ordered' | 'ripeChats' | 'sold') => list.reduce((a, p) => a + p[k], 0);
  const conv = pts.map((_, i) => {
    const w = win(i);
    const c = sum(w, 'chats');
    return c ? (sum(w, 'ordered') / c) * 100 : null;
  });
  // real sales: only where the parcels had time to arrive (the newest days would look like a fall that is not real)
  const real = pts.map((p, i) => {
    if (p.open) return null;
    const w = win(i);
    const c = sum(w, 'ripeChats');
    return c ? (sum(w, 'sold') / c) * 100 : null;
  });
  const seen = [...conv, ...real].filter((v): v is number => v !== null);
  if (!seen.length) return <p className="pp-chart-one muted">{t('platform.pilot.board.noLine')}</p>;
  const hi0 = Math.max(...seen);
  const lo0 = Math.min(...seen);
  const step = hi0 - lo0 > 30 ? 10 : 5;
  const lo = Math.max(0, Math.floor((lo0 - 2) / step) * step);
  const hi = Math.min(100, Math.max(lo + 2 * step, Math.ceil((hi0 + 2) / step) * step));
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
  const path = (vals: (number | null)[]) => {
    let s = '';
    let prev = -2;
    vals.forEach((v, i) => {
      if (v === null) return;
      s += `${i === prev + 1 ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      prev = i;
    });
    return s;
  };
  const lastOf = (vals: (number | null)[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i;
    return -1;
  };
  const lc = lastOf(conv);
  const lr = lastOf(real);
  // the names at the end of each line (never on top of each other)
  let yc = lc >= 0 ? y(conv[lc]!) : 0;
  let yr = lr >= 0 ? y(real[lr]!) : 0;
  if (lc >= 0 && lr >= 0 && Math.abs(yc - yr) < 16) {
    const mid = (yc + yr) / 2;
    if (yc <= yr) (yc = mid - 8), (yr = mid + 8);
    else (yc = mid + 8), (yr = mid - 8);
  }
  const open = pts.findIndex((p) => p.open);
  const h = hov === null ? null : pts[hov];
  const label = (p: Pt) => (d.bucket === 'week' ? t('platform.pilot.board.week', { day: shortDayIn(loc, p.day) }) : shortDayIn(loc, p.day));
  return (
    <div className="pp-chart pb-chart" ref={box} onMouseLeave={() => setHov(null)}>
      <div className="pb-chart-head">
        <span className="pp-lg">
          <span>
            <i className="pb-k-conv" /> {t('platform.pilot.board.k.conversion')}
          </span>
          <span>
            <i className="pb-k-real" /> {t('platform.pilot.board.k.realSales')}
          </span>
          {open >= 0 && (
            <span>
              <i className="qo" /> {t('platform.pilot.board.open', { days: d.saleDays })}
            </span>
          )}
        </span>
        <small className="muted">{smooth ? t('platform.pilot.board.avg7') : d.bucket === 'week' ? t('platform.pilot.board.perWeek') : t('platform.pilot.board.perDay')}</small>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('platform.pilot.board.chartLabel', { conv: rate(d.kpi.conversion), real: rate(d.kpi.realSales) })}>
        {ticks.map((v, i) => (
          <g key={v}>
            <line className={i === 0 ? 'base' : 'g'} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="ax" x={L - 8} y={y(v) + 4} textAnchor="end">
              {v} %
            </text>
          </g>
        ))}
        {open >= 0 && <rect className="pp-q-open" x={L + slot * open} y={T} width={W - R - (L + slot * open)} height={ih} />}
        {hov !== null && <line className="pb-cross" x1={x(hov)} x2={x(hov)} y1={T} y2={T + ih} />}
        <path className="pb-l-real" d={path(real)} />
        <path className="pb-l-conv" d={path(conv)} />
        {/* a point alone (no neighbour to join) is still seen */}
        {real.map((v, i) => (v !== null && real[i - 1] == null && real[i + 1] == null ? <circle key={`r${i}`} className="pb-d-real" cx={x(i)} cy={y(v)} r={3.5} /> : null))}
        {conv.map((v, i) => (v !== null && conv[i - 1] == null && conv[i + 1] == null ? <circle key={`c${i}`} className="pb-d-conv" cx={x(i)} cy={y(v)} r={3.5} /> : null))}
        {hov !== null && conv[hov] !== null && <circle className="pb-d-conv on" cx={x(hov)} cy={y(conv[hov]!)} r={4.5} />}
        {hov !== null && real[hov] !== null && <circle className="pb-d-real on" cx={x(hov)} cy={y(real[hov]!)} r={4.5} />}
        {lc >= 0 && (
          <text className="pb-end" x={x(lc) + 8} y={yc + 4}>
            {rate(conv[lc])}
          </text>
        )}
        {lr >= 0 && (
          <text className="pb-end" x={x(lr) + 8} y={yr + 4}>
            {rate(real[lr])}
          </text>
        )}
        <DateLabels days={pts} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
        {pts.map((p, i) => (
          <rect key={p.day} x={L + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
        ))}
      </svg>
      {h && hov !== null && (
        <div className="pp-tip" dir={i18n.dir()} style={{ left: `${Math.min(80, Math.max(20, (x(hov) / W) * 100))}%` }}>
          <b>{label(h)}</b>
          <span>
            <i className="pb-k-conv" /> {t('platform.pilot.board.k.conversion')} <b className="ltr">{rate(conv[hov])}</b>
          </span>
          <span>
            <i className="pb-k-real" /> {t('platform.pilot.board.k.realSales')} <b className="ltr">{h.open ? t('platform.pilot.board.onRoad') : rate(real[hov])}</b>
          </span>
          <span className="pp-tip-sub">{t('platform.pilot.board.tip', { chats: n(sum(win(hov), 'chats')), orders: n(sum(win(hov), 'ordered')) })}</span>
          {smooth && <span className="pp-tip-sub">{t('platform.pilot.board.avg7')}</span>}
        </div>
      )}
    </div>
  );
}

/** each shop (all shops), each product (one shop) or each channel (one product): click a shop or a product to look closer */
function Breakdown({ d, onShop, onProduct }: { d: Dellal; onShop: (id: number) => void; onProduct: (id: number) => void }) {
  const { t } = useTranslation();
  if (!d.rows.length) return null;
  const name = (key: string, label: string) =>
    d.rowKind === 'channel' ? (
      t(`platform.pilot.board.ch.${key}`, { defaultValue: label })
    ) : (
      <button type="button" className="pb-go" onClick={() => (d.rowKind === 'shop' ? onShop(Number(key)) : onProduct(Number(key)))}>
        {label}
      </button>
    );
  return (
    <div className="pb-break">
      <h3 className="pb-h">{t(`platform.pilot.board.by.${d.rowKind}`)}</h3>
      <div className="tbl-wrap">
        <table className="tbl pp-tbl pb-tbl">
          <thead>
            <tr>
              <th>{t(`platform.pilot.board.col.${d.rowKind}`)}</th>
              <th className="num">{t('platform.pilot.board.k.chats')}</th>
              <th className="num">{t('platform.pilot.board.col.orders')}</th>
              <th className="num">{t('platform.pilot.board.k.conversion')}</th>
              <th className="num">{t('platform.pilot.board.k.realSales')}</th>
              <th className="num">{t('platform.pilot.board.k.deliveredRate')}</th>
              <th className="num">{t('platform.pilot.board.k.revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.key}>
                <td className="wide" data-l={t(`platform.pilot.board.col.${d.rowKind}`)}>
                  {name(r.key, r.label)}
                </td>
                <td className="num ltr" data-l={t('platform.pilot.board.k.chats')}>
                  {n(r.chats)}
                </td>
                <td className="num ltr" data-l={t('platform.pilot.board.col.orders')}>
                  {n(r.orders)}
                </td>
                <td className="num ltr" data-l={t('platform.pilot.board.k.conversion')}>
                  <b>{rate(r.conversion)}</b>
                </td>
                <td className="num ltr" data-l={t('platform.pilot.board.k.realSales')} title={r.realSales === null ? t('platform.pilot.board.onRoad') : undefined}>
                  {rate(r.realSales)}
                </td>
                <td className="num ltr" data-l={t('platform.pilot.board.k.deliveredRate')}>
                  {rate(r.deliveredRate)}
                </td>
                <td className="num ltr" data-l={t('platform.pilot.board.k.revenue')}>
                  {r.revenue ? da(r.revenue) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.rowKind !== 'channel' && <p className="small muted">{t(`platform.pilot.board.go.${d.rowKind}`)}</p>}
    </div>
  );
}

/** Why chats ended without a sale: what Pilot AI read at night (the shops that teach Dellal), the biggest reason first */
function WhyCard({ d }: { d: Dellal }) {
  const { t } = useTranslation();
  return (
    <Card title={t('platform.pilot.why.title')} help={t('platform.pilot.why.help')} className="pb-why">
      {!d.whyTotal ? (
        <p className="muted">{t('platform.pilot.why.none', { days: d.days })}</p>
      ) : (
        <>
          <p className="small">{t('platform.pilot.why.lead', { count: d.whyTotal, n: n(d.whyTotal), days: d.days })}</p>
          <ul className="pb-why-list">
            {d.why.map((w) => (
              <li key={`${w.outcome}-${w.reason}`}>
                <span className="pb-why-l">
                  <b>{t(`platform.pilot.outcome.${w.outcome}`, { defaultValue: w.outcome })}</b> · {t(`platform.pilot.reason.${w.reason}`, { defaultValue: w.reason })}
                </span>
                <b className="pb-why-v ltr">{rate(w.pct)}</b>
                <span className="pb-why-n ltr">{n(w.n)}</span>
                <i className="pb-why-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, w.pct ?? 0)}%` }} />
                </i>
              </li>
            ))}
          </ul>
          <p className="small muted">{t(`platform.pilot.why.tip.${d.why[0].outcome}`, { defaultValue: t('platform.pilot.why.tip.other') })}</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- CM AI agent
export function CmBoard({ days, onDays, shopId, onShop, manager }: { days: BoardDays; onDays: (d: BoardDays) => void; shopId: number | null; onShop: (id: number | null) => void; manager: boolean }) {
  const { t } = useTranslation();
  const q = usePRpc('p.cm.board', { days, ...(shopId ? { shopId } : {}) }, { refetchInterval: 5 * 60_000 });
  const d = q.data;
  return (
    <Card title={t('platform.pilot.cm.title')} help={t('platform.pilot.cm.help')} className="pb-card">
      <BoardBar days={days} onDays={onDays} shops={d?.shops ?? []} shopId={shopId} onShop={onShop} busy={q.isFetching && !!d} />
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {!!d.skipped.length && <p className="warnbox small">{t('platform.pilot.board.skipped', { names: d.skipped.join(', ') })}</p>}
          <p className={`pb-find ${d.kpi.comments ? '' : 'muted'}`}>
            {d.kpi.comments
              ? t('platform.pilot.cm.find', { days: d.days, n: n(d.kpi.comments), answered: keep(pct(d.kpi.answered / d.kpi.comments)), privates: n(d.kpi.privates), hidden: n(d.kpi.hidden) })
              : t('platform.pilot.cm.none', { days: d.days })}
          </p>
          <div className="pb-figs">
            <Fig label={t('platform.pilot.cm.k.comments')} value={n(d.kpi.comments)} sub={parts(delta(t, d.kpi.comments, d.prev.comments))} />
            <Fig label={t('platform.pilot.cm.k.answered')} value={d.kpi.comments ? pct(d.kpi.answered / d.kpi.comments, 1) : '—'} sub={t('platform.pilot.cm.k.answeredN', { n: n(d.kpi.answered) })} />
            <Fig label={t('platform.pilot.cm.k.privates')} value={n(d.kpi.privates)} sub={t('platform.pilot.cm.k.privatesSub')} />
            <Fig label={t('platform.pilot.cm.k.leads')} value={n(d.kpi.leads)} sub={t('platform.pilot.cm.k.leadsSub')} help={t('platform.pilot.cm.k.leadsHelp')} />
            <Fig label={t('platform.pilot.cm.k.hidden')} value={n(d.kpi.hidden)} sub={t('platform.pilot.cm.k.hiddenSub')} />
            <Fig label={t('platform.pilot.cm.k.handed')} value={n(d.kpi.handed)} sub={t('platform.pilot.cm.k.team', { n: n(d.kpi.team) })} />
            <Fig label={t('platform.pilot.cm.k.errors')} value={n(d.kpi.errors)} sub={d.kpi.comments ? pct(d.kpi.errors / d.kpi.comments, 1) : undefined} />
            {manager && d.cost && <Fig label={t('platform.pilot.board.k.costAll')} value={usd(d.cost.usd)} sub={t('platform.pilot.board.k.calls', { count: d.cost.calls, n: n(d.cost.calls) })} />}
          </div>
          <CountBars days={d.series} bucket={d.bucket} label={t('platform.pilot.cm.k.comments')} title={t(d.bucket === 'week' ? 'platform.pilot.cm.perWeek' : 'platform.pilot.cm.perDay')} />
          {d.rows.length > 0 && (
            <div className="pb-break">
              <h3 className="pb-h">{t('platform.pilot.board.by.shop')}</h3>
              <div className="tbl-wrap">
                <table className="tbl pp-tbl pb-tbl">
                  <thead>
                    <tr>
                      <th>{t('platform.pilot.board.col.shop')}</th>
                      {(['comments', 'answered', 'privates', 'leads', 'hidden', 'handed', 'errors'] as const).map((k) => (
                        <th key={k} className="num">
                          {t(`platform.pilot.cm.k.${k}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => (
                      <tr key={r.key}>
                        <td className="wide" data-l={t('platform.pilot.board.col.shop')}>
                          <button type="button" className="pb-go" onClick={() => onShop(Number(r.key))}>
                            {r.label}
                          </button>
                        </td>
                        {(['comments', 'answered', 'privates', 'leads', 'hidden', 'handed', 'errors'] as const).map((k) => (
                          <td key={k} className="num ltr" data-l={t(`platform.pilot.cm.k.${k}`)}>
                            {r[k] ? n(r[k]) : <span className="muted">0</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** one count a day (a week for 90 days): thin bars, one colour, a tooltip */
function CountBars({ days, bucket, label, title }: { days: { day: string; comments: number }[]; bucket: 'day' | 'week'; label: string; title: string }) {
  const { t, i18n } = useTranslation();
  const loc = useLoc();
  const [box, size] = useBox();
  const [hov, setHov] = useState<number | null>(null);
  const W = Math.max(300, size.w || 720);
  const H = 200;
  const T = 10;
  const B = 26;
  const L = 44;
  const R = 10;
  const iw = W - L - R;
  const ih = H - T - B;
  const slot = iw / days.length;
  const x = (i: number) => L + slot * (i + 0.5);
  const max = Math.max(0, ...days.map((d) => d.comments));
  if (!max) return null;
  const ticks = ticksFor(max);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => T + ih - (v / top) * ih;
  const bw = Math.max(2, Math.min(18, slot * 0.62));
  const h = hov === null ? null : days[hov];
  return (
    <div className="pp-chart pb-chart" ref={box} onMouseLeave={() => setHov(null)}>
      <h3 className="pb-h">{title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <Axis ticks={ticks} y={y} L={L} R={R} W={W} />
        {days.map((d, i) =>
          d.comments ? <path key={d.day} className={`pb-bar-c ${hov === i ? 'on' : ''}`} d={bar(x(i) - bw / 2, y(d.comments), bw, y(0) - y(d.comments))} /> : null,
        )}
        <DateLabels days={days} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
        {days.map((d, i) => (
          <rect key={d.day} x={L + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
        ))}
      </svg>
      {h && hov !== null && (
        <div className="pp-tip" dir={i18n.dir()} style={{ left: `${Math.min(80, Math.max(20, (x(hov) / W) * 100))}%` }}>
          <b>{bucket === 'week' ? t('platform.pilot.board.week', { day: shortDayIn(loc, h.day) }) : shortDayIn(loc, h.day)}</b>
          <span>
            {label} <b className="ltr">{n(h.comments)}</b>
          </span>
        </div>
      )}
    </div>
  );
}
/** a bar with its top corners rounded (4px), standing on the baseline */
function bar(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------------------------------------------------------------- AI Spy
export function SpyBoard({ days, onDays, shopId, onShop, manager }: { days: BoardDays; onDays: (d: BoardDays) => void; shopId: number | null; onShop: (id: number | null) => void; manager: boolean }) {
  const { t } = useTranslation();
  const q = usePRpc('p.spy.board', { days, ...(shopId ? { shopId } : {}) }, { refetchInterval: 5 * 60_000 });
  const d = q.data;
  const cols = ['watched', 'ads', 'active', 'newAds', 'analysed', 'briefs', 'followed', 'alerts'] as const;
  return (
    <Card title={t('platform.pilot.spy.title')} help={t('platform.pilot.spy.help')} className="pb-card">
      <BoardBar days={days} onDays={onDays} shops={d?.shops ?? []} shopId={shopId} onShop={onShop} busy={q.isFetching && !!d} />
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {!!d.skipped.length && <p className="warnbox small">{t('platform.pilot.board.skipped', { names: d.skipped.join(', ') })}</p>}
          <p className={`pb-find ${d.kpi.watched ? '' : 'muted'}`}>
            {d.kpi.watched ? t('platform.pilot.spy.find', { days: d.days, watched: n(d.kpi.watched), shops: n(d.rows.length), ads: n(d.kpi.ads), fresh: n(d.kpi.newAds) }) : t('platform.pilot.spy.none')}
          </p>
          <div className="pb-figs">
            <Fig label={t('platform.pilot.spy.k.watched')} value={n(d.kpi.watched)} sub={t('platform.pilot.spy.k.watchedSub')} />
            <Fig label={t('platform.pilot.spy.k.ads')} value={n(d.kpi.ads)} sub={t('platform.pilot.spy.k.activeN', { n: n(d.kpi.active) })} />
            <Fig label={t('platform.pilot.spy.k.newAds')} value={n(d.kpi.newAds)} sub={t('platform.pilot.spy.k.newAdsSub', { days: d.days })} />
            <Fig label={t('platform.pilot.spy.k.analysed')} value={n(d.kpi.analysed)} sub={d.kpi.ads ? pct(d.kpi.analysed / d.kpi.ads) : undefined} />
            <Fig label={t('platform.pilot.spy.k.briefs')} value={n(d.kpi.briefs)} sub={t('platform.pilot.spy.k.briefsSub')} />
            <Fig label={t('platform.pilot.spy.k.followed')} value={n(d.kpi.followed)} sub={t('platform.pilot.spy.k.alertsN', { count: d.kpi.alerts, n: n(d.kpi.alerts) })} />
            {manager && d.cost && <Fig label={t('platform.pilot.board.k.costAll')} value={usd(d.cost.usd)} sub={t('platform.pilot.board.k.calls', { count: d.cost.calls, n: n(d.cost.calls) })} />}
          </div>
          {d.rows.length > 0 && (
            <div className="pb-break">
              <h3 className="pb-h">{t('platform.pilot.board.by.shop')}</h3>
              <div className="tbl-wrap">
                <table className="tbl pp-tbl pb-tbl">
                  <thead>
                    <tr>
                      <th>{t('platform.pilot.board.col.shop')}</th>
                      {cols.map((k) => (
                        <th key={k} className="num">
                          {t(`platform.pilot.spy.k.${k}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => (
                      <tr key={r.key}>
                        <td className="wide" data-l={t('platform.pilot.board.col.shop')}>
                          <button type="button" className="pb-go" onClick={() => onShop(Number(r.key))}>
                            {r.label}
                          </button>
                        </td>
                        {cols.map((k) => (
                          <td key={k} className="num ltr" data-l={t(`platform.pilot.spy.k.${k}`)}>
                            {r[k] ? n(r[k]) : <span className="muted">0</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="small muted">{t('platform.pilot.spy.note')}</p>
        </>
      )}
    </Card>
  );
}
