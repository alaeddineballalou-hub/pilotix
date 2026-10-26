// Dashboard: one tab per area (Confirmation, Dépôt, Suivi, Livreurs, SAV). Managers only see the areas the admin gave them.
import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { pageIsOn } from '../../lib/features';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Help, Icon, Loading } from '../../ui/kit';
import type { PageProps } from '../registry';
import { Board } from './board/Board';
import { ShopDoctor } from './Doctor';
import { LivreursArea } from './Livreurs';
import { TeamEditor } from './Teams';
import { Overview } from './Overview';
import './dashboard.css';

const AREAS = ['overview', 'doctor', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'] as const;
type Area = (typeof AREAS)[number];
/** areas an admin can give to an agent manager (the overview and Pilotix Doctor are for admin / vendeur only) */
const SCOPE_AREAS = AREAS.filter((a): a is Exclude<Area, 'overview' | 'doctor'> => a !== 'overview' && a !== 'doctor');
type ScopeArea = (typeof SCOPE_AREAS)[number];
type Meta = Out<'stats.dashMeta'>;

export function Dashboard({ sub }: PageProps) {
  const { t } = useTranslation();
  const meta = useRpc('stats.dashMeta', {});
  if (meta.isLoading) return <Loading />;
  if (meta.error) return <ErrorBox error={meta.error} onRetry={() => meta.refetch()} />;
  const m = meta.data!;
  const allowed = AREAS.filter((a) => (a === 'overview' || a === 'doctor' ? m.seesAll : (m.areas as string[]).includes(a)) && pageIsOn('dashboard', a));
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
      {area === 'overview' && <Overview areas={m.areas as ScopeArea[]} />}
      {area === 'doctor' && <ShopDoctor />}
      {area === 'confirmation' && (
        <Board
          key={area}
          area="confirmation"
          extra={
            (m.canEditTeams || m.canEditScope) && (
              <Fold icon="usercog" title={t('dashboard.tb.settings')} sub={t('dashboard.tb.settingsSub')}>
                {m.canEditTeams && <TeamEditor meta={m} />}
                {m.canEditScope && <ScopeCard meta={m} />}
              </Fold>
            )
          }
        />
      )}
      {(area === 'depot' || area === 'suivi' || area === 'sav') && <Board key={area} area={area} />}
      {area === 'livreurs' && (
        <Board
          key={area}
          area="livreurs"
          extra={
            <Fold icon="wallet" title={t('dashboard.tb.livDetail')} sub={t('dashboard.tb.livDetailSub')}>
              <LivreursArea />
            </Fold>
          }
        />
      )}
    </>
  );
}

/** A part of the page kept folded (settings, details): its title, what is inside. */
function Fold({ icon, title, sub, children }: { icon: string; title: string; sub: string; children: ReactNode }) {
  return (
    <details className="tb-set">
      <summary>
        <Icon name={icon} />
        <b>{title}</b>
        <small>{sub}</small>
        <Icon name="chevron" />
      </summary>
      <div className="tb-set-b">{children}</div>
    </details>
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

