// Product form › Options: the product's options (Taille, Couleur, Fille / Garçon…) and their values; Pilotix makes one
// variant per combination (« 12P / ROSE / Fille »), each with its SKU, price and on/off. Variants already made that do
// not follow the options stay listed (orders and stock may use them): they are switched off, never deleted.
import { KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da } from '../../lib/format';
import { Icon } from '../../ui/kit';
import { bidi } from './stockui';

export interface VRow {
  id?: number;
  title: string;
  sku: string;
  price: string;
  cost: string;
  maxDiscount: string;
  weightKg: string;
  alertQty: string;
  feeGrid: string;
  active: boolean;
}
export interface Opt {
  name: string;
  values: string[];
}

export const SEP = ' / ';
export const MAX_COMBOS = 200;
const low = (s: string) => s.trim().toLowerCase();
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const slugU = (s: string) =>
  strip(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Every combination of the values, in the options' order: Taille × Couleur × Genre. */
export function combosOf(opts: Opt[]): string[][] {
  const used = opts.filter((o) => o.name.trim() && o.values.length);
  if (!used.length) return [];
  return used.reduce<string[][]>((acc, o) => acc.flatMap((c) => o.values.map((v) => [...c, v])), [[]]);
}
export const titleOf = (c: string[]) => c.join(SEP);
/** A readable SKU for a new variant: the product's SKU (or name) + the values. */
export const skuOf = (base: string, c: string[]) => [slugU(base).slice(0, 24), ...c.map(slugU)].filter(Boolean).join('-');

/**
 * The variant rows after the options changed: one per combination (new ones added), the variants already saved kept.
 * `skipped`: combinations the product was saved without (unticked on purpose): they come back unticked.
 */
export function reconcile(prev: VRow[], opts: Opt[], skipped: Set<string> = new Set()): VRow[] {
  const combos = combosOf(opts);
  const want = new Set(combos.map((c) => low(titleOf(c))));
  const keep = prev.filter((v) => v.id || want.has(low(v.title)));
  const have = new Set(keep.map((v) => low(v.title)));
  const add = combos.filter((c) => !have.has(low(titleOf(c)))).map((c) => ({ title: titleOf(c), sku: '', price: '', cost: '', maxDiscount: '', weightKg: '', alertQty: '', feeGrid: '', active: !skipped.has(low(titleOf(c))) }));
  return add.length || keep.length !== prev.length ? [...keep, ...add] : prev;
}

const NAMES = ['Taille', 'Couleur', 'Genre', 'Modèle', 'Pointure', 'Âge', 'Matière'];
const PRESET: [RegExp, string[]][] = [
  [/couleur|color|لون/i, ['Noir', 'Blanc', 'Rouge', 'Bleu', 'Rose', 'Vert', 'Gris', 'Beige', 'Mauve', 'Jaune', 'Orange', 'Marron', 'Bleu ciel', 'Bleu nuit']],
  [/taille|size|مقاس/i, ['12P', '14P', '16P', '20P', '24P', '26P', 'S', 'M', 'L', 'XL']],
  [/genre|sexe|fille|garcon|garçon/i, ['Fille', 'Garçon', 'Mixte']],
  [/age|âge/i, ['0-6 mois', '6-12 mois', '1-3 ans', '3-5 ans', '5-8 ans']],
];

function ValuesInput({ opt, onChange, suggestions }: { opt: Opt; onChange: (values: string[]) => void; suggestions: string[] }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(/[,;\n]+/)
      .map((x) => x.replace(/\//g, '-').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const next = [...opt.values];
    for (const x of parts) if (!next.some((y) => low(y) === low(x))) next.push(x.slice(0, 60));
    if (next.length !== opt.values.length) onChange(next);
    setText('');
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim())) && text.trim()) {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Enter') e.preventDefault();
    else if (e.key === 'Backspace' && !text && opt.values.length) onChange(opt.values.slice(0, -1));
  };
  const left = suggestions.filter((s) => !opt.values.some((v) => low(v) === low(s))).slice(0, 14);
  return (
    <>
      <div className="po-vals">
        {opt.values.map((v) => (
          <span key={v} className="po-chip">
            {v}
            <button type="button" aria-label={`${t('produits.form.opt.removeValue')} ${v}`} onClick={() => onChange(opt.values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          value={text}
          aria-label={t('produits.form.opt.valuesPh')}
          placeholder={opt.values.length ? t('produits.form.opt.valuesMore') : t('produits.form.opt.valuesPh')}
          onChange={(e) => (/[,;]/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
          onKeyDown={key}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {left.length > 0 && (
        <div className="po-sugg">
          <span className="muted small">{t('produits.form.opt.suggest')}</span>
          {left.map((s) => (
            <button key={s} type="button" onClick={() => onChange([...opt.values, s])}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function VariantOptions({
  opts,
  setOpts,
  vars,
  setVars,
  basePrice,
  baseSku,
  used,
  skipped,
  admin,
  feeGrids,
}: {
  opts: Opt[];
  setOpts: (o: Opt[]) => void;
  vars: VRow[];
  setVars: (fn: (v: VRow[]) => VRow[]) => void;
  basePrice: number;
  baseSku: string;
  /** values already used by the shop's other products, by option name (suggestions) */
  used: Map<string, string[]>;
  /** combinations the saved product does not have (unticked when it was saved) */
  skipped: Set<string>;
  admin: boolean;
  feeGrids: string[];
}) {
  const { t } = useTranslation();
  const combos = useMemo(() => combosOf(opts), [opts]);
  const key = JSON.stringify(opts);
  useEffect(() => {
    if (combos.length <= MAX_COMBOS) setVars((prev) => reconcile(prev, opts, skipped));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const byTitle = new Map(vars.map((v) => [low(v.title), v]));
  const want = new Set(combos.map((c) => low(titleOf(c))));
  const others = vars.filter((v) => v.id && v.title && !want.has(low(v.title)));
  const editRow = (title: string, patch: Partial<VRow>) => setVars((prev) => prev.map((v) => (low(v.title) === low(title) ? { ...v, ...patch } : v)));
  const setOpt = (k: number, o: Opt) => setOpts(opts.map((x, i) => (i === k ? o : x)));
  const names = new Set(opts.map((o) => low(o.name)));
  const addOpt = (o: Opt) => setOpts([...opts, o]);
  const sugg = (name: string) => {
    const preset = PRESET.find(([re]) => re.test(name))?.[1] ?? [];
    const mine = used.get(low(name)) ?? [];
    return [...new Set([...mine, ...preset])];
  };
  // « Mettre le prix … » for all variants, or those with one value (e.g. every 16P)
  const [bulkOn, setBulkOn] = useState('*');
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkField, setBulkField] = useState<'price' | 'cost' | 'maxDiscount' | 'weightKg' | 'alertQty' | 'feeGrid'>('price');
  const applyBulk = () => {
    if (bulkPrice === '' || (bulkField !== 'feeGrid' && (!Number.isFinite(Number(bulkPrice)) || Number(bulkPrice) < 0))) return;
    const [k, v] = bulkOn === '*' ? [-1, ''] : [Number(bulkOn.split('|')[0]), bulkOn.slice(bulkOn.indexOf('|') + 1)];
    const hit = new Set(combos.filter((c) => k < 0 || low(c[k]) === low(v)).map((c) => low(titleOf(c))));
    setVars((prev) => prev.map((x) => (hit.has(low(x.title)) ? { ...x, [bulkField]: bulkPrice } : x)));
  };
  const usedOpts = opts.filter((o) => o.name.trim() && o.values.length);
  const activeCount = combos.filter((c) => byTitle.get(low(titleOf(c)))?.active).length;

  return (
    <>
      <p className="muted small po-help">{t('produits.form.opt.help')}</p>
      {opts.map((o, k) => (
        <div key={k} className="po-opt">
          <div className="po-name">
            <span className="po-num">{k + 1}</span>
            <input list="po-names" value={o.name} aria-label={t('produits.form.opt.name')} placeholder={t('produits.form.opt.namePh')} onChange={(e) => setOpt(k, { ...o, name: e.target.value })} />
          </div>
          <div className="po-body">
            <ValuesInput opt={o} onChange={(values) => setOpt(k, { ...o, values })} suggestions={sugg(o.name)} />
          </div>
          <button type="button" className="icon-btn" title={t('produits.form.opt.remove')} aria-label={t('produits.form.opt.remove')} onClick={() => setOpts(opts.filter((_, i) => i !== k))}>
            ✕
          </button>
        </div>
      ))}
      <datalist id="po-names">
        {NAMES.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {opts.length < 3 && (
        <div className="po-add">
          <span className="muted small">{opts.length ? t('produits.form.opt.addAnother') : t('produits.form.opt.addFirst')}</span>
          {!names.has(low(t('produits.form.opt.size'))) && (
            <button type="button" className="btn small" onClick={() => addOpt({ name: t('produits.form.opt.size'), values: [] })}>
              <Icon name="plus" /> {t('produits.form.opt.size')}
            </button>
          )}
          {!names.has(low(t('produits.form.opt.color'))) && (
            <button type="button" className="btn small" onClick={() => addOpt({ name: t('produits.form.opt.color'), values: [] })}>
              <Icon name="plus" /> {t('produits.form.opt.color')}
            </button>
          )}
          {!names.has(low(t('produits.form.opt.gender'))) && (
            <button type="button" className="btn small" onClick={() => addOpt({ name: t('produits.form.opt.gender'), values: [t('produits.form.opt.girl'), t('produits.form.opt.boy')] })}>
              <Icon name="plus" /> {t('produits.form.opt.girl')} / {t('produits.form.opt.boy')}
            </button>
          )}
          <button type="button" className="btn small ghost" onClick={() => addOpt({ name: '', values: [] })}>
            <Icon name="plus" /> {t('produits.form.opt.other')}
          </button>
        </div>
      )}

      {combos.length > MAX_COMBOS && <p className="form-err">{t('produits.form.opt.tooMany', { count: combos.length })}</p>}
      {combos.length > 0 && combos.length <= MAX_COMBOS && (
        <div className="po-gen">
          <div className="po-gen-head">
            <b>
              {t('produits.form.opt.count', { count: activeCount })}
              {activeCount !== combos.length && <span className="muted"> / {combos.length}</span>}
            </b>
            <div className="po-bulk">
              <span className="muted small">{t('produits.form.opt.bulkFor')}</span>
              <select value={bulkOn} onChange={(e) => setBulkOn(e.target.value)} aria-label={t('produits.form.opt.bulkFor')}>
                <option value="*">{t('produits.form.opt.bulkAll')}</option>
                {usedOpts.map((o, k) =>
                  o.values.map((v) => (
                    <option key={`${k}|${v}`} value={`${k}|${v}`}>
                      {o.name} = {v}
                    </option>
                  )),
                )}
              </select>
              <select value={bulkField} onChange={(e) => setBulkField(e.target.value as 'price' | 'cost' | 'maxDiscount' | 'weightKg' | 'alertQty' | 'feeGrid')} aria-label="Price field">
                <option value="price">Selling price</option>
                <option value="cost">Purchase price</option>
                {admin && <option value="maxDiscount">Max. discount</option>}
                <option value="weightKg">Weight (kg)</option>
                <option value="alertQty">Minimum stock</option>
                <option value="feeGrid">Delivery grid</option>
              </select>
              {bulkField === 'feeGrid' ? <select value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)} aria-label="Delivery grid"><option value="">Product default</option>{feeGrids.map((g) => <option key={g} value={g}>{g}</option>)}</select> : <input type="number" min={0} step={bulkField === 'weightKg' ? 0.1 : bulkField === 'alertQty' ? 1 : 50} value={bulkPrice} placeholder={String(basePrice || '')} aria-label="Bulk value" onChange={(e) => setBulkPrice(e.target.value)} />}
              <button type="button" className="btn small" disabled={bulkPrice === ''} onClick={applyBulk}>
                {t('produits.form.opt.bulkApply')}
              </button>
            </div>
          </div>
          <div className="tbl-wrap">
            <table className="tbl po-tbl">
              <thead>
                <tr>
                  <th>{t('produits.form.opt.colOn')}</th>
                  {usedOpts.map((o, k) => (
                    <th key={k}>{o.name}</th>
                  ))}
                  <th>{t('produits.form.opt.colSku')}</th>
                  <th>{t('produits.form.opt.colPrice')}</th>
                  <th>Purchase price (DA)</th>
                  <th>Max. discount (DA)</th>
                  <th>Weight (kg)</th>
                  <th>Minimum stock</th>
                  <th>Delivery grid</th>
                  <th>Margin (DA)</th>
                </tr>
              </thead>
              <tbody>
                {combos.map((c) => {
                  const title = titleOf(c);
                  const v = byTitle.get(low(title));
                  if (!v) return null;
                  return (
                    <tr key={title} className={v.active ? '' : 'dim'}>
                      <td data-l={t('produits.form.opt.colOn')}>
                        <input type="checkbox" checked={v.active} aria-label={`${t('produits.form.opt.colOn')} ${title}`} onChange={(e) => editRow(title, { active: e.target.checked })} />
                      </td>
                      {c.map((x, k) => (
                        <td key={k} data-l={usedOpts[k]?.name}>
                          <span className="po-chip po-chip-s">{x}</span>
                        </td>
                      ))}
                      <td data-l={t('produits.form.opt.colSku')}>
                        <input className="ltr" value={v.sku} placeholder={v.id ? '' : skuOf(baseSku, c)} aria-label={`SKU ${title}`} onChange={(e) => editRow(title, { sku: e.target.value })} />
                      </td>
                      <td data-l={t('produits.form.opt.colPrice')}>
                        <input type="number" min={0} step={50} value={v.price} placeholder={basePrice ? bidi(da(basePrice)) : ''} aria-label={`${t('produits.form.opt.colPrice')} ${title}`} onChange={(e) => editRow(title, { price: e.target.value })} />
                      </td>
                      <td data-l="Purchase price (DA)"><input type="number" min={0} step={50} value={v.cost} aria-label={`Purchase price ${title}`} onChange={(e) => editRow(title, { cost: e.target.value })} /></td>
                      <td data-l="Max. discount (DA)"><input type="number" min={0} step={50} value={v.maxDiscount} disabled={!admin} aria-label={`Max. discount ${title}`} onChange={(e) => editRow(title, { maxDiscount: e.target.value })} /></td>
                      <td data-l="Weight (kg)"><input type="number" min={0} max={1000} step={0.1} value={v.weightKg} aria-label={`Weight ${title}`} onChange={(e) => editRow(title, { weightKg: e.target.value })} /></td>
                      <td data-l="Minimum stock"><input type="number" min={0} step={1} value={v.alertQty} aria-label={`Minimum stock ${title}`} onChange={(e) => editRow(title, { alertQty: e.target.value })} /></td>
                      <td data-l="Delivery grid"><select value={v.feeGrid} aria-label={`Delivery grid ${title}`} onChange={(e) => editRow(title, { feeGrid: e.target.value })}><option value="">Product default</option>{feeGrids.map((g) => <option key={g} value={g}>{g}</option>)}</select></td>
                      <td data-l="Margin (DA)">{v.price !== '' && v.cost !== '' ? bidi(da(Number(v.price) - Number(v.cost))) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small">{t('produits.form.opt.genHelp')}</p>
        </div>
      )}

      {others.length > 0 && (
        <div className="po-others">
          <h4>{t('produits.form.opt.others')}</h4>
          <p className="muted small">{t('produits.form.opt.othersHelp')}</p>
          <div className="items-ed">
            {others.map((v) => (
              <div key={v.id} className={`item-row bjpv-row ${v.active ? '' : 'dim'}`}>
                <input value={v.title} aria-label={t('produits.form.variants')} onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, title: e.target.value } : x)))} />
                <input className="ltr" value={v.sku} placeholder="SKU" aria-label="SKU" onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, sku: e.target.value } : x)))} />
                <input type="number" min={0} step={50} value={v.price} placeholder={t('produits.form.variantPrice')} aria-label={t('produits.form.variantPrice')} onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, price: e.target.value } : x)))} />
                <input type="number" min={0} step={50} value={v.cost} placeholder="Purchase price" aria-label="Purchase price" onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, cost: e.target.value } : x)))} />
                <input type="number" min={0} step={50} value={v.maxDiscount} disabled={!admin} placeholder="Max. discount" aria-label="Max. discount" onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, maxDiscount: e.target.value } : x)))} />
                <input type="number" min={0} step={0.1} value={v.weightKg} placeholder="Weight (kg)" aria-label="Weight" onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, weightKg: e.target.value } : x)))} />
                <input type="number" min={0} step={1} value={v.alertQty} placeholder="Minimum stock" aria-label="Minimum stock" onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, alertQty: e.target.value } : x)))} />
                <select value={v.feeGrid} aria-label="Delivery grid" onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, feeGrid: e.target.value } : x)))}><option value="">Product default</option>{feeGrids.map((g) => <option key={g} value={g}>{g}</option>)}</select>
                <label className="check">
                  <input type="checkbox" checked={v.active} onChange={(e) => setVars((prev) => prev.map((x) => (x.id === v.id ? { ...x, active: e.target.checked } : x)))} />
                  {t('produits.form.variantActive')}
                </label>
                <span />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
