// Produits & stock, in seven tabs: Stock · Inventaire · Produits (prices, margin and maximum discount included) ·
// Mouvements · Alertes · Achats (and suppliers) · Dépôts (and transfers). The header is the one of the Pilot AI pages: an icon, a name, a sentence
// about the current tab, and the tabs underneath.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateTime, n } from '../../lib/format';
import { featureIsOn, pageIsOn } from '../../lib/features';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Icon, Kpi, Kpis, Loading, Pager } from '../../ui/kit';
import { Filters, SearchBox, SectionHeader } from '../ai/agent';
import type { PageProps } from '../registry';
import { Achats } from './Achats';
import { Alertes } from './Alertes';
import { Depots } from './Depots';
import { Inventaire } from './Inventaire';
import { useDebounced } from './OrderList';
import { ImportDialog } from './ImportDialog';
import { ProductForm } from './ProductForm';
import { AlertDialog, MoveDialog, TransferDialog } from './StockDialogs';
import { bidi, Delta, DepotSelect, LevelBar, matches, nameOf, RowMenu, StockRowT, Toolbar, useDepots } from './stockui';
import './produits.css';

const TABS = ['stock', 'inventaire', 'produits', 'mouvements', 'alertes', 'achats', 'depots'] as const;
type Tab = (typeof TABS)[number];
const ICONS: Record<Tab, string> = { stock: 'package', inventaire: 'clipboard', produits: 'tag', mouvements: 'swap', alertes: 'alert', achats: 'receipt', depots: 'building' };

export function Produits({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  // the former « Prix » tab lives in Produits now
  const tab: Tab = sub === 'prix' ? 'produits' : (TABS as readonly string[]).includes(sub ?? '') ? (sub as Tab) : 'stock';
  const alerts = useRpc('catalog.alerts', {});
  const tabs = TABS.filter((k) => pageIsOn('produits', k)).map((k) => ({ key: k, label: t(`produits.tabs.${k}`), icon: ICONS[k], href: `#/produits/${k}`, count: k === 'alertes' ? alerts.data?.length : undefined, alert: k === 'alertes' }));
  const arg = rest?.[0] ? decodeURIComponent(rest[0]) : undefined;
  return (
    <div className="pd">
      <SectionHeader icon="layers" title={t('produits.title')} about={t(`produits.about.${tab}`)} tabs={tabs} current={tab} />
      {tab === 'stock' && <StockTab />}
      {tab === 'inventaire' && <Inventaire />}
      {tab === 'produits' && <ProductsTab />}
      {tab === 'mouvements' && <MovesTab key={arg ?? ''} initial={arg} />}
      {tab === 'alertes' && <Alertes />}
      {tab === 'achats' && <Achats open={arg && /^\d+$/.test(arg) ? Number(arg) : undefined} />}
      {tab === 'depots' && <Depots />}
    </div>
  );
}

// ---------------------------------------------------------------- Stock
type Dialog = { kind: 'entry' | 'count' | 'loss' | 'alert' | 'transfer'; row: StockRowT } | null;
type StockFilter = 'all' | 'low' | 'out' | 'hidden';
const isHidden = (r: StockRowT) => !r.productActive || !r.variantActive;
/** shown in « Tout »: on sale, or still physically in a depot, or promised to an order */
const isListed = (r: StockRowT) => !isHidden(r) || r.qty !== 0 || r.reserved !== 0;
const isLow = (r: StockRowT) => !isHidden(r) && r.available <= r.alertQty;
const isOut = (r: StockRowT) => !isHidden(r) && r.available <= 0;

function StockTab() {
  const { t } = useTranslation();
  const { depots, many } = useDepots();
  const [q, setQ] = useState('');
  const [f, setF] = useState<StockFilter>('all');
  const [wh, setWh] = useState('');
  const [dlg, setDlg] = useState<Dialog>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const st = useRpc('catalog.stock', { withHidden: true });
  const inDepot = (st.data ?? []).filter((r) => !wh || r.warehouseId === Number(wh));
  const found = inDepot.filter((r) => !q.trim() || matches(q, nameOf(r), r.sku));
  const test: Record<StockFilter, (r: StockRowT) => boolean> = { all: isListed, low: isLow, out: isOut, hidden: isHidden };
  const list = found.filter(test[f]);
  const groups = [...new Map(list.map((r) => [r.productId, r.productName])).entries()].map(([productId, productName]) => ({ productId, productName, rows: list.filter((r) => r.productId === productId) }));
  const sum = (fn: (r: StockRowT) => number) => inDepot.reduce((s, r) => s + fn(r), 0);
  const value = sum((r) => Math.max(0, r.qty) * r.cost);
  const pieces = sum((r) => Math.max(0, r.qty));
  const reserved = sum((r) => r.reserved);
  const toBuy = inDepot.filter(isLow).length;
  return (
    <>
      <Kpis>
        <Kpi label={t('produits.stock.kValue')} value={da(value)} sub={t('produits.stock.kValueSub')} icon="coins" />
        <Kpi label={t('produits.stock.kPieces')} value={n(pieces)} sub={t('produits.stock.kPiecesSub', { count: inDepot.filter((r) => r.qty > 0).length })} icon="package" />
        <Kpi label={t('produits.stock.kReserved')} value={n(reserved)} sub={t('produits.stock.kReservedSub')} icon="clock" />
        <Kpi label={t('produits.stock.kToBuy')} value={n(toBuy)} sub={t('produits.stock.kToBuySub')} icon="alert" tone={toBuy ? 'bad' : undefined} href="#/produits/alertes" />
      </Kpis>
      <section className="card pd-card">
        <Toolbar action={many ? <DepotSelect value={wh} onChange={setWh} all={t('produits.ui.allDepots')} label={t('produits.stock.depot')} /> : undefined}>
          <SearchBox value={q} onChange={setQ} placeholder={t('produits.stock.searchPh')} />
          <Filters<StockFilter>
            value={f}
            onChange={setF}
            label={t('produits.stock.filters')}
            items={[
              { value: 'all', label: t('produits.stock.fAll'), count: found.filter(isListed).length },
              { value: 'low', label: t('produits.stock.fLow'), count: found.filter(isLow).length, alert: true },
              { value: 'out', label: t('produits.stock.fOut'), count: found.filter(isOut).length, alert: true },
              { value: 'hidden', label: t('produits.stock.fHidden'), count: found.filter(isHidden).length },
            ]}
          />
        </Toolbar>
        {st.isLoading ? (
          <Loading />
        ) : st.error ? (
          <ErrorBox error={st.error} onRetry={() => st.refetch()} />
        ) : !list.length ? (
          <Empty>{q.trim() ? t('produits.ui.noMatch') : t(`produits.stock.empty_${f}`)}</Empty>
        ) : (
          <div className="pd-list">
            <div className={`pd-row pd-head pd-stock ${many ? 'many' : ''}`} aria-hidden="true">
              <span>{t('produits.stock.product')}</span>
              {many && <span>{t('produits.stock.depot')}</span>}
              <span className="num">{t('produits.stock.inStock')}</span>
              <span className="num">{t('produits.stock.reserved')}</span>
              <span className="num">{t('produits.stock.available')}</span>
              <span className="num">{t('produits.stock.cost')}</span>
              <span />
            </div>
            <div className="pd-rows">
              {groups.map((group) => (
                <div key={group.productId}>
                  <div className="pd-row pd-stock" style={{ alignItems: 'center' }}>
                    <button type="button" className="btn small ghost" aria-expanded={expanded.has(group.productId)} onClick={() => setExpanded((old) => { const next = new Set(old); next.has(group.productId) ? next.delete(group.productId) : next.add(group.productId); return next; })}>
                      <Icon name={expanded.has(group.productId) ? 'chevron-down' : 'chevron-right'} /> {group.productName} ({group.rows.length})
                    </button>
                    <span className="num">{n(group.rows.reduce((v, r) => v + r.qty, 0))} in stock</span>
                    <span className="num">{n(group.rows.reduce((v, r) => v + r.reserved, 0))} reserved</span>
                    <span className="num">{n(group.rows.reduce((v, r) => v + r.available, 0))} available</span>

                  </div>
                  {expanded.has(group.productId) && group.rows.map((r) => (
                <div key={`${r.variantId}-${r.warehouseId}`} className={`pd-row pd-stock ${many ? 'many' : ''} ${isHidden(r) ? 'dim' : ''}`}>
                  <span className="pd-name">
                    <b>{nameOf(r)}</b>
                    <small>
                      <span className="ltr">{r.sku}</span>
                      {isHidden(r) && <span className="chip">{t('produits.products.hidden')}</span>}
                    </small>
                  </span>
                  {many && <span className="pd-depot">{r.warehouseName}</span>}
                  <span className="num pd-c pd-q" data-l={t('produits.stock.inStock')}>
                    <span className="ltr">{n(r.qty)}</span>
                  </span>
                  <span className="num pd-c pd-r" data-l={t('produits.stock.reserved')}>
                    <span className="ltr">{n(r.reserved)}</span>
                  </span>
                  <span className="num pd-avail" data-l={t('produits.stock.available')}>
                    <b className={`ltr ${r.available <= 0 ? 'out' : r.available <= r.alertQty ? 'low' : ''}`}>{n(r.available)}</b>
                    <LevelBar available={r.available} alert={r.alertQty} />
                    {r.alertQty > 0 && <small>{t('produits.stock.alertAt', { n: r.alertQty })}</small>}
                  </span>
                  <span className="num pd-c pd-cost" data-l={t('produits.stock.cost')}>
                    <span className="ltr">{da(r.cost)}</span>
                  </span>
                  <span className="pd-acts">

                    <button className="btn small" onClick={() => setDlg({ kind: 'entry', row: r })}>
                      <Icon name="plus" />
                      {t('produits.stock.entry')}
                    </button>
                    <RowMenu
                      label={t('produits.ui.moreFor', { name: nameOf(r) })}
                      items={[
                        { label: t('produits.stock.loss'), icon: 'minus', onClick: () => setDlg({ kind: 'loss', row: r }) },
                        { label: t('produits.stock.count'), icon: 'clipboard', onClick: () => setDlg({ kind: 'count', row: r }) },
                        { label: t('produits.stock.alertTitle'), icon: 'alert', onClick: () => setDlg({ kind: 'alert', row: r }) },
                        ...(many ? [{ label: t('produits.stock.transfer'), icon: 'swap', onClick: () => setDlg({ kind: 'transfer', row: r }) }] : []),
                        { label: t('produits.stock.history'), icon: 'history', onClick: () => (location.hash = `#/produits/mouvements/${encodeURIComponent(r.sku)}`) },
                      ]}
                    />
                  </span>
                </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="pd-note">{t('produits.stock.help')}</p>
      </section>
      {dlg && (dlg.kind === 'alert' ? <AlertDialog row={dlg.row} onClose={() => setDlg(null)} /> : dlg.kind === 'transfer' ? <TransferDialog row={dlg.row} warehouses={depots} onClose={() => setDlg(null)} /> : <MoveDialog kind={dlg.kind} row={dlg.row} onClose={() => setDlg(null)} />)}
    </>
  );
}

// ---------------------------------------------------------------- Produits
type ProdFilter = 'active' | 'hidden' | 'service' | 'all';

function ProductsTab() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [f, setF] = useState<ProdFilter>('active');
  const [openProduct, setOpenProduct] = useState<Set<number>>(new Set());
  const availability = useAction('catalog.setAvailability', { success: 'Disponibilité mise à jour' });
  const prods = useRpc('catalog.products', {});
  const st = useRpc('catalog.stock', { withHidden: true });
  const [edit, setEdit] = useState<number | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  // landing pages: which products have one (a product just created without one gets a banner)
  const { session } = useSession();
  const marketer = !!session && (session.isAdmin || session.roles.includes('marketer'));
  // landing pages are not in every plan
  const cov = useRpc('landing.coverage', {}, { enabled: featureIsOn('landing') });
  const pages = useMemo(() => new Map((cov.data?.pages ?? []).map((x) => [x.productId, x])), [cov.data]);
  const ignored = useMemo(() => new Set(cov.data?.ignored ?? []), [cov.data]);
  const [fresh, setFresh] = useState<{ id: number; name: string } | null>(null);
  const stock = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of st.data ?? []) m.set(r.productId, (m.get(r.productId) ?? 0) + r.available);
    return m;
  }, [st.data]);
  const all = prods.data ?? [];
  const found = all.filter((p) => !q.trim() || matches(q, p.name, p.sku, ...p.variants.map((v) => `${v.title} ${v.sku}`)));
  const test: Record<ProdFilter, (p: (typeof all)[number]) => boolean> = { active: (p) => p.active, hidden: (p) => !p.active, service: (p) => p.isService, all: () => true };
  const rows = found.filter(test[f]);
  const stockByVariant = new Map<number, number>();
  for (const r of st.data ?? []) stockByVariant.set(r.variantId, (stockByVariant.get(r.variantId) ?? 0) + r.available);
  const toggleOpen = (id: number) => setOpenProduct((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  return (
    <section className="card pd-card">
      <Toolbar
        action={
          <div className="pd-acts-top">
            <button className="btn" onClick={() => setImporting(true)}>
              <Icon name="upload" />
              {t('produits.import.button')}
            </button>
            <button className="btn primary" onClick={() => setEdit('new')}>
              <Icon name="plus" />
              {t('produits.products.new')}
            </button>
          </div>
        }
      >
        <SearchBox value={q} onChange={setQ} placeholder={t('produits.products.searchPh')} />
        <Filters<ProdFilter>
          value={f}
          onChange={setF}
          label={t('produits.products.filters')}
          items={(['active', 'hidden', 'service', 'all'] as const).map((k) => ({ value: k, label: t(`produits.products.f_${k}`), count: found.filter(test[k]).length }))}
        />
      </Toolbar>
      {fresh && !cov.isFetching && !pages.has(fresh.id) && (
        <div className="lp-fresh" role="status">
          <Icon name="globe" />
          <span>
            <b>{t('produits.landing.freshTitle', { name: fresh.name })}</b>
            <small>{marketer ? t('produits.landing.freshHelp') : t('produits.landing.freshMarketer')}</small>
          </span>
          {marketer && (
            <a className="btn small primary" href={`#/landing/pages/new/${fresh.id}`}>
              {t('produits.landing.create')}
            </a>
          )}
          <button className="icon-btn" aria-label={t('common.close')} onClick={() => setFresh(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {prods.isLoading ? (
        <Loading />
      ) : prods.error ? (
        <ErrorBox error={prods.error} onRetry={() => prods.refetch()} />
      ) : !rows.length ? (
        <Empty>{q.trim() ? t('produits.ui.noMatch') : t('produits.products.empty')}</Empty>
      ) : (
        <div className="pd-list">
          <div className="pd-row pd-head pd-prows" aria-hidden="true">
            <span className="a-name">{t('produits.products.product')}</span>
            <span className="a-vars">{t('produits.products.variants')}</span>
            <span className="a-price num">{t('produits.products.price')}</span>
            <span className="a-cost num">{t('produits.products.cost')}</span>
            <span className="a-margin num">{t('produits.products.margin')}</span>
            <span className="a-disc num">{t('produits.prices.discountShort')}</span>
            <span className="a-avail num">{t('produits.products.available')}</span>
            <span className="a-state">{t('produits.products.state')}</span>
          </div>
          {rows.map((p) => {
            const detailed = p.variants.filter((v) => v.title);
            return (
              <div key={p.id} className="pd-product-group">
              <div
                className={`pd-row pd-prows pd-click ${p.active ? '' : 'dim'}`}
                role="button"
                tabIndex={0}
                aria-label={t('produits.form.editTitle', { name: p.name })}
                onClick={() => setEdit(p.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setEdit(p.id))}
              >
                <span className="a-name pd-prod">
                  {detailed.length > 0 && <button type="button" className="btn small ghost" aria-label={openProduct.has(p.id) ? `Collapse ${p.name} variants` : `Expand ${p.name} variants`} aria-expanded={openProduct.has(p.id)} onClick={(e) => { e.stopPropagation(); toggleOpen(p.id); }}>{openProduct.has(p.id) ? '▾' : '▸'}</button>}
                  <span className="pd-thumb" aria-hidden="true">
                    {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <Icon name={p.isService ? 'sparkles' : 'package'} />}
                  </span>
                  <span className="pd-name">
                    <b>{p.name}</b>
                    <small>
                      {detailed.length === 0 && <span className="ltr">{p.sku}</span>}
                      {p.isService && <span className="chip">{t('produits.products.service')}</span>}
                      {p.parts.length > 0 && <span className="chip">{t('produits.products.parts', { n: p.parts.length })}</span>}
                      {cov.data && p.active && !p.isService && !pages.has(p.id) && !ignored.has(p.id) &&
                        (marketer ? (
                          <a className="chip lp-nolp" href={`#/landing/pages/new/${p.id}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                            {t('produits.landing.none')} · {t('produits.landing.create')}
                          </a>
                        ) : (
                          <span className="chip lp-nolp">{t('produits.landing.none')}</span>
                        ))}
                    </small>
                  </span>
                </span>
                <span className="a-vars pd-vars">
                  {detailed.length > 0 && <span className="pd-variant-count">{detailed.length} variants</span>}
                  {detailed.length === 0 && <span className="pd-none">—</span>}
                </span>
                <span className="pd-sub">
                  <span className="a-price num" data-l={t('produits.prices.sale')}>
                    <b className="ltr">{da(p.price)}</b>
                  </span>
                  <span className="a-cost num" data-l={t('produits.prices.cost')}>
                    <span className="ltr">{p.isService ? '—' : da(p.cost)}</span>
                  </span>
                  <span className="a-margin num" data-l={t('produits.prices.margin')}>
                    <span className="ltr">{p.isService ? '—' : da(p.price - p.cost)}</span>
                  </span>
                  <span className="a-disc num pd-disc" data-l={t('produits.prices.discountShort')}>
                    {p.maxDiscount === null ? (
                      <span className="pd-none">{t('produits.prices.noLimit')}</span>
                    ) : (
                      <>
                        <span className="ltr">{da(p.maxDiscount)}</span>
                        <small>{t('produits.prices.floor', { price: bidi(da(Math.max(0, p.price - p.maxDiscount))) })}</small>
                      </>
                    )}
                  </span>
                  <span className="a-avail num" data-l={t('produits.products.available')}>
                    <span className="ltr">{p.isService ? '—' : n(stock.get(p.id) ?? 0)}</span>
                  </span>
                </span>
                <span className="a-state">
                  <label className="pd-availability" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={p.active} disabled={availability.isPending} aria-label={`Product ${p.name} available for orders`} onChange={(e) => availability.mutate({ productId: p.id, active: e.target.checked })} />
                    <span className="pd-switch-track" aria-hidden="true" /> <span className="pd-switch-state">{p.active ? "ON" : "OFF"}</span>
                  </label>
                </span>
              </div>
              {openProduct.has(p.id) && detailed.length > 0 && (
                <div className="pd-variant-detail" aria-label={`Variants of ${p.name}`}>
                  <div className="pd-variant-head">
                    <span>Variant / Photo</span><span>SKU</span><span>Weight</span><span>Purchase</span><span>Sale</span><span>Margin</span><span>Max. discount</span><span>Stock</span><span>Status</span>
                  </div>
                  {detailed.map((v) => (
                    <div key={v.id} className="pd-variant-line">
                      <b style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{(v.photo || p.photo) ? <img src={v.photo || p.photo || ''} alt="" className="pd-variant-photo" /> : <Icon name="package" />}{v.title}</b>
                      <span className="ltr">{v.sku}</span>
                      <span>{v.weightKg == null ? '—' : `${v.weightKg} kg`}</span>
                      <span className="ltr">{da(p.cost)}</span>
                      <span className="ltr">{da(p.price)}</span>
                      <span className="ltr">{da(p.price - p.cost)}</span>
                      <span className="ltr">{p.maxDiscount == null ? '—' : da(p.maxDiscount)}</span>
                      <span>{n(stockByVariant.get(v.id) ?? 0)}</span>
                      <label className="pd-availability">
                        <input type="checkbox" checked={v.active} disabled={availability.isPending || !p.active} aria-label={`Variant ${v.title} available for orders`} onChange={(e) => availability.mutate({ variantId: v.id, active: e.target.checked })} />
                        <span className="pd-switch-track" aria-hidden="true" /> <span className="pd-switch-state">{v.active && p.active ? "ON" : "OFF"}</span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {edit !== null && <ProductForm id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onCreated={(r) => r.active && !r.isService && setFresh({ id: r.id, name: r.name })} />}
    </section>
  );
}

// ---------------------------------------------------------------- Mouvements de stock
const REASONS = ['purchase', 'entry', 'count', 'loss', 'transfer_in', 'transfer_out', 'shipped', 'returned', 'exchange_in'];

function MovesTab({ initial }: { initial?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState(initial ?? '');
  const [reason, setReason] = useState('');
  const [wh, setWh] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, reason, wh, size]);
  const { many } = useDepots();
  const mv = useRpc('catalog.movements', { q: dq || undefined, reason: reason || undefined, warehouseId: wh ? Number(wh) : undefined, page, pageSize: size });
  const reasonLabel = (r: string) => t(`produits.moves.reasons.${r}`, { defaultValue: r });
  return (
    <section className="card pd-card">
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={t('produits.moves.searchPh')} />
        <div className="pd-sels">
          <select className={`pd-sel ${reason ? 'on' : ''}`} aria-label={t('produits.moves.kind')} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{t('produits.moves.allKinds')}</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {reasonLabel(r)}
              </option>
            ))}
          </select>
          <DepotSelect value={wh} onChange={setWh} all={t('produits.ui.allDepots')} label={t('produits.moves.depot')} />
        </div>
      </Toolbar>
      {mv.isLoading ? (
        <Loading />
      ) : mv.error ? (
        <ErrorBox error={mv.error} onRetry={() => mv.refetch()} />
      ) : !mv.data?.rows.length ? (
        <Empty>{t('produits.moves.empty')}</Empty>
      ) : (
        <>
          <div className="pd-list">
            <div className={`pd-row pd-head pd-mv ${many ? 'many' : ''}`} aria-hidden="true">
              <span className="a-when">{t('produits.moves.when')}</span>
              <span className="a-name">{t('produits.moves.product')}</span>
              {many && <span className="a-depot">{t('produits.moves.depot')}</span>}
              <span className="a-kind">{t('produits.moves.kind')}</span>
              <span className="a-qty num">{t('produits.moves.qty')}</span>
              <span className="a-ref">{t('produits.moves.ref')}</span>
              <span className="a-note">{t('produits.moves.note')}</span>
            </div>
            {mv.data.rows.map((m) => (
              <div key={m.id} className={`pd-row pd-mv ${many ? 'many' : ''}`}>
                <span className="a-name pd-name">
                  <b>{m.label}</b>
                  <small className="ltr">{m.sku}</small>
                </span>
                <span className="a-qty num">
                  <Delta v={m.delta} />
                </span>
                <span className="pd-sub">
                  <span className="a-kind">
                    <span className={`pd-reason r-${m.reason}`}>{reasonLabel(m.reason)}</span>
                  </span>
                  <span className={`a-ref ${m.orderRef || m.purchaseRef || m.inventoryRef ? '' : 'pd-empty'}`}>
                    {m.orderRef ? (
                      <button type="button" className="pd-ref ltr" onClick={() => openOrder(m.orderId!)}>
                        {m.orderRef}
                      </button>
                    ) : m.purchaseRef ? (
                      <a className="pd-ref ltr" href={`#/produits/achats/${m.purchaseId}`}>
                        {m.purchaseRef}
                      </a>
                    ) : m.inventoryRef ? (
                      <button type="button" className="pd-ref ltr" onClick={() => setQ(m.inventoryRef!)}>
                        {m.inventoryRef}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </span>
                  {many && <span className="a-depot pd-muted">{m.warehouseName}</span>}
                  <span className="a-when pd-muted">
                    <span className="ltr">{dateTime(m.at)}</span>
                    {m.userName && <small>{m.userName}</small>}
                  </span>
                </span>
                {m.note ? <span className="a-note pd-mnote">{m.note}</span> : null}
              </div>
            ))}
          </div>
          <Pager page={page} pageSize={size} total={mv.data.total} onPage={setPage} onSize={setSize} />
        </>
      )}
    </section>
  );
}
