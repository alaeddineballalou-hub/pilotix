// Shops: the list (state, plan, team, orders this month, last activity), a new shop, a payment received.
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, n, when } from '../../lib/format';
import { openShop, PIn, POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { copyText, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { waLink } from '../../layout/ShopBanner';
import { can, Empty, METHODS, nextEnd, ShopRow, StateBadge } from './bits';

const FILTERS = ['all', 'trial', 'active', 'late', 'suspended', 'archived'] as const;
type Plan = POut<'p.plans.list'>[number];

export function Shops({ staff, creating, filter }: { staff: Staff; creating?: boolean; filter?: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<string>((FILTERS as readonly string[]).includes(filter ?? '') ? filter! : 'all');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pay, setPay] = useState<ShopRow | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    if (filter && (FILTERS as readonly string[]).includes(filter)) setState(filter);
  }, [filter]);
  const list = usePRpc('p.shops.list', { q: debounced || undefined, state: state === 'all' ? undefined : state });
  const all = usePRpc('p.shops.list', {});
  const plans = usePRpc('p.plans.list', {});
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const s of all.data ?? []) {
      if (s.primary || s.demo) continue;
      if (s.state !== 'archived') c.all++;
      c[s.state] = (c[s.state] ?? 0) + 1;
      if (s.state === 'grace' || s.state === 'expired') c.late = (c.late ?? 0) + 1;
    }
    return c;
  }, [all.data]);
  const manager = can(staff, 'manager');
  // "Toutes": the shops still open (the archived ones have their own tab)
  const rows = (list.data ?? []).filter((s) => state === 'archived' || s.state !== 'archived');
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.shops')}</h1>
          <p className="muted">{t('platform.shopsSub')}</p>
        </div>
        {manager && (
          <a className="btn primary" href="#/platform/shops/new">
            + {t('platform.newShop')}
          </a>
        )}
      </div>
      <div className="pp-toolbar">
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={state === f} className={`tab ${state === f ? 'on' : ''}`} onClick={() => setState(f)}>
              {t(`platform.filter.${f}`)}
              {counts[f] ? <b className="ltr"> {counts[f]}</b> : null}
            </button>
          ))}
        </div>
        <label className="pp-search">
          <Icon name="search" />
          <input type="search" placeholder={t('platform.searchShop')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="card">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <Empty>{t('platform.noShop')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl pp-tbl">
              <thead>
                <tr>
                  <th>{t('platform.col.shop')}</th>
                  <th>{t('platform.col.owner')}</th>
                  <th>{t('platform.col.plan')}</th>
                  <th>{t('platform.col.state')}</th>
                  <th className="num">{t('platform.col.team')}</th>
                  <th className="num">{t('platform.col.orders')}</th>
                  <th>{t('platform.col.activity')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className={s.primary ? 'pp-own' : ''}>
                    <td data-l={t('platform.col.shop')}>
                      <a className="pp-shop" href={`#/platform/shops/${s.id}`}>
                        <b>{s.name}</b>
                        <small className="muted ltr">
                          {s.slug}
                          {s.city ? ` · ${s.city}` : ''}
                        </small>
                      </a>
                      {s.primary && <span className="chip pp-chip-own">{t('platform.ownShop')}</span>}
                      {s.demo && <span className="chip">{t('platform.demoShop')}</span>}
                      {s.selfSignup && <span className={`chip ${s.emailVerifiedAt ? '' : 'pp-chip-warn'}`}>{s.emailVerifiedAt ? t('platform.selfSignup') : t('platform.emailUnconfirmed')}</span>}
                      {s.domain && (
                        <span className={`chip ltr ${s.domain.status === 'ok' ? '' : 'pp-chip-warn'}`} title={s.domain.status === 'ok' ? t('platform.domainOk') : t('platform.domainPending')}>
                          {s.domain.name}
                        </span>
                      )}
                    </td>
                    <td data-l={t('platform.col.owner')}>
                      <span className="pp-two">
                        <span>{s.owner.name ?? '—'}</span>
                        <small className="muted ltr">{s.owner.phone || s.owner.email || ''}</small>
                      </span>
                    </td>
                    <td data-l={t('platform.col.plan')}>
                      {s.plan && !s.plan.system ? (
                        <span className="pp-two">
                          <span>{s.plan.name}</span>
                          <small className="muted">{t('platform.perMonth', { price: da(s.plan.priceMonth) })}</small>
                        </span>
                      ) : (
                        <span className="muted">{s.primary ? t('platform.unlimited') : '—'}</span>
                      )}
                    </td>
                    <td data-l={t('platform.col.state')}>
                      <span className="pp-two">
                        <StateBadge state={s.state} daysLeft={s.primary || s.demo ? null : s.daysLeft} />
                        {!s.primary && !s.demo && (s.state === 'trial' || s.state === 'active' || s.state === 'grace') && (
                          <small className="muted">{t('platform.untilDate', { date: dateOnly(s.state === 'trial' ? s.trialEndsAt : s.paidUntil ?? s.trialEndsAt) })}</small>
                        )}
                      </span>
                    </td>
                    <td className="num" data-l={t('platform.col.team')}>
                      {n(s.usage.users)}
                    </td>
                    <td className="num" data-l={t('platform.col.orders')}>
                      {n(s.usage.ordersMonth)}
                    </td>
                    <td data-l={t('platform.col.activity')}>
                      <small>{s.lastActiveAt ? when(s.lastActiveAt) : '—'}</small>
                    </td>
                    <td data-l="" className="pp-acts">
                      {manager && !s.primary && !s.demo && s.status !== 'archived' && (
                        <button type="button" className="btn small" onClick={() => setPay(s)}>
                          <Icon name="coins" /> {t('platform.payment')}
                        </button>
                      )}
                      {s.status !== 'archived' && <OpenButton id={s.id} small />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && manager && plans.data && <NewShop plans={plans.data} onClose={() => (location.hash = '#/platform/shops')} />}
      {pay && plans.data && <PaymentModal shop={pay} plans={plans.data} onClose={() => setPay(null)} />}
    </div>
  );
}

/** Support: opens the shop in a new tab as its administrator (2 hours, written in the journal). */
export function OpenButton({ id, small }: { id: number; small?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${small ? 'small' : ''}`}
      disabled={busy}
      title={t('platform.openHelp')}
      onClick={async () => {
        setBusy(true);
        try {
          await openShop(id);
        } catch (e: any) {
          toast(e?.message ?? t('common.error'), 'bad');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="external" /> {t('platform.open')}
    </button>
  );
}

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

function NewShop({ plans, onClose }: { plans: Plan[]; onClose: () => void }) {
  const { t } = useTranslation();
  const settings = usePRpc('p.settings.get', {});
  const offered = plans.filter((p) => p.active && !p.system);
  const [f, setF] = useState({ name: '', slug: '', slugTouched: false, ownerName: '', ownerEmail: '', ownerPhone: '', city: '', planId: 0, trialDays: 14, password: '', notes: '' });
  const [done, setDone] = useState<POut<'p.shops.create'> | null>(null);
  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setF((x) => ({ ...x, trialDays: s.trial.days, planId: x.planId || (offered.find((p) => p.code === s.trial.planCode) ?? offered[0])?.id || 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const create = usePAction('p.shops.create', { onDone: (r) => setDone(r) });
  const slug = f.slugTouched ? f.slug : slugify(f.name);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: PIn<'p.shops.create'> = {
      name: f.name.trim(),
      // not typed: the server takes this one, or the next free one (…-2)
      slug: f.slugTouched && slug ? slug : undefined,
      ownerName: f.ownerName.trim(),
      ownerEmail: f.ownerEmail.trim(),
      ownerPhone: f.ownerPhone.trim() || null,
      city: f.city.trim() || null,
      planId: f.planId,
      trialDays: f.trialDays,
      password: f.password || undefined,
      notes: f.notes || undefined,
    };
    create.mutate(input);
  };
  if (done) return <Created shop={done} name={f.name} owner={f.ownerName} phone={f.ownerPhone} days={f.trialDays} onClose={onClose} />;
  return (
    <Modal
      title={t('platform.newShop')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" type="submit" form="pp-new-shop" disabled={create.isPending || !f.planId}>
            {create.isPending ? t('platform.creating') : t('platform.create')}
          </button>
        </>
      }
    >
      <form id="pp-new-shop" className="pp-form" onSubmit={submit}>
        <h3>{t('platform.f.shop')}</h3>
        <div className="grid2">
          <Field label={t('platform.f.name')}>
            <input required minLength={2} maxLength={80} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Bébé Confort Oran" />
          </Field>
          <Field label={t('platform.f.slug')} hint={<span className="ltr">{window.location.host}/{slug || 'ma-boutique'}/…</span>}>
            <input dir="ltr" maxLength={40} value={slug} onChange={(e) => setF((x) => ({ ...x, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''), slugTouched: true }))} />
          </Field>
          <Field label={t('platform.f.city')}>
            <input maxLength={60} value={f.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
        </div>
        <h3>{t('platform.f.owner')}</h3>
        <div className="grid2">
          <Field label={t('platform.f.ownerName')}>
            <input required minLength={2} maxLength={80} value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
          </Field>
          <Field label={t('platform.f.ownerEmail')} hint={t('platform.f.ownerEmailHint')}>
            <input required type="email" dir="ltr" maxLength={200} value={f.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />
          </Field>
          <Field label={t('platform.f.ownerPhone')} hint={t('platform.f.ownerPhoneHint')}>
            <input dir="ltr" inputMode="tel" maxLength={30} value={f.ownerPhone} onChange={(e) => set('ownerPhone', e.target.value)} placeholder="0550 12 34 56" />
          </Field>
        </div>
        <h3>{t('platform.f.subscription')}</h3>
        <div className="grid2">
          <Field label={t('platform.f.plan')}>
            <select value={f.planId} onChange={(e) => set('planId', Number(e.target.value))}>
              {offered.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {t('platform.perMonth', { price: da(p.priceMonth) })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('platform.f.trialDays')}>
            <div className="pp-quick">
              <input type="number" min={0} max={90} value={f.trialDays} onChange={(e) => set('trialDays', Math.max(0, Math.min(90, Number(e.target.value) || 0)))} />
              {[0, 7, 14, 30].map((d) => (
                <button key={d} type="button" className={`btn small ${f.trialDays === d ? 'on' : ''}`} onClick={() => set('trialDays', d)}>
                  {d}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t('platform.f.password')} hint={t('platform.f.passwordHint')}>
            <input dir="ltr" minLength={10} maxLength={200} value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={t('platform.f.passwordAuto')} />
          </Field>
          <Field label={t('platform.f.notes')}>
            <input maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function Created({ shop, name, owner, phone, days, onClose }: { shop: POut<'p.shops.create'>; name: string; owner: string; phone: string; days: number; onClose: () => void }) {
  const { t } = useTranslation();
  const url = `${window.location.origin}/`;
  const text = t('platform.welcome', { name: owner.split(' ')[0], shop: name, url, email: shop.email, password: shop.password, days });
  return (
    <Modal
      title={t('platform.createdTitle')}
      onClose={onClose}
      footer={
        <>
          <a className="btn" href={`#/platform/shops/${shop.id}`}>
            {t('platform.seeShop')}
          </a>
          <button className="btn primary" type="button" onClick={onClose}>
            {t('common.close', { defaultValue: 'Fermer' })}
          </button>
        </>
      }
    >
      <p>{t('platform.createdText', { name })}</p>
      <dl className="pp-creds">
        <dt>{t('platform.f.link')}</dt>
        <dd className="ltr">{url}</dd>
        <dt>{t('login.email')}</dt>
        <dd className="ltr">{shop.email}</dd>
        <dt>{t('login.password')}</dt>
        <dd className="ltr">
          <b>{shop.password}</b>
        </dd>
      </dl>
      <p className="small muted">{t('platform.createdOnce')}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={async () => toast((await copyText(text)) ? t('platform.copied') : t('common.error'), 'ok')}>
          <Icon name="copy" /> {t('platform.copyAll')}
        </button>
        {phone.trim() && (
          <a className="btn primary" href={waLink(phone, text)} target="_blank" rel="noreferrer">
            <Icon name="chat" /> {t('platform.sendWa')}
          </a>
        )}
      </div>
    </Modal>
  );
}

/** A payment received (BaridiMob, CCP, cash…): the access is extended by the months paid. */
export function PaymentModal({ shop, plans, onClose }: { shop: Pick<ShopRow, 'id' | 'name' | 'plan' | 'paidUntil' | 'trialEndsAt'>; plans: Plan[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [months, setMonths] = useState(1);
  const [planId, setPlanId] = useState(shop.plan?.id ?? plans.find((p) => !p.system)?.id ?? 0);
  const plan = plans.find((p) => p.id === planId);
  const suggested = (plan?.priceMonth ?? 0) * months;
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('baridimob');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const add = usePAction('p.payments.add', { success: (r) => t('platform.paidUntil', { date: dateOnly(r.paidUntil) }), onDone: onClose });
  const end = nextEnd(shop.paidUntil, shop.trialEndsAt, months);
  return (
    <Modal
      title={t('platform.paymentFor', { name: shop.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={add.isPending}
            onClick={() =>
              add.mutate({ shopId: shop.id, amount: amount ?? suggested, method, months, reference: reference || undefined, note: note || undefined, paidAt: new Date(`${paidAt}T12:00:00Z`).toISOString(), planId: planId || undefined })
            }
          >
            {t('platform.savePayment')}
          </button>
        </>
      }
    >
      <div className="pp-form">
        <Field label={t('platform.p.months')}>
          <div className="pp-quick">
            {[1, 3, 6, 12].map((m) => (
              <button key={m} type="button" className={`btn small ${months === m ? 'on' : ''}`} onClick={() => (setMonths(m), setAmount(null))}>
                {t('platform.p.monthsN', { count: m })}
              </button>
            ))}
            <input type="number" min={1} max={36} value={months} onChange={(e) => (setMonths(Math.max(1, Math.min(36, Number(e.target.value) || 1))), setAmount(null))} />
          </div>
        </Field>
        <div className="grid2">
          <Field label={t('platform.f.plan')}>
            <select value={planId} onChange={(e) => (setPlanId(Number(e.target.value)), setAmount(null))}>
              {plans
                .filter((p) => !p.system && (p.active || p.id === shop.plan?.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {t('platform.perMonth', { price: da(p.priceMonth) })}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('platform.p.amount')}>
            <input type="number" min={0} value={amount ?? suggested} onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Field label={t('platform.p.method')}>
            <select value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`platform.method.${m}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('platform.p.reference')}>
            <input maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t('platform.p.referenceHint')} />
          </Field>
          <Field label={t('platform.p.date')}>
            <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
          <Field label={t('platform.f.notes')}>
            <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <p className="pp-preview">
          <Icon name="calendar" /> {t('platform.p.newEnd', { date: dateOnly(end) })}
        </p>
      </div>
    </Modal>
  );
}
