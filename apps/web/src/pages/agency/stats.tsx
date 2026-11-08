// A confirmation agency's numbers (its space), on its orders only, for the seller chosen at the top of the page or all.
// Dashboard: each person his own numbers —
// - the chief: what waits now, the month's money (billed to the sellers, the agents' cost, the profit and the margin,
//   per seller and per agent), the period next to the one before, day by day, each seller, the confirmation team and
//   the suivi team;
// - an agent manager: the same without the money;
// - an agent (it is his home: an agent has no Accueil): what waits for him now, his own job's numbers (a confirmation
//   agent: calls, confirmation, upsells, delivery; a suivi agent: parcels delivered, back, his delivery rate) next to
//   his period before, with his rank (no one else's name), his gains and his bonuses.
// Analyse & statistiques (the chief and the agent managers): the results per seller, product, wilaya and agent.
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, dayRange, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { SellerScope, useSeller } from '../../lib/seller';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Kpis, Loading, Trend } from '../../ui/kit';
import { useBoardPeriod } from '../dashboard/board/Board';
import { Avatar, DayChart, PeriodChips } from '../dashboard/board/parts';
import { confTone, delivTone, KpiBox } from '../dashboard/util';
import type { PageProps } from '../registry';
import { NoPlanAlert } from '../caisse/NoPlanAlert';
import { payDay, period } from '../caisse/paieParts';
import { MyAgentBonuses } from './index';
import { monthLabel, MonthPicker } from './parts';
import '../dashboard/board/board.css';
import './stats.css';

type Dash = Out<'agency.dash'>;
type Ana = Out<'agency.analytics'>;
type Money = Out<'agency.money'>;
type Totals = Dash['team'];
type Row = Ana['sellers'][number];

/** change against the period before (null: nothing to compare with) */
const ch = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || b === 0 ? null : (a - b) / b);
/** change of a rate, in points */
const chPts = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);

export function AgencyDashboard(_: PageProps) {
  const seller = useSeller();
  return (
    <SellerScope seller={seller}>
      <DashBody />
    </SellerScope>
  );
}

export function AgencyAnalyse(_: PageProps) {
  const seller = useSeller();
  return (
    <SellerScope seller={seller}>
      <AnalyseBody />
    </SellerScope>
  );
}

/** The page's title, its period (and the one it is compared with) and the period chips. */
function Head({ title, per }: { title: string; per: ReturnType<typeof useBoardPeriod> }) {
  const { t } = useTranslation();
  return (
    <header className="tb-head hm-head">
      <div className="tb-ht">
        <h2>{title}</h2>
        <p className="tb-cap">{dayRange(per.range.from, per.range.to)}</p>
      </div>
      <PeriodChips value={per.period} onChange={per.setPeriod} custom={per.custom} onCustom={per.setCustom} />
    </header>
  );
}

/** The period's numbers next to the period before. */
function PeriodKpis({ d, p, vs, mine, earned }: { d: Totals; p: Totals; vs: string; mine?: boolean; earned?: { total: number; months: number } | null }) {
  const { t } = useTranslation();
  return (
    <Kpis>
      {earned && <KpiBox icon="wallet" label={t('agency.st.earned')} value={da(earned.total)} sub={t('agency.st.earnedSub', { count: earned.months })} tone="ok" href="#/facturation" />}
      <KpiBox icon="list" label={t(mine ? 'agency.st.myReceived' : 'agency.st.received')} value={n(d.received)} trend={<Trend v={ch(d.received, p.received)} vs={vs} />} sub={t('agency.st.pending', { n: d.pending })} />
      <KpiBox icon="check" label={t('agency.st.confirmed')} value={n(d.confirmed)} trend={<Trend v={chPts(d.confRate, p.confRate)} pts vs={vs} />} sub={t('agency.st.confRate', { v: pct(d.confRate) })} rate={d.confRate} tone={confTone(d.confRate)} />
      <KpiBox icon="xcircle" label={t('agency.st.cancelled')} value={n(d.cancelled)} trend={<Trend v={ch(d.cancelled, p.cancelled)} goodDown vs={vs} />} sub={t('agency.st.invalid', { n: d.invalid })} tone={d.cancelled ? 'bad' : undefined} zero={!d.cancelled} />
      <KpiBox icon="truck" label={t('agency.st.delivered')} value={n(d.delivered)} trend={<Trend v={chPts(d.deliveryRate, p.deliveryRate)} pts vs={vs} />} sub={t('agency.st.delivRate', { v: pct(d.deliveryRate) })} rate={d.deliveryRate} tone={delivTone(d.deliveryRate)} />
      <KpiBox icon="undo" label={t('agency.st.returned')} value={n(d.returned)} trend={<Trend v={ch(d.returned, p.returned)} goodDown vs={vs} />} sub={t('agency.st.returnedSub')} tone={d.returned ? 'bad' : undefined} zero={!d.returned} />
      <KpiBox icon="gift" label={t('agency.st.upsells')} value={n(d.upsells)} trend={<Trend v={ch(d.upsells, p.upsells)} vs={vs} />} sub={t('agency.st.upsellRate', { v: pct(d.upsellRate) })} zero={!d.upsells} />
      <KpiBox icon="coins" label={t('agency.st.revenue')} value={da(d.revenue)} trend={<Trend v={ch(d.revenue, p.revenue)} vs={vs} />} sub={t('agency.st.revenueSub')} />
    </Kpis>
  );
}

/** Day by day: orders received (bars), and how many of them are confirmed (line). */
function Days({ days, title }: { days: Dash['days']; title: string }) {
  const { t } = useTranslation();
  if (days.length < 2) return null;
  return (
    <section className="card agx-st-days">
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <DayChart days={days.map((x) => ({ d: x.d, n: x.received, ok: x.confirmed, of: x.received }))} barLabel={t('agency.st.received')} lineLabel={t('agency.st.confRateShort')} />
    </section>
  );
}

// ---------------------------------------------------------------- Dashboard
function DashBody() {
  const { t } = useTranslation();
  const { session } = useSession();
  const per = useBoardPeriod('agx.dash', 'today');
  const q = useRpc('agency.dash', per.range, { refetchInterval: 60_000 });
  const d = q.data;
  const vs = d ? t('dashboard.tb.vs', { range: dayRange(d.prevRange.from, d.prevRange.to) }) : '';
  // an agent sees the work of his own job (a suivi agent has no calls to make, a confirmation agent no alerts)
  const roles = session!.roles;
  const conf = !!d?.lead || roles.includes('confirmation');
  const follow = !!d?.lead || roles.includes('suivi');
  return (
    <div className="tb hm agx-st">
      <Head title={t('agency.st.dashTitle')} per={per} />
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          {!d.lead && <NoPlanAlert />}
          <section className="card hm-now">
            <div className="card-head">
              <h2>{t(d.lead ? 'agency.st.now' : 'agency.st.myNow')}</h2>
            </div>
            <Kpis>
              {conf && <KpiBox icon="phone" label={t('agency.st.toCall')} value={n(d.now.toCall)} sub={t('agency.st.fresh', { n: d.now.fresh })} tone={d.now.toCall ? 'warn' : undefined} zero={!d.now.toCall} href="#/confirmation/nouvelles" />}
              {d.lead && <KpiBox icon="users" label={t('agency.st.unassigned')} value={n(d.now.unassigned)} sub={t('agency.st.unassignedSub')} tone={d.now.unassigned ? 'warn' : undefined} zero={!d.now.unassigned} href="#/affectation" />}
              {follow && <KpiBox icon="alert" label={t('agency.st.alerts')} value={n(d.now.alerts)} sub={t('agency.st.alertsSub')} tone={d.now.alerts ? 'bad' : undefined} zero={!d.now.alerts} href="#/suivi/alertes_new" />}
              <KpiBox icon="route" label={t('agency.st.onRoad')} value={n(d.now.onRoad)} sub={t('agency.st.onRoadSub')} href="#/suivi/enlivraison" />
              {d.lead && <KpiBox icon="headset" label={t('agency.st.online')} value={n(d.online)} sub={t('agency.st.onlineSub', { n: d.agents.length })} tone={d.online ? 'ok' : undefined} zero={!d.online} />}
            </Kpis>
          </section>
          {d.lead ? (
            <>
              {session!.isAdmin && <MoneyCard />}
              <section className="card hm-per">
                <div className="card-head">
                  <h2>
                    {t('agency.st.period')} <small className="px-vs">{vs}</small>
                  </h2>
                </div>
                <PeriodKpis d={d.team} p={d.prev} vs={vs} />
              </section>
              <Days days={d.days} title={t('agency.st.days')} />
              {d.bySeller.length > 0 && <SellerOps rows={d.bySeller} />}
              <Team rows={d.agents} />
            </>
          ) : (
            <>
              {d.agents[0] && <MyJob d={d} vs={vs} />}
              <MyGains />
              {roles.includes('confirmation') && <Days days={d.days} title={t('agency.st.days')} />}
              {d.ladder && <Ladder l={d.ladder} />}
              <MyAgentBonuses />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** An agent's own numbers over the period, job by job, next to his period before, with his rank in his job. */
function MyJob({ d, vs }: { d: Dash; vs: string }) {
  const { t } = useTranslation();
  const m = d.agents[0];
  const p = d.prevMe;
  const rank = (job: 'conf' | 'follow') =>
    d.rank && d.ladder?.by === job ? (
      <span className="tb-rank">
        <Icon name="medal" /> {t('dashboard.tb.rank', { rank: d.rank.rank, of: d.rank.of })}
        <small> · {t(job === 'conf' ? 'agency.st.confRateShort' : 'agency.st.followRate')}</small>
      </span>
    ) : null;
  return (
    <>
      {m.conf && (
        <section className="card hm-per">
          <div className="card-head">
            <h2>
              {t('agency.st.myConf')} <small className="px-vs">{vs}</small>
            </h2>
            {rank('conf')}
          </div>
          <Kpis>
            <KpiBox icon="phone" label={t('agency.st.callsKpi')} value={n(m.calls)} trend={<Trend v={ch(m.calls, p?.calls)} vs={vs} />} sub={t('agency.st.callsSub')} zero={!m.calls} />
            <KpiBox icon="list" label={t('agency.st.myReceived')} value={n(m.received)} trend={<Trend v={ch(m.received, p?.received)} vs={vs} />} sub={t('agency.st.pending', { n: m.pending })} zero={!m.received} />
            <KpiBox icon="check" label={t('agency.st.confirmed')} value={n(m.confirmed)} trend={<Trend v={chPts(m.confRate, p?.confRate)} pts vs={vs} />} sub={t('agency.st.confRate', { v: pct(m.confRate) })} rate={m.confRate} tone={confTone(m.confRate)} />
            <KpiBox icon="xcircle" label={t('agency.st.cancelled')} value={n(m.cancelled)} trend={<Trend v={ch(m.cancelled, p?.cancelled)} goodDown vs={vs} />} sub={t('agency.st.invalid', { n: m.invalid })} tone={m.cancelled ? 'bad' : undefined} zero={!m.cancelled} />
            <KpiBox icon="gift" label={t('agency.st.upsells')} value={n(m.upsells)} trend={<Trend v={ch(m.upsells, p?.upsells)} vs={vs} />} sub={t('agency.st.upsellRate', { v: pct(m.upsellRate) })} zero={!m.upsells} />
            <KpiBox icon="truck" label={t('agency.st.delivered')} value={n(m.delivered)} trend={<Trend v={chPts(m.deliveryRate, p?.deliveryRate)} pts vs={vs} />} sub={t('agency.st.delivRate', { v: pct(m.deliveryRate) })} rate={m.deliveryRate} tone={delivTone(m.deliveryRate)} />
          </Kpis>
        </section>
      )}
      {m.suivi && (
        <section className="card hm-per">
          <div className="card-head">
            <h2>
              {t('agency.st.myFollow')} <small className="px-vs">{vs}</small>
            </h2>
            {rank('follow')}
          </div>
          <Kpis>
            <KpiBox icon="truck" label={t('agency.st.followDelivered')} value={n(m.followDelivered)} trend={<Trend v={ch(m.followDelivered, p?.followDelivered)} vs={vs} />} sub={t('agency.st.followDeliveredSub')} tone={m.followDelivered ? 'ok' : undefined} zero={!m.followDelivered} />
            <KpiBox icon="undo" label={t('agency.st.followReturned')} value={n(m.followReturned)} trend={<Trend v={ch(m.followReturned, p?.followReturned)} goodDown vs={vs} />} sub={t('agency.st.returnedSub')} tone={m.followReturned ? 'bad' : undefined} zero={!m.followReturned} />
            <KpiBox icon="chart" label={t('agency.st.followRate')} value={pct(m.followRate)} trend={<Trend v={chPts(m.followRate, p?.followRate)} pts vs={vs} />} sub={t('agency.st.ladderOf.follow', { a: m.followDelivered, b: m.followDelivered + m.followReturned })} rate={m.followRate} tone={delivTone(m.followRate)} />
          </Kpis>
        </section>
      )}
    </>
  );
}

/** An agent's own money, as « Mes gains »: what the agency owes him, this pay period, what is on its way. */
function MyGains() {
  const { t } = useTranslation();
  const q = useRpc('pay.mine', {}, { refetchInterval: 300_000 });
  const g = q.data;
  // no plan yet: the red alert at the top of the page says it
  if (!g || !g.plans.length) return null;
  return (
    <section className="card agx-gains">
      <div className="card-head">
        <h2>{t('agency.st.gains')}</h2>
        <a className="btn small" href="#/gains">
          {t('agency.st.gainsLink')}
        </a>
      </div>
      <Kpis>
        <KpiBox icon="wallet" label={t('paie.owedAgency')} value={da(g.owed)} sub={g.ready.total > 0 ? t('paie.owedSub', { ready: da(g.ready.total), open: da(Math.max(0, g.open.net)) }) : t('paie.owedSubOpen')} tone="ok" href="#/gains" />
        <KpiBox icon="coins" label={t('paie.earned', { period: period(g.open.from, g.open.to) })} value={da(g.open.earned)} sub={`${t('paie.earnedSub', { count: g.open.orders, upsells: g.open.upsells })} · ${t('paie.payDay', { d: payDay(g.open.to) })}`} />
        <KpiBox icon="truck" label={t('paie.coming')} value={`+${da(g.coming.amount)}`} sub={t('paie.comingSub', { count: g.coming.count })} zero={!g.coming.amount} />
      </Kpis>
    </section>
  );
}

/** this month (Algeria) */
const monthNow = () => {
  const x = new Date(Date.now() + 3_600_000);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** what is left of what was billed: green from 30 %, orange from 10 %, red under */
const marginTone = (v: number | null, badge = false) => (v === null ? undefined : v < 0.1 ? 'bad' : v < 0.3 ? (badge ? 'mid' : 'warn') : 'ok');

/**
 * The chief: the month's money — what the sellers owe the agency (as Facturation), what its agents cost (as Paie), the
 * profit and the margin; then each seller (the fixed salaries apart: they belong to no seller) and each agent's cost.
 */
function MoneyCard() {
  const { t } = useTranslation();
  const max = monthNow();
  const [month, setMonth] = useState(max);
  const q = useRpc('agency.money', { month }, { refetchInterval: 300_000 });
  return (
    <section className="card agx-money">
      <div className="card-head">
        <h2>{t('agency.st.money.title')}</h2>
        <MonthPicker value={month} max={max} onChange={setMonth} />
      </div>
      <p className="muted small agx-st-hint">{t('agency.st.money.help')}</p>
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <Loading /> : <MoneyBody m={q.data} />}
    </section>
  );
}

function MoneyBody({ m }: { m: Money }) {
  const { t } = useTranslation();
  if (!m.earned && !m.cost) return <p className="tb-calm">{t('agency.st.money.empty')}</p>;
  const running = m.month === m.current;
  const L = (k: string) => t(`agency.st.money.${k}`);
  return (
    <>
      <Kpis>
        <KpiBox icon="wallet" label={L('billed')} value={da(m.earned)} sub={running ? L('running') : m.received ? t('agency.st.money.received', { v: da(m.received) }) : L('noneReceived')} href="#/facturation/vendeurs" />
        <KpiBox icon="users" label={L('cost')} value={da(m.cost)} sub={m.salaries ? t('agency.st.money.costSplit', { c: da(m.commissions), s: da(m.salaries) }) : L('costCom')} href="#/equipe/paie" />
        <KpiBox icon="coins" label={L('profit')} value={da(m.profit)} sub={L('profitSub')} tone={m.profit >= 0 ? 'ok' : 'bad'} />
        <KpiBox icon="chart" label={L('margin')} value={pct(m.margin)} sub={L('marginSub')} rate={m.margin} tone={marginTone(m.margin)} />
      </Kpis>
      <h3 className="agx-money-h">{L('sellers')}</h3>
      <div className="tbl-wrap">
        <table className="tbl agx-st-tbl agx-money-tbl">
          <thead>
            <tr>
              <th>{L('seller')}</th>
              <th className="num">{L('billed')}</th>
              <th className="num">{L('cost')}</th>
              <th className="num">{L('profit')}</th>
              <th className="num">{L('margin')}</th>
            </tr>
          </thead>
          <tbody>
            {m.sellers.map((s) => {
              const st = s.status ?? (running ? 'running' : 'estimate');
              return (
                <tr key={s.key}>
                  <td data-l={L('seller')}>
                    <b>{s.name}</b>
                  </td>
                  <td className="num" data-l={L('billed')}>
                    <b className="ltr">{da(s.earned)}</b>
                    <small className={`agx-st-bill ${st}`}>{t(`agency.st.bill.${st}`)}</small>
                  </td>
                  <td className="num ltr" data-l={L('cost')}>
                    {da(s.cost)}
                  </td>
                  <td className="num" data-l={L('profit')}>
                    <b className={`ltr${s.profit < 0 ? ' agx-neg' : ''}`}>{da(s.profit)}</b>
                  </td>
                  <td className="num" data-l={L('margin')}>
                    <Rate v={s.margin} tone={marginTone(s.margin, true)} />
                  </td>
                </tr>
              );
            })}
            {m.salaries ? (
              <tr className="agx-money-sal">
                <td data-l={L('seller')}>
                  <span className="agx-st-who">
                    <b>{L('salaries')}</b>
                    <small>{L('salariesSub')}</small>
                  </span>
                </td>
                <td className="num" data-l={L('billed')}>
                  —
                </td>
                <td className="num ltr" data-l={L('cost')}>
                  {da(m.salaries)}
                </td>
                <td className="num" data-l={L('profit')}>
                  <b className="ltr agx-neg">{da(-m.salaries)}</b>
                </td>
                <td className="num" data-l={L('margin')}>
                  —
                </td>
              </tr>
            ) : null}
          </tbody>
          {(m.sellers.length > 1 || !!m.salaries) && (
            <tfoot>
              <tr>
                <th>{t('agency.st.c.total')}</th>
                <th className="num ltr">{da(m.earned)}</th>
                <th className="num ltr">{da(m.cost)}</th>
                <th className={`num ltr${m.profit < 0 ? ' agx-neg' : ''}`}>{da(m.profit)}</th>
                <th className="num">
                  <Rate v={m.margin} tone={marginTone(m.margin, true)} />
                </th>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {m.salaries === null && <p className="muted small">{L('oneSeller')}</p>}
      {m.agents.length > 0 && (
        <>
          <h3 className="agx-money-h">{L('agents')}</h3>
          <div className="tbl-wrap">
            <table className="tbl agx-st-tbl agx-money-tbl">
              <thead>
                <tr>
                  <th>{L('agent')}</th>
                  <th className="num">{L('orders')}</th>
                  <th className="num">{L('commissions')}</th>
                  {m.salaries !== null && <th className="num">{L('salary')}</th>}
                  <th className="num">{t('agency.st.c.total')}</th>
                </tr>
              </thead>
              <tbody>
                {m.agents.map((a) => (
                  <tr key={a.id}>
                    <td data-l={L('agent')}>
                      <span className="agx-st-who">
                        <Avatar name={a.name} />
                        <b>{a.name}</b>
                      </span>
                    </td>
                    <td className="num ltr" data-l={L('orders')}>
                      {n(a.orders)}
                    </td>
                    <td className="num ltr" data-l={L('commissions')}>
                      {da(a.commissions)}
                    </td>
                    {m.salaries !== null && (
                      <td className="num ltr" data-l={L('salary')}>
                        {a.salary ? da(a.salary) : '—'}
                      </td>
                    )}
                    <td className="num" data-l={t('agency.st.c.total')}>
                      <b className="ltr">{da(a.total)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** The leads: each seller over the period — confirmation, delivery, upsells and the value delivered. */
function SellerOps({ rows }: { rows: Dash['bySeller'] }) {
  const { t } = useTranslation();
  const cols: Col<Dash['bySeller'][number]>[] = [
    { k: 'received', l: t('agency.st.c.received'), v: (r) => r.received, f: (r) => n(r.received) },
    { k: 'confirmed', l: t('agency.st.c.confirmed'), v: (r) => r.confirmed, f: (r) => n(r.confirmed) },
    { k: 'confRate', l: t('agency.st.c.confRate'), v: (r) => r.confRate ?? -1, f: (r) => <Rate v={r.confRate} tone={confTone(r.confRate, true)} /> },
    { k: 'delivered', l: t('agency.st.c.delivered'), v: (r) => r.delivered, f: (r) => n(r.delivered) },
    { k: 'deliveryRate', l: t('agency.st.c.deliveryRate'), v: (r) => r.deliveryRate ?? -1, f: (r) => <Rate v={r.deliveryRate} tone={delivTone(r.deliveryRate, true)} /> },
    { k: 'upsells', l: t('agency.st.c.upsells'), v: (r) => r.upsells, f: (r) => n(r.upsells) },
    { k: 'upsellRate', l: t('agency.st.c.upsellRate'), v: (r) => r.upsellRate ?? -1, f: (r) => <span className="ltr">{pct(r.upsellRate)}</span> },
    { k: 'revenue', l: t('agency.st.c.revenue'), v: (r) => r.revenue, f: (r) => <span className="ltr">{da(r.revenue)}</span> },
  ];
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('agency.st.bySeller')}</h2>
      </div>
      <p className="muted small agx-st-hint">{t('agency.st.bySellerHint')}</p>
      <SortTable rows={rows} cols={cols} first={t('agency.st.first.sellers')} name={(r) => <span className="agx-st-who"><b>{r.name || t('agency.st.noName')}</b></span>} keyOf={(r) => r.key} />
    </section>
  );
}

/** The leads: the confirmation team (calls, confirmation, upsells, delivery) and the suivi team (its parcels). */
function Team({ rows }: { rows: Dash['agents'] }) {
  const { t } = useTranslation();
  if (!rows.length)
    return (
      <section className="card">
        <div className="card-head">
          <h2>{t('agency.st.team')}</h2>
        </div>
        <p className="tb-calm">{t('agency.st.noAgents')}</p>
      </section>
    );
  const conf = rows.filter((r) => r.conf);
  const follow = rows.filter((r) => r.suivi);
  return (
    <>
      {conf.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>{t('agency.st.teamConf')}</h2>
          </div>
          <AgentTable rows={conf} live />
        </section>
      )}
      {follow.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>{t('agency.st.teamFollow')}</h2>
          </div>
          <AgentTable rows={follow} live job="follow" />
        </section>
      )}
    </>
  );
}

type AgentRow = Dash['agents'][number] | Ana['agents'][number];

/**
 * Each agent: on line or not, then his job's numbers — confirmation: calls, the orders given to him (confirmed,
 * cancelled), their delivery and upsells; suivi: the parcels he followed (delivered, back, his delivery rate).
 */
function AgentTable({ rows, live, job = 'conf' }: { rows: AgentRow[]; live?: boolean; job?: 'conf' | 'follow' }) {
  const { t } = useTranslation();
  const followCols: Col<AgentRow>[] = [
    { k: 'followDelivered', l: t('agency.st.c.followDelivered'), v: (r) => r.followDelivered, f: (r) => n(r.followDelivered) },
    { k: 'followReturned', l: t('agency.st.c.followReturned'), v: (r) => r.followReturned, f: (r) => n(r.followReturned) },
    { k: 'followRate', l: t('agency.st.c.followRate'), v: (r) => r.followRate ?? -1, f: (r) => <Rate v={r.followRate} tone={delivTone(r.followRate, true)} /> },
  ];
  const confCols: Col<AgentRow>[] = [
    { k: 'calls', l: t('agency.st.c.calls'), v: (r) => r.calls, f: (r) => n(r.calls) },
    { k: 'received', l: t('agency.st.c.received'), v: (r) => r.received, f: (r) => n(r.received) },
    { k: 'confirmed', l: t('agency.st.c.confirmed'), v: (r) => r.confirmed, f: (r) => n(r.confirmed) },
    { k: 'cancelled', l: t('agency.st.c.cancelled'), v: (r) => r.cancelled, f: (r) => n(r.cancelled) },
    { k: 'confRate', l: t('agency.st.c.confRate'), v: (r) => r.confRate ?? -1, f: (r) => <Rate v={r.confRate} tone={confTone(r.confRate, true)} /> },
    { k: 'delivered', l: t('agency.st.c.delivered'), v: (r) => r.delivered, f: (r) => n(r.delivered) },
    { k: 'returned', l: t('agency.st.c.returned'), v: (r) => r.returned, f: (r) => n(r.returned) },
    { k: 'deliveryRate', l: t('agency.st.c.deliveryRate'), v: (r) => r.deliveryRate ?? -1, f: (r) => <Rate v={r.deliveryRate} tone={delivTone(r.deliveryRate, true)} /> },
    { k: 'upsells', l: t('agency.st.c.upsells'), v: (r) => r.upsells, f: (r) => n(r.upsells) },
    { k: 'upsellRate', l: t('agency.st.c.upsellRate'), v: (r) => r.upsellRate ?? -1, f: (r) => <span className="ltr">{pct(r.upsellRate)}</span> },
  ];
  return (
    <SortTable
      key={job}
      rows={rows}
      cols={job === 'follow' ? followCols : confCols}
      first={t('agency.st.c.agent')}
      name={(r) => (
        <span className="agx-st-who">
          {live && 'presence' in r ? <Avatar name={r.name} presence={r.presence} /> : <Avatar name={r.name} />}
          <b>{r.name}</b>
          {live && 'presence' in r && <small className={`agx-st-pr ${r.presence}`}>{t(`agency.st.pr.${r.presence}`)}</small>}
        </span>
      )}
      keyOf={(r) => String(r.id)}
    />
  );
}

/** A rate with its color (green, orange, red). */
function Rate({ v, tone }: { v: number | null; tone?: string }) {
  return <span className={`agx-st-rate${tone ? ` t-${tone}` : ''}`}>{pct(v)}</span>;
}

// ---------------------------------------------------------------- a table sorted by any column
interface Col<T> {
  k: string;
  l: string;
  v: (r: T) => number;
  f: (r: T) => ReactNode;
}
function SortTable<T>({ rows, cols, first, name, keyOf }: { rows: T[]; cols: Col<T>[]; first: string; name: (r: T) => ReactNode; keyOf: (r: T) => string }) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 } | null>(null);
  const col = sort ? cols.find((c) => c.k === sort.k) : null;
  const list = col && sort ? [...rows].sort((a, b) => (col.v(b) - col.v(a)) * sort.dir) : rows;
  const click = (k: string) => setSort(sort && sort.k === k ? (sort.dir === 1 ? { k, dir: -1 } : null) : { k, dir: 1 });
  return (
    <div className="tbl-wrap">
      <table className="tbl agx-st-tbl">
        <thead>
          <tr>
            <th>{first}</th>
            {cols.map((c) => (
              <th key={c.k} className="num">
                <button type="button" className={`agx-st-sort${sort?.k === c.k ? ' on' : ''}`} onClick={() => click(c.k)} aria-label={t('agency.st.sortBy', { col: c.l })}>
                  {c.l}
                  {sort?.k === c.k && <span aria-hidden="true">{sort.dir === 1 ? ' ▼' : ' ▲'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={keyOf(r)}>
              <td data-l={first}>{name(r)}</td>
              {cols.map((c) => (
                <td key={c.k} className="num" data-l={c.l}>
                  {c.f(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Analyse & statistiques
const TABS = ['sellers', 'products', 'wilayas', 'agents', 'followers', 'earnings'] as const;
type Tab = (typeof TABS)[number];

function AnalyseBody() {
  const { t, i18n } = useTranslation();
  const per = useBoardPeriod('agx.ana', '30d');
  const q = useRpc('agency.analytics', per.range, { refetchInterval: 120_000 });
  const [tab, setTab] = useState<Tab>('sellers');
  const d = q.data;
  const vs = d ? t('dashboard.tb.vs', { range: dayRange(d.prevRange.from, d.prevRange.to) }) : '';
  const cols: Col<Row>[] = [
    { k: 'received', l: t('agency.st.c.received'), v: (r) => r.received, f: (r) => n(r.received) },
    { k: 'confirmed', l: t('agency.st.c.confirmed'), v: (r) => r.confirmed, f: (r) => n(r.confirmed) },
    { k: 'cancelled', l: t('agency.st.c.cancelled'), v: (r) => r.cancelled, f: (r) => n(r.cancelled) },
    { k: 'confRate', l: t('agency.st.c.confRate'), v: (r) => r.confRate ?? -1, f: (r) => <Rate v={r.confRate} tone={confTone(r.confRate, true)} /> },
    { k: 'delivered', l: t('agency.st.c.delivered'), v: (r) => r.delivered, f: (r) => n(r.delivered) },
    { k: 'returned', l: t('agency.st.c.returned'), v: (r) => r.returned, f: (r) => n(r.returned) },
    { k: 'deliveryRate', l: t('agency.st.c.deliveryRate'), v: (r) => r.deliveryRate ?? -1, f: (r) => <Rate v={r.deliveryRate} tone={delivTone(r.deliveryRate, true)} /> },
    { k: 'upsells', l: t('agency.st.c.upsells'), v: (r) => r.upsells, f: (r) => n(r.upsells) },
    { k: 'revenue', l: t('agency.st.c.revenue'), v: (r) => r.revenue, f: (r) => da(r.revenue) },
  ];
  const rowsOf: Record<Tab, Row[]> = d ? { sellers: d.sellers, products: d.products, wilayas: d.wilayas, agents: [], followers: d.followers, earnings: [] } : { sellers: [], products: [], wilayas: [], agents: [], followers: [], earnings: [] };
  return (
    <div className="tb hm agx-st">
      <Head title={t('agency.st.anaTitle')} per={per} />
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          <section className="card hm-per">
            <div className="card-head">
              <h2>
                {t('agency.st.results')} <small className="px-vs">{vs}</small>
              </h2>
            </div>
            <PeriodKpis d={d.team} p={d.prev} vs={vs} earned={d.earnings ? { total: d.earnings.total, months: d.earnings.months.length } : null} />
          </section>
          <Days days={d.days} title={t('agency.st.days')} />
          <section className="card agx-st-break">
            <div className="agx-st-bar">
              <div className="agx-st-tabs" role="tablist" aria-label={t('agency.st.byAria')}>
                {TABS.filter((k) => k !== 'earnings' || d.earnings).map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                    {t(`agency.st.by.${k}`)}
                    <span className="agx-st-n ltr">{k === 'agents' ? d.agents.length : k === 'earnings' ? d.earnings?.sellers.length ?? 0 : rowsOf[k].length}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="btn small" onClick={() => toExcel(d, t, i18n.language, per.range)}>
                <Icon name="download" /> {t('agency.st.excel')}
              </button>
            </div>
            <p className="muted small agx-st-hint">{t(`agency.st.hint.${tab}`)}</p>
            {tab === 'earnings' && d.earnings ? (
              <Earnings e={d.earnings} />
            ) : tab === 'agents' ? (
              d.agents.length ? <AgentTable rows={d.agents} /> : <p className="tb-calm">{t('agency.st.empty')}</p>
            ) : rowsOf[tab].length ? (
              <SortTable
                key={tab}
                rows={rowsOf[tab]}
                cols={tab === 'followers' ? cols.filter((c) => ['delivered', 'returned', 'deliveryRate', 'upsells', 'revenue'].includes(c.k)) : cols}
                first={t(`agency.st.first.${tab}`)}
                name={(r) => (
                  <span className="agx-st-who">
                    <b>{r.name || t('agency.st.noName')}</b>
                    {'seller' in r && d.sellerCount > 1 && <small>{(r as Row & { seller: string }).seller}</small>}
                  </span>
                )}
                keyOf={(r) => r.key}
              />
            ) : (
              <p className="tb-calm">{t('agency.st.empty')}</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the money (the chief)
type Earn = NonNullable<Ana['earnings']>;

/** What each seller owes the agency, month by month (the same amounts as Facturation), and where each bill stands. */
function Earnings({ e }: { e: Earn }) {
  const { t, i18n } = useTranslation();
  if (!e.sellers.length) return <p className="tb-calm">{t('agency.st.empty')}</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl agx-st-tbl agx-st-earn">
        <thead>
          <tr>
            <th>{t('agency.st.first.sellers')}</th>
            {e.months.map((m) => (
              <th key={m} className="num">
                {monthLabel(m, i18n.language)}
              </th>
            ))}
            {e.months.length > 1 && <th className="num">{t('agency.st.c.total')}</th>}
          </tr>
        </thead>
        <tbody>
          {e.sellers.map((s) => (
            <tr key={s.key}>
              <td data-l={t('agency.st.first.sellers')}>
                <b>{s.name}</b>
              </td>
              {e.months.map((m) => {
                const c = s.months[m];
                return (
                  <td key={m} className="num" data-l={monthLabel(m, i18n.language)}>
                    {c ? (
                      <>
                        <b className="ltr">{da(c.total)}</b>
                        <small className={`agx-st-bill ${c.status ?? (m === e.current ? 'running' : 'estimate')}`}>{t(`agency.st.bill.${c.status ?? (m === e.current ? 'running' : 'estimate')}`)}</small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                );
              })}
              {e.months.length > 1 && (
                <td className="num" data-l={t('agency.st.c.total')}>
                  <b className="ltr">{da(s.total)}</b>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {e.sellers.length > 1 && (
          <tfoot>
            <tr>
              <th>{t('agency.st.c.total')}</th>
              {e.months.map((m) => (
                <th key={m} className="num ltr">
                  {da(e.perMonth[m] ?? 0)}
                </th>
              ))}
              {e.months.length > 1 && <th className="num ltr">{da(e.total)}</th>}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Excel
/** One workbook: the results, each table of the page, day by day (and the money for the chief). */
async function toExcel(d: Ana, t: (k: string, o?: Record<string, unknown>) => string, lang: string, range: { from: string; to: string }) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const pctv = (v: number | null) => (v === null ? '' : Math.round(v * 1000) / 10);
  const head = [t('agency.st.c.received'), t('agency.st.c.confirmed'), t('agency.st.c.cancelled'), t('agency.st.xl.invalid'), t('agency.st.xl.pending'), `${t('agency.st.c.confRate')} %`, t('agency.st.c.delivered'), t('agency.st.c.returned'), `${t('agency.st.c.deliveryRate')} %`, t('agency.st.c.upsells'), `${t('agency.st.c.revenue')} (DA)`];
  const vals = (r: Totals) => [r.received, r.confirmed, r.cancelled, r.invalid, r.pending, pctv(r.confRate), r.delivered, r.returned, pctv(r.deliveryRate), r.upsells, r.revenue];
  const sheet = (name: string, aoa: (string | number)[][], widths: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  };
  const w = [28, ...head.map(() => 13)];
  sheet(t('agency.st.results'), [[t('agency.st.xl.period'), dayRange(range.from, range.to)], [], ['', ...head], [t('agency.st.xl.now'), ...vals(d.team)], [t('agency.st.xl.before'), ...vals(d.prev)]], w);
  const table = (key: 'sellers' | 'products' | 'wilayas' | 'followers', rows: Row[]) => sheet(t(`agency.st.by.${key}`), [[t(`agency.st.first.${key}`), ...(key === 'products' ? [t('agency.st.first.sellers')] : []), ...head], ...rows.map((r) => [r.name || t('agency.st.noName'), ...(key === 'products' ? [(r as Row & { seller?: string }).seller ?? ''] : []), ...vals(r)])], key === 'products' ? [28, 20, ...head.map(() => 13)] : w);
  table('sellers', d.sellers);
  table('products', d.products);
  table('wilayas', d.wilayas);
  sheet(t('agency.st.by.agents'), [[t('agency.st.c.agent'), t('agency.st.c.calls'), ...head], ...d.agents.map((r) => [r.name, r.calls, ...vals(r)])], [24, 10, ...head.map(() => 13)]);
  table('followers', d.followers);
  sheet(t('agency.st.days'), [[t('agency.st.xl.day'), t('agency.st.c.received'), t('agency.st.c.confirmed'), t('agency.st.c.delivered')], ...d.days.map((x) => [x.d, x.received, x.confirmed, x.delivered])], [14, 13, 13, 13]);
  if (d.earnings) {
    const e = d.earnings;
    sheet(t('agency.st.by.earnings'), [[t('agency.st.first.sellers'), ...e.months.map((m) => monthLabel(m, lang)), t('agency.st.c.total')], ...e.sellers.map((s) => [s.name, ...e.months.map((m) => s.months[m]?.total ?? 0), s.total]), [t('agency.st.c.total'), ...e.months.map((m) => e.perMonth[m] ?? 0), e.total]], [28, ...e.months.map(() => 16), 16]);
  }
  const blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // the days in Algiers (UTC+1), the end excluded: « analyse-2026-10-05-2026-11-03 »
  const day = (iso: string, end = false) => new Date(Date.parse(iso) + 3_600_000 - (end ? 1 : 0)).toISOString().slice(0, 10);
  a.download = `analyse-${day(range.from)}-${day(range.to, true)}.xlsx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- an agent's ladder
/** The team's ladder for an agent: places and numbers, only his own name. */
function Ladder({ l }: { l: NonNullable<Dash['ladder']> }) {
  const { t } = useTranslation();
  if (l.rows.length < 2) return null;
  return (
    <section className="card agx-st-ladder">
      <div className="card-head">
        <h2>{t('agency.st.ladder')}</h2>
        <small className="muted">{t(`agency.st.ladderBy.${l.by}`)}</small>
      </div>
      <ol className="agx-st-lad">
        {l.rows.map((x) => (
          <li key={x.pos} className={x.me ? 'me' : ''}>
            <span className={`agx-st-pos p${x.pos <= 3 ? x.pos : 'n'}`}>{x.pos}</span>
            <b className="agx-st-ln">{x.me ? t('agency.st.you', { name: x.name }) : t('agency.st.agentN', { n: x.pos })}</b>
            <span className="agx-st-lv">
              <Rate v={x.rate} tone={(l.by === 'conf' ? confTone : delivTone)(x.rate, true)} />
              <small className="ltr">{t(`agency.st.ladderOf.${l.by}`, { a: x.a, b: x.b })}</small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
