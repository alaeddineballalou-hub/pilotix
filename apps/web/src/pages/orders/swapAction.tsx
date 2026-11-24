// « Swap » on a parcel the customer cancelled, on its way back: always there (Suivi's rule, 9 Nov 2026), in Annulé too —
// the same Annulé everywhere (owner's choice, 24 Nov 2026). It gives the parcel to another confirmed order.
import type { Order } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rightOn } from '../../lib/rights';
import { SellerScope } from '../../lib/seller';
import { useSession } from '../../lib/session';
import { SwapModal, SwapSheetModal, type SwapResult } from '../suivi/Swap';

/** The seller of an order of a list over every seller (an agency's « Tous les vendeurs »): its swap is done there. */
const sellerOf = (o: Order) => (o as { seller?: { id: number } }).seller?.id;

/**
 * The people who follow the parcels or confirm the orders (and may swap: Utilisateurs › Rôles « Swap »): `button` on a
 * parcel coming back, `dialogs` to draw once (the swap window, then « Copier pour ZR »).
 */
export function useSwap() {
  const { t } = useTranslation();
  const { has } = useSession();
  const can = has('suivi', 'confirmation') && rightOn('act:suivi.swap');
  const [pick, setPick] = useState<Order | null>(null);
  const [done, setDone] = useState<{ r: SwapResult; seller?: number } | null>(null);
  const scoped = (seller: number | undefined, node: ReactNode) => (seller ? <SellerScope seller={seller}>{node}</SellerScope> : node);
  const button = (o: Order): ReactNode =>
    can && o.followStatus === 'returning' ? (
      <button
        type="button"
        className="btn small primary nowrap"
        onClick={(e) => {
          e.stopPropagation();
          setPick(o);
        }}
      >
        {t('suivi.act.swap')}
      </button>
    ) : null;
  const dialogs = (
    <>
      {pick &&
        scoped(
          sellerOf(pick),
          <SwapModal
            o={pick}
            onClose={() => setPick(null)}
            onDone={(r) => {
              setDone({ r, seller: sellerOf(pick) });
              setPick(null);
            }}
          />,
        )}
      {done && scoped(done.seller, <SwapSheetModal {...done.r} fresh onClose={() => setDone(null)} />)}
    </>
  );
  return { can, button, dialogs };
}
