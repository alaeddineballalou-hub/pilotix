// What the platform does on its own: reminders e-mailed to a store's owner before its trial or its paid period ends
// (and when it locks), and the free months a store gets when a store it brought first pays.
import { isoOrNull, num } from '../db';
import type { Db } from '../db';
import { loadShops, platformSettings, PlatformSettings, shopStatus } from './shops';
import type { Tenancy } from './tenancy';

export type ReminderKind = 'trial_end' | 'paid_end' | 'grace' | 'locked';

export interface DueReminder {
  shopId: number;
  shop: string;
  kind: ReminderKind;
  /** the date that ends (trial, paid period) */
  endsAt: string;
  /** that date is the free trial's (never paid): the e-mail says « essai », not « abonnement » */
  trial: boolean;
  daysLeft: number | null;
  to: string;
  name: string;
  language: string;
  plan: string | null;
  price: number | null;
}

/**
 * The reminders to e-mail now, each one once per store, kind and end date (recorded as sent before they are returned:
 * two servers running the job cannot both send it). Stores of the platform only (not the owner's own, not the demo).
 */
export async function takeDueReminders(t: Tenancy, now = Date.now()): Promise<DueReminder[]> {
  const set = await platformSettings(t);
  if (!set.reminders.on) return [];
  const out: DueReminder[] = [];
  for (const s of await loadShops(t)) {
    if (s.primary || s.demo || s.status !== 'active') continue;
    const st = shopStatus(s, now, set.trial.graceDays);
    const days = Math.max(1, set.reminders.daysBefore);
    let kind: ReminderKind | null = null;
    let ends: string | null = null;
    if (st.state === 'trial' && (st.daysLeft ?? 99) <= days) [kind, ends] = ['trial_end', s.trialEndsAt];
    else if (st.state === 'active' && s.paidUntil && (st.daysLeft ?? 99) <= days) [kind, ends] = ['paid_end', s.paidUntil];
    else if (st.state === 'grace') [kind, ends] = ['grace', maxDate(s.paidUntil, s.trialEndsAt)];
    else if (st.state === 'expired') [kind, ends] = ['locked', maxDate(s.paidUntil, s.trialEndsAt)];
    if (!kind || !ends) continue;
    const owner = s.ownerAccountId ? (await t.platform.query('SELECT email, name, language FROM platform.accounts WHERE id = $1', [s.ownerAccountId]))[0] : null;
    const to = (owner?.email as string | undefined) ?? s.ownerEmail;
    if (!to) continue;
    const fresh = await t.platform.query('INSERT INTO platform.reminders (shop_id, kind, ends_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING shop_id', [s.id, kind, ends.slice(0, 10)]);
    if (!fresh.length) continue;
    out.push({
      shopId: s.id,
      shop: s.name,
      kind,
      endsAt: ends,
      trial: kind === 'trial_end' || (kind !== 'paid_end' && ends === s.trialEndsAt && !(s.paidUntil && Date.parse(s.paidUntil) >= Date.parse(ends))),
      daysLeft: st.daysLeft,
      to,
      name: (owner?.name as string | undefined) || s.ownerName || '',
      language: (owner?.language as string | undefined) || 'fr',
      plan: s.plan && !s.plan.system ? s.plan.name : null,
      price: s.plan && !s.plan.system ? s.plan.priceMonth : null,
    });
  }
  return out;
}

const maxDate = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) > Date.parse(b) ? a : b);

// ---------------------------------------------------------------- referrals
export interface ReferralReward {
  referrerShopId: number;
  shop: string;
  referred: string;
  months: number;
  to: string | null;
  name: string;
  language: string;
  paidUntil: string | null;
}

/**
 * A store's payment: when it is the first one of a store another store brought, that store gets its free months
 * (once). Runs inside the payment's transaction.
 */
export async function rewardReferrer(db: Db, set: PlatformSettings, referredShopId: number, paymentId: number): Promise<ReferralReward | null> {
  const r = (await db.query('SELECT * FROM platform.referrals WHERE referred_shop_id = $1 AND rewarded_at IS NULL FOR UPDATE', [referredShopId]))[0];
  if (!r) return null;
  const months = set.referral.on ? Math.max(0, set.referral.months) : 0;
  const ref = (await db.query('SELECT s.*, a.email AS acc_email, a.name AS acc_name, a.language AS acc_lang FROM platform.shops s LEFT JOIN platform.accounts a ON a.id = s.owner_account_id WHERE s.id = $1', [r.referrer_shop_id]))[0];
  const referred = (await db.query('SELECT name FROM platform.shops WHERE id = $1', [referredShopId]))[0]?.name ?? '';
  const gets = months > 0 && ref && !ref.never_expires && !ref.is_demo && ref.status !== 'deleted' && ref.status !== 'archived';
  let paidUntil: string | null = null;
  if (gets) {
    const u = (
      await db.query(
        `UPDATE platform.shops SET paid_until = GREATEST(now(), paid_until, trial_ends_at) + make_interval(months => $2) WHERE id = $1 RETURNING paid_until`,
        [ref.id, months],
      )
    )[0];
    paidUntil = isoOrNull(u?.paid_until);
  }
  await db.query('UPDATE platform.referrals SET rewarded_at = now(), reward_months = $2, payment_id = $3 WHERE id = $1', [r.id, gets ? months : 0, paymentId]);
  if (!gets) return null;
  return {
    referrerShopId: num(ref.id),
    shop: ref.name,
    referred,
    months,
    to: ref.acc_email ?? ref.owner_email ?? null,
    name: ref.acc_name || ref.owner_name || '',
    language: ref.acc_lang || 'fr',
    paidUntil,
  };
}

/** What the store's « Parrainage » page shows on a multi-shop server: its code, the reward, the stores it brought. */
export async function storeReferrals(t: Tenancy, shopId: number) {
  const set = await platformSettings(t);
  const s = (await t.platform.query('SELECT referral_code FROM platform.shops WHERE id = $1', [shopId]))[0];
  const rows = await t.platform.query(
    `SELECT r.*, s.name, s.trial_ends_at, s.paid_until, s.status, s.created_at AS shop_created
       FROM platform.referrals r JOIN platform.shops s ON s.id = r.referred_shop_id WHERE r.referrer_shop_id = $1 ORDER BY r.created_at DESC`,
    [shopId],
  );
  const list = rows.map((r: any) => ({
    name: r.status === 'deleted' ? '—' : (r.name as string),
    at: isoOrNull(r.created_at)!,
    paid: !!r.rewarded_at,
    months: num(r.reward_months),
  }));
  return {
    code: (s?.referral_code as string | null) ?? null,
    on: set.referral.on,
    months: set.referral.months,
    list,
    earned: list.reduce((a: number, x: { months: number }) => a + x.months, 0),
  };
}
