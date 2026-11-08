// Accueil, by role, under one period:
// - admin / vendeur: what is waiting now, Co-Pilot (what is going wrong, with what to do), the teams at a glance (who to help), the shop over the period, who is online;
// - agent manager: their team (what is late, its numbers against the targets, each member with what to work on), their
//   other teams, the shop over the period, who is online;
// - agent: their own Co-Pilot, what is waiting now, their own numbers next to their team's (their priority and how to improve it), the shop.
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dayRange, n, pct } from '../../lib/format';
import { featureIsOn } from '../../lib/features';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Kpis, Loading, Trend } from '../../ui/kit';
import type { PageProps } from '../registry';
import { ShopDoctor } from '../dashboard/Doctor';
import { ProBanner } from '../pro/banner';
import { Presence } from '../dashboard/Presence';
import { Board, useBoardPeriod } from '../dashboard/board/Board';
import { TeamHealth } from '../dashboard/board/Health';
import { AreaKey } from '../dashboard/board/defs';
import { PeriodChips } from '../dashboard/board/parts';
import { KpiBox, prevRangeOf } from '../dashboard/util';
import { MyDay } from '../dashboard/Mine';
import '../dashboard/board/board.css';
import { useAllMode } from '../../layout/AllBoutiques';
import { NoPlanAlert } from '../caisse/NoPlanAlert';
import { LivCard, Now } from './cards';

type R = { from: string; to: string };

export function Home(_: PageProps) {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const all = useAllMode();
  const s = session!;
  if (!has('confirmation', 'suivi', 'depot')) {
    const livreur = s.roles.includes('livreur');
    return (
      <>
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
      {s.roles.includes('marketer') && featureIsOn('dashboard/doctor') && <ShopDoctor card />}
      <ProBanner />
      </>
    );
  }
  return all.on ? (
    <Suspense fallback={<Loading />}>
      <AllHome />
    </Suspense>
  ) : (
    <HomeStats />
  );
}
const AllHome = lazy(() => import('../boutiques/all').then((m) => ({ default: () => <m.BoutiquesHome /> })));

function HomeStats() {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const per = useBoardPeriod('home', 'today');
  const lead = has('agent_manager', 'vendeur');
  const meta = useRpc('stats.dashMeta', {}, { enabled: lead });
  const prev = prevRangeOf(per.range);
  const copilot = featureIsOn('dashboard/doctor');
  const vs = t('dashboard.tb.vs', { range: dayRange(prev.from, prev.to) });

  const head = (
    <header className="tb-head hm-head">
      <div className="tb-ht">
        <h2>{t('home.hello', { name: session!.profile.name })}</h2>
        <p className="tb-cap">
          {dayRange(per.range.from, per.range.to)}
          <span className="tb-capvs"> · {vs}</span>
        </p>
      </div>
      <PeriodChips value={per.period} onChange={per.setPeriod} custom={per.custom} onCustom={per.setCustom} />
    </header>
  );

  if (!lead)
    return (
      <div className="tb hm">
        {head}
        <NoPlanAlert admins={false} />
        {copilot && <ShopDoctor card />}
        <Now />
        <MyDay range={per.range} />
        <Period range={per.range} vs={vs} />
        {has('suivi') && <LivCard range={per.range} />}
      </div>
    );

  const m = meta.data;
  const areas = (m?.areas ?? []) as AreaKey[];
  return (
    <div className="tb hm">
      {head}
      <NoPlanAlert admins={false} />
      {meta.error ? (
        <ErrorBox error={meta.error} onRetry={() => meta.refetch()} />
      ) : !m ? (
        <Loading />
      ) : m.seesAll ? (
        <>
          {copilot && <ShopDoctor card />}
          <Now />
          <TeamHealth areas={areas} range={per.range} />
          <Period range={per.range} vs={vs} />
          <Presence />
        </>
      ) : (
        <>
          {copilot && <ShopDoctor card />}
          {areas.includes('confirmation') && <Board area="confirmation" compact range={per.range} />}
          <TeamHealth areas={areas.filter((a) => a !== 'confirmation')} range={per.range} title={areas.includes('confirmation') ? t('dashboard.tb.healthOthers') : undefined} />
          <Period range={per.range} vs={vs} />
          <Presence />
        </>
      )}
    </div>
  );
}

/** The shop over the period, each number next to the period before. */
function Period({ range, vs }: { range: R; vs: string }) {
  const { t } = useTranslation();
  const q = useRpc('stats.overview', range);
  const pq = useRpc('stats.overview', prevRangeOf(range));
  const d = q.data;
  const p = pq.data;
  const ch = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || b === 0 ? null : (a - b) / b);
  return (
    <section className="card hm-per">
      <div className="card-head">
        <h2>
          {t('home.period')} <small className="px-vs">{vs}</small>
        </h2>
      </div>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <Kpis>
          <KpiBox icon="list" href="#/commandes" label={t('home.received')} value={n(d.received)} trend={<Trend v={ch(d.received, p?.received)} vs={vs} />} sub={t('home.receivedTodo', { n: d.receivedTodo })} />
          <KpiBox icon="check" href="#/confirmation/confirmees" label={t('home.confirmed')} value={n(d.confirmed)} trend={<Trend v={ch(d.confirmed, p?.confirmed)} vs={vs} />} sub={t('home.rate', { v: pct(d.confRate) })} rate={d.confRate} tone="ok" />
          <KpiBox icon="xcircle" href="#/commandes/annulees" label={t('home.cancelled')} value={n(d.cancelled)} trend={<Trend v={ch(d.cancelled, p?.cancelled)} goodDown vs={vs} />} sub={t('home.cancelledSub')} tone={d.cancelled ? 'bad' : undefined} zero={!d.cancelled} />
          <KpiBox icon="route" href="#/suivi" label={t('home.shipped')} value={n(d.shipped)} trend={<Trend v={ch(d.shipped, p?.shipped)} vs={vs} />} sub={t('home.shippedSub', { n: d.shippedOnRoad })} />
          <KpiBox icon="truck" href="#/commandes/livrees" label={t('home.delivered')} value={n(d.delivered)} trend={<Trend v={ch(d.delivered, p?.delivered)} vs={vs} />} sub={t('home.deliveryRate', { v: pct(d.deliveryRate) })} rate={d.deliveryRate} tone="ok" />
          <KpiBox icon="undo" href="#/depot/retours" label={t('home.returns')} value={n(d.returns)} trend={<Trend v={ch(d.returns, p?.returns)} goodDown vs={vs} />} sub={t('home.returnsSub')} tone={d.returns ? 'bad' : undefined} zero={!d.returns} />
          <KpiBox icon="coins" href="#/caisse/done" label={t('home.cashed')} value={da(d.cashed)} trend={<Trend v={ch(d.cashed, p?.cashed)} vs={vs} />} sub={t('home.cashedSub', { v: da(d.cashedProducts) })} />
        </Kpis>
      )}
    </section>
  );
}
