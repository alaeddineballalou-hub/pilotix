import { lazy, Suspense, useEffect, useState } from 'react';
import { Loading } from '../ui/kit';

/** Options for the order form (new order, edit, exchange). */
export interface OrderFormOpts {
  orderId?: number;
  /** create an exchange for this order */
  exchangeOf?: number;
  /** prefill a new order (e.g. from a SAV ticket) */
  prefill?: Record<string, unknown>;
  onSaved?: (orderId: number) => void;
}

type Open = { kind: 'card'; id: number } | { kind: 'form'; opts: OrderFormOpts } | null;
let current: Open = null;
const subs = new Set<(o: Open) => void>();
const set = (o: Open) => {
  current = o;
  subs.forEach((s) => s(o));
};

/** Opens the order card (details, history, actions). */
export const openOrder = (id: number) => set({ kind: 'card', id });
/** Opens the order form: new order, edit (orderId) or exchange (exchangeOf). */
export const openOrderForm = (opts: OrderFormOpts = {}) => set({ kind: 'form', opts });
export const closeModal = () => set(null);

const OrderCard = lazy(() => import('../pages/orders/OrderCard'));
const OrderForm = lazy(() => import('../pages/orders/OrderForm'));

export function ModalHost() {
  const [open, setOpen] = useState<Open>(current);
  useEffect(() => {
    subs.add(setOpen);
    return () => {
      subs.delete(setOpen);
    };
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={<Loading />}>
      {open.kind === 'card' ? <OrderCard id={open.id} onClose={closeModal} /> : <OrderForm {...open.opts} onClose={closeModal} />}
    </Suspense>
  );
}
