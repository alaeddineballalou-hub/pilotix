// The agency's Réglages › Notifications (owner's ask, 25 Nov 2026: « easy to understand and control, like the seller
// one »): the seller's Management › Notifications look (pages/admin/Notifications.tsx, « Liste + détail »): the list on
// the left — each notification, who gets it in a few words, its switch — and the chosen one on the right: what it is,
// who gets it and how, the people chosen by name, its sound, when the phone rings, and what the person sees. On a phone
// the list, then the chosen one with a way back. Then the alerts on numbers (KPI), the same way.
// A notification about an order goes by itself to that order's own agent; the timing of « C'est l'heure d'appeler » is
// the seller's (his calling hours, his chrono), never the agency's (agencybell.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { bellSound, BellSound, unlockAudio } from '../../lib/sound';
import { useMedia } from '../../lib/useMedia';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Back, Switch } from '../admin/Notifications';
import '../admin/notifications.css';

type Data = Out<'agency.notify.get'>;
type Row = Data['kinds'][number];
type Kind = Row['kind'];
type Rule = Row['rule'];
type Role = Row['can'][number];
type Phone = Rule['phone'];
type KpiRow = Data['kpis'][number];
type Metric = KpiRow['metric'];
type KpiRule = { threshold: number; roles: Role[]; people?: number[] };
type Sel = { k: Kind } | { m: Metric };

const ICON: Record<Kind, string> = {
  delegatedConfirmation: 'inbox', order: 'cart', due: 'phone', delivered: 'coins', returned: 'undo', cancelled: 'xcircle',
  alert: 'alert', delegatedFollow: 'truck', follow: 'route', delegatedSav: 'headset', sav: 'ticket', seller: 'store',
  payment: 'wallet', team: 'users', access: 'key',
};
/** each kind's colour and sound: the bell's (layout/bell.css, lib/sound.ts), as agencybell.ts › tellAgency rings it */
const BELL: Record<Kind, BellSound> = {
  delegatedConfirmation: 'info', order: 'order', due: 'callback', delivered: 'delivered', returned: 'returned', cancelled: 'cancelled',
  alert: 'alert', delegatedFollow: 'info', follow: 'alert', delegatedSav: 'info', sav: 'info', seller: 'info', payment: 'info',
  team: 'info', access: 'info',
};
const LOUD = new Set<BellSound>(['order', 'callback', 'alert']);
/** the kinds about the orders, then the agency's own news */
const ORDERS = new Set<Kind>(['delegatedConfirmation', 'order', 'due', 'delivered', 'returned', 'cancelled', 'alert', 'delegatedFollow', 'follow', 'delegatedSav', 'sav']);
/** the roles that are the order's (or ticket's, or person's) own people: they get their own line, about their own work */
const SELF: Partial<Record<Kind, readonly Role[]>> = {
  order: ['confirmation'], due: ['confirmation'], delivered: ['confirmation', 'suivi'], returned: ['confirmation', 'suivi'],
  cancelled: ['confirmation', 'suivi'], alert: ['suivi'], follow: ['suivi'], sav: ['sav'], access: ['confirmation', 'suivi', 'sav'],
};
/** the kinds whose others (team leaders, administrators) get a line of their own, about their team */
const TEAM_LINE = new Set<Kind>(['order', 'due', 'follow']);
const PHONES: Phone[] = ['work', 'always', 'never'];

const sameRule = (a: Rule, b: Rule) => a.on === b.on && a.phone === b.phone && [...a.roles].sort().join() === [...b.roles].sort().join() && [...a.people].sort().join() === [...b.people].sort().join();
const sameKpi = (a: KpiRule | null | undefined, b: KpiRule | null | undefined) =>
  !a || !b ? !a === !b : a.threshold === b.threshold && [...a.roles].sort().join() === [...b.roles].sort().join() && [...(a.people ?? [])].sort().join() === [...(b.people ?? [])].sort().join();
const kpiOk = (r: KpiRule | null) => !r || (Number.isInteger(r.threshold) && r.threshold >= 1 && r.threshold <= 100000 && (r.roles.length > 0 || !!r.people?.length));

export function AgencyNotifications() {
  const { t } = useTranslation();
  const q = useRpc('agency.notify.get', {});
  const save = useAction('agency.notify.set', { success: t('notifs.saved') });
  // a phone or a tablet: the list, then the chosen one (with a way back)
  const narrow = useMedia('(max-width: 1000px)');
  const grid = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<Kind, Rule>>>({});
  const [kdraft, setKdraft] = useState<Partial<Record<Metric, KpiRule | null>>>({});
  const data = q.data;
  const rules = useMemo(() => (data ? (Object.fromEntries(data.kinds.map((r) => [r.kind, draft[r.kind] ?? r.rule])) as Record<Kind, Rule>) : null), [data, draft]);
  const kpis = useMemo(
    () => (data ? (Object.fromEntries(data.kpis.map((r) => [r.metric, r.metric in kdraft ? kdraft[r.metric]! : (r.rule as KpiRule | null)])) as Record<Metric, KpiRule | null>) : null),
    [data, kdraft],
  );
  const changedKinds = useMemo(() => (data ? data.kinds.filter((r) => draft[r.kind] && !sameRule(draft[r.kind]!, r.rule)).map((r) => r.kind) : []), [data, draft]);
  const changedKpis = useMemo(() => (data ? data.kpis.filter((r) => r.metric in kdraft && !sameKpi(kdraft[r.metric], r.rule as KpiRule | null)).map((r) => r.metric) : []), [data, kdraft]);
  // on a phone, the list and the chosen one take turns: each starts at its top
  useEffect(() => {
    if (narrow && grid.current && grid.current.getBoundingClientRect().top < 0) grid.current.scrollIntoView({ block: 'start' });
  }, [open, sel, narrow]);
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!data || !rules || !kpis) return <Loading />;

  const count = changedKinds.length + changedKpis.length;
  const invalid = changedKpis.some((m) => !kpiOk(kpis[m]));
  const names = new Map(data.people.map((p) => [p.id, p.name]));
  const first: Sel | null = data.kinds[0] ? { k: data.kinds[0].kind } : data.kpis[0] ? { m: data.kpis[0].metric } : null;
  const cur = sel ?? first;
  const isSel = (s: Sel) => !!cur && ('k' in s ? 'k' in cur && cur.k === s.k : 'm' in cur && cur.m === s.m);
  const pick = (s: Sel) => {
    setSel(s);
    setOpen(true);
  };
  const edit = (k: Kind, f: (r: Rule) => Rule) => setDraft((d) => ({ ...d, [k]: f({ ...rules[k], roles: [...rules[k].roles], people: [...rules[k].people] }) }));
  const editKpi = (m: Metric, r: KpiRule | null) => setKdraft((d) => ({ ...d, [m]: r }));
  const roleShort = (k: Kind, role: Role) => t(`anotifs.short.${k}.${role}`, { defaultValue: t(`anotifs.short._.${role}`) });
  const summary = (k: Kind) => {
    const r = rules[k];
    if (!r.on) return t('notifs.off');
    const parts = r.roles.map((role) => roleShort(k, role));
    if (r.people.length) parts.push(t('notifs.peopleN', { count: r.people.length }));
    return parts.length ? parts.join(' · ') : t('notifs.nobody');
  };
  const kpiSummary = (m: Metric) => {
    const r = kpis[m];
    if (!r) return t('notifs.off');
    return t('anotifs.kpiShort', { n: r.threshold });
  };
  const reset = () => {
    setDraft({});
    setKdraft({});
  };
  const doSave = () => {
    const out: Partial<Record<Kind, Rule>> = {};
    for (const k of changedKinds) out[k] = draft[k]!;
    const outK: Partial<Record<Metric, KpiRule | null>> = {};
    for (const m of changedKpis) outK[m] = kpis[m];
    save.mutate({ ...(changedKinds.length ? { rules: out } : {}), ...(changedKpis.length ? { kpis: outK } : {}) }, { onSuccess: reset });
  };
  const showList = !narrow || !open;
  const showDetail = !narrow || open;
  const orders = data.kinds.filter((r) => ORDERS.has(r.kind));
  const agency = data.kinds.filter((r) => !ORDERS.has(r.kind));
  const kindRow = (r: Row) => {
    const k = r.kind;
    const on = isSel({ k });
    return (
      <div key={k} role="listitem" className={`px-nt-row${on && showDetail && !narrow ? ' on' : ''}${rules[k].on ? '' : ' off'}`}>
        <button type="button" className="px-nt-pick" aria-current={on ? 'true' : undefined} onClick={() => pick({ k })}>
          <span className={`px-bell-ic k-${BELL[k]}`}>
            <Icon name={ICON[k]} />
          </span>
          <span className="px-nt-rtx">
            <b>{t(`anotifs.kind.${k}`)}</b>
            <small>{summary(k)}</small>
          </span>
          {narrow && <Icon name="chevr" className="px-nt-go" />}
        </button>
        <Switch on={rules[k].on} label={t('notifs.turnOn', { what: t(`anotifs.kind.${k}`) })} onChange={(v) => edit(k, (x) => ({ ...x, on: v }))} />
      </div>
    );
  };

  return (
    <div className="px-nt">
      <div className="px-nt-head">
        <div>
          <h2>{t('notifs.title')}</h2>
          <p className="muted">{t('anotifs.help')}</p>
        </div>
        <div className="px-nt-actions">
          {count > 0 && <span className="px-nt-unsaved">{t('notifs.unsaved', { count })}</span>}
          {count > 0 && (
            <button type="button" className="btn" disabled={save.isPending} onClick={reset}>
              {t('notifs.cancel')}
            </button>
          )}
          <button type="button" className="btn primary" disabled={save.isPending || !count || invalid} onClick={doSave}>
            {t('notifs.save')}
          </button>
        </div>
      </div>

      <div className="px-nt-strip">
        <div className="px-nt-card">
          <span className="px-nt-cic">
            <Icon name="clock" />
          </span>
          <span className="px-nt-ctx">
            <b>{t('notifs.hours')}</b>
            <small>{t('anotifs.hoursText')}</small>
          </span>
        </div>
        <div className="px-nt-card">
          <span className="px-nt-cic">
            <Icon name="volume" />
          </span>
          <span className="px-nt-ctx">
            <b>{t('notifs.sounds')}</b>
            <small>{t('notifs.soundsText')}</small>
          </span>
        </div>
      </div>

      <div className="px-nt-grid" ref={grid}>
        {showList && (
          <div className="px-nt-list" role="list">
            {orders.length > 0 && <small className="px-nt-group">{t('anotifs.groupOrders')}</small>}
            {orders.map(kindRow)}
            {agency.length > 0 && <small className="px-nt-group">{t('anotifs.groupAgency')}</small>}
            {agency.map(kindRow)}
            {data.kpis.length > 0 && <small className="px-nt-group">{t('anotifs.groupKpi')}</small>}
            {data.kpis.map(({ metric: m }) => {
              const on = isSel({ m });
              return (
                <div key={m} role="listitem" className={`px-nt-row${on && showDetail && !narrow ? ' on' : ''}${kpis[m] ? '' : ' off'}`}>
                  <button type="button" className="px-nt-pick" aria-current={on ? 'true' : undefined} onClick={() => pick({ m })}>
                    <span className="px-bell-ic k-info">
                      <Icon name="chart" />
                    </span>
                    <span className="px-nt-rtx">
                      <b>{t(`agency.alerts.metrics.${m}`)}</b>
                      <small>{kpiSummary(m)}</small>
                    </span>
                    {narrow && <Icon name="chevr" className="px-nt-go" />}
                  </button>
                  <Switch on={!!kpis[m]} label={t('notifs.turnOn', { what: t(`agency.alerts.metrics.${m}`) })} onChange={(v) => editKpi(m, v ? { threshold: 10, roles: ['admin'] } : null)} />
                </div>
              );
            })}
          </div>
        )}
        {showDetail &&
          cur &&
          ('k' in cur ? (
            <KindDetail
              key={cur.k}
              row={data.kinds.find((r) => r.kind === cur.k)!}
              rule={rules[cur.k]}
              people={data.people}
              names={names}
              changed={changedKinds.includes(cur.k)}
              onBack={narrow ? () => setOpen(false) : undefined}
              onEdit={(f) => edit(cur.k, f)}
            />
          ) : (
            <KpiDetail
              key={cur.m}
              row={data.kpis.find((r) => r.metric === cur.m)!}
              rule={kpis[cur.m]}
              people={data.people}
              names={names}
              changed={changedKpis.includes(cur.m)}
              onBack={narrow ? () => setOpen(false) : undefined}
              onEdit={(r) => editKpi(cur.m, r)}
            />
          ))}
      </div>
      {narrow && count > 0 && (
        <div className="px-nt-savebar">
          <span className="px-nt-unsaved">{t('notifs.unsaved', { count })}</span>
          <button type="button" className="btn" disabled={save.isPending} onClick={reset}>
            {t('notifs.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending || invalid} onClick={doSave}>
            {t('notifs.save')}
          </button>
        </div>
      )}
    </div>
  );
}

/** The people who can be chosen by name (those with a role this notification can go to), and the chosen ones. */
function People(p: { roles: readonly Role[]; chosen: readonly number[]; people: Data['people']; names: Map<number, string>; disabled: boolean; onChange: (ids: number[]) => void }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState('');
  const free = p.people.filter((x) => !p.chosen.includes(x.id) && x.roles.some((r) => p.roles.includes(r as Role)));
  return (
    <div className="px-nt-people">
      {p.chosen.map((id) => (
        <button key={id} type="button" className="px-nt-person" disabled={p.disabled} onClick={() => p.onChange(p.chosen.filter((y) => y !== id))} aria-label={t('notifs.removePerson', { who: p.names.get(id) ?? `#${id}` })}>
          {p.names.get(id) ?? `#${id}`} <Icon name="x" />
        </button>
      ))}
      <label className="px-nt-add">
        <Icon name="plus" />
        <select
          value={adding}
          disabled={p.disabled || !free.length}
          aria-label={t('notifs.addPerson')}
          onChange={(e) => {
            const id = Number(e.target.value);
            setAdding('');
            if (id) p.onChange([...p.chosen, id]);
          }}
        >
          <option value="">{t('notifs.addPerson')}</option>
          {free.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function KindDetail(p: { row: Row; rule: Rule; people: Data['people']; names: Map<number, string>; changed: boolean; onBack?: () => void; onEdit: (f: (r: Rule) => Rule) => void }) {
  const { t } = useTranslation();
  const { row, rule: r } = p;
  const k = row.kind;
  const self = SELF[k] ?? [];
  const flip = (role: Role) => p.onEdit((x) => ({ ...x, roles: x.roles.includes(role) ? x.roles.filter((y) => y !== role) : row.can.filter((y) => y === role || x.roles.includes(y)) }));
  const label = (role: Role) => t(`anotifs.role.${k}.${role}`, { defaultValue: t(`anotifs.role._.${role}`) });
  const desc = (role: Role) => t(`anotifs.roleDesc.${k}.${role}`, { defaultValue: t(`anotifs.roleDesc._.${role}`) });
  const listen = () => {
    unlockAudio();
    window.setTimeout(() => bellSound(BELL[k], LOUD.has(BELL[k])), 30);
  };
  const selfShown = r.on && r.roles.some((role) => self.includes(role));
  const others = r.on && (r.roles.some((role) => !self.includes(role)) || r.people.length > 0);
  return (
    <div className="px-nt-detail">
      <Back onBack={p.onBack} />
      <div className="px-nt-dhead">
        <span className={`px-bell-ic k-${BELL[k]} px-nt-big`}>
          <Icon name={ICON[k]} />
        </span>
        <span className="px-nt-rtx">
          <b className="px-nt-h">{t(`anotifs.kind.${k}`)}</b>
          <small>{t(`anotifs.desc.${k}`)}</small>
        </span>
        <Switch on={r.on} label={t('notifs.turnOn', { what: t(`anotifs.kind.${k}`) })} onChange={(v) => p.onEdit((x) => ({ ...x, on: v }))} />
      </div>
      {!r.on && <p className="px-nt-offnote">{t('notifs.offNote')}</p>}
      {k === 'due' && (
        <p className="px-nt-note">
          <Icon name="clock" /> {t('anotifs.dueNote')}
        </p>
      )}

      <section className={r.on ? '' : 'px-nt-dim'}>
        <b className="px-nt-sh">{t('notifs.who')}</b>
        {row.can.map((role) => {
          const on = r.roles.includes(role);
          return (
            <div className="px-nt-role" key={role}>
              <label className="px-nt-check">
                <input type="checkbox" checked={on} disabled={!r.on} onChange={() => flip(role)} />
                <span>
                  <b>{label(role)}</b>
                  <small>{desc(role)}</small>
                </span>
              </label>
              {on ? <span className="px-nt-how">{self.includes(role) ? t('anotifs.howOwn') : t('notifs.how.notif')}</span> : <span className="px-nt-not">{t('notifs.notGet')}</span>}
            </div>
          );
        })}
        <People roles={row.can} chosen={r.people} people={p.people} names={p.names} disabled={!r.on} onChange={(ids) => p.onEdit((x) => ({ ...x, people: ids }))} />
        {self.length > 0 && <p className="px-nt-note">{t('anotifs.peopleNote')}</p>}
      </section>

      <div className={`px-nt-two${r.on ? '' : ' px-nt-dim'}`}>
        <section>
          <b className="px-nt-sh">{t('notifs.sound')}</b>
          <div className="px-nt-soundrow">
            <button type="button" className="px-nt-play" onClick={listen} aria-label={t('notifs.listenTo', { what: t(`notifs.soundName.${BELL[k]}`) })}>
              <span className="px-nt-pb">
                <Icon name="play" />
              </span>
              {t(`notifs.soundName.${BELL[k]}`)}
            </button>
            <small className="muted">{t('notifs.fixed')}</small>
          </div>
        </section>
        <section>
          <b className="px-nt-sh">{t('notifs.phone')}</b>
          <div className="px-nt-seg" role="group" aria-label={t('notifs.phone')}>
            {PHONES.map((ph) => (
              <button key={ph} type="button" aria-pressed={r.phone === ph} disabled={!r.on} onClick={() => p.onEdit((x) => ({ ...x, phone: ph }))}>
                {t(`notifs.phoneMode.${ph}`)}
              </button>
            ))}
          </div>
          <small className="muted">{r.phone === 'work' ? t('anotifs.phoneWork') : t(`notifs.phoneHint.${r.phone}`)}</small>
        </section>
      </div>

      {(selfShown || others) && (
        <section>
          <b className="px-nt-sh">{t('notifs.preview')}</b>
          <div className="px-nt-previews">
            {selfShown && <Pop who={t('anotifs.pvOwn')} k={k} title={t(`anotifs.sample.${k}.t`)} body={t(`anotifs.sample.${k}.b`)} />}
            {others &&
              (TEAM_LINE.has(k) ? (
                <Pop who={t('anotifs.pvTeam')} k={k} title={t(`anotifs.team.${k}.t`)} body={t(`anotifs.team.${k}.b`)} />
              ) : (
                !selfShown && <Pop who={t('anotifs.pvAll')} k={k} title={t(`anotifs.sample.${k}.t`)} body={t(`anotifs.sample.${k}.b`)} />
              ))}
          </div>
        </section>
      )}

      {!sameRule(r, row.def) && (
        <button type="button" className="px-nt-reset" onClick={() => p.onEdit(() => ({ ...row.def, roles: [...row.def.roles], people: [...row.def.people] }))}>
          {t('notifs.reset')}
        </button>
      )}
      {p.changed && !p.onBack && <p className="px-nt-unsaved">{t('notifs.unsavedHere')}</p>}
    </div>
  );
}

/** An alert on a number (KPI): on when the number reaches its threshold, for the roles and the people ticked. */
function KpiDetail(p: { row: KpiRow; rule: KpiRule | null; people: Data['people']; names: Map<number, string>; changed: boolean; onBack?: () => void; onEdit: (r: KpiRule | null) => void }) {
  const { t } = useTranslation();
  const { row, rule: r } = p;
  const m = row.metric;
  const allowed = row.allowed as Role[];
  const flip = (role: Role) => r && p.onEdit({ ...r, roles: r.roles.includes(role) ? r.roles.filter((y) => y !== role) : allowed.filter((y) => y === role || r.roles.includes(y)) });
  const wrong = !!r && !kpiOk(r);
  return (
    <div className="px-nt-detail">
      <Back onBack={p.onBack} />
      <div className="px-nt-dhead">
        <span className="px-bell-ic k-info px-nt-big">
          <Icon name="chart" />
        </span>
        <span className="px-nt-rtx">
          <b className="px-nt-h">{t(`agency.alerts.metrics.${m}`)}</b>
          <small>{t(`anotifs.kpiDesc.${m}`)}</small>
        </span>
        <Switch on={!!r} label={t('notifs.turnOn', { what: t(`agency.alerts.metrics.${m}`) })} onChange={(v) => p.onEdit(v ? { threshold: 10, roles: ['admin'] } : null)} />
      </div>
      {!r ? (
        <p className="px-nt-offnote">{t('notifs.offNote')}</p>
      ) : (
        <>
          <section>
            <b className="px-nt-sh">{t('anotifs.threshold')}</b>
            <div className="px-nt-numrow">
              <input
                className="in px-nt-num"
                type="number"
                inputMode="numeric"
                min={1}
                max={100000}
                aria-label={t('anotifs.threshold')}
                value={r.threshold || ''}
                onChange={(e) => p.onEdit({ ...r, threshold: Number(e.target.value) })}
              />
              <small className="muted">{t('anotifs.thresholdText')}</small>
            </div>
          </section>
          <section>
            <b className="px-nt-sh">{t('notifs.who')}</b>
            {allowed.map((role) => {
              const on = r.roles.includes(role);
              return (
                <div className="px-nt-role" key={role}>
                  <label className="px-nt-check">
                    <input type="checkbox" checked={on} onChange={() => flip(role)} />
                    <span>
                      <b>{t(`anotifs.kpiRole.${role}`)}</b>
                      <small>{t(`anotifs.kpiRoleDesc.${role === 'admin' || role === 'agent_manager' ? 'lead' : 'agent'}`)}</small>
                    </span>
                  </label>
                  {on ? <span className="px-nt-how">{t('notifs.how.notif')}</span> : <span className="px-nt-not">{t('notifs.notGet')}</span>}
                </div>
              );
            })}
            <People roles={allowed} chosen={r.people ?? []} people={p.people} names={p.names} disabled={false} onChange={(ids) => p.onEdit({ ...r, people: ids })} />
          </section>
          {wrong && <p className="px-nt-offnote">{t('anotifs.kpiWrong')}</p>}
        </>
      )}
      {p.changed && !p.onBack && <p className="px-nt-unsaved">{t('notifs.unsavedHere')}</p>}
    </div>
  );
}

/** What a line looks like (the bell's pop-up). */
function Pop({ who, k, title, body }: { who: string; k: Kind; title: string; body: string }) {
  const { t } = useTranslation();
  return (
    <div className="px-nt-pv">
      <small className="px-nt-pvw">{who}</small>
      <div className={`px-nt-pop k-${BELL[k]}`}>
        <span className={`px-bell-ic k-${BELL[k]}`}>
          <Icon name={ICON[k]} />
        </span>
        <span className="px-nt-rtx">
          <small className="px-nt-pk">{t(`bell.kind.${BELL[k]}`)}</small>
          <b>{title}</b>
          <small>{body}</small>
        </span>
      </div>
    </div>
  );
}
