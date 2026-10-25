import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Field, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';

interface VRow {
  id?: number;
  title: string;
  sku: string;
  price: string;
  active: boolean;
}
interface PackRow {
  qty: string;
  price: string;
}
interface PartRow {
  name: string;
  max: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Create / edit a product: identity, prices, variants, SAV parts, packs, linked products, max discount, delivery price grid. */
/** onCreated: a NEW product was saved (Produits proposes its landing page). */
export function ProductForm({ id, onClose, onCreated }: { id: number | null; onClose: () => void; onCreated?: (p: { id: number; name: string; isService: boolean; active: boolean }) => void }) {
  const { t } = useTranslation();
  const cur = useRpc('catalog.product', { id: id ?? 0 }, { enabled: !!id });
  if (id && cur.isLoading) return <Modal title="…" onClose={onClose}><Loading /></Modal>;
  if (id && cur.error) return <Modal title="…" onClose={onClose}><ErrorBox error={cur.error} /></Modal>;
  return <Form p={id ? cur.data ?? null : null} onClose={onClose} onCreated={onCreated} key={id ?? 'new'} t={t} />;
}

function Form({ p, onClose, onCreated, t }: { p: any; onClose: () => void; onCreated?: (p: { id: number; name: string; isService: boolean; active: boolean }) => void; t: (k: string, o?: any) => string }) {
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const all = useRpc('catalog.products', {});
  const grids = useRpc('catalog.feeGrids', {});
  const [f, setF] = useState({
    name: p?.name ?? '',
    sku: p?.sku ?? '',
    price: String(p?.price ?? 0),
    cost: String(p?.cost ?? 0),
    weightKg: String(p?.weightKg ?? 1),
    photo: p?.photo ?? '',
    isService: !!p?.isService,
    active: p ? !!p.active : true,
    fixedPrice: !!p?.fixedPrice,
    maxDiscount: p ? (p.maxDiscount === null ? '' : String(p.maxDiscount)) : '0',
    feeGrid: p?.feeGrid ?? '',
  });
  const [vars, setVars] = useState<VRow[]>(() => (p?.variants ?? []).filter((v: any) => v.title !== '').map((v: any) => ({ id: v.id, title: v.title, sku: v.sku, price: v.price === null ? '' : String(v.price), active: v.active })));
  const [packs, setPacks] = useState<PackRow[]>(() => (p?.packs ?? []).map((x: any) => ({ qty: String(x.qty), price: String(x.price) })));
  const [hasParts, setHasParts] = useState((p?.parts ?? []).length > 0);
  const [parts, setParts] = useState<PartRow[]>(() => (p?.parts ?? []).map((x: any) => ({ name: x.name, max: x.max === null ? '' : String(x.max) })));
  const [linked, setLinked] = useState<Set<number>>(() => new Set(p?.linked ?? []));
  const [relQ, setRelQ] = useState('');
  useEffect(() => {
    if (hasParts && !parts.length) setParts([{ name: '', max: '' }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasParts]);
  const save = useAction('catalog.saveProduct', {
    success: t('produits.form.saved'),
    onDone: (r) => {
      onClose();
      if (!p) onCreated?.(r);
    },
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const others = (all.data ?? []).filter((x) => !x.isService && x.id !== p?.id);
  const q = norm(relQ);
  const relList = others.filter((x) => !q || norm(x.name).includes(q) || linked.has(x.id)).sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id))).slice(0, 80);

  const submit = () => {
    if (!f.name.trim()) return toast(t('produits.form.name'), 'bad');
    save.mutate({
      id: p?.id,
      name: f.name.trim(),
      sku: f.sku.trim() || null,
      price: Math.round(Number(f.price) || 0),
      cost: Math.round(Number(f.cost) || 0),
      weightKg: Number(f.weightKg) || 0,
      photo: f.photo.trim() || null,
      isService: f.isService,
      active: f.active,
      fixedPrice: f.fixedPrice,
      maxDiscount: f.maxDiscount === '' ? null : Math.max(0, Math.round(Number(f.maxDiscount) || 0)),
      feeGrid: f.feeGrid || null,
      variants: vars.filter((v) => v.title.trim() || v.id).map((v) => ({ id: v.id, title: v.title.trim(), sku: v.sku.trim() || null, price: v.price === '' ? null : Math.round(Number(v.price) || 0), active: v.active })),
      packs: packs.filter((x) => Number(x.qty) > 1 && Number(x.price) > 0).map((x) => ({ qty: Math.round(Number(x.qty)), price: Math.round(Number(x.price)) })),
      linked: [...linked],
      parts: hasParts ? parts.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), max: x.max === '' ? null : Math.round(Number(x.max)) || null })) : [],
    });
  };

  return (
    <Modal
      wide
      title={p ? t('produits.form.editTitle', { name: p.name }) : t('produits.form.newTitle')}
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
        <div className="grid2">
          <Field label={t('produits.form.name')}>
            <input required value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t('produits.form.sku')} hint={!p ? t('produits.form.skuAuto') : undefined}>
            <input className="ltr" value={f.sku} onChange={(e) => set('sku', e.target.value)} />
          </Field>
        </div>
        <div className="grid3">
          <Field label={t('produits.form.price')}>
            <input type="number" min={0} step={50} value={f.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
          <Field label={t('produits.form.cost')}>
            <input type="number" min={0} step={50} value={f.cost} onChange={(e) => set('cost', e.target.value)} />
          </Field>
          <Field label={t('produits.form.weight')}>
            <input type="number" min={0} step={0.1} value={f.weightKg} onChange={(e) => set('weightKg', e.target.value)} />
          </Field>
        </div>
        <Field label={t('produits.form.photo')}>
          <input className="ltr" placeholder="https://…" value={f.photo} onChange={(e) => set('photo', e.target.value)} />
        </Field>
        <div className="row" style={{ flexWrap: 'wrap', gap: 14, margin: '6px 0' }}>
          <label className="check">
            <input type="checkbox" checked={f.isService} onChange={(e) => set('isService', e.target.checked)} />
            {t('produits.form.isService')}
          </label>
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
            {t('produits.form.active')}
          </label>
          <label className="check">
            <input type="checkbox" checked={f.fixedPrice} onChange={(e) => set('fixedPrice', e.target.checked)} />
            {t('produits.form.fixedPrice')}
          </label>
        </div>

        <h3>{t('produits.form.variants')}</h3>
        <p className="muted small">{t('produits.form.variantsHelp')}</p>
        <div className="items-ed">
          {vars.map((v, i) => (
            <div key={v.id ?? `n${i}`} className="item-row bjpv-row">
              <input aria-label={t('produits.form.variants')} value={v.title} placeholder={t('produits.form.variantPh')} onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} />
              <input aria-label="SKU" className="ltr" value={v.sku} placeholder="SKU" onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, sku: e.target.value } : x)))} />
              <input type="number" min={0} step={50} aria-label={t('produits.form.variantPrice')} value={v.price} placeholder={t('produits.form.variantPrice')} onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))} />
              <label className="check">
                <input type="checkbox" checked={v.active} onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, active: e.target.checked } : x)))} />
                {t('produits.form.variantActive')}
              </label>
              {v.id ? (
                <span />
              ) : (
                <button type="button" className="icon-btn" aria-label={t('produits.form.remove')} onClick={() => setVars(vars.filter((_, k) => k !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <div>
            <button type="button" className="btn small" onClick={() => setVars([...vars, { title: '', sku: '', price: '', active: true }])}>
              {t('produits.form.addVariant')}
            </button>
          </div>
        </div>

        <h3>{t('produits.form.parts')}</h3>
        <Field label={t('produits.form.hasParts')}>
          <select value={hasParts ? 'yes' : 'no'} onChange={(e) => setHasParts(e.target.value === 'yes')}>
            <option value="no">{t('common.no')}</option>
            <option value="yes">{t('common.yes')}</option>
          </select>
        </Field>
        <p className="muted small">{t('produits.form.partsHelp')}</p>
        {hasParts && (
          <div className="items-ed">
            {parts.map((x, i) => (
              <div key={i} className="item-row bjpt-row">
                <input aria-label={t('produits.form.parts')} value={x.name} placeholder={t('produits.form.partPh')} onChange={(e) => setParts(parts.map((y, k) => (k === i ? { ...y, name: e.target.value } : y)))} />
                <input type="number" min={1} step={1} aria-label={t('produits.form.partMax')} value={x.max} placeholder={t('produits.form.partMax')} onChange={(e) => setParts(parts.map((y, k) => (k === i ? { ...y, max: e.target.value } : y)))} />
                <button type="button" className="icon-btn" aria-label={t('produits.form.remove')} onClick={() => setParts(parts.filter((_, k) => k !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="btn small" onClick={() => setParts([...parts, { name: '', max: '' }])}>
                {t('produits.form.addPart')}
              </button>
            </div>
          </div>
        )}

        <h3>{t('produits.form.upsell')}</h3>
        <p className="muted small">{t('produits.form.upsellHelp')}</p>
        <div className="items-ed">
          {packs.map((x, i) => (
            <div key={i} className="item-row bjpt-row">
              <label className="row small">
                <span className="muted">{t('produits.form.packQty')}</span>
                <input type="number" min={2} step={1} value={x.qty} placeholder="2" onChange={(e) => setPacks(packs.map((y, k) => (k === i ? { ...y, qty: e.target.value } : y)))} />
              </label>
              <label className="row small">
                <span className="muted">{t('produits.form.packPrice')}</span>
                <input type="number" min={0} step={50} value={x.price} placeholder="18000" onChange={(e) => setPacks(packs.map((y, k) => (k === i ? { ...y, price: e.target.value } : y)))} />
              </label>
              <button type="button" className="icon-btn" aria-label={t('produits.form.remove')} onClick={() => setPacks(packs.filter((_, k) => k !== i))}>
                ✕
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn small" onClick={() => setPacks([...packs, { qty: String(packs.length ? Math.max(...packs.map((y) => Number(y.qty) || 1)) + 1 : 2), price: '' }])}>
              {t('produits.form.addPack')}
            </button>
          </div>
        </div>
        <Field label={t('produits.form.linked')}>
          <input type="search" placeholder={t('produits.form.linkedPh')} value={relQ} onChange={(e) => setRelQ(e.target.value)} />
        </Field>
        <div className="qd2-rel">
          {relList.map((x) => (
            <label key={x.id} className="check">
              <input
                type="checkbox"
                checked={linked.has(x.id)}
                onChange={(e) => {
                  const s = new Set(linked);
                  e.target.checked ? s.add(x.id) : s.delete(x.id);
                  setLinked(s);
                }}
              />
              {x.name}
              {!x.active && <small className="muted"> {t('produits.form.inactive')}</small>}
            </label>
          ))}
        </div>

        <h3>{t('produits.form.pricing')}</h3>
        <div className="grid2">
          <Field label={t('produits.form.maxDiscount')} hint={t('produits.form.maxDiscountHint')}>
            <input type="number" min={0} step={50} disabled={!admin} value={f.maxDiscount} onChange={(e) => set('maxDiscount', e.target.value)} />
          </Field>
          <Field label={t('produits.form.feeGrid')} hint={t('produits.form.feeGridHint')}>
            <select value={f.feeGrid} onChange={(e) => set('feeGrid', e.target.value)}>
              <option value="">{grids.data?.defaultGrid ? `— ${grids.data.defaultGrid} —` : '—'}</option>
              {grids.data?.grids.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              {f.feeGrid && !grids.data?.grids.includes(f.feeGrid) && <option value={f.feeGrid}>{f.feeGrid}</option>}
            </select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}
