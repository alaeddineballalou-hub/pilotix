// Pilot AI › Dellal AI, more: how fast Dellal answers (and whether the slow answers sell less), the weekday × hour of
// the chats that buy, each ad that started chats (with what it cost when the shop connected its ads), and whether Dellal
// gets better from one lesson book to the next. Same filters as the dashboard (period, shop, product), except the books:
// the last 180 days, every shop or one.
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, DUR_UNITS, n, pct } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { useBox, useLoc } from '../../ui/chart';
import { Card, ErrorBox, Loading, Tabs } from '../../ui/kit';
import { usePilotRpc } from './pilotDemo';

type More = POut<'p.dellal.more'>;
type Books = POut<'p.dellal.books'>;

/** a rate given in % (24.3) as « 24,3 % » */
const rate = (v: number | null | undefined) => (v === null || v === undefined ? '—' : pct(v / 100, 1));
const usd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x.toFixed(2)} $`);
/** a figure inside a sentence: kept in one piece, left to right, in an Arabic sentence too */
const keep = (s: string) => `⁦${s.replace(/ /g, ' ')}⁩`;

/** seconds in words: « 12 s », « 3 min 20 s », « 1 h 05 » */
export function useSecs() {
  const { i18n } = useTranslation();
  const [mn, hr] = DUR_UNITS[i18n.language] ?? DUR_UNITS.fr;
  const sec = i18n.language === 'ar' ? 'ث' : 's';
  return (s: number | null | undefined) => {
    if (s === null || s === undefined) return '—';
    const v = Math.max(0, Math.round(s));
    if (v < 60) return `${v} ${sec}`;
    if (v < 600) return v % 60 ? `${Math.floor(v / 60)} ${mn} ${v % 60} ${sec}` : `${v / 60} ${mn}`;
    if (v < 3600) return `${Math.round(v / 60)} ${mn}`;
    const m = Math.round((v % 3600) / 60);
    return `${Math.floor(v / 3600)} ${hr} ${String(m).padStart(2, '0')}`;
  };
}

// ---------------------------------------------------------------- how fast
export function SpeedCard({ d }: { d: More }) {
  const { t } = useTranslation();
  const secs = useSecs();
  const sp = d.speed;
  const total = sp.answered + sp.unanswered;
  const steps = [...sp.steps.map((s) => ({ key: s.max === null ? 'later' : String(s.max), ...s })), { key: 'none', max: null, ...sp.none }];
  const max = Math.max(1, ...steps.map((s) => s.chats));
  // the finding: the fastest answers against the slow ones (enough chats on both sides)
  const fast = sp.steps[0];
  const slow = [...sp.steps.slice(2)].reduce((a, s) => ({ chats: a.chats + s.chats, ordered: a.ordered + s.ordered }), { chats: 0, ordered: 0 });
  const both = fast.chats >= 10 && slow.chats >= 10;
  return (
    <Card title={t('platform.pilot.more.speed.title')} help={t('platform.pilot.more.speed.help')} className="pb-speed">
      {!total ? (
        <p className="muted">{t('platform.pilot.more.none', { days: d.days })}</p>
      ) : (
        <>
          <div className="pb-lead">
            <b className="ltr">{secs(sp.median)}</b>
            <span>{t('platform.pilot.more.speed.median')}</span>
          </div>
          <p className="small muted">{t('platform.pilot.more.speed.medianSub', { s: keep(secs(sp.median)) })}</p>
          <dl className="pb-facts">
            <div>
              <dt>{t('platform.pilot.more.speed.under1')}</dt>
              <dd className="ltr">{rate(sp.underMinute)}</dd>
            </div>
            <div>
              <dt>{t('platform.pilot.more.speed.p90')}</dt>
              <dd className="ltr">{secs(sp.p90)}</dd>
            </div>
            <div>
              <dt>
                {t('platform.pilot.more.speed.team')}
                <small>{t('platform.pilot.more.speed.teamSub', { count: sp.team.handed, n: n(sp.team.handed), answered: n(sp.team.chats) })}</small>
              </dt>
              <dd className="ltr">{secs(sp.team.median)}</dd>
            </div>
          </dl>
          <ul className="pb-steps" aria-label={t('platform.pilot.more.speed.byStep')}>
            <li className="pb-steps-head" aria-hidden="true">
              <span />
              <span>{t('platform.pilot.more.speed.head.chats')}</span>
              <span>{t('platform.pilot.more.speed.head.conv')}</span>
            </li>
            {steps.map((s) => (
              <li key={s.key}>
                <span className="pb-steps-l">{t(`platform.pilot.more.step.${s.key}`)}</span>
                <span className="pb-steps-n ltr">{n(s.chats)}</span>
                <span className="pb-steps-c ltr" title={t('platform.pilot.board.k.conversion')}>
                  {s.chats ? rate(s.conversion) : '—'}
                </span>
                <i className="pb-steps-bar" aria-hidden="true">
                  <i style={{ width: `${(s.chats / max) * 100}%` }} />
                </i>
              </li>
            ))}
          </ul>
          <p className="small muted">
            {both
              ? t('platform.pilot.more.speed.find', { fast: keep(rate((fast.ordered / fast.chats) * 100)), slow: keep(rate((slow.ordered / slow.chats) * 100)) })
              : t('platform.pilot.more.speed.cols')}
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- when chats buy
type Mode = 'ordered' | 'conversion' | 'chats';
/** Sunday first: Algeria's week (Friday and Saturday, the weekend, last) */
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const LEVELS = [14, 28, 44, 62, 80, 100];
/** a share of the strongest cell, as one of six steps of the same blue (light to dark) */
const level = (v: number, max: number) => (max > 0 && v > 0 ? LEVELS[Math.min(LEVELS.length - 1, Math.floor((v / max) * LEVELS.length - 1e-9))] : 0);
/** fewer chats than this in a cell: its conversion is not shown as a colour (too few to tell) */
const MIN_CHATS = 5;

export function HoursCard({ d }: { d: More }) {
  const { t } = useTranslation();
  const loc = useLoc();
  const [mode, setMode] = useState<Mode>('ordered');
  const [hov, setHov] = useState<string | null>(null);
  const day = (dow: number, long = false) => new Intl.DateTimeFormat(loc, { weekday: long ? 'long' : 'short', timeZone: 'UTC' }).format(Date.parse(`2026-10-${String(4 + dow).padStart(2, '0')}T12:00:00Z`));
  const cell = new Map(d.hours.map((h) => [`${h.dow}:${h.hour}`, h]));
  const val = (c: { chats: number; ordered: number } | undefined) => (!c ? 0 : mode === 'chats' ? c.chats : mode === 'ordered' ? c.ordered : c.chats >= MIN_CHATS ? (c.ordered / c.chats) * 100 : 0);
  const max = Math.max(0, ...d.hours.map((h) => val(h)));
  const total = d.hours.reduce((a, h) => ({ chats: a.chats + h.chats, ordered: a.ordered + h.ordered }), { chats: 0, ordered: 0 });
  // the findings: the hour of the day with the most orders (every day together), and the best moment (enough chats)
  const byHour = Array.from({ length: 24 }, (_, h) => d.hours.filter((x) => x.hour === h).reduce((a, x) => ({ chats: a.chats + x.chats, ordered: a.ordered + x.ordered }), { chats: 0, ordered: 0 }));
  const topHour = byHour.reduce((b, x, h) => (x.ordered > byHour[b].ordered ? h : b), 0);
  const best = [...d.hours].filter((x) => x.chats >= Math.max(MIN_CHATS * 2, total.chats / 200)).sort((a, b) => b.ordered / b.chats - a.ordered / a.chats || b.chats - a.chats)[0];
  const h = hov ? cell.get(hov) ?? { dow: Number(hov.split(':')[0]), hour: Number(hov.split(':')[1]), chats: 0, ordered: 0 } : null;
  const hh = (x: number) => `${String(x).padStart(2, '0')}:00`;
  return (
    <Card title={t('platform.pilot.more.hours.title')} help={t('platform.pilot.more.hours.help', { min: MIN_CHATS })} className="pb-hours">
      {!total.chats ? (
        <p className="muted">{t('platform.pilot.more.none', { days: d.days })}</p>
      ) : (
        <>
          <div className="pb-hours-top">
            <Tabs value={mode} onChange={(v) => setMode(v as Mode)} items={(['ordered', 'conversion', 'chats'] as const).map((k) => ({ value: k, label: t(`platform.pilot.more.hours.m.${k}`) }))} />
          </div>
          <p className="pb-find">
            {total.ordered
              ? t('platform.pilot.more.hours.find', { from: keep(hh(topHour)), to: keep(hh((topHour + 1) % 24)), share: keep(pct(byHour[topHour].ordered / total.ordered)) })
              : t('platform.pilot.more.hours.noOrder')}{' '}
            {best && best.ordered > 0 && t('platform.pilot.more.hours.best', { day: day(best.dow, true), hour: keep(hh(best.hour)), rate: keep(rate((best.ordered / best.chats) * 100)), chats: n(best.chats) })}
          </p>
          <div className="pb-heat-wrap">
            <div className="pb-heat" role="grid" aria-label={t('platform.pilot.more.hours.title')} onMouseLeave={() => setHov(null)}>
              <span className="pb-heat-corner" aria-hidden="true" />
              {Array.from({ length: 24 }, (_, x) => (
                <span key={`h${x}`} className="pb-heat-h ltr" aria-hidden="true">
                  {x % 3 === 0 ? x : ''}
                </span>
              ))}
              {DAYS.map((dow) => (
                <Fragment key={dow}>
                  <span className="pb-heat-d">{day(dow)}</span>
                  {Array.from({ length: 24 }, (_, x) => {
                    const k = `${dow}:${x}`;
                    const c = cell.get(k);
                    const thin = mode === 'conversion' && !!c && c.chats > 0 && c.chats < MIN_CHATS;
                    const lv = level(val(c), max);
                    return (
                      <button
                        key={k}
                        type="button"
                        className={`pb-heat-c${thin ? ' thin' : ''}${hov === k ? ' on' : ''}`}
                        style={lv ? ({ '--lv': `${lv}%` } as React.CSSProperties) : undefined}
                        data-lv={lv || undefined}
                        aria-label={`${day(dow, true)} ${hh(x)} : ${t('platform.pilot.more.hours.tip', { chats: n(c?.chats ?? 0), orders: n(c?.ordered ?? 0), rate: c?.chats ? rate((c.ordered / c.chats) * 100) : '—' })}`}
                        onMouseEnter={() => setHov(k)}
                        onFocus={() => setHov(k)}
                        onClick={() => setHov(k)}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
          <div className="pb-heat-foot">
            <span className="pb-heat-tip" aria-live="polite">
              {h ? (
                <>
                  <b>
                    {day(h.dow, true)} · <span className="ltr">{hh(h.hour)}</span>
                  </b>{' '}
                  {t('platform.pilot.more.hours.tip', { chats: n(h.chats), orders: n(h.ordered), rate: h.chats ? rate((h.ordered / h.chats) * 100) : '—' })}
                </>
              ) : (
                <span className="muted">{t('platform.pilot.more.hours.hover')}</span>
              )}
            </span>
            <span className="pb-heat-key" aria-hidden="true">
              {t('platform.pilot.more.hours.few')}
              {LEVELS.map((l) => (
                <i key={l} style={{ '--lv': `${l}%` } as React.CSSProperties} />
              ))}
              {t('platform.pilot.more.hours.many')}
            </span>
          </div>
          {mode === 'conversion' && <p className="small muted">{t('platform.pilot.more.hours.thin', { min: MIN_CHATS })}</p>}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- which ad
export function AdsCard({ d, manager }: { d: More; manager: boolean }) {
  const { t } = useTranslation();
  const label = (a: More['ads'][number]) =>
    a.kind === 'direct'
      ? t('platform.pilot.more.ads.direct')
      : a.kind === 'comment'
        ? t('platform.pilot.more.ads.comment', { label: a.label ?? '' })
        : a.kind === 'ad'
          ? a.label ?? t('platform.pilot.more.ads.adId', { id: a.adId ?? '' })
          : a.label ?? '—';
  // the best and the weakest ad on real sales (enough chats old enough to tell)
  const ranked = d.ads.filter((a) => a.kind === 'ad' && a.ripeChats >= 10 && a.realSales !== null).sort((a, b) => b.realSales! - a.realSales!);
  const best = ranked.length >= 2 ? ranked[0] : null;
  const worst = ranked.length >= 2 ? ranked[ranked.length - 1] : null;
  const spend = manager && d.ads.some((a) => a.spendUsd !== null);
  return (
    <Card title={t('platform.pilot.more.ads.title')} help={t('platform.pilot.more.ads.help', { days: 7 })} className="pb-ads">
      {!d.ads.length ? (
        <p className="muted">{t('platform.pilot.more.none', { days: d.days })}</p>
      ) : (
        <>
          {best && worst && best !== worst && (
            <p className="pb-find pb-find-two">
              <span>
                {t('platform.pilot.more.ads.best')} <b dir="auto">{label(best)}</b> <b className="ltr pb-good">{rate(best.realSales)}</b>
                {best.costPerSale !== null && spend && <> · {t('platform.pilot.more.ads.perSale', { usd: keep(usd(best.costPerSale)) })}</>}
              </span>{' '}
              <span>
                {t('platform.pilot.more.ads.worst')} <b dir="auto">{label(worst)}</b> <b className="ltr pb-bad">{rate(worst.realSales)}</b>
                {worst.costPerSale !== null && spend && <> · {t('platform.pilot.more.ads.perSale', { usd: keep(usd(worst.costPerSale)) })}</>}
              </span>
            </p>
          )}
          <div className="tbl-wrap">
            <table className="tbl pp-tbl pb-tbl">
              <thead>
                <tr>
                  <th>{t('platform.pilot.more.ads.col')}</th>
                  <th className="num">{t('platform.pilot.board.k.chats')}</th>
                  <th className="num">{t('platform.pilot.board.k.conversion')}</th>
                  <th className="num">{t('platform.pilot.board.k.realSales')}</th>
                  <th className="num">{t('platform.pilot.board.k.revenue')}</th>
                  {spend && <th className="num">{t('platform.pilot.more.ads.spend')}</th>}
                  {spend && <th className="num">{t('platform.pilot.more.ads.costPerSale')}</th>}
                </tr>
              </thead>
              <tbody>
                {d.ads.map((a) => (
                  <tr key={a.key} className={a.kind === 'direct' ? 'pb-row-quiet' : ''}>
                    <td className="wide" data-l={t('platform.pilot.more.ads.col')}>
                      <span className="pb-ad">
                        <b dir="auto">{label(a)}</b>
                        <small>
                          {t(`platform.pilot.more.ads.kind.${a.kind}`)}
                          {a.shop ? ` · ${a.shop}` : ''}
                        </small>
                      </span>
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.chats')}>
                      {n(a.chats)}
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.conversion')}>
                      <b>{rate(a.conversion)}</b>
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.realSales')} title={a.realSales === null ? t('platform.pilot.board.onRoad') : t('platform.pilot.more.ads.ofRipe', { sold: n(a.sold), of: n(a.ripeChats) })}>
                      {rate(a.realSales)}
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.revenue')}>
                      {a.revenue ? da(a.revenue) : '—'}
                    </td>
                    {spend && (
                      <td className="num ltr" data-l={t('platform.pilot.more.ads.spend')}>
                        {usd(a.spendUsd)}
                      </td>
                    )}
                    {spend && (
                      <td className="num ltr" data-l={t('platform.pilot.more.ads.costPerSale')}>
                        <b>{usd(a.costPerSale)}</b>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">{manager ? t('platform.pilot.more.ads.note') : t('platform.pilot.more.ads.noteSupport')}</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- is Dellal getting better
export function VersionsCard({ shopId }: { shopId: number | null }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.dellal.books', shopId ? { shopId } : {}, { refetchInterval: 10 * 60_000 });
  const d = q.data;
  const name = (v: Books['versions'][number]) => (v.version === 0 ? t('platform.pilot.more.books.base') : `v${v.version}`);
  const champ = d?.versions.find((v) => v.status === 'champion') ?? null;
  const base = d?.versions.find((v) => v.version === 0) ?? null;
  const first = base ?? d?.versions[0] ?? null;
  return (
    <Card title={t('platform.pilot.more.books.title')} help={t('platform.pilot.more.books.help', { days: d?.saleDays ?? 7 })} className="pb-books">
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d.versions.length ? (
        <p className="muted">{t('platform.pilot.more.books.none')}</p>
      ) : (
        <>
          <p className="pb-find">
            {champ && first && champ !== first && champ.realSales !== null && first.realSales !== null
              ? t('platform.pilot.more.books.find', { from: name(first), a: keep(rate(first.realSales)), to: name(champ), b: keep(rate(champ.realSales)) })
              : t('platform.pilot.more.books.findOne')}
          </p>
          <VersionsChart versions={d.versions} name={name} />
          <div className="tbl-wrap">
            <table className="tbl pp-tbl pb-tbl">
              <thead>
                <tr>
                  <th>{t('platform.pilot.more.books.col')}</th>
                  <th>{t('platform.pilot.more.books.when')}</th>
                  <th className="num">{t('platform.pilot.board.k.chats')}</th>
                  <th className="num">{t('platform.pilot.board.k.conversion')}</th>
                  <th className="num">{t('platform.pilot.board.k.realSales')}</th>
                </tr>
              </thead>
              <tbody>
                {d.versions.map((v) => (
                  <tr key={v.key}>
                    <td data-l={t('platform.pilot.more.books.col')}>
                      <b>{name(v)}</b> <small className="muted">{t(`platform.pilot.bookStatus.${v.status}`, { defaultValue: v.status === 'base' ? '' : v.status })}</small>
                    </td>
                    <td data-l={t('platform.pilot.more.books.when')} className="ltr">
                      <DayRange from={v.from} to={v.to} />
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.chats')}>
                      {n(v.chats)}
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.conversion')}>
                      {rate(v.conversion)}
                    </td>
                    <td className="num ltr" data-l={t('platform.pilot.board.k.realSales')} title={t('platform.pilot.more.ads.ofRipe', { sold: n(v.sold), of: n(v.ripeChats) })}>
                      <b>{rate(v.realSales)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">{d.test ? t('platform.pilot.more.books.fair', { share: Math.round(d.test.share * 100) }) : t('platform.pilot.more.books.fairNone')}</p>
        </>
      )}
    </Card>
  );
}

function DayRange({ from, to }: { from: string | null; to: string | null }) {
  const loc = useLoc();
  const f = (x: string) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'Africa/Algiers', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(x));
  if (!from || !to) return <>—</>;
  return <>{f(from) === f(to) ? f(from) : `${f(from)} – ${f(to)}`}</>;
}

/** conversion and real sales of each version, one point each, joined from the first book to the last (the test dashed) */
function VersionsChart({ versions, name }: { versions: Books['versions']; name: (v: Books['versions'][number]) => string }) {
  const { t, i18n } = useTranslation();
  const [box, size] = useBox();
  const [hov, setHov] = useState<number | null>(null);
  const W = Math.max(300, size.w || 640);
  const H = 220;
  const T = 18;
  const B = 30;
  const L = 44;
  const R = 70;
  const iw = W - L - R;
  const ih = H - T - B;
  const slot = iw / versions.length;
  const x = (i: number) => L + slot * (i + 0.5);
  const vals = versions.flatMap((v) => [v.conversion, v.realSales]).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  const step = Math.max(...vals) - Math.min(...vals) > 30 ? 10 : 5;
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 2) / step) * step);
  const hi = Math.min(100, Math.max(lo + 2 * step, Math.ceil((Math.max(...vals) + 2) / step) * step));
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
  /** the books in service one after the other, joined (the test apart: dashed) */
  const line = (k: 'conversion' | 'realSales') => {
    let s = '';
    let prev = -2;
    versions.forEach((v, i) => {
      const val = v[k];
      if (val === null || v.status === 'testing') return;
      s += `${i === prev + 1 ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`;
      prev = i;
    });
    return s;
  };
  // the test, if any, is joined to the book before it with a dashed line (not proven yet)
  const testAt = versions.findIndex((v) => v.status === 'testing');
  const dash = (k: 'conversion' | 'realSales') => {
    if (testAt <= 0) return '';
    const a = versions[testAt - 1][k];
    const b = versions[testAt][k];
    return a === null || b === null ? '' : `M${x(testAt - 1).toFixed(1)},${y(a).toFixed(1)}L${x(testAt).toFixed(1)},${y(b).toFixed(1)}`;
  };
  const hv = hov === null ? null : versions[hov];
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
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('platform.pilot.more.books.title')}>
        {ticks.map((v, i) => (
          <g key={v}>
            <line className={i === 0 ? 'base' : 'g'} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="ax" x={L - 8} y={y(v) + 4} textAnchor="end">
              {v} %
            </text>
          </g>
        ))}
        {testAt >= 0 && <rect className="pp-q-open" x={L + slot * testAt} y={T} width={slot} height={ih} />}
        {(['realSales', 'conversion'] as const).map((k) => (
          <g key={k}>
            <path className={k === 'conversion' ? 'pb-l-conv' : 'pb-l-real'} d={versions.length > 1 ? line(k) : ''} />
            <path className={`${k === 'conversion' ? 'pb-l-conv' : 'pb-l-real'} pb-l-dash`} d={dash(k)} />
            {versions.map((v, i) =>
              v[k] === null ? null : <circle key={i} className={`${k === 'conversion' ? 'pb-d-conv' : 'pb-d-real'}${hov === i ? ' on' : ''}`} cx={x(i)} cy={y(v[k]!)} r={hov === i ? 5 : 4} />,
            )}
          </g>
        ))}
        {versions.map((v, i) => (
          <text key={`l${i}`} className="ax pb-x" x={x(i)} y={H - 8} textAnchor="middle">
            {name(v)}
            {v.status === 'testing' ? ` · ${t('platform.pilot.more.books.inTest')}` : ''}
          </text>
        ))}
        {versions.length > 0 &&
          (['conversion', 'realSales'] as const).map((k) => {
            const i = versions.length - 1;
            const v = versions[i][k];
            return v === null ? null : (
              <text key={`e${k}`} className="pb-end" x={x(i) + 9} y={y(v) + 4}>
                {rate(v)}
              </text>
            );
          })}
        {versions.map((v, i) => (
          <rect key={`h${i}`} x={L + slot * i} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
        ))}
      </svg>
      {hv && hov !== null && (
        <div className="pp-tip" dir={i18n.dir()} style={{ left: `${Math.min(80, Math.max(20, (x(hov) / W) * 100))}%` }}>
          <b>
            {name(hv)}
            {hv.status === 'testing' ? ` · ${t('platform.pilot.more.books.inTest')}` : ''}
          </b>
          <span>
            <i className="pb-k-conv" /> {t('platform.pilot.board.k.conversion')} <b className="ltr">{rate(hv.conversion)}</b>
          </span>
          <span>
            <i className="pb-k-real" /> {t('platform.pilot.board.k.realSales')} <b className="ltr">{rate(hv.realSales)}</b>
          </span>
          <span className="pp-tip-sub">{t('platform.pilot.more.books.tip', { chats: n(hv.chats), sold: n(hv.sold), ripe: n(hv.ripeChats) })}</span>
        </div>
      )}
    </div>
  );
}
