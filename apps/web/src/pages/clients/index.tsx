// Clients: search, "Liste noire seulement", order history and blacklist — as in the original app.
import { CONF_TONE } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, when, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Card, Empty, ErrorBox, Field, Loading, Pager, StatusBadge } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import type { PageProps } from '../registry';

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

export function Clients(_: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [black, setBlack] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(60);
  const [open, setOpen] = useState<number | null>(null);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, black]);
  const list = useRpc('customers.list', { q: dq || undefined, blacklisted: black || undefined, page, pageSize: size });
  const rows = list.data?.rows;

  return (
    <>
      <Card title={t('clients.title')}>
        <div className="row">
          <div className="grow">
            <input type="search" placeholder={t('clients.search')} aria-label={t('clients.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={black} onChange={(e) => setBlack(e.target.checked)} />
            {t('clients.onlyBlack')}
          </label>
        </div>
        {list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{t('clients.empty')}</Empty>
        ) : (
          <div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('clients.col.client')}</th>
                    <th>{t('clients.col.phone')}</th>
                    <th>{t('clients.col.wilaya')}</th>
                    <th className="num">{t('clients.col.orders')}</th>
                    <th className="num">{t('clients.col.delivered')}</th>
                    <th className="num">{t('clients.col.returned')}</th>
                    <th>{t('clients.col.last')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                      <td data-l={t('clients.col.client')}>
                        <b>{c.name || '—'}</b>
                        {c.blacklisted && <span className="flag">{t('clients.black')}</span>}
                      </td>
                      <td data-l={t('clients.col.phone')}>
                        <span className="ltr">{c.phone}</span>
                      </td>
                      <td data-l={t('clients.col.wilaya')}>{c.wilayaId ? wilayaName(c.wilayaId) : '—'}</td>
                      <td className="num" data-l={t('clients.col.orders')}>
                        {n(c.orders)}
                      </td>
                      <td className="num" data-l={t('clients.col.delivered')}>
                        {n(c.delivered)}
                      </td>
                      <td className="num" data-l={t('clients.col.returned')}>
                        <span className={c.returned ? 'stock-low' : undefined}>{n(c.returned)}</span>
                      </td>
                      <td data-l={t('clients.col.last')}>{c.lastOrderAt ? when(c.lastOrderAt).replace(/\s\d{2}:\d{2}$/, '') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={page}
              pageSize={size}
              total={list.data!.total}
              onPage={setPage}
              onSize={(s) => {
                setSize(s);
                setPage(1);
              }}
              sizes={[60, 100, 200]}
            />
          </div>
        )}
      </Card>
      {open !== null && <History id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function History({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const h = useRpc('customers.history', { id }, { placeholderData: undefined });
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const c = h.data?.customer;
  const set = useAction('customers.setBlacklist', {
    success: t('clients.updated'),
    onDone: () => {
      setAsking(false);
      setReason('');
    },
  });
  const footer = c && (
    <>
      <button className="btn" onClick={onClose}>
        {t('common.close')}
      </button>
      {c.blacklisted ? (
        <button className="btn" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, on: false })}>
          {t('clients.unblack')}
        </button>
      ) : asking ? (
        <button className="btn danger" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, on: true, reason: reason.trim() || null })}>
          {t('clients.confirmBlack')}
        </button>
      ) : (
        <button className="btn danger" onClick={() => setAsking(true)}>
          {t('clients.toBlack')}
        </button>
      )}
    </>
  );
  return (
    <Modal title={c ? `${c.name} · ${c.phone}` : t('common.loading')} onClose={onClose} wide footer={footer}>
      {h.error ? (
        <ErrorBox error={h.error} />
      ) : !h.data ? (
        <Loading />
      ) : (
        <>
          {c!.blacklisted && <div className="badbox">{c!.blacklistReason ? t('clients.inBlackReason', { reason: c!.blacklistReason }) : t('clients.inBlack')}</div>}
          <p className="muted small">{t('clients.summary', { orders: c!.orders, delivered: c!.delivered, returned: c!.returned, cancelled: c!.cancelled })}</p>
          {asking && !c!.blacklisted && (
            <Field label={t('clients.reason')}>
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('clients.reasonPh')} />
            </Field>
          )}
          {h.data.orders.length === 0 ? (
            <Empty>{t('clients.noOrders')}</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('clients.col.order')}</th>
                    <th className="wide">{t('clients.col.products')}</th>
                    <th>{t('clients.col.variant')}</th>
                    <th className="num">{t('clients.col.total')}</th>
                    <th>{t('clients.col.conf')}</th>
                    <th>{t('clients.col.follow')}</th>
                  </tr>
                </thead>
                <tbody>
                  {h.data.orders.map((o) => (
                    <tr
                      key={o.id}
                      className="clickable"
                      onClick={() => {
                        onClose();
                        openOrder(o.id);
                      }}
                    >
                      <td data-l={t('clients.col.order')}>
                        <b className="ltr">{o.ref}</b>
                        <small>{when(o.createdAt)}</small>
                      </td>
                      <td className="wide" data-l={t('clients.col.products')}>
                        {o.itemsText}
                      </td>
                      <td data-l={t('clients.col.variant')}>{o.variantsText || '—'}</td>
                      <td className="num ltr" data-l={t('clients.col.total')}>
                        {da(o.total)}
                      </td>
                      <td data-l={t('clients.col.conf')}>
                        {o.confStatus === 'no_answer' ? (
                          <span className={`badge t-${CONF_TONE.no_answer}`}>{t('orders.attemptN', { n: String(Math.max(1, o.attempts)).padStart(2, '0') })}</span>
                        ) : (
                          <StatusBadge kind="conf" status={o.confStatus} />
                        )}
                      </td>
                      <td data-l={t('clients.col.follow')}>
                        <StatusBadge kind="follow" status={o.followStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
