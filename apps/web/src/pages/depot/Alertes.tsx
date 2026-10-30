// Alertes: the products to reorder — out of stock first, then under their alert level — with what sold in 30 days,
// how long the stock lasts, the last purchase, and a purchase filled in with one tap (one product or a selection).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, dateOnly, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Filters } from '../ai/agent';
import { PurchaseForm, PurchasePrefill } from './PurchaseForm';
import { AlertDialog, MoveDialog } from './StockDialogs';
import { bidi, DepotSelect, LevelBar, nameOf, Toolbar } from './stockui';

type AlertRow = Out<'catalog.alerts'>[number];
type AlertFilter = 'all' | 'out' | 'low';
const keyOf = (a: AlertRow) => `${a.variantId}-${a.warehouseId}`;

/** One purchase for these products: their last supplier (the most frequent one), their depot, how many to buy. */
function prefillOf(rows: AlertRow[]): PurchasePrefill {
  const count = new Map<number, number>();
  for (const r of rows) if (r.lastPurchase?.supplierId) count.set(r.lastPurchase.supplierId, (count.get(r.lastPurchase.supplierId) ?? 0) + 1);
  const supplierId = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const depots = new Set(rows.map((r) => r.warehouseId));
  const seen = new Set<number>();
  return {
    supplierId,
    warehouseId: depots.size === 1 ? rows[0].warehouseId : undefined,
    lines: rows.filter((r) => !seen.has(r.variantId) && seen.add(r.variantId)).map((r) => ({ variantId: r.variantId, qty: r.suggest, unitCost: r.lastPurchase?.unitCost ?? r.cost })),
  };
}

export function Alertes() {
  const { t } = useTranslation();
  const [f, setF] = useState<AlertFilter>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [wh, setWh] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [buy, setBuy] = useState<PurchasePrefill | null>(null);
  const [dlg, setDlg] = useState<{ kind: 'alert' | 'entry'; row: AlertRow } | null>(null);
  const al = useRpc('catalog.alerts', { warehouseId: wh ? Number(wh) : undefined });
  const all = al.data ?? [];
  const list = all.filter((a) => f === 'all' || a.level === f);
  const groups = [...new Map(list.map((a) => [a.productId, a.productName])).entries()].map(([productId, productName]) => ({ productId, productName, rows: list.filter((a) => a.productId === productId) }));
  const chosen = all.filter((a) => sel.has(keyOf(a)));
  const toggle = (a: AlertRow) => setSel((s) => (s.has(keyOf(a)) ? (s.delete(keyOf(a)), new Set(s)) : new Set(s).add(keyOf(a))));
  return (
    <>
      <section className="card pd-card">
        <Toolbar action={<DepotSelect value={wh} onChange={setWh} all={t('produits.ui.allDepots')} label={t('produits.stock.depot')} />}>
          <Filters<AlertFilter>
            value={f}
            onChange={setF}
            label={t('produits.alerts.filters')}
            items={[
              { value: 'all', label: t('produits.alerts.fAll'), count: all.length },
              { value: 'out', label: t('produits.alerts.fOut'), count: all.filter((a) => a.level === 'out').length, alert: true },
              { value: 'low', label: t('produits.alerts.fLow'), count: all.filter((a) => a.level === 'low').length, alert: true },
            ]}
          />
        </Toolbar>
        {al.isLoading ? (
          <Loading />
        ) : al.error ? (
          <ErrorBox error={al.error} onRetry={() => al.refetch()} />
        ) : !list.length ? (
          <div className="ai-empty pd-allgood">
            <Icon name="checkcircle" />
            <p>{t('produits.alerts.none')}</p>
          </div>
        ) : (
          <div className="pd-alerts">
            {groups.map((group) => (
              <div key={group.productId} className="pd-card">
                <button type="button" className="btn ghost" aria-expanded={expanded.has(group.productId)} onClick={() => setExpanded((old) => { const next = new Set(old); next.has(group.productId) ? next.delete(group.productId) : next.add(group.productId); return next; })}>
                  <Icon name={expanded.has(group.productId) ? "chevron-down" : "chevron-right"} /> {group.productName} · {group.rows.length} variants to reorder
                </button>
                {expanded.has(group.productId) && group.rows.map((a) => {
              const perDay = a.sold30 / 30;
              const days = perDay > 0 ? Math.max(0, Math.floor(a.available / perDay)) : null;
              const on = sel.has(keyOf(a));
              return (
                <article key={keyOf(a)} className={`pd-alert ${a.level} ${on ? 'sel' : ''}`}>
                  <label className="pd-ck">
                    <input type="checkbox" checked={on} onChange={() => toggle(a)} aria-label={t('produits.alerts.pick', { name: nameOf(a) })} />
                  </label>
                  <div className="pd-alert-in">
                    <div className="pd-alert-top">
                      <span className="pd-name">
                        <b>{nameOf(a)}</b>
                        <small>
                          <span className="ltr">{a.sku}</span>
                          <span>{a.warehouseName}</span>
                        </small>
                      </span>
                      <span className={`pd-lvl ${a.level}`}>{t(`produits.alerts.${a.level}`)}</span>
                    </div>
                    <div className="pd-gauge">
                      <b className="ltr">{n(a.available)}</b>
                      <span>
                        <small>{t('produits.alerts.left')}</small>
                        <LevelBar available={a.available} alert={a.alertQty} />
                        <small>{a.alertQty > 0 ? t('produits.alerts.level', { n: a.alertQty }) : t('produits.alerts.noLevel')}</small>
                      </span>
                    </div>
                    <ul className="pd-facts">
                      <li>
                        <Icon name="chart" />
                        <span>
                          {t('produits.alerts.sold', { count: a.sold30 })}
                          {days !== null && a.available > 0 && <> · {t('produits.alerts.days', { count: days })}</>}
                        </span>
                      </li>
                      <li>
                        <Icon name="receipt" />
                        <span>{a.lastPurchase ? t('produits.alerts.last', { price: bidi(da(a.lastPurchase.unitCost)), who: bidi(a.lastPurchase.supplierName ?? t('produits.buy.noSupplier')), when: bidi(dateOnly(a.lastPurchase.at)) }) : t('produits.alerts.never')}</span>
                      </li>
                      {a.qty < 0 ? (
                        <li className="bad">
                          <Icon name="alert" />
                          <span>
                            {t('produits.alerts.negative', { n: a.qty })} <a href="#/produits/inventaire">{t('produits.alerts.countIt')}</a>
                          </span>
                        </li>
                      ) : (
                        a.reserved > 0 && (
                          <li>
                            <Icon name="clock" />
                            <span>{t('produits.alerts.reserved', { count: a.reserved, stock: a.qty })}</span>
                          </li>
                        )
                      )}
                    </ul>
                    <div className="pd-alert-acts">
                      <button type="button" className="btn primary small" onClick={() => setBuy(prefillOf([a]))}>
                        <Icon name="cart" />
                        {t('produits.alerts.buy', { n: a.suggest })}
                      </button>
                      <button type="button" className="btn small" onClick={() => setDlg({ kind: 'alert', row: a })}>
                        {t('produits.alerts.setLevel')}
                      </button>
                      <button type="button" className="btn small" onClick={() => setDlg({ kind: 'entry', row: a })}>
                        <Icon name="plus" />
                        {t('produits.stock.entry')}
                      </button>
                    </div>
                  </div>
                </article>
              );
                })}
              </div>
            ))}
          </div>
        )}
        <p className="pd-note">{t('produits.alerts.help')}</p>
      </section>
      {chosen.length > 0 && (
        <div className="bulkbar pd-bulk" role="toolbar">
          <b>{t('common.selected', { count: chosen.length })}</b>
          <button type="button" className="btn small primary" onClick={() => setBuy(prefillOf(chosen))}>
            <Icon name="cart" />
            {t('produits.alerts.buySel')}
          </button>
          <button type="button" className="btn small ghost" style={{ color: 'inherit' }} onClick={() => setSel(new Set())}>
            {t('common.unselect')}
          </button>
        </div>
      )}
      {buy && (
        <PurchaseForm
          prefill={buy}
          onClose={() => {
            setBuy(null);
            setSel(new Set());
          }}
        />
      )}
      {dlg?.kind === 'alert' && <AlertDialog row={dlg.row} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'entry' && <MoveDialog kind="entry" row={dlg.row} onClose={() => setDlg(null)} />}
    </>
  );
}
