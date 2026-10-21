// Accueil: "Maintenant" (live counters), "Période" (7 KPIs), agents table, livreurs card, presence.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Card, ErrorBox, Kpis, Loading, Tabs } from '../../ui/kit';
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
          <h2>{t('home.period')}</h2>
          <Tabs value={period} onChange={setPeriod} items={PERIODS.map((p) => ({ value: p, label: t(`home.periods.${p}`) }))} />
        </div>
        <Overview range={range} />
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
            <KpiBox label={t('home.toCall')} value={n(q.data.toCall)} sub={t('home.callbacksLater', { n: q.data.callbacksLater })} tone={q.data.toCall ? 'warn' : undefined} href={has('confirmation') ? '#/confirmation' : undefined} />
            <KpiBox label={t('home.noStock')} value={n(q.data.noStock)} sub={t('home.noStockSub')} tone={q.data.noStock ? 'bad' : undefined} href="#/commandes" />
            <KpiBox label={t('home.toPrepare')} value={n(q.data.toPrepare)} sub={t('home.prepared', { n: q.data.prepared })} href={has('depot') ? '#/depot' : undefined} />
            <KpiBox label={t('home.onRoad')} value={n(q.data.onRoad)} sub={t('home.failed', { n: q.data.failed })} tone={q.data.failed ? 'warn' : undefined} href={has('suivi') ? '#/suivi' : undefined} />
            {session!.isAdmin && q.data.moneyDue !== null && (
              <KpiBox label={t('home.moneyDue')} value={da(q.data.moneyDue)} sub={t('home.moneyDueSub', { n: q.data.moneyDueCount ?? 0 })} tone={q.data.moneyDue ? 'info' : undefined} href="#/caisse" />
            )}
          </Kpis>
        )
      )}
    </section>
  );
}

function Overview({ range }: { range: { from: string; to: string } }) {
  const { t } = useTranslation();
  const q = useRpc('stats.overview', range);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <Kpis>
      <KpiBox label={t('home.received')} value={n(d.received)} sub={t('home.receivedTodo', { n: d.receivedTodo })} />
      <KpiBox label={t('home.confirmed')} value={n(d.confirmed)} sub={t('home.rate', { v: pct(d.confRate) })} tone="ok" />
      <KpiBox label={t('home.cancelled')} value={n(d.cancelled)} sub={t('home.cancelledSub')} tone="bad" />
      <KpiBox label={t('home.shipped')} value={n(d.shipped)} sub={t('home.shippedSub', { n: d.shippedOnRoad })} />
      <KpiBox label={t('home.delivered')} value={n(d.delivered)} sub={t('home.deliveryRate', { v: pct(d.deliveryRate) })} tone="ok" />
      <KpiBox label={t('home.returns')} value={n(d.returns)} sub={t('home.returnsSub')} tone="bad" />
      <KpiBox label={t('home.cashed')} value={da(d.cashed)} sub={t('home.cashedSub', { v: da(d.cashedProducts) })} />
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
