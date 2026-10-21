// Livreurs dashboard ("Nos livreurs"): own couriers or delivery companies, parcels and cash.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, pct } from '../../lib/format';
import type { Out } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { ErrorBox, Kpis, Loading } from '../../ui/kit';
import { AnyPeriod, Badge, delivTone, inputsOf, KpiBox, rangeOf, useStored } from './util';

type Row = Out<'stats.livreurs'>['rows'][number];

export function LivreursTable({ rows, simple }: { rows: Row[]; simple?: boolean }) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="muted">{t('dashboard.liv.empty')}</p>;
  if (simple)
    return (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('home.liv.col.livreur')}</th>
              <th className="num">{t('home.liv.col.inRound')}</th>
              <th className="num">{t('home.liv.col.delivered')}</th>
              <th className="num">{t('home.liv.col.returns')}</th>
              <th className="num">{t('home.liv.col.rate')}</th>
              <th className="num">{t('home.liv.col.uncashed')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-l={t('home.liv.col.livreur')}>{r.name}</td>
                <td className="num ltr" data-l={t('home.liv.col.inRound')}>{n(r.inHand)}</td>
                <td className="num ltr" data-l={t('home.liv.col.delivered')}>{n(r.delivered)}</td>
                <td className="num ltr" data-l={t('home.liv.col.returns')}>{n(r.returned)}</td>
                <td className="num" data-l={t('home.liv.col.rate')}>
                  <Badge tone={delivTone(r.deliveryRate)}>{pct(r.deliveryRate)}</Badge>
                </td>
                <td className="num ltr" data-l={t('home.liv.col.uncashed')}>{da(r.uncashed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const cols = ['livreur', 'shipped', 'pickup', 'delivered', 'rate', 'inHand', 'late', 'toBring', 'uncashedCount', 'uncashed', 'net'] as const;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={c} className={i ? 'num' : undefined}>
                {t(`dashboard.liv.col.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-l={t('dashboard.liv.col.livreur')}>{r.name}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.shipped')}>{n(r.shipped)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.pickup')}>{n(r.pickup)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.delivered')}>{n(r.delivered)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.rate')}>{pct(r.deliveryRate)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.inHand')}>{n(r.inHand)}</td>
              <td className="num" data-l={t('dashboard.liv.col.late')}>{r.late ? <Badge tone="bad">{r.late}</Badge> : <span className="ltr">0</span>}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.toBring')}>{n(r.toBring)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.uncashedCount')}>{n(r.uncashedCount)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.uncashed')}>{da(r.uncashed)}</td>
              <td className="num ltr" data-l={t('dashboard.liv.col.net')}>{da(r.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LIV_PERIODS: AnyPeriod[] = ['today', 'yesterday', 'week', 'lastweek', 'month', 'lastmonth', 'custom'];

export function LivreursArea() {
  const { t } = useTranslation();
  const [by, setBy] = useStored<'livreur' | 'company'>('dash.liv.by', 'livreur');
  const [period, setPeriod] = useStored<AnyPeriod>('dash.liv.period', 'month');
  const [dateType, setDateType] = useStored<'delivered' | 'created'>('dash.liv.dtype', 'delivered');
  const [who, setWho] = useState<number | 0>(0);
  const [custom, setCustom] = useState(() => inputsOf(rangeOf('month')));
  const range = rangeOf(period, custom);
  const dates = period === 'custom' ? custom : inputsOf(range);
  const q = useRpc('stats.dashLivreurs', { ...range, by, dateType, livreurId: who || undefined });
  const d = q.data;
  const title = by === 'company' ? t('dashboard.liv.companies') : t('dashboard.liv.ours');
  const stamp = q.dataUpdatedAt ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Algiers' }).format(q.dataUpdatedAt) : '';
  const setDate = (k: 'from' | 'to', v: string) => {
    if (!v) return;
    setCustom({ ...dates, [k]: v });
    setPeriod('custom');
  };
  return (
    <div className="bjliv">
      <section className="card bjlv-bar">
        <div className="card-head">
          <h2>{title}</h2>
        </div>
        <div className="bjlv-ctrl">
          <label className="field">
            <span className="lab">{t('dashboard.liv.see')}</span>
            <select value={by} onChange={(e) => (setBy(e.target.value as 'livreur' | 'company'), setWho(0))}>
              <option value="livreur">{t('dashboard.liv.livreurs')}</option>
              <option value="company">{t('dashboard.liv.companiesOpt')}</option>
            </select>
          </label>
          <label className="field">
            <span className="lab">{by === 'company' ? t('dashboard.liv.company') : t('dashboard.liv.livreur')}</span>
            <select value={who} onChange={(e) => setWho(Number(e.target.value))}>
              <option value={0}>{title}</option>
              {d?.all.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('dashboard.period')}</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value as AnyPeriod)}>
              {LIV_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`dashboard.periods.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('dashboard.liv.by')}</span>
            <select value={dateType} onChange={(e) => setDateType(e.target.value as 'delivered' | 'created')}>
              <option value="delivered">{t('dashboard.liv.byDelivered')}</option>
              <option value="created">{t('dashboard.liv.byCreated')}</option>
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('dashboard.from')}</span>
            <input type="date" value={dates.from} onChange={(e) => setDate('from', e.target.value)} />
          </label>
          <label className="field">
            <span className="lab">{t('dashboard.to')}</span>
            <input type="date" value={dates.to} onChange={(e) => setDate('to', e.target.value)} />
          </label>
        </div>
        <div className="bjlv-sub">
          <span className="stamp muted small">{t('dashboard.liv.stamp', { t: stamp })}</span>
          <a className="btn small ghost" href={by === 'company' ? '#/livraison/societes' : '#/livraison/livreurs'}>
            {by === 'company' ? t('dashboard.liv.listCompanies') : t('dashboard.liv.list')}
          </a>
        </div>
      </section>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        d && (
          <section className="card">
            <div className="card-head">
              <h2>
                {title}
                {d.hidden > 0 && !who && <span className="count">· {t('dashboard.liv.hidden', { n: d.hidden })}</span>}
              </h2>
            </div>
            <Kpis>
              <KpiBox label={t('dashboard.liv.k.shipped')} value={n(d.totals.shipped)} sub={t('dashboard.liv.k.onPeriod')} />
              <KpiBox label={t('dashboard.liv.k.pickup')} value={`${n(d.totals.pickup)} (${n(d.totals.pickupOld)})`} sub={t('dashboard.liv.k.pickupSub', { v: da(d.totals.pickupValue) })} />
              <KpiBox label={t('dashboard.liv.k.inHand')} value={n(d.totals.inHand)} sub={t('dashboard.liv.k.inHandSub', { v: da(d.totals.inHandValue), n: d.totals.late })} tone={d.totals.late ? 'warn' : undefined} />
              <KpiBox label={t('dashboard.liv.k.delivered')} value={n(d.totals.delivered)} sub={t('dashboard.liv.k.returns', { n: d.totals.returned })} />
              <KpiBox label={t('dashboard.liv.k.rate')} value={pct(d.totals.deliveryRate)} sub={t('dashboard.liv.k.rateSub')} tone={delivTone(d.totals.deliveryRate)} />
              <KpiBox label={t('dashboard.liv.k.uncashed')} value={da(d.totals.uncashed)} sub={t('dashboard.liv.k.uncashedSub', { n: d.totals.uncashedCount })} tone="warn" zero={!d.totals.uncashed} />
              <KpiBox label={t('dashboard.liv.k.net')} value={da(d.totals.net)} sub={t('dashboard.liv.k.netSub', { v: da(d.totals.heldShare) })} tone="ok" />
              <KpiBox
                label={by === 'company' ? t('dashboard.liv.k.fees') : t('dashboard.liv.k.share')}
                value={da(d.totals.share)}
                sub={by === 'company' ? t('dashboard.liv.k.feesSub', { n: d.totals.delivered }) : t('dashboard.liv.k.shareSub', { n: d.totals.delivered, light: da(d.pay.light), heavy: da(d.pay.heavy) })}
              />
              <KpiBox label={t('dashboard.liv.k.cashed')} value={da(d.totals.cashed)} sub={t('dashboard.liv.k.cashedSub', { n: d.totals.cashedCount })} />
            </Kpis>
            <LivreursTable rows={who ? d.all : d.rows} />
          </section>
        )
      )}
    </div>
  );
}
