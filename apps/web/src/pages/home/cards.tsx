// Two cards of the home page that an agent also finds on his Dashboard (he has no Accueil): what waits now in the shop,
// and (a suivi agent) the livreurs' parcels over the period.
import { useTranslation } from 'react-i18next';
import { da, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Card, ErrorBox, Kpis, Loading } from '../../ui/kit';
import { LivreursTable } from '../dashboard/Livreurs';
import { delivTone, KpiBox } from '../dashboard/util';

type R = { from: string; to: string };

/** What waits now in the shop: orders to call, without stock, to prepare, on the road (and, for an owner, money due). */
export function Now() {
  const { t } = useTranslation();
  const { has, session } = useSession();
  const q = useRpc('stats.now', {}, { refetchInterval: 60_000 });
  return (
    <section className="card hm-now">
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

/** The livreurs' parcels over the period: in their rounds, delivered, returned, their rate, the money they hold. */
export function LivCard({ range }: { range: R }) {
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
