// Plans: what each one costs, how many accounts and orders it allows, and its menus and sub-menus.
import { featureList, featureOn, FEATURES } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n } from '../../lib/format';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { ErrorBox, Field, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { featureLabel, FeatureTree } from './FeatureTree';

type Plan = POut<'p.plans.list'>[number];

export function Plans({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.plans.list', {});
  const [edit, setEdit] = useState<Plan | 'new' | null>(null);
  const owner = staff.role === 'owner';
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const plans = q.data ?? [];
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.plans')}</h1>
          <p className="muted">{t('platform.plansSub')}</p>
        </div>
        {owner && (
          <button type="button" className="btn primary" onClick={() => setEdit('new')}>
            + {t('platform.plan.new')}
          </button>
        )}
      </div>
      <div className="pp-plans">
        {plans.map((p) => {
          const tops = FEATURES.filter((f) => !f.always && featureOn(p.features, f.key));
          return (
            <section key={p.id} className={`card pp-plan ${p.active ? '' : 'off'} ${p.system ? 'sys' : ''}`}>
              <div className="pp-plan-h">
                <h2>{p.name}</h2>
                {!p.active && <span className="chip">{t('platform.plan.inactive')}</span>}
                {p.system && <span className="chip pp-chip-own">{t('platform.ownShop')}</span>}
              </div>
              <p className="pp-price">
                {p.system ? (
                  t('platform.unlimited')
                ) : (
                  <>
                    <b className="ltr">{da(p.priceMonth)}</b> <span className="muted">{t('platform.plan.month')}</span>
                    {p.priceYear ? (
                      <small className="pp-year">
                        {' '}
                        · <b className="ltr">{da(p.priceYear)}</b> {t('platform.plan.year')}
                      </small>
                    ) : null}
                  </>
                )}
              </p>
              {p.description && <p className="muted small">{p.description}</p>}
              <ul className="pp-plan-lim">
                <li>{p.maxUsers === null ? t('platform.plan.usersAny') : t('platform.plan.users', { n: n(p.maxUsers) })}</li>
                <li>{p.maxDrivers === null ? t('platform.plan.driversAny') : t('platform.plan.drivers', { count: p.maxDrivers })}</li>
                <li>{p.maxOrdersMonth === null ? t('platform.plan.ordersAny') : t('platform.plan.orders', { n: n(p.maxOrdersMonth) })}</li>
                {!p.system && <li>{t('platform.plan.shops', { count: p.shops })}</li>}
              </ul>
              <div className="pp-plan-f">
                {p.features.includes('*') && !p.features.some((k) => k.startsWith('-')) ? (
                  <span className="chip">{t('platform.plan.everything')}</span>
                ) : (
                  tops.map((f) => {
                    // a menu with some of its sub-menus left out: how many it keeps
                    const subs = f.subs ?? [];
                    const kept = subs.filter((s) => featureOn(p.features, `${f.key}/${s}`)).length;
                    return (
                      <span key={f.key} className="chip">
                        {featureLabel(t, f.key)}
                        {kept < subs.length && <small className="ltr"> {kept}/{subs.length}</small>}
                      </span>
                    );
                  })
                )}
              </div>
              {owner && (
                <button type="button" className="btn small" onClick={() => setEdit(p)}>
                  {t('platform.plan.edit')}
                </button>
              )}
            </section>
          );
        })}
      </div>
      {edit && <PlanForm plan={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PlanForm({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    name: plan?.name ?? '',
    priceMonth: plan?.priceMonth ?? 0,
    priceYear: plan?.priceYear ?? null,
    maxUsers: plan?.maxUsers ?? null,
    maxDrivers: plan?.maxDrivers ?? null,
    maxOrdersMonth: plan?.maxOrdersMonth ?? null,
    description: plan?.description ?? '',
    public: plan?.public ?? true,
    active: plan?.active ?? true,
  });
  // the ticks: every menu item and sub-menu, from the plan's list
  const [on, setOn] = useState<Set<string>>(() => {
    const list = plan?.features ?? ['dashboard', 'commandes', 'produits', 'clients', 'livraison', 'management'];
    const s = new Set<string>();
    for (const x of FEATURES) {
      if (featureOn(list, x.key)) s.add(x.key);
      for (const sub of x.subs ?? []) if (featureOn(list, `${x.key}/${sub}`)) s.add(`${x.key}/${sub}`);
    }
    return s;
  });
  const save = usePAction('p.plans.save', { success: t('platform.saved'), onDone: onClose });
  const toggle = (k: string, v: boolean) => {
    const s = new Set(on);
    if (v) s.add(k);
    else s.delete(k);
    // a menu item ticked again comes back with all its sub-menus
    if (v && !k.includes('/')) for (const sub of FEATURES.find((x) => x.key === k)?.subs ?? []) s.add(`${k}/${sub}`);
    setOn(s);
  };
  const numOrNull = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v) || 0)));
  return (
    <Modal
      title={plan ? t('platform.plan.editTitle', { name: plan.name }) : t('platform.plan.new')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={f.name.trim().length < 2 || save.isPending}
            onClick={() =>
              save.mutate({
                ...(plan ? { id: plan.id } : {}),
                name: f.name.trim(),
                priceMonth: f.priceMonth,
                priceYear: f.priceYear,
                maxUsers: f.maxUsers || null,
                maxDrivers: f.maxDrivers ?? null,
                maxOrdersMonth: f.maxOrdersMonth || null,
                description: f.description,
                public: f.public,
                active: f.active,
                features: plan?.system ? ['*'] : featureList((k) => on.has(k)),
              })
            }
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="pp-form">
        <div className="grid2">
          <Field label={t('platform.plan.name')}>
            <input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('platform.plan.priceMonth')}>
            <input type="number" min={0} disabled={plan?.system} value={f.priceMonth} onChange={(e) => setF({ ...f, priceMonth: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label={t('platform.plan.priceYear')} hint={t('platform.plan.priceYearHint', { price: da(f.priceMonth * 12) })}>
            <input type="number" min={0} disabled={plan?.system} value={f.priceYear ?? ''} placeholder="—" onChange={(e) => setF({ ...f, priceYear: numOrNull(e.target.value) })} />
          </Field>
          <Field label={t('platform.plan.maxDrivers')} hint={t('platform.plan.emptyAny')}>
            <input type="number" min={0} disabled={plan?.system} value={f.maxDrivers ?? ''} onChange={(e) => setF({ ...f, maxDrivers: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label={t('platform.plan.maxUsers')} hint={t('platform.plan.emptyAny')}>
            <input type="number" min={1} disabled={plan?.system} value={f.maxUsers ?? ''} onChange={(e) => setF({ ...f, maxUsers: numOrNull(e.target.value) })} />
          </Field>
          <Field label={t('platform.plan.maxOrders')} hint={t('platform.plan.maxOrdersHint')}>
            <input type="number" min={1} disabled={plan?.system} value={f.maxOrdersMonth ?? ''} onChange={(e) => setF({ ...f, maxOrdersMonth: numOrNull(e.target.value) })} />
          </Field>
          <Field label={t('platform.plan.description')} wide>
            <input maxLength={400} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
        </div>
        {!plan?.system && (
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <label className="check">
              <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> {t('platform.plan.activeLabel')}
            </label>
          </div>
        )}
        <h3>{t('platform.menus.title')}</h3>
        {plan?.system ? <p className="muted">{t('platform.plan.systemMenus')}</p> : <FeatureTree isOn={(k) => on.has(k) && (k.includes('/') ? on.has(k.split('/')[0]) : true)} onToggle={toggle} />}
      </div>
    </Modal>
  );
}
