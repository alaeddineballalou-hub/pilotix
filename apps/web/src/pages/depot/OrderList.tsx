import type { FollowStatus, Order } from '@pilotix/shared';
import { API_COURIER_KINDS, WILAYAS } from '@pilotix/shared';
import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, wilaya, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { BulkBar, Card, ErrorBox, Icon, Loading, RemovableChip, StatusBadge, TicketTag } from '../../ui/kit';
import { namesOf, variantsOf, trackOf } from '../../lib/items';
import { CopyCode } from '../../ui/CopyCode';
import { Modal } from '../../ui/modal';
import { stateOf, useCouriers } from './Labels';
import './stages.css';

export interface ExtraCol {
  label: string;
  num?: boolean;
  cell: (o: Order) => ReactNode;
}

/** The products of an order with their variant in grey, on up to two lines: "2 × Écharpe de portage Gris chiné + Biberon". */
function ItemsCell({ o }: { o: Order }) {
  if (!o.items.length) return <>—</>;
  return (
    <>
      {o.items.map((i, k) => (
        <span key={k}>
          {k > 0 && ' + '}
          {i.qty > 1 && `${i.qty} × `}
          {i.name}
          {i.variantTitle && <span className="muted"> {i.variantTitle}</span>}
        </span>
      ))}
    </>
  );
}

/** Products of an order on one line: "1 × VELO 16P BLEU + 1 × montage". */
export const itemsLine = (o: Order) => o.items.map((i) => `${i.qty} × ${i.variantTitle ? `${i.name} ${i.variantTitle}` : i.name}`).join(' + ');

/** Debounced value (search boxes). */
export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * The order list of the depot stages (same columns as the original "Commandes à préparer"):
 * search, Société and Wilaya filters, checkboxes, extra columns and bulk actions.
 * `hide` drops the columns that say the same thing on every row of a stage (all confirmed, all shipped…), and
 * `compact` (the stages after « En préparation ») puts the variant next to its product and leaves out the agent,
 * so the columns that matter there (the partner, how long the parcel has waited, the button) fit on a laptop.
 * `labels` (En dispatch): a parcel whose company has an API shows « Suivi en attente » until the company gives its
 * number (the Pilotix one would be replaced); `top` goes above the filters (the labels bar).
 */
export function DepotOrderList({
  title,
  help,
  follow,
  confirmedOnly = true,
  sort,
  extra = [],
  bulk,
  actions,
  hide = [],
  compact = false,
  labels = false,
  top,
}: {
  title: string;
  help?: string;
  follow: FollowStatus[];
  confirmedOnly?: boolean;
  sort: 'confirmed_at' | 'shipped_at' | 'updated_at' | 'created_at';
  extra?: ExtraCol[];
  bulk?: (ids: number[], clear: () => void) => ReactNode;
  actions?: (o: Order) => ReactNode;
  hide?: ('conf' | 'follow')[];
  compact?: boolean;
  labels?: boolean;
  top?: ReactNode;
}) {
  const { t } = useTranslation();
  const unCompany = useAction('orders.assignCompany', { success: t('depot.partnerRemoved') });
  const unDispatch = useAction('depot.unassign', { success: (o) => t('depot.removed', { ref: o.ref }) });
  const couriers = useCouriers();
  // « Retirer » on a parcel the company already has (its own number): the parcel is cancelled there, asked first
  const [ask, setAsk] = useState<Order | null>(null);
  const atCompany = (o: Order) => !!o.tracking && !!o.companyId && !!couriers && API_COURIER_KINDS.includes(couriers.kindOf(o.companyId) ?? '');
  const waiting = (o: Order) => {
    if (!labels || !couriers) return false;
    const s = stateOf(o, couriers);
    return !s.ok && s.why === 'waiting';
  };
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [wil, setWil] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const dq = useDebounced(q);
  const pageSize = 50;
  const companies = useRpc('depot.companies', {});
  const list = useRpc('orders.list', {
    follow,
    conf: confirmedOnly ? ['confirmed'] : undefined,
    q: dq || undefined,
    companyId: company === 'none' ? 'none' : company ? Number(company) : undefined,
    wilayaId: wil ? Number(wil) : undefined,
    sort,
    dir: 'asc',
    page,
    pageSize,
    tickets: 'include',
  });
  useEffect(() => setPage(1), [dq, company, wil]);
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const allOn = rows.length > 0 && rows.every((o) => sel.has(o.id));
  const toggle = (id: number) => {
    const s = new Set(sel);
    s.has(id) ? s.delete(id) : s.add(id);
    setSel(s);
  };
  const clear = () => setSel(new Set());
  const showConf = !hide.includes('conf');
  const showFollow = !hide.includes('follow');
  const cols = 7 + (compact ? 0 : 2) + (showConf ? 1 : 0) + (showFollow ? 1 : 0);

  return (
    <Card title={title} help={help}>
      {top}
      <div className={`filters ${open ? 'open' : ''}`}>
        <label className="field search-f">
          <span className="lab">{t('depot.filters.search')}</span>
          <input type="search" aria-label={t('depot.filters.searchPh')} placeholder={t('depot.filters.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="btn filters-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('common.filters')}
        </button>
        <label className="field more-f">
          <span className="lab">{t('depot.filters.company')}</span>
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">{t('depot.filters.all')}</option>
            <option value="none">{t('depot.filters.noCompany')}</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field more-f">
          <span className="lab">{t('depot.filters.wilaya')}</span>
          <select value={wil} onChange={(e) => setWil(e.target.value)}>
            <option value="">{t('depot.filters.all')}</option>
            {WILAYAS.map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {wilaya(i + 1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {bulk && (
        <BulkBar count={sel.size} onClear={clear}>
          {bulk([...sel], clear)}
        </BulkBar>
      )}
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className={`tbl-wrap ${compact ? 'px-dlw' : ''}`}>
          <table className={`tbl ${compact ? 'px-dl' : ''}`}>
            <thead>
              <tr>
                <th className="ck">
                  <input type="checkbox" aria-label={t('depot.selectAll')} checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((o) => o.id)))} />
                </th>
                <th>{t('depot.cols.order')}</th>
                <th>{t('depot.cols.client')}</th>
                <th className={compact ? 'px-dl-addr' : undefined}>{t('depot.cols.address')}</th>
                <th className="wide">{t('depot.cols.products')}</th>
                {!compact && <th>{t('depot.cols.variant')}</th>}
                <th className={`num ${compact ? 'px-dl-tot' : ''}`}>{t('depot.cols.total')}</th>
                {showConf && <th>{t('depot.cols.conf')}</th>}
                {showFollow && <th>{t('depot.cols.follow')}</th>}
                <th>{t('depot.cols.company')}</th>
                {!compact && <th className="hide-m">{t('depot.cols.agent')}</th>}
                {extra.map((c) => (
                  <th key={c.label} className={`${c.num ? 'num' : ''} ${compact ? 'px-dl-x' : ''}`}>
                    {c.label}
                  </th>
                ))}
                {actions && <th className="px-act" />}
              </tr>
            </thead>
            <tbody>
              {!rows.length && (
                <tr>
                  <td colSpan={cols + extra.length + (actions ? 1 : 0)} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    {t('depot.empty')}
                  </td>
                </tr>
              )}
              {rows.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                  <td className="ck" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={t('depot.select')} checked={sel.has(o.id)} onChange={() => toggle(o.id)} />
                  </td>
                  <td data-l={t('depot.cols.order')}>
                    <b className="ltr">{o.ref}</b> <TicketTag savRef={o.savRef} />
                    <small>{when(o.createdAt)}</small>
                  </td>
                  <td data-l={t('depot.cols.client')}>
                    {o.customerName}
                    <small className="ltr">{o.phone}</small>
                    {compact && (
                      <small className="px-dl-where">
                        {wilaya(o.wilayaId)}
                        {o.commune ? ` · ${o.commune}` : ''}
                      </small>
                    )}
                  </td>
                  <td className={compact ? 'px-dl-addr' : undefined} data-l={t('depot.cols.address')}>
                    {wilaya(o.wilayaId)}
                    <small>{o.commune}</small>
                  </td>
                  <td className="wide px-cw" data-l={t('depot.cols.products')}>
                    <div className="px-clamp">{compact ? <ItemsCell o={o} /> : namesOf(o.items)}</div>
                    {compact && <small className="px-dl-sum ltr">{da(o.total)}</small>}
                  </td>
                  {!compact && (
                    <td data-l={t('depot.cols.variant')}>
                      <div className="px-clamp">{variantsOf(o.items)}</div>
                    </td>
                  )}
                  <td className={`num ltr ${compact ? 'px-dl-tot' : ''}`} data-l={t('depot.cols.total')}>
                    {da(o.total)}
                  </td>
                  {showConf && (
                    <td data-l={t('depot.cols.conf')}>
                      <StatusBadge kind="conf" status={o.confStatus} />
                    </td>
                  )}
                  {showFollow && (
                    <td data-l={t('depot.cols.follow')}>
                      <StatusBadge kind="follow" status={o.followStatus} />
                    </td>
                  )}
                  <td data-l={t('depot.cols.company')}>
                    <RemovableChip
                      name={o.companyName}
                      removeLabel={t('depot.removePartner')}
                      disabled={unCompany.isPending || unDispatch.isPending}
                      onRemove={
                        o.followStatus === 'to_prepare'
                          ? () => unCompany.mutate({ ids: [o.id], companyId: null, livreurId: null })
                          : o.followStatus === 'prepared'
                            ? () => (atCompany(o) ? setAsk(o) : unDispatch.mutate({ id: o.id }))
                            : undefined
                      }
                    />
                    {waiting(o) ? (
                      <small className="px-wait">
                        <Icon name="clock" /> {t('depot.labels.waiting')}
                      </small>
                    ) : (
                      <CopyCode code={trackOf(o) || o.ref} small />
                    )}
                  </td>
                  {!compact && (
                    <td className="hide-m" data-l={t('depot.cols.agent')}>
                      {o.agentName ?? '—'}
                    </td>
                  )}
                  {extra.map((c) => (
                    <td key={c.label} className={c.num ? 'num' : undefined} data-l={c.label}>
                      {c.cell(o)}
                    </td>
                  ))}
                  {actions && (
                    <td className="px-act" data-l="" onClick={(e) => e.stopPropagation()}>
                      {actions(o)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <span className="muted">{t('depot.results', { count: total })}</span>
        <span className="grow" />
        <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('common.prev')}>
          ‹
        </button>
        <span className="ltr">
          {page} / {pages}
        </span>
        <button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label={t('common.next')}>
          ›
        </button>
      </div>
      {ask && (
        <Modal
          title={t('depot.labels.cancelTitle', { name: ask.companyName ?? '' })}
          onClose={() => setAsk(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsk(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={unDispatch.isPending}
                onClick={() => {
                  unDispatch.mutate({ id: ask.id });
                  setAsk(null);
                }}
              >
                {t('depot.labels.cancelOk')}
              </button>
            </>
          }
        >
          <p>{t('depot.labels.cancelText', { name: ask.companyName ?? '', tracking: ask.tracking ?? '', ref: ask.ref })}</p>
        </Modal>
      )}
    </Card>
  );
}
