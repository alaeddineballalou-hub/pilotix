import type { OrderFormOpts } from '../../lib/modals';
import { Modal } from '../../ui/modal';
export default function OrderForm(p: OrderFormOpts & { onClose: () => void }) {
  return <Modal title="Nouvelle commande" onClose={p.onClose}>…</Modal>;
}
