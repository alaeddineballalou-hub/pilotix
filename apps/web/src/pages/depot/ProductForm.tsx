import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pageIsOn } from '../../lib/features';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { da, pct } from '../../lib/format';
import { ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { ConfirmButton } from '../admin/bits';
import { bidi } from './stockui';
import { combosOf, MAX_COMBOS, Opt, skuOf, titleOf, VariantOptions, VRow } from './VariantOptions';

interface PackRow {
  qty: string;
  price: string;
}
interface PartRow {
  name: string;
  max: string;
}
interface ServiceRow { id?: number; name: string; price: string; cost: string; }

/** a field the form cannot be saved without */
const Req = ({ children }: { children: ReactNode }) => (
  <>
    {children} <b className="pf-req">*</b>
  </>
);

/** A picked photo becomes a small WebP (or JPEG) thumbnail kept with the product: 320 px is enough for lists and orders. */
async function thumb(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 320 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const webp = c.toDataURL('image/webp', 0.75);
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.75);
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Create / edit a product, in the sections of the « Nouveau produit » screen: basic information, prices & margin (with the
 *  maximum discount), stock & logistics, options (variants), images, then SAV parts, packs and linked products. */
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
    price: p ? String(p.price) : '',
    cost: p ? String(p.cost) : '',
    weightKg: String(p?.weightKg ?? 1),
    photo: p?.photo ?? '',
    isService: !!p?.isService,
    active: p ? !!p.active : true,
    fixedPrice: !!p?.fixedPrice,
    maxDiscount: p ? (p.maxDiscount === null ? '' : String(p.maxDiscount)) : '',
    feeGrid: p?.feeGrid ?? '',
    barcode: p?.barcode ?? '',
    brand: p?.brand ?? '',
    externalId: p?.externalId ?? '',
    pageUrl: p?.pageUrl ?? '',
    sellerId: p?.sellerId ? String(p.sellerId) : '',
    description: p?.description ?? '',
    alertQty: String(p?.alertQty ?? 0),
    defaultCompanyId: p?.defaultCompanyId ? String(p.defaultCompanyId) : '',
  });
  const [vars, setVars] = useState<VRow[]>(() => (p?.variants ?? []).filter((v: any) => v.title !== '').map((v: any) => ({ id: v.id, title: v.title, sku: v.sku, price: v.price === null ? '' : String(v.price), cost: v.cost == null ? '' : String(v.cost), maxDiscount: v.maxDiscount == null ? '' : String(v.maxDiscount), weightKg: v.weightKg == null ? '' : String(v.weightKg), alertQty: v.alertQty == null ? '' : String(v.alertQty), feeGrid: v.feeGrid ?? '', photo: v.photo ?? '', active: v.active })));
  // Options (Taille, Couleur, Fille / Garçon…): the variants are made from them. A product made before, with variants typed
  // one by one, keeps that list until « Organiser en options » is chosen.
  const [opts, setOpts] = useState<Opt[]>(() => (p?.options ?? []).map((o: Opt) => ({ name: o.name, values: [...o.values] })));
  const [optMode, setOptMode] = useState<boolean>(() => !p || (p.options ?? []).length > 0 || !(p.variants ?? []).some((v: any) => v.title !== ''));
  const variantPricing = (optMode && combosOf(opts).length > 0) || (!optMode && vars.length > 0);
  // combinations of the saved options that are not variants: they were unticked when the product was saved
  const [skipped] = useState<Set<string>>(() => {
    const saved = new Set<string>((p?.variants ?? []).map((v: any) => String(v.title).trim().toLowerCase()));
    return new Set(combosOf(p?.options ?? []).map((c) => titleOf(c).toLowerCase()).filter((x) => !saved.has(x)));
  });
  const [packs, setPacks] = useState<PackRow[]>(() => (p?.packs ?? []).map((x: any) => ({ qty: String(x.qty), price: String(x.price) })));
  const [services, setServices] = useState<ServiceRow[]>(() => (p?.services ?? []).map((s: any) => ({ id: s.id, name: s.name, price: String(s.price), cost: String(s.cost) })));
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
  // Archiver (administrators): out of the lists, kept for the orders; deleted later from Management › Archives
  const archive = useAction('archive.set', { success: (r) => (r.done ? t('produits.form.archived') : t('produits.form.archiveStock')), onDone: (r) => r.done && onClose() });
  const canArchive = !!p && admin && pageIsOn('management', 'archive');
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const brands = [...new Set((all.data ?? []).map((x) => x.brand).filter((x): x is string => !!x))].sort();
  const others = (all.data ?? []).filter((x) => !x.isService && x.id !== p?.id);
  const q = norm(relQ);
  const relList = others.filter((x) => !q || norm(x.name).includes(q) || linked.has(x.id)).sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id))).slice(0, 80);
  /** values the shop already uses for each option name (Couleur → Noir, Rose…), offered as suggestions */
  const usedValues = new Map<string, string[]>();
  for (const x of others)
    for (const o of ((x as any).options ?? []) as Opt[]) {
      const k = o.name.trim().toLowerCase();
      usedValues.set(k, [...new Set([...(usedValues.get(k) ?? []), ...o.values])]);
    }

  const submit = () => {
    if (!f.name.trim()) return toast(t('produits.form.needName'), 'bad');
    if (f.price === '' || f.cost === '' || (!variantPricing && f.alertQty === '')) return toast(t('produits.form.needRequired'), 'bad');
    const combos = optMode ? combosOf(opts) : [];
    if (optMode && opts.some((o) => !o.name.trim() && o.values.length)) return toast(t('produits.form.opt.needName'), 'bad');
    if (combos.length > MAX_COMBOS) return toast(t('produits.form.opt.tooMany', { count: combos.length }), 'bad');
    const price = (_v: VRow) => null;
    const cost = (_v: VRow) => null;
    const maxDiscount = (_v: VRow) => null;
    const weightKg = (v: VRow) => v.weightKg === '' ? null : Number(v.weightKg);
    const alertQty = (v: VRow) => v.alertQty === '' ? null : Math.round(Number(v.alertQty));
    const feeGrid = (v: VRow) => v.feeGrid || null;
    const photo = (_v: VRow) => null;
    const base = f.sku.trim() || f.name.trim();
    const want = new Set(combos.map((c) => titleOf(c).toLowerCase()));
    const variants = optMode
      ? [
          // one per combination: a new one only when ticked; one already saved keeps its id (and is switched off when unticked)
          ...combos.flatMap((c) => {
            const v = vars.find((x) => x.title.trim().toLowerCase() === titleOf(c).toLowerCase());
            return v && (v.id || v.active) ? [{ id: v.id, title: titleOf(c), sku: v.sku.trim() || (v.id ? null : skuOf(base, c)), price: price(v), cost: cost(v), maxDiscount: maxDiscount(v), weightKg: weightKg(v), alertQty: alertQty(v), feeGrid: feeGrid(v), photo: photo(v), active: v.active }] : [];
          }),
          ...vars.filter((v) => v.id && !want.has(v.title.trim().toLowerCase())).map((v) => ({ id: v.id, title: v.title.trim(), sku: v.sku.trim() || null, price: price(v), cost: cost(v), maxDiscount: maxDiscount(v), weightKg: weightKg(v), alertQty: alertQty(v), feeGrid: feeGrid(v), photo: photo(v), active: v.active })),
        ]
      : vars.filter((v) => v.title.trim() || v.id).map((v) => ({ id: v.id, title: v.title.trim(), sku: v.sku.trim() || null, price: price(v), cost: cost(v), maxDiscount: maxDiscount(v), weightKg: weightKg(v), alertQty: alertQty(v), feeGrid: feeGrid(v), photo: photo(v), active: v.active }));
    // Prices, discount and picture are product-level fields. Legacy variant overrides
    // are cleared only after an explicit confirmation to avoid silent repricing.
    if (p && vars.some((v) => v.price !== '' || v.cost !== '' || v.maxDiscount !== '' || v.photo !== '')) {
      if (!window.confirm('Existing variant-specific prices, discounts and photos will be replaced by the product values. Continue?')) return;
    }
    if (services.some((s) => !s.name.trim() || s.price === '' || s.cost === '')) return toast('Enter a name, selling price and service cost for each additional service.', 'bad');
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
      barcode: f.barcode.trim() || null,
      brand: f.brand.trim() || null,
      externalId: f.externalId.trim() || null,
      pageUrl: f.pageUrl.trim() || null,
      sellerId: f.sellerId ? Number(f.sellerId) : null,
      description: f.description.trim() || null,
      alertQty: Math.max(0, Math.round(Number(f.alertQty) || 0)),
      defaultCompanyId: f.defaultCompanyId ? Number(f.defaultCompanyId) : null,
      variants,
      options: optMode ? opts.filter((o) => o.name.trim() && o.values.length).map((o) => ({ name: o.name.trim(), values: o.values })) : undefined,
      packs: packs.filter((x) => Number(x.qty) > 1 && Number(x.price) > 0).map((x) => ({ qty: Math.round(Number(x.qty)), price: Math.round(Number(x.price)) })),
      linked: [...linked],
      parts: hasParts ? parts.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), max: x.max === '' ? null : Math.round(Number(x.max)) || null })) : [],
      services: services.map((x) => ({ id: x.id, name: x.name.trim(), price: Math.round(Number(x.price)), cost: Math.round(Number(x.cost)) })),
    });
  };

  return (
    <Modal
      wide
      className="pf-modal"
      title={p ? t('produits.form.editTitle', { name: p.name }) : t('produits.form.newTitle')}
      onClose={onClose}
      footer={
        <>
          {canArchive && (
            <ConfirmButton className="btn ghost" disabled={archive.isPending} question={t('produits.form.archiveAsk')} onConfirm={() => archive.mutate({ kind: 'products', ids: [p.id], archived: true })}>
              <Icon name="archive" /> {t('produits.form.archive')}
            </ConfirmButton>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={submit}>
            {p ? t('common.save') : t('produits.form.create')}
          </button>
        </>
      }
    >
      <form
        className="pf"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <section className="pf-sec">
          <h3>{t('produits.form.basic')}</h3>
          <div className="pf-grid4">
            <Field label={<Req>{t('produits.form.name')}</Req>}>
              <input required value={f.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label={t('produits.form.sku')} hint={!p ? t('produits.form.skuAuto') : undefined}>
              <input className="ltr" value={f.sku} onChange={(e) => set('sku', e.target.value)} />
            </Field>
            <Field label={t('produits.form.barcode')}>
              <input className="ltr" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} />
            </Field>
            <Field label={t('produits.form.brand')}>
              <input list="pf-brands" value={f.brand} placeholder={t('produits.form.brandPh')} onChange={(e) => set('brand', e.target.value)} />
              <datalist id="pf-brands">
                {brands.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
            <Field label={t('produits.form.externalId')}>
              <input className="ltr" value={f.externalId} onChange={(e) => set('externalId', e.target.value)} />
            </Field>
            <Field label={t('produits.form.pageUrl')}>
              <input className="ltr" placeholder="https://…" value={f.pageUrl} onChange={(e) => set('pageUrl', e.target.value)} />
            </Field>
            <Field label={t('produits.form.seller')}>
              <select value={f.sellerId} onChange={(e) => set('sellerId', e.target.value)}>
                <option value="">{t('produits.form.sellerPh')}</option>
                {grids.data?.sellers.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('produits.form.description')}>
            <textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </section>

        <div className="pf-two">
          <section className="pf-sec">
            <h3>{t('produits.form.pricing')}</h3>
            <div className="grid2">
              <Field label={<Req>{t('produits.form.cost')}</Req>}>
                <input type="number" min={0} step={50} value={f.cost} onChange={(e) => set('cost', e.target.value)} />
              </Field>
              <Field label={<Req>{t('produits.form.price')}</Req>}>
                <input type="number" min={0} step={50} value={f.price} onChange={(e) => set('price', e.target.value)} />
              </Field>
            </div>
            {!f.isService && !(Number(f.cost) > 0) && <p className="pf-warn">⚠ {t('produits.form.noCost')}</p>}
            {Number(f.price) > 0 && Number(f.cost) > 0 && (
              <p className={`pf-margin ${Number(f.price) - Number(f.cost) < 0 ? 'bad' : ''}`}>
                {t('produits.form.marginIs', { m: bidi(da(Number(f.price) - Number(f.cost))), r: bidi(pct((Number(f.price) - Number(f.cost)) / Number(f.price))) })}
              </p>
            )}
            <Field
              label={
                <>
                  {t('produits.form.maxDiscount')}
                  {!admin && <Icon name="lock" className="pd-lock" />}
                </>
              }
              hint={f.maxDiscount === '' ? t('produits.form.maxDiscountHint') : t('produits.prices.floor', { price: bidi(da(Math.max(0, (Number(f.price) || 0) - (Number(f.maxDiscount) || 0)))) })}
            >
              <input type="number" min={0} step={50} disabled={!admin} placeholder={t('produits.prices.noLimit')} value={f.maxDiscount} onChange={(e) => set('maxDiscount', e.target.value)} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={f.fixedPrice} onChange={(e) => set('fixedPrice', e.target.checked)} />
              {t('produits.form.fixedPrice')}
            </label>
          </section>

          <section className="pf-sec">
            <h3>{variantPricing ? 'Shared product settings' : t('produits.form.logistics')}</h3>
            <div className="grid2">
              {!variantPricing && <><Field label={<Req>{t('produits.form.alertQty')}</Req>} hint={t('produits.form.alertQtyHint')}>
                <input type="number" min={0} step={1} disabled={f.isService} value={f.alertQty} onChange={(e) => set('alertQty', e.target.value)} />
              </Field>
              <Field label={t('produits.form.weight')}>
                <input type="number" min={0} step={0.1} value={f.weightKg} onChange={(e) => set('weightKg', e.target.value)} />
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
              </>}
              <Field label={t('produits.form.company')}>
                <select value={f.defaultCompanyId} onChange={(e) => set('defaultCompanyId', e.target.value)}>
                  <option value="">{t('produits.form.companyPh')}</option>
                  {grids.data?.companies.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="pf-checks">
              <label className="check">
                <input type="checkbox" checked={f.isService} onChange={(e) => set('isService', e.target.checked)} />
                {t('produits.form.isService')}
              </label>
              <label className="check">
                <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
                {t('produits.form.active')}
              </label>
            </div>
          </section>
        </div>

        <section className="pf-sec">
          <div className="pf-head">
            <h3>{t('produits.form.variants')}</h3>
            {!optMode && (
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn small" onClick={() => setOptMode(true)}>
                  <Icon name="layers" />
                  {t('produits.form.opt.organize')}
                </button>
                <button type="button" className="btn small primary" onClick={() => setVars([...vars, { title: '', sku: '', price: '', cost: '', maxDiscount: '', weightKg: '', alertQty: '', feeGrid: '', photo: '', active: true }])}>
                  <Icon name="plus" />
                  {t('produits.form.addVariant')}
                </button>
              </div>
            )}
          </div>
          {optMode ? (
            <VariantOptions opts={opts} setOpts={setOpts} vars={vars} setVars={setVars} basePrice={Number(f.price) || 0} baseCost={Number(f.cost) || 0} baseSku={f.sku.trim() || f.name.trim()} used={usedValues} skipped={skipped} admin={admin} feeGrids={grids.data?.grids ?? []} />
          ) : (
            <>
              {vars.length ? (
                <div className="items-ed">
                  {vars.map((v, i) => (
                    <div key={v.id ?? `n${i}`} className="item-row bjpv-row">
                      <input aria-label={t('produits.form.variants')} value={v.title} placeholder={t('produits.form.variantPh')} onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} />
                      <span className="muted small">Product pricing &amp; photo apply</span>
                      <input type="number" min={0} step={0.1} aria-label="Weight" value={v.weightKg} placeholder="Weight (kg)" onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, weightKg: e.target.value } : x)))} />
                      <input type="number" min={0} step={1} aria-label="Minimum stock" value={v.alertQty} placeholder="Minimum stock" onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, alertQty: e.target.value } : x)))} />
                      <select aria-label="Delivery grid" value={v.feeGrid} onChange={(e) => setVars(vars.map((x, k) => (k === i ? { ...x, feeGrid: e.target.value } : x)))}><option value="">Product default</option>{(grids.data?.grids ?? []).map((g) => <option key={g} value={g}>{g}</option>)}</select>
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
                </div>
              ) : (
                <p className="pf-empty">
                  <Icon name="package" />
                  {t('produits.form.noVariants')}
                </p>
              )}
              <p className="muted small">{t('produits.form.variantsHelp')}</p>
            </>
          )}
        </section>

        <section className="pf-sec">
          <h3>{t('produits.form.images')}</h3>
          <div className="pf-img">
            <span className="pf-thumb" aria-hidden="true">
              {f.photo ? <img src={f.photo} alt="" /> : <Icon name="package" />}
            </span>
            <div className="pf-img-f">
              <input
                type="file"
                accept="image/*"
                aria-label={t('produits.form.photoFile')}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    set('photo', await thumb(file));
                  } catch {
                    toast(t('produits.form.photoBad'), 'bad');
                  }
                }}
              />
              <input className="ltr" placeholder={t('produits.form.photoPh')} value={f.photo.startsWith('data:') ? '' : f.photo} onChange={(e) => set('photo', e.target.value)} />
              {f.photo && (
                <button type="button" className="btn small ghost" onClick={() => set('photo', '')}>
                  {t('produits.form.photoRemove')}
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="pf-sec">
        <h3>Additional paid services</h3>
        <p className="muted small">Optional add-ons such as Montage are offered in new orders as linked services. They have a selling price and a service cost and do not consume physical stock.</p>
        <div className="items-ed">
          {services.map((sv, index) => (
            <div key={sv.id ?? `new-${index}`} className="item-row bjpt-row">
              <input aria-label="Service name" placeholder="Montage" value={sv.name} onChange={(e) => setServices((old) => old.map((x, k) => k === index ? { ...x, name: e.target.value } : x))} />
              <input aria-label="Service selling price (DA)" type="number" min={0} step={50} placeholder="Selling price (DA)" value={sv.price} onChange={(e) => setServices((old) => old.map((x, k) => k === index ? { ...x, price: e.target.value } : x))} />
              <input aria-label="Service cost (DA)" type="number" min={0} step={50} placeholder="Service cost (DA)" value={sv.cost} onChange={(e) => setServices((old) => old.map((x, k) => k === index ? { ...x, cost: e.target.value } : x))} />
              <button type="button" className="icon-btn" aria-label="Remove service" onClick={() => setServices((old) => old.filter((_, k) => k !== index))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => setServices((old) => [...old, { name: '', price: '', cost: '' }])}>+ Add paid service</button>
        </div>
        </section>

        <section className="pf-sec">
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

        </section>

        <details className="pf-sec pf-more" open={services.length > 0 || (!!p && (packs.length > 0 || hasParts || linked.size > 0))}>
          <summary>{t('produits.form.more')}</summary>
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
          <input type="search" aria-label={t('produits.form.linkedPh')} placeholder={t('produits.form.linkedPh')} value={relQ} onChange={(e) => setRelQ(e.target.value)} />
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

        </details>
      </form>
    </Modal>
  );
}
