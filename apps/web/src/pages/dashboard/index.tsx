// Dashboard: one tab per area (Confirmation, Dépôt, Suivi, Livreurs, SAV). Managers only see the areas the admin gave them.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { dur, n, pct } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Help, Kpis, Loading } from '../../ui/kit';
import type { PageProps } from '../registry';
import { LivreursArea } from './Livreurs';
import { TeamsArea } from './Teams';
import { Overview } from './Overview';
import { AnyPeriod, delivTone, KpiBox, rangeOf, useStored } from './util';
import './dashboard.css';

const AREAS = ['overview', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'] as const;
type Area = (typeof AREAS)[number];
/** areas an admin can give to an agent manager (the overview is for admin / vendeur only) */
const SCOPE_AREAS = AREAS.filter((a): a is Exclude<Area, 'overview'> => a !== 'overview');
type ScopeArea = (typeof SCOPE_AREAS)[number];
type Meta = Out<'stats.dashMeta'>;
const PERIODS: AnyPeriod[] = ['today', '7d', '30d', 'month', 'lastmonth'];

export function Dashboard({ sub }: PageProps) {
  const { t } = useTranslation();
  const meta = useRpc('stats.dashMeta', {});
  if (meta.isLoading) return <Loading />;
  if (meta.error) return <ErrorBox error={meta.error} onRetry={() => meta.refetch()} />;
  const m = meta.data!;
  const allowed = AREAS.filter((a) => (a === 'overview' ? m.seesAll : (m.areas as string[]).includes(a)));
  if (!allowed.length) return <div className="empty-box">{t('dashboard.noArea')}</div>;
  const area: Area = allowed.includes(sub as Area) ? (sub as Area) : allowed[0];
  return (
    <>
      <nav className="bjm-bar bjd-tabs" aria-label={t('dashboard.areasAria')} data-g="dashboard">
        {allowed.map((a) => (
          <a key={a} className={`bjm-p ${a === area ? 'on' : ''}`} href={`#/dashboard/${a}`} aria-current={a === area ? 'page' : undefined}>
            {t(`dashboard.areas.${a}`)}
          </a>
        ))}
      </nav>
      {area === 'overview' && <Overview />}
      {area === 'confirmation' && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>
                {t('dashboard.title', { area: t('dashboard.areas.confirmation') })}
                <Help text={m.seesAll ? t('dashboard.help.headAll') : t('dashboard.help.headMine')} label={t('dashboard.areas.confirmation')} />
              </h2>
            </div>
          </section>
          <TeamsArea meta={m} />
        </>
      )}
      {area === 'depot' && <PeriodArea area="depot" />}
      {area === 'suivi' && <PeriodArea area="suivi" />}
      {area === 'sav' && <PeriodArea area="sav" />}
      {area === 'livreurs' && <LivreursArea />}
      {m.canEditScope && area !== 'livreurs' && area !== 'overview' && <ScopeCard meta={m} />}
    </>
  );
}

/** Dépôt / Suivi / SAV: one card head with the period select (remembered), then KPIs and a table. */
function PeriodArea({ area }: { area: 'depot' | 'suivi' | 'sav' }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useStored<AnyPeriod>('dash.period', '7d');
  const range = rangeOf(PERIODS.includes(period) ? period : '7d');
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>
            {t('dashboard.title', { area: t(`dashboard.areas.${area}`) })}
            <Help text={t(`dashboard.help.${area}`)} label={t(`dashboard.areas.${area}`)} />
          </h2>
          <label className="field px-dperiod">
            <span className="lab">{t('dashboard.period')}</span>
            <select aria-label={t('dashboard.period')} value={PERIODS.includes(period) ? period : '7d'} onChange={(e) => setPeriod(e.target.value as AnyPeriod)}>
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`dashboard.periods.${p}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {area === 'depot' && <Depot range={range} />}
      {area === 'suivi' && <Suivi range={range} />}
      {area === 'sav' && <Sav range={range} />}
    </>
  );
}

type R = { from: string; to: string };

function Depot({ range }: { range: R }) {
  const { t } = useTranslation();
  const q = useRpc('stats.dashDepot', range);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <>
      <Kpis>
        <KpiBox label={t('dashboard.depot.toPrepare')} value={n(d.toPrepare)} sub={t('dashboard.depot.toPrepareSub')} tone={d.toPrepare ? 'warn' : undefined} href="#/depot/preparer" />
        <KpiBox label={t('dashboard.depot.prepared')} value={n(d.prepared)} sub={t('dashboard.depot.preparedSub')} href="#/depot/prepares" />
        <KpiBox label={t('dashboard.depot.dispatched')} value={n(d.dispatched)} sub={t('dashboard.depot.dispatchedSub')} href="#/depot/dispatchees" />
        <KpiBox label={t('dashboard.depot.out')} value={n(d.outForDelivery)} sub={t('dashboard.depot.outSub')} href="#/depot/enlivraison" />
        <KpiBox label={t('dashboard.depot.returning')} value={n(d.returning)} sub={t('dashboard.depot.returningSub')} tone={d.returning ? 'bad' : undefined} href="#/depot/retours" />
        <KpiBox label={t('dashboard.depot.shipped')} value={n(d.shipped)} sub={t('dashboard.depot.shippedSub')} />
        <KpiBox label={t('dashboard.depot.delay')} value={d.medianConfirmToShipMs === null ? '—' : dur(d.medianConfirmToShipMs)} sub={t('dashboard.depot.delaySub')} />
      </Kpis>
      <Card title={t('dashboard.depot.byPerson')}>
        {!d.people.length ? (
          <p className="muted">{t('dashboard.nothing')}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.depot.person')}</th>
                  <th className="num">{t('dashboard.depot.packed')}</th>
                  <th className="num">{t('dashboard.depot.shippedCol')}</th>
                  <th className="num">{t('dashboard.depot.returnsIn')}</th>
                </tr>
              </thead>
              <tbody>
                {d.people.map((p) => (
                  <tr key={p.id ?? 'auto'}>
                    <td data-l={t('dashboard.depot.person')}>{p.name ?? t('dashboard.depot.auto')}</td>
                    <td className="num ltr" data-l={t('dashboard.depot.packed')}>{n(p.packed)}</td>
                    <td className="num ltr" data-l={t('dashboard.depot.shippedCol')}>{n(p.shipped)}</td>
                    <td className="num ltr" data-l={t('dashboard.depot.returnsIn')}>{n(p.returns)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Suivi({ range }: { range: R }) {
  const { t } = useTranslation();
  const q = useRpc('stats.dashSuivi', range);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <>
      <Kpis>
        <KpiBox label={t('dashboard.suivi.alerts')} value={n(d.alerts)} sub={t('dashboard.suivi.alertsSub')} tone={d.alerts ? 'bad' : undefined} href="#/suivi/alertes" />
        <KpiBox label={t('dashboard.suivi.onRoad')} value={n(d.onRoad)} sub={t('dashboard.suivi.onRoadSub')} />
        <KpiBox label={t('dashboard.suivi.cancelledBack')} value={n(d.cancelledBack)} sub={t('dashboard.suivi.cancelledBackSub')} tone={d.cancelledBack ? 'warn' : undefined} href="#/suivi/swap" />
        <KpiBox label={t('dashboard.suivi.delivered')} value={n(d.delivered)} sub={t('dashboard.suivi.onPeriod')} tone="ok" zero={!d.delivered} />
        <KpiBox label={t('dashboard.suivi.returned')} value={n(d.returned)} sub={t('dashboard.suivi.returnedSub')} tone="bad" zero={!d.returned} />
        <KpiBox label={t('dashboard.suivi.rate')} value={pct(d.deliveryRate, 1)} sub={t('dashboard.suivi.rateSub')} tone={delivTone(d.deliveryRate)} />
      </Kpis>
      <Card title={t('dashboard.suivi.byAgent')}>
        {!d.agents.length ? (
          <p className="muted">{t('dashboard.nothing')}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.suivi.agent')}</th>
                  <th className="num">{t('dashboard.suivi.deliveredCol')}</th>
                  <th className="num">{t('dashboard.suivi.returnedCol')}</th>
                  <th className="num">{t('dashboard.suivi.rateCol')}</th>
                </tr>
              </thead>
              <tbody>
                {d.agents.map((a) => (
                  <tr key={a.id ?? 'none'}>
                    <td data-l={t('dashboard.suivi.agent')}>{a.name ?? t('dashboard.suivi.unassigned')}</td>
                    <td className="num ltr" data-l={t('dashboard.suivi.deliveredCol')}>{n(a.delivered)}</td>
                    <td className="num ltr" data-l={t('dashboard.suivi.returnedCol')}>{n(a.returned)}</td>
                    <td className="num ltr" data-l={t('dashboard.suivi.rateCol')}>{pct(a.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Sav({ range }: { range: R }) {
  const { t } = useTranslation();
  const q = useRpc('stats.dashSav', range);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const avgH = d.avgSettleMs === null ? null : (d.avgSettleMs / 3_600_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  return (
    <>
      <Kpis>
        <KpiBox label={t('dashboard.sav.open')} value={n(d.open)} sub={t('dashboard.sav.openSub')} tone={d.open ? 'bad' : undefined} href="#/sav/attente" />
        <KpiBox label={t('dashboard.sav.progress')} value={n(d.progress)} sub={t('dashboard.sav.progressSub')} />
        <KpiBox label={t('dashboard.sav.old')} value={n(d.older48h)} sub={t('dashboard.sav.oldSub')} tone={d.older48h ? 'bad' : undefined} />
        <KpiBox label={t('dashboard.sav.created')} value={n(d.created)} sub={t('dashboard.sav.createdSub')} />
        <KpiBox label={t('dashboard.sav.settled')} value={n(d.settled)} sub={avgH ? t('dashboard.sav.settledSub', { h: avgH }) : t('dashboard.sav.onPeriod')} tone="ok" zero={!d.settled} />
      </Kpis>
      <Card title={t('dashboard.sav.byPerson')}>
        {!d.people.length ? (
          <p className="muted">{t('dashboard.nothing')}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.sav.person')}</th>
                  <th className="num">{t('dashboard.sav.todo')}</th>
                  <th className="num">{t('dashboard.sav.settledCol')}</th>
                </tr>
              </thead>
              <tbody>
                {d.people.map((p) => (
                  <tr key={p.id ?? 'none'}>
                    <td data-l={t('dashboard.sav.person')}>{p.name ?? t('dashboard.sav.nobody')}</td>
                    <td className="num ltr" data-l={t('dashboard.sav.todo')}>{n(p.todo)}</td>
                    <td className="num ltr" data-l={t('dashboard.sav.settledCol')}>{n(p.settled)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/** "Qui gère quoi": the areas each agent manager sees in his dashboard (admin only, setting mgrScope). */
function ScopeCard({ meta }: { meta: Meta }) {
  const { t } = useTranslation();
  const init = () => Object.fromEntries(meta.managers.map((m) => [String(m.id), (meta.scope[String(m.id)]?.length ? meta.scope[String(m.id)] : ['confirmation']) as string[]]));
  const [scope, setScope] = useState<Record<string, string[]>>(init);
  useEffect(() => setScope(init()), [meta]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction('stats.saveScope', { success: t('dashboard.scope.saved') });
  if (!meta.managers.length) return null;
  const toggle = (id: string, a: ScopeArea) => {
    const cur = scope[id] ?? [];
    setScope({ ...scope, [id]: cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a] });
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {t('dashboard.scope.title')}
          <Help text={t('dashboard.scope.help')} label={t('dashboard.scope.title')} />
        </h2>
        <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ scope: scope as Record<string, ScopeArea[]> })}>
          {t('dashboard.scope.save')}
        </button>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('dashboard.scope.manager')}</th>
              {SCOPE_AREAS.map((a) => (
                <th key={a} className="num">
                  {t(`dashboard.areas.${a}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {meta.managers.map((m) => (
              <tr key={m.id}>
                <td data-l={t('dashboard.scope.manager')}>{m.name}</td>
                {SCOPE_AREAS.map((a) => (
                  <td key={a} className="num" data-l={t(`dashboard.areas.${a}`)}>
                    <input type="checkbox" aria-label={`${m.name} · ${t(`dashboard.areas.${a}`)}`} checked={(scope[String(m.id)] ?? []).includes(a)} onChange={() => toggle(String(m.id), a)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

