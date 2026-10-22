// SAV › Statistiques: tickets counted on their own (never mixed with orders): tickets, their parcels and their money.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dur, n, Period, periodRange } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Empty, ErrorBox, Help, Icon, Kpi, Kpis, Loading, PeriodSelect } from '../../ui/kit';
import { FACES, SatBadge } from './PhoneSav';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);

export function SavStats() {
  const { t } = useTranslation();
  const [p, setP] = useState<Period>('30d');
  const q = useRpc('sav.stats', periodRange(p));
  const s = q.data;
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {t('sav.st.title')}
          <Help text={t('sav.st.help')} label={t('sav.st.title')} />
        </h2>
        <PeriodSelect value={p} onChange={(v) => setP(v as Period)} />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !s ? null : (
        <div className="bjfc">
          <Satisfaction s={s.satisfaction} />
          <div className="bjfc-row">
            <span className="bjfc-rl">{t('sav.st.tickets')}</span>
            <Kpis>
              <Kpi label={t('sav.st.created')} value={n(s.tickets.created)} />
              <Kpi label={t('sav.st.delivered')} value={n(s.tickets.delivered)} tone="ok" sub={s.tickets.avgMs ? t('sav.st.avg', { v: dur(s.tickets.avgMs) }) : undefined} />
              <Kpi label={t('sav.st.cancelled')} value={n(s.tickets.cancelled)} tone={s.tickets.cancelled ? 'bad' : undefined} />
              <Kpi label={t('sav.st.open')} value={n(s.tickets.open)} tone={s.tickets.open ? 'warn' : undefined} />
            </Kpis>
          </div>
          <div className="bjfc-row">
            <span className="bjfc-rl">{t('sav.st.parcels')}</span>
            <Kpis>
              <Kpi label={t('sav.st.shipped')} value={n(s.parcels.shipped)} sub={t('sav.st.now', { d: n(s.parcels.atDepot), r: n(s.parcels.onRoad) })} />
              <Kpi label={t('sav.st.pDelivered')} value={n(s.parcels.delivered)} tone="ok" sub={s.parcels.free ? t('sav.st.free', { count: s.parcels.free }) : undefined} />
              <Kpi label={t('sav.st.returned')} value={n(s.parcels.returned)} tone={s.parcels.returned ? 'bad' : undefined} />
              <Kpi label={t('sav.st.rate')} value={pct(s.parcels.deliveryRate)} sub={t('sav.st.rateSub')} />
            </Kpis>
          </div>
          <div className="bjfc-row">
            <span className="bjfc-rl">{t('sav.st.money')}</span>
            <Kpis>
              <Kpi label={t('sav.st.collected')} value={da(s.money.collected)} sub={t('sav.st.collectedSub', { f: da(s.money.feesPaid), d: da(s.money.diffPaid) })} />
              <Kpi label={t('sav.st.courier')} value={da(s.money.courierFees + s.money.returnFees)} sub={t('sav.st.courierSub', { r: da(s.money.returnFees) })} tone="warn" />
              <Kpi label={t('sav.st.result')} value={da(s.money.result)} tone={s.money.result < 0 ? 'bad' : 'ok'} sub={t('sav.st.resultSub')} />
              <Kpi label={t('sav.st.toReceive')} value={da(s.money.netToReceive)} sub={t('sav.st.toReceiveSub', { v: da(s.money.cashed) })} />
            </Kpis>
          </div>
          <div className="two" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 16 }}>
            <Breakdown title={t('sav.st.byType')} rows={s.byType.map((r) => ({ label: t(`sav.type.${r.key}`), n: r.n }))} />
            <Breakdown title={t('sav.st.byKind')} rows={s.byKind.map((r) => ({ label: r.key === 'none' ? t('sav.st.noExchange') : t(`sav.kind.${r.key}`), n: r.n }))} />
          </div>
          <h3 style={{ margin: '6px 0 0' }}>{t('sav.st.byCompany')}</h3>
          {!s.companies.length ? (
            <Empty>{t('sav.st.noParcel')}</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('sav.st.company')}</th>
                    <th className="num">{t('sav.st.pDelivered')}</th>
                    <th className="num">{t('sav.st.returned')}</th>
                    <th className="num">{t('sav.st.rate')}</th>
                    <th className="num">{t('sav.st.collected')}</th>
                    <th className="num">{t('sav.st.courier')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.companies.map((c) => (
                    <tr key={c.companyId ?? 0}>
                      <td data-l={t('sav.st.company')}>{c.name}</td>
                      <td className="num" data-l={t('sav.st.pDelivered')}>{n(c.delivered)}</td>
                      <td className="num" data-l={t('sav.st.returned')}>{n(c.returns)}</td>
                      <td className="num" data-l={t('sav.st.rate')}>{pct(c.delivered + c.returns ? c.delivered / (c.delivered + c.returns) : null)}</td>
                      <td className="num" data-l={t('sav.st.collected')}>{da(c.amount)}</td>
                      <td className="num" data-l={t('sav.st.courier')}>{da(c.fees)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { label: string; n: number }[] }) {
  const total = rows.reduce((s, r) => s + r.n, 0);
  return (
    <div>
      <h3 style={{ margin: '0 0 8px' }}>{title}</h3>
      {!rows.length ? (
        <p className="muted small">—</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 44px', gap: 10, alignItems: 'center' }}>
              <div>
                <div className="small" style={{ fontWeight: 700 }}>{r.label}</div>
                <div style={{ height: 8, borderRadius: 6, background: 'var(--sky-soft)', overflow: 'hidden' }}>
                  <div style={{ width: `${total ? (r.n / total) * 100 : 0}%`, height: '100%', background: 'var(--px-orange, #F7A823)' }} />
                </div>
              </div>
              <b className="ltr" style={{ textAlign: 'end' }}>{n(r.n)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Sat = { n: number; counts: number[]; rate: number | null; prevRate: number | null; agents: { id: number; name: string; n: number; rate: number }[]; ends: { key: string; n: number; rate: number }[]; unhappy: { ref: string; satisfaction: number; note: string; at: string; customerName: string }[] };

/** Client satisfaction: the share of happy customers, the answers, by agent, by ending, and why the unhappy ones were. */
function Satisfaction({ s }: { s: Sat }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...s.counts);
  const delta = s.rate !== null && s.prevRate !== null ? Math.round((s.rate - s.prevRate) * 100) : null;
  return (
    <section className="pxv-st">
      <h3>
        <Icon name="smile" /> {t('sav.st.sat')}
      </h3>
      {!s.n ? (
        <p className="muted small">{t('sav.st.satNone')}</p>
      ) : (
        <div className="pxv-stg">
          <div className="pxv-stc pxv-str">
            <div className="pxv-ring" style={{ ['--p' as string]: `${Math.round((s.rate ?? 0) * 100)}%` }}>
              <b className="ltr">{pct(s.rate)}</b>
            </div>
            <div>
              <b>{t('sav.st.satHappy')}</b>
              <small>{t('sav.st.satOf', { count: s.n })}</small>
              {delta !== null && <em className={delta >= 0 ? 'up' : 'down'}>{t(delta >= 0 ? 'sav.st.satUp' : 'sav.st.satDown', { n: Math.abs(delta) })}</em>}
            </div>
          </div>
          <div className="pxv-stc">
            <span className="pxv-stl">{t('sav.st.satSplit')}</span>
            {[4, 3, 2, 1].map((v) => (
              <div key={v} className={`pxv-bar1 f${v}`}>
                <span className="pxv-bi" title={t(`sav.sat.${v}`)}>
                  <Icon name={FACES[v]} />
                </span>
                <i style={{ width: `${(s.counts[v - 1] / max) * 100}%` }} />
                <b className="ltr">{n(s.counts[v - 1])}</b>
              </div>
            ))}
          </div>
          <div className="pxv-stc">
            <span className="pxv-stl">{t('sav.st.satAgents')}</span>
            {s.agents.map((a) => (
              <div key={a.id} className="pxv-sta">
                <span className="pxv-av">{a.name.slice(0, 1).toUpperCase()}</span>
                <b>{a.name}</b>
                <small>{t('sav.st.satAnswers', { count: a.n })}</small>
                <span className={`badge ${a.rate >= 0.75 ? 't-ok' : a.rate >= 0.5 ? 't-warn' : 't-bad'} ltr`}>{pct(a.rate)}</span>
              </div>
            ))}
            <span className="pxv-stl" style={{ marginTop: 10 }}>
              {t('sav.st.satEnds')}
            </span>
            {s.ends.map((e) => (
              <div key={e.key} className="pxv-sta">
                <Icon name={e.key === 'phone' ? 'check' : 'swap'} />
                <b>{t(`sav.st.end.${e.key}`)}</b>
                <small>{t('sav.st.satAnswers', { count: e.n })}</small>
                <span className={`badge ${e.rate >= 0.75 ? 't-ok' : e.rate >= 0.5 ? 't-warn' : 't-bad'} ltr`}>{pct(e.rate)}</span>
              </div>
            ))}
          </div>
          {s.unhappy.length > 0 && (
            <div className="pxv-stc pxv-stw">
              <span className="pxv-stl">{t('sav.st.satWhy')}</span>
              {s.unhappy.map((u) => (
                <div key={u.ref + u.at} className="pxv-stu">
                  <SatBadge v={u.satisfaction} />
                  <span>
                    <b>{u.customerName}</b> <small className="ltr">{u.ref}</small>
                    <q>{u.note}</q>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
