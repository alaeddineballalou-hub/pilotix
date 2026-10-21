// Management → Paie des agents: people per category with their plan, the plan cards (edit), the monthly payslips + CSV.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadCsv } from '../../lib/files';
import { da } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, Empty, ErrorBox, Field, Help, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { intOf, thisMonth } from './bits';

type Tab = 'agents' | 'managers' | 'suivi' | 'depot' | 'livreurs';
const TABS: Tab[] = ['agents', 'managers', 'suivi', 'depot', 'livreurs'];
const TAB_ROLE: Record<Tab, string> = { agents: 'confirmation', managers: 'agent_manager', suivi: 'suivi', depot: 'depot', livreurs: 'livreur' };

export function Paie() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('agents');
  const [month, setMonth] = useState(thisMonth());
  const cfg = useRpc('admin.pay.get', {});
  const pay = useRpc('admin.payroll', { month });
  const users = useRpc('users.list', {});
  const [edit, setEdit] = useState<'plan' | 'upsell' | null>(null);

  if (cfg.isLoading || users.isLoading) return <Loading />;
  if (cfg.error || users.error) return <ErrorBox error={cfg.error ?? users.error} onRetry={() => (cfg.refetch(), users.refetch())} />;
  const plans = cfg.data!.plans;
  const teams = cfg.data!.teams;
  const people = (users.data ?? []).filter((u) => u.active && (u.roles as string[]).includes(TAB_ROLE[tab]));
  const count = (tb: Tab) => (users.data ?? []).filter((u) => u.active && (u.roles as string[]).includes(TAB_ROLE[tb])).length;

  const planName = (tb: Tab) => t(`admin.pay.plan.${tb}`);
  const planKind = (tb: Tab) => t(`admin.pay.plan.${tb}Kind`);
  const planText = (tb: Tab) => {
    const p = plans;
    if (tb === 'agents') {
      const base = p.agent.threshold > 0 ? t('admin.pay.plan.agentsText', { under: da(p.agent.threshold - 1), below: da(p.agent.below), threshold: da(p.agent.threshold), above: da(p.agent.above) }) : t('admin.pay.plan.agentsFlat', { above: da(p.agent.above) });
      return p.agent.formOrder ? `${base} · ${t('admin.pay.plan.agentsForm', { form: da(p.agent.formOrder) })}` : base;
    }
    if (tb === 'managers') return t('admin.pay.plan.managersText', { rate: da(p.manager.perDelivered) });
    if (tb === 'suivi') return t('admin.pay.plan.suiviText', { rate: da(p.suivi.perDelivered) });
    if (tb === 'depot') return t('admin.pay.plan.depotText', { rate: da(p.depot.perPrepared) });
    return t('admin.pay.plan.livreursText', { light: da(p.livreur.light), heavy: da(p.livreur.heavy), kg: p.livreur.heavyFromKg });
  };
  const upsellName = t('admin.pay.plan.upsell', { bonus: da(plans.agent.upsellBonus) });
  const teamOf = (id: number) => teams.find((x) => x.agentIds.includes(id) || x.managerId === id)?.name;

  const lines = pay.data?.[tab] ?? [];
  const partText = (p: { label: string; qty: number; rate: number }) => t(`admin.pay.parts.${p.label}`, { qty: p.qty, rate: da(p.rate) });
  const exportCsv = () => {
    if (!pay.data) return;
    const h = t('admin.pay.csv', { returnObjects: true }) as Record<string, string>;
    const rows: (string | number)[][] = [[h.category, h.person, h.count, h.detail, h.pay]];
    for (const tb of TABS) for (const l of pay.data[tb]) rows.push([t(`admin.pay.tabs.${tb}`), l.name, l.count, l.parts.map(partText).join(' + '), l.pay]);
    rows.push(['', t('admin.pay.total'), '', '', pay.data.total]);
    downloadCsv(`paie-${month}.csv`, rows);
  };

  return (
    <div className="bjpp">
      <p className="muted small">{t('admin.pay.intro')}</p>
      <div className="tabs bjpp-tabs">
        {TABS.map((tb) => (
          <button key={tb} type="button" className={`tab ${tb === tab ? 'on' : ''}`} aria-pressed={tb === tab} onClick={() => setTab(tb)}>
            {t(`admin.pay.tabs.${tb}`)}
            <b className="ltr">{count(tb)}</b>
          </button>
        ))}
      </div>

      <Card title={t(`admin.pay.tabs.${tab}`)} help={t(`admin.pay.paidOn.${tab}`)}>
        {!people.length ? (
          <Empty>{t('admin.pay.noPeople')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.pay.colPerson')}</th>
                  <th>{t('admin.pay.colPlan')}</th>
                  {tab === 'agents' && <th>{t('admin.pay.colUpsell')}</th>}
                </tr>
              </thead>
              <tbody>
                {people.map((u) => (
                  <tr key={u.id}>
                    <td data-l={t('admin.pay.colPerson')}>
                      <div className="bjpp-cell">
                        <div className="grow">
                          <b>{u.name}</b>
                          <small>
                            {t('admin.pay.account', { role: t(`roles.${TAB_ROLE[tab]}`) })}
                            {(tab === 'agents' || tab === 'managers') && ` · ${teamOf(u.id) ? t('admin.pay.team', { team: teamOf(u.id) }) : t('admin.pay.noTeam')}`}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td data-l={t('admin.pay.colPlan')}>
                      <div className="bjpp-cell">
                        <div className="grow">
                          <b>{planName(tab)}</b>
                          <small>
                            {planKind(tab)} · {t('admin.pay.default').toLowerCase()}
                          </small>
                        </div>
                        <button type="button" className="btn small" onClick={() => setEdit('plan')}>
                          {t('admin.pay.change')}
                        </button>
                      </div>
                    </td>
                    {tab === 'agents' && (
                      <td data-l={t('admin.pay.colUpsell')}>
                        <div className="bjpp-cell">
                          <div className="grow">
                            <b>{upsellName}</b>
                            <small>
                              {t('admin.pay.plan.upsellKind')} · {t('admin.pay.default').toLowerCase()}
                            </small>
                          </div>
                          <button type="button" className="btn small" onClick={() => setEdit('upsell')}>
                            {t('admin.pay.change')}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t('admin.pay.plansTitle', { tab: t(`admin.pay.tabs.${tab}`) })}>
        <div className="bjpp-plans">
          <PlanCard name={planName(tab)} kind={planKind(tab)} text={planText(tab)} people={people.length} onEdit={() => setEdit('plan')} />
        </div>
      </Card>
      {tab === 'agents' && (
        <Card title={t('admin.pay.upsellTitle')} help={t('admin.pay.upsellHelp')}>
          <div className="bjpp-plans">
            <PlanCard name={upsellName} kind={t('admin.pay.plan.upsellKind')} text={t('admin.pay.plan.upsellText', { bonus: da(plans.agent.upsellBonus) })} people={people.length} onEdit={() => setEdit('upsell')} />
          </div>
        </Card>
      )}

      <div className="card">
        <div className="card-head">
          <h2>
            {t('admin.pay.slips')}
            <Help text={t('admin.pay.slipsHelp')} />
          </h2>
          <div className="row">
            <label className="row nowrap" style={{ gap: 6 }}>
              <span className="muted small">{t('admin.pay.month')}</span>
              <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 'auto' }} />
            </label>
            <button className="btn" onClick={exportCsv} disabled={!pay.data}>
              {t('admin.pay.export')}
            </button>
          </div>
        </div>
        {pay.isLoading ? (
          <Loading />
        ) : pay.error ? (
          <ErrorBox error={pay.error} onRetry={() => pay.refetch()} />
        ) : !lines.length ? (
          <Empty>{t('admin.pay.noPeople')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.pay.colPerson')}</th>
                  <th className="num">{t('admin.pay.colCount')}</th>
                  <th>{t('admin.pay.colDetail')}</th>
                  <th className="num">{t('admin.pay.colPay')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td data-l={t('admin.pay.colPerson')}>
                      <b>{l.name}</b>
                    </td>
                    <td data-l={t('admin.pay.colCount')} className="num">
                      <span className="ltr">{l.count}</span>
                    </td>
                    <td data-l={t('admin.pay.colDetail')}>{l.parts.length ? l.parts.map(partText).join(' + ') : <span className="muted">{t('admin.pay.nothing')}</span>}</td>
                    <td data-l={t('admin.pay.colPay')} className="num">
                      <b className="ltr">{da(l.pay)}</b>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} data-l="">
                    <b>{t('admin.pay.totalTab', { tab: t(`admin.pay.tabs.${tab}`) })}</b>
                  </td>
                  <td className="num" data-l={t('admin.pay.colPay')}>
                    <b className="ltr">{da(lines.reduce((s, l) => s + l.pay, 0))}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {pay.data && (
          <div className="okbox" style={{ marginTop: 10 }}>
            {t('admin.pay.total')} : <span className="ltr">{da(pay.data.total)}</span>
          </div>
        )}
      </div>

      {edit && <PlanForm tab={tab} upsell={edit === 'upsell'} plans={plans} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PlanCard({ name, kind, text, people, onEdit }: { name: string; kind: string; text: string; people: number; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bjpp-plan">
      <div className="bjpp-ph">
        <b>{name}</b>
        <span className="badge t-ok">{t('admin.pay.default')}</span>
      </div>
      <span className="chip">{kind}</span>
      <p className="small">{text}</p>
      <div className="row">
        <span className="muted small">{t('admin.pay.people', { count: people })}</span>
        <span className="grow" />
        <button type="button" className="btn small" onClick={onEdit}>
          {t('admin.pay.edit')}
        </button>
      </div>
    </div>
  );
}

type Plans = { agent: { threshold: number; below: number; above: number; upsellBonus: number; formOrder: number }; manager: { perDelivered: number }; suivi: { perDelivered: number }; depot: { perPrepared: number }; livreur: { light: number; heavy: number; heavyFromKg: number } };

function PlanForm({ tab, upsell, plans, onClose }: { tab: Tab; upsell: boolean; plans: Plans; onClose: () => void }) {
  const { t } = useTranslation();
  const [p, setP] = useState<Plans>(JSON.parse(JSON.stringify(plans)));
  const save = useAction('admin.pay.savePlans', { success: t('admin.pay.form.saved'), onDone: onClose });
  const n = (label: string, value: number, set: (v: number) => void, hint?: string, decimals = false) => (
    <Field label={label} hint={hint}>
      <input type="number" min={0} step={decimals ? 0.5 : 1} inputMode="numeric" value={value} onChange={(e) => set(decimals ? Math.max(0, Number(e.target.value) || 0) : intOf(e.target.value))} />
    </Field>
  );
  return (
    <Modal
      title={t('admin.pay.form.title', { tab: upsell ? t('admin.pay.upsellTitle') : t(`admin.pay.tabs.${tab}`) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate(p)}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="grid2">
        {upsell ? (
          n(t('admin.pay.form.upsell'), p.agent.upsellBonus, (v) => setP({ ...p, agent: { ...p.agent, upsellBonus: v } }))
        ) : tab === 'agents' ? (
          <>
            {n(t('admin.pay.form.threshold'), p.agent.threshold, (v) => setP({ ...p, agent: { ...p.agent, threshold: v } }), t('admin.pay.form.thresholdHint'))}
            {n(t('admin.pay.form.below'), p.agent.below, (v) => setP({ ...p, agent: { ...p.agent, below: v } }))}
            {n(t('admin.pay.form.above'), p.agent.above, (v) => setP({ ...p, agent: { ...p.agent, above: v } }))}
            {n(t('admin.pay.form.form'), p.agent.formOrder, (v) => setP({ ...p, agent: { ...p.agent, formOrder: v } }))}
          </>
        ) : tab === 'managers' ? (
          n(t('admin.pay.form.perDelivered'), p.manager.perDelivered, (v) => setP({ ...p, manager: { perDelivered: v } }))
        ) : tab === 'suivi' ? (
          n(t('admin.pay.form.perDelivered'), p.suivi.perDelivered, (v) => setP({ ...p, suivi: { perDelivered: v } }))
        ) : tab === 'depot' ? (
          n(t('admin.pay.form.perPrepared'), p.depot.perPrepared, (v) => setP({ ...p, depot: { perPrepared: v } }))
        ) : (
          <>
            {n(t('admin.pay.form.light'), p.livreur.light, (v) => setP({ ...p, livreur: { ...p.livreur, light: v } }))}
            {n(t('admin.pay.form.heavy'), p.livreur.heavy, (v) => setP({ ...p, livreur: { ...p.livreur, heavy: v } }))}
            {n(t('admin.pay.form.heavyFrom'), p.livreur.heavyFromKg, (v) => setP({ ...p, livreur: { ...p.livreur, heavyFromKg: v } }), undefined, true)}
          </>
        )}
      </div>
    </Modal>
  );
}
