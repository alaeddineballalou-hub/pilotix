// Marketing on phones. Publicité: everything to know what to do — the verdict (won / lost), where the money goes,
// every figure (orders, money, Meta), what wins and what loses, what to do, day by day and month by month, then the
// products and ad sets (a tap opens them full screen). Marketeurs: what is owed to whom, each marketer's ad sets.
// AI Spy: the desktop page (Spy.tsx), which lays itself out in one column on a phone.
// Every figure comes from core (ads.*, mk.*); this page only arranges them for a phone.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n, pct } from '../../lib/format';
import { useFullScreen } from '../../lib/fullScreen';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Spy } from './Spy';
import '../confirmation/phone.css';
import '../suivi/phone.css';
import '../sav/phone.css';
import './phone.css';

type Ov = Out<'ads.overview'>;
type Prod = Ov['products'][number];
type Adset = Ov['adsets'][number];
type PKey = 'today' | 'yesterday' | 'thisweek' | 'month' | 'lastmonth' | 'custom';
const PKEYS: PKey[] = ['today', 'yesterday', 'thisweek', 'month', 'lastmonth'];

const algDay = (k = 0) => new Date(Date.now() + 3_600_000 + k * 86_400_000).toISOString().slice(0, 10);
const addDays = (d: string, k: number) => new Date(Date.parse(d + 'T00:00:00Z') + k * 86_400_000).toISOString().slice(0, 10);
const daysIn = (r: { from: string; to: string }) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;
function rangeOf(p: PKey): { from: string; to: string } {
  const today = algDay();
  const sinceSat = (new Date(today + 'T00:00:00Z').getUTCDay() + 1) % 7; // weeks start on Saturday in Algeria
  const first = today.slice(0, 8) + '01';
  if (p === 'today') return { from: today, to: today };
  if (p === 'yesterday') return { from: algDay(-1), to: algDay(-1) };
  if (p === 'thisweek') return { from: algDay(-sinceSat), to: today };
  if (p === 'lastmonth') {
    const end = addDays(first, -1);
    return { from: end.slice(0, 8) + '01', to: end };
  }
  return { from: first, to: today };
}
/** The same number of days just before. */
const prevOf = (r: { from: string; to: string }) => ({ from: addDays(r.from, -daysIn(r)), to: addDays(r.from, -1) });

const usd = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !isFinite(v) ? '—' : `${v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} $`);
const dz = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : n(Math.round(v)));
const sgn = (v: number) => (v > 0 ? `+${n(Math.round(v))}` : n(Math.round(v)));
const div = (a: number, b: number) => (b ? a / b : null);
const kfmt = (v: number) => (v >= 10_000 ? `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k` : n(v));
const ADV_TONE: Record<string, string> = { scale: 'g', keep: 'o', price: 'o', cutdel: 'r', cut: 'r', loss: 'r', wait: 'm' };
const DIAG_ICON: Record<string, string> = { scale: 'trend', cut: 'cut', hook: 'film', fatigue: 'film', audience: 'users', page: 'globe' };

// ---------------------------------------------------------------- the page
export function PhoneMarketing({ sub, rest, noSpy, mkLabel }: { sub?: string; rest?: string[]; noSpy?: boolean; mkLabel?: string }) {
  const { t } = useTranslation();
  const tab = sub === 'marketer' ? 'mk' : sub === 'spy' && !noSpy ? 'spy' : 'pub';
  return (
    <div className="pxm">
      <div className="pxv-own pxm-tabs" role="tablist">
        <a role="tab" aria-selected={tab === 'pub'} className={tab === 'pub' ? 'on' : ''} href="#/marketing/publicite">
          {t('nav.publicite')}
        </a>
        <a role="tab" aria-selected={tab === 'mk'} className={tab === 'mk' ? 'on' : ''} href="#/marketing/marketer">
          {mkLabel ?? t('mkph.marketers')}
        </a>
        {!noSpy && (
          <a role="tab" aria-selected={tab === 'spy'} className={tab === 'spy' ? 'on' : ''} href="#/marketing/spy">
            {t('nav.spy')}
          </a>
        )}
      </div>
      {/* AI Spy: the same page as on a computer, in one column */}
      {tab === 'pub' ? <Pub /> : tab === 'spy' ? <Spy rest={rest} /> : <Marketeurs />}
    </div>
  );
}

function Pub() {
  const { t } = useTranslation();
  const { has, session } = useSession();
  // opened from a marketer's space: Meta is connected (or not) at the seller's
  const atSeller = session?.shop?.kind === 'marketer';
  const owner = has('vendeur');
  const [p, setP] = useState<PKey>(() => {
    const s = store.get('ads-period') as PKey | null;
    return s && PKEYS.includes(s) ? s : 'month';
  });
  const [range, setRange] = useState(() => rangeOf(p));
  const [dates, setDates] = useState(false);
  const [marketerId, setMarketerId] = useState<number | null>(null);
  const [prod, setProd] = useState<number | null>(null);
  const [adset, setAdset] = useState<Adset | null>(null);
  const q = useRpc('ads.overview', { ...range, productId: null, marketerId });
  const prev = useRpc('ads.overview', { ...prevOf(range), productId: null, marketerId });
  const months = useRpc('ads.months', { to: range.to, marketerId });
  const sync = useAction('ads.sync', { success: t('ads.refreshed') });
  const choose = (k: PKey) => {
    setP(k);
    store.set('ads-period', k);
    setRange(rangeOf(k));
  };
  const d = q.data;
  return (
    <>
      <div className="pxv-road">
        {PKEYS.map((k) => (
          <button key={k} type="button" className={p === k ? 'on' : ''} onClick={() => choose(k)}>
            {t(`mkph.p.${k}`)}
          </button>
        ))}
        <button type="button" className={p === 'custom' ? 'on' : ''} onClick={() => setDates((v) => !v)}>
          <Icon name="calendar" /> {p === 'custom' ? `${range.from.slice(5)} → ${range.to.slice(5)}` : t('mkph.p.custom')}
        </button>
      </div>
      {dates && (
        <div className="pxm-dates">
          <label>
            <span>{t('ads.from')}</span>
            <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && (setP('custom'), setRange({ ...range, from: e.target.value }))} />
          </label>
          <label>
            <span>{t('ads.to')}</span>
            <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && (setP('custom'), setRange({ ...range, to: e.target.value }))} />
          </label>
        </div>
      )}
      {owner && !!d?.marketers.length && (
        <select className="pxm-sel" value={marketerId ?? ''} aria-label={t('ads.marketer')} onChange={(e) => setMarketerId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t('ads.allMarketers')}</option>
          {d.marketers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          {d.syncWarning && <div className="error">{d.syncWarning}</div>}
          {!d.connected && !d.demo && <div className="warnbox">{t(atSeller ? 'ads.notConnectedSeller' : 'ads.notConnected')}</div>}
          <FxBar d={d} />
          <Dash d={d} prev={prev.data ?? null} label={t(`mkph.when.${p}`)} onProd={setProd} onAdset={setAdset} />
          {d && <Months rows={months.data ?? null} />}
          <ProductList d={d} onOpen={setProd} />
          <AdsetList d={d} onOpen={setAdset} />
          {!d.demo && (
            <button type="button" className="pxv-btn" disabled={sync.isPending} onClick={() => sync.mutate(range)}>
              <Icon name="refresh" /> {t('ads.refresh')}
            </button>
          )}
          <p className="pxv-help pxm-foot">{d.demo ? t('ads.demoTip') : ''}</p>
        </>
      )}
      {prod !== null && <ProductPage id={prod} range={range} marketerId={marketerId} label={t(`mkph.when.${p}`)} onClose={() => setProd(null)} onAdset={setAdset} />}
      {adset && <AdsetPage a={adset} range={range} onClose={() => setAdset(null)} />}
    </>
  );
}

/** The dollar rate of the month: without it, nothing in DA can be computed. */
function FxBar({ d }: { d: Ov }) {
  const { t } = useTranslation();
  const [v, setV] = useState('');
  const { has } = useSession();
  const save = useAction('ads.setFx', { success: t('ads.fxSaved') });
  if (d.fx.rate && !d.fx.missing) return null;
  // only the owner sets the rate (it decides the marketers' pay)
  if (!has('vendeur'))
    return (
      <div className="pxm-fx">
        <Icon name="alert" />
        <span>{t('ads.fxMissing')} {t('ads.fxOwnerOnly')}</span>
      </div>
    );
  return (
    <div className="pxm-fx">
      <Icon name="alert" />
      <span>{t('ads.fxMissing')}</span>
      <input type="number" inputMode="decimal" min={1} placeholder="250" value={v} onChange={(e) => setV(e.target.value)} />
      <button type="button" className="pxv-btn nv" disabled={!(Number(v) >= 1) || save.isPending} onClick={() => save.mutate({ ym: d.fx.month, rate: Number(v) })}>
        {t('ads.fxSave')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the dashboard (shop, or one product)
function Dash({ d, prev, label, onProd, onAdset, product }: { d: Ov; prev: Ov | null; label: string; onProd?: (id: number) => void; onAdset: (a: Adset) => void; product?: boolean }) {
  const { t } = useTranslation();
  // in a marketer's space the money is the seller's, not the marketer's
  const atSeller = useSession().session?.shop?.kind === 'marketer';
  const m = d.totals;
  const fxOk = !!d.fx.rate && !d.fx.missing;
  const win = m.net >= 0;
  const delta = prev && fxOk ? m.net - prev.totals.net : null;
  const maxCpd = m.d ? m.avant / m.d : null; // what one delivered order can pay for ads and still break even
  const cpd = div(m.pub, m.d);
  const pur = d.adsets.reduce((s, a) => s + a.purchases, 0);
  const imp = d.adsets.reduce((s, a) => s + a.impressions, 0);
  const clicks = d.adsets.reduce((s, a) => s + (a.ctr ?? 0) * a.impressions, 0);
  const days = Math.max(1, daysIn(d));
  const cancelled = (m as { x?: number }).x ?? 0;
  const rate = div(m.d, m.d + m.r);
  return (
    <>
      {/* the verdict */}
      <section className={`pxm-verd ${!fxOk ? 'off' : win ? 'w' : 'l'}`}>
        <div className="pxm-vh">
          <span>{fxOk ? t(atSeller ? (win ? 'mkph.sellerWin' : 'mkph.sellerLose') : win ? 'mkph.youWin' : 'mkph.youLose', { when: label }) : t('mkph.noFx')}</span>
          {d.fx.rate ? <b className="ltr">1 $ = {n(d.fx.rate)} DA</b> : null}
        </div>
        <b className="pxm-big ltr">{fxOk ? `${sgn(m.net)} DA` : usd(m.spendUsd)}</b>
        {fxOk && (
          <div className="pxm-pills">
            {m.d > 0 && <span>{t('mkph.perDelivered', { v: sgn(m.net / m.d) })}</span>}
            {delta !== null && (
              <span>
                <Icon name={delta >= 0 ? 'trend' : 'trenddown'} /> {t('mkph.vsBefore', { v: sgn(delta) })}
              </span>
            )}
            {m.rev > 0 && <span>{t('mkph.adsShare', { v: pct(m.pub / m.rev) })}</span>}
          </div>
        )}
      </section>

      {/* where the money goes */}
      {fxOk && m.rev > 0 && (
        <section className="pxs-sec pxm-wf">
          <h4>{t('mkph.whereMoney', { v: dz(m.rev) })}</h4>
          {(
            [
              [t('mkph.wf.rev', { n: m.d }), m.rev, 'g'],
              [t('mkph.wf.achat'), -m.achat, 'n'],
              [t('mkph.wf.liv'), -m.liv, 'n'],
              [t('mkph.wf.conf'), -m.conf, 'n'],
              [t('mkph.wf.ret', { n: m.r }), -m.ret, 'o'],
              [t('mkph.wf.pub', { v: usd(m.spendUsd, 0) }), -m.pub, 'r'],
            ] as [string, number, string][]
          ).map(([l, v, c]) => (
            <div key={l} className="pxm-wr">
              <span>{l}</span>
              <i className={c} style={{ width: `${Math.max(1, (Math.abs(v) / m.rev) * 100)}%` }} />
              <b className="ltr">{v > 0 ? dz(v) : `−${dz(-v)}`}</b>
            </div>
          ))}
          <div className="pxm-wr tot">
            <span>{t('mkph.wf.net')}</span>
            <small className={win ? 'ok' : 'bad'}>{t('mkph.ofSales', { v: pct(m.net / m.rev) })}</small>
            <b className={`ltr ${win ? 'ok' : 'bad'}`}>{sgn(m.net)}</b>
          </div>
        </section>
      )}

      {/* every figure */}
      <div className="pxm-lbl">
        <Icon name="package" /> {t('mkph.g.orders')}
      </div>
      <div className="pxm-kg">
        <K l={t('mkph.k.received')} v={n(m.n)} s={t('mkph.k.perDay', { v: (m.n / days).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) })} />
        <K l={t('mkph.k.delivered')} v={n(m.d)} s={t('mkph.k.pieces', { n: m.qty })} />
        <K l={t('mkph.k.rate')} v={pct(rate)} s={t('mkph.k.rateSub')} tone={rate === null ? '' : rate >= 0.6 ? 'g' : rate >= 0.45 ? 'o' : 'r'} />
        <K l={t('mkph.k.road')} v={n(m.enRoute)} s={t('mkph.k.roadSub')} />
        <K l={t('mkph.k.returned')} v={n(m.r)} s={fxOk && m.ret ? `−${dz(m.ret)} DA` : pct(div(m.r, m.n))} tone={m.r ? 'r' : ''} />
        <K l={t('mkph.k.cancelled')} v={n(cancelled)} s={pct(div(cancelled, m.n))} />
      </div>
      <div className="pxm-lbl">
        <Icon name="coins" /> {t('mkph.g.money')}
      </div>
      <div className="pxm-kg">
        <K l={t('mkph.k.spend')} v={usd(m.spendUsd, 0)} s={fxOk ? `${dz(m.pub)} DA` : t('ads.kpi.noFx')} />
        <K l={t('mkph.k.cpo')} v={fxOk ? dz(div(m.pub, m.n)) : '—'} s="DA" />
        <K l={t('mkph.k.cpd')} v={fxOk ? dz(cpd) : '—'} s={maxCpd !== null && fxOk ? t('mkph.k.cpdMax', { v: dz(maxCpd) }) : 'DA'} tone={cpd !== null && maxCpd !== null && fxOk ? (cpd > maxCpd ? 'r' : cpd > maxCpd * 0.7 ? 'o' : 'g') : ''} hl={cpd !== null && maxCpd !== null && fxOk && cpd > maxCpd} />
        <K l={t('mkph.k.before')} v={fxOk ? dz(m.avant) : '—'} s={m.d ? t('mkph.k.perDel', { v: dz(m.avant / m.d) }) : ''} tone={m.avant >= 0 ? 'g' : 'r'} />
        <K l={t('mkph.k.roas')} v={m.pub ? (m.rev / m.pub).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '—'} s={t('mkph.k.roasSub')} />
        <K l={t('mkph.k.basket')} v={dz(div(m.rev, m.d))} s="DA" />
      </div>
      <div className="pxm-lbl">
        <Icon name="megaphone" /> {t('mkph.g.meta')}
      </div>
      <div className="pxm-kg">
        <K l={t('mkph.k.purchases')} v={n(pur)} s={t('mkph.k.vsReal', { n: m.n })} />
        <K l={t('mkph.k.cpa')} v={usd(div(m.spendUsd, pur))} s={fxOk && pur ? `${dz(m.pub / pur)} DA` : ''} />
        <K l={t('mkph.k.ctr')} v={pct(div(clicks, imp), 1)} s={t('mkph.k.ctrSub')} />
        <K l={t('mkph.k.cpm')} v={usd(imp ? (m.spendUsd / imp) * 1000 : null)} s={t('mkph.k.cpmSub')} />
        <K l={t('mkph.k.imp')} v={kfmt(imp)} s={t('mkph.k.perDay', { v: kfmt(Math.round(imp / days)) })} />
        {product ? <K l={t('mkph.k.adsets')} v={n(d.adsets.length)} s={t('mkph.k.active', { n: d.adsets.filter((a) => a.status === 'ACTIVE').length })} /> : <K l={t('mkph.k.toScale')} v={n(m.toScale)} s={t('mkph.k.toScaleSub')} tone={m.toScale ? 'g' : ''} />}
      </div>

      {/* wins / losses */}
      {!product && fxOk && <WinLose d={d} onProd={onProd} />}
      <Todo d={d} onAdset={onAdset} fxOk={fxOk} />
      <DaysChart d={d} />
    </>
  );
}

function K({ l, v, s, tone = '', hl }: { l: string; v: string; s?: string; tone?: string; hl?: boolean }) {
  return (
    <div className={`${tone}${hl ? ' hl' : ''}`}>
      <small>{l}</small>
      <b className="ltr">{v}</b>
      <em>{s || ' '}</em>
    </div>
  );
}

function WinLose({ d, onProd }: { d: Ov; onProd?: (id: number) => void }) {
  const { t } = useTranslation();
  const sorted = [...d.products].sort((a, b) => b.money.net - a.money.net);
  const wins = sorted.filter((p) => p.money.net > 0).slice(0, 4);
  const losses = sorted.filter((p) => p.money.net < 0).reverse().slice(0, 4);
  const Item = ({ p }: { p: Prod }) => (
    <button type="button" className="pxm-it" onClick={() => onProd?.(p.productId)}>
      <b>{p.name}</b>
      <span className={`ltr ${p.money.net >= 0 ? 'ok' : 'bad'}`}>{sgn(p.money.net)} DA</span>
    </button>
  );
  return (
    <div className="pxm-wl">
      <div>
        <h5 className="ok">
          <Icon name="trend" /> {t('mkph.wins')}
        </h5>
        {wins.length ? wins.map((p) => <Item key={p.productId} p={p} />) : <small className="muted">—</small>}
      </div>
      <div>
        <h5 className="bad">
          <Icon name="trenddown" /> {t('mkph.losses')}
        </h5>
        {losses.map((p) => (
          <Item key={p.productId} p={p} />
        ))}
        {d.totals.unlinkedDzd > 0 && (
          <span className="pxm-it">
            <b>{t('mkph.unlinked')}</b>
            <span className="ltr bad">−{dz(d.totals.unlinkedDzd)} DA</span>
          </span>
        )}
        {!losses.length && !d.totals.unlinkedDzd && <small className="muted">—</small>}
      </div>
    </div>
  );
}

/** What to do: the ad sets that need a move, the products whose price should rise, with the money at stake. */
function Todo({ d, onAdset, fxOk }: { d: Ov; onAdset: (a: Adset) => void; fxOk: boolean }) {
  const { t } = useTranslation();
  const days = Math.max(1, daysIn(d));
  const order: Record<string, number> = { cut: 0, scale: 1, fatigue: 2, audience: 3, hook: 4, page: 5 };
  const sets = d.adsets.filter((a) => a.diag.k in order).sort((a, b) => order[a.diag.k] - order[b.diag.k] || b.spendUsd - a.spendUsd);
  const prices = d.products.filter((p) => p.advice.k === 'price' && p.advice.rise);
  if (!sets.length && !prices.length)
    return (
      <div className="pxm-ok">
        <Icon name="checkcircle" /> {t('ads.diagNone')}
      </div>
    );
  return (
    <>
      <div className="pxm-lbl">{t('mkph.todo', { n: sets.length + prices.length })}</div>
      {sets.map((a) => {
        const tone = a.diag.tone === 'ok' ? 'g' : a.diag.k === 'cut' ? 'r' : 'o';
        return (
          <button key={a.id} type="button" className="pxm-todo" onClick={() => onAdset(a)}>
            <span className={`pxm-tic ${tone}`}>
              <Icon name={DIAG_ICON[a.diag.k] ?? 'alert'} />
            </span>
            <span className="pxm-tt">
              <b>
                {t(`ads.diag.${a.diag.k}`)} · {a.name}
              </b>
              <small>{t(`ads.diagDo.${a.diag.k}`)}</small>
            </span>
            {fxOk && a.spendDzd > 0 && <span className={`pxm-imp ${tone}`}>{t(a.diag.k === 'cut' ? 'mkph.spendsDay' : 'mkph.spendDay', { v: dz(a.spendDzd / days) })}</span>}
          </button>
        );
      })}
      {prices.map((p) => (
        <div key={p.productId} className="pxm-todo">
          <span className="pxm-tic o">
            <Icon name="tag" />
          </span>
          <span className="pxm-tt">
            <b>{t('mkph.priceUp', { name: p.name, v: dz(p.advice.rise) })}</b>
            <small>{t('mkph.priceWhy')}</small>
          </span>
        </div>
      ))}
    </>
  );
}

function DaysChart({ d }: { d: Ov }) {
  const { t } = useTranslation();
  const days = d.days.slice(-31);
  if (days.length < 2) return null;
  const maxS = Math.max(1, ...days.map((x) => x.spendUsd));
  const maxO = Math.max(1, ...days.map((x) => x.orders));
  const best = [...days].sort((a, b) => b.orders - a.orders)[0];
  return (
    <section className="pxs-sec">
      <h4>{t('mkph.days')}</h4>
      <div className="pxm-leg">
        <span>
          <i className="s" /> {t('mkph.spend')}
        </span>
        <span>
          <i className="o" /> {t('mkph.orders')}
        </span>
        <span className="sp">{t('mkph.bestDay', { d: best.day.slice(8) + '/' + best.day.slice(5, 7), n: best.orders })}</span>
      </div>
      <div className="pxm-chart" aria-label={t('mkph.days')}>
        {days.map((x) => (
          <span key={x.day} title={`${x.day} · ${usd(x.spendUsd)} · ${x.orders}`}>
            <i className="s" style={{ height: `${(x.spendUsd / maxS) * 100}%` }} />
            <i className="o" style={{ height: `${(x.orders / maxO) * 100}%` }} />
          </span>
        ))}
      </div>
    </section>
  );
}

type MonthRow = { ym: string; spendUsd: number; delivered: number; cpd: number | null; profit: number };
function Months({ rows: raw }: { rows: Out<'ads.months'> | null }) {
  const rows = raw as unknown as MonthRow[] | null;
  const { t, i18n } = useTranslation();
  const shown = (rows ?? []).filter((r) => r.spendUsd > 0 || r.profit !== 0 || r.delivered > 0);
  if (!shown.length) return null;
  const lang = i18n.language === 'ar' ? 'ar-DZ' : i18n.language;
  return (
    <section className="pxs-sec">
      <h4>{t('mkph.months')}</h4>
      <table className="pxm-mt">
        <thead>
          <tr>
            <th>{t('ads.colMonth')}</th>
            <th>{t('mkph.pub')}</th>
            <th>{t('mkph.k.delivered')}</th>
            <th>{t('mkph.cpdShort')}</th>
            <th>{t('mkph.net')}</th>
          </tr>
        </thead>
        <tbody>
          {[...shown].reverse().map((r) => (
            <tr key={r.ym}>
              <td>
                <b>{new Date(r.ym + '-15T00:00:00Z').toLocaleDateString(lang, { month: 'short' })}</b>
              </td>
              <td className="ltr">{usd(r.spendUsd, 0)}</td>
              <td>{n(r.delivered)}</td>
              <td className="ltr">{dz(r.cpd)}</td>
              <td className={`ltr ${r.profit >= 0 ? 'ok' : 'bad'}`}>
                <b>{sgn(r.profit)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ProductList({ d, onOpen }: { d: Ov; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  if (!d.products.length) return null;
  return (
    <>
      <div className="pxm-lbl">{t('mkph.products', { n: d.products.length })}</div>
      {[...d.products]
        .sort((a, b) => a.money.net - b.money.net)
        .map((p) => (
          <ProdCard key={p.productId} p={p} onOpen={() => onOpen(p.productId)} />
        ))}
    </>
  );
}

function ProdCard({ p, onOpen }: { p: Prod; onOpen: () => void }) {
  const { t } = useTranslation();
  const tone = ADV_TONE[p.advice.k] ?? 'm';
  return (
    <button type="button" className="pxm-pc" onClick={onOpen}>
      <span className="pxm-pt">
        <i className={`pxm-light ${tone}`} />
        <b>{p.name}</b>
        <span className={`pxm-adv ${tone}`}>{t(`ads.advice.${p.advice.k}`)}</span>
      </span>
      <span className="pxm-st4">
        <span>
          <small>{t('mkph.k.spend')}</small>
          <b className="ltr">{usd(p.spendUsd, 0)}</b>
        </span>
        <span>
          <small>{t('mkph.k.delivered')}</small>
          <b className="ltr">
            {n(p.money.d)} / {n(p.money.n)}
          </b>
        </span>
        <span>
          <small>{t('mkph.cpdShort')}</small>
          <b className="ltr">{dz(div(p.money.pub, p.money.d))}</b>
        </span>
        <span>
          <small>{t('mkph.net')}</small>
          <b className={`ltr ${p.money.net >= 0 ? 'ok' : 'bad'}`}>{sgn(p.money.net)}</b>
        </span>
      </span>
    </button>
  );
}

function AdsetList({ d, onOpen }: { d: Ov; onOpen: (a: Adset) => void }) {
  const { t } = useTranslation();
  if (!d.adsets.length) return null;
  return (
    <>
      <div className="pxm-lbl">{t('mkph.adsets', { n: d.adsets.length })}</div>
      <ul className="pxm-al">
        {d.adsets.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a)}>
              <i className={`pxm-light ${a.status === 'ACTIVE' ? (a.diag.tone === 'bad' ? 'r' : a.diag.tone === 'mid' ? 'o' : 'g') : 'm'}`} />
              <span className="pxm-an">
                <b>{a.name}</b>
                <small>
                  {a.status === 'ACTIVE' ? t(`ads.diag.${a.diag.k}`) : (a.status ?? '').toLowerCase()}
                  {a.marketerName ? ` · ${a.marketerName}` : ''}
                </small>
              </span>
              <span className="pxm-av">
                <b className="ltr">{usd(a.spendUsd, 0)}</b>
                <small className="ltr">
                  {n(a.purchases)} · CPA {usd(a.cpa)}
                </small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- one product, full screen
function ProductPage({ id, range, marketerId, label, onClose, onAdset }: { id: number; range: { from: string; to: string }; marketerId: number | null; label: string; onClose: () => void; onAdset: (a: Adset) => void }) {
  const { t } = useTranslation();
  useFullScreen(onClose);
  const q = useRpc('ads.overview', { ...range, productId: id, marketerId });
  const prev = useRpc('ads.overview', { ...prevOf(range), productId: id, marketerId });
  const d = q.data;
  const p = d?.products.find((x) => x.productId === id);
  const name = p?.name ?? d?.catalog.find((c) => c.id === id)?.name ?? '…';
  const tone = p ? ADV_TONE[p.advice.k] ?? 'm' : 'm';
  return (
    <div className="pxp-order pxm-page" role="dialog" aria-modal="true" aria-label={name}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>{name}</b>
          <small>
            {label} · {t('mkph.adsetsN', { count: d?.adsets.length ?? 0 })}
          </small>
        </div>
        {p && <span className={`pxm-adv ${tone}`}>{t(`ads.advice.${p.advice.k}`)}</span>}
      </header>
      <div className="pxp-ob pxm-ob">
        {!d ? (
          q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />
        ) : (
          <>
            {p && (
              <section className={`pxs-sec pxm-advice ${tone}`}>
                <span className={`pxm-tic ${tone}`}>
                  <Icon name={tone === 'g' ? 'trend' : tone === 'r' ? 'cut' : tone === 'o' ? 'tag' : 'clock'} />
                </span>
                <span className="pxm-tt">
                  <b>{t(`ads.adviceLong.${p.advice.k}`)}</b>
                  <small>
                    {p.advice.k === 'price' && p.advice.rise ? t('mkph.priceBy', { v: dz(p.advice.rise) }) : p.money.d ? t('mkph.cpdVs', { c: dz(div(p.money.pub, p.money.d)), m: dz(p.money.avant / p.money.d) }) : t('ads.adviceLong.wait')}
                  </small>
                </span>
              </section>
            )}
            <Dash d={d} prev={prev.data ?? null} label={label} onAdset={onAdset} product />
            <AdsetList d={d} onOpen={onAdset} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one ad set, full screen
function AdsetPage({ a, range, onClose }: { a: Adset; range: { from: string; to: string }; onClose: () => void }) {
  const { t } = useTranslation();
  useFullScreen(onClose);
  const q = useRpc('ads.adset', { id: a.id, ...range });
  const ads = q.data?.ads ?? [];
  // the ad set's video health: its ads weighted by spend
  const w = (k: 'hook' | 'hold' | 'ctr') => {
    const xs = ads.filter((x) => x[k] !== null && x.spendUsd > 0);
    const tot = xs.reduce((s, x) => s + x.spendUsd, 0);
    return tot ? xs.reduce((s, x) => s + (x[k] as number) * x.spendUsd, 0) / tot : null;
  };
  const health: [string, number | null, number, number][] = [
    [t('mkph.hook'), w('hook'), 0.2, 0.3],
    [t('mkph.hold'), w('hold'), 0.15, 0.25],
    [t('mkph.ctr'), w('ctr'), 0.008, 0.015],
  ];
  const days = q.data?.days ?? [];
  const maxS = Math.max(1, ...days.map((x) => x.spendUsd));
  const tone = a.diag.tone === 'bad' ? 'r' : a.diag.tone === 'mid' ? 'o' : a.diag.tone === 'ok' ? 'g' : 'm';
  return (
    <div className="pxp-order pxm-page" role="dialog" aria-modal="true" aria-label={a.name}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>{a.name}</b>
          <small className="ltr">
            {a.id}
            {a.marketerName ? ` · ${a.marketerName}` : ''}
          </small>
        </div>
        <span className={`pxm-adv ${a.status === 'ACTIVE' ? 'g' : 'm'}`}>{(a.status ?? '—').toLowerCase()}</span>
      </header>
      <div className="pxp-ob pxm-ob">
        <section className={`pxs-sec pxm-advice ${tone}`}>
          <span className={`pxm-tic ${tone}`}>
            <Icon name={DIAG_ICON[a.diag.k] ?? (tone === 'g' ? 'checkcircle' : 'clock')} />
          </span>
          <span className="pxm-tt">
            <b>{t(`ads.diag.${a.diag.k}`)}</b>
            <small>{t(`ads.diagDo.${a.diag.k}`)}</small>
          </span>
        </section>
        <div className="pxm-kg two">
          <K l={t('mkph.k.spend')} v={usd(a.spendUsd)} s={a.spendDzd ? `${dz(a.spendDzd)} DA` : ''} />
          <K l={t('mkph.k.purchases')} v={n(a.purchases)} s={`CPA ${usd(a.cpa)}`} />
          <K l={t('mkph.k.ctr')} v={pct(a.ctr, 2)} s={t('mkph.k.ctrSub')} />
          <K l={t('mkph.k.cpm')} v={usd(a.cpm)} s={`${kfmt(a.impressions)} ${t('mkph.views')}`} />
        </div>
        {days.length > 1 && (
          <section className="pxs-sec">
            <h4>{t('mkph.days')}</h4>
            <div className="pxm-chart one">
              {days.map((x) => (
                <span key={x.day} title={`${x.day} · ${usd(x.spendUsd)} · ${x.purchases}`}>
                  <i className="s" style={{ height: `${(x.spendUsd / maxS) * 100}%` }} />
                </span>
              ))}
            </div>
          </section>
        )}
        <section className="pxs-sec">
          <h4>{t('mkph.health')}</h4>
          {health.map(([l, v, lo, hi]) => (
            <div key={l} className="pxm-gauge">
              <span>
                <b>{l}</b>
                <b className="ltr">{pct(v, l === t('mkph.ctr') ? 2 : 0)}</b>
              </span>
              <i>
                <u className={v === null ? '' : v >= hi ? 'g' : v >= lo ? 'o' : 'r'} style={{ width: `${v === null ? 0 : Math.min(100, (v / (hi * 1.6)) * 100)}%` }} />
              </i>
            </div>
          ))}
        </section>
        <section className="pxs-sec">
          <h4>{t('mkph.ads', { n: ads.length })}</h4>
          {!q.data ? (
            q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />
          ) : !ads.length ? (
            <p className="pxv-help">{t('ads.noAds')}</p>
          ) : (
            ads.map((x) => (
              <div key={x.id} className="pxm-ad">
                <Icon name={x.isVideo ? 'film' : 'image'} />
                <span className="pxm-an">
                  <b>{x.name}</b>
                  <small className="ltr">
                    {usd(x.spendUsd, 0)} · {n(x.purchases)} · CPA {usd(x.cpa)}
                    {x.hook !== null ? ` · hook ${pct(x.hook)}` : ''}
                  </small>
                </span>
                <span className={`pxm-adv ${x.advice.tone === 'ok' ? 'g' : x.advice.tone === 'bad' ? 'r' : x.advice.tone === 'mid' ? 'o' : 'm'}`}>{t(`ads.adAdvice.${x.advice.k}`)}</span>
              </div>
            ))
          )}
        </section>
        <a className="pxv-btn" href={`https://adsmanager.facebook.com/adsmanager/manage/adsets?selected_adset_ids=${encodeURIComponent(a.id)}`} target="_blank" rel="noopener noreferrer">
          <Icon name="external" /> {t('ads.adsManager')}
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Marketeurs
type Mk = Out<'mk.overview'>;
type MkRow = Mk['rows'][number];
const resOf = (r: MkRow): 'pay' | 'paid' | 'ok' | 'ko' | 'run' => (r.paid ? 'paid' : r.owe ? 'pay' : !r.final ? 'run' : r.ok ? 'ok' : 'ko');
const RES_TONE = { pay: 'g', paid: 'm', ok: 'g', ko: 'r', run: 'o' } as const;

function Marketeurs() {
  const { t } = useTranslation();
  const q = useRpc('mk.overview', {});
  const [who, setWho] = useState<number | 'none' | null>(null);
  const pay = useAction('mk.pay', { success: t('mkph.paidDone') });
  const d = q.data;
  const by = useMemo(() => {
    const m = new Map<number, MkRow[]>();
    for (const r of d?.rows ?? []) if (r.marketerId) (m.get(r.marketerId) ?? m.set(r.marketerId, []).get(r.marketerId)!).push(r);
    return m;
  }, [d]);
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const owed = d.rows.filter((r) => r.owe && !r.paid);
  const total = owed.reduce((s, r) => s + (r.owe ?? 0), 0);
  const paid = d.rows.filter((r) => r.paid).reduce((s, r) => s + (r.paid?.amount ?? 0), 0);
  const none = d.rows.filter((r) => !r.marketerId);
  const people = d.owner ? d.marketers.filter((m) => by.has(m.id) || m.active) : d.marketers;
  const judged = d.rows.filter((r) => r.final && r.marketerId);
  // a marketer account's people (from its own space): paid by its monthly bill (Facturation), not ad set by ad set
  const partnerView = !d.owner && d.rows.length > 0 && d.rows.every((r) => r.partnerId !== null);
  return (
    <>
      {partnerView ? (
        <p className="pxv-help">
          {t('marketer.partnerPaidBy')} <a href="#/facturation">{t('agency.nav.facturation')}</a>
        </p>
      ) : (
      <section className={`pxm-verd ${total ? 'w' : 'n'}`}>
        <div className="pxm-vh">
          <span>{d.owner ? t('mkph.toPay') : t('mkph.myToPay')}</span>
          <b>{t('mkph.alreadyPaid', { v: da(paid) })}</b>
        </div>
        <b className="pxm-big ltr">{da(total)}</b>
        <div className="pxm-vf">
          <span>{t('mkph.owedSets', { count: owed.length })}</span>
          {d.owner && owed.length > 0 && (
            <button type="button" className="pxm-pay" disabled={pay.isPending} onClick={() => pay.mutate({ ids: owed.map((r) => r.id) })}>
              <Icon name="wallet" /> {t('mkph.payAll')}
            </button>
          )}
        </div>
      </section>
      )}
      {d.fxMissing.length > 0 && <div className="warnbox">{t('mkph.fxMissing', { m: d.fxMissing.join(', ') })}</div>}
      <div className="pxm-kg">
        <K l={t('mkph.k.success')} v={pct(div(judged.filter((r) => r.ok).length, judged.length))} s={t('mkph.k.successSub', { ok: judged.filter((r) => r.ok).length, n: judged.length })} />
        <K l={t('mkph.k.running')} v={n(d.rows.filter((r) => r.marketerId && !r.final).length)} s={t('mkph.k.runningSub')} />
        <K l={t('mkph.k.mkNet')} v={dz(d.rows.filter((r) => r.marketerId).reduce((s, r) => s + r.net, 0))} s="DA" tone={d.rows.filter((r) => r.marketerId).reduce((s, r) => s + r.net, 0) >= 0 ? 'g' : 'r'} />
      </div>
      {people.map((m) => {
        const rs = by.get(m.id) ?? [];
        const ok = rs.filter((r) => r.final && r.ok).length;
        const ko = rs.filter((r) => r.final && !r.ok).length;
        const run = rs.filter((r) => !r.final).length;
        const owe = rs.reduce((s, r) => s + (r.owe && !r.paid ? r.owe : 0), 0);
        return (
          <button key={m.id} type="button" className="pxm-mk" onClick={() => setWho(m.id)}>
            <span className="pxm-avr">{m.name.slice(0, 1).toUpperCase()}</span>
            <span className="pxm-an">
              <b>{m.name}</b>
              <small>{t('mkph.mkLine', { n: rs.length, ok, ko, run })}</small>
              <i className="pxm-bar">
                <u className="g" style={{ width: `${rs.length ? (ok / rs.length) * 100 : 0}%` }} />
                <u className="r" style={{ width: `${rs.length ? (ko / rs.length) * 100 : 0}%` }} />
              </i>
            </span>
            {m.partner ? (
              <span className="pxm-av">
                <span className="chip mkx-chip">{m.partner.name}</span>
              </span>
            ) : (
              <span className="pxm-av">
                <b className={`ltr ${owe ? 'ok' : ''}`}>{da(owe)}</b>
                <small>{t('mkph.toPayShort')}</small>
              </span>
            )}
          </button>
        );
      })}
      {d.owner && none.length > 0 && (
        <button type="button" className="pxm-todo" onClick={() => setWho('none')}>
          <span className="pxm-tic o">
            <Icon name="tag" />
          </span>
          <span className="pxm-tt">
            <b>{t('mkph.noneTitle', { count: none.length })}</b>
            <small>{t('mkph.noneSub')}</small>
          </span>
          <Icon name="chevr" />
        </button>
      )}
      <p className="pxv-help pxm-foot">{t('mkph.rule', { s: pct(d.rules.seuil), m: d.rules.mult })}</p>
      {who !== null && <MkPage d={d} who={who} onClose={() => setWho(null)} />}
    </>
  );
}

function MkPage({ d, who, onClose }: { d: Mk; who: number | 'none'; onClose: () => void }) {
  const { t } = useTranslation();
  useFullScreen(onClose);
  const [f, setF] = useState<'all' | 'pay' | 'run' | 'ko' | 'ok'>('all');
  const pay = useAction('mk.pay', { success: t('mkph.paidOne') });
  const assign = useAction('mk.assign', { success: t('mkph.assigned') });
  const rows = d.rows.filter((r) => (who === 'none' ? !r.marketerId : r.marketerId === who));
  const m = who === 'none' ? null : d.marketers.find((x) => x.id === who);
  const owe = rows.reduce((s, r) => s + (r.owe && !r.paid ? r.owe : 0), 0);
  const count = (k: typeof f) => (k === 'all' ? rows.length : rows.filter((r) => resOf(r) === k || (k === 'ok' && resOf(r) === 'paid')).length);
  const show = rows.filter((r) => f === 'all' || resOf(r) === f || (f === 'ok' && resOf(r) === 'paid'));
  return (
    <div className="pxp-order pxm-page" role="dialog" aria-modal="true">
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>{m ? m.name : t('mkph.noneTitle', { count: rows.length })}</b>
          <small>{m ? t('mkph.adsetsN', { count: rows.length }) + (m.price ? ` · ${t('mkph.price', { v: da(m.price) })}` : '') : t('mkph.noneSub')}</small>
        </div>
        {m && <b className="ok ltr">{da(owe)}</b>}
      </header>
      <div className="pxp-ob pxm-ob">
        {m && (
          <div className="pxv-road">
            {(['all', 'pay', 'run', 'ok', 'ko'] as const).map((k) => (
              <button key={k} type="button" className={f === k ? 'on' : ''} onClick={() => setF(k)}>
                {t(`mkph.f.${k}`)} <b>{count(k)}</b>
              </button>
            ))}
          </div>
        )}
        {show.map((r) => {
          const res = resOf(r);
          const tone = RES_TONE[res];
          const closed = r.n ? (r.n - r.open) / r.n : 0;
          return (
            <section key={r.id} className="pxm-pc static">
              <span className="pxm-pt">
                <b>
                  {r.prod || t('marketer.noProduct', { defaultValue: '—' })} · {r.name}
                </b>
                <span className={`pxm-adv ${tone}`}>{t(`mkph.res.${res}`)}</span>
              </span>
              <span className="pxm-st4">
                <span>
                  <small>{t('mkph.k.spend')}</small>
                  <b className="ltr">{usd(r.sp, 0)}</b>
                </span>
                <span>
                  <small>{t('mkph.k.delivered')}</small>
                  <b className="ltr">
                    {n(r.d)} / {n(r.n)}
                  </b>
                </span>
                <span>
                  <small>{t('mkph.share')}</small>
                  <b className={`ltr ${r.ratio !== null && r.ratio < 0 ? 'bad' : ''}`}>{pct(r.ratio)}</b>
                </span>
                <span>
                  <small>{t('mkph.net')}</small>
                  <b className={`ltr ${r.net >= 0 ? 'ok' : 'bad'}`}>{sgn(r.net)}</b>
                </span>
              </span>
              <small className="pxm-why">
                {res === 'run' ? (r.unlinked ? t('mkph.why.unlinked') : !r.stopped ? t('mkph.why.active') : t('mkph.why.open', { n: r.open })) : res === 'ko' ? t('mkph.why.ko', { s: pct(r.ratio) }) : res === 'paid' ? t('mkph.why.paid', { v: da(r.paid?.amount ?? 0) }) : t('mkph.why.ok', { s: pct(r.ratio) })}
              </small>
              <i className="pxm-bar">
                <u className={tone} style={{ width: `${res === 'run' ? closed * 100 : 100}%` }} />
              </i>
              {d.owner && res === 'pay' && (
                <span className="pxm-row">
                  <b className="ok ltr">{t('mkph.oweV', { v: da(r.owe ?? 0) })}</b>
                  <button type="button" className="pxm-pay nv" disabled={pay.isPending} onClick={() => pay.mutate({ ids: [r.id] })}>
                    <Icon name="check" /> {t('mkph.markPaid')}
                  </button>
                </span>
              )}
              {d.owner && who === 'none' && (
                <select className="pxm-sel" value="" aria-label={t('marketer.choose')} onChange={(e) => e.target.value && assign.mutate({ ids: [r.id], marketerId: Number(e.target.value) })}>
                  <option value="">{t('mkph.giveTo')}</option>
                  {d.marketers.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
            </section>
          );
        })}
        {!show.length && <p className="pxv-help">—</p>}
      </div>
    </div>
  );
}
