import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateTime, n } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorBox, Field, Loading, Pager, Tabs } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { useDebounced } from './OrderList';
import { ProductForm } from './ProductForm';

const TABS = ['stock', 'produits', 'mouvements'] as const;
type Tab = (typeof TABS)[number];

export function Produits({ sub }: PageProps) {
  const { t } = useTranslation();
  const tab: Tab = (TABS as readonly string[]).includes(sub ?? '') ? (sub as Tab) : 'stock';
  return (
    <>
      <Card
        title={t('produits.title')}
        actions={<Tabs value={tab} onChange={(v) => (location.hash = `#/produits/${v}`)} items={TABS.map((k) => ({ value: k, label: t(`produits.tabs.${k}`) }))} />}
      />
      {tab === 'stock' && (
        <>
          <StockTab />
          <DiscountCard />
        </>
      )}
      {tab === 'produits' && <ProductsTab />}
      {tab === 'mouvements' && <MovesTab />}
    </>
  );
}

// ---------------------------------------------------------------- Stock
type StockRowT = { variantId: number; productName: string; variantTitle: string; sku: string; warehouseId: number; warehouseName: string; qty: number; reserved: number; available: number; alertQty: number; cost: number };
type Dialog = { kind: 'entry' | 'count' | 'loss' | 'alert' | 'transfer'; row: StockRowT } | null;
const nameOf = (r: StockRowT) => (r.variantTitle ? `${r.productName} ${r.variantTitle}` : r.productName);

function StockTab() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [missing, setMissing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dlg, setDlg] = useState<Dialog>(null);
  const dq = useDebounced(q, 200);
  const whs = useRpc('catalog.warehouses', {});
  const st = useRpc('catalog.stock', { q: dq || undefined, missingOnly: missing, withHidden: hidden });
  const many = (whs.data?.length ?? 0) > 1;
  return (
    <Card>
      <div className="row">
        <div className="grow">
          <input type="search" placeholder={t('produits.stock.searchPh')} aria-label={t('produits.stock.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} />
          {t('produits.stock.missingOnly')}
        </label>
        <label className="check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          {t('produits.stock.withHidden')}
        </label>
      </div>
      <p className="muted small">{t('produits.stock.help')}</p>
      {st.isLoading ? (
        <Loading />
      ) : st.error ? (
        <ErrorBox error={st.error} onRetry={() => st.refetch()} />
      ) : !st.data?.length ? (
        <Empty>{t('produits.stock.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('produits.stock.product')}</th>
                {many && <th>{t('produits.stock.depot')}</th>}
                <th className="num">{t('produits.stock.inStock')}</th>
                <th className="num">{t('produits.stock.reserved')}</th>
                <th className="num">{t('produits.stock.available')}</th>
                <th className="num">{t('produits.stock.cost')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {st.data.map((r) => (
                <tr key={`${r.variantId}-${r.warehouseId}`}>
                  <td data-l={t('produits.stock.product')}>
                    {nameOf(r)}
                    {!r.productActive || !r.variantActive ? <span className="chip">{t('produits.products.hidden')}</span> : null}
                    <small className="ltr">{r.sku}</small>
                  </td>
                  {many && <td data-l={t('produits.stock.depot')}>{r.warehouseName}</td>}
                  <td className="num ltr" data-l={t('produits.stock.inStock')}>
                    {n(r.qty)}
                  </td>
                  <td className="num ltr" data-l={t('produits.stock.reserved')}>
                    {n(r.reserved)}
                  </td>
                  <td className="num" data-l={t('produits.stock.available')}>
                    <b className={`ltr ${r.available <= 0 || (r.alertQty > 0 && r.available <= r.alertQty) ? 'stock-low' : ''}`}>{n(r.available)}</b>
                  </td>
                  <td className="num ltr" data-l={t('produits.stock.cost')}>
                    {da(r.cost)}
                  </td>
                  <td className="px-act px-act-many" data-l="">
                    <div className="row nowrap">
                      <button className="btn small" onClick={() => setDlg({ kind: 'entry', row: r })}>
                        {t('produits.stock.entry')}
                      </button>
                      <button className="btn small" onClick={() => setDlg({ kind: 'count', row: r })}>
                        {t('produits.stock.count')}
                      </button>
                      <button className="btn small" onClick={() => setDlg({ kind: 'loss', row: r })}>
                        {t('produits.stock.loss')}
                      </button>
                      <button className="btn small" title={t('produits.stock.alertTitle')} onClick={() => setDlg({ kind: 'alert', row: r })}>
                        {t('produits.stock.alert')}
                        {r.alertQty ? <span className="ltr"> ≤ {r.alertQty}</span> : null}
                      </button>
                      {many && (
                        <button className="btn small" onClick={() => setDlg({ kind: 'transfer', row: r })}>
                          {t('produits.stock.transfer')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dlg && (dlg.kind === 'alert' ? <AlertDialog row={dlg.row} onClose={() => setDlg(null)} /> : dlg.kind === 'transfer' ? <TransferDialog row={dlg.row} warehouses={whs.data ?? []} onClose={() => setDlg(null)} /> : <MoveDialog kind={dlg.kind} row={dlg.row} onClose={() => setDlg(null)} />)}
    </Card>
  );
}

function MoveDialog({ kind, row, onClose }: { kind: 'entry' | 'count' | 'loss'; row: StockRowT; onClose: () => void }) {
  const { t } = useTranslation();
  const [qty, setQty] = useState(kind === 'count' ? String(row.qty) : '');
  const [note, setNote] = useState('');
  const move = useAction('catalog.move', { success: t('produits.stock.updated'), onDone: onClose });
  const submit = () => {
    const v = Number(qty);
    if (!Number.isInteger(v) || v < (kind === 'count' ? 0 : 1)) return toast(t('produits.stock.invalidQty'), 'bad');
    if (kind === 'count' && v === row.qty) return onClose();
    move.mutate({ variantId: row.variantId, warehouseId: row.warehouseId, kind, qty: v, note: note.trim() || null });
  };
  return (
    <Modal
      title={t(`produits.stock.${kind}Title`, { name: nameOf(row) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={move.isPending} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={kind === 'count' ? t('produits.stock.countedQty') : t('produits.stock.qty')} hint={kind !== 'count' ? t('produits.stock.inDepot', { n: row.qty }) : undefined}>
          <input type="number" min={kind === 'count' ? 0 : 1} step={1} required value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={t('produits.stock.note')}>
          <input value={note} placeholder={kind === 'entry' ? t('produits.stock.entryNotePh') : t('produits.stock.reasonPh')} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function AlertDialog({ row, onClose }: { row: StockRowT; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(String(row.alertQty || 0));
  const save = useAction('catalog.setAlert', { success: t('produits.stock.alertSaved'), onDone: onClose });
  const submit = () => save.mutate({ variantId: row.variantId, warehouseId: row.warehouseId, alertQty: Math.max(0, Number(v) || 0) });
  return (
    <Modal
      title={t('produits.stock.alertModal', { name: nameOf(row) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('produits.stock.alertLabel')} hint={t('produits.stock.alertHint')}>
          <input type="number" min={0} step={1} value={v} onChange={(e) => setV(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function TransferDialog({ row, warehouses, onClose }: { row: StockRowT; warehouses: { id: number; name: string }[]; onClose: () => void }) {
  const { t } = useTranslation();
  const others = warehouses.filter((w) => w.id !== row.warehouseId);
  const [to, setTo] = useState(String(others[0]?.id ?? ''));
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const tr = useAction('catalog.transfer', { success: t('produits.stock.transferDone'), onDone: onClose });
  const submit = () => {
    const v = Number(qty);
    if (!Number.isInteger(v) || v < 1) return toast(t('produits.stock.invalidQty'), 'bad');
    tr.mutate({ variantId: row.variantId, from: row.warehouseId, to: Number(to), qty: v, note: note.trim() || null });
  };
  return (
    <Modal
      title={t('produits.stock.transferTitle', { name: nameOf(row) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={tr.isPending || !to} onClick={submit}>
            {t('produits.stock.transfer')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('produits.stock.from')}>
          <input value={`${row.warehouseName} — ${t('produits.stock.inDepot', { n: row.qty })}`} disabled />
        </Field>
        <Field label={t('produits.stock.toDepot')}>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('produits.stock.qty')}>
          <input type="number" min={1} max={Math.max(1, row.qty)} step={1} required value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={t('produits.stock.note')}>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Remise maximale par produit
function DiscountCard() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const prods = useRpc('catalog.products', { activeOnly: false });
  const [vals, setVals] = useState<Record<number, string>>({});
  useEffect(() => {
    if (prods.data) setVals(Object.fromEntries(prods.data.map((p) => [p.id, p.maxDiscount === null ? '' : String(p.maxDiscount)])));
  }, [prods.data]);
  const save = useAction('catalog.setMaxDiscounts', { success: t('produits.discount.saved') });
  const list = (prods.data ?? []).filter((p) => !p.isService);
  if (!list.length) return null;
  return (
    <Card
      className="bjrm"
      title={t('produits.discount.title')}
      help={t('produits.discount.help')}
      actions={
        admin ? (
          <button
            type="button"
            className="btn primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                items: list.map((p) => ({ id: p.id, maxDiscount: vals[p.id] === '' || vals[p.id] === undefined ? null : Math.max(0, Number(vals[p.id]) || 0) })),
              })
            }
          >
            {t('common.save')}
          </button>
        ) : undefined
      }
    >
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('produits.products.product')}</th>
              <th className="num">{t('produits.discount.price')}</th>
              <th className="num">{t('produits.discount.max')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td data-l={t('produits.products.product')}>
                  <b>{p.name}</b>
                </td>
                <td className="num ltr" data-l={t('produits.discount.price')}>
                  {da(p.price)}
                </td>
                <td className="num" data-l={t('produits.discount.max')}>
                  <input
                    type="number"
                    min={0}
                    step={50}
                    disabled={!admin}
                    value={vals[p.id] ?? ''}
                    aria-label={t('produits.discount.label', { name: p.name })}
                    style={{ width: 120 }}
                    onChange={(e) => setVals({ ...vals, [p.id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Produits
function ProductsTab() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const prods = useRpc('catalog.products', { q: dq || undefined });
  const [edit, setEdit] = useState<number | 'new' | null>(null);
  const rows = prods.data ?? [];
  return (
    <Card
      title={t('produits.products.count', { count: rows.length })}
      actions={
        <button className="btn primary" onClick={() => setEdit('new')}>
          {t('produits.products.new')}
        </button>
      }
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="grow">
          <input type="search" placeholder={t('produits.products.searchPh')} aria-label={t('produits.products.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {prods.isLoading ? (
        <Loading />
      ) : prods.error ? (
        <ErrorBox error={prods.error} onRetry={() => prods.refetch()} />
      ) : !rows.length ? (
        <Empty>{t('produits.stock.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('produits.products.product')}</th>
                <th className="wide">{t('produits.products.variants')}</th>
                <th className="num">{t('produits.products.price')}</th>
                <th className="num">{t('produits.products.cost')}</th>
                <th className="num">{t('produits.products.margin')}</th>
                <th>{t('produits.products.state')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setEdit(p.id)}>
                  <td data-l={t('produits.products.product')}>
                    <b>{p.name}</b>
                    <small className="ltr">{p.sku}</small>
                    {p.isService && <span className="chip">{t('produits.products.service')}</span>}
                    {p.parts.length > 0 && <span className="chip">🔧 {t('produits.products.parts', { n: p.parts.length })}</span>}
                  </td>
                  <td className="wide" data-l={t('produits.products.variants')}>
                    {p.variants.filter((v) => v.title && v.active).map((v) => v.title).join(', ') || '—'}
                  </td>
                  <td className="num ltr" data-l={t('produits.products.price')}>
                    {da(p.price)}
                  </td>
                  <td className="num ltr" data-l={t('produits.products.cost')}>
                    {da(p.cost)}
                  </td>
                  <td className="num ltr" data-l={t('produits.products.margin')}>
                    {da(p.price - p.cost)}
                  </td>
                  <td data-l={t('produits.products.state')}>{p.active ? <span className="badge t-ok">{t('produits.products.active')}</span> : <span className="badge t-off">{t('produits.products.hidden')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit !== null && <ProductForm id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

// ---------------------------------------------------------------- Mouvements
const REASONS = ['entry', 'count', 'loss', 'transfer_in', 'transfer_out', 'shipped', 'returned', 'exchange_in'];

function MovesTab() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const [wh, setWh] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, reason, wh, size]);
  const whs = useRpc('catalog.warehouses', {});
  const mv = useRpc('catalog.movements', { q: dq || undefined, reason: reason || undefined, warehouseId: wh ? Number(wh) : undefined, page, pageSize: size });
  const many = (whs.data?.length ?? 0) > 1;
  const reasonLabel = useMemo(() => (r: string) => t(`produits.moves.reasons.${r}`, { defaultValue: r }), [t]);
  return (
    <Card title={t('produits.moves.title')}>
      <div className="filters">
        <label className="field">
          <span className="lab">{t('common.search')}</span>
          <input type="search" placeholder={t('produits.moves.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('produits.moves.kind')}</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{t('produits.moves.allKinds')}</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {reasonLabel(r)}
              </option>
            ))}
          </select>
        </label>
        {many && (
          <label className="field">
            <span className="lab">{t('produits.moves.depot')}</span>
            <select value={wh} onChange={(e) => setWh(e.target.value)}>
              <option value="">{t('produits.moves.allDepots')}</option>
              {whs.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mv.isLoading ? (
        <Loading />
      ) : mv.error ? (
        <ErrorBox error={mv.error} onRetry={() => mv.refetch()} />
      ) : !mv.data?.rows.length ? (
        <Empty>{t('produits.moves.empty')}</Empty>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('produits.moves.when')}</th>
                  <th>{t('produits.moves.product')}</th>
                  {many && <th>{t('produits.moves.depot')}</th>}
                  <th>{t('produits.moves.kind')}</th>
                  <th className="num">{t('produits.moves.qty')}</th>
                  <th>{t('produits.moves.order')}</th>
                  <th>{t('produits.moves.by')}</th>
                  <th className="wide">{t('produits.moves.note')}</th>
                </tr>
              </thead>
              <tbody>
                {mv.data.rows.map((m) => (
                  <tr key={m.id}>
                    <td data-l={t('produits.moves.when')} className="ltr">
                      {dateTime(m.at)}
                    </td>
                    <td data-l={t('produits.moves.product')}>
                      {m.label}
                      <small className="ltr">{m.sku}</small>
                    </td>
                    {many && <td data-l={t('produits.moves.depot')}>{m.warehouseName}</td>}
                    <td data-l={t('produits.moves.kind')}>{reasonLabel(m.reason)}</td>
                    <td className="num" data-l={t('produits.moves.qty')}>
                      <b className={`ltr ${m.delta < 0 ? 'stock-low' : ''}`}>
                        {m.delta > 0 ? '+' : ''}
                        {n(m.delta)}
                      </b>
                    </td>
                    <td data-l={t('produits.moves.order')}>
                      {m.orderRef ? (
                        <button type="button" className="linkish ltr" onClick={() => openOrder(m.orderId!)}>
                          {m.orderRef}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-l={t('produits.moves.by')}>{m.userName ?? '—'}</td>
                    <td className="wide" data-l={t('produits.moves.note')}>
                      {m.note ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={size} total={mv.data.total} onPage={setPage} onSize={setSize} />
        </>
      )}
    </Card>
  );
}
