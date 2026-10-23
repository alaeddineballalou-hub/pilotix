// A purchase from a supplier: the products bought, how many, at what price, into which depot, and what was paid.
// Saving brings the stock in (one « Achat » movement per product) and, if asked, makes this price the products'
// purchase price. Opened from « Achats » (empty) or from « Alertes » (filled with what to reorder).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Field, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { bidi, MoneyInput, PickItem, ProductPicker, Stepper, useDepots } from './stockui';

export type PurchasePrefill = { supplierId?: number | null; warehouseId?: number; lines?: { variantId: number; qty: number; unitCost?: number }[] };
type Line = { variantId: number; label: string; sku: string; qty: number | ''; unitCost: number | '' };

export function PurchaseForm({ prefill, onClose }: { prefill?: PurchasePrefill; onClose: () => void }) {
  const { t } = useTranslation();
  const { depots, many } = useDepots();
  const sups = useRpc('suppliers.list', {});
  const prods = useRpc('catalog.products', {});
  const items: PickItem[] = useMemo(
    () =>
      (prods.data ?? [])
        .filter((p) => p.active && !p.isService)
        .flatMap((p) => p.variants.filter((v) => v.active).map((v) => ({ variantId: v.id, label: v.title ? `${p.name} ${v.title}` : p.name, sku: v.sku, cost: p.cost, note: t('produits.buy.lastCost', { price: da(p.cost) }) }))),
    [prods.data, t],
  );
  const byId = useMemo(() => new Map(items.map((it) => [it.variantId, it])), [items]);
  const [supplier, setSupplier] = useState<string>(prefill?.supplierId ? String(prefill.supplierId) : '');
  const [newSup, setNewSup] = useState({ name: '', phone: '' });
  const [wid, setWid] = useState<number | null>(prefill?.warehouseId ?? null);
  const [extra, setExtra] = useState<Line[] | null>(null);
  const [paid, setPaid] = useState<number | ''>(0);
  const [updateCost, setUpdateCost] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const create = useAction('purchases.create', { success: (r) => t('produits.buy.saved', { ref: bidi(r.ref), pieces: r.pieces, depot: bidi(r.warehouseName) }), onDone: onClose });

  // the lines start from the prefill once the product names are known
  const lines: Line[] =
    extra ??
    (prefill?.lines ?? [])
      .filter((l) => byId.has(l.variantId))
      .map((l) => {
        const it = byId.get(l.variantId)!;
        return { variantId: l.variantId, label: it.label, sku: it.sku, qty: l.qty, unitCost: l.unitCost ?? it.cost };
      });
  const setLines = (fn: (ls: Line[]) => Line[]) => setExtra(fn(lines));
  const depot = wid ?? depots[0]?.id ?? null;
  const total = lines.reduce((s, l) => s + (l.qty === '' ? 0 : l.qty) * (l.unitCost === '' ? 0 : l.unitCost), 0);
  const pieces = lines.reduce((s, l) => s + (l.qty === '' ? 0 : l.qty), 0);
  const paidV = paid === '' ? 0 : paid;
  const taken = new Set(lines.map((l) => l.variantId));

  const add = (it: PickItem) =>
    setLines((ls) => (ls.some((l) => l.variantId === it.variantId) ? ls.map((l) => (l.variantId === it.variantId ? { ...l, qty: (l.qty === '' ? 0 : l.qty) + 1 } : l)) : [...ls, { variantId: it.variantId, label: it.label, sku: it.sku, qty: 1, unitCost: it.cost }]));

  const submit = async () => {
    if (!depot) return;
    if (!lines.length) return toast(t('produits.buy.noLines'), 'bad');
    const bad = lines.find((l) => l.qty === '' || l.qty < 1 || l.unitCost === '');
    if (bad) return toast(t('produits.buy.badLine', { name: bad.label }), 'bad');
    if (paidV > total) return toast(t('produits.buy.paidTooMuch'), 'bad');
    let supplierId: number | null = supplier && supplier !== 'new' ? Number(supplier) : null;
    if (supplier === 'new') {
      if (!newSup.name.trim()) return toast(t('produits.sup.nameRequired'), 'bad');
      setBusy(true);
      try {
        supplierId = (await rpc('suppliers.save', { name: newSup.name.trim(), phone: newSup.phone.trim() })).id;
      } catch (e) {
        setBusy(false);
        return toast((e as Error).message, 'bad');
      }
      setBusy(false);
      setSupplier(String(supplierId));
    }
    create.mutate({ supplierId, warehouseId: depot, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty as number, unitCost: l.unitCost as number })), paid: paidV, updateCost, note: note.trim() });
  };

  return (
    <Modal
      title={t('produits.buy.title')}
      onClose={onClose}
      wide
      className="pd-sheet"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || create.isPending || !lines.length} onClick={submit}>
            <Icon name="check" />
            {t('produits.buy.save', { total: bidi(da(total)) })}
          </button>
        </>
      }
    >
      <div className="pd-form">
        <div className="pd-grid2">
          <Field label={t('produits.buy.supplier')}>
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">{t('produits.buy.noSupplier')}</option>
              {(sups.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="new">{t('produits.buy.newSupplier')}</option>
            </select>
          </Field>
          {many ? (
            <Field label={t('produits.buy.depot')}>
              <select value={depot ?? ''} onChange={(e) => setWid(Number(e.target.value))}>
                {depots.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label={t('produits.buy.depot')}>
              <input value={depots[0]?.name ?? ''} disabled />
            </Field>
          )}
        </div>
        {supplier === 'new' && (
          <div className="pd-grid2 pd-newsup">
            <Field label={t('produits.sup.name')}>
              <input value={newSup.name} maxLength={120} autoFocus onChange={(e) => setNewSup({ ...newSup, name: e.target.value })} />
            </Field>
            <Field label={t('produits.sup.phone')}>
              <input value={newSup.phone} maxLength={40} inputMode="tel" className="ltr" onChange={(e) => setNewSup({ ...newSup, phone: e.target.value })} />
            </Field>
          </div>
        )}

        <div className="pd-lines">
          <h3>{t('produits.buy.products')}</h3>
          <ProductPicker items={items} onPick={add} taken={taken} placeholder={t('produits.buy.addPh')} />
          {lines.length > 0 ? (
            <ul className="pd-lines-l">
              <li className="pd-line pd-line-h" aria-hidden="true">
                <span>{t('produits.stock.product')}</span>
                <span>{t('produits.buy.qty')}</span>
                <span>{t('produits.buy.unitCost')}</span>
                <span className="num">{t('produits.buy.amount')}</span>
                <span />
              </li>
              {lines.map((l) => (
                <li key={l.variantId} className="pd-line">
                  <span className="pd-name">
                    <b>{l.label}</b>
                    <small className="ltr">{l.sku}</small>
                  </span>
                  <label className="pd-in">
                    <small className="pd-lab">{t('produits.buy.qty')}</small>
                    <Stepper value={l.qty} min={1} label={t('produits.buy.qtyOf', { name: l.label })} onChange={(v) => setLines((ls) => ls.map((x) => (x.variantId === l.variantId ? { ...x, qty: v } : x)))} />
                  </label>
                  <label className="pd-in">
                    <small className="pd-lab">{t('produits.buy.unitCost')}</small>
                    <MoneyInput value={l.unitCost} label={t('produits.buy.unitCostOf', { name: l.label })} onChange={(v) => setLines((ls) => ls.map((x) => (x.variantId === l.variantId ? { ...x, unitCost: v } : x)))} />
                  </label>
                  <span className="pd-amount">
                    <small className="pd-lab">{t('produits.buy.amount')}</small>
                    <b className="ltr">{da((l.qty === '' ? 0 : l.qty) * (l.unitCost === '' ? 0 : l.unitCost))}</b>
                  </span>
                  <button type="button" className="icon-btn pd-x" aria-label={t('produits.buy.removeOf', { name: l.label })} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))}>
                    <Icon name="x" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pd-lines-empty">{t('produits.buy.empty')}</p>
          )}
        </div>

        <div className="pd-total">
          <span>
            <small>{t('produits.buy.total', { count: pieces })}</small>
            <b className="ltr">{da(total)}</b>
          </span>
          <label className="pd-in">
            <small className="pd-lab">{t('produits.buy.paidNow')}</small>
            <span className="pd-paid">
              <MoneyInput value={paid} label={t('produits.buy.paidNow')} onChange={setPaid} />
              <button type="button" className="btn small" disabled={!total} onClick={() => setPaid(total)}>
                {t('produits.buy.payAll')}
              </button>
            </span>
          </label>
          <span className={total - paidV > 0 ? 'due' : ''}>
            <small>{t('produits.buy.due')}</small>
            <b className="ltr">{da(Math.max(0, total - paidV))}</b>
          </span>
        </div>

        <label className="dl-switch">
          <input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} />
          <span>
            <b>{t('produits.buy.updateCost')}</b>
            <small>{t('produits.buy.updateCostHint')}</small>
          </span>
        </label>
        <Field label={t('produits.buy.note')}>
          <input value={note} maxLength={300} placeholder={t('produits.buy.notePh')} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {pieces > 0 && depot && <p className="pd-note">{t('produits.buy.willAdd', { count: pieces, depot: bidi(depots.find((d) => d.id === depot)?.name) })}</p>}
      </div>
    </Modal>
  );
}
