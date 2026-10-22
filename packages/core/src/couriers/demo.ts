// Browser preview (no server): realistic fake answers from the couriers.
import type { CourierKind, FollowStatus } from '@pilotix/shared';


/** One ID: the parcel is sent with the order ID (PX…) as its tracking number. */
export function fakeTracking(_kind: CourierKind, ref: string): string {
  return ref;
}

/** What each courier would say for each step (courier words, as stored in ext_status). */
const WORDS: Partial<Record<CourierKind, Partial<Record<FollowStatus, string>>>> = {
  yalidine: { prepared: 'En préparation', shipped: 'Vers Wilaya', out_for_delivery: 'Sorti en livraison', failed: 'Tentative échouée', delivered: 'Livré', returning: 'Retour vers vendeur' },
  zr: { prepared: 'Pret a expedier', shipped: 'Vers wilaya', out_for_delivery: 'En livraison', failed: 'Echec livraison · Client injoignable', delivered: 'Livré', returning: 'Retourné' },
  zr_legacy: { prepared: 'En Preparation', shipped: 'Dispatcher', out_for_delivery: 'En livraison', failed: 'Appel sans Réponse 1', delivered: 'Livrée', returning: 'Retour Livreur' },
  ecotrack: { prepared: 'Prêt à expédier', shipped: 'Vers wilaya', out_for_delivery: 'En livraison', failed: 'Attempt delivery · Client absent', delivered: 'Livre non encaissé', returning: 'Retours chez livreur' },
  noest: { prepared: 'Upload', shipped: 'Validation reception', out_for_delivery: 'Fdr activated', failed: 'Non livré', delivered: 'Livré', returning: 'Return asked by customer' },
};
export const word = (kind: CourierKind, s: FollowStatus) => WORDS[kind]?.[s] ?? WORDS.yalidine![s] ?? s;

/** Next step of a parcel on the road, or null when it does not move this time. */
export function nextStep(cur: FollowStatus, hasTracking: boolean, r = Math.random()): FollowStatus | null {
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
      return r < 0.2 ? 'out_for_delivery' : null;
    default:
      return null;
  }
}
