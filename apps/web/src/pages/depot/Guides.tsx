// Produits & stock › Guide de vente: every product on the left (search, and where its guide stands), its guide on the
// right. The owner and the depot team write it there (« Modifier », with « Écrire avec l'IA »); the agents read it, for
// their own products only, in the app's language (Pilot AI translates it after each save). On a phone the guide rises
// from the bottom. The same guide as the product form's tab.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { dateOnly, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { SellerScope } from '../../lib/seller';
import { useIsPhone } from '../../lib/useMedia';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/toast';
import { DraftFacts, formToGuide, formTr, GuideEditor, GuideForm, guideProblem, guideToForm, GuideView, readLang, sizeValues, useGuideTranslate } from './guide';

type Row = Out<'catalog.guides'>['rows'][number];
type Filter = 'all' | 'with' | 'without' | 'todo';
const FILTERS: Filter[] = ['all', 'with', 'without', 'todo'];
const keyOf = (r: Row) => `${r.seller?.id ?? 0}:${r.id}`;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fits = (r: Row, f: Filter) => (f === 'all' ? true : f === 'with' ? r.hasGuide : f === 'without' ? !r.hasGuide : r.toFill > 0);

/** manager: who writes here (the owner, the depot team, a confirmation agency's people); the others read. initial: a product id from the address. */
export function Guides({ manager, initial }: { manager: boolean; initial?: number }) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const q = useRpc('catalog.guides', {});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const rows = q.data?.rows ?? [];
  // a product named in the address (#/produits/guides/12) opens first
  useEffect(() => {
    if (sel || !rows.length) return;
    const first = (initial && rows.find((r) => r.id === initial)) || (!phone ? rows[0] : null);
    if (first) setSel(keyOf(first));
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, rows.filter((r) => fits(r, f)).length])) as Record<Filter, number>, [rows]);
  const shown = useMemo(() => {
    const w = fold(search.trim());
    return rows.filter((r) => fits(r, filter) && (!w || fold(`${r.name} ${r.sku}`).includes(w)));
  }, [rows, filter, search]);
  const row = rows.find((r) => keyOf(r) === sel) ?? null;
  const pick = (r: Row) => {
    if (editing) return toast(t('produits.guide.page.finish'), 'bad');
    setSel(keyOf(r));
    if (!r.seller) history.replaceState(null, '', `#/produits/guides/${r.id}`);
  };
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  if (!rows.length) return <Empty>{t('produits.guide.page.none')}</Empty>;

  const box = row && (
    <GuideBox key={keyOf(row)} row={row} manager={manager} products={rows.filter((r) => (r.seller?.id ?? 0) === (row.seller?.id ?? 0)).map((r) => ({ id: r.id, name: r.name }))} phone={phone} onEditing={setEditing} onClose={() => (setSel(null), setEditing(false))} />
  );
  return (
    <div className={`gd-page ${editing ? 'editing' : ''}`}>
      <aside className="card gd-list" aria-label={t('produits.guide.page.list')}>
        <div className="gd-list-top">
          <label className="gd-search">
            <Icon name="search" />
            <input type="search" value={search} placeholder={t('produits.guide.page.search')} aria-label={t('produits.guide.page.search')} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="gd-filters" role="group" aria-label={t('produits.guide.page.filter')}>
            {FILTERS.map((f) => (
              <button key={f} type="button" className={`gd-filter ${filter === f ? 'on' : ''} ${f === 'todo' && counts.todo ? 'warn' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {t(`produits.guide.page.f.${f}`)} <span className="ltr">{n(counts[f])}</span>
              </button>
            ))}
          </div>
          {editing && <p className="gd-list-note">{t('produits.guide.page.finish')}</p>}
        </div>
        {shown.length ? (
          <ul className="gd-rows">
            {shown.map((r) => (
              <li key={keyOf(r)}>
                <button type="button" className={`gd-row ${keyOf(r) === sel ? 'on' : ''} ${r.active ? '' : 'off'}`} aria-current={keyOf(r) === sel ? 'true' : undefined} aria-disabled={editing && keyOf(r) !== sel} onClick={() => pick(r)}>
                  <span className="gd-row-thumb" aria-hidden="true">
                    {r.photo ? <img src={r.photo} alt="" loading="lazy" /> : <Icon name="package" />}
                  </span>
                  <span className="gd-row-main">
                    <b dir="auto">{r.name}</b>
                    <small>
                      {r.seller && <span className="chip">{r.seller.name}</span>}
                      <span className="ltr">{r.sku}</span>
                      {!r.active && <span> · {t('produits.guide.page.hidden')}</span>}
                    </small>
                  </span>
                  <span className={`gd-state ${r.hasGuide ? (r.toFill ? 'todo' : 'ok') : 'none'}`}>
                    {r.hasGuide ? (r.toFill ? t('produits.guide.page.toFill', { count: r.toFill }) : t('produits.guide.page.ready')) : t('produits.guide.none')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="gd-list-empty">{t('produits.guide.page.noMatch')}</p>
        )}
      </aside>
      {!phone && (row ? (row.seller ? <SellerScope seller={row.seller.id}>{box}</SellerScope> : box) : <section className="card gd-detail gd-detail-empty"><Icon name="book" /><p>{t('produits.guide.page.pick')}</p></section>)}
      {phone && row && (row.seller ? <SellerScope seller={row.seller.id}>{box}</SellerScope> : box)}
    </div>
  );
}

/** One product's guide: read it, or (the owner and the depot team) write it. */
function GuideBox({ row, manager, products, phone, onEditing, onClose }: { row: Row; manager: boolean; products: { id: number; name: string }[]; phone: boolean; onEditing: (on: boolean) => void; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = readLang(i18n.language);
  const read = useRpc('catalog.guide', { id: row.id, lang }, { staleTime: 30_000 });
  const [form, setForm] = useState<GuideForm | null>(null);
  const editing = form !== null;
  const prod = useRpc('catalog.guideFacts', { id: row.id }, { enabled: manager && editing });
  const translate = useGuideTranslate();
  // saved: Pilot AI translates what changed into the other languages
  const save = useAction('catalog.saveGuide', {
    success: t('produits.guide.page.saved'),
    onDone: (r) => {
      setForm(null);
      if (Object.keys(r.trMissing).length) void translate.run(row.id);
    },
  });
  useEffect(() => onEditing(editing), [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEditing(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const d = read.data;
  const id = `gd-${row.seller?.id ?? 0}-${row.id}`;
  const meta = translate.busy === row.id ? t('produits.guide.tr.working') : d?.updatedAt ? (d.updatedBy ? t('produits.guide.updated', { date: dateOnly(d.updatedAt), name: d.updatedBy }) : t('produits.guide.updatedNoName', { date: dateOnly(d.updatedAt) })) : t('produits.guide.none');
  const facts = (): DraftFacts => prod.data ?? { productId: row.id, name: row.name, variants: [], packs: [], linked: [], services: [], options: [], linkedIds: [] };
  const submit = () => {
    if (!form) return;
    const g = formToGuide(form, prod.data ? sizeValues(prod.data.options) : undefined);
    const problem = guideProblem(g, t);
    if (problem) return toast(problem, 'bad');
    save.mutate({ id: row.id, guide: g, tr: formTr(form, g) });
  };
  const write = () => setForm(guideToForm(d?.guide ?? null, null, lang));
  // the translations to correct come with the product's facts (the editor waits for them): taken once per edit
  const [trTaken, setTrTaken] = useState(false);
  useEffect(() => {
    if (!editing) return setTrTaken(false);
    if (trTaken || !prod.data) return;
    const tr = prod.data.guideTr;
    setForm((f) => (f ? { ...f, tr: JSON.parse(JSON.stringify(tr)), trBase: JSON.parse(JSON.stringify(tr)) } : f));
    setTrTaken(true);
  }, [editing, prod.data, trTaken]);
  const actions = editing ? (
    <>
      <button type="button" className="btn" disabled={save.isPending} onClick={() => setForm(null)}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn primary" disabled={save.isPending} onClick={submit}>
        <Icon name="check" /> {t('common.save')}
      </button>
    </>
  ) : manager && d ? (
    <button type="button" className={`btn ${d.guide ? '' : 'primary'}`} onClick={write}>
      <Icon name="pencil" /> {d.guide ? t('produits.guide.page.edit') : t('produits.guide.page.write')}
    </button>
  ) : null;
  const body = read.error ? (
    <ErrorBox error={read.error} onRetry={() => read.refetch()} />
  ) : !d ? (
    <Loading />
  ) : editing ? (
    // the product's options say which size guide it gets (one line per size, or the small one): wait for them
    trTaken || prod.error ? <GuideEditor value={form!} onChange={setForm} facts={facts} products={products} /> : <Loading />
  ) : d.guide ? (
    <GuideView guide={d.guide} id={id} upsell={d.upsell} tr={d.tr} trMissing={d.trMissing} onTranslate={manager ? () => void translate.run(row.id) : undefined} translating={translate.busy === row.id} />
  ) : (
    <div className="gd-none">
      <Icon name="book" />
      <p>{manager ? t('produits.guide.page.emptyManager') : t('produits.guide.empty')}</p>
      {manager && (
        <button type="button" className="btn primary" onClick={write}>
          <Icon name="pencil" /> {t('produits.guide.page.write')}
        </button>
      )}
    </div>
  );
  if (phone)
    return (
      <Sheet title={row.name} sub={meta} tall onClose={() => (editing ? toast(t('produits.guide.page.finish'), 'bad') : onClose())} foot={actions ? <div className="gd-sheet-foot">{actions}</div> : undefined} className="gd-sheet">
        {body}
      </Sheet>
    );
  return (
    <section className="card gd-detail" aria-labelledby={`${id}-h`}>
      <header className="gd-detail-head">
        <span className="gd-thumb" aria-hidden="true">
          {row.photo ? <img src={row.photo} alt="" /> : <Icon name="package" />}
        </span>
        <div className="gd-tt">
          <h2 id={`${id}-h`} dir="auto">
            {row.name}
          </h2>
          <span className="gd-meta">{editing ? t('produits.guide.page.editing') : meta}</span>
        </div>
        {actions && <div className="gd-detail-acts">{actions}</div>}
      </header>
      <div className="gd-detail-body">{body}</div>
    </section>
  );
}
