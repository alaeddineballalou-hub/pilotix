// One shop: its subscription (plan, trial, paid period, limits), its own menus, payments and receipts, its numbers
// (accounts, livreurs, orders — never what is inside), its owner, details and notes, and its journal. Actions: payment
// received, longer trial, suspend, archive. Pilotix never opens a store nor sets the password of its people.
import { effectiveFeatures, featureOn } from '@pilotix/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, dateTime, n, when } from '../../lib/format';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { auditText, can, Empty, StateBadge } from './bits';
import { FeatureTree } from './FeatureTree';
import { PaymentModal } from './Shops';

type Detail = POut<'p.shops.get'>;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const iso = (d: string) => (d ? new Date(`${d}T23:00:00Z`).toISOString() : null);

export function ShopDetail({ id, staff }: { id: number; staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.shops.get', { id });
  const plans = usePRpc('p.plans.list', {});
  const [pay, setPay] = useState(false);
  const [status, setStatus] = useState<'suspended' | 'archived' | null>(null);
  const reactivate = usePAction('p.shops.setStatus', { success: t('platform.reactivated') });
  const extend = usePAction('p.shops.extendTrial', { success: (r) => t('platform.trialUntil', { date: dateOnly(r.trialEndsAt) }) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data as Detail;
  const manager = can(staff, 'manager');
  const special = s.primary || s.demo;
  const gone = s.status === 'deleted';
  return (
    <div className="pp-stack">
      <a className="pp-backlink" href="#/platform/shops">
        ← {t('platform.nav.shops')}
      </a>
      <div className="pp-head pp-shop-head">
        <div>
          <h1>
            {s.name} <StateBadge state={s.state} daysLeft={special ? null : s.daysLeft} />
          </h1>
          <p className="muted">
            {s.primary ? t('platform.ownShopLong') : s.demo ? t('platform.demoShopLong') : `${s.plan?.name ?? '—'} · ${t('platform.createdOn', { date: dateOnly(s.createdAt) })}`}
            {s.status !== 'active' && s.statusReason ? ` · ${s.statusReason}` : ''}
          </p>
        </div>
        <div className="row pp-head-acts" hidden={gone}>
          {manager && !special && s.status !== 'archived' && (
            <button type="button" className="btn primary" onClick={() => setPay(true)}>
              <Icon name="coins" /> {t('platform.paymentReceived')}
            </button>
          )}
          {manager && !special && s.status === 'active' && (s.state === 'trial' || s.state === 'grace' || s.state === 'expired') && (
            <button type="button" className="btn" disabled={extend.isPending} onClick={() => extend.mutate({ id: s.id, days: 7 })}>
              <Icon name="clock" /> {t('platform.extend7')}
            </button>
          )}
          {manager && !s.primary && s.status === 'active' && (
            <button type="button" className="btn pp-danger" onClick={() => setStatus('suspended')}>
              <Icon name="pause" /> {t('platform.suspend')}
            </button>
          )}
          {manager && !s.primary && s.status !== 'active' && (
            <button type="button" className="btn" disabled={reactivate.isPending} onClick={() => reactivate.mutate({ id: s.id, status: 'active' })}>
              <Icon name="power" /> {t('platform.reactivate')}
            </button>
          )}
          {manager && !s.primary && s.status !== 'archived' && (
            <button type="button" className="btn pp-danger" onClick={() => setStatus('archived')}>
              <Icon name="archive" /> {t('platform.archive')}
            </button>
          )}
        </div>
      </div>
      <div className="pp-grid">
        <Subscription s={s} plans={plans.data ?? []} manager={manager} />
        <Usage s={s} />
      </div>
      <Menus s={s} manager={manager} />
      <div className="pp-grid">
        <Payments s={s} staff={staff} onAdd={manager && !special && s.status !== 'archived' && !gone ? () => setPay(true) : undefined} />
        <Owner s={s} manager={manager} />
      </div>
      <div className="pp-grid">
        <Info s={s} manager={manager} />
        <ShopLog s={s} />
      </div>
      {pay && plans.data && <PaymentModal shop={s} plans={plans.data} onClose={() => setPay(false)} />}
      {status && <StatusModal s={s} status={status} onClose={() => setStatus(null)} />}
    </div>
  );
}

function Subscription({ s, plans, manager }: { s: Detail; plans: POut<'p.plans.list'>; manager: boolean }) {
  const { t } = useTranslation();
  const init = () => ({
    planId: s.plan?.id ?? 0,
    trial: day(s.trialEndsAt),
    paid: day(s.paidUntil),
    maxUsers: s.maxUsers === null ? '' : String(s.maxUsers),
    maxDrivers: s.maxDrivers === null ? '' : String(s.maxDrivers),
  });
  const [f, setF] = useState(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setF(init()), [s]);
  const save = usePAction('p.shops.update', { success: t('platform.saved') });
  if (s.primary || s.demo)
    return (
      <Card title={t('platform.sub.title')}>
        <p>{s.primary ? t('platform.sub.own') : t('platform.sub.demo')}</p>
      </Card>
    );
  const planMax = plans.find((p) => p.id === f.planId)?.maxUsers ?? null;
  const planDrivers = plans.find((p) => p.id === f.planId)?.maxDrivers ?? null;
  const o = init();
  const dirty = JSON.stringify(f) !== JSON.stringify(o);
  const submit = () =>
    save.mutate({
      id: s.id,
      ...(f.planId !== o.planId ? { planId: f.planId } : {}),
      ...(f.trial !== o.trial ? { trialEndsAt: iso(f.trial) } : {}),
      ...(f.paid !== o.paid ? { paidUntil: iso(f.paid) } : {}),
      ...(f.maxUsers !== o.maxUsers ? { maxUsers: f.maxUsers === '' ? null : Math.max(1, Number(f.maxUsers) || 1) } : {}),
      ...(f.maxDrivers !== o.maxDrivers ? { maxDrivers: f.maxDrivers === '' ? null : Math.max(0, Number(f.maxDrivers) || 0) } : {}),
    });
  return (
    <Card title={t('platform.sub.title')} help={t('platform.sub.help')}>
      <div className="grid2 pp-form">
        <Field label={t('platform.f.plan')}>
          <select disabled={!manager} value={f.planId} onChange={(e) => setF({ ...f, planId: Number(e.target.value) })}>
            {plans
              .filter((p) => !p.system && (p.active || p.id === s.plan?.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {t('platform.perMonth', { price: da(p.priceMonth) })}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('platform.sub.maxUsers')} hint={t('platform.sub.maxUsersHint', { n: planMax ?? '∞' })}>
          <input disabled={!manager} type="number" min={1} value={f.maxUsers} placeholder={String(planMax ?? '∞')} onChange={(e) => setF({ ...f, maxUsers: e.target.value })} />
        </Field>
        <Field label={t('platform.sub.maxDrivers')} hint={t('platform.sub.maxDriversHint', { n: planDrivers ?? '∞' })}>
          <input disabled={!manager} type="number" min={0} value={f.maxDrivers} placeholder={String(planDrivers ?? '∞')} onChange={(e) => setF({ ...f, maxDrivers: e.target.value })} />
        </Field>
        <Field label={t('platform.sub.trialEnds')}>
          <input disabled={!manager} type="date" value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} />
        </Field>
        <Field label={t('platform.sub.paidUntil')}>
          <input disabled={!manager} type="date" value={f.paid} onChange={(e) => setF({ ...f, paid: e.target.value })} />
        </Field>
      </div>
      {manager && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" className="btn primary" disabled={!dirty || save.isPending} onClick={submit}>
            {t('common.save')}
          </button>
        </div>
      )}
    </Card>
  );
}

/** The store's numbers against its limits — numbers only, never what is inside. */
function Usage({ s }: { s: Detail }) {
  const { t } = useTranslation();
  const u = s.usage;
  const tile = (v: number, max: number | null, label: string, over: boolean) => (
    <div className={over ? 'bad' : ''}>
      <b className="ltr">
        {n(v)}
        {max !== null && <small> / {n(max)}</small>}
      </b>
      <span>{label}</span>
    </div>
  );
  return (
    <Card title={t('platform.use.title')} help={t('platform.use.help')}>
      <div className="pp-use">
        {tile(u.users, s.limits.maxUsers, t('platform.use.users'), s.limits.over.users)}
        {tile(u.drivers, s.limits.maxDrivers, t('platform.use.drivers'), s.limits.over.drivers)}
        {tile(u.ordersMonth, s.limits.maxOrdersMonth, t('platform.use.ordersMonth'), s.limits.over.orders)}
        {tile(u.ordersLastMonth, null, t('platform.use.ordersLastMonth'), false)}
        {tile(u.ownerStores, null, t('platform.use.ownerStores'), false)}
        <div className="txt">
          <b>{s.lastActiveAt ? when(s.lastActiveAt) : '—'}</b>
          <span>{t('platform.use.lastActive')}</span>
        </div>
      </div>
      {(s.limits.over.users || s.limits.over.drivers || s.limits.over.orders) && <p className="pp-warn">{t('platform.use.over')}</p>}
    </Card>
  );
}

function Menus({ s, manager }: { s: Detail; manager: boolean }) {
  const { t } = useTranslation();
  const [on, setOn] = useState<Set<string>>(new Set(s.featuresOn));
  const [off, setOff] = useState<Set<string>>(new Set(s.featuresOff));
  useEffect(() => {
    setOn(new Set(s.featuresOn));
    setOff(new Set(s.featuresOff));
  }, [s]);
  const plan = s.planFeatures;
  const eff = useMemo(() => effectiveFeatures(plan, [...on], [...off]), [plan, on, off]);
  const save = usePAction('p.shops.features', { success: t('platform.saved') });
  const dirty = [...on].sort().join() !== [...s.featuresOn].sort().join() || [...off].sort().join() !== [...s.featuresOff].sort().join();
  const toggle = (k: string, v: boolean) => {
    const n1 = new Set(on);
    const n2 = new Set(off);
    n1.delete(k);
    n2.delete(k);
    // what the plan gives without a change of this shop's own: a menu item if the plan includes it; a sub-menu unless
    // the plan leaves it out (a menu item turned on for this shop comes with all its sub-menus)
    const base = k.includes('/') ? !plan.includes(`-${k}`) : featureOn(plan, k);
    if (v !== base) (v ? n1 : n2).add(k);
    setOn(n1);
    setOff(n2);
  };
  return (
    <Card
      title={t('platform.menus.title')}
      help={t('platform.menus.help')}
      actions={
        manager && (
          <>
            {(on.size > 0 || off.size > 0) && (
              <button type="button" className="btn small" onClick={() => (setOn(new Set()), setOff(new Set()))}>
                {t('platform.menus.reset')}
              </button>
            )}
            <button type="button" className="btn small primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ id: s.id, on: [...on], off: [...off] })}>
              {t('common.save')}
            </button>
          </>
        )
      }
    >
      <p className="small muted">{s.primary ? t('platform.menus.own') : t('platform.menus.sub', { plan: s.plan?.name ?? '—', count: on.size + off.size })}</p>
      <FeatureTree isOn={(k) => featureOn(eff, k)} changed={(k) => on.has(k) || off.has(k)} onToggle={toggle} disabled={!manager} />
    </Card>
  );
}

function Payments({ s, staff, onAdd }: { s: Detail; staff: Staff; onAdd?: () => void }) {
  const { t } = useTranslation();
  const [voiding, setVoiding] = useState<number | null>(null);
  return (
    <Card
      title={t('platform.pay.title')}
      actions={
        onAdd && (
          <button type="button" className="btn small" onClick={onAdd}>
            + {t('platform.payment')}
          </button>
        )
      }
    >
      {s.payments.length ? (
        <ul className="pp-pays">
          {s.payments.map((p) => (
            <li key={p.id} className={p.voidAt ? 'void' : ''}>
              <span>
                <b className="ltr">{da(p.amount)}</b> · {t(`platform.method.${p.method}`)} · {t('platform.p.monthsN', { count: p.months })}
                {p.reference ? <span className="muted ltr"> · {p.reference}</span> : null}
              </span>
              <small className="muted">
                {dateOnly(p.paidAt)} → {t('platform.untilDate', { date: dateOnly(p.periodTo) })}
                {p.by ? ` · ${p.by}` : ''}
                {p.voidAt ? ` · ${t('platform.pay.voided', { reason: p.voidReason ?? '' })}` : ''}
              </small>
              <span className="row pp-pay-acts">
                {p.receiptNo && (
                  <a className="btn small pp-link" href={`#/platform/receipt/${p.id}`} target="_blank" rel="noreferrer">
                    <Icon name="receipt" /> <span className="ltr">{p.receiptNo}</span>
                  </a>
                )}
                {!p.voidAt && can(staff, 'manager') && <MailReceipt id={p.id} />}
                {!p.voidAt && staff.role === 'owner' && (
                  <button type="button" className="btn small pp-link" onClick={() => setVoiding(p.id)}>
                    {t('platform.pay.void')}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t('platform.pay.none')}</Empty>
      )}
      {voiding && <VoidModal id={voiding} onClose={() => setVoiding(null)} />}
    </Card>
  );
}

/** E-mails the receipt to the store's owner. */
export function MailReceipt({ id }: { id: number }) {
  const { t } = useTranslation();
  const m = usePAction('p.payments.mailReceipt', { success: (r) => t('platform.pay.receiptSent', { email: r.email }) });
  return (
    <button type="button" className="btn small pp-link" disabled={m.isPending} onClick={() => m.mutate({ id })}>
      <Icon name="send" /> {t('platform.pay.sendReceipt')}
    </button>
  );
}

function VoidModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const v = usePAction('p.payments.void', { success: t('platform.pay.voidDone'), onDone: onClose });
  return (
    <Modal
      title={t('platform.pay.voidTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn pp-danger" disabled={reason.trim().length < 2 || v.isPending} onClick={() => v.mutate({ id, reason: reason.trim() })}>
            {t('platform.pay.void')}
          </button>
        </>
      }
    >
      <p>{t('platform.pay.voidText')}</p>
      <Field label={t('platform.reason')}>
        <input autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** The owner: the account that made the store (only they see everything and can delete it). */
function Owner({ s, manager }: { s: Detail; manager: boolean }) {
  const { t } = useTranslation();
  const a = s.ownerAccount;
  const resend = usePAction('p.shops.resendInvite', { success: (r) => t('platform.owner.resent', { email: r.email }) });
  const save = usePAction('p.shops.update', { success: t('platform.saved') });
  const [max, setMax] = useState(a?.maxStores === null || a?.maxStores === undefined ? '' : String(a.maxStores));
  useEffect(() => setMax(a?.maxStores === null || a?.maxStores === undefined ? '' : String(a.maxStores)), [a?.maxStores]);
  return (
    <Card title={t('platform.owner.title')} help={t('platform.owner.help')}>
      {a ? (
        <>
          <dl className="pp-creds">
            <dt>{t('login.email')}</dt>
            <dd className="ltr">{a.email}</dd>
            <dt>{t('platform.owner.state')}</dt>
            <dd>{a.invited ? <span className="pp-bad">{t('platform.owner.invited')}</span> : a.verified ? t('platform.owner.ok') : t('platform.owner.unverified')}</dd>
            <dt>{t('platform.owner.lastLogin')}</dt>
            <dd>{a.lastLoginAt ? when(a.lastLoginAt) : '—'}</dd>
          </dl>
          {a.invited && manager && s.status !== 'deleted' && (
            <button type="button" className="btn small" disabled={resend.isPending} onClick={() => resend.mutate({ id: s.id })}>
              <Icon name="send" /> {t('platform.owner.resend')}
            </button>
          )}
          {!s.primary && !s.demo && (
            <Field label={t('platform.owner.maxStores')} hint={t('platform.owner.maxStoresHint', { n: a.stores, def: a.maxStoresDefault })}>
              <div className="row" style={{ gap: 8 }}>
                <input disabled={!manager} type="number" min={1} max={100} value={max} placeholder={String(a.maxStoresDefault)} onChange={(e) => setMax(e.target.value)} style={{ width: 110 }} />
                {manager && (
                  <button type="button" className="btn small" disabled={save.isPending || max === (a.maxStores === null ? '' : String(a.maxStores))} onClick={() => save.mutate({ id: s.id, ownerMaxStores: max === '' ? null : Math.max(1, Number(max) || 1) })}>
                    {t('common.save')}
                  </button>
                )}
              </div>
            </Field>
          )}
        </>
      ) : (
        <Empty>{t('platform.owner.none')}</Empty>
      )}
      <p className="small muted pp-privacy">
        <Icon name="shield" /> {t('platform.owner.privacy')}
      </p>
      {(s.referralCode || s.referredBy || s.referrals.length > 0) && (
        <div className="pp-ref">
          <h4>{t('platform.ref.title')}</h4>
          {s.referralCode && (
            <p className="small">
              {t('platform.ref.code')} <b className="ltr">{s.referralCode}</b>
            </p>
          )}
          {s.referredBy && (
            <p className="small">
              {t('platform.ref.by')} <a href={`#/platform/shops/${s.referredBy.id}`}>{s.referredBy.name}</a>
            </p>
          )}
          {s.referrals.length > 0 && (
            <ul className="pp-mini">
              {s.referrals.map((r) => (
                <li key={r.shopId}>
                  <a href={`#/platform/shops/${r.shopId}`}>{r.name}</a>
                  <small className="muted">{r.rewardedAt ? t('platform.ref.rewarded', { count: r.months }) : t('platform.ref.waiting')}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function Info({ s, manager }: { s: Detail; manager: boolean }) {
  const { t } = useTranslation();
  const init = () => ({ name: s.name, slug: s.slug, ownerName: s.owner.name ?? '', ownerEmail: s.owner.email ?? '', ownerPhone: s.owner.phone ?? '', city: s.city ?? '' });
  const [f, setF] = useState(init);
  const [notes, setNotes] = useState(s.notes);
  useEffect(() => {
    setF(init());
    setNotes(s.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  const save = usePAction('p.shops.update', { success: t('platform.saved') });
  const saveNotes = usePAction('p.shops.notes', { success: t('platform.saved') });
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  // its landing pages' address (site/<store>/<page>); its webhooks: …/api/s/<store>/… (shop #1: its first links)
  const link = `${window.location.host}/${s.slug}/…`;
  return (
    <Card title={t('platform.info.title')}>
      <div className="grid2 pp-form">
        <Field label={t('platform.f.name')}>
          <input disabled={!manager} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field
          label={t('platform.f.slug')}
          hint={
            f.slug !== s.slug ? (
              <span className="pp-bad">{t('platform.info.slugWarn')}</span>
            ) : (
              <span className="ltr">{link}</span>
            )
          }
        >
          <input disabled={!manager} dir="ltr" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
        </Field>
        <Field label={t('platform.f.ownerName')}>
          <input disabled={!manager} value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} />
        </Field>
        <Field label={t('platform.f.contactEmail')}>
          <input disabled={!manager} dir="ltr" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />
        </Field>
        <Field label={t('platform.f.ownerPhone')}>
          <input disabled={!manager} dir="ltr" value={f.ownerPhone} onChange={(e) => setF({ ...f, ownerPhone: e.target.value })} />
        </Field>
        <Field label={t('platform.f.city')}>
          <input disabled={!manager} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </Field>
      </div>
      {manager && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ id: s.id, ...f, ownerName: f.ownerName || null, ownerEmail: f.ownerEmail || null, ownerPhone: f.ownerPhone || null, city: f.city || null })}>
            {t('common.save')}
          </button>
        </div>
      )}
      <Field label={t('platform.f.notes')} hint={t('platform.info.notesHint')}>
        <textarea rows={4} value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn small" disabled={notes === s.notes || saveNotes.isPending} onClick={() => saveNotes.mutate({ id: s.id, notes })}>
          {t('platform.info.saveNotes')}
        </button>
      </div>
    </Card>
  );
}

function ShopLog({ s }: { s: Detail }) {
  const { t } = useTranslation();
  return (
    <Card title={t('platform.nav.journal')}>
      {s.log.length ? (
        <ul className="pp-log">
          {s.log.map((a) => (
            <li key={a.id}>
              <span className="muted small">{dateTime(a.at)}</span>
              <span>{auditText(t, a)}</span>
              <span className="muted small">{a.staff}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t('platform.d.nothingYet')}</Empty>
      )}
    </Card>
  );
}

function StatusModal({ s, status, onClose }: { s: Detail; status: 'suspended' | 'archived'; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const m = usePAction('p.shops.setStatus', { success: t(status === 'suspended' ? 'platform.suspendedDone' : 'platform.archivedDone'), onDone: onClose });
  return (
    <Modal
      title={t(status === 'suspended' ? 'platform.suspendTitle' : 'platform.archiveTitle', { name: s.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn pp-danger" disabled={m.isPending} onClick={() => m.mutate({ id: s.id, status, reason: reason.trim() || undefined })}>
            {t(status === 'suspended' ? 'platform.suspend' : 'platform.archive')}
          </button>
        </>
      }
    >
      <p>{t(status === 'suspended' ? 'platform.suspendText' : 'platform.archiveText')}</p>
      <Field label={t('platform.reason')}>
        <input autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={t('platform.reasonHint')} />
      </Field>
    </Modal>
  );
}
