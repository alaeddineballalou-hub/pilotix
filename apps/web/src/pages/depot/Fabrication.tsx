// Fabrication (Management › Stock › « Fabrication »): each product's recipe (the parts one piece uses) and « Fabriquer »:
// the parts leave the depot, the finished pieces come in at the cost of their parts. The last makings below.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateTime, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { DepotSelect, PickItem, ProductPicker, Stepper, Toolbar, useDepots } from './stockui';

type Part = { variantId: number; label: string; sku: string; qty: number | '' };

export function Fabrication() {
  const { t } = useTranslation();
  const [wh, setWh] = useState('');
  const q = useRpc('making.list', { warehouseId: wh ? Number(wh) : undefined });
  const [edit, setEdit] = useState<{ productId: number | null; parts: Part[] } | null>(null);
  const [make, setMake] = useState<{ productId: number } | null>(null);
  const d = q.data;
  return (
    <>
      <section className="card pd-card">
        <Toolbar
          action={
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <DepotSelect value={wh} onChange={setWh} label={t('produits.stock.depot')} />
              <button type="button" className="btn primary" onClick={() => setEdit({ productId: null, parts: [] })}>
                <Icon name="plus" />
                {t('produits.mk.newRecipe')}
              </button>
            </span>
          }
        >
          <h3 style={{ margin: 0 }}>{t('produits.mk.recipes')}</h3>
        </Toolbar>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !d?.recipes.length ? (
          <div className="ai-empty pd-allgood">
            <Icon name="box" />
            <p>{t('produits.mk.none')}</p>
          </div>
        ) : (
          <ul className="pd-mk">
            {d.recipes.map((r) => (
              <li key={r.productId} className="pd-mk-card">
                <div className="pd-mk-head">
                  <b>{r.name}</b>
                  <span className="muted small">{t('produits.mk.unitCost', { cost: da(r.unitCost) })}</span>
                </div>
                <ul className="pd-mk-parts">
                  {r.parts.map((x) => (
                    <li key={x.variantId}>
                      <span>
                        <b className="ltr">{x.qty} ×</b> {x.label}
                      </span>
                      <span className={`ltr ${x.inStock < x.qty ? 'pd-mk-short' : 'muted'}`}>{t('produits.mk.inStock', { n: n(x.inStock) })}</span>
                    </li>
                  ))}
                </ul>
                <div className="pd-mk-acts">
                  <span className={r.canMake ? '' : 'pd-mk-short'}>{t('produits.mk.canMake', { count: r.canMake })}</span>
                  <span className="grow" />
                  <button type="button" className="btn small" onClick={() => setEdit({ productId: r.productId, parts: r.parts.map((x) => ({ variantId: x.variantId, label: x.label, sku: x.sku, qty: x.qty })) })}>
                    <Icon name="edit" />
                    {t('produits.mk.edit')}
                  </button>
                  <button type="button" className="btn small primary" disabled={!r.canMake} onClick={() => setMake({ productId: r.productId })}>
                    <Icon name="check" />
                    {t('produits.mk.make')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="pd-note">{t('produits.mk.help')}</p>
      </section>
      {!!d?.last.length && (
        <section className="card pd-card">
          <h3 style={{ marginTop: 0 }}>{t('produits.mk.last')}</h3>
          <div className="tbl-wrap">
            <table className="tbl pd-fc">
              <tbody>
                {d.last.map((m) => (
                  <tr key={m.id}>
                    <td className="ltr">{m.ref}</td>
                    <td className="wide">
                      <b>{m.label}</b>
                      <small className="pd-fc-sub">
                        {m.warehouseName}
                        {m.by ? ` · ${m.by}` : ''}
                      </small>
                    </td>
                    <td className="num ltr">+{n(m.qty)}</td>
                    <td className="num ltr">{da(m.unitCost)}</td>
                    <td className="muted small">{dateTime(m.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {edit && <RecipeForm init={edit} onClose={() => setEdit(null)} />}
      {make && d && <MakeForm recipe={d.recipes.find((r) => r.productId === make.productId)!} warehouseId={d.warehouseId} onClose={() => setMake(null)} />}
    </>
  );
}

function RecipeForm({ init, onClose }: { init: { productId: number | null; parts: Part[] }; onClose: () => void }) {
  const { t } = useTranslation();
  const prods = useRpc('catalog.products', {});
  const [pid, setPid] = useState<number | null>(init.productId);
  const [parts, setParts] = useState<Part[]>(init.parts);
  const save = useAction('making.saveRecipe', { success: t('common.saved'), onDone: onClose });
  const items: PickItem[] = useMemo(
    () =>
      (prods.data ?? [])
        .filter((p) => p.active && !p.isService && p.id !== pid)
        .flatMap((p) => p.variants.filter((v) => v.active).map((v) => ({ variantId: v.id, label: v.title ? `${p.name} ${v.title}` : p.name, sku: v.sku, cost: p.cost }))),
    [prods.data, pid],
  );
  const submit = () => {
    if (!pid) return toast(t('produits.mk.pickProduct'), 'bad');
    if (parts.some((x) => x.qty === '' || x.qty < 1)) return toast(t('produits.mk.badQty'), 'bad');
    save.mutate({ productId: pid, parts: parts.map((x) => ({ variantId: x.variantId, qty: x.qty as number })) });
  };
  return (
    <Modal
      title={t('produits.mk.recipeTitle')}
      onClose={onClose}
      className="pd-sheet"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={submit}>
            <Icon name="check" />
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="pd-form">
        <Field label={t('produits.mk.finished')}>
          <select value={pid ?? ''} disabled={!!init.productId} onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('produits.mk.pickProduct')}</option>
            {(prods.data ?? [])
              .filter((p) => p.active && !p.isService)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
        <h3>{t('produits.mk.parts')}</h3>
        <ProductPicker items={items} taken={new Set(parts.map((x) => x.variantId))} placeholder={t('produits.mk.addPart')} onPick={(it) => setParts((ps) => [...ps, { variantId: it.variantId, label: it.label, sku: it.sku, qty: 1 }])} />
        {parts.length ? (
          <ul className="pd-lines-l">
            {parts.map((x) => (
              <li key={x.variantId} className="pd-line">
                <span className="pd-name">
                  <b>{x.label}</b>
                  <small className="ltr">{x.sku}</small>
                </span>
                <label className="pd-in">
                  <small className="pd-lab">{t('produits.mk.perPiece')}</small>
                  <Stepper value={x.qty} min={1} label={t('produits.mk.perPiece')} onChange={(v) => setParts((ps) => ps.map((y) => (y.variantId === x.variantId ? { ...y, qty: v } : y)))} />
                </label>
                <button type="button" className="icon-btn pd-x" aria-label={t('produits.mk.removePart')} onClick={() => setParts((ps) => ps.filter((y) => y.variantId !== x.variantId))}>
                  <Icon name="x" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pd-lines-empty">{t('produits.mk.noParts')}</p>
        )}
        {init.productId && !parts.length && <p className="pd-note">{t('produits.mk.removeHint')}</p>}
      </div>
    </Modal>
  );
}

type Recipe = { productId: number; name: string; variants: { id: number; title: string }[]; parts: { variantId: number; label: string; qty: number; inStock: number; cost: number }[]; unitCost: number; canMake: number };

function MakeForm({ recipe, warehouseId, onClose }: { recipe: Recipe; warehouseId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { depots, many } = useDepots();
  const [vid, setVid] = useState(recipe.variants[0]?.id ?? 0);
  const [wid, setWid] = useState(warehouseId);
  const [qty, setQty] = useState<number | ''>(1);
  const [note, setNote] = useState('');
  const go = useAction('making.make', { success: (r) => t('produits.mk.done', { ref: r.ref, n: r.qty, name: r.label }), onDone: onClose });
  const q = qty === '' ? 0 : qty;
  return (
    <Modal
      title={t('produits.mk.makeTitle', { name: recipe.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={go.isPending || q < 1} onClick={() => go.mutate({ variantId: vid, warehouseId: wid, qty: q, note: note.trim() })}>
            <Icon name="check" />
            {t('produits.mk.makeN', { count: q })}
          </button>
        </>
      }
    >
      <div className="pd-form">
        {recipe.variants.length > 1 && (
          <Field label={t('produits.mk.variant')}>
            <select value={vid} onChange={(e) => setVid(Number(e.target.value))}>
              {recipe.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title || recipe.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {many && (
          <Field label={t('produits.stock.depot')}>
            <select value={wid} onChange={(e) => setWid(Number(e.target.value))}>
              {depots.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('produits.mk.howMany', { max: recipe.canMake })}>
          <Stepper value={qty} min={1} max={recipe.canMake || undefined} label={t('produits.mk.howMany', { max: recipe.canMake })} onChange={setQty} />
        </Field>
        <ul className="pd-mk-parts">
          {recipe.parts.map((x) => (
            <li key={x.variantId}>
              <span>{x.label}</span>
              <span className={`ltr ${x.inStock < x.qty * q ? 'pd-mk-short' : ''}`}>
                −{n(x.qty * q)} <small className="muted">/ {n(x.inStock)}</small>
              </span>
            </li>
          ))}
        </ul>
        <p className="pd-note">{t('produits.mk.costNote', { cost: da(recipe.unitCost) })}</p>
        <Field label={t('produits.buy.note')}>
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
