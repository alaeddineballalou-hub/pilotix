// Publicité (marketer): Meta spend against the shop's real orders. Everything is computed in core (ads.*);
// this page only shows it, with the original layout (#ads: header controls, KPIs, products, ad sets, days, months).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PageProps } from '../registry';
import { da, n, pct, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { Empty, ErrorBox, Help, Loading, StageBar } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { Marketer } from './Marketer';
import { PhoneMarketing } from './PhoneAds';
import { Spy } from './Spy';
import { useIsPhone } from '../../lib/useMedia';
import './ads.css';

/** Marketing: Publicité (Meta spend face to the real orders), Marketer (paying marketers per ad set) and AI Spy
 *  (competitors' Facebook ads in Algeria, Spy.tsx). */
export function Marketing({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  // phones: every KPI to decide (won / lost, where the money goes, what to do), then products and ad sets
  const phone = useIsPhone();
  if (phone) return <PhoneMarketing sub={sub} rest={rest} />;
  return <MarketingDesktop sub={sub} rest={rest} t={t} />;
}

function MarketingDesktop({ sub, rest, t }: { sub?: string; rest?: string[]; t: (k: string) => string }) {
  const cur = sub === 'marketer' ? 'marketer' : sub === 'spy' ? 'spy' : 'publicite';
  return (
    <>
      <StageBar flow={false} current={cur} items={(['publicite', 'marketer', 'spy'] as const).map((k) => ({ key: k, label: t(`nav.${k}`), href: `#/marketing/${k}` }))} />
      {cur === 'marketer' ? <Marketer rest={rest} /> : cur === 'spy' ? <Spy rest={rest} /> : <Publicite />}
    </>
  );
}

type PeriodKey = 'today' | 'yesterday' | 'thisweek' | 'lastweek' | 'month' | 'lastmonth' | 'custom';
const PERIODS: PeriodKey[] = ['today', 'yesterday', 'thisweek', 'lastweek', 'month', 'lastmonth', 'custom'];

/** Day in Algiers (UTC+1) as YYYY-MM-DD, k days from today. */
const algDay = (k = 0) => new Date(Date.now() + 3_600_000 + k * 86_400_000).toISOString().slice(0, 10);
function rangeOf(p: PeriodKey): { from: string; to: string } {
  const today = algDay();
  const d = new Date(today + 'T00:00:00Z');
  const sinceSat = (d.getUTCDay() + 1) % 7; // weeks start on Saturday in Algeria
  const first = today.slice(0, 8) + '01';
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: algDay(-1), to: algDay(-1) };
    case 'thisweek':
      return { from: algDay(-sinceSat), to: today };
    case 'lastweek':
      return { from: algDay(-sinceSat - 7), to: algDay(-sinceSat - 1) };
    case 'lastmonth': {
      const end = new Date(Date.parse(first + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
      return { from: end.slice(0, 8) + '01', to: end };
    }
    default:
      return { from: first, to: today };
  }
}
const usd = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : `${v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);
const dz = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : da(Math.round(v)));
const monthLabel = (ym: string, lang: string) => new Date(ym + '-15T00:00:00Z').toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang, { month: 'long', year: 'numeric' });
const dayLabel = (d: string, lang: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang, { weekday: 'short', day: 'numeric', month: 'short' });

export function Publicite(_: Partial<PageProps> = {}) {
  const { t, i18n } = useTranslation();
  const { has } = useSession();
  const owner = has('vendeur');
  const [period, setPeriod] = useState<PeriodKey>(() => {
    const s = store.get('ads-period') as PeriodKey | null;
    return s && PERIODS.includes(s) && s !== 'custom' ? s : 'month';
  });
  const [range, setRange] = useState(() => rangeOf(period));
  const [productId, setProductId] = useState<number | null>(null);
  const [marketerId, setMarketerId] = useState<number | null>(null);
  const [pick, setPick] = useState<{ id: string; name: string; productIds: number[] } | null>(null);
  const [adset, setAdset] = useState<{ id: string; name: string } | null>(null);
  const input = { from: range.from, to: range.to, productId, marketerId };
  const q = useRpc('ads.overview', input);
  const sync = useAction('ads.sync', { success: t('ads.refreshed') });

  const choosePeriod = (p: PeriodKey) => {
    setPeriod(p);
    if (p !== 'custom') {
      store.set('ads-period', p);
      setRange(rangeOf(p));
    }
  };
  const d = q.data;
  const fxOk = !!d?.fx.rate && !d.fx.missing;

  return (
    <div id="ads" className="view">
      <section className="card ad-head">
        <div className="ad-head-top">
          <div className="ad-title">
            <h2>{t('ads.title')}</h2>
            {d?.lastSync && <span className="note">{t('ads.stamp', { when: when(d.lastSync) })}</span>}
          </div>
          <span className="ad-live" title={d?.demo ? t('ads.demoTip') : t('ads.liveTip')}>
            {d?.demo ? t('ads.demo') : t('ads.live')}
          </span>
        </div>
        <div className="ad-ctrl">
          <label className="field">
            <span className="lab">{t('ads.period')}</span>
            <select value={period} onChange={(e) => choosePeriod(e.target.value as PeriodKey)}>
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`ads.periods.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('ads.from')}</span>
            <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && (setPeriod('custom'), setRange({ ...range, from: e.target.value }))} />
          </label>
          <label className="field">
            <span className="lab">{t('ads.to')}</span>
            <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && (setPeriod('custom'), setRange({ ...range, to: e.target.value }))} />
          </label>
          <FxField ym={range.to.slice(0, 7)} rate={d?.fx.rate ?? null} />
          <label className="field ad-fprod">
            <span className="lab">{t('ads.product')}</span>
            <select value={productId ?? ''} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('ads.allProducts')}</option>
              {d?.catalog.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {d && !d.demo && (
            <button className="btn primary ad-refresh" type="button" disabled={sync.isPending} onClick={() => sync.mutate({ from: range.from, to: range.to })}>
              {t('ads.refresh')}
            </button>
          )}
        </div>
        {owner && !!d?.marketers.length && (
          <label className="field" style={{ maxWidth: 320 }}>
            <span className="lab">{t('ads.marketer')}</span>
            <select value={marketerId ?? ''} onChange={(e) => setMarketerId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('ads.allMarketers')}</option>
              {d.marketers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {q.isLoading && !d ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          {!d.connected && !d.demo && <div className="warnbox">{t('ads.notConnected')}</div>}
          {d.syncWarning && <div className="error">{d.syncWarning}</div>}
          {!fxOk && <div className="fxcard warnbox">{t('ads.fxMissing')}</div>}
          {productId && (
            <button className="back" type="button" onClick={() => setProductId(null)}>
              {t('ads.back')}
            </button>
          )}
          <section className="card">
            <div className="card-head">
              <h2>
                {productId ? d.catalog.find((p) => p.id === productId)?.name : t('ads.products')}
                {!productId && <span className="count">{d.products.length}</span>}
              </h2>
              {!productId && <span className="note">{t('ads.productsClick')}</span>}
            </div>
            <Kpis d={d} fxOk={fxOk} />
            <Diagnostics adsets={d.adsets} />
            {productId ? (
              <ProfitLines d={d} owner={owner && !marketerId} />
            ) : !d.products.length ? (
              <Empty>{t('ads.noProducts')}</Empty>
            ) : (
              <>
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('ads.colProduct')}</th>
                        <th className="num">{t('ads.colSpend')}</th>
                        <th className="num">{t('ads.colOrders')}</th>
                        <th className="num">{t('ads.colDelivered')}</th>
                        <th className="num">{t('ads.colRate')}</th>
                        <th className="num">{t('ads.colCpo')}</th>
                        <th className="num">{t('ads.colCpd')}</th>
                        <th className="num">{t('ads.colProfit')}</th>
                        <th>{t('ads.colAdvice')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.products.map((p) => (
                        <tr key={p.productId} className="ov-row" tabIndex={0} onClick={() => setProductId(p.productId)} onKeyDown={(e) => e.key === 'Enter' && setProductId(p.productId)}>
                          <td data-l={t('ads.colProduct')}>{p.name}</td>
                          <td className="num" data-l={t('ads.colSpend')}>
                            {usd(p.spendUsd)}
                          </td>
                          <td className="num" data-l={t('ads.colOrders')}>
                            {n(p.money.n)}
                          </td>
                          <td className="num" data-l={t('ads.colDelivered')}>
                            {n(p.money.d)}
                          </td>
                          <td className="num" data-l={t('ads.colRate')}>
                            {pct(p.money.n ? p.money.d / p.money.n : null)}
                          </td>
                          <td className="num" data-l={t('ads.colCpo')}>
                            {fxOk ? dz(p.money.n ? p.money.pub / p.money.n : null) : '—'}
                          </td>
                          <td className="num" data-l={t('ads.colCpd')}>
                            {fxOk ? dz(p.money.d ? p.money.pub / p.money.d : null) : '—'}
                          </td>
                          <td className={`num ${p.money.net < 0 ? 'neg' : ''}`} data-l={t('ads.colProfit')}>
                            {fxOk ? dz(p.money.net) : '—'}
                          </td>
                          <td data-l={t('ads.colAdvice')}>
                            <span className={`badge t-${p.advice.tone}`} title={t(`ads.adviceLong.${p.advice.k}`)}>
                              {t(`ads.advice.${p.advice.k}`)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="note">{t('ads.productsNote')}</p>
              </>
            )}
          </section>

          <AdsetsCard d={d} owner={owner} onPick={setPick} onOpen={setAdset} />
          <DaysCard d={d} lang={i18n.language} />
          <MonthsCard to={range.to} marketerId={marketerId} owner={owner} lang={i18n.language} onOpen={(ym) => {
            setPeriod('custom');
            const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
            setRange({ from: `${ym}-01`, to: last });
          }} who={owner && !marketerId ? t('ads.monthsWho') : t('ads.monthsMine')} />
          {pick && <PickProduct adset={pick} catalog={d.catalog} onClose={() => setPick(null)} />}
          {adset && <AdsetDetail adset={adset} from={range.from} to={range.to} lang={i18n.language} onClose={() => setAdset(null)} />}
        </>
      ) : null}
    </div>
  );
}

function FxField({ ym, rate }: { ym: string; rate: number | null }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const [v, setV] = useState(rate ? String(rate) : '');
  useEffect(() => setV(rate ? String(rate) : ''), [rate, ym]);
  const save = useAction('ads.setFx', { success: t('ads.fxSaved') });
  const changed = v !== (rate ? String(rate) : '') && Number(v) >= 1;
  // only the owner sets the rate (it decides the marketers' pay); a marketer sees it
  if (!has('vendeur'))
    return (
      <label className="field">
        <span className="lab">{t('ads.fx', { month: ym })}</span>
        <span className="fxrow">{rate ? `${rate} DA` : t('ads.fxOwnerOnly')}</span>
      </label>
    );
  return (
    <label className="field">
      <span className="lab">{t('ads.fx', { month: ym })}</span>
      <span className="fxrow">
        <input type="number" inputMode="decimal" min={1} step={0.5} placeholder="ex. 250" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && changed && save.mutate({ ym, rate: Number(v) })} />
        {changed && (
          <button type="button" className="btn small" onClick={() => save.mutate({ ym, rate: Number(v) })}>
            {t('ads.fxSave')}
          </button>
        )}
      </span>
    </label>
  );
}

type Overview = NonNullable<ReturnType<typeof useRpc<'ads.overview'>>['data']>;

function Kpis({ d, fxOk }: { d: Overview; fxOk: boolean }) {
  const { t } = useTranslation();
  const m = d.totals;
  const K = ({ l, v, s, cls = '' }: { l: string; v: string; s?: string; cls?: string }) => (
    <div className={`kpi ${cls}`}>
      <span className="lab">{l}</span>
      <span className="val ltr">{v}</span>
      <span className="sub">{s || ' '}</span>
    </div>
  );
  const noFx = t('ads.kpi.noFx');
  return (
    <div className="kpis" aria-label={t('ads.title')}>
      <K l={t('ads.kpi.spend')} v={usd(m.spendUsd)} s={fxOk ? dz(m.pub) : noFx} />
      <K l={t('ads.kpi.orders')} v={n(m.n)} s={m.enRoute ? t('ads.kpi.ordersSub', { n: m.enRoute }) : ''} />
      <K l={t('ads.kpi.delivered')} v={n(m.d)} s={t('ads.kpi.deliveredSub', { rate: pct(m.n ? m.d / m.n : null) })} />
      <K l={t('ads.kpi.cpo')} v={fxOk ? dz(m.n ? m.pub / m.n : null) : '—'} />
      <K l={t('ads.kpi.cpd')} v={fxOk ? dz(m.d ? m.pub / m.d : null) : '—'} cls="warn" />
      <K l={t('ads.kpi.scale')} v={n(m.toScale)} s={t('ads.kpi.scaleSub')} />
      <K l={t('ads.kpi.net')} v={fxOk ? dz(m.net) : '—'} s={fxOk ? (m.d ? t('ads.kpi.netSub', { per: dz(m.net / m.d) }) : '') : noFx} cls={`net wide ${m.net < 0 ? 'loss' : ''}`} />
    </div>
  );
}

function Diagnostics({ adsets }: { adsets: Overview['adsets'] }) {
  const { t } = useTranslation();
  const act = adsets.filter((a) => !['ok', 'wait'].includes(a.diag.k));
  const bad = act.some((a) => a.diag.tone === 'bad');
  return (
    <details className={`fixcard ${bad ? 'bad' : act.length ? '' : 'good'}`} open={act.length > 0}>
      <summary>
        <span className="fx-t">{t('ads.diagTitle')}</span>
        <span className="fx-s">{act.length ? act.map((a) => t(`ads.diag.${a.diag.k}`)).filter((x, i, l) => l.indexOf(x) === i).join(' · ') : t('ads.diagNone')}</span>
      </summary>
      <div className="fx-body">
        {act.length > 0 && (
          <ul className="diag-list">
            {act.map((a) => (
              <li key={a.id}>
                <span className={`badge t-${a.diag.tone}`}>{t(`ads.diag.${a.diag.k}`)}</span> <b>{a.name}</b> — {t(`ads.diagDo.${a.diag.k}`)}
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary className="small">{t('ads.diagRules')}</summary>
          <ul className="small muted">
            {(t('ads.diagRulesText', { returnObjects: true }) as string[]).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      </div>
    </details>
  );
}

function ProfitLines({ d, owner }: { d: Overview; owner: boolean }) {
  const { t } = useTranslation();
  const m = d.totals;
  const per = (v: number) => (m.d ? t('ads.plRows.perDelivered', { v: dz(v / m.d) }) : '');
  const rows: [string, string, number, string?][] = [
    [t('ads.plRows.rev', { d: m.d }), '', m.rev],
    [t('ads.plRows.achat', { qty: m.qty }), '', -m.achat],
    [t('ads.plRows.liv', { d: m.d }), '', -m.liv],
    [t('ads.plRows.conf', { d: m.d }), '', -m.conf],
    [t('ads.plRows.ret', { r: m.r }), '', -m.ret],
    [t('ads.plRows.avant'), per(m.avant), m.avant, 'sub'],
    [t('ads.plRows.pub'), t('ads.plRows.pubDetail', { usd: usd(m.spendUsd) }), -m.pub],
    [t('ads.plRows.net'), per(m.net), m.net, 'tot'],
  ];
  return (
    <section className="card" id="ad-pl">
      <div className="card-head">
        <h2>{t('ads.pl')}</h2>
        <span className="note">{t('ads.plNote')}</span>
      </div>
      <div className="tbl-wrap">
        <table className="pl">
          <tbody>
            {rows.map(([l, s, v, cls]) => (
              <tr key={l} className={cls}>
                <td>
                  {l}
                  {s && <small className="muted"> · {s}</small>}
                </td>
                <td className="num ltr">{v < 0 ? `− ${dz(-v)}` : `+ ${dz(v)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        {t('ads.plFoot', { from: d.from, to: d.to, n: m.n, enRoute: m.enRoute })} {!owner && t('ads.plShare')}
      </p>
    </section>
  );
}

function AdsetsCard({ d, owner, onPick, onOpen }: { d: Overview; owner: boolean; onPick: (a: { id: string; name: string; productIds: number[] }) => void; onOpen: (a: { id: string; name: string }) => void }) {
  const { t } = useTranslation();
  const setOwner = useAction('ads.setMarketer', { success: t('ads.ownerSaved') });
  const P = useMemo(() => new Map(d.catalog.map((p) => [p.id, p.name])), [d.catalog]);
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {owner ? t('ads.adsets') : t('ads.adsetsMine')}
          <span className="count">{d.adsets.length}</span>
          <Help text={(t('ads.diagRulesText', { returnObjects: true }) as string[]).join(' ')} />
        </h2>
      </div>
      {!d.adsets.length ? (
        <Empty>{t('ads.noAdsets')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('ads.colAdset')}</th>
                <th>{t('ads.colStatus')}</th>
                <th className="num">{t('ads.colSpend')}</th>
                <th className="num">{t('ads.colPurchases')}</th>
                <th className="num">{t('ads.colCpa')}</th>
                <th className="num">{t('ads.colCtr')}</th>
                <th className="num">{t('ads.colCpm')}</th>
                <th>{t('ads.colDiag')}</th>
                <th>{t('ads.colLinked')}</th>
                {owner && <th>{t('ads.colOwner')}</th>}
              </tr>
            </thead>
            <tbody>
              {d.adsets.map((a) => (
                <tr key={a.id} className="ov-row" onClick={() => onOpen({ id: a.id, name: a.name })}>
                  <td data-l={t('ads.colAdset')}>
                    {a.name}
                    <small className="muted ltr" style={{ display: 'block' }}>
                      {a.campaign ? `${a.campaign} · ` : ''}
                      {a.id}
                    </small>
                  </td>
                  <td data-l={t('ads.colStatus')}>
                    <span className={`badge t-${a.status === 'ACTIVE' ? 'ok' : 'off'}`}>{a.status ?? '—'}</span>
                  </td>
                  <td className="num" data-l={t('ads.colSpend')}>
                    {usd(a.spendUsd)}
                  </td>
                  <td className="num" data-l={t('ads.colPurchases')}>
                    {n(a.purchases)}
                  </td>
                  <td className="num" data-l={t('ads.colCpa')}>
                    {usd(a.cpa)}
                  </td>
                  <td className="num" data-l={t('ads.colCtr')}>
                    {pct(a.ctr, 2)}
                  </td>
                  <td className="num" data-l={t('ads.colCpm')}>
                    {usd(a.cpm)}
                  </td>
                  <td data-l={t('ads.colDiag')}>
                    <span className={`badge t-${a.diag.tone}`} title={t(`ads.diagDo.${a.diag.k}`)}>
                      {t(`ads.diag.${a.diag.k}`)}
                    </span>
                  </td>
                  <td data-l={t('ads.colLinked')} onClick={(e) => e.stopPropagation()}>
                    {a.productIds.map((p) => (
                      <span key={p} className="chip cp">
                        {P.get(p) ?? `#${p}`}
                      </span>
                    ))}{' '}
                    <button type="button" className="btn-mini" onClick={() => onPick({ id: a.id, name: a.name, productIds: a.productIds })}>
                      {t('ads.pick')}
                    </button>
                  </td>
                  {owner && (
                    <td data-l={t('ads.colOwner')} onClick={(e) => e.stopPropagation()}>
                      <select value={a.marketerId ?? ''} aria-label={t('ads.colOwner')} onChange={(e) => setOwner.mutate({ adsetId: a.id, marketerId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">{t('ads.noOwner')}</option>
                        {d.marketers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DaysCard({ d, lang }: { d: Overview; lang: string }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...d.days.map((x) => x.spendUsd));
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('ads.days')}</h2>
        <span className="note">{t('ads.daysNote')}</span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('ads.colDay')}</th>
              <th className="num">{t('ads.colSpend')}</th>
              <th />
              <th className="num">{t('ads.colImp')}</th>
              <th className="num">{t('ads.colClicks')}</th>
              <th className="num">{t('ads.colPurchases')}</th>
              <th className="num">{t('ads.colOrders')}</th>
              <th className="num">{t('ads.colCpo')}</th>
            </tr>
          </thead>
          <tbody>
            {[...d.days].reverse().map((x) => (
              <tr key={x.day}>
                <td data-l={t('ads.colDay')}>{dayLabel(x.day, lang)}</td>
                <td className="num" data-l={t('ads.colSpend')}>
                  {usd(x.spendUsd)}
                </td>
                <td style={{ width: '22%' }} aria-hidden="true">
                  <span className="ad-bar" style={{ width: `${(x.spendUsd / max) * 100}%` }} />
                </td>
                <td className="num" data-l={t('ads.colImp')}>
                  {n(x.impressions)}
                </td>
                <td className="num" data-l={t('ads.colClicks')}>
                  {n(x.clicks)}
                </td>
                <td className="num" data-l={t('ads.colPurchases')}>
                  {n(x.purchases)}
                </td>
                <td className="num" data-l={t('ads.colOrders')}>
                  {n(x.orders)}
                </td>
                <td className="num" data-l={t('ads.colCpo')}>
                  {x.spendDzd !== null && x.orders ? dz(x.spendDzd / x.orders) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MonthsCard({ to, marketerId, owner, who, lang, onOpen }: { to: string; marketerId: number | null; owner: boolean; who: string; lang: string; onOpen: (ym: string) => void }) {
  const { t } = useTranslation();
  const q = useRpc('ads.months', { to, marketerId });
  const close = useAction('ads.closeMonth', { success: (r) => (r ? t('ads.closedOk') : '') });
  const reopen = useAction('ads.closeMonth', { success: t('ads.reopened') });
  const nowYm = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {t('ads.months')} · <span>{who}</span>
        </h2>
        <span className="note">{t('ads.monthsNote')}</span>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('ads.colMonth')}</th>
                <th className="num">{t('ads.colSpend')}</th>
                <th className="num">{t('ads.colMetaCpa')}</th>
                <th className="num">{t('ads.colOrders')}</th>
                <th className="num">{t('ads.colDelivered')}</th>
                <th className="num">{t('ads.colRate')}</th>
                <th className="num">{t('ads.colCpo')}</th>
                <th className="num">{t('ads.colCpd')}</th>
                <th className="num">{t('ads.colProfit')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.map((m: any) => (
                <tr key={m.ym} className="ov-row" onClick={() => onOpen(m.ym)}>
                  <td data-l={t('ads.colMonth')}>{monthLabel(m.ym, lang)}</td>
                  <td className="num" data-l={t('ads.colSpend')}>
                    {usd(m.spendUsd)}
                  </td>
                  <td className="num" data-l={t('ads.colMetaCpa')}>
                    {usd(m.metaCpa)}
                  </td>
                  <td className="num" data-l={t('ads.colOrders')}>
                    {n(m.orders)}
                  </td>
                  <td className="num" data-l={t('ads.colDelivered')}>
                    {n(m.delivered)}
                  </td>
                  <td className="num" data-l={t('ads.colRate')}>
                    {pct(m.rate)}
                  </td>
                  <td className="num" data-l={t('ads.colCpo')}>
                    {dz(m.cpo)}
                  </td>
                  <td className="num" data-l={t('ads.colCpd')}>
                    {dz(m.cpd)}
                  </td>
                  <td className={`num ${m.profit < 0 ? 'neg' : ''}`} data-l={t('ads.colProfit')}>
                    {dz(m.profit)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {m.closed ? (
                      <span className="row nowrap" style={{ gap: 6 }}>
                        <span className="badge t-off">{t('ads.closed')}</span>
                        {owner && (
                          <button type="button" className="btn-ghost" onClick={() => reopen.mutate({ ym: m.ym, close: false, marketerId })}>
                            {t('ads.reopen')}
                          </button>
                        )}
                      </span>
                    ) : m.ym < nowYm ? (
                      <button type="button" className="btn-mini" onClick={() => close.mutate({ ym: m.ym, close: true, marketerId })}>
                        {t('ads.close')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PickProduct({ adset, catalog, onClose }: { adset: { id: string; name: string; productIds: number[] }; catalog: { id: number; name: string; sku: string; active: boolean }[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number[]>(adset.productIds);
  const save = useAction('ads.link', { success: t('ads.pickSaved'), onDone: onClose });
  const s = q.trim().toLowerCase();
  const list = catalog.filter((p) => !s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || String(p.id) === s);
  return (
    <Modal
      title={t('ads.pickTitle')}
      onClose={onClose}
      footer={
        <>
          {adset.productIds.length > 0 && (
            <button className="btn ghost" onClick={() => save.mutate({ adsetId: adset.id, productIds: [] })}>
              {t('ads.pickReset')}
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending || !sel.length} onClick={() => save.mutate({ adsetId: adset.id, productIds: sel })}>
            {t('ads.pickSave')}
          </button>
        </>
      }
    >
      <div className="adpick-who">
        <b>{adset.name}</b> <span className="muted ltr">{adset.id}</span>
      </div>
      <input type="search" placeholder={t('ads.pickSearch')} value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '8px 0' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {list.map((p) => (
          <label key={p.id} className="row nowrap" style={{ gap: 8 }}>
            <input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />
            <span className="grow">{p.name}</span>
            <small className="muted ltr">{p.sku}</small>
          </label>
        ))}
      </div>
      <p className="muted small">{t('ads.pickNote')}</p>
    </Modal>
  );
}

function AdsetDetail({ adset, from, to, lang, onClose }: { adset: { id: string; name: string }; from: string; to: string; lang: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('ads.adset', { id: adset.id, from, to });
  const max = Math.max(1, ...(q.data?.days.map((x) => x.spendUsd) ?? [1]));
  return (
    <Modal
      wide
      title={adset.name}
      onClose={onClose}
      footer={
        <>
          <a className="btn" href={`https://adsmanager.facebook.com/adsmanager/manage/adsets?selected_adset_ids=${encodeURIComponent(adset.id)}`} target="_blank" rel="noopener noreferrer">
            {t('ads.adsManager')}
          </a>
          <button className="btn primary" onClick={onClose}>
            {t('ads.detailClose')}
          </button>
        </>
      }
    >
      <div id="ads">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <h3>{t('ads.days')}</h3>
            <div className="ad-spark" aria-label={t('ads.days')}>
              {q.data!.days.map((x) => (
                <span key={x.day} title={`${dayLabel(x.day, lang)} · ${usd(x.spendUsd)} · ${x.purchases} ${t('ads.colPurchases')}`} style={{ height: `${Math.max(4, (x.spendUsd / max) * 100)}%` }} />
              ))}
            </div>
            <h3>
              {t('ads.adsTitle')} <span className="count">{q.data!.ads.length}</span>
            </h3>
            <p className="note">{t('ads.adsNote')}</p>
            {!q.data!.ads.length ? (
              <Empty>{t('ads.noAds')}</Empty>
            ) : (
              <div className="tbl-wrap">
                <table className="sv-ads">
                  <thead>
                    <tr>
                      <th>{t('ads.colAd')}</th>
                      <th className="num">{t('ads.colSpend')}</th>
                      <th className="num">{t('ads.colPurchases')}</th>
                      <th className="num">{t('ads.colCpa')}</th>
                      <th className="num">{t('ads.col7d')}</th>
                      <th className="num">{t('ads.colHook')}</th>
                      <th className="num">{t('ads.colHold')}</th>
                      <th className="num">{t('ads.colCtr')}</th>
                      <th>{t('ads.colAdvice')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data!.ads.map((a) => (
                      <tr key={a.id}>
                        <td data-l={t('ads.colAd')}>{a.name}</td>
                        <td className="num">{usd(a.spendUsd)}</td>
                        <td className="num">{n(a.purchases)}</td>
                        <td className="num">{usd(a.cpa)}</td>
                        <td className="num">{usd(a.cpa7)}</td>
                        <td className="num">{pct(a.hook)}</td>
                        <td className="num">{pct(a.hold)}</td>
                        <td className="num">{pct(a.ctr, 2)}</td>
                        <td>
                          <span className={`badge t-${a.advice.tone}`}>{t(`ads.adAdvice.${a.advice.k}`)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
