import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { In } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { useMedia } from '../../lib/useMedia';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import '../admin/notifications.css';

type Settings = In<'agency.notifications.set'>;
type Group = keyof Settings['rules'];
type Metric = keyof NonNullable<Settings['kpis']>;
type Role = NonNullable<Settings['rules'][Group]>[number];
type KpiDraft = { threshold: number; roles: Role[]; people?: number[] };

export function AgencyNotifications() {
  const { t } = useTranslation();
  const query = useRpc('agency.notifications.get', {});
  const [rules, setRules] = useState<Settings['rules']>({});
  const [people, setPeople] = useState<NonNullable<Settings['people']>>({});
  const [kpis, setKpis] = useState<Partial<Record<Metric, KpiDraft | null>>>({});
  const [selection, setSelection] = useState<string>();
  const [detail, setDetail] = useState(false);
  const narrow = useMedia('(max-width: 1000px)');
  const save = useAction('agency.notifications.set', {
    success: t('notifs.saved'),
    onDone: () => { setRules({}); setKpis({}); setPeople({}); },
  });
  if (query.error) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data) return <Loading />;
  const { groups, kpis: metrics } = query.data;
  const entries = [
    ...groups.map(({ group }) => ({ key: `group:${group}`, label: t(`agency.alerts.groups.${group}`), icon: 'bell' })),
    ...metrics.map(({ metric }) => ({ key: `kpi:${metric}`, label: t(`agency.alerts.metrics.${metric}`), icon: 'chart' })),
  ];
  const selected = selection ?? entries[0]?.key;
  const changed = Object.keys(rules).length > 0 || Object.keys(kpis).length > 0 || Object.keys(people).length > 0;
  const invalid = Object.values(kpis).some((rule) => rule && (!Number.isInteger(rule.threshold) || rule.threshold < 1 || rule.threshold > 100000 || (!rule.roles.length && !rule.people?.length)));
  const roleLabel = (role: Role) => role === 'sav' ? t('agency.task.sav') : t(`roles.${role}`);
  const roleChecks = (allowed: readonly Role[], roles: readonly string[], change: (roles: Role[]) => void) =>
    allowed.map((role) => (
      <label key={role}>
        <input type="checkbox" checked={roles.includes(role)} onChange={() => change(allowed.filter((item) => item === role ? !roles.includes(item) : roles.includes(item)))} /> {roleLabel(role)}
      </label>
    ));
  const namedChecks = (allowed: readonly Role[], selected: readonly number[], change: (ids: number[]) => void) => (
    <details>
      <summary>{t('devices.namedRecipients')} ({selected.length})</summary>
      {query.data?.people?.filter((person) => person.roles.some((role) => allowed.includes(role))).map((person) => (
        <label key={person.id} style={{ display: 'block' }}>
          <input type="checkbox" checked={selected.includes(person.id)} onChange={(event) => change(
            event.target.checked ? [...selected, person.id] : selected.filter((id) => id !== person.id),
          )} /> {person.name}
        </label>
      ))}
    </details>
  );
  return (
    <div className="px-nt">
      <div className="px-nt-head">
        <div><h2>{t('notifs.title')}</h2><p className="muted">{t('agency.alerts.help')}</p></div>
        <div className="px-nt-actions">
          {changed && <button type="button" className="btn" disabled={save.isPending}
            onClick={() => { setRules({}); setKpis({}); setPeople({}); }}>{t('notifs.cancel')}</button>}
          <button type="button" className="btn primary" disabled={!changed || invalid || save.isPending}
            onClick={() => save.mutate({ rules, kpis, people })}>{t('common.save')}</button>
        </div>
      </div>
      <div className="px-nt-grid">
        {(!narrow || !detail) && <nav className="px-nt-list" aria-label={t('notifs.title')}>
          {entries.map(({ key, label, icon }) => (
            <div key={key} className={`px-nt-row${selected === key ? ' on' : ''}`}>
              <button type="button" className="px-nt-pick" aria-current={selected === key ? 'true' : undefined}
                onClick={() => { setSelection(key); setDetail(true); }}>
                <span className="px-bell-ic"><Icon name={icon} /></span>
                <span className="px-nt-rtx"><b>{label}</b></span>
              </button>
            </div>
          ))}
        </nav>}
        {(!narrow || detail) && <section className="px-nt-detail">
          {narrow && <button type="button" className="btn" onClick={() => setDetail(false)}>
            <Icon name="chevl" /> {t('notifs.title')}
          </button>}
      {groups.filter(({ group }) => `group:${group}` === selected).map(({ group, allowed, roles, people: saved }) => (
        <fieldset key={group} className="agx-sub">
          <legend>{t(`agency.alerts.groups.${group}`)}</legend>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {roleChecks(allowed, rules[group] ?? roles, (next) => setRules((old) => ({ ...old, [group]: next })))}
          </div>
          {namedChecks(allowed, people[group] ?? saved ?? [], (ids) => setPeople((old) => ({ ...old, [group]: ids })))}
        </fieldset>
      ))}
      {metrics.filter(({ metric }) => `kpi:${metric}` === selected).map(({ metric, allowed, rule: saved }) => {
        const rule = Object.prototype.hasOwnProperty.call(kpis, metric) ? kpis[metric] : saved;
        const edit = (next: KpiDraft | null) => setKpis((old) => ({ ...old, [metric]: next }));
        return (
          <fieldset key={metric} className="agx-sub">
            <legend>{t(`agency.alerts.metrics.${metric}`)}</legend>
            <label><input type="checkbox" checked={!!rule} onChange={() => edit(rule ? null : { threshold: 10, roles: ['admin'] })} /> {t('agency.alerts.enabled')}</label>
            {rule && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <label>{t('agency.alerts.threshold')} <input className="in" type="number" min={1} max={100000} value={rule.threshold || ''} onChange={(e) => edit({ ...rule, threshold: Number(e.target.value), roles: allowed.filter((role) => rule.roles.includes(role)) })} /></label>
                {roleChecks(allowed, rule.roles, (roles) => edit({ ...rule, roles }))}
                {namedChecks(allowed, rule.people ?? [], (people) => edit({ ...rule, roles: allowed.filter((role) => rule.roles.includes(role)), people }))}
              </div>
            )}
          </fieldset>
        );
      })}
        </section>}
      </div>
    </div>
  );
}
