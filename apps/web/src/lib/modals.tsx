import { lazy, ReactNode, Suspense, useEffect, useState } from 'react';
import { Loading } from '../ui/kit';
import { useBackLayer } from './backLayer';
import { ambientSeller, Seller, SellerScope } from './seller';
import { AgentView } from './session';
import { useIsPhone } from './useMedia';

/** Options for the order form (new order, edit, exchange). */
export interface OrderFormOpts {
  orderId?: number;
  /** create an exchange for this order */
  exchangeOf?: number;
  /** prefill a new order (e.g. from a SAV ticket) */
  prefill?: Record<string, unknown>;
  onSaved?: (orderId: number) => void;
}

/** seller: in a confirmation agency's space, the store the order belongs to */
type Open = { kind: 'card'; id: number; seller?: Seller } | { kind: 'form'; opts: OrderFormOpts; seller?: Seller } | null;
let current: Open = null;
const subs = new Set<(o: Open) => void>();
const set = (o: Open) => {
  current = o;
  subs.forEach((s) => s(o));
};

/**
 * Opens the order card (details, history, actions). `seller` (an agency's space): the order's store, by default the
 * seller of what is open on screen.
 */
export const openOrder = (id: number, seller?: Seller) => set({ kind: 'card', id, seller: seller ?? ambientSeller() });
/** Opens the order form: new order, edit (orderId) or exchange (exchangeOf). */
export const openOrderForm = (opts: OrderFormOpts = {}) => set({ kind: 'form', opts, seller: ambientSeller() });
export const closeModal = () => set(null);

const OrderCard = lazy(() => import('../pages/orders/OrderCard'));
const OrderForm = lazy(() => import('../pages/orders/OrderForm'));

/** On a phone the back button closes the opened order (not the page under it). */
function BackCloses({ onClose }: { onClose: () => void }) {
  useBackLayer(onClose);
  return null;
}

export function ModalHost() {
  const [open, setOpen] = useState<Open>(current);
  const phone = useIsPhone();
  useEffect(() => {
    subs.add(setOpen);
    return () => {
      subs.delete(setOpen);
    };
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={<Loading />}>
      {phone && open.kind === 'card' && <BackCloses onClose={closeModal} />}
      <OfSeller seller={open.seller}>{open.kind === 'card' ? <OrderCard id={open.id} onClose={closeModal} /> : <OrderForm {...open.opts} onClose={closeModal} />}</OfSeller>
    </Suspense>
  );
}

/** An order of one of an agency's sellers: shown inside that store, as the agency's agents see it there. */
function OfSeller({ seller, children }: { seller?: Seller; children: ReactNode }) {
  if (seller === undefined) return <>{children}</>;
  return (
    <SellerScope seller={seller}>
      <AgentView>{children}</AgentView>
    </SellerScope>
  );
}
