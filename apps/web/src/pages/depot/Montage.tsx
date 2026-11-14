// Montage on a product: a switch, its price and cost, and where it is done (the shop's list, or this product's own
// wilayas). One « Montage » service for the whole shop: no service product per product.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WILAYAS } from '@pilotix/shared';
import { useAction, useRpc } from '../../lib/query';
import { wilaya } from '../../lib/format';
import { Modal } from '../../ui/modal';

export interface MontageForm { on: boolean; price: string; cost: string; own: boolean; wilayas: number[] }

export const montageForm = (m: { price: number; cost: number; wilayas: number[] | null } | null | undefined): MontageForm =>
  m ? { on: true, price: String(m.price), cost: String(m.cost), own: m.wilayas !== null, wilayas: m.wilayas ?? [] } : { on: false, price: '', cost: '', own: false, wilayas: [] };

export const montageInput = (m: MontageForm) =>
  m.on ? { price: Math.max(0, Math.round(Number(m.price) || 0)), cost: Math.max(0, Math.round(Number(m.cost) || 0)), wilayas: m.own ? m.wilayas : null } : null;

/** Every wilaya, ticked or not, with a search. */
export function WilayaPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const on = new Set(value);
  const all = WILAYAS.map((_, i) => i + 1);
  const shown = all.filter((id) => !q.trim() || wilaya(id).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="mt-pick">
      <div className="mt-pick-bar">
        <input placeholder={t('produits.montage.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn small" onClick={() => onChange(all)}>{t('produits.montage.all')}</button>
        <button type="button" className="btn small" onClick={() => onChange([])}>{t('produits.montage.none')}</button>
        <span className="muted small">{t('produits.montage.count', { n: value.length })}</span>
      </div>
      <div className="mt-grid">
        {shown.map((id) => (
          <label key={id} className={on.has(id) ? 'mt-w on' : 'mt-w'}>
            <input type="checkbox" checked={on.has(id)} onChange={(e) => onChange(e.target.checked ? [...value, id].sort((a, b) => a - b) : value.filter((x) => x !== id))} />
            {wilaya(id)}
          </label>
        ))}
      </div>
    </div>
  );
}

/** The shop's list (Réglages of montage): the wilayas where products « liste de la boutique » are mounted. */
function ShopListModal({ list, onClose }: { list: number[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(list);
  const save = useAction('catalog.saveMontage', { success: t('produits.montage.shopSaved'), onDone: onClose });
  return (
    <Modal
      title={t('produits.montage.shopTitle')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('produits.montage.cancel')}</button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ wilayas: v })}>{t('produits.montage.save')}</button>
        </>
      }
    >
      <p className="muted small">{t('produits.montage.shopHelp')}</p>
      <WilayaPicker value={v} onChange={setV} />
    </Modal>
  );
}

export function MontageBlock({ value: m, onChange, disabled }: { value: MontageForm; onChange: (m: MontageForm) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const shop = useRpc('catalog.montage', {});
  const [editShop, setEditShop] = useState(false);
  const list = shop.data?.wilayas ?? [];
  const set = (x: Partial<MontageForm>) => onChange({ ...m, ...x });
  return (
    <section className="pf-sec mt-sec">
      <label className="mt-switch">
        <input type="checkbox" checked={m.on} disabled={disabled} onChange={(e) => set({ on: e.target.checked })} />
        <span>
          <b>{t('produits.montage.title')}</b>
          <small className="muted">{t('produits.montage.help')}</small>
        </span>
      </label>
      {m.on && (
        <>
          <div className="mt-prices">
            <label className="field">
              <span>{t('produits.montage.price')}</span>
              <input type="number" min={0} step={50} value={m.price} onChange={(e) => set({ price: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('produits.montage.cost')}</span>
              <input type="number" min={0} step={50} value={m.cost} onChange={(e) => set({ cost: e.target.value })} />
            </label>
          </div>
          <div className="mt-where">
            <label className="mt-radio">
              <input type="radio" checked={!m.own} onChange={() => set({ own: false })} />
              <span>
                {t('produits.montage.shopList')} <span className="muted small">— {list.length ? t('produits.montage.count', { n: list.length }) : t('produits.montage.everywhere')}</span>
              </span>
              <button type="button" className="btn small" onClick={() => setEditShop(true)}>{t('produits.montage.editShop')}</button>
            </label>
            <label className="mt-radio">
              <input type="radio" checked={m.own} onChange={() => set({ own: true, wilayas: m.wilayas.length ? m.wilayas : list })} />
              <span>{t('produits.montage.ownList')}</span>
            </label>
            {m.own && <WilayaPicker value={m.wilayas} onChange={(w) => set({ wilayas: w })} />}
            {m.own && !m.wilayas.length && <p className="pf-warn">⚠ {t('produits.montage.ownEmpty')}</p>}
          </div>
        </>
      )}
      {editShop && <ShopListModal list={list} onClose={() => setEditShop(false)} />}
    </section>
  );
}
