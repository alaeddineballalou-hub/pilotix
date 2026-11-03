// A confirmation agency's numbers (its space), on its orders only, for the seller chosen at the top of the page or all:
// - Dashboard (everyone): what waits now, the period next to the one before, day by day, and each agent's numbers —
//   an agent sees his own orders and his own row, with his rank (no one else's name).
// - Analyse & statistiques (the chief and the agent managers): the results per seller, product, wilaya and agent.
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
import '../dashboard/board/board.css';
import './stats.css';

type Dash = Out<'agency.dash'>;
type Ana = Out<'agency.analytics'>;
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
function PeriodKpis({ d, p, vs, mine }: { d: Totals; p: Totals; vs: string; mine?: boolean }) {
  const { t } = useTranslation();
  return (
    <Kpis>
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
          <section className="card hm-per">
            <div className="card-head">
              <h2>
                {t(d.lead ? 'agency.st.period' : 'agency.st.myPeriod')} <small className="px-vs">{vs}</small>
              </h2>
              {d.rank && (
                <span className="tb-rank">
                  <Icon name="medal" /> {t('dashboard.tb.rank', { rank: d.rank.rank, of: d.rank.of })}
                  <small> · {t('agency.st.confRateShort')}</small>
                </span>
              )}
            </div>
            <PeriodKpis d={d.team} p={d.prev} vs={vs} mine={!d.lead} />
          </section>
          <Days days={d.days} title={t('agency.st.days')} />
          {d.lead ? (
            <section className="card">
              <div className="card-head">
                <h2>{t('agency.st.team')}</h2>
              </div>
              {d.agents.length ? <AgentTable rows={d.agents} live /> : <p className="tb-calm">{t('agency.st.noAgents')}</p>}
            </section>
          ) : (
            d.agents[0] && (
              <section className="card">
                <div className="card-head">
                  <h2>{t('agency.st.mine', { name: session!.profile.name })}</h2>
                </div>
                <AgentTable rows={d.agents} />
              </section>
            )
          )}
        </>
      )}
    </div>
  );
}

type AgentRow = Dash['agents'][number] | Ana['agents'][number];

/** Each agent: on line or not, calls, confirmation (the orders given to him), delivery, upsells. */
function AgentTable({ rows, live }: { rows: AgentRow[]; live?: boolean }) {
  const { t } = useTranslation();
  const cols: Col<AgentRow>[] = [
    { k: 'calls', l: t('agency.st.c.calls'), v: (r) => r.calls, f: (r) => n(r.calls) },
    { k: 'received', l: t('agency.st.c.received'), v: (r) => r.received, f: (r) => n(r.received) },
    { k: 'confirmed', l: t('agency.st.c.confirmed'), v: (r) => r.confirmed, f: (r) => n(r.confirmed) },
    { k: 'cancelled', l: t('agency.st.c.cancelled'), v: (r) => r.cancelled, f: (r) => n(r.cancelled) },
    { k: 'confRate', l: t('agency.st.c.confRate'), v: (r) => r.confRate ?? -1, f: (r) => <Rate v={r.confRate} tone={confTone(r.confRate, true)} /> },
    { k: 'delivered', l: t('agency.st.c.delivered'), v: (r) => r.delivered, f: (r) => n(r.delivered) },
    { k: 'returned', l: t('agency.st.c.returned'), v: (r) => r.returned, f: (r) => n(r.returned) },
    { k: 'deliveryRate', l: t('agency.st.c.deliveryRate'), v: (r) => r.deliveryRate ?? -1, f: (r) => <Rate v={r.deliveryRate} tone={delivTone(r.deliveryRate, true)} /> },
    { k: 'upsells', l: t('agency.st.c.upsells'), v: (r) => r.upsells, f: (r) => n(r.upsells) },
  ];
  return (
    <SortTable
      rows={rows}
      cols={cols}
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
const TABS = ['sellers', 'products', 'wilayas', 'agents', 'followers'] as const;
type Tab = (typeof TABS)[number];

function AnalyseBody() {
  const { t } = useTranslation();
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
  const rowsOf: Record<Tab, Row[]> = d ? { sellers: d.sellers, products: d.products, wilayas: d.wilayas, agents: [], followers: d.followers } : { sellers: [], products: [], wilayas: [], agents: [], followers: [] };
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
            <PeriodKpis d={d.team} p={d.prev} vs={vs} />
          </section>
          <Days days={d.days} title={t('agency.st.days')} />
          <section className="card agx-st-break">
            <div className="agx-st-tabs" role="tablist" aria-label={t('agency.st.byAria')}>
              {TABS.map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {t(`agency.st.by.${k}`)}
                  <span className="agx-st-n ltr">{k === 'agents' ? d.agents.length : rowsOf[k].length}</span>
                </button>
              ))}
            </div>
            <p className="muted small agx-st-hint">{t(`agency.st.hint.${tab}`)}</p>
            {tab === 'agents' ? (
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
