// « ↶ Annuler » right after a status change: the message at the bottom of the screen carries the button (8 s); the
// person's own change of these orders goes back (orders.undo / orders.undoMany, the rules on the server).
import { rpc } from './backend';
import i18n from './i18n';
import { toast } from '../ui/toast';

export function toastUndo(text: string, ids: number[], refresh: () => void, tone: 'ok' | 'bad' | 'info' = 'ok') {
  if (!ids.length) return toast(text, tone);
  toast(text, tone, 8000, {
    label: `↶ ${i18n.t('orders.undo.do')}`,
    run: async () => {
      try {
        if (ids.length === 1) await rpc('orders.undo', { id: ids[0] });
        else {
          const r = await rpc('orders.undoMany', { ids });
          if (r.refused.length) {
            toast(i18n.t('orders.undo.some', { done: r.done.length, count: ids.length, why: r.refused[0].why }), r.done.length ? 'info' : 'bad', 6000);
            refresh();
            return;
          }
        }
        toast(i18n.t('orders.undo.done'), 'ok');
      } catch (e: any) {
        toast(e?.message ?? String(e), 'bad', 6000);
      }
      refresh();
    },
  });
}
