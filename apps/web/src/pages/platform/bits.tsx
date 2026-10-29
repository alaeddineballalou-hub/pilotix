// Small pieces of the control room: state badges, money, the journal's sentences.
import type { ShopState } from '@pilotix/shared';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { da, dateOnly } from '../../lib/format';
import type { POut, Staff } from '../../lib/platform';

export type ShopRow = POut<'p.shops.list'>[number];
export type AuditRow = POut<'p.audit.list'>[number];
export const METHODS = ['baridimob', 'ccp', 'cash', 'virement', 'autre'] as const;

/** Can this staff member do it? (the owner always can) */
export const can = (staff: Staff, ...roles: Staff['role'][]) => staff.role === 'owner' || roles.includes(staff.role);

export function StateBadge({ state, daysLeft }: { state: ShopState; daysLeft?: number | null }) {
  const { t } = useTranslation();
  const days = daysLeft !== null && daysLeft !== undefined && (state === 'trial' || state === 'active' || state === 'grace');
  return (
    <span className={`pp-st pp-st-${state}`}>
      {t(`platform.state.${state}`)}
      {days && <b className="ltr"> · {t('platform.daysShort', { count: daysLeft })}</b>}
    </span>
  );
}

/** The date a payment of `months` would run to: from today, or from the end of the trial / period still ahead. */
export function nextEnd(paidUntil: string | null, trialEndsAt: string | null, months: number): string {
  const start = Math.max(Date.now(), paidUntil ? Date.parse(paidUntil) : 0, trialEndsAt ? Date.parse(trialEndsAt) : 0);
  const d = new Date(start);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

/** One line of the journal, in words. */
export function auditText(t: TFunction, a: AuditRow): string {
  const d = a.details as Record<string, any>;
  switch (a.action) {
    case 'shop.create':
      return t('platform.log.shopCreate', { plan: d.plan ?? '', days: d.trialDays ?? 0 });
    case 'shop.update':
      return t('platform.log.shopUpdate', { fields: Object.keys(d).map((k) => t(`platform.field.${k}`, { defaultValue: k })).join(', ') });
    case 'shop.suspend':
      return t('platform.log.shopSuspend', { reason: d.reason ? ` — ${d.reason}` : '' });
    case 'shop.reactivate':
      return t('platform.log.shopReactivate');
    case 'shop.archive':
      return t('platform.log.shopArchive', { reason: d.reason ? ` — ${d.reason}` : '' });
    case 'shop.features':
      return t('platform.log.shopFeatures', { on: (d.on ?? []).length, off: (d.off ?? []).length });
    case 'shop.trial':
      return t('platform.log.shopTrial', { days: d.days, date: dateOnly(d.to) });
    case 'shop.adminPassword':
      return t('platform.log.adminPassword', { email: d.email ?? '' });
    case 'shop.open':
      return t('platform.log.shopOpen', { as: d.as ?? '' });
    case 'shop.signup':
      return t('platform.log.shopSignup', { plan: d.plan ?? '' });
    case 'shop.added':
      return t('platform.log.shopAdded', { plan: d.plan ?? '' });
    case 'shop.deleted':
      return t('platform.log.shopDeleted', { name: d.name ?? '' });
    case 'shop.invite':
      return t('platform.log.shopInvite', { email: d.email ?? '' });
    case 'shop.ownerStores':
      return t('platform.log.ownerStores', { n: d.maxStores ?? '∞' });
    case 'payment.receipt':
      return t('platform.log.receipt', { no: d.receipt ?? '', email: d.to ?? '' });
    case 'referral.reward':
      return t('platform.log.reward', { count: d.months ?? 0, from: d.from ?? '' });
    case 'support.reply':
      return t('platform.log.supportReply', { subject: d.subject ?? '' });
    case 'payment.add':
      return t('platform.log.paymentAdd', { amount: da(d.amount), method: t(`platform.method.${d.method}`, { defaultValue: d.method }), months: d.months, date: dateOnly(d.paidUntil) });
    case 'payment.void':
      return t('platform.log.paymentVoid', { amount: da(d.amount), reason: d.reason ?? '' });
    case 'plan.create':
    case 'plan.update':
      return t(a.action === 'plan.create' ? 'platform.log.planCreate' : 'platform.log.planUpdate', { plan: d.plan ?? '', price: da(d.priceMonth) });
    case 'staff.create':
    case 'staff.update':
      return t(a.action === 'staff.create' ? 'platform.log.staffCreate' : 'platform.log.staffUpdate', { email: d.email ?? '', role: t(`platform.roles.${d.role}`, { defaultValue: d.role ?? '' }) });
    case 'staff.password':
      return t('platform.log.staffPassword');
    case 'settings.save':
      return t('platform.log.settings');
    case 'agency.signup':
    case 'marketer.signup':
      return t('platform.log.partnerSignup', { kind: t(`platform.kind.${a.action.split('.')[0]}`) });
    case 'agency.added':
    case 'marketer.added':
      return t('platform.log.partnerAdded', { kind: t(`platform.kind.${a.action.split('.')[0]}`) });
    case 'agency.verify':
    case 'marketer.verify':
      return t('platform.log.partnerVerify');
    case 'agency.unverify':
    case 'marketer.unverify':
      return t('platform.log.partnerUnverify');
    case 'demo.create':
      return t('platform.log.demoCreate');
    case 'demo.reset':
      return t('platform.log.demoReset');
    // Sociétés de livraison: test keys, a company removed / put back, « Changements API »
    case 'couriers.keys':
    case 'couriers.keysCleared':
    case 'couriers.removed':
    case 'couriers.restored':
    case 'couriers.todoResolved':
    case 'couriers.todoReopened':
    case 'couriers.todoAdded':
    case 'couriers.todoRemoved':
      return t(`platform.log.${a.action.replace('.', '_')}`, { company: d.name ?? d.company ?? '', title: d.title ?? '' });
    default:
      return a.action;
  }
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="pp-empty">{children}</p>;
}
