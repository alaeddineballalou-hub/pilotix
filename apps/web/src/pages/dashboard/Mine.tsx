// Dashboard of a person who is not a manager (Dashboard › Mon tableau de bord): their own numbers only, over the period
// they choose — in each area they work in (Confirmation, Suivi, Dépôt) next to their team's, with their rank (no one
// else's name), and a livreur's own parcels, deliveries, returns, the money he holds and his pay.
// An agent who leads no one has no Accueil: this is his home — his own Co-Pilot first, folded (his score, what to put
// right, with what to do), what waits now, his numbers, and a suivi agent the livreurs' parcels.
import { useTranslation } from 'react-i18next';
import { featureIsOn } from '../../lib/features';
import { da, dayRange, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { useMedia } from '../../lib/useMedia';
import { ErrorBox, Icon, Kpis, Loading } from '../../ui/kit';
import { MemberDetail, useBoardPeriod } from './board/Board';
import { AreaKey, AREAS } from './board/defs';
import { PeriodChips } from './board/parts';
import { delivTone, KpiBox, prevRangeOf } from './util';
import { ShopDoctor } from './Doctor';
import { LivCard, Now } from '../home/cards';
import { NoPlanAlert } from '../caisse/NoPlanAlert';
import './board/board.css';

type R = { from: string; to: string };

/** Dashboard of an agent, a depot worker or a livreur: their own numbers, never anyone else's. */
export function MyDashboard() {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const per = useBoardPeriod('dash.mine', '7d');
  const prev = prevRangeOf(per.range);
  const roles = session!.roles;
  const works = roles.includes('confirmation') || roles.includes('suivi') || roles.includes('depot');
  return (
    <div className="tb hm my-dash">
      <header className="tb-head hm-head">
        <div className="tb-ht">
          <h2>{t('dashboard.mine.title')}</h2>
          <p className="tb-cap">
            {dayRange(per.range.from, per.range.to)}
            <span className="tb-capvs"> · {t('dashboard.tb.vs', { range: dayRange(prev.from, prev.to) })}</span>
          </p>
        </div>
        <PeriodChips value={per.period} onChange={per.setPeriod} custom={per.custom} onCustom={per.setCustom} />
      </header>
      {works && <NoPlanAlert admins={false} />}
      {works && featureIsOn('dashboard/doctor') && <ShopDoctor fold />}
      {works && <Now />}
      {works && <MyDay range={per.range} />}
      {works && roles.includes('suivi') && <LivCard range={per.range} />}
      {has('livreur') && roles.includes('livreur') && <MyLivreur range={per.range} />}
      {!works && !roles.includes('livreur') && <div className="empty-box">{t('dashboard.mine.nothing')}</div>}
    </div>
  );
}

/** A livreur's own numbers over the period (and what he holds now). */
function MyLivreur({ range }: { range: R }) {
  const { t } = useTranslation();
  const q = useRpc('stats.myLivreur', range, { refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const m = q.data.me;
  return (
    <section className="tb-card tb-myc tb-livreurs">
      <div className="tb-ch tb-mych">
        <h3>
          <Icon name="bike" /> {t('dashboard.mine.livTitle')}
        </h3>
      </div>
      {!m ? (
        <p className="tb-calm">{t('dashboard.tb.noWorkLong')}</p>
      ) : (
        <Kpis>
          <KpiBox icon="truck" label={t('home.liv.inRound')} value={n(m.inHand)} sub={m.late ? t('dashboard.mine.late', { n: m.late }) : t('home.liv.inRoundSub')} tone={m.late ? 'warn' : undefined} href="#/tournee" />
          <KpiBox icon="checkcircle" label={t('home.liv.delivered')} value={n(m.delivered)} sub={t('home.liv.onPeriod')} tone="ok" zero={!m.delivered} />
          <KpiBox icon="undo" label={t('home.liv.returns')} value={n(m.returned)} sub={m.toBring ? t('dashboard.mine.toBring', { n: m.toBring }) : t('home.liv.onPeriod')} tone="bad" zero={!m.returned} />
          <KpiBox icon="chart" label={t('home.liv.rate')} value={pct(m.deliveryRate)} sub={t('home.liv.rateSub')} tone={delivTone(m.deliveryRate)} rate={m.deliveryRate} />
          <KpiBox icon="wallet" label={t('home.liv.uncashed')} value={da(m.uncashed)} sub={t('dashboard.mine.uncashedSub', { n: m.uncashedCount })} tone={m.uncashed ? 'info' : undefined} />
          <KpiBox icon="coins" label={t('dashboard.mine.pay')} value={da(m.share)} sub={t('dashboard.mine.paySub', { light: da(q.data.pay.light), heavy: da(q.data.pay.heavy) })} />
        </Kpis>
      )}
    </section>
  );
}

/** An agent's own numbers in each area they work in, next to their team's, with their rank (no one else's name). */
export function MyDay({ range }: { range: R }) {
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

