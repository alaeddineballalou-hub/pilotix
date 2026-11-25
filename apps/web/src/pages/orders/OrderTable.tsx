// The order list of the original app (Commandes, Livrées, Annulées…), reusable by other screens.
import { CONF_DONE_BAD, CONF_TONE, Order } from '@pilotix/shared';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, when, wilaya, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { BulkBar, Empty, Loading, Pager, RemovableChip, SortTh, StatusBadge } from '../../ui/kit';
import { useAction } from '../../lib/query';
import { useSession } from '../../lib/session';
import { confLabel } from './shared';
import { namesOf, variantsOf, trackOf } from '../../lib/items';
import { CopyCode } from '../../ui/CopyCode';
import { TrustFlags } from './TrustFlags';
import { OriginChip } from './OrderPath';
import { ScoreChip } from '../../ui/clientScore';
import { TableColumnMenu, useTableColumns } from '../../ui/ColumnMenu';
import { PhoneOf } from '../../ui/PhoneOf';

/** Built-in columns, in the original order. */
export type OrderColumn = 'order' | 'client' | 'score' | 'address' | 'products' | 'variant' | 'total' | 'conf' | 'follow' | 'company' | 'agent' | 'fagent' | 'phone' | 'wilaya' | 'since';
export const DEFAULT_COLUMNS: OrderColumn[] = ['order', 'client', 'score', 'address', 'products', 'variant', 'total', 'conf', 'follow', 'company', 'agent', 'fagent'];

/** Column → orders.list sort key (when sortable). */
const SORT_KEY: Partial<Record<OrderColumn, OrderSort>> = {
  order: 'created_at', client: 'customer_name', score: 'score', address: 'wilaya_id', wilaya: 'wilaya_id', total: 'total', conf: 'conf_status', follow: 'follow_status', since: 'updated_at',
};
export type OrderSort = 'created_at' | 'confirmed_at' | 'next_call_at' | 'updated_at' | 'total' | 'customer_name' | 'wilaya_id' | 'shipped_at' | 'delivered_at' | 'ref' | 'conf_status' | 'follow_status' | 'score';

/** A column given by the screen using the table (e.g. "Frais société"). */
export interface ExtraColumn {
  key: string;
  label: string;
  num?: boolean;
  cell: (o: Order) => ReactNode;
  sort?: OrderSort;
  /** buttons (« Swap »): always shown, at the end, not in the column menu */
  fixed?: boolean;
}

export interface OrderTableProps {
  rows: Order[] | undefined;
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  onSize?: (s: number) => void;
  loading?: boolean;
  columns?: OrderColumn[];
  /**
   * The list's name for the column menu (each user's columns, saved with his account, and the team's presets): the
   * columns to show, their order. Without it, every column shows.
   */
  table?: string;
  /** extra columns added after the built-in ones */
  extra?: ExtraColumn[];
  /** a column before the built-in ones (« Toutes les boutiques »: the order's boutique) */
  lead?: ExtraColumn;
  sort?: OrderSort;
  dir?: 'asc' | 'desc';
  onSort?: (k: OrderSort, dir: 'asc' | 'desc') => void;
  /** rows can be selected; `bulk` draws the actions in the navy bar */
  selectable?: boolean;
  bulk?: (ids: number[], rows: Order[], clear: () => void) => ReactNode;
  /** changes when the filters change: clears the selection */
  resetKey?: string;
  empty?: ReactNode;
  onRow?: (o: Order) => void;
}

export function OrderTable(p: OrderTableProps) {
  const { t } = useTranslation();
  const { has } = useSession();
  const canAgent = has('agent_manager', 'vendeur');
  const canFollow = has('suivi');
  const unAgent = useAction('orders.assignAgent', { success: t('confirmation.unassigned', { n: 1 }) });
  const unFollow = useAction('suivi.unassign', { success: (o) => t('suivi.agentRemoved', { ref: o.ref }) });
  const builtIn = p.columns ?? DEFAULT_COLUMNS;
  const movable = (p.extra ?? []).filter((x) => !x.fixed);
  const keys: string[] = [...builtIn, ...movable.map((x) => x.key)];
  const tc = useTableColumns<string>(p.table ?? 'orders', keys);
  const [menu, setMenu] = useState(false);
  // the columns shown, in this user's order (the built-in ones and the screen's own)
  const shown = p.table ? tc.order.filter((k) => keys.includes(k) && tc.visible.has(k)) : keys;
  const cols = shown.filter((k): k is OrderColumn => (builtIn as string[]).includes(k));
  const xOf = (k: string) => movable.find((x) => x.key === k);
  const [sel, setSel] = useState<Map<number, Order>>(new Map());
  useEffect(() => setSel(new Map()), [p.resetKey]);
  const rows = p.rows ?? [];
  const allOn = rows.length > 0 && rows.every((o) => sel.has(o.id));
  const toggleAll = () =>
    setSel((s) => {
      const n = new Map(s);
      if (allOn) rows.forEach((o) => n.delete(o.id));
      else rows.forEach((o) => n.set(o.id, o));
      return n;
    });
  const toggle = (o: Order) =>
    setSel((s) => {
      const n = new Map(s);
      if (n.has(o.id)) n.delete(o.id);
      else n.set(o.id, o);
      return n;
    });
  const clear = () => setSel(new Map());
  const sortBy = (k: OrderSort) => p.onSort?.(k, p.sort === k && p.dir === 'desc' ? 'asc' : 'desc');

  const label: Record<OrderColumn, string> = useMemo(
    () => ({
      order: t('orders.col.order'), client: t('orders.col.client'), score: t('clients.score.col'), address: t('orders.col.address'), products: t('orders.col.products'), variant: t('orders.col.variant'), total: t('orders.col.total'),
      conf: t('orders.col.conf'), follow: t('orders.col.follow'), company: t('orders.col.tracking'), agent: t('orders.col.agent'), fagent: t('orders.col.fagent'), phone: t('orders.col.phone'),
      wilaya: t('orders.col.wilaya'), since: t('orders.col.since'),
    }),
    [t],
  );
  const isNum = (c: OrderColumn) => c === 'total';
  const th = (c: OrderColumn) => {
    const k = SORT_KEY[c];
    const cls = c === 'products' ? 'wide' : c === 'agent' || c === 'fagent' ? 'hide-m' : undefined;
    if (k && p.onSort && p.sort)
      return (
        <SortTh key={c} k={k} sort={p.sort} dir={p.dir ?? 'desc'} onSort={sortBy} num={isNum(c)}>
          {label[c]}
        </SortTh>
      );
    return (
      <th key={c} className={[cls, isNum(c) ? 'num' : ''].filter(Boolean).join(' ') || undefined}>
        {label[c]}
      </th>
    );
  };

  const xTh = (x: ExtraColumn) =>
    x.sort && p.onSort && p.sort ? (
      <SortTh key={x.key} k={x.sort} sort={p.sort} dir={p.dir ?? 'desc'} onSort={sortBy} num={x.num}>
        {x.label}
      </SortTh>
    ) : (
      <th key={x.key} className={x.num ? 'num' : undefined}>
        {x.label}
      </th>
    );
  const xTd = (x: ExtraColumn, o: Order) => (
    <td key={x.key} className={x.num ? 'num' : undefined} data-l={x.label}>
      {x.cell(o)}
    </td>
  );

  const cell = (c: OrderColumn, o: Order): ReactNode => {
    switch (c) {
      case 'order':
        return (
          <td key={c} data-l={label[c]}>
            <b className="ltr">{o.ref}</b>
            <small>{when(o.createdAt)}</small>
            {o.possibleDuplicate && <span className="flag dup">{t('orders.flag.dup')}</span>}
            {o.blacklisted && <span className="flag">{t('orders.flag.black')}</span>}
            <TrustFlags o={o} />
            <OriginChip o={o} />
          </td>
        );
      case 'client':
        return (
          <td key={c} data-l={label[c]}>
            {o.customerName}
            {/* the score has its own column here (sortable); a screen without it shows it next to the name */}
            {o.clientScore && !cols.includes('score') && <ScoreChip s={o.clientScore} short />}
            <PhoneOf o={o} small />
          </td>
        );
      case 'score':
        // a new customer (nothing known yet): no chip, as in every list
        return (
          <td key={c} data-l={label[c]} title={o.clientScore ? `${t(`clients.score.level.${o.clientScore.level}`)} — ${t('clients.score.help')}` : undefined}>
            {o.clientScore && o.clientScore.level !== 'new' ? <ScoreChip s={o.clientScore} /> : <span className="muted">—</span>}
          </td>
        );
      case 'phone':
        return (
          <td key={c} data-l={label[c]}>
            <PhoneOf o={o} />
          </td>
        );
      case 'address':
        return (
          <td key={c} data-l={label[c]}>
            {wilaya(o.wilayaId)}
            <small>{o.commune || wilayaName(o.wilayaId)}</small>
          </td>
        );
      case 'wilaya':
        return (
          <td key={c} data-l={label[c]}>
            {wilayaName(o.wilayaId)}
            <small>{o.commune}</small>
          </td>
        );
      case 'products':
        return (
          <td key={c} className="wide px-cw" data-l={label[c]}>
            <div className="px-clamp">{namesOf(o.items, ' · ')}</div>
          </td>
        );
      case 'variant':
        return (
          <td key={c} data-l={label[c]}>
            <div className="px-clamp">{variantsOf(o.items, ' · ')}</div>
          </td>
        );
      case 'total':
        return (
          <td key={c} className="num" data-l={label[c]}>
            <span className="ltr">{da(o.total)}</span>
          </td>
        );
      case 'conf':
        return (
          <td key={c} data-l={label[c]}>
            <span className={`badge t-${o.confStatus === 'no_answer' ? 'mid' : CONF_TONE[o.confStatus] ?? 'off'}`}>{confLabel(t, o)}</span>
            {o.nextCallAt && ['no_answer', 'busy', 'callback', 'postponed'].includes(o.confStatus) && <small>{t('orders.callbackAt', { when: when(o.nextCallAt) })}</small>}
          </td>
        );
      case 'follow':
        return (
          <td key={c} data-l={label[c]}>
            <StatusBadge kind="follow" status={o.followStatus} sub={o.subStatus} />
          </td>
        );
      case 'company':
        return (
          <td key={c} data-l={label[c]}>
            <CopyCode code={trackOf(o)} />
          </td>
        );
      case 'agent':
        return (
          <td key={c} className="hide-m" data-l={label[c]}>
            <RemovableChip name={o.agentName} removeLabel={t('confirmation.removeAgent')} disabled={unAgent.isPending} onRemove={canAgent ? () => unAgent.mutate({ ids: [o.id], agentId: null }) : undefined} />
          </td>
        );
      case 'fagent':
        return (
          <td key={c} className="hide-m" data-l={label[c]}>
            <RemovableChip name={o.followAgentName} removeLabel={t('suivi.removeAgent')} disabled={unFollow.isPending} onRemove={canFollow ? () => unFollow.mutate({ id: o.id }) : undefined} />
          </td>
        );
      case 'since':
        return (
          <td key={c} data-l={label[c]}>
            {when(o.updatedAt)}
          </td>
        );
    }
  };

  if (!p.rows && p.loading) return <Loading />;
  const ids = [...sel.keys()];
  return (
    <div>
      {p.table && (
        <div className="px-scols">
          <TableColumnMenu tc={tc} cols={keys.map((k) => ({ k, label: xOf(k)?.label ?? label[k as OrderColumn] }))} open={menu} onToggle={() => setMenu((v) => !v)} />
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>{p.empty ?? t('orders.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {p.selectable && (
                  <th className="ck">
                    <input type="checkbox" aria-label={t('orders.selectAll')} checked={allOn} onChange={toggleAll} />
                  </th>
                )}
                {p.lead && <th key={p.lead.key}>{p.lead.label}</th>}
                {shown.map((k) => {
                  const x = xOf(k);
                  return x ? xTh(x) : th(k as OrderColumn);
                })}
                {p.extra?.filter((x) => x.fixed).map(xTh)}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const dim = CONF_DONE_BAD.includes(o.confStatus) || o.followStatus === 'cancelled';
                return (
                  <tr key={`${(o as { seller?: { id: number } }).seller?.id ?? ''}:${o.id}`} className={`clickable${sel.has(o.id) ? ' sel' : ''}${dim ? ' dim' : ''}`} onClick={() => (p.onRow ? p.onRow(o) : openOrder(o.id))}>
                    {p.selectable && (
                      <td className="ck" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`${t('orders.select')} ${o.ref}`} checked={sel.has(o.id)} onChange={() => toggle(o)} />
                      </td>
                    )}
                    {p.lead && (
                      <td key={p.lead.key} data-l={p.lead.label}>
                        {p.lead.cell(o)}
                      </td>
                    )}
                    {shown.map((k) => {
                      const x = xOf(k);
                      return x ? xTd(x, o) : cell(k as OrderColumn, o);
                    })}
                    {p.extra?.filter((x) => x.fixed).map((x) => xTd(x, o))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {p.bulk && (
        <BulkBar count={ids.length} onClear={clear}>
          {p.bulk(ids, [...sel.values()], clear)}
        </BulkBar>
      )}
      {p.total > 0 && <Pager page={p.page} pageSize={p.pageSize} total={p.total} onPage={p.onPage} onSize={p.onSize} />}
    </div>
  );
}
