// Prévisions: every product that sells, with how many leave a day, in how many days it runs out, and how many to buy
// now to last the supplier's delay plus the days of stock wanted. One tap fills a purchase (one product or a selection).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, dateOnly, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Filters } from '../ai/agent';
import { PurchaseForm, PurchasePrefill } from './PurchaseForm';
import { bidi, DepotSelect, nameOf, Toolbar } from './stockui';

type Row = Out<'catalog.forecast'>['rows'][number];
type F = 'all' | 'now' | 'soon';
const WINDOWS = [7, 14, 30, 60, 90] as const;

/** One purchase for these products: their most frequent last supplier, the depot looked at, how many to buy. */
function prefillOf(rows: Row[], warehouseId: number | null): PurchasePrefill {
  const count = new Map<number, number>();
  for (const r of rows) if (r.lastPurchase?.supplierId) count.set(r.lastPurchase.supplierId, (count.get(r.lastPurchase.supplierId) ?? 0) + 1);
  return {
    supplierId: [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    warehouseId: warehouseId ?? undefined,
    lines: rows.filter((r) => r.toOrder > 0).map((r) => ({ variantId: r.variantId, qty: r.toOrder, unitCost: r.lastPurchase?.unitCost ?? r.cost ?? undefined })),
  };
}

export function Prevision() {
  const { t } = useTranslation();
  const [wh, setWh] = useState('');
  const [win, setWin] = useState(30);
  const [lead, setLead] = useState(15);
  const [cover, setCover] = useState(30);
  const [f, setF] = useState<F>('all');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [buy, setBuy] = useState<PurchasePrefill | null>(null);
  const q = useRpc('catalog.forecast', { warehouseId: wh ? Number(wh) : undefined, window: win, lead, cover });
  const all = q.data?.rows ?? [];
  const list = all.filter((r) => f === 'all' || r.status === f);
  const chosen = all.filter((r) => sel.has(r.variantId) && r.toOrder > 0);
  const toggle = (id: number) => setSel((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s).add(id)));
  const days = (v: number, set: (x: number) => void, label: string, max: number) => (
    <label className="pd-fc-n">
      <span>{label}</span>
      <input type="number" min={0} max={max} value={v} onChange={(e) => set(Math.max(0, Math.min(max, Number(e.target.value) || 0)))} />
    </label>
  );
  return (
    <>
      <section className="card pd-card">
        <Toolbar action={<DepotSelect value={wh} onChange={setWh} all={t('produits.ui.allDepots')} label={t('produits.stock.depot')} />}>
          <Filters<F>
            value={f}
            onChange={setF}
            label={t('produits.fc.filters')}
            items={[
              { value: 'all', label: t('produits.fc.fAll'), count: all.length },
              { value: 'now', label: t('produits.fc.now'), count: all.filter((r) => r.status === 'now').length, alert: true },
              { value: 'soon', label: t('produits.fc.soon'), count: all.filter((r) => r.status === 'soon').length },
            ]}
          />
        </Toolbar>
        <div className="pd-fc-set">
          <label className="pd-fc-n">
            <span>{t('produits.fc.window')}</span>
            <select className="pd-sel" value={win} onChange={(e) => setWin(Number(e.target.value))}>
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {t('produits.fc.days', { count: d })}
                </option>
              ))}
            </select>
          </label>
          {days(lead, setLead, t('produits.fc.lead'), 180)}
          {days(cover, (x) => setCover(Math.max(1, x)), t('produits.fc.cover'), 365)}
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !list.length ? (
          <div className="ai-empty pd-allgood">
            <Icon name="checkcircle" />
            <p>{all.length ? t('produits.fc.noneHere') : t('produits.fc.none', { count: win })}</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl pd-fc">
              <thead>
                <tr>
                  <th className="ck" />
                  <th>{t('produits.fc.product')}</th>
                  <th className="num">{t('produits.fc.left')}</th>
                  <th className="num">{t('produits.fc.perDay')}</th>
                  <th>{t('produits.fc.runsOut')}</th>
                  <th className="num">{t('produits.fc.toOrder')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.variantId} className={sel.has(r.variantId) ? 'sel' : ''}>
                    <td className="ck">
                      <input type="checkbox" checked={sel.has(r.variantId)} disabled={r.toOrder <= 0} onChange={() => toggle(r.variantId)} aria-label={t('produits.alerts.pick', { name: nameOf(r) })} />
                    </td>
                    <td className="wide">
                      <b>{nameOf(r)}</b>
                      <small className="pd-fc-sub">
                        <span className="ltr">{r.sku}</span>
                        {r.lastPurchase ? ` · ${t('produits.alerts.last', { price: bidi(da(r.lastPurchase.unitCost)), who: bidi(r.lastPurchase.supplierName ?? t('produits.buy.noSupplier')), when: bidi(dateOnly(r.lastPurchase.at)) })}` : ''}
                      </small>
                    </td>
                    <td className="num ltr">{n(r.available)}</td>
                    <td className="num ltr" title={t('produits.fc.soldIn', { n: r.sold, count: win })}>
                      {r.perDay.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                    </td>
                    <td>
                      <span className={`pd-fc-st ${r.status}`}>{r.daysLeft === 0 ? t('produits.fc.outNow') : t('produits.fc.inDays', { count: r.daysLeft ?? 0 })}</span>
                      {r.runOutAt && r.daysLeft !== 0 && <small className="pd-fc-sub">{dateOnly(r.runOutAt)}</small>}
                    </td>
                    <td className="num ltr">
                      <b>{r.toOrder > 0 ? n(r.toOrder) : '—'}</b>
                    </td>
                    <td>
                      {r.toOrder > 0 && (
                        <button type="button" className="btn small primary" onClick={() => setBuy(prefillOf([r], q.data?.warehouseId ?? null))}>
                          <Icon name="cart" />
                          {t('produits.alerts.buy', { n: r.toOrder })}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="pd-note">
          {t('produits.fc.help', { lead, cover, total: lead + cover })}
          {q.data?.idle ? ` ${t('produits.fc.idle', { count: q.data.idle, days: win })}` : ''}
        </p>
      </section>
      {chosen.length > 0 && (
        <div className="bulkbar pd-bulk" role="toolbar">
          <b>{t('common.selected', { count: chosen.length })}</b>
          <button type="button" className="btn small primary" onClick={() => setBuy(prefillOf(chosen, q.data?.warehouseId ?? null))}>
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
    </>
  );
}
