// Produits › « Importer Excel »: pick a .xlsx / .xls / .csv, see what will be created (the server's dry run), then import.
// The file is read here, in the browser (SheetJS, loaded only when the dialog needs it); the server groups and checks the lines.
import type { ImportProduct, ImportResult } from '@pilotix/core';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { In, rpc } from '../../lib/backend';
import { da, n } from '../../lib/format';
import { useAction } from '../../lib/query';
import { Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';

type Row = In<'catalog.importProducts'>['rows'][number];
type Field = Exclude<keyof Row, 'line'>;
const FIELDS: Field[] = ['name', 'sku', 'cost', 'price', 'variant', 'variantSku', 'stock', 'weightKg', 'maxDiscount'];
const REQUIRED: Field[] = ['name', 'price'];
const MAX_ROWS = 2000;

/** "Prix d’achat" → "prixdachat": accents, Arabic vowel marks, case, spaces and punctuation do not count */
const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ًͯ-ٰٟ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
// the headers in French, English and Arabic (the template is written in the language of the page)
const ALIASES: Record<Field, string[]> = {
  name: ['Nom', 'Nom du produit', 'Produit', 'Name', 'Product', 'Product name', 'الاسم', 'اسم المنتج', 'المنتج'],
  sku: ['SKU', 'Référence', 'Ref', 'Code', 'رمز المنتج', 'الرمز'],
  cost: ['Prix d’achat', 'Prix achat', 'Coût', 'Purchase price', 'Cost', 'Cost price', 'سعر الشراء'],
  price: ['Prix de vente', 'Prix vente', 'Prix', 'Sale price', 'Selling price', 'Price', 'سعر البيع', 'السعر'],
  variant: ['Variante', 'Variant', 'Option', 'المتغير', 'النوع', 'الخيار'],
  variantSku: ['SKU variante', 'Variant SKU', 'رمز المتغير'],
  stock: ['Stock initial', 'Stock', 'Quantité', 'Qté', 'Initial stock', 'Quantity', 'Qty', 'المخزون الأولي', 'المخزون', 'الكمية'],
  weightKg: ['Poids (kg)', 'Poids', 'Weight (kg)', 'Weight', 'الوزن (كغ)', 'الوزن'],
  maxDiscount: ['Remise max', 'Remise maximale', 'Max discount', 'Maximum discount', 'الخصم الأقصى', 'أقصى خصم'],
};
const BY_HEADER = new Map(FIELDS.flatMap((f) => ALIASES[f].map((a) => [norm(a), f] as const)));

const EXAMPLES: (string | number)[][] = [
  ['T-shirt coton', 'TSH-COTON', 900, 2500, 'Rouge / M', 'TSH-COTON-R-M', 20, 0.3, 300],
  ['T-shirt coton', 'TSH-COTON', 900, 2500, 'Bleu / L', 'TSH-COTON-B-L', 15, 0.3, 300],
  ['Montre classique', 'MONTRE-CL', 1800, 4900, '', '', 12, 0.2, 500],
];

type Parsed = { file: string; rows: Row[]; ignored: string[] };
async function readSheet(file: File): Promise<Parsed | { error: string; args?: Record<string, string | number> }> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws?.['!ref']) return { error: 'empty' };
  const first = XLSX.utils.decode_range(ws['!ref']).s.r;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true, blankrows: true });
  const blank = (r: unknown[]) => !r.some((c) => c !== null && String(c).trim() !== '');
  const h = grid.findIndex((r) => !blank(r));
  if (h < 0) return { error: 'empty' };
  const cols = new Map<Field, number>();
  const ignored: string[] = [];
  grid[h].forEach((c, k) => {
    const f = BY_HEADER.get(norm(c));
    if (f && !cols.has(f)) cols.set(f, k);
    else if (String(c ?? '').trim()) ignored.push(String(c).trim());
  });
  const missing = REQUIRED.find((f) => !cols.has(f));
  if (missing) return { error: 'missingCol', args: { col: missing } };
  const rows: Row[] = [];
  grid.slice(h + 1).forEach((r, k) => {
    if (blank(r)) return;
    const row: Row = { line: first + h + k + 2 };
    for (const [f, at] of cols) {
      const v = r[at];
      if (v !== null && v !== undefined) row[f] = typeof v === 'number' ? v : String(v);
    }
    rows.push(row);
  });
  if (!rows.length) return { error: 'empty' };
  if (rows.length > MAX_ROWS) return { error: 'tooMany', args: { n: rows.length, max: MAX_ROWS } };
  return { file: file.name, rows, ignored };
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<Parsed | null>(null);
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const run = useAction('catalog.importProducts', { success: (r) => t('produits.import.done', { count: r.created }), onDone: (r) => setPlan(r) });
  const col = (f: Field) => t(`produits.import.cols.${f}`);

  const template = async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([FIELDS.map(col), ...EXAMPLES]);
    ws['!cols'] = FIELDS.map((f) => ({ wch: f === 'name' || f === 'variantSku' ? 20 : 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Produits');
    const blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modele-import-produits.xlsx';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setData(null);
    setPlan(null);
    try {
      const r = await readSheet(file);
      if ('error' in r) return setErr(t(`produits.import.err_${r.error}`, { ...r.args, col: r.args?.col ? col(r.args.col as Field) : '' }));
      setData(r);
      setPlan(await rpc('catalog.importProducts', { rows: r.rows, dryRun: true }));
    } catch (e) {
      setErr(t('produits.import.err_read', { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const done = plan && !plan.dryRun;
  const ready = plan?.products.filter((p) => p.status === 'ready') ?? [];
  const pieces = ready.reduce((s, p) => s + p.variants.reduce((x, v) => x + v.stock, 0), 0);
  const variants = ready.reduce((s, p) => s + p.variants.filter((v) => v.title).length, 0);
  const count = (s: ImportProduct['status']) => plan?.products.filter((p) => p.status === s).length ?? 0;
  return (
    <Modal
      wide
      title={t('produits.import.title')}
      onClose={onClose}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            {plan && (
              <button className="btn" disabled={busy || run.isPending} onClick={() => input.current?.click()}>
                {t('produits.import.other')}
              </button>
            )}
            <button className="btn primary" disabled={!data || !ready.length || busy || run.isPending} onClick={() => data && run.mutate({ rows: data.rows, dryRun: false })}>
              <Icon name="upload" />
              {t('produits.import.confirm', { count: ready.length })}
            </button>
          </>
        )
      }
    >
      <div className="pd-form pd-imp">
        <input ref={input} type="file" hidden accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        {!plan && (
          <>
            <p className="pd-imp-intro">{t('produits.import.intro')}</p>
            <div className="pd-imp-cols">
              {FIELDS.map((f) => (
                <span key={f} className={`chip ${REQUIRED.includes(f) ? 'req' : ''}`}>
                  {col(f)}
                  {REQUIRED.includes(f) && ' *'}
                </span>
              ))}
            </div>
            <p className="pd-note">{t('produits.import.rules')}</p>
            <div className="pd-imp-pick">
              <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
                <Icon name="upload" />
                {t('produits.import.pick')}
              </button>
              <button className="btn" onClick={template}>
                <Icon name="download" />
                {t('produits.import.template')}
              </button>
            </div>
          </>
        )}
        {busy && <Loading />}
        {err && (
          <p className="pd-imp-err" role="alert">
            {err}
          </p>
        )}
        {plan && data && (
          <>
            <div className="pd-imp-sum" role="status">
              <Icon name={done ? 'checkcircle' : 'list'} />
              <span>
                <b>{data.file}</b>
                <small>
                  {done
                    ? t('produits.import.doneSum', { created: plan.created, skipped: plan.skipped, failed: plan.failed })
                    : [
                        t('produits.import.sumReady', { count: ready.length }),
                        variants ? t('produits.import.sumVariants', { count: variants }) : null,
                        pieces && plan.warehouse ? t('produits.import.sumStock', { n: n(pieces), depot: plan.warehouse.name }) : null,
                        count('skip') ? t('produits.import.sumSkip', { count: count('skip') }) : null,
                        count('error') ? t('produits.import.sumError', { count: count('error') }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </small>
              </span>
            </div>
            {data.ignored.length > 0 && <p className="pd-note">{t('produits.import.ignoredCols', { cols: data.ignored.join(', ') })}</p>}
            {plan.lineErrors.map((e) => (
              <p key={e.line} className="pd-imp-err">
                {t('produits.import.line', { line: e.line })} : {e.message}
              </p>
            ))}
            <div className="pd-imp-table" role="table" aria-label={t('produits.import.title')}>
              <div className="pd-imp-row pd-imp-head" role="row">
                <span role="columnheader">{t('produits.import.lines')}</span>
                <span role="columnheader">{t('produits.products.product')}</span>
                <span role="columnheader">{t('produits.products.variants')}</span>
                <span role="columnheader" className="num">
                  {t('produits.products.price')}
                </span>
                <span role="columnheader" className="num">
                  {t('produits.products.cost')}
                </span>
                <span role="columnheader">{t('produits.products.state')}</span>
              </div>
              {plan.products.map((p, k) => (
                <div key={k} className={`pd-imp-row s-${p.status}`} role="row">
                  <span className="pd-imp-lines ltr">{p.lines.length > 1 ? `${p.lines[0]}–${p.lines[p.lines.length - 1]}` : p.lines[0]}</span>
                  <span className="pd-name">
                    <b>{p.name}</b>
                    <small className="ltr">{p.sku || t('produits.import.autoSku')}</small>
                  </span>
                  <span className="pd-imp-vars">
                    {p.variants.map((v) => (
                      <span key={v.line} className="chip">
                        <bdi>{v.title || t('produits.import.noVariant')}</bdi>
                        {v.stock > 0 && <b className="ltr">{`\u00a0·\u00a0${n(v.stock)}`}</b>}
                      </span>
                    ))}
                  </span>
                  <span className="num ltr">{da(p.price)}</span>
                  <span className="num ltr">{da(p.cost)}</span>
                  <span>
                    <span className={`badge ${p.status === 'error' ? 't-bad' : p.status === 'skip' ? 't-warn' : p.status === 'created' ? 't-ok' : 't-info'}`}>{t(`produits.import.st_${p.status}`)}</span>
                  </span>
                  {(p.errors.length > 0 || p.warnings.length > 0) && (
                    <ul className="pd-imp-msgs">
                      {p.errors.map((m) => (
                        <li key={m} className="bad">
                          {m}
                        </li>
                      ))}
                      {p.warnings.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            {!done && <p className="pd-note">{t('produits.import.stockHint', { depot: plan.warehouse?.name ?? '—' })}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
