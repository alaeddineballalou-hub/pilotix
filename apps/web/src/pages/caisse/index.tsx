// « Caisse » (admin): À recevoir (delivered, money not received yet, by company / livreur) · Déjà reçu (versements) · Livreurs.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadCsv } from '../../lib/files';
import { da, dateTime, n, wilayaName, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { openOrder } from '../../lib/modals';
import { Empty, ErrorBox, Help, Kpi, Kpis, Loading, TicketTag } from '../../ui/kit';
import type { PageProps } from '../registry';
import { LivreursCash } from './LivreursCash';

export function Caisse({ sub }: PageProps) {
  const { t } = useTranslation();
  const current = sub === 'done' ? 'done' : sub === 'livreurs' ? 'livreurs' : 'due';
  const tabs = [
    { key: 'due', label: t('caisse.tabs.due') },
    { key: 'done', label: t('caisse.tabs.done') },
    { key: 'livreurs', label: t('caisse.tabs.livreurs') },
  ];
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>
            {t('caisse.title')}
            <Help text={t('caisse.help')} label={t('caisse.title')} />
          </h2>
          <div className="tabs" role="tablist">
            {tabs.map((x) => (
              <a key={x.key} role="tab" aria-selected={current === x.key} className={`tab ${current === x.key ? 'on' : ''}`} href={`#/caisse/${x.key}`} style={{ textDecoration: 'none' }}>
                {x.label}
              </a>
            ))}
          </div>
        </div>
      </div>
      {current === 'due' && <Due />}
      {current === 'done' && <Done />}
      {current === 'livreurs' && <LivreursCash />}
    </>
  );
}

type Group = NonNullable<ReturnType<typeof useRpc<'cash.due'>>['data']>['groups'][number];

function Due() {
  const { t } = useTranslation();
  const q = useRpc('cash.due', {});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const groups = q.data?.groups ?? [];
  const tk = q.data?.tickets;
  return (
    <div>
      <div className="card">
        <h2>{t('caisse.due.title')}</h2>
        {!groups.length ? (
          <Empty>{t('caisse.due.empty')}</Empty>
        ) : (
          <>
            <Kpis>
              {groups.map((g) => (
                <Kpi key={g.key} label={g.name} value={da(g.net)} sub={t('caisse.due.kpiSub', { count: g.count, amount: da(g.collected) })} onClick={() => document.getElementById(`cash-${g.key}`)?.scrollIntoView({ behavior: 'smooth' })} />
              ))}
            </Kpis>
            <p className="muted small">{t('caisse.due.note')}</p>
          </>
        )}
      </div>
      {groups.map((g) => (
        <GroupCard key={g.key} g={g} />
      ))}
      {/* SAV tickets: their money is a separate line, never mixed with orders */}
      <div className="card px-tk-card">
        <div className="card-head">
          <h2>
            {t('caisse.tickets.title')}
            <Help text={t('caisse.tickets.help')} label={t('caisse.tickets.title')} />
          </h2>
          <b className="ltr">{da(tk?.total ?? 0)}</b>
        </div>
        {!tk?.groups.length ? (
          <Empty>{t('caisse.tickets.empty')}</Empty>
        ) : (
          <Kpis>
            {tk.groups.map((g) => (
              <Kpi key={g.key} label={g.name} value={da(g.net)} sub={t('caisse.due.kpiSub', { count: g.count, amount: da(g.collected) })} onClick={() => document.getElementById(`cash-${g.key}`)?.scrollIntoView({ behavior: 'smooth' })} />
            ))}
          </Kpis>
        )}
      </div>
      {tk?.groups.map((g) => (
        <GroupCard key={g.key} g={g} ticket />
      ))}
    </div>
  );
}

function GroupCard({ g, ticket }: { g: Group; ticket?: boolean }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const receive = useAction('cash.receive', { success: (r) => t('caisse.due.received', { count: r.orders }), onDone: () => (setSel(new Set()), setConfirm(false)) });
  const chosen = g.orders.filter((o) => sel.has(o.id));
  const sum = chosen.reduce((s, o) => s + o.net, 0);
  const csv = () =>
    downloadCsv(`caisse-${g.name.replace(/[^\w-]+/g, '_')}`, [
      [t('caisse.col.order'), t('caisse.col.tracking'), t('caisse.col.delivered'), t('caisse.col.customer'), t('caisse.col.phone'), t('caisse.col.wilaya'), t('caisse.col.commune'), t('caisse.col.products'), t('caisse.col.paid'), t('caisse.col.fee'), t('caisse.col.net')],
      ...(chosen.length ? chosen : g.orders).map((o) => [o.ref, o.tracking, dateTime(o.deliveredAt), o.customerName, o.phone, wilayaName(o.wilayaId), o.commune, o.products, o.total, o.deliveryCost, o.net]),
    ]);
  return (
    <div className="card" id={`cash-${g.key}`}>
      <div className="card-head">
        <h2>{t(ticket ? 'caisse.tickets.groupTitle' : 'caisse.due.groupTitle', { name: g.name, count: g.count })}</h2>
        <div className="row">
          <b className="ltr">{chosen.length ? `${n(chosen.length)} · ${da(sum)}` : ''}</b>
          <button className="btn ok" disabled={!chosen.length} onClick={() => setConfirm(true)}>
            {t('caisse.due.received_btn')}
          </button>
          <button className="btn" onClick={csv}>
            {t('common.export')}
          </button>
        </div>
      </div>
      {confirm && (
        <div className="card" role="alertdialog" style={{ background: 'var(--raise)' }}>
          <p>{t('caisse.due.confirm', { count: chosen.length, amount: da(sum), name: g.name })}</p>
          <div className="row">
            <button className="btn ok" disabled={receive.isPending} onClick={() => receive.mutate({ ids: chosen.map((o) => o.id) })}>
              {t('caisse.due.confirmBtn')}
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="ck">
                <input type="checkbox" aria-label={t('caisse.selectAll')} checked={sel.size > 0 && sel.size === g.orders.length} onChange={(e) => setSel(e.target.checked ? new Set(g.orders.map((o) => o.id)) : new Set())} />
              </th>
              <th>{t('caisse.col.order')}</th>
              <th>{t('caisse.col.delivered')}</th>
              <th>{t('caisse.col.customer')}</th>
              <th className="wide">{t('caisse.col.products')}</th>
              <th className="num">{t('caisse.col.paid')}</th>
              <th className="num">{t('caisse.col.net')}</th>
            </tr>
          </thead>
          <tbody>
            {g.orders.map((o) => (
              <tr key={o.id}>
                <td className="ck">
                  <input
                    type="checkbox"
                    aria-label={t('caisse.select')}
                    checked={sel.has(o.id)}
                    onChange={(e) => {
                      const s = new Set(sel);
                      e.target.checked ? s.add(o.id) : s.delete(o.id);
                      setSel(s);
                    }}
                  />
                </td>
                <td data-l={t('caisse.col.order')} className="clickable" onClick={() => openOrder(o.id)}>
                  <b className="ltr">{o.ref}</b> <TicketTag savRef={o.savRef} />
                  {o.tracking && <small className="ltr">{o.tracking}</small>}
                </td>
                <td data-l={t('caisse.col.delivered')}>{when(o.deliveredAt)}</td>
                <td data-l={t('caisse.col.customer')}>
                  {o.customerName}
                  <small>
                    {wilayaName(o.wilayaId)} · {o.commune}
                  </small>
                </td>
                <td className="wide px-cw" data-l={t('caisse.col.products')}>
                  <div className="px-clamp">{o.products}</div>
                </td>
                <td className="num" data-l={t('caisse.col.paid')}>
                  {da(o.total)}
                </td>
                <td className="num" data-l={t('caisse.col.net')}>
                  <b>{da(o.net)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Done() {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(30);
  const q = useRpc('cash.history', { limit });
  const [ask, setAsk] = useState<number | null>(null);
  const cancel = useAction('cash.cancel', { success: t('caisse.done.cancelled'), onDone: () => setAsk(null) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const list = q.data ?? [];
  const amount = (h: (typeof list)[number], o: (typeof list)[number]['orders'][number]) => (h.livreurId ? o.total - o.share : o.net);
  const csv = () =>
    downloadCsv('caisse-recu', [
      [t('caisse.col.receivedAt'), t('caisse.col.order'), t('caisse.col.company'), t('caisse.col.customer'), t('caisse.col.amount')],
      ...list.flatMap((h) => h.orders.map((o) => [dateTime(h.at), o.ref, h.name, o.customerName, amount(h, o)])),
    ]);
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('caisse.done.title')}</h2>
        <button className="btn" onClick={csv} disabled={!list.length}>
          {t('common.export')}
        </button>
      </div>
      {!list.length ? (
        <Empty>{t('caisse.done.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('caisse.col.receivedAt')}</th>
                <th>{t('caisse.col.order')}</th>
                <th>{t('caisse.col.company')}</th>
                <th>{t('caisse.col.customer')}</th>
                <th className="num">{t('caisse.col.amount')}</th>
              </tr>
            </thead>
            {list.map((h) => (
              <tbody key={h.id}>
                <tr style={{ background: 'var(--raise)' }}>
                  <td colSpan={5} data-l="">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        {h.tickets && <span className="px-ticket">{t('caisse.tickets.badge')}</span>} <b>{h.name}</b> · {dateTime(h.at)} · {t('caisse.done.summary', { count: h.orders.length, amount: da(h.net) })}
                        {h.fees > 0 && <span className="muted small"> ({t('caisse.done.fees', { amount: da(h.fees) })})</span>}
                      </span>
                      {ask === h.id ? (
                        <span className="row">
                          <span className="small">{t('caisse.done.confirmCancel')}</span>
                          <button className="btn small danger" disabled={cancel.isPending} onClick={() => cancel.mutate({ handoverId: h.id })}>
                            {t('common.confirm')}
                          </button>
                          <button className="btn small" onClick={() => setAsk(null)}>
                            {t('common.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button className="btn small ghost" onClick={() => setAsk(h.id)}>
                          {t('caisse.done.cancel')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {h.orders.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                    <td data-l={t('caisse.col.receivedAt')}>{when(h.at)}</td>
                    <td data-l={t('caisse.col.order')}>
                      <b className="ltr">{o.ref}</b> <TicketTag savRef={o.savRef} />
                      {o.tracking && <small className="ltr">{o.tracking}</small>}
                    </td>
                    <td data-l={t('caisse.col.company')}>{h.name}</td>
                    <td data-l={t('caisse.col.customer')}>{o.customerName}</td>
                    <td className="num" data-l={t('caisse.col.amount')}>
                      {da(amount(h, o))}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {list.length >= limit && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
          <button className="btn" onClick={() => setLimit(limit + 30)}>
            {t('caisse.done.more')}
          </button>
        </div>
      )}
    </div>
  );
}
