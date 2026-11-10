// The store's side of « J'ai payé » (the pay window: banners, lock screen). The store's admins pay Pilotix by BaridiMob /
// CCP / virement outside the app, then send the period (1 month or 1 year), the way, a reference and the receipt's photo.
// The amount is the plan's (never the screen's). One claim waits at a time; the store keeps working meanwhile (nothing
// changes in its lock). The control room checks it (platform/procs.ts › p.claims.*); see platform/claims.ts.
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { CLAIM_COLUMNS, CLAIM_METHODS, CLAIM_PHOTO_MAX, CLAIM_PHOTO_RE, claimAmount, claimRow } from '../platform/claims';
import { loadShop, Shop } from '../platform/shops';

const NO_SERVER = 'Le paiement en ligne de reçu fonctionne sur le serveur Pilotix (pas dans cet aperçu)';
const WAITING = 'Un paiement attend déjà la vérification de Pilotix';

/** The shop holding the plan the person pays (one plan per seller: their first boutique). */
async function payingShop(ctx: Ctx): Promise<Shop> {
  if (!ctx.t || !ctx.shop) throw bad(NO_SERVER);
  const here = await loadShop(ctx.t, { id: ctx.shop.id });
  if (!here) throw bad(NO_SERVER);
  const s = here.mainShopId ? await loadShop(ctx.t, { id: here.mainShopId }) : here;
  if (!s || s.primary || s.demo || s.kind !== 'store') throw bad('Pas de paiement pour cette boutique');
  return s;
}

/** Sends the claim to Pilotix's team on WhatsApp (server hook), then keeps what happened. Never fails the store's request. */
function alertTeam(ctx: Ctx, claimId: number): Promise<void> {
  const t = ctx.t!;
  const keep = (st: string) => t.platform.query('UPDATE platform.payment_claims SET wa_status = $2 WHERE id = $1', [claimId, st.slice(0, 200)]).then(() => undefined);
  const hook = ctx.server?.payAlert;
  if (!hook) return keep('off').catch(() => undefined);
  return Promise.resolve()
    .then(() => hook(claimId))
    .then((st) => keep(st || 'off'))
    .catch((e) => {
      console.warn(`[pay alert] claim ${claimId}: ${(e as Error)?.message ?? e}`);
      return keep(`erreur : ${(e as Error)?.message ?? 'inconnue'}`).catch(() => undefined);
    });
}

export const billingProcs = {
  /** The pay window: the plan's prices (1 month, 1 year) and the shop's last claims (the newest first). */
  'billing.claims': proc([], z.object({}), async (ctx) => {
    const s = await payingShop(ctx);
    const rows = await ctx.t!.platform.query(
      `SELECT ${CLAIM_COLUMNS} FROM platform.payment_claims c LEFT JOIN platform.plans pl ON pl.id = c.plan_id WHERE c.shop_id = $1 ORDER BY c.id DESC LIMIT 5`,
      [s.id],
    );
    return {
      shop: { id: s.id, name: s.name },
      plan: s.plan && !s.plan.system ? s.plan.name : null,
      prices: { month: claimAmount(s.plan, 1), year: claimAmount(s.plan, 12) },
      claims: rows.map((r: any) => {
        const c = claimRow(r);
        // the store does not need the team's WhatsApp outcome
        return { id: c.id, plan: c.plan, months: c.months, amount: c.amount, method: c.method, reference: c.reference, status: c.status, reason: c.reason, createdAt: c.createdAt, decidedAt: c.decidedAt };
      }),
    };
  }),

  /** « J'ai payé »: the period, the way, a reference and the receipt's photo (a JPEG data URL). */
  'billing.claim': proc(
    [],
    z.object({
      months: z.union([z.literal(1), z.literal(12)]),
      method: z.enum(CLAIM_METHODS),
      reference: z.string().trim().max(120).optional(),
      photo: z.string().max(CLAIM_PHOTO_MAX, 'Photo trop lourde : prenez-la plus petite').regex(CLAIM_PHOTO_RE, 'Ajoutez la photo du reçu (une image)'),
    }),
    async (ctx, i) => {
      const s = await payingShop(ctx);
      const amount = claimAmount(s.plan, i.months);
      if (amount === null) throw bad('Pas de formule à payer pour cette boutique');
      const t = ctx.t!;
      if ((await t.platform.query(`SELECT 1 FROM platform.payment_claims WHERE shop_id = $1 AND status = 'pending'`, [s.id])).length) throw bad(WAITING);
      const p = ctx.session.profile;
      let id: number;
      try {
        const r = await t.platform.query(
          `INSERT INTO platform.payment_claims (shop_id, plan_id, months, amount, method, reference, photo, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
          [s.id, s.plan!.id, i.months, amount, i.method, i.reference || null, i.photo, `${p.name} (${p.email})`.slice(0, 200)],
        );
        id = num(r[0].id);
      } catch (e) {
        // two sent at the same moment: the unique index keeps one
        if (/payment_claims_one_pending|duplicate key|unique/i.test(String((e as Error)?.message))) throw bad(WAITING);
        throw e;
      }
      void alertTeam(ctx, id);
      return { id, amount, months: i.months, status: 'pending' as const };
    },
  ),
};
