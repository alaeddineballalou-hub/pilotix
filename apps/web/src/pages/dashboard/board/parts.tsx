// The pieces of the team boards (Dashboard and Accueil): period chips, the target meter, the trend, a day chart, the
// reasons, what is late now, a member's initials.
import type { Tone } from '@pilotix/shared';
import { ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dayRange, n, pct } from '../../../lib/format';
import { Icon } from '../../../ui/kit';
import { Sheet } from '../../../ui/Sheet';
import { AnyPeriod, inputsOf, rangeOf } from '../util';
import { AreaDef, AreaKey, fmt, MetricDef, NowDef, scaleOf, trendOf } from './defs';

export const BOARD_PERIODS: AnyPeriod[] = ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth'];

/** The period as chips (the chosen one in navy), the last one opening a sheet of dates. */
export function PeriodChips({ value, onChange, custom, onCustom, keys = BOARD_PERIODS }: { value: AnyPeriod; onChange: (p: AnyPeriod) => void; custom: { from: string; to: string }; onCustom: (c: { from: string; to: string }) => void; keys?: AnyPeriod[] }) {
  const { t } = useTranslation();
  const [pick, setPick] = useState(false);
  const r = rangeOf(value, custom);
  return (
    <>
      <div className="tb-per" role="radiogroup" aria-label={t('dashboard.period')}>
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={value === k}
            className={value === k ? 'on' : ''}
            onClick={(e) => {
              onChange(k);
              e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}
          >
            {t(`dashboard.periods.${k}`)}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={value === 'custom'} className={value === 'custom' ? 'on' : ''} onClick={() => setPick(true)}>
          <Icon name="calendar" />
          {value === 'custom' ? dayRange(r.from, r.to) : t('dashboard.tb.dates')}
        </button>
      </div>
      {pick && (
        <DatesSheet
          init={value === 'custom' ? custom : inputsOf(r)}
          onClose={() => setPick(false)}
          onPick={(c) => {
            onCustom(c);
            onChange('custom');
            setPick(false);
          }}
        />
      )}
    </>
  );
}

function DatesSheet({ init, onPick, onClose }: { init: { from: string; to: string }; onPick: (c: { from: string; to: string }) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const ok = !!from && !!to && from <= to;
  return (
    <Sheet
      title={t('dashboard.tb.datesTitle')}
      sub={ok ? dayRange(rangeOf('custom', { from, to }).from, rangeOf('custom', { from, to }).to) : undefined}
      onClose={onClose}
      className="tb-side"
      foot={
        <button type="button" className="pxk-go" disabled={!ok} onClick={() => onPick({ from, to })}>
          <Icon name="check" /> {t('dashboard.tb.datesApply')}
        </button>
      }
    >
      <div className="pxk-g2">
        <label>
          {t('dashboard.from')}
          <input className="pxk-in" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t('dashboard.to')}
          <input className="pxk-in" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
    </Sheet>
  );
}

const at = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The signature of the boards: where a number stands — its fill, the target (a navy tick), the team (a ring). */
export function Meter({ def, v, team, tone, big }: { def: MetricDef; v: number | null | undefined; team?: number | null; tone?: Tone; big?: boolean }) {
  if (v === null || v === undefined || (!def.target && def.fmt !== 'pct' && team === undefined)) return null;
  const s = scaleOf(def, v, team, def.target?.[0]);
  return (
    <span className={`tb-meter${big ? ' big' : ''} is-${tone ?? 'none'}`} aria-hidden="true">
      <i style={{ width: at(s(v)) }} />
      {def.target && <b style={{ insetInlineStart: at(s(def.target[0])) }} />}
      {team !== null && team !== undefined && <u style={{ insetInlineStart: at(s(team)) }} />}
    </span>
  );
}

/** ▲ 4 pts / ▼ 12 %: green when it went the right way. */
export function TrendChip({ def, v, p, label }: { def: MetricDef | undefined; v: number | null | undefined; p: number | null | undefined; label?: string }) {
  const tr = trendOf(def, v, p);
  if (!tr) return null;
  return (
    <span className={`tb-tr ${tr.good === null ? '' : tr.good ? 'good' : 'bad'}`} title={label}>
      {tr.txt === '=' ? '=' : `${tr.up ? '▲' : '▼'} ${tr.txt}`}
    </span>
  );
}

/** Initials in a circle, with the presence dot of a confirmation agent. */
export function Avatar({ name, presence, none }: { name: string; presence?: string; none?: boolean }) {
  // the first letters of the first two words (« Sofiane (Vendeur) » → S V)
  const ini = name
    .split(/\s+/)
    .map((w) => w.match(/\p{L}/u)?.[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className={`tb-av${none ? ' none' : ''}`} aria-hidden="true">
      {none ? <Icon name="help" /> : ini || '?'}
      {presence && <i className={`tb-dot ${presence}`} />}
    </span>
  );
}

/** What is late right now, each count a way to the page where it is done. */
export function NowList({ area, def, items, isAdmin }: { area: AreaKey; def: AreaDef; items: { key: string; n: number }[]; isAdmin: boolean }) {
  const { t } = useTranslation();
  const shown = items.filter((x) => x.n > 0);
  return (
    <section className="tb-card tb-now" aria-labelledby={`tb-now-${area}`}>
      <h3 id={`tb-now-${area}`}>
        <Icon name="timer" /> {t('dashboard.tb.now')}
      </h3>
      {!shown.length ? (
        <p className="tb-calm">
          <Icon name="checkcircle" /> {t('dashboard.tb.nowNone')}
        </p>
      ) : (
        <ul>
          {shown.map((x) => {
            const d: NowDef = def.now[x.key] ?? { tone: 'info' };
            const href = d.href && (!d.adminHref || isAdmin) ? d.href : undefined;
            const body = (
              <>
                <b className={`ltr is-${d.tone}`}>{d.money ? fmt({ key: x.key, fmt: 'da', better: 'down' }, x.n) : n(x.n)}</b>
                <span>{t(`dashboard.tb.nowK.${area}.${x.key}`)}</span>
                {href && <Icon name="chevr" />}
              </>
            );
            return <li key={x.key}>{href ? <a href={href}>{body}</a> : <div>{body}</div>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

/** Day by day: the volume in bars, the rate as a line (and the team's, dashed, for one member). */
export function DayChart({ days, team, barLabel, lineLabel, teamLabel }: { days: { d: string; n: number; ok: number; of: number }[]; team?: { d: string; ok: number; of: number }[]; barLabel: string; lineLabel: string; teamLabel?: string }) {
  const { i18n } = useTranslation();
  const [hov, setHov] = useState<number | null>(null);
  // drawn at the width it is shown, so its words keep their size (a drawer, a phone, a full row)
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length >= 2]); // eslint-disable-line react-hooks/exhaustive-deps
  if (days.length < 2) return null;
  const W = Math.max(280, w || 640);
  const Ht = W < 480 ? 190 : 210;
  const L = 30;
  const R = 34;
  const T = 12;
  const B = 22;
  const iw = W - L - R;
  const ih = Ht - T - B;
  const max = Math.max(4, ...days.map((d) => d.n));
  const top = Math.ceil(max / 4) * 4;
  const bw = iw / days.length;
  const barW = Math.min(bw * 0.6, 40);
  const x = (i: number) => L + bw * i + bw / 2;
  const y = (v: number) => T + ih - (v / top) * ih;
  const yr = (r: number) => T + ih - r * ih;
  const line = (list: { ok: number; of: number }[]) =>
    list.reduce((s, d, i) => (d.of ? `${s}${s ? 'L' : 'M'}${x(i).toFixed(1)},${yr(d.ok / d.of).toFixed(1)}` : s), '');
  const every = Math.max(1, Math.ceil(days.length / Math.max(3, Math.floor(iw / 68))));
  const loc = i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR';
  const lab = (d: string) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'UTC', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(d));
  const h = hov === null ? null : days[hov];
  return (
    <div className="tb-chart" ref={box} onMouseLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${W} ${Ht}`} role="img" aria-label={`${barLabel} · ${lineLabel}`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="g" x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} />
            <text className="ax" x={L - 6} y={y(top * f) + 3} textAnchor="end">
              {Math.round(top * f)}
            </text>
            <text className="ax" x={W - R + 6} y={yr(f) + 3}>
              {Math.round(f * 100)}%
            </text>
          </g>
        ))}
        {days.map((d, i) => (
          <g key={d.d}>
            <rect className={`b${hov === i ? ' on' : ''}`} x={x(i) - barW / 2} width={barW} y={y(d.n)} height={Math.max(d.n ? 2 : 0, T + ih - y(d.n))} rx={3} />
            {i % every === 0 && (
              <text className="ax" x={x(i)} y={Ht - 6} textAnchor="middle">
                {lab(d.d)}
              </text>
            )}
            <rect x={x(i) - bw / 2} y={0} width={bw} height={Ht} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />
          </g>
        ))}
        {team && <path className="lt" d={line(team)} />}
        <path className="ln" d={line(days)} />
        {days.map((d, i) => d.of > 0 && <circle key={d.d} className="dt" cx={x(i)} cy={yr(d.ok / d.of)} r={hov === i ? 4.5 : 3} />)}
      </svg>
      {h && hov !== null && (
        <div className="tb-tip" style={{ left: `${Math.min(80, Math.max(20, (x(hov) / W) * 100))}%` }}>
          <b>{lab(h.d)}</b>
          <span>
            <i className="lb" /> {barLabel} <b className="ltr">{n(h.n)}</b>
          </span>
          <span>
            <i className="ll" /> {lineLabel} <b className="ltr">{pct(h.of ? h.ok / h.of : null)}</b>
          </span>
        </div>
      )}
      <div className="tb-lg">
        <span>
          <i className="lb" />
          {barLabel}
        </span>
        <span>
          <i className="ll" />
          {lineLabel}
        </span>
        {team && teamLabel && (
          <span>
            <i className="lt" />
            {teamLabel}
          </span>
        )}
      </div>
    </div>
  );
}

/** The reasons given, as bars (the others in one line, those given none apart). */
export function ReasonBars({ list, total }: { list: { reason: string; n: number }[]; total?: number }) {
  const { t } = useTranslation();
  const all = total ?? list.reduce((s, r) => s + r.n, 0);
  const max = Math.max(1, ...list.map((r) => r.n));
  return (
    <ul className="tb-why">
      {list.map((r) => (
        <li key={r.reason || '_'} className={r.reason && r.reason !== '…' ? '' : 'mute'}>
          <span className="tb-why-l">
            <span dir="auto">{r.reason === '…' ? t('dashboard.tb.others') : r.reason || t('dashboard.tb.noReason')}</span>
            <b className="ltr">{n(r.n)}</b>
            <small className="ltr">{pct(all ? r.n / all : null)}</small>
          </span>
          <span className="tb-why-t" aria-hidden="true">
            <i style={{ width: `${Math.max(3, (r.n / max) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A card of the board: its title, maybe a note beside it. */
export function BCard({ title, aside, children, className = '', id }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`tb-card ${className}`} aria-labelledby={id}>
      <header className="tb-ch">
        <h3 id={id}>{title}</h3>
        {aside && <span>{aside}</span>}
      </header>
      {children}
    </section>
  );
}
