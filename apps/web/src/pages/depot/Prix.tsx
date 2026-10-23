// Prix: the sale price (vente), the purchase price (achat), the margin and the maximum discount (remise) of every
// product in one table, changed in place and saved together. A variant can have its own sale price.
// The maximum discount is the administrator's: the others see it, they do not change it.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, pct } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Filters, SearchBox } from '../ai/agent';
import { bidi, matches, MoneyInput, ProductT, Toolbar } from './stockui';

type Edit = { price?: number | ''; cost?: number | ''; maxDiscount?: number | ''; variants?: Record<number, number | ''> };
type PriceFilter = 'active' | 'hidden' | 'all';

export function Prix() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const prods = useRpc('catalog.products', {});
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [q, setQ] = useState('');
  const [f, setF] = useState<PriceFilter>('active');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const save = useAction('catalog.setPrices', { success: (r) => t('produits.prices.saved', { count: r.changed }), onDone: () => setEdits({}) });

  const all = prods.data ?? [];
  const found = all.filter((p) => !q.trim() || matches(q, p.name, p.sku, ...p.variants.map((v) => `${v.title} ${v.sku}`)));
  const test: Record<PriceFilter, (p: ProductT) => boolean> = { active: (p) => p.active, hidden: (p) => !p.active, all: () => true };
  const rows = found.filter(test[f]);

  const val = (p: ProductT) => {
    const e = edits[p.id] ?? {};
    return {
      price: e.price ?? p.price,
      cost: e.cost ?? p.cost,
      maxDiscount: e.maxDiscount ?? (p.maxDiscount === null ? '' : p.maxDiscount),
      variant: (vid: number, own: number | null) => (e.variants && vid in e.variants ? e.variants[vid] : own === null ? '' : own),
    };
  };
  const changedOf = (p: ProductT) => {
    const e = edits[p.id];
    if (!e) return { any: false, price: false, cost: false, md: false, vars: [] as number[] };
    const v = val(p);
    const price = v.price !== p.price;
    const cost = v.cost !== p.cost;
    const md = v.maxDiscount !== (p.maxDiscount === null ? '' : p.maxDiscount);
    const vars = p.variants.filter((x) => v.variant(x.id, x.price) !== (x.price === null ? '' : x.price)).map((x) => x.id);
    return { any: price || cost || md || vars.length > 0, price, cost, md, vars };
  };
  const dirty = useMemo(() => all.filter((p) => changedOf(p).any), [all, edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (p: ProductT, patch: Edit) => setEdits((m) => ({ ...m, [p.id]: { ...m[p.id], ...patch, variants: { ...m[p.id]?.variants, ...patch.variants } } }));

  const submit = () => {
    const items = [];
    for (const p of dirty) {
      const v = val(p);
      if (v.price === '' || v.cost === '') return toast(t('produits.prices.missing', { name: p.name }), 'bad');
      const ch = changedOf(p);
      items.push({
        id: p.id,
        price: v.price,
        cost: v.cost,
        ...(admin && ch.md ? { maxDiscount: v.maxDiscount === '' ? null : v.maxDiscount } : {}),
        variants: ch.vars.map((vid) => {
          const x = v.variant(vid, p.variants.find((y) => y.id === vid)!.price);
          return { id: vid, price: x === '' ? null : x };
        }),
      });
    }
    if (items.length) save.mutate({ items });
  };

  return (
    <>
      <section className="card pd-card">
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder={t('produits.products.searchPh')} />
          <Filters<PriceFilter>
            value={f}
            onChange={setF}
            label={t('produits.products.filters')}
            items={(['active', 'hidden', 'all'] as const).map((k) => ({ value: k, label: t(`produits.products.f_${k}`), count: found.filter(test[k]).length }))}
          />
        </Toolbar>
        {prods.isLoading ? (
          <Loading />
        ) : prods.error ? (
          <ErrorBox error={prods.error} onRetry={() => prods.refetch()} />
        ) : !rows.length ? (
          <Empty>{q.trim() ? t('produits.ui.noMatch') : t('produits.products.empty')}</Empty>
        ) : (
          <div className="pd-list">
            <div className="pd-row pd-head pd-price" aria-hidden="true">
              <span>{t('produits.prices.product')}</span>
              <span className="num">{t('produits.prices.sale')}</span>
              <span className="num">{t('produits.prices.cost')}</span>
              <span className="num">{t('produits.prices.margin')}</span>
              <span className="num">
                {t('produits.prices.discount')}
                {!admin && <Icon name="lock" className="pd-lock" />}
              </span>
            </div>
            {rows.map((p) => {
              const v = val(p);
              const ch = changedOf(p);
              const price = v.price === '' ? 0 : v.price;
              const cost = v.cost === '' ? 0 : v.cost;
              const m = price - cost;
              const rate = price > 0 ? m / price : null;
              const tone = m < 0 ? 'bad' : rate !== null && rate < 0.2 ? 'warn' : 'ok';
              const titled = p.variants.filter((x) => x.title);
              const isOpen = open.has(p.id);
              const own = p.variants.filter((x) => v.variant(x.id, x.price) !== '').length;
              return (
                <div key={p.id} className={`pd-pgroup ${ch.any ? 'changed' : ''} ${p.active ? '' : 'dim'}`}>
                  <div className="pd-row pd-price">
                    <span className="pd-name">
                      <b>{p.name}</b>
                      <small>
                        <span className="ltr">{p.sku}</span>
                        {p.isService && <span className="chip">{t('produits.products.service')}</span>}
                        {!p.active && <span className="chip">{t('produits.products.hidden')}</span>}
                      </small>
                      {titled.length > 0 && (
                        <button type="button" className="pd-vbtn" aria-expanded={isOpen} onClick={() => setOpen((s) => (s.has(p.id) ? (s.delete(p.id), new Set(s)) : new Set(s).add(p.id)))}>
                          <Icon name="chevron" />
                          {t('produits.prices.variants', { count: titled.length })}
                          {own > 0 && <em>{t('produits.prices.ownPrices', { count: own })}</em>}
                        </button>
                      )}
                    </span>
                    <label className="pd-in">
                      <small className="pd-lab">{t('produits.prices.sale')}</small>
                      <MoneyInput value={v.price} changed={ch.price} label={t('produits.prices.saleOf', { name: p.name })} onChange={(x) => set(p, { price: x })} />
                    </label>
                    <label className="pd-in">
                      <small className="pd-lab">{t('produits.prices.cost')}</small>
                      <MoneyInput value={v.cost} changed={ch.cost} label={t('produits.prices.costOf', { name: p.name })} onChange={(x) => set(p, { cost: x })} />
                    </label>
                    <span className={`pd-margin ${tone}`}>
                      <small className="pd-lab">{t('produits.prices.margin')}</small>
                      <b className="ltr">{da(m)}</b>
                      <small className="ltr">{rate === null ? '—' : pct(rate)}</small>
                    </span>
                    <label className="pd-in">
                      <small className="pd-lab">
                        {t('produits.prices.discountShort')}
                        {!admin && <Icon name="lock" className="pd-lock" />}
                      </small>
                      <MoneyInput value={v.maxDiscount} changed={ch.md} disabled={!admin} placeholder={t('produits.prices.noLimit')} label={t('produits.prices.discountOf', { name: p.name })} onChange={(x) => set(p, { maxDiscount: x })} />
                      <small className="pd-floor">{v.maxDiscount === '' ? t('produits.prices.anyPrice') : t('produits.prices.floor', { price: bidi(da(Math.max(0, price - v.maxDiscount))) })}</small>
                    </label>
                  </div>
                  {isOpen &&
                    titled.map((x) => {
                      const xv = v.variant(x.id, x.price);
                      return (
                        <div key={x.id} className={`pd-row pd-price pd-var ${x.active ? '' : 'dim'}`}>
                          <span className="pd-name">
                            <b>{x.title}</b>
                            <small>
                              <span className="ltr">{x.sku}</span>
                              {!x.active && <span className="chip">{t('produits.products.hidden')}</span>}
                            </small>
                          </span>
                          <label className="pd-in">
                            <small className="pd-lab">{t('produits.prices.sale')}</small>
                            <MoneyInput value={xv} changed={ch.vars.includes(x.id)} placeholder={n(price)} label={t('produits.prices.saleOf', { name: `${p.name} ${x.title}` })} onChange={(y) => set(p, { variants: { [x.id]: y } })} />
                          </label>
                          <span className="pd-vnote">{xv === '' ? t('produits.prices.sameAsProduct') : t('produits.prices.own')}</span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
        <p className="pd-note">{admin ? t('produits.prices.help') : t('produits.prices.helpDepot')}</p>
      </section>
      <div className={`ai-save pd-savebar ${dirty.length ? 'dirty' : ''}`}>
        <span className="ai-save-t" aria-live="polite">
          {dirty.length ? t('produits.prices.dirty', { count: dirty.length }) : t('produits.prices.clean')}
        </span>
        {dirty.length > 0 && (
          <button type="button" className="btn ghost" onClick={() => setEdits({})}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" className="btn primary" disabled={!dirty.length || save.isPending} onClick={submit}>
          {save.isPending ? t('ai.saving') : t('produits.prices.save')}
        </button>
      </div>
    </>
  );
}
