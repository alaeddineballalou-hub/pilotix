// Browser preview (no server): realistic fake answers from the couriers.
import type { CourierKind, FollowStatus } from '@pilotix/shared';
import type { ClaimState } from './types';


/**
 * The courier's own tracking number, in its style (yal-4K7P2Q, ZR-12345678…): when a parcel is sent to a company, this
 * number replaces the Pilotix one on screen and on the label, as the real couriers do. Procolis (ZR, old platform) keeps
 * the order reference, like its API. `salt` gives a parcel sent again after a cancel a new number; the demo data uses 0.
 */
export function fakeTracking(kind: CourierKind, ref: string, salt = Date.now()): string {
  const n = Number(ref.replace(/\D/g, '')) || 0;
  const mix = (n * 2654435761 + (salt % 1_000_003) * 40503) % 2176782336; // 36^6
  const d8 = String(mix % 100_000_000).padStart(8, '0');
  switch (kind) {
    case 'yalidine':
      return `yal-${mix.toString(36).toUpperCase().padStart(6, '0')}`;
    case 'zr':
      return `ZR-${d8}`;
    case 'zr_legacy':
      return ref;
    case 'noest':
      return `NOE-${d8}`;
    case 'ecotrack':
      return `ECO-${d8}`;
    case 'maystro':
      return `MAY${d8}`;
    case 'zimou':
      return `ZIM-${d8}`;
    case 'elogistia':
      return `ELO${d8}`;
    case 'ecom':
      return `ECM${d8}`;
    case 'mdm':
      return `MDM-${d8}`;
    case 'near':
      return `NEAR-${d8}`;
    default:
      return `TRK-${d8}`;
  }
}

/** What each courier would say for each step (courier words, as stored in ext_status). */
const WORDS: Partial<Record<CourierKind, Partial<Record<FollowStatus, string>>>> = {
  yalidine: { prepared: 'En préparation', shipped: 'Vers Wilaya', out_for_delivery: 'Sorti en livraison', failed: 'Tentative échouée', alert: 'Tentative échouée', delivered: 'Livré', returning: 'Retour vers vendeur' },
  zr: { prepared: 'Pret a expedier', shipped: 'Vers wilaya', out_for_delivery: 'En livraison', failed: 'Echec livraison · Client injoignable', alert: 'Echec livraison · Client injoignable', delivered: 'Livré', returning: 'Retourné' },
  zr_legacy: { prepared: 'En Preparation', shipped: 'Dispatcher', out_for_delivery: 'En livraison', failed: 'Appel sans Réponse 1', alert: 'Appel sans Réponse 2', delivered: 'Livrée', returning: 'Retour Livreur' },
  ecotrack: { prepared: 'Prêt à expédier', shipped: 'Vers wilaya', out_for_delivery: 'En livraison', failed: 'Attempt delivery · Client absent', alert: 'Attempt delivery · Client absent', delivered: 'Livre non encaissé', returning: 'Retours chez livreur' },
  noest: { prepared: 'Upload', shipped: 'Validation reception', out_for_delivery: 'Fdr activated', failed: 'Non livré', alert: 'Non livré', delivered: 'Livré', returning: 'Return asked by customer' },
};
export const word = (kind: CourierKind, s: FollowStatus) => WORDS[kind]?.[s] ?? WORDS.yalidine![s] ?? s;

/** Next step of a parcel on the road, or null when it does not move this time. */
export function nextStep(cur: FollowStatus, hasTracking: boolean, r = Math.random(), expanded = false): FollowStatus | null {
  switch (cur) {
    case 'prepared':
      return hasTracking && r < 0.5 ? 'shipped' : null;
    case 'shipped':
      return r < 0.45 ? 'out_for_delivery' : null;
    case 'out_for_delivery':
      return r < 0.45 ? 'delivered' : r < 0.58 ? 'failed' : r < 0.62 ? 'returning' : null;
    case 'failed':
      return r < 0.35 ? 'out_for_delivery' : r < 0.5 ? 'returning' : null;
    case 'alert':
      return r < 0.2 ? 'out_for_delivery' : expanded && r < 0.3 ? 'returning' : null;
    case 'returning':
      return expanded && r < 0.45 ? 'returned' : null;
    case 'in_exchange':
      return expanded && r < 0.4 ? 'exchanged' : null;
    default:
      return null;
  }
}

/** Browser preview: the weight ZR counts for a parcel — whole kilos, one heavy parcel (4 kg or more) in three 2 kg more. */
export const zrWeighs = (orderId: number, productsKg: unknown) => {
  const d = Math.max(1, Math.round(Number(productsKg) || 0));
  return d + (d >= 4 && orderId % 3 === 0 ? 2 : 0);
};

/** A fake courier-API reply for a complaint in a demo shop. It cannot call a real courier.
 * Older claims advance through "received", "processing" and "answered". One in three eventually resolves,
 * so testers can see all outcomes; the claim's ID makes the scenario stable across repeated syncs.
 */
export function demoClaimState(extId: string, claimId: number, sentAt: string | null, now: number): ClaimState {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  const hours = Number.isFinite(sent) ? Math.max(0, (now - sent) / 3_600_000) : 0;
  const resolved = hours >= 72 && claimId % 3 === 0;
  return {
    extId,
    status: resolved ? 'Résolue' : hours >= 24 ? 'Réponse apportée' : hours >= 6 ? 'En cours de traitement' : 'Nouvelle',
    resolved,
    answer: hours >= 24 ? 'Simulation API : le transporteur a contacté le client et planifié une nouvelle livraison.' : null,
  };
}
