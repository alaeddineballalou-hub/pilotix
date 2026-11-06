// Marketing › Catalogue › Résultats: what the catalog ads (Meta and TikTok) brought these last days: visits of the
// products' pages, orders, delivered orders and the money they brought, product by product (the best first). Beside it,
// « Cachés : stock bas »: the colours / sizes out of the ads because little (or nothing) is left, and the shop's level.
// A product opens its page: its numbers, its orders day by day, its colours / sizes and its own level. Everything is
// counted in core (metacatalog.results / product / guard / productGuard).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { pageIsOn } from '../../lib/features';
import { da, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Axis, DateLabels, shortDayIn, ticksFor, useBox, useLoc } from '../../ui/chart';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';

type Days = 7 | 30 | 0;
type Res = Out<'metacatalog.results'>;
type Row = Res['products'][number];
type Hidden = Res['hidden'][number];

const rate = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);

export function Results() {
  const { t } = useTranslation();
  const loc = useLoc();
  const [days, setDays] = useState<Days>(7);
  const [open, setOpen] = useState<number | null>(null);
  const q = useRpc('metacatalog.results', { days }, { refetchInterval: 60_000 });
  const r = q.data;
  if (q.error && !r) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!r) return <Loading />;
  const tt = r.totals;
  const pctDelivered = rate(tt.delivered, tt.orders);
  return (
    <div className="ct-res">
      <div className="ct-res-head">
        <h3>{t('metacatalog.res.title')}</h3>
        {r.since && <span className="lf-muted ct-small">{t('metacatalog.res.since', { day: shortDayIn(loc, r.since) })}</span>}
        <Period value={days} onChange={setDays} />
      </div>
      <div className="ct-tiles">
        <Tile icon="eye" label={t('metacatalog.res.visits')} value={n(tt.visits)} sub={t('metacatalog.res.visitsSub')} />
        <Tile
          icon="cart"
          label={t('metacatalog.res.orders')}
          value={n(tt.orders)}
          sub={t('metacatalog.res.split', {
            meta: n(tt.meta.orders),
            tiktok: n(tt.tiktok.orders),
          })}
        />
        <Tile icon="truck" label={t('metacatalog.res.delivered')} value={n(tt.delivered)} sub={pctDelivered === null ? t('metacatalog.res.noOrder') : t('metacatalog.res.deliveredSub', { pct: pctDelivered })} />
        <Tile icon="coins" label={t('metacatalog.res.cash')} value={da(tt.cash)} sub={t('metacatalog.res.cashSub')} ok />
      </div>
      <div className="ct-res-main">
        <section className="ct-rcard" aria-labelledby="ct-rt-title">
          <h4 id="ct-rt-title">{t(days === 7 ? 'metacatalog.res.byProduct7' : days === 30 ? 'metacatalog.res.byProduct30' : 'metacatalog.res.byProductAll')}</h4>
          {!r.products.length ? (
            <p className="lf-muted ct-small ct-res-none">{t('metacatalog.res.noProducts')}</p>
          ) : (
            <>
              {!tt.visits && !tt.orders && <p className="lf-note ct-res-none">{t('metacatalog.res.waiting')}</p>}
              <div className="ct-rt-wrap">
                <table className="ct-rt">
                  <thead>
                    <tr>
                      <th scope="col">{t('metacatalog.res.product')}</th>
                      <th scope="col" className="num">
                        {t('metacatalog.res.visits')}
                      </th>
                      <th scope="col" className="num">
                        {t('metacatalog.res.orders')}
                      </th>
                      <th scope="col" className="num">
                        {t('metacatalog.res.delivered')}
                      </th>
                      <th scope="col" className="num" aria-sort="descending">
                        {t('metacatalog.res.cash')}
                      </th>
                      <th scope="col" className="num">
                        {t('metacatalog.res.left')}
                      </th>
                      <th scope="col">{t('metacatalog.res.inAds')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.products.map((p) => (
                      <ResultRow key={p.id} p={p} onOpen={() => setOpen(p.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
        <HiddenBox r={r} onOpen={setOpen} />
      </div>
      {open !== null && <ProductSheet id={open} days={days} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Period({ value, onChange }: { value: Days; onChange: (d: Days) => void }) {
  const { t } = useTranslation();
  const items: [Days, string][] = [
    [7, t('metacatalog.res.d7')],
    [30, t('metacatalog.res.d30')],
    [0, t('metacatalog.res.all')],
  ];
  return (
    <div className="lf-chips ct-period" role="group" aria-label={t('metacatalog.res.period')}>
      {items.map(([d, label]) => (
        <button key={d} type="button" className="lf-chip" aria-pressed={value === d} onClick={() => onChange(d)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Tile({ icon, label, value, sub, ok }: { icon: string; label: string; value: string; sub: string; ok?: boolean }) {
  return (
    <div className="ct-tile">
      <span className="ct-tile-l">
        <Icon name={icon} />
        {label}
      </span>
      <b className={`ct-tile-v ltr ${ok ? 'ok' : ''}`}>{value}</b>
      <span className="ct-tile-s">{sub}</span>
    </div>
  );
}

/** Where a product is in the ads, in a word. */
function AdState({ p }: { p: Pick<Row, 'state' | 'hidden' | 'variants' | 'problem'> }) {
  const { t } = useTranslation();
  if (p.state === 'ads')
    return (
      <span className="lf-tag ok">
        <Icon name="check" />
        {t('metacatalog.res.st.ads')}
      </span>
    );
  if (p.state === 'some')
    return (
      <span className="lf-tag info">
        <Icon name="eyeoff" />
        {t('metacatalog.res.st.some', { count: p.hidden, total: p.variants })}
      </span>
    );
  if (p.state === 'low' || p.state === 'out')
    return (
      <span className="lf-tag mute">
        <Icon name="eyeoff" />
        {t(`metacatalog.res.st.${p.state}`)}
      </span>
    );
  if (p.state === 'fix')
    return (
      <span className="lf-tag warn">
        <Icon name="alert" />
        {t(p.problem === 'photo' ? 'metacatalog.pb.photo' : 'metacatalog.pb.nopage')}
      </span>
    );
  return <span className="lf-tag mute">{t('metacatalog.res.st.off')}</span>;
}

function Thumb({ src, size = 40, dim }: { src: string | null; size?: number; dim?: boolean }) {
  return src ? (
    <img className={`ct-thumb ${dim ? 'out' : ''}`} src={src} alt="" width={size} height={size} style={{ width: size, height: size }} loading="lazy" />
  ) : (
    <span className="ct-thumb none" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="package" />
    </span>
  );
}

function ResultRow({ p, onOpen }: { p: Row; onOpen: () => void }) {
  const { t } = useTranslation();
  const dr = rate(p.delivered, p.orders);
  return (
    <tr>
      <th scope="row">
        <button type="button" className="ct-rt-p" onClick={onOpen} aria-label={t('metacatalog.res.open', { name: p.name })}>
          <Thumb src={p.thumb} dim={p.state === 'low' || p.state === 'out'} />
          <bdi>{p.name}</bdi>
        </button>
      </th>
      <td className="num" data-label={t('metacatalog.res.visits')}>
        {n(p.visits)}
      </td>
      <td className="num" data-label={t('metacatalog.res.orders')}>
        <b>{n(p.orders)}</b>
      </td>
      <td className="num" data-label={t('metacatalog.res.delivered')}>
        {n(p.delivered)}
        {dr !== null && <small className="lf-muted"> ({t('metacatalog.res.pct', { pct: dr })})</small>}
      </td>
      <td className="num" data-label={t('metacatalog.res.cash')}>
        <b className={p.cash ? 'ct-cash' : ''}>{da(p.cash)}</b>
      </td>
      <td className="num" data-label={t('metacatalog.res.left')}>
        {p.left === null ? <span title={t('metacatalog.res.notCounted')}>—</span> : n(p.left)}
      </td>
      <td data-label={t('metacatalog.res.inAds')}>
        <AdState p={p} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- « Cachés : stock bas »
function HiddenBox({ r, onOpen }: { r: Res; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const { has } = useSession();
  // « Ajouter du stock »: for the people who can open Produits › Stock (its « Entrée »)
  const canStock = has('depot') && pageIsOn('produits', 'stock');
  const guard = useAction('metacatalog.guard');
  const g = r.guard;
  const why = (h: Hidden) =>
    h.why === 'out'
      ? h.variant
        ? t('metacatalog.res.hidOutV', { v: h.variant })
        : t('metacatalog.res.hidOut')
      : h.variant
        ? t('metacatalog.res.hidLowV', { v: h.variant, count: h.left })
        : t('metacatalog.res.hidLow', { count: h.left });
  return (
    <aside className="ct-hid" aria-labelledby="ct-hid-title">
      <div className="ct-hid-head">
        <h4 id="ct-hid-title">
          <Icon name="eyeoff" />
          {t('metacatalog.res.hidTitle')}
        </h4>
        <button type="button" role="switch" className="lf-switch" aria-checked={g.on} aria-label={t('metacatalog.res.guardSwitch')} disabled={guard.isPending} onClick={() => guard.mutate({ on: !g.on, min: g.min })}>
          <span aria-hidden="true" />
        </button>
      </div>
      <div className={`ct-guard ${g.on ? '' : 'off'}`}>
        {t('metacatalog.res.guardA')}
        <Stepper value={g.min} disabled={!g.on || guard.isPending} label={t('metacatalog.res.guardLabel')} onCommit={(min) => guard.mutate({ on: g.on, min })} />
        {t('metacatalog.res.guardB')}
      </div>
      {r.hidden.length ? (
        <ul className="ct-hid-list">
          {r.hidden.map((h) => (
            <li key={`${h.productId}-${h.variant ?? ''}`}>
              <Thumb src={h.thumb} size={36} dim />
              <span className="ct-name">
                <button type="button" className="ct-hid-p" onClick={() => onOpen(h.productId)} aria-label={t('metacatalog.res.open', { name: h.name })}>
                  <bdi>{h.name}</bdi>
                </button>
                <small>
                  {why(h)}
                  {h.why === 'low' && h.level !== g.min && <> · {t('metacatalog.res.ownLevel', { count: h.level })}</>}
                </small>
                {canStock && (
                  <a className="lf-link ct-hid-add" href="#/produits/stock">
                    <Icon name="plus" />
                    {t('metacatalog.res.addStock')}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="lf-muted ct-small">{g.on ? t('metacatalog.res.hidNone') : t('metacatalog.res.guardOff')}</p>
      )}
      <p className="lf-muted ct-small">{t('metacatalog.res.hidBack')}</p>
    </aside>
  );
}

/** − 3 +: a number changed by steps (sent once the hand stops), or typed. */
function Stepper({ value, onCommit, label, disabled }: { value: number; onCommit: (v: number) => void; label: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [v, setV] = useState(String(value));
  const timer = useRef<number | null>(null);
  useEffect(() => setV(String(value)), [value]);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  const commit = (x: number) => {
    const c = Math.max(0, Math.min(999, Math.trunc(x)));
    setV(String(c));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => c !== value && onCommit(c), 600);
  };
  const cur = Number(v) || 0;
  return (
    <span className="ct-step" role="group" aria-label={label}>
      <button type="button" aria-label={t('metacatalog.res.less')} disabled={disabled || cur <= 0} onClick={() => commit(cur - 1)}>
        <Icon name="minus" />
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 3))}
        onBlur={() => commit(cur)}
        onKeyDown={(e) => e.key === 'Enter' && commit(cur)}
      />
      <button type="button" aria-label={t('metacatalog.res.more')} disabled={disabled || cur >= 999} onClick={() => commit(cur + 1)}>
        <Icon name="plus" />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- one product
function ProductSheet({ id, days: start, onClose }: { id: number; days: Days; onClose: () => void }) {
  const { t } = useTranslation();
  const [days, setDays] = useState<Days>(start);
  const q = useRpc('metacatalog.product', { id, days });
  const own = useAction('metacatalog.productGuard');
  const p = q.data;
  const title = p?.name ?? t('metacatalog.res.loading');
  const pct = p ? rate(p.numbers.delivered, p.numbers.orders) : null;
  return (
    <Modal sheet title={title} onClose={onClose} className="ct-ps-modal">
      {q.error && !p ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !p ? (
        <Loading />
      ) : (
        <div className="ct-ps">
          <div className="ct-ps-top">
            <Thumb src={p.thumb} size={56} />
            <span className="ct-name">
              <span>
                <b className="ltr">{da(p.price)}</b>
                {p.oldPrice && <s className="ltr">{da(p.oldPrice)}</s>}
              </span>
            </span>
            <Period value={days} onChange={setDays} />
          </div>
          <div className="ct-ps-nums">
            <Num label={t('metacatalog.res.visits')} value={n(p.numbers.visits)} />
            <Num label={t('metacatalog.res.orders')} value={n(p.numbers.orders)} />
            <Num label={t('metacatalog.res.delivered')} value={`${n(p.numbers.delivered)}${pct !== null ? ` (${t('metacatalog.res.pct', { pct })})` : ''}`} />
            <Num label={t('metacatalog.res.cash')} value={da(p.numbers.cash)} ok />
          </div>
          <OrdersChart daily={p.daily} />
          <div className="ct-ps-stock">
            <h4>{t('metacatalog.res.stockBy')}</h4>
            {(p.state === 'fix' || p.state === 'off') && (
              <p className={`ct-small ${p.state === 'fix' ? 'ct-ps-fix' : 'lf-muted'}`}>
                {p.state === 'fix'
                  ? t('metacatalog.res.notInAdsFix', {
                      why: t(p.problem === 'photo' ? 'metacatalog.pb.photo' : 'metacatalog.pb.nopage'),
                    })
                  : t('metacatalog.res.notInAdsOff')}
              </p>
            )}
            {!p.tracked ? (
              <p className="lf-muted ct-small">{t('metacatalog.res.untracked')}</p>
            ) : (
              <ul>
                {p.variants.map((v) => (
                  <li key={v.id}>
                    <span className="ct-ps-v">
                      <bdi>{v.title || t('metacatalog.res.oneModel')}</bdi>
                    </span>
                    <span className="lf-muted">
                      {t('metacatalog.res.leftN', {
                        count: Math.max(0, v.left),
                      })}
                    </span>
                    {v.why === null ? (
                      p.state !== 'fix' &&
                      p.state !== 'off' && (
                        <span className="lf-tag ok">
                          <Icon name="check" />
                          {t('metacatalog.res.st.ads')}
                        </span>
                      )
                    ) : (
                      <span className="lf-tag mute">
                        <Icon name="eyeoff" />
                        {t(v.why === 'out' ? 'metacatalog.res.st.out' : 'metacatalog.res.st.low')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {p.tracked && (
            <fieldset className="ct-ps-level" disabled={own.isPending || !p.guard.on}>
              <legend>{t('metacatalog.res.levelTitle')}</legend>
              {!p.guard.on && <p className="lf-muted ct-small">{t('metacatalog.res.guardOff')}</p>}
              <label className={`lf-radio ${p.level === null ? 'on' : ''}`}>
                <input type="radio" name={`lvl-${p.id}`} checked={p.level === null} onChange={() => own.mutate({ id: p.id, level: null })} />
                <span>{t('metacatalog.res.levelShop', { count: p.guard.min })}</span>
              </label>
              <label className={`lf-radio ${p.level !== null ? 'on' : ''}`}>
                <input type="radio" name={`lvl-${p.id}`} checked={p.level !== null} onChange={() => own.mutate({ id: p.id, level: p.guard.min })} />
                <span className="ct-ps-own">
                  {t('metacatalog.res.levelOwnA')}
                  <Stepper value={p.level ?? p.guard.min} disabled={p.level === null || own.isPending} label={t('metacatalog.res.levelTitle')} onCommit={(level) => own.mutate({ id: p.id, level })} />
                  {t('metacatalog.res.levelOwnB')}
                </span>
              </label>
            </fieldset>
          )}
        </div>
      )}
    </Modal>
  );
}

function Num({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="ct-num">
      <span>{label}</span>
      <b className={`ltr ${ok ? 'ok' : ''}`}>{value}</b>
    </div>
  );
}

/** Orders day by day, Meta under TikTok (time runs left to right in every language). */
function OrdersChart({ daily }: { daily: { day: string; meta: number; tiktok: number }[] }) {
  const { t } = useTranslation();
  const [ref, box] = useBox();
  const meta = daily.reduce((s, d) => s + d.meta, 0);
  const tiktok = daily.reduce((s, d) => s + d.tiktok, 0);
  const ticks = ticksFor(Math.max(...daily.map((d) => d.meta + d.tiktok), 0));
  const W = Math.max(240, box.w);
  const H = 190;
  const L = 34;
  const R = 6;
  const T = 8;
  const Hy = H - 6;
  const B = H - 26;
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => B - ((B - T) * v) / top;
  const iw = W - L - R;
  const slot = iw / Math.max(1, daily.length);
  const bw = Math.max(3, Math.min(26, slot * 0.62));
  const x = (i: number) => L + slot * i + slot / 2;
  return (
    <figure className="ct-chart">
      <figcaption>
        <b>{t('metacatalog.res.perDay')}</b>
        <span className="pp-lg">
          <span>
            <i className="ct-k-meta" />
            {t('metacatalog.res.metaN', { count: meta, n: n(meta) })}
          </span>
          <span>
            <i className="ct-k-tt" />
            {t('metacatalog.res.tiktokN', { count: tiktok, n: n(tiktok) })}
          </span>
        </span>
      </figcaption>
      <div
        ref={ref}
        className="pp-chart"
        role="img"
        aria-label={t('metacatalog.res.chartAlt', {
          meta,
          tiktok,
          days: daily.length,
        })}
      >
        {box.w > 0 && (
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
            <Axis ticks={ticks} y={y} L={L} R={R} W={W} />
            {daily.map((d, i) => (
              <g key={d.day}>
                {daily.length <= 10 && d.meta + d.tiktok > 0 && (
                  <text className="ct-bv" x={x(i)} y={y(d.meta + d.tiktok) - 5} textAnchor="middle">
                    {d.meta + d.tiktok}
                  </text>
                )}
                {d.meta > 0 && <rect className="ct-b-meta" x={x(i) - bw / 2} y={y(d.meta)} width={bw} height={B - y(d.meta)} rx={2} />}
                {d.tiktok > 0 && <rect className="ct-b-tt" x={x(i) - bw / 2} y={y(d.meta + d.tiktok)} width={bw} height={y(d.meta) - y(d.meta + d.tiktok) - (d.meta > 0 ? 1.5 : 0)} rx={2} />}
              </g>
            ))}
            <DateLabels days={daily} x={x} iw={iw} L={L} R={R} W={W} Hy={Hy} />
          </svg>
        )}
      </div>
    </figure>
  );
}
