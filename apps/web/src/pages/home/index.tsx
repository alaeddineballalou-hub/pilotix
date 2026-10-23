// Accueil, by role, under one period:
// - admin / vendeur: what is waiting now, the teams at a glance (who to help), the shop over the period, who is online;
// - agent manager: their team (what is late, its numbers against the targets, each member with what to work on), their
//   other teams, the shop over the period, who is online;
// - agent: what is waiting now, their own numbers next to their team's (their priority and how to improve it), the shop.
import { useTranslation } from 'react-i18next';
import { da, dayRange, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { useMedia } from '../../lib/useMedia';
import { Card, ErrorBox, Icon, Kpis, Loading, Trend } from '../../ui/kit';
import type { PageProps } from '../registry';
import { Presence } from '../dashboard/Presence';
import { LivreursTable } from '../dashboard/Livreurs';
import { Board, MemberDetail, useBoardPeriod } from '../dashboard/board/Board';
import { TeamHealth } from '../dashboard/board/Health';
import { AreaKey, AREAS } from '../dashboard/board/defs';
import { PeriodChips } from '../dashboard/board/parts';
import { delivTone, KpiBox, prevRangeOf } from '../dashboard/util';
import '../dashboard/board/board.css';

type R = { from: string; to: string };

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
  const per = useBoardPeriod('home', 'today');
  const lead = has('agent_manager', 'vendeur');
  const meta = useRpc('stats.dashMeta', {}, { enabled: lead });
  const prev = prevRangeOf(per.range);
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
      {meta.error ? (
        <ErrorBox error={meta.error} onRetry={() => meta.refetch()} />
      ) : !m ? (
        <Loading />
      ) : m.seesAll ? (
        <>
          <Now />
          <TeamHealth areas={areas} range={per.range} />
          <Period range={per.range} vs={vs} />
          <Presence />
        </>
      ) : (
        <>
          {areas.includes('confirmation') && <Board area="confirmation" compact range={per.range} />}
          <TeamHealth areas={areas.filter((a) => a !== 'confirmation')} range={per.range} title={areas.includes('confirmation') ? t('dashboard.tb.healthOthers') : undefined} />
          <Period range={per.range} vs={vs} />
          <Presence />
        </>
      )}
    </div>
  );
}

function Now() {
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

/** An agent's own numbers in each area they work in, next to their team's, with their rank (no one else's name). */
function MyDay({ range }: { range: R }) {
  const { t } = useTranslation();
  const wide = useMedia('(min-width: 1000px)');
  const q = useRpc('stats.me', range, { refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  return (
    <>
      {q.data.map((x) => {
        const area = x.area as AreaKey;
        const def = AREAS[area];
        // a count is compared with the average of those who worked, a rate with the team's
        const refOf = (k: string) => (x.team[k] === null || x.team[k] === undefined ? null : def.metrics[k]?.fmt === 'n' ? x.avg[k] ?? null : x.team[k]);
        return (
          <section key={area} className={`tb-card tb-myc tb-${area}`}>
            <div className="tb-ch tb-mych">
              <h3>
                <Icon name="chart" /> {t('dashboard.tb.myNumbers')}
                {q.data.length > 1 && <small> · {t(`dashboard.areas.${area}`)}</small>}
              </h3>
              {x.rank !== null && x.size > 1 && (
                <span className="tb-rank">
                  <Icon name="medal" /> {t('dashboard.tb.rank', { rank: x.rank, of: x.size })}
                  <small> · {t(`dashboard.tb.m.${area}.${x.rankOf}.l`)}</small>
                </span>
              )}
            </div>
            {x.me ? (
              <div className="tb-my">
                <MemberDetail area={area} v={x.me.v} p={x.me.p} days={x.me.days} reasons={x.me.reasons} team={x.team} teamDays={x.teamDays} refOf={refOf} mine wide={wide} />
              </div>
            ) : (
              <p className="tb-calm">{t('dashboard.tb.noWorkLong')}</p>
            )}
          </section>
        );
      })}
    </>
  );
}

function LivCard({ range }: { range: R }) {
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
