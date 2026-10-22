// Accueil: "Maintenant" (live counters), "Période" (7 KPIs), agents table, livreurs card, presence.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Card, ErrorBox, Kpis, Loading, Tabs, Trend } from '../../ui/kit';
import type { PageProps } from '../registry';
import { Presence } from '../dashboard/Presence';
import { LivreursTable } from '../dashboard/Livreurs';
import { delivTone, KpiBox, rangeOf } from '../dashboard/util';

type P = 'today' | 'yesterday' | '7d' | '30d' | 'month';
const PERIODS: P[] = ['today', 'yesterday', '7d', '30d', 'month'];

export function Home(_: PageProps) {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const s = session!;
  if (!has('confirmation', 'suivi', 'depot')) {
    const livreur = s.roles.includes('livreur');
    return (
      <section className="card">
        <h2>{t('home.hello', { name: s.profile.name })}</h2>
        <p className="muted">{livreur ? t('home.livreurHint') : t('home.soon')}</p>
        {livreur && (
          <div className="row">
            <a className="btn primary" href="#/tournee">
              {t('home.seeRound')}
            </a>
          </div>
        )}
      </section>
    );
  }
  return <HomeStats />;
}

function HomeStats() {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const [period, setPeriod] = useState<P>('today');
  const range = rangeOf(period);
  const isAdmin = session!.isAdmin;
  const showAgents = has('confirmation', 'suivi');
  const showLiv = isAdmin || has('suivi');
  const showPresence = has('agent_manager', 'vendeur');

  return (
    <>
      <Now />
      <section className="card">
        <div className="card-head">
          <h2>
            {t('home.period')} <small className="px-vs">{t('home.vsLong', { vs: t(`home.vs.${period}`) })}</small>
          </h2>
          <Tabs value={period} onChange={setPeriod} items={PERIODS.map((p) => ({ value: p, label: t(`home.periods.${p}`) }))} />
        </div>
        <Overview range={range} vs={t(`home.vs.${period}`)} />
      </section>
      {showAgents && <Agents range={range} />}
      {showLiv && <LivCard range={range} />}
      {showPresence && <Presence />}
    </>
  );
}

function Now() {
  const { t } = useTranslation();
  const { has, session } = useSession();
  const q = useRpc('stats.now', {}, { refetchInterval: 60_000 });
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('home.now')}</h2>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        q.data && (
          <Kpis>
            <KpiBox icon="phone" label={t('home.toCall')} value={n(q.data.toCall)} sub={t('home.callbacksLater', { n: q.data.callbacksLater })} tone={q.data.toCall ? 'warn' : undefined} href={has('confirmation') ? '#/confirmation' : undefined} />
            <KpiBox icon="alert" label={t('home.noStock')} value={n(q.data.noStock)} sub={t('home.noStockSub')} tone={q.data.noStock ? 'bad' : undefined} href="#/commandes" />
            <KpiBox icon="package" label={t('home.toPrepare')} value={n(q.data.toPrepare)} sub={t('home.prepared', { n: q.data.prepared })} href={has('depot') ? '#/depot' : undefined} />
            <KpiBox icon="truck" label={t('home.onRoad')} value={n(q.data.onRoad)} sub={t('home.failed', { n: q.data.failed })} tone={q.data.failed ? 'warn' : undefined} href={has('suivi') ? '#/suivi' : undefined} />
            {session!.isAdmin && q.data.moneyDue !== null && (
              <KpiBox icon="wallet" label={t('home.moneyDue')} value={da(q.data.moneyDue)} sub={t('home.moneyDueSub', { n: q.data.moneyDueCount ?? 0 })} tone={q.data.moneyDue ? 'info' : undefined} href="#/caisse" />
            )}
          </Kpis>
        )
      )}
    </section>
  );
}

function Overview({ range, vs }: { range: { from: string; to: string }; vs: string }) {
  const { t } = useTranslation();
  const q = useRpc('stats.overview', range);
  // the same length just before, for the ▲ / ▼ trends
  // same length just before; a period still running (today, this month) is compared up to the same moment
  const f0 = Date.parse(range.from);
  const len = Date.parse(range.to) - f0;
  const upTo = Math.min(Date.now(), Date.parse(range.to)) - f0;
  const prevRange = { from: new Date(f0 - len).toISOString(), to: new Date(f0 - len + upTo).toISOString() };
  const pq = useRpc('stats.overview', prevRange);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const p = pq.data;
  const ch = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || b === 0 ? null : (a - b) / b);
  return (
    <Kpis>
      <KpiBox icon="list" href="#/commandes" label={t('home.received')} value={n(d.received)} trend={<Trend v={ch(d.received, p?.received)} vs={vs} />} sub={t('home.receivedTodo', { n: d.receivedTodo })} />
      <KpiBox icon="check" href="#/confirmation/confirmees" label={t('home.confirmed')} value={n(d.confirmed)} trend={<Trend v={ch(d.confirmed, p?.confirmed)} vs={vs} />} sub={t('home.rate', { v: pct(d.confRate) })} rate={d.confRate} tone="ok" />
      <KpiBox icon="xcircle" href="#/commandes/annulees" label={t('home.cancelled')} value={n(d.cancelled)} trend={<Trend v={ch(d.cancelled, p?.cancelled)} goodDown vs={vs} />} sub={t('home.cancelledSub')} tone={d.cancelled ? 'bad' : undefined} zero={!d.cancelled} />
      <KpiBox icon="route" href="#/suivi" label={t('home.shipped')} value={n(d.shipped)} trend={<Trend v={ch(d.shipped, p?.shipped)} vs={vs} />} sub={t('home.shippedSub', { n: d.shippedOnRoad })} />
      <KpiBox icon="truck" href="#/commandes/livrees" label={t('home.delivered')} value={n(d.delivered)} trend={<Trend v={ch(d.delivered, p?.delivered)} vs={vs} />} sub={t('home.deliveryRate', { v: pct(d.deliveryRate) })} rate={d.deliveryRate} tone="ok" />
      <KpiBox icon="undo" href="#/depot/retours" label={t('home.returns')} value={n(d.returns)} trend={<Trend v={ch(d.returns, p?.returns)} goodDown vs={vs} />} sub={t('home.returnsSub')} tone={d.returns ? 'bad' : undefined} zero={!d.returns} />
      <KpiBox icon="coins" href="#/caisse/done" label={t('home.cashed')} value={da(d.cashed)} trend={<Trend v={ch(d.cashed, p?.cashed)} vs={vs} />} sub={t('home.cashedSub', { v: da(d.cashedProducts) })} />
    </Kpis>
  );
}

function Agents({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('stats.agents', range);
  const cols = ['agent', 'treated', 'confirmed', 'confRate', 'delivered', 'returned', 'deliveryRate'] as const;
  return (
    <Card title={t('home.agents')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <p className="muted">{t('home.noAgents')}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th key={c} className={i ? 'num' : undefined}>
                    {t(`home.col.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id}>
                  <td data-l={t('home.col.agent')}>{a.name}</td>
                  <td className="num ltr" data-l={t('home.col.treated')}>{n(a.treated)}</td>
                  <td className="num ltr" data-l={t('home.col.confirmed')}>{n(a.confirmed)}</td>
                  <td className="num ltr" data-l={t('home.col.confRate')}>{pct(a.confRate)}</td>
                  <td className="num ltr" data-l={t('home.col.delivered')}>{n(a.delivered)}</td>
                  <td className="num ltr" data-l={t('home.col.returned')}>{n(a.returned)}</td>
                  <td className="num ltr" data-l={t('home.col.deliveryRate')}>{pct(a.deliveryRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LivCard({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const q = useRpc('stats.livreurs', { ...range, by: 'livreur' });
  return (
    <Card
      title={t('home.livreurs')}
      actions={
        has('agent_manager', 'vendeur') ? (
          <a className="btn small" href="#/dashboard/livreurs">
            {t('home.livDash')}
          </a>
        ) : undefined
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        q.data && (
          <>
            <Kpis>
              <KpiBox label={t('home.liv.inRound')} value={n(q.data.totals.inHand)} sub={t('home.liv.inRoundSub')} />
              <KpiBox label={t('home.liv.delivered')} value={n(q.data.totals.delivered)} sub={t('home.liv.onPeriod')} tone="ok" zero={!q.data.totals.delivered} />
              <KpiBox label={t('home.liv.returns')} value={n(q.data.totals.returned)} sub={t('home.liv.onPeriod')} tone="bad" zero={!q.data.totals.returned} />
              <KpiBox label={t('home.liv.rate')} value={pct(q.data.totals.deliveryRate)} sub={t('home.liv.rateSub')} tone={delivTone(q.data.totals.deliveryRate)} />
              <KpiBox label={t('home.liv.uncashed')} value={da(q.data.totals.uncashed)} sub={t('home.liv.uncashedSub')} />
            </Kpis>
            <Card title={t('home.liv.byLivreur')}>
              <LivreursTable rows={q.data.all} simple />
            </Card>
          </>
        )
      )}
    </Card>
  );
}
