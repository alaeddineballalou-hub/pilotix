import { canSetStatus, Language, Order, ORDER_STATUSES, OrderStatus, STATUS_FLOW, WILAYAS } from '@pilotix/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, Loading, StatusPill } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDZD } from '../lib/i18n';
import { enqueue, isNetworkError, newClientId } from '../lib/offline';

export function OrderDrawer({ id, initial, onClose }: { id: number; initial?: Order; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Language;
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api.order(id), initialData: initial });
  const events = useQuery({ queryKey: ['order', id, 'events'], queryFn: () => api.orderEvents(id) });
  const products = useQuery({ queryKey: ['products'], queryFn: () => api.products(), staleTime: 300_000 });
  const staff = useQuery({ queryKey: ['users'], queryFn: api.users, staleTime: 300_000 });

  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [note, setNote] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [livreurId, setLivreurId] = useState<number | ''>('');
  const [tracking, setTracking] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const o = order.data;
  const boss = can('manager');
  const next: OrderStatus[] = o
    ? ORDER_STATUSES.filter((s) => STATUS_FLOW[o.status].includes(s) && (boss || canSetStatus(user?.roles ?? [], o.status, s)))
    : [];

  const save = useMutation({
    mutationFn: async () => {
      if (!o || !status) return;
      const body = {
        status,
        note: note || undefined,
        callbackAt: callbackAt ? new Date(callbackAt).toISOString() : null,
        livreurId: livreurId || undefined,
        tracking: tracking || undefined,
        clientId: newClientId(),
      };
      try {
        const updated = await api.setStatus(o.id, body);
        qc.setQueryData(['order', o.id], updated);
        qc.invalidateQueries({ queryKey: ['orders'] });
        qc.invalidateQueries({ queryKey: ['order', o.id, 'events'] });
        setMsg('');
      } catch (e) {
        // No network: keep the change on the phone and send it later.
        if (isNetworkError(e) && status !== 'assigned') {
          await enqueue({ orderId: o.id, kind: 'status', status, note: note || undefined, callbackAt: body.callbackAt });
          setMsg(t('orders.queued'));
        } else throw e;
      }
      setStatus('');
      setNote('');
      setCallbackAt('');
    },
    onError: (e: Error) => setMsg(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const productName = (pid: number) => products.data?.find((p) => p.id === pid)?.name ?? `#${pid}`;
  const livreurs = staff.data?.filter((u) => u.roles.includes('livreur') && u.active) ?? [];

  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow ltr">{o?.reference}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('orders.close')}>
            <Icon.close />
          </button>
        </div>
        {!o ? (
          <Loading />
        ) : (
          <>
            <section className="card">
              <div className="row">
                <b className="grow">{o.customerName}</b>
                <StatusPill status={o.status} />
              </div>
              <div className="row">
                <a className="btn small" href={`tel:${o.phone}`}>
                  <Icon.phone /> <span className="ltr">{o.phone}</span>
                </a>
                {o.possibleDuplicate && <span className="flag">{t('orders.duplicate')}</span>}
                <span className="small muted">
                  {t('orders.delivered', { count: o.customerDelivered ?? 0 })} · {t('orders.returned', { count: o.customerReturned ?? 0 })}
                </span>
              </div>
              <span>
                {String(o.wilaya).padStart(2, '0')} · {WILAYAS[o.wilaya - 1]} — {o.commune}
              </span>
              {o.address && <span className="muted">{o.address}</span>}
              {o.callbackAt && (
                <span className="small">
                  {t('orders.callbackAt')} <span className="ltr">{formatDate(o.callbackAt, lang)}</span>
                </span>
              )}
              {o.tracking && (
                <span className="small">
                  {t('orders.tracking')}: <span className="ltr">{o.tracking}</span>
                </span>
              )}
            </section>

            <section className="card">
              <h2>{t('orders.items')}</h2>
              <table className="tbl">
                <tbody>
                  {o.items.map((it, i) => (
                    <tr key={i}>
                      <td>
                        {productName(it.productId)}
                        {it.variant && <span className="muted"> · {it.variant}</span>}
                      </td>
                      <td className="n ltr">×{it.quantity}</td>
                      <td className="n ltr">{formatDZD(it.unitPrice * it.quantity, lang)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>{t('orders.deliveryFee')}</td>
                    <td />
                    <td className="n ltr">{formatDZD(o.deliveryFee, lang)}</td>
                  </tr>
                  {o.discount > 0 && (
                    <tr>
                      <td>{t('orders.discount')}</td>
                      <td />
                      <td className="n ltr">−{formatDZD(o.discount, lang)}</td>
                    </tr>
                  )}
                  <tr>
                    <td>
                      <b>{t('orders.total')}</b>
                    </td>
                    <td />
                    <td className="n ltr">
                      <b>{formatDZD(o.total, lang)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            {next.length > 0 && (
              <form className="card" onSubmit={submit}>
                <h2>{t('orders.setStatus')}</h2>
                <div className="tabs" style={{ flexWrap: 'wrap' }}>
                  {next.map((s) => (
                    <button type="button" key={s} className={`tab ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
                      {t(`status.${s}`)}
                    </button>
                  ))}
                </div>
                {(status === 'callback' || status === 'postponed' || status === 'no_answer') && (
                  <label className="field">
                    <span>{t('orders.callbackAt')}</span>
                    <input type="datetime-local" dir="ltr" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} required={status !== 'no_answer'} />
                  </label>
                )}
                {status === 'assigned' && (
                  <label className="field">
                    <span>{t('orders.livreur')}</span>
                    <select required value={livreurId} onChange={(e) => setLivreurId(e.target.value ? Number(e.target.value) : '')}>
                      <option value="" />
                      {livreurs.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {status === 'shipped' && (
                  <label className="field">
                    <span>{t('orders.tracking')}</span>
                    <input dir="ltr" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                  </label>
                )}
                <label className="field">
                  <span>{t('orders.note')}</span>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                {msg && <p className={msg === t('orders.queued') ? 'muted' : 'err'}>{msg}</p>}
                <button className="btn primary" disabled={!status || save.isPending}>
                  {t('orders.save')}
                </button>
              </form>
            )}

            <section className="card">
              <h2>{t('orders.history')}</h2>
              <ul className="timeline">
                {events.data?.map((ev) => (
                  <li key={ev.id}>
                    <span className="small muted ltr">{formatDate(ev.createdAt, lang)}</span> · <b>{ev.userName ?? '—'}</b>
                    <div>
                      {ev.type === 'status' && ev.toValue ? (
                        <>
                          {ev.fromValue && t(`status.${ev.fromValue}`)} → {t(`status.${ev.toValue}`)}
                        </>
                      ) : ev.type === 'created' ? (
                        t('status.new')
                      ) : (
                        ev.type
                      )}
                      {ev.note && <div className="muted">{ev.note}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
