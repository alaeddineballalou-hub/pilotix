import { Modal } from '../../ui/modal';
export default function OrderCard({ id, onClose }: { id: number; onClose: () => void }) {
  return <Modal title={`#${id}`} onClose={onClose}>…</Modal>;
}
