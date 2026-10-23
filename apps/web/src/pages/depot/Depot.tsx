import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, n } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading, StatusBadge } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { DepotOrderList, itemsLine } from './OrderList';
import { ScanCard } from './ScanCard';
import { trackOf } from '../../lib/items';
import { CopyCode } from '../../ui/CopyCode';
import { useIsPhone } from '../../lib/useMedia';
import { PhonePrep } from './PhonePrep';
import { PhoneDispatch, PhoneReturns, PhoneRoad } from './PhoneStages';
import { LabelAction, LabelsBar, PrintSelected } from './Labels';
import { BagBulk, BagsCard } from './Bags';

const STAGES = ['preparer', 'prepares', 'dispatchees', 'enlivraison', 'retours'] as const;
type Stage = (typeof STAGES)[number];

export function Depot({ sub }: PageProps) {
  const { t } = useTranslation();
  const stage: Stage = (STAGES as readonly string[]).includes(sub ?? '') ? (sub as Stage) : 'preparer';
  const counts = useRpc('depot.counts', {}, { refetchInterval: 60_000 });
  const c = counts.data;
  // phones: the first stage is products first (pick), then the orders that have everything (pack, partner, dispatch)
  const phone = useIsPhone();
  // a phone shows two or three stages at a time: the current one is brought into view
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    const on = el?.querySelector<HTMLElement>('.bjm-p.on');
    if (!el || !on || el.scrollWidth <= el.clientWidth + 1) return;
    const r = el.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    if (b.left >= r.left + 8 && b.right <= r.right - 8) return;
    el.scrollBy({ left: b.left + b.width / 2 - (r.left + r.width / 2) });
  }, [stage]);
  return (
    <>
      <nav ref={bar} className="bjm-bar flow" aria-label={t('depot.title')} data-g="depot">
        {STAGES.map((k, i) => (
          <span key={k} style={{ display: 'contents' }}>
            {i > 0 && (
              <span className={`bjm-ar ${k === 'retours' ? 'bjm-ar2' : ''}`} aria-hidden="true">
                {k === 'retours' ? '⟶' : '›'}
              </span>
            )}
            <a className={`bjm-p ${stage === k ? 'on' : ''} ${k === 'retours' ? 'end' : ''}`} href={`#/depot/${k}`} aria-current={stage === k ? 'page' : undefined}>
              <span className="bjm-l">{phone && k === 'preparer' ? t('depot.ph.stage') : t(`depot.stage.${k}`)}</span>
              {c && <b className="bjm-n ltr">{c[k]}</b>}
            </a>
          </span>
        ))}
      </nav>
      {stage === 'preparer' && !phone && <Card title={t(`depot.stage.${stage}`)} />}
      {stage === 'preparer' && (phone ? <PhonePrep /> : <Preparer />)}
      {stage === 'prepares' && (phone ? <PhoneDispatch /> : <Prepares />)}
      {stage === 'dispatchees' && (phone ? <PhoneRoad stage="dispatchees" /> : <Dispatchees />)}
      {stage === 'enlivraison' && (phone ? <PhoneRoad stage="enlivraison" /> : <EnLivraison />)}
      {stage === 'retours' && (phone ? <PhoneReturns /> : <Retours />)}
    </>
  );
}
// (The depot bar is drawn here rather than with <StageBar>: it needs the ⟶ arrow and the red "end" stage of the original.)

// ---------------------------------------------------------------- En préparation
/**
 * "Quantité à acheter": a small foldable table of the variants that are missing for the orders
 * (available < 0), under their minimum stock (available < alert quantity) or exactly at it.
 */
function ToBuy() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const q = useRpc('catalog.stock', { missingOnly: true });
  // missing for the orders, or under / at the minimum; sorted by product, then variant (16, 20, 24… in natural order)
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const rows = (q.data ?? [])
    .filter((r) => r.available < 0 || (r.alertQty > 0 && r.available <= r.alertQty))
    .sort((a, b) => byName(a.productName, b.productName) || byName(a.variantTitle ?? '', b.variantTitle ?? '') || byName(a.warehouseName, b.warehouseName));
  const missing = rows.filter((r) => r.available < 0).length;
  const under = rows.filter((r) => r.available >= 0 && r.available < r.alertQty).length;
  const atMin = rows.length - missing - under;
  const depots = new Set(rows.map((r) => r.warehouseId)).size > 1;
  return (
    <Card
      title={
        <button type="button" className="linklike" aria-expanded={open} onClick={() => setOpen(!open)} style={{ all: 'unset', cursor: 'pointer' }}>
          {open ? '▾' : '▸'} {t('depot.toBuy.title')}
        </button>
      }
      badge={
        q.data && (
          <>
            {missing > 0 && <span className="badge t-bad">{t('depot.toBuy.missingN', { count: missing })}</span>}{' '}
            {under > 0 && <span className="badge t-warn">{t('depot.toBuy.underN', { count: under })}</span>}{' '}
            {atMin > 0 && <span className="badge t-info">{t('depot.toBuy.lowN', { count: atMin })}</span>}
            {!rows.length && <span className="badge t-ok">✓ {t('depot.toBuy.none')}</span>}
          </>
        )
      }
      actions={
        <button type="button" className="btn small ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('depot.toBuy.hide') : t('depot.toBuy.show')}
        </button>
      }
    >
      {open &&
        (q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <p className="muted">✓ {t('depot.toBuy.none')}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="wide">{t('depot.picking.product')}</th>
                  <th>{t('depot.toBuy.variant')}</th>
                  <th className="num">{t('depot.toBuy.stock')}</th>
                  <th className="num">{t('depot.toBuy.reserved')}</th>
                  <th className="num">{t('depot.toBuy.min')}</th>
                  <th className="num">{t('depot.toBuy.buy')}</th>
                  <th>{t('depot.toBuy.state')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const miss = r.available < 0;
                  const below = !miss && r.available < r.alertQty;
                  const buy = Math.max(0, r.alertQty - r.available);
                  const same = i > 0 && rows[i - 1].productId === r.productId;
                  return (
                    <tr key={`${r.variantId}-${r.warehouseId}`}>
                      <td className="wide px-cw" data-l={t('depot.picking.product')}>
                        <div className={`px-clamp ${same ? 'muted' : ''}`}>{same ? r.productName : <b>{r.productName}</b>}</div>
                      </td>
                      <td data-l={t('depot.toBuy.variant')}>
                        {r.variantTitle || '—'}
                        {depots && <small>{r.warehouseName}</small>}
                      </td>
                      <td className="num ltr" data-l={t('depot.toBuy.stock')}>
                        {n(r.qty)}
                      </td>
                      <td className="num ltr" data-l={t('depot.toBuy.reserved')}>
                        {n(r.reserved)}
                      </td>
                      <td className="num ltr" data-l={t('depot.toBuy.min')}>
                        {r.alertQty ? n(r.alertQty) : '—'}
                      </td>
                      <td className="num" data-l={t('depot.toBuy.buy')}>
                        <b className="ltr">{n(buy)}</b>
                      </td>
                      <td data-l={t('depot.toBuy.state')}>
                        <span className={`badge ${miss ? 't-bad' : below ? 't-warn' : 't-info'}`}>
                          {miss ? t('depot.toBuy.missing', { n: -r.available }) : below ? t('depot.toBuy.under', { n: r.alertQty - r.available }) : t('depot.toBuy.atMin')}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </Card>
  );
}

/** « Société… » in En dispatch: another delivery company for the selection; a company with an API gets the parcels
 *  right away (a parcel already at another company is cancelled there first). */
function CompanyBulk({ ids, done }: { ids: number[]; done: () => void }) {
  const { t } = useTranslation();
  const companies = useRpc('depot.companies', {});
  const go = useToDispatch();
  return (
    <select
      aria-label={t('depot.setCompany')}
      value=""
      style={{ width: 'auto' }}
      disabled={go.busy}
      onChange={(e) => e.target.value && go.run(ids, Number(e.target.value), done, t('depot.companySet'))}
    >
      <option value="">{t('depot.setCompany')}</option>
      {companies.data?.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** Assign a delivery partner to the orders and push them to "En dispatch": a partner with an API gets the parcels
 *  right away, and its own tracking number replaces the Pilotix one (the labels can be printed then). */
export function useToDispatch() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (ids: number[], companyId: number | null, onDone?: () => void, okText?: string) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await rpc('depot.dispatch', companyId ? { ids, companyId } : { ids });
      const sent = r.sent ? ` · ${t('depot.labels.sent', { count: r.sent })}` : '';
      toast(`${okText ?? t('depot.toDispatch.done', { count: r.moved })}${sent}`, 'ok');
      if (r.failed.length) toast(`${t('depot.labels.notSent', { count: r.failed.length })} : ${r.failed.map((f) => `${f.ref} ${f.error}`).join(' · ')}`, 'bad', 9000);
      onDone?.();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
      qc.invalidateQueries();
    }
  };
  return { run, busy };
}

function DispatchBulk({ ids, done }: { ids: number[]; done: () => void }) {
  const { t } = useTranslation();
  const companies = useRpc('depot.companies', {});
  const [company, setCompany] = useState('');
  const go = useToDispatch();
  return (
    <>
      <select aria-label={t('depot.toDispatch.partner')} value={company} style={{ width: 'auto' }} disabled={go.busy} onChange={(e) => setCompany(e.target.value)}>
        <option value="">{t('depot.toDispatch.partner')}</option>
        {companies.data?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button className="btn small ok" disabled={!company || go.busy} onClick={() => go.run(ids, Number(company), done)}>
        {t('depot.toDispatch.button')} ›
      </button>
    </>
  );
}

function DispatchRow({ o }: { o: Order }) {
  const { t } = useTranslation();
  const companies = useRpc('depot.companies', {});
  const go = useToDispatch();
  if (o.companyId)
    return (
      <button className="btn small ok" disabled={go.busy} onClick={() => go.run([o.id], null)}>
        {t('depot.toDispatch.button')} ›
      </button>
    );
  return (
    <select aria-label={t('depot.toDispatch.partner')} value="" style={{ width: 'auto' }} disabled={go.busy} onChange={(e) => e.target.value && go.run([o.id], Number(e.target.value))}>
      <option value="">{t('depot.toDispatch.partner')}</option>
      {companies.data?.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function Preparer() {
  const { t } = useTranslation();
  return (
    <>
      <ToBuy />
      <DepotOrderList
        title={t('depot.lists.preparer')}
        follow={['to_prepare']}
        sort="confirmed_at"
        bulk={(ids, clear) => <DispatchBulk ids={ids} done={clear} />}
        actions={(o) => <DispatchRow o={o} />}
      />
    </>
  );
}

// ---------------------------------------------------------------- En dispatch
function Prepares() {
  const { t } = useTranslation();
  return (
    <>
      <ScanCard mode="dispatch" />
      <DepotOrderList
        title={t('depot.lists.prepares')}
        follow={['prepared']}
        sort="updated_at"
        hide={['conf', 'follow']}
        compact
        labels
        top={<LabelsBar />}
        bulk={(ids, clear) => (
          <>
            <PrintSelected ids={ids} />
            <CompanyBulk ids={ids} done={clear} />
          </>
        )}
        actions={(o) => <LabelAction o={o} />}
      />
    </>
  );
}

// ---------------------------------------------------------------- Dispatchées / En livraison
function Dispatchees() {
  const { t } = useTranslation();
  return (
    <>
      <DepotOrderList
        title={t('depot.lists.dispatchees')}
        help={t('depot.help.dispatchees')}
        follow={['shipped']}
        sort="shipped_at"
        hide={['conf', 'follow']}
        compact
        top={<BagsCard />}
        bulk={(ids, clear) => <BagBulk ids={ids} done={clear} />}
        extra={[
          {
            label: t('depot.cols.handedSince'),
            num: true,
            cell: (o) => {
              if (!o.shippedAt) return '—';
              const h = (Date.now() - Date.parse(o.shippedAt)) / 3_600_000;
              return (
                <span className={`badge ${h >= 48 ? 't-bad' : h >= 24 ? 't-warn' : 't-ok'}`}>
                  {h < 1 ? t('depot.lessThanHour') : h < 48 ? t('depot.hours', { n: Math.floor(h) }) : t('depot.days', { n: Math.floor(h / 24) })}
                </span>
              );
            },
          },
        ]}
      />
    </>
  );
}

function EnLivraison() {
  const { t } = useTranslation();
  return (
    <>
      <DepotOrderList
        title={t('depot.lists.enlivraison')}
        help={t('depot.help.enlivraison')}
        follow={['out_for_delivery']}
        sort="shipped_at"
        hide={['conf', 'follow']}
        compact
        extra={[
          {
            label: t('depot.cols.leftSince'),
            num: true,
            cell: (o) => {
              if (!o.shippedAt) return '—';
              const d = Math.floor((Date.now() - Date.parse(o.shippedAt)) / 86_400_000);
              return <span className={`badge ${d >= 7 ? 't-bad' : d >= 4 ? 't-warn' : 't-info'}`}>{d < 1 ? t('depot.today') : t('depot.days', { n: d })}</span>;
            },
          },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------- Retours / Échanges
function Receive() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    const c = code.trim().replace(/[,()"*]/g, '');
    if (!c) return;
    setBusy(true);
    try {
      setFound(await rpc('depot.find', { code: c }));
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const recv = useAction('depot.receiveReturn', {
    success: (o) => t('depot.receive.done', { ref: o.ref }),
    onDone: () => {
      setFound(null);
      setCode('');
    },
  });
  return (
    <Card title={t('depot.receive.title')}>
      <p className="muted">{t('depot.receive.help')}</p>
      <div className="row">
        <div className="grow">
          <input
            type="search"
            autoFocus
            autoComplete="off"
            placeholder={t('depot.receive.ph')}
            aria-label={t('depot.receive.ph')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                search();
              }
            }}
          />
        </div>
        <button className="btn primary" onClick={search} disabled={busy}>
          {t('depot.receive.search')}
        </button>
      </div>
      {found &&
        (found.length ? (
          <div className="tbl-wrap" style={{ marginTop: 10 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('depot.cols.order')}</th>
                  <th>{t('depot.cols.client')}</th>
                  <th className="wide">{t('depot.cols.products')}</th>
                  <th>{t('depot.cols.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {found.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                    <td data-l={t('depot.cols.order')}>
                      <b className="ltr">{o.ref}</b>
                      {trackOf(o) && <CopyCode code={trackOf(o)} small />}
                    </td>
                    <td data-l={t('depot.cols.client')}>
                      {o.customerName}
                      <small className="ltr">{o.phone}</small>
                    </td>
                    <td className="wide" data-l={t('depot.cols.products')}>
                      {itemsLine(o)} <span className="muted ltr">· {da(o.total)}</span>
                    </td>
                    <td data-l={t('depot.cols.status')}>{o.followStatus ? <StatusBadge kind="follow" status={o.followStatus} /> : <StatusBadge kind="conf" status={o.confStatus} />}</td>
                    <td data-l="" onClick={(e) => e.stopPropagation()}>
                      {o.followStatus === 'returned' ? (
                        <span className="badge t-ok">{t('depot.receive.already')}</span>
                      ) : (
                        <button className="btn small ok" disabled={!o.shippedAt || recv.isPending} onClick={() => recv.mutate({ id: o.id })}>
                          {t('depot.receive.button')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            {t('depot.receive.none')}
          </p>
        ))}
    </Card>
  );
}

function Retours() {
  const { t } = useTranslation();
  return (
    <>
      <Receive />
      <DepotOrderList
        title={t('depot.lists.returning')}
        follow={['returning']}
        confirmedOnly={false}
        sort="updated_at"
        hide={['conf', 'follow']}
        compact
        actions={(o) => <ReceiveButton o={o} />}
      />
      <DepotOrderList title={t('depot.lists.exchange')} follow={['in_exchange']} confirmedOnly={false} sort="updated_at" hide={['conf', 'follow']} compact />
    </>
  );
}

/** « Reçu au dépôt » on a return still on its way: the stock comes back. */
function ReceiveButton({ o }: { o: Order }) {
  const { t } = useTranslation();
  const recv = useAction('depot.receiveReturn', { success: (r) => t('depot.receive.done', { ref: r.ref }) });
  return (
    <button type="button" className="btn small ok" disabled={!o.shippedAt || recv.isPending} onClick={(e) => (e.stopPropagation(), recv.mutate({ id: o.id }))}>
      <Icon name="check" />
      {t('depot.receive.button')}
    </button>
  );
}
