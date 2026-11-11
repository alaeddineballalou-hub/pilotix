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
    // one plan per seller: their other boutiques follow their first one, which gets the reminders
    if (s.primary || s.demo || s.status !== 'active' || s.mainShopId) continue;
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
  // one plan per seller: the free months go to the referrer's first boutique (its plan and period are the seller's)
  const ref = (
    await db.query(
      `SELECT s.*, a.email AS acc_email, a.name AS acc_name, a.language AS acc_lang FROM platform.shops s LEFT JOIN platform.accounts a ON a.id = s.owner_account_id
        WHERE s.id = COALESCE((SELECT x.id FROM platform.shops me JOIN platform.shops x ON x.owner_account_id = me.owner_account_id
                                WHERE me.id = $1 AND me.kind = 'store' AND NOT me.is_demo AND x.kind = 'store' AND x.status NOT IN ('deleted', 'archived') AND NOT x.is_demo
                                ORDER BY x.primary_shop DESC, x.id LIMIT 1), $1)`,
      [r.referrer_shop_id],
    )
  )[0];
  const referred = (await db.query('SELECT name FROM platform.shops WHERE id = $1', [referredShopId]))[0]?.name ?? '';
  // never a reward for oneself: the store that pays belongs to the same account as the one that brought it
  const self = !!ref && (await isSelfReferral(db, num(ref.id), referredShopId));
  const gets = months > 0 && ref && !self && !ref.never_expires && !ref.is_demo && ref.status !== 'deleted' && ref.status !== 'archived';
  let paidUntil: string | null = null;
  let from: string | null = null;
  if (gets) {
    const u = (
      await db.query(
        `UPDATE platform.shops x SET paid_until = GREATEST(now(), x.paid_until, x.trial_ends_at) + make_interval(months => $2)
           FROM (SELECT GREATEST(now(), paid_until, trial_ends_at) AS f FROM platform.shops WHERE id = $1) b
          WHERE x.id = $1 RETURNING x.paid_until, b.f`,
        [ref.id, months],
      )
    )[0];
    paidUntil = isoOrNull(u?.paid_until);
    from = isoOrNull(u?.f);
  }
  await db.query('UPDATE platform.referrals SET rewarded_at = now(), reward_months = $2, payment_id = $3, reward_from = $4, reward_to = $5 WHERE id = $1', [
    r.id,
    gets ? months : 0,
    paymentId,
    gets ? from : null,
    gets ? paidUntil : null,
  ]);
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

/**
 * Two stores of one person (the same account, e-mail or phone): not a referral. `db` reads the platform's tables.
 */
export async function isSelfReferral(db: Db, referrerShopId: number, referredShopId: number): Promise<boolean> {
  const r = (
    await db.query(
      `SELECT 1 FROM platform.shops a, platform.shops b
         LEFT JOIN platform.accounts ab ON ab.id = b.owner_account_id
        WHERE a.id = $1 AND b.id = $2 AND (
          (a.owner_account_id IS NOT NULL AND a.owner_account_id = b.owner_account_id)
          OR lower(COALESCE(a.owner_email, '-')) = lower(COALESCE(b.owner_email, ab.email, '--'))
          OR (COALESCE(a.owner_phone, '') <> '' AND a.owner_phone = COALESCE(b.owner_phone, ab.phone)))`,
      [referrerShopId, referredShopId],
    )
  ).length;
  return r > 0;
}

/** A friend's store was just made with this store's code: who to tell (once), in the referrer's language. */
export async function referralSignupNotice(t: Tenancy, referredShopId: number): Promise<{ referrerShopId: number; to: string | null; name: string; language: string; shop: string; friend: string } | null> {
  const r = (
    await t.platform.query(
      `UPDATE platform.referrals SET told_at = now() WHERE referred_shop_id = $1 AND told_at IS NULL
        RETURNING referrer_shop_id, (SELECT name FROM platform.shops WHERE id = $1) AS friend`,
      [referredShopId],
    )
  )[0];
  if (!r) return null;
  const s = (
    await t.platform.query(
      `SELECT s.name, s.owner_email, s.owner_name, a.email, a.name AS acc_name, a.language FROM platform.shops s LEFT JOIN platform.accounts a ON a.id = s.owner_account_id WHERE s.id = $1`,
      [r.referrer_shop_id],
    )
  )[0];
  if (!s) return null;
  return { referrerShopId: num(r.referrer_shop_id), to: s.email ?? s.owner_email ?? null, name: s.acc_name || s.owner_name || '', language: s.language || 'fr', shop: s.name, friend: String(r.friend ?? '') };
}

/**
 * What the store's « Referral › Referral » page shows on a multi-shop server: its code, the reward, the stores it
 * brought (started → signed up → paying), the free months earned, used and left.
 */
export async function storeReferrals(t: Tenancy, shopId: number, now = Date.now()) {
  const set = await platformSettings(t);
  const s = (await t.platform.query('SELECT referral_code FROM platform.shops WHERE id = $1', [shopId]))[0];
  const code = (s?.referral_code as string | null) ?? null;
  const rows = await t.platform.query(
    `SELECT r.*, s.name, s.trial_ends_at, s.paid_until, s.status, s.created_at AS shop_created,
            EXISTS (SELECT 1 FROM platform.payments p WHERE p.shop_id = s.id AND p.amount > 0 AND p.void_at IS NULL) AS pays
       FROM platform.referrals r JOIN platform.shops s ON s.id = r.referred_shop_id WHERE r.referrer_shop_id = $1 ORDER BY r.created_at DESC`,
    [shopId],
  );
  const used = (r: any) => {
    const m = num(r.reward_months);
    const f = r.reward_from ? Date.parse(r.reward_from) : NaN;
    const to = r.reward_to ? Date.parse(r.reward_to) : NaN;
    if (!m || !Number.isFinite(f) || !Number.isFinite(to) || to <= f) return 0;
    return Math.round(Math.min(1, Math.max(0, (now - f) / (to - f))) * m * 10) / 10;
  };
  const list = rows.map((r: any) => ({
    name: r.status === 'deleted' ? '—' : (r.name as string),
    at: isoOrNull(r.created_at)!,
    paid: !!r.rewarded_at || !!r.pays,
    months: num(r.reward_months),
    used: used(r),
    stage: (r.rewarded_at || r.pays ? 'paying' : 'signed_up') as 'started' | 'signed_up' | 'paying',
  }));
  // people who opened the link and started their sign-up, not finished yet (the last 30 days)
  const started = code
    ? await t.platform.query(
        `SELECT DISTINCT ON (lower(r.email)) r.name, r.created_at FROM platform.signup_requests r
          WHERE r.referral_code = $1 AND r.shop_id IS NULL AND r.created_at > now() - interval '30 days'
            AND NOT EXISTS (SELECT 1 FROM platform.accounts a WHERE lower(a.email) = lower(r.email))
          ORDER BY lower(r.email), r.created_at DESC LIMIT 50`,
        [code],
      )
    : [];
  const all = [
    ...started.map((r: any) => ({ name: String(r.name ?? '').split(' ')[0] || '—', at: isoOrNull(r.created_at)!, paid: false, months: 0, used: 0, stage: 'started' as const })),
    ...list,
  ];
  const earned = list.reduce((a: number, x: { months: number }) => a + x.months, 0);
  const usedAll = Math.round(list.reduce((a: number, x: { used: number }) => a + x.used, 0) * 10) / 10;
  return { code, on: set.referral.on, months: set.referral.months, list: all, earned, used: usedAll, left: Math.max(0, Math.round((earned - usedAll) * 10) / 10) };
}
