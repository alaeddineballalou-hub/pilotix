// Management → Prix de livraison: named client price grids per wilaya (Domicile / Bureau), default grid, products per grid.
import { WILAYAS } from '@pilotix/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wilaya } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Field, Help, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { ConfirmButton, intOf } from './bits';

type Grid = Record<string, { home: number; desk: number }>;

export function Prix() {
  const { t } = useTranslation();
  const q = useRpc('admin.fees.get', {});
  const [cur, setCur] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | 'rename' | null>(null);
  const [prods, setProds] = useState(false);
  const createFirst = useAction('admin.fees.saveGrid', { success: t('admin.fees.saved') });
  const grids = q.data?.grids ?? {};
  const names = Object.keys(grids);
  const name = cur && grids[cur] ? cur : q.data?.defaultGrid && grids[q.data.defaultGrid] ? q.data.defaultGrid : names[0] ?? null;

  const head = (
    <div className="card-head">
      <h2>
        {t('admin.fees.title')}
        <Help text={t('admin.fees.help')} />
      </h2>
      {names.length > 0 && (
        <button className="btn primary" onClick={() => setForm('new')}>
          {t('admin.fees.add')}
        </button>
      )}
    </div>
  );
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!names.length || !name)
    return (
      <div className="card">
        {head}
        <div className="bjg-empty">
          <p>{t('admin.fees.empty')}</p>
          <button type="button" className="btn primary" disabled={createFirst.isPending} onClick={() => createFirst.mutate({ name: 'Standard' })}>
            {t('admin.fees.createFirst')}
          </button>
        </div>
      </div>
    );

  const products = q.data!.products;
  const countOf = (g: string) => products.filter((p) => p.feeGrid === g || (!p.feeGrid && g === q.data!.defaultGrid)).length;
  return (
    <>
      <div className="card">
        {head}
        <div className="bjg-tabs" role="tablist">
          {names.map((g) => (
            <button key={g} type="button" role="tab" aria-selected={g === name} className={`bjg-tab ${g === name ? 'on' : ''}`} onClick={() => setCur(g)}>
              <span>
                {g} {g === q.data!.defaultGrid && <span className="bjg-def">{t('admin.fees.default')}</span>}
              </span>
              <small>{t('admin.fees.products', { count: countOf(g) })}</small>
            </button>
          ))}
          <button type="button" className="bjg-tab bjg-add" onClick={() => setForm('new')}>
            {t('admin.fees.add')}
          </button>
        </div>
        <GridEditor key={name} name={name} grid={grids[name]} isDefault={name === q.data!.defaultGrid} onRename={() => setForm('rename')} onProducts={() => setProds(true)} onDeleted={() => setCur(null)} />
      </div>
      {form && <GridForm mode={form} name={name} names={names} onClose={() => setForm(null)} onDone={(n) => setCur(n)} />}
      {prods && <ProductsForm name={name} products={products} defaultGrid={q.data!.defaultGrid} onClose={() => setProds(false)} />}
    </>
  );
}

function GridEditor({ name, grid, isDefault, onRename, onProducts, onDeleted }: { name: string; grid: Grid; isDefault: boolean; onRename: () => void; onProducts: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, { home: string; desk: string }>>({});
  const [q, setQ] = useState('');
  const [delta, setDelta] = useState('');
  useEffect(() => {
    const r: Record<string, { home: string; desk: string }> = {};
    for (let w = 1; w <= WILAYAS.length; w++) r[w] = { home: grid[w] ? String(grid[w].home) : '', desk: grid[w] ? String(grid[w].desk) : '' };
    setRows(r);
  }, [grid]);
  const save = useAction('admin.fees.saveGrid', { success: t('admin.fees.saved') });
  const setDef = useAction('admin.fees.setDefault', { success: t('admin.fees.saved') });
  const del = useAction('admin.fees.deleteGrid', { success: t('admin.fees.deleted'), onDone: onDeleted });
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return WILAYAS.map((_, i) => i + 1).filter((w) => !s || wilaya(w).toLowerCase().includes(s));
  }, [q]);
  const submit = () => {
    const out: Grid = {};
    for (const [w, r] of Object.entries(rows)) if (r.home !== '' || r.desk !== '') out[w] = { home: intOf(r.home), desk: intOf(r.desk) };
    save.mutate({ name, oldName: name, rows: out });
  };
  const shift = () => {
    const d = Math.round(Number(delta) || 0);
    if (!d) return;
    setRows(Object.fromEntries(Object.entries(rows).map(([w, r]) => [w, { home: r.home === '' ? '' : String(Math.max(0, Number(r.home) + d)), desk: r.desk === '' ? '' : String(Math.max(0, Number(r.desk) + d)) }])));
    setDelta('');
  };
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <button className="btn small" onClick={onProducts}>
          {t('admin.fees.productsTitle', { name })}
        </button>
        <button className="btn small" onClick={onRename}>
          {t('admin.fees.rename')}
        </button>
        {isDefault ? (
          <span className="chip">{t('admin.fees.isDefault')}</span>
        ) : (
          <button className="btn small" onClick={() => setDef.mutate({ name })}>
            {t('admin.fees.setDefault')}
          </button>
        )}
        {!isDefault && (
          <ConfirmButton className="btn small ghost danger" question={t('admin.fees.deleteConfirm', { name })} onConfirm={() => del.mutate({ name })}>
            {t('admin.fees.delete')}
          </ConfirmButton>
        )}
      </div>
      <div className="filters row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input type="search" placeholder={t('admin.fees.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 'auto', minWidth: 240, flex: '0 1 300px' }} />
        <span className="row nowrap" style={{ gap: 6 }}>
          <input type="number" step={50} value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="± 100" aria-label={t('admin.fees.allHome')} style={{ width: 110 }} />
          <button className="btn small" onClick={shift}>
            {t('admin.fees.apply')}
          </button>
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('admin.fees.colWilaya')}</th>
              <th>{t('admin.fees.colHome')}</th>
              <th>{t('admin.fees.colDesk')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w}>
                <td data-l={t('admin.fees.colWilaya')}>{wilaya(w)}</td>
                <td data-l={t('admin.fees.colHome')}>
                  <input type="number" min={0} step={50} inputMode="numeric" className="ltr" style={{ width: 110 }} value={rows[w]?.home ?? ''} aria-label={`${t('admin.fees.colHome')} ${wilaya(w)}`} onChange={(e) => setRows({ ...rows, [w]: { ...rows[w], home: e.target.value } })} />
                </td>
                <td data-l={t('admin.fees.colDesk')}>
                  <input type="number" min={0} step={50} inputMode="numeric" className="ltr" style={{ width: 110 }} value={rows[w]?.desk ?? ''} aria-label={`${t('admin.fees.colDesk')} ${wilaya(w)}`} onChange={(e) => setRows({ ...rows, [w]: { ...rows[w], desk: e.target.value } })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row end" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={save.isPending} onClick={submit}>
          {t('admin.fees.save')}
        </button>
      </div>
    </>
  );
}

function GridForm({ mode, name, names, onClose, onDone }: { mode: 'new' | 'rename'; name: string; names: string[]; onClose: () => void; onDone: (n: string) => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(mode === 'rename' ? name : '');
  const [from, setFrom] = useState<string>('');
  const save = useAction('admin.fees.saveGrid', {
    success: t('admin.fees.saved'),
    onDone: () => {
      onDone(v.trim());
      onClose();
    },
  });
  return (
    <Modal
      title={mode === 'new' ? t('admin.fees.newTitle') : t('admin.fees.renameTitle', { name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button className="btn primary" disabled={!v.trim() || save.isPending} onClick={() => save.mutate(mode === 'new' ? { name: v.trim(), copyFrom: from || undefined } : { name: v.trim(), oldName: name })}>
            {mode === 'new' ? t('admin.fees.create') : t('common.save')}
          </button>
        </>
      }
    >
      <Field label={t('admin.fees.name')}>
        <input value={v} maxLength={60} placeholder={t('admin.fees.namePh')} onChange={(e) => setV(e.target.value)} />
      </Field>
      {mode === 'new' && (
        <Field label={t('admin.fees.copyFrom')}>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">{t('admin.fees.copyCompany')}</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {t('admin.fees.copyGrid', { name: n })}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  );
}

function ProductsForm({ name, products, defaultGrid, onClose }: { name: string; products: { id: number; name: string; sku: string; feeGrid: string | null; active: boolean }[]; defaultGrid: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<number>>(new Set(products.filter((p) => p.feeGrid === name).map((p) => p.id)));
  const save = useAction('admin.fees.assign', { success: t('admin.fees.productsSaved'), onDone: onClose });
  return (
    <Modal
      title={t('admin.fees.productsTitle', { name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ name, productIds: [...sel] })}>
            {t('admin.fees.productsSave')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('admin.fees.productsHelp')}</p>
      {!products.length ? (
        <Empty>{t('admin.fees.noProducts')}</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {products.map((p) => (
            <label key={p.id} className={`row nowrap ${p.active ? '' : 'dim'}`} style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={sel.has(p.id)}
                onChange={(e) => {
                  const n = new Set(sel);
                  if (e.target.checked) n.add(p.id);
                  else n.delete(p.id);
                  setSel(n);
                }}
              />
              <span className="grow">
                {p.name} <small className="muted ltr">{p.sku}</small>
              </span>
              {p.feeGrid && p.feeGrid !== name && <small className="muted">{t('admin.fees.usesOther', { name: p.feeGrid })}</small>}
              {!p.feeGrid && name !== defaultGrid && <small className="muted">{t('admin.fees.usesOther', { name: defaultGrid })}</small>}
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
