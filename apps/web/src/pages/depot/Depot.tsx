import type { Order } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { escapeHtml, printHtml } from '../../lib/files';
import { da, dateOnly, n } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Card, Empty, ErrorBox, Icon, Loading, StatusBadge } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { DepotOrderList, itemsLine } from './OrderList';
import { ScanCard } from './ScanCard';

const STAGES = ['preparer', 'prepares', 'dispatchees', 'enlivraison', 'retours'] as const;
type Stage = (typeof STAGES)[number];

export function Depot({ sub }: PageProps) {
  const { t } = useTranslation();
  const stage: Stage = (STAGES as readonly string[]).includes(sub ?? '') ? (sub as Stage) : 'preparer';
  const counts = useRpc('depot.counts', {}, { refetchInterval: 60_000 });
  const c = counts.data;
  return (
    <>
      <nav className="bjm-bar flow" aria-label={t('depot.title')} data-g="depot">
        {STAGES.map((k, i) => (
          <span key={k} style={{ display: 'contents' }}>
            {i > 0 && (
              <span className={`bjm-ar ${k === 'retours' ? 'bjm-ar2' : ''}`} aria-hidden="true">
                {k === 'retours' ? '⟶' : '›'}
              </span>
            )}
            <a className={`bjm-p ${stage === k ? 'on' : ''} ${k === 'retours' ? 'end' : ''}`} href={`#/depot/${k}`} aria-current={stage === k ? 'page' : undefined}>
              <span className="bjm-l">{t(`depot.stage.${k}`)}</span>
              {c && <b className="bjm-n ltr">{c[k]}</b>}
            </a>
          </span>
        ))}
      </nav>
      <Card title={t(`depot.stage.${stage}`)} />
      {stage === 'preparer' && <Preparer />}
      {stage === 'prepares' && <Prepares />}
      {stage === 'dispatchees' && <Dispatchees />}
      {stage === 'enlivraison' && <EnLivraison />}
      {stage === 'retours' && <Retours />}
    </>
  );
}
// (The depot bar is drawn here rather than with <StageBar>: it needs the ⟶ arrow and the red "end" stage of the original.)

// ---------------------------------------------------------------- En préparation
function Picking() {
  const { t } = useTranslation();
  const q = useRpc('catalog.picking', {});
  const print = () => {
    const rows = (q.data ?? []).filter((r) => r.toPrepare > 0);
    const date = dateOnly(new Date().toISOString());
    printHtml(
      t('depot.picking.sheetTitle', { date }),
      `<h1>${escapeHtml(t('depot.picking.sheetTitle', { date }))}</h1><table><tr><th>${escapeHtml(t('depot.picking.product'))}</th><th class="num">${escapeHtml(t('depot.picking.qty'))}</th><th class="num">${escapeHtml(
        t('depot.picking.orders'),
      )}</th><th class="num">${escapeHtml(t('depot.picking.stock'))}</th><th style="width:70px">${escapeHtml(t('depot.picking.done'))}</th></tr>${rows
        .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="num big">${r.toPrepare}</td><td class="num">${r.orders}</td><td class="num">${r.stock}${r.stock < r.toPrepare + r.prepared ? ` (${escapeHtml(t('depot.picking.missing', { n: r.toPrepare + r.prepared - r.stock }))})` : ''}</td><td></td></tr>`)
        .join('')}</table>`,
    );
  };
  return (
    <Card
      title={t('depot.picking.title')}
      actions={
        <button className="btn" onClick={print} disabled={!q.data?.length}>
          {t('depot.picking.print')}
        </button>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <Empty>{t('depot.picking.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="wide">{t('depot.picking.product')}</th>
                <th className="num">{t('depot.picking.toPrepare')}</th>
                <th className="num">{t('depot.picking.prepared')}</th>
                <th className="num">{t('depot.picking.orders')}</th>
                <th className="num">{t('depot.picking.stock')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => {
                const need = r.toPrepare + r.prepared;
                const low = r.stock < need;
                return (
                  <tr key={`${r.productId}-${r.variantId}`}>
                    <td className="wide px-cw" data-l={t('depot.picking.product')}>
                      <div className="px-clamp">{r.label}</div>
                    </td>
                    <td className="num" data-l={t('depot.picking.toPrepare')}>
                      <b className="ltr">{n(r.toPrepare)}</b>
                    </td>
                    <td className="num ltr" data-l={t('depot.picking.prepared')}>
                      {n(r.prepared)}
                    </td>
                    <td className="num ltr" data-l={t('depot.picking.orders')}>
                      {n(r.orders)}
                    </td>
                    <td className="num" data-l={t('depot.picking.stock')}>
                      <span className={low ? 'stock-low' : undefined}>
                        <span className="ltr">{n(r.stock)}</span>
                        {low && ` (${t('depot.picking.missing', { n: need - r.stock })})`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CompanyBulk({ ids, done }: { ids: number[]; done: () => void }) {
  const { t } = useTranslation();
  const companies = useRpc('depot.companies', {});
  const assign = useAction('orders.assignCompany', { success: t('depot.companySet'), onDone: done });
  return (
    <select
      aria-label={t('depot.setCompany')}
      value=""
      style={{ width: 'auto' }}
      disabled={assign.isPending}
      onChange={(e) => e.target.value && assign.mutate({ ids, companyId: e.target.value === 'none' ? null : Number(e.target.value) })}
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

function Preparer() {
  const { t } = useTranslation();
  const prep = useAction('orders.setFollow', { success: (r) => t('depot.markPreparedDone', { count: r.changed.length }) });
  return (
    <>
      <Picking />
      <DepotOrderList
        title={t('depot.lists.preparer')}
        follow={['to_prepare']}
        sort="confirmed_at"
        bulk={(ids, clear) => (
          <>
            <button className="btn small ok" disabled={prep.isPending} onClick={() => prep.mutate({ ids, status: 'prepared' }, { onSuccess: clear })}>
              ✓ {t('depot.markPrepared')}
            </button>
            <CompanyBulk ids={ids} done={clear} />
          </>
        )}
        actions={(o) => (
          <button className="btn small ok" disabled={prep.isPending} onClick={() => prep.mutate({ ids: [o.id], status: 'prepared' })}>
            ✓ {t('depot.markPrepared')}
          </button>
        )}
      />
    </>
  );
}

// ---------------------------------------------------------------- En dispatch
function Prepares() {
  const { t } = useTranslation();
  const un = useAction('depot.unassign', { success: (o) => t('depot.removed', { ref: o.ref }) });
  return (
    <>
      <ScanCard mode="dispatch" />
      <DepotOrderList
        title={t('depot.lists.prepares')}
        follow={['prepared']}
        sort="updated_at"
        bulk={(ids, clear) => <CompanyBulk ids={ids} done={clear} />}
        actions={(o) => (
          <button type="button" className="btn small ghost bjd-un" title={t('depot.removeTitle')} disabled={un.isPending} onClick={() => un.mutate({ id: o.id })}>
            <Icon name="unlink" /> {t('depot.remove')}
          </button>
        )}
      />
    </>
  );
}

// ---------------------------------------------------------------- Dispatchées / En livraison
function Dispatchees() {
  const { t } = useTranslation();
  return (
    <>
      <Card>
        <p className="muted small">{t('depot.help.dispatchees')}</p>
      </Card>
      <DepotOrderList
        title={t('depot.lists.dispatchees')}
        follow={['shipped']}
        sort="shipped_at"
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
      <Card>
        <p className="muted small">{t('depot.help.enlivraison')}</p>
      </Card>
      <DepotOrderList
        title={t('depot.lists.enlivraison')}
        follow={['out_for_delivery']}
        sort="shipped_at"
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
                      <small className="ltr">{o.tracking ?? ''}</small>
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
      <DepotOrderList title={t('depot.lists.returning')} follow={['returning']} confirmedOnly={false} sort="updated_at" />
      <DepotOrderList title={t('depot.lists.exchange')} follow={['in_exchange']} confirmedOnly={false} sort="updated_at" />
    </>
  );
}
