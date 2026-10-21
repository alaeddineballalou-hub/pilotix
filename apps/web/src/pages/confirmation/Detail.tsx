// The open row of the queue (".qdetail"): notes, products (variant / qty / price), add a product,
// delivery price and total, packs and linked products, save bar. Saved with orders.update (version check).
import { FOLLOW_LOCKED, Order } from '@pilotix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { da } from '../../lib/format';
import { Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';

interface Line {
  productId: number;
  variantId: number | null;
  name: string;
  variantTitle: string;
  qty: number;
  unitPrice: number;
  isUpsell: boolean;
}
type Catalog = NonNullable<ReturnType<typeof useCatalog>['data']>;
type Prod = Catalog[number];

const useCatalog = () => useRpc('confirmation.catalog', {}, { staleTime: 5 * 60_000 });
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
const key = (L: Line[]) => JSON.stringify(L.map((l) => [l.variantId, l.productId, l.qty, l.unitPrice, l.isUpsell]));

export function Detail({ order }: { order: Order }) {
  const { t } = useTranslation();
  const cat = useCatalog();
  const grid = useRpc('confirmation.gridFee', { id: order.id }, { staleTime: 60_000 });
  const initial = useMemo<Line[]>(() => order.items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.name, variantTitle: i.variantTitle, qty: i.qty, unitPrice: i.unitPrice, isUpsell: i.isUpsell })), [order]);
  const [L, setL] = useState<Line[]>(initial);
  const [fee, setFee] = useState(order.deliveryFee);
  const [err, setErr] = useState('');
  useEffect(() => {
    setL(initial);
    setFee(order.deliveryFee);
    setErr('');
  }, [initial, order.deliveryFee]);
  const save = useAction('orders.update', { success: t('confirmation.d.saved', { ref: order.ref }), silent: true });

  if (!cat.data) return <Loading />;
  const P = new Map(cat.data.map((p) => [p.id, p]));
  const editable = !(order.followStatus && FOLLOW_LOCKED.includes(order.followStatus)) && !order.shippedAt;
  const lockedPrice = !order.isExchange;
  const dirty = key(L) !== key(initial) || fee !== order.deliveryFee;
  const sub = L.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const disc = order.discount;
  const gf = grid.data?.fee ?? null;

  const priceOf = (p: Prod, vid: number | null) => p.variants.find((v) => v.id === vid)?.price ?? p.price;
  const add = (p: Prod, vid: number | null) => {
    setErr('');
    setL((cur) => {
      const ex = cur.find((l) => l.productId === p.id && l.variantId === vid);
      if (ex) return cur.map((l) => (l === ex ? { ...l, qty: l.qty + 1 } : l));
      const v = p.variants.find((x) => x.id === vid);
      return [...cur, { productId: p.id, variantId: vid, name: p.name, variantTitle: v?.title ?? '', qty: 1, unitPrice: priceOf(p, vid), isUpsell: cur.length > 0 }];
    });
  };
  const upd = (i: number, patch: Partial<Line>) => setL((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const setVar = (i: number, vid: number) => {
    const l = L[i];
    const p = P.get(l.productId);
    const twin = L.findIndex((x, k) => k !== i && x.variantId === vid);
    if (twin >= 0) {
      setL((cur) => cur.map((x, k) => (k === twin ? { ...x, qty: x.qty + l.qty } : x)).filter((_, k) => k !== i));
      toast(t('confirmation.d.merged'), 'ok');
      return;
    }
    const v = p?.variants.find((x) => x.id === vid);
    upd(i, { variantId: vid, variantTitle: v?.title ?? '', unitPrice: p ? priceOf(p, vid) : l.unitPrice });
  };

  // offers: packs of the products in the order, then linked products not in it yet
  const inOrder = new Set(L.map((l) => l.productId));
  const packs: { i: number; qty: number; price: number; save: number }[] = [];
  const linked = new Map<number, Prod>();
  L.forEach((l, i) => {
    const p = P.get(l.productId);
    if (!p) return;
    for (const pk of p.packs) if (pk.qty !== l.qty) packs.push({ i, qty: pk.qty, price: pk.price, save: l.unitPrice * pk.qty - pk.price });
    for (const id of p.linked) {
      const lp = P.get(id);
      if (lp && !inOrder.has(id) && !linked.has(id)) linked.set(id, lp);
    }
  });

  const onSave = () => {
    if (!L.length) {
      setErr(t('confirmation.d.keepOne'));
      return;
    }
    setErr('');
    save.mutate(
      { id: order.id, version: order.version, deliveryFee: fee, ...(key(L) !== key(initial) ? { items: L.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, isUpsell: l.isUpsell })) } : {}) },
      { onError: (e) => setErr(e.message) },
    );
  };

  const notes = (
    [
      ['client', order.customerNote],
      ['delivery', order.deliveryNote],
      ['internal', order.internalNote],
    ] as const
  ).filter((x) => x[1]);

  return (
    <div className="qd2-main qd3">
      {notes.length > 0 && (
        <div className="qd3-notes">
          {notes.map(([k, v]) => (
            <span key={k} className="qd3-note">
              <b>{t(`confirmation.d.note.${k}`)}</b>
              {v}
            </span>
          ))}
        </div>
      )}
      <div className="qd2-prod">
        <table className={`tbl qd2-tbl qd3-tbl qd4-ptbl ${lockedPrice ? 'qd4-lk' : ''}`}>
          <thead>
            <tr>
              <th>{t('confirmation.d.product')}</th>
              <th>{t('confirmation.d.variant')}</th>
              <th>{t('confirmation.d.qty')}</th>
              <th className="num qd3-pu">{lockedPrice ? '' : t('confirmation.d.unit')}</th>
              <th className="num">{t('confirmation.d.price')}</th>
              <th className="ck" />
            </tr>
          </thead>
          <tbody>
            {L.length ? (
              L.map((l, i) => {
                const p = P.get(l.productId);
                const vs = (p?.variants ?? []).filter((v) => v.title !== '');
                const pk = p?.packs.find((x) => x.qty === l.qty && Math.round(x.price / x.qty) === Math.round(l.unitPrice));
                const fixed = lockedPrice || !!p?.fixedPrice;
                return (
                  <tr key={`${l.productId}-${l.variantId}-${i}`}>
                    <td data-l={t('confirmation.d.product')} className="qd3-name">
                      <b>{l.name}</b> {l.isUpsell && <span className="chip">upsell</span>} {pk && <span className="chip qd2-pk">pack {l.qty}</span>}
                    </td>
                    <td data-l={t('confirmation.d.variant')}>
                      {vs.length > 1 || (vs.length === 1 && vs[0].id !== l.variantId) ? (
                        <select className="qd2-var" aria-label={t('confirmation.d.variant')} disabled={!editable} value={l.variantId ?? ''} onChange={(e) => setVar(i, Number(e.target.value))}>
                          {vs.map((v) => (
                            <option key={v.id} value={v.id}>
                              {p!.name} {v.title}
                              {L.some((x, k) => k !== i && x.variantId === v.id) ? ` ${t('confirmation.d.already')}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="qd3-v">{l.variantTitle || '—'}</span>
                      )}
                    </td>
                    <td data-l={t('confirmation.d.qty')}>
                      <div className="qd2-qty">
                        <button type="button" className="btn qd2-st" aria-label={t('confirmation.d.minus')} disabled={!editable || l.qty <= 1} onClick={() => upd(i, { qty: Math.max(1, l.qty - 1) })}>
                          −
                        </button>
                        <input type="number" min={1} step={1} className="qd2-q ltr" aria-label={t('confirmation.d.qty')} disabled={!editable} value={l.qty} onChange={(e) => upd(i, { qty: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
                        <button type="button" className="btn qd2-st" aria-label={t('confirmation.d.plus')} disabled={!editable} onClick={() => upd(i, { qty: l.qty + 1 })}>
                          +
                        </button>
                      </div>
                    </td>
                    <td className="num qd3-pu" data-l={t('confirmation.d.unit')}>
                      {lockedPrice ? null : (
                        <input type="number" min={0} className="qd2-p ltr" aria-label={t('confirmation.d.unit')} disabled={!editable || fixed} value={l.unitPrice} onChange={(e) => upd(i, { unitPrice: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                      )}
                    </td>
                    <td className="num" data-l={t('confirmation.d.price')}>
                      <b className="ltr">{da(l.qty * l.unitPrice)}</b>
                      {l.qty > 1 && (
                        <small className="ltr">
                          {l.qty} × {da(l.unitPrice)}
                        </small>
                      )}
                    </td>
                    <td className="ck">
                      {editable && (
                        <button type="button" className="icon-btn qrm" aria-label={t('confirmation.d.remove', { name: l.name })} title={t('confirmation.d.removeShort')} onClick={() => setL((cur) => cur.filter((_, k) => k !== i))}>
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  {t('confirmation.d.noProduct')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="qd3-addrow">
          {editable ? <AddProduct catalog={cat.data} lines={L} onPick={add} /> : <p className="muted small">{t('confirmation.d.locked')}</p>}
          <button type="button" className="linkish qd3-hist" onClick={() => openOrder(order.id)}>
            {t('confirmation.d.history')}
          </button>
        </div>
        {editable && (packs.length > 0 || linked.size > 0) && (
          <div className="qd2-offers">
            {packs.length > 0 && (
              <div className="qd2-orow">
                <span className="qd2-ol">{t('confirmation.d.packs')}</span>
                {packs.map((x, k) => {
                  const l = L[x.i];
                  return (
                    <button key={k} type="button" className="qd2-chip pk" onClick={() => upd(x.i, { qty: x.qty, unitPrice: Math.round(x.price / x.qty) })}>
                      <b>
                        {x.qty} × {l.name}
                        {l.variantTitle ? ` ${l.variantTitle}` : ''}
                      </b>
                      <span className="ltr">{da(x.price)}</span>
                      {x.save > 0 && <small className="ltr">−{da(x.save)}</small>}
                    </button>
                  );
                })}
              </div>
            )}
            {linked.size > 0 && (
              <div className="qd2-orow">
                <span className="qd2-ol">{t('confirmation.d.with')}</span>
                {[...linked.values()].map((p) => (
                  <button key={p.id} type="button" className="qd2-chip rel" onClick={() => add(p, p.variants[0]?.id ?? null)}>
                    <b>+ {p.name}</b>
                    <span className="ltr">{da(priceOf(p, p.variants[0]?.id ?? null))}</span>
                    {p.variants.length > 1 && <small>{t('confirmation.d.variants', { n: p.variants.length })}</small>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="qd2-tot">
          <table className="tbl qd4-tbl">
            <thead>
              <tr>
                <th>{t('confirmation.d.type')}</th>
                <th className="num">{t('confirmation.d.fee')}</th>
                {disc > 0 && <th className="num">{t('confirmation.d.discount')}</th>}
                <th className="num">{t('confirmation.d.total')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-l={t('confirmation.d.type')}>
                  {order.isStopdesk ? t('confirmation.d.desk') : t('confirmation.d.home')}
                  {gf !== null && gf !== fee && editable && (
                    <button type="button" className="linkish qd2-gf" onClick={() => setFee(gf)}>
                      {t('confirmation.d.grid', { v: da(gf) })}
                    </button>
                  )}
                </td>
                <td className="num qd4-fee" data-l={t('confirmation.d.fee')}>
                  <label className="qd4-fv ltr">
                    <input type="number" min={0} className="qd2-p" aria-label={t('confirmation.d.fee')} disabled={!editable} value={fee} onChange={(e) => setFee(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                    <b>DA</b>
                  </label>
                </td>
                {disc > 0 && (
                  <td className="num ltr" data-l={t('confirmation.d.discount')}>
                    − {da(disc)}
                  </td>
                )}
                <td className="num qd4-total" data-l={t('confirmation.d.total')}>
                  <b className="ltr">{da(sub + fee - disc)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {err && <p className="form-err">{err}</p>}
        {dirty && (
          <div className="qd2-save">
            <span className="muted small">{t('confirmation.d.modified')}</span>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setL(initial);
                setFee(order.deliveryFee);
                setErr('');
              }}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="btn small primary" disabled={save.isPending} onClick={onSave}>
              {t('common.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** "+ Ajouter un produit : tapez le nom, la couleur ou le SKU…" — Enter adds the first match. */
function AddProduct({ catalog, lines, onPick }: { catalog: Catalog; lines: Line[]; onPick: (p: Prod, vid: number | null) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [k, setK] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const opts = useMemo(
    () =>
      catalog
        .filter((p) => !p.isService)
        .flatMap((p) => (p.variants.length ? p.variants : [{ id: null as unknown as number, title: '', sku: p.sku, price: null }]).map((v) => ({ p, v, label: `${p.name}${v.title ? ` · ${v.title}` : ''}`, hay: norm(`${p.name} ${v.title} ${v.sku} ${p.sku}`) }))),
    [catalog],
  );
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  const hits = norm(q).trim().length < 2 ? [] : opts.filter((o) => words.every((w) => o.hay.includes(w))).slice(0, 12);
  const pick = (o: (typeof opts)[number]) => {
    onPick(o.p, o.v.id ?? null);
    setQ('');
    ref.current?.focus();
  };
  return (
    <div className="combo qd2-add">
      <input
        ref={ref}
        type="search"
        className="qd2-add-in"
        autoComplete="off"
        placeholder={t('confirmation.d.addPh')}
        aria-label={t('confirmation.d.add')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setK(0);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!hits.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setK((k + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(hits[k]);
          } else if (e.key === 'Escape') setQ('');
        }}
      />
      {open && hits.length > 0 && (
        <div className="combo-list" role="listbox">
          {hits.map((o, i) => (
            <button
              key={`${o.p.id}-${o.v.id}`}
              type="button"
              className={i === k ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              <span>
                {o.label}
                {lines.some((l) => l.productId === o.p.id && l.variantId === (o.v.id ?? null)) && <small className="muted"> · {t('confirmation.d.inOrder')}</small>}
              </span>
              <span className="muted ltr">{da(o.v.price ?? o.p.price)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
