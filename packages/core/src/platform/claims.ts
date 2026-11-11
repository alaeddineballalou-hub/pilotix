// « J'ai payé »: a store pays Pilotix by BaridiMob / CCP / virement outside the app, then sends the receipt's photo from
// its pay window (modules/billing.ts). The control room checks it (procs.ts › p.claims.*): « Valider » records a real
// payment like « Enregistrer un paiement », « Refuser » gives the store a reason (it may send again). One pending claim
// per shop. The claim is the shop's that holds the plan (one plan per seller: their first boutique). The amount always
// comes from the plan (1 month, or a year: the plan's year price, else 10 months). Pilotix's team hears of each claim on
// WhatsApp when the control room set its numbers (the server's `payAlert` hook; its outcome is kept in wa_status).
import { isoOrNull, num, numOrNull } from '../db';
import type { Plan } from './shops';

/** The ways a store may say it paid (a subset of the control room's PAYMENT_METHODS). */
export const CLAIM_METHODS = ['baridimob', 'ccp', 'virement'] as const;
export type ClaimMethod = (typeof CLAIM_METHODS)[number];

/** The biggest receipt photo kept (its data URL: about 900 KB of JPEG). */
export const CLAIM_PHOTO_MAX = 1_250_000;
export const CLAIM_PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;

/** What 1 month or 1 year of this plan costs (DA); null when the plan is not paid (none, internal, free). */
export function claimAmount(plan: Pick<Plan, 'priceMonth' | 'priceYear' | 'system'> | null | undefined, months: 1 | 12): number | null {
  if (!plan || plan.system || !(plan.priceMonth > 0)) return null;
  return months === 1 ? plan.priceMonth : plan.priceYear && plan.priceYear > 0 ? plan.priceYear : plan.priceMonth * 10;
}

export type ClaimStatus = 'pending' | 'accepted' | 'refused';

/** A claim as the screens show it (never the photo: it is asked for alone). */
export function claimRow(r: any) {
  return {
    id: num(r.id),
    shopId: num(r.shop_id),
    planId: numOrNull(r.plan_id),
    plan: (r.plan_name as string | null | undefined) ?? null,
    months: num(r.months) as 0 | 1 | 12,
    /** a pack of AI credits (months = 0), else null */
    credits: r.credits == null ? null : num(r.credits),
    packKey: (r.pack_key as string | null | undefined) ?? null,
    amount: num(r.amount),
    method: r.method as ClaimMethod,
    reference: (r.reference as string | null) ?? null,
    hasPhoto: !!r.has_photo,
    status: r.status as ClaimStatus,
    reason: (r.reason as string | null) ?? null,
    sentBy: (r.sent_by as string | null) ?? null,
    createdAt: isoOrNull(r.created_at)!,
    decidedAt: isoOrNull(r.decided_at),
    paymentId: numOrNull(r.payment_id),
    waStatus: (r.wa_status as string | null) ?? null,
  };
}
export type ClaimRow = ReturnType<typeof claimRow>;

/** The columns claimRow reads (the photo only as « has one »). */
export const CLAIM_COLUMNS = `c.id, c.shop_id, c.plan_id, pl.name AS plan_name, c.months, c.amount, c.method, c.reference, (c.photo IS NOT NULL) AS has_photo,
  c.status, c.reason, c.sent_by, c.created_at, c.decided_at, c.payment_id, c.wa_status, c.credits, c.pack_key`;
