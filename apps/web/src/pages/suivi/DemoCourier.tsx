import { useState } from 'react';
import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { inBrowserDemo } from '../../lib/backend';
import { useSession } from '../../lib/session';
import { useAction } from '../../lib/query';
import { toast } from '../../ui/toast';

/** Demo shop only: feed a fake tracking answer through the same core as a courier sync. */
export function DemoCourier({ rows }: { rows: Order[] }) {
  const { session, has } = useSession();
  const { t } = useTranslation();
  const [orderId, setOrderId] = useState('');
  const [status, setStatus] = useState<'out_for_delivery' | 'alert' | 'delivered' | 'returning' | 'lost' | 'error'>('alert');
  const act = useAction('delivery.demoScenario', { onDone: (r) => toast(r.error ?? t('suivi.demo.done', { n: r.changed }), r.error ? 'bad' : 'ok') });
  if ((!inBrowserDemo() && !session?.shop?.demo) || !has('suivi')) return null;
  const choices = rows.filter((o) => o.shippedAt && o.tracking && o.companyId && ['shipped', 'out_for_delivery', 'failed', 'alert', 'returning'].includes(o.followStatus ?? ''));
  const selected = choices.find((o) => String(o.id) === orderId);
  return <details className="card" style={{ padding: 12, marginBottom: 12 }}>
    <summary>{t('suivi.demo.title')}</summary>
    <p className="muted small">{t('suivi.demo.help')}</p>
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      <select style={{ maxWidth: '100%', minWidth: 0, flex: '1 1 220px' }} aria-label={t('suivi.rec.order')} value={selected ? orderId : ''} onChange={(e) => setOrderId(e.target.value)}>
        <option value="">{t('suivi.demo.choose')}</option>
        {choices.map((o) => <option key={o.id} value={o.id}>{o.ref} · {o.companyName} · {o.customerName}</option>)}
      </select>
      <select style={{ maxWidth: '100%', minWidth: 0, flex: '1 1 220px' }} aria-label={t('suivi.demo.response')} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
        {(['out_for_delivery', 'alert', 'delivered', 'returning', 'lost', 'error'] as const).map((s) => <option key={s} value={s}>{s === 'error' ? t('suivi.demo.error') : t(`status.follow.${s}`)}</option>)}
      </select>
      <button className="btn" disabled={!selected || act.isPending} onClick={() => selected && act.mutate({ orderId: selected.id, status })}>{t('suivi.demo.run')}</button>
    </div>
  </details>;
}
