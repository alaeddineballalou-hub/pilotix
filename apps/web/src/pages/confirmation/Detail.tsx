// The open row of the queue (".qdetail"): notes, products (variant / qty / price), add a product,
// delivery price and total, packs and linked products, save bar. Saved with orders.update (version check).
import { FOLLOW_LOCKED, Order } from '@pilotix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { da, wilayaName } from '../../lib/format';
import { Icon, Loading } from '../../ui/kit';
import { createPortal } from 'react-dom';
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
  const [desk, setDesk] = useState(order.isStopdesk);
  const [deskId, setDeskId] = useState<number | null>(order.stopdeskId);
  const [picker, setPicker] = useState(false);
  const [modeTouched, setModeTouched] = useState(false);
  const opts = useRpc('confirmation.deskOptions', { wilayaId: order.wilayaId }, { staleTime: 5 * 60_000 });
  const modeFee = useRpc('confirmation.gridFee', { id: order.id, isStopdesk: desk }, { staleTime: 60_000 });
  useEffect(() => {
    setL(initial);
    setFee(order.deliveryFee);
    setDesk(order.isStopdesk);
    setDeskId(order.stopdeskId);
    setModeTouched(false);
    setErr('');
  }, [initial, order.deliveryFee, order.isStopdesk, order.stopdeskId]);
  // switching Domicile / Bureau puts that type's price from the grid
  useEffect(() => {
    if (modeTouched && modeFee.data?.fee != null) setFee(modeFee.data.fee);
  }, [modeTouched, modeFee.data]);
  const save = useAction('orders.update', { success: t('confirmation.d.saved', { ref: order.ref }), silent: true });

  if (!cat.data) return <Loading />;
  const P = new Map(cat.data.map((p) => [p.id, p]));
  const editable = !(order.followStatus && FOLLOW_LOCKED.includes(order.followStatus)) && !order.shippedAt;
  const lockedPrice = !order.isExchange;
  const dirty = key(L) !== key(initial) || fee !== order.deliveryFee || desk !== order.isStopdesk || (desk && deskId !== order.stopdeskId);
  const chosen = opts.data?.desks.find((d) => d.id === deskId) ?? null;
  const company = opts.data?.companies.find((c) => c.id === (chosen?.companyId ?? order.companyId)) ?? null;
  // can it be delivered? Bureau: the chosen bureau's company serves it. Domicile: the order's company (or any active one) delivers here.
  const served: boolean | null = !opts.data ? null : desk ? (chosen ? chosen.served : null) : company ? company.home : opts.data.companies.some((c) => c.home);
  const stockOf = (l: Line) => {
    const p = P.get(l.productId);
    if (!p || p.isService) return null;
    const vs = l.variantId ? p.variants.filter((v) => v.id === l.variantId) : p.variants;
    return vs.length ? vs.reduce((n, v) => n + (v.stock ?? 0), 0) : null;
  };
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
    if (desk && !deskId) {
      setErr(t('confirmation.dl.needDesk'));
      setPicker(true);
      return;
    }
    setErr('');
    const mode =
      desk !== order.isStopdesk || (desk && deskId !== order.stopdeskId)
        ? { isStopdesk: desk, stopdeskId: desk ? deskId : null, ...(desk && chosen ? { companyId: chosen.companyId } : {}) }
        : {};
    save.mutate(
      { id: order.id, version: order.version, deliveryFee: fee, ...mode, ...(key(L) !== key(initial) ? { items: L.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, isUpsell: l.isUpsell })) } : {}) },
      { onError: (e) => setErr(e.message) },
    );
  };
  const setMode = (d: boolean) => {
    if (!editable || d === desk) return;
    setDesk(d);
    setModeTouched(true);
    setErr('');
    if (d && !deskId) setPicker(true);
  };

  const notes = (
    [
      ['client', order.customerNote],
      ['delivery', order.deliveryNote],
      ['internal', order.internalNote],
    ] as const
  ).filter((x) => x[1]);

  return (
    <div className="qd2-main qd3 qd5">
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
                      {(() => {
                        const n = stockOf(l);
                        if (n === null) return null;
                        return n >= l.qty ? (
                          <span className="qd5-stock ok">
                            <i />
                            {t('confirmation.dl.inStock', { n })}
                          </span>
                        ) : (
                          <span className="qd5-stock bad">
                            <i />
                            {t('confirmation.dl.outStock', { n })}
                          </span>
                        );
                      })()}
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
      </div>
      <aside className="qd5-side" aria-label={t('confirmation.dl.title')}>
        <div className="qd5-h">{t('confirmation.dl.title')}</div>
        <div className="qd5-seg" role="radiogroup" aria-label={t('confirmation.d.type')}>
          <button type="button" role="radio" aria-checked={!desk} className={!desk ? 'on' : ''} disabled={!editable} onClick={() => setMode(false)}>
            <Icon name="home" />
            {t('confirmation.d.home')}
          </button>
          <button type="button" role="radio" aria-checked={desk} className={desk ? 'on' : ''} disabled={!editable} onClick={() => setMode(true)}>
            <Icon name="building" />
            {t('confirmation.d.desk')}
          </button>
        </div>
        {desk && (
          <div className={`qd5-desk ${chosen ? '' : 'miss'}`}>
            {chosen ? (
              <>
                <div>
                  <b>{chosen.name}</b>
                  <small>
                    {chosen.companyName} · {chosen.commune || wilayaName(order.wilayaId)}
                  </small>
                  {chosen.address && <small>{chosen.address}</small>}
                </div>
                {editable && (
                  <button type="button" className="linkish" onClick={() => setPicker(true)}>
                    {t('confirmation.dl.change')}
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="btn small primary" disabled={!editable} onClick={() => setPicker(true)}>
                {t('confirmation.dl.pick')}
              </button>
            )}
          </div>
        )}
        {served !== null && (
          <div className={`qd5-served ${served ? 'ok' : 'bad'}`}>
            <i />
            {served ? t('confirmation.dl.ok') : t('confirmation.dl.no')}
            {company && !desk && <small>{company.name}</small>}
          </div>
        )}
        <dl className="qd5-sum">
          <div>
            <dt>{t('confirmation.d.sub')}</dt>
            <dd className="ltr">{da(sub)}</dd>
          </div>
          <div>
            <dt>
              {t('confirmation.d.fee')}
              {modeFee.data?.fee != null && modeFee.data.fee !== fee && editable && (
                <button type="button" className="linkish qd2-gf" onClick={() => setFee(modeFee.data!.fee!)}>
                  {t('confirmation.d.grid', { v: da(modeFee.data.fee) })}
                </button>
              )}
            </dt>
            <dd>
              <label className="qd4-fv ltr">
                <input type="number" min={0} className="qd2-p" aria-label={t('confirmation.d.fee')} disabled={!editable} value={fee} onChange={(e) => setFee(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                <b>DA</b>
              </label>
            </dd>
          </div>
          {disc > 0 && (
            <div>
              <dt>{t('confirmation.d.discount')}</dt>
              <dd className="ltr">− {da(disc)}</dd>
            </div>
          )}
          <div className="qd5-total">
            <dt>{t('confirmation.d.total')}</dt>
            <dd className="ltr">{da(sub + fee - disc)}</dd>
          </div>
        </dl>
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
      </aside>
      {picker && opts.data && (
        <DeskPicker
          wilaya={wilayaName(order.wilayaId)}
          desks={opts.data.desks}
          current={deskId}
          onPick={(id) => {
            setDeskId(id);
            setPicker(false);
            setErr('');
          }}
          onClose={() => setPicker(false)}
        />
      )}
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

type Desk = { id: number; companyId: number; companyName: string; name: string; commune: string; address: string; served: boolean };

/** Window on the left side: the bureaus of the wilaya, green when the company delivers there, red when not. */
function DeskPicker({ wilaya, desks, current, onPick, onClose }: { wilaya: string; desks: Desk[]; current: number | null; onPick: (id: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  const list = desks.filter((d) => words.every((w) => norm(`${d.name} ${d.companyName} ${d.commune} ${d.address}`).includes(w)));
  const groups = [...new Set(list.map((d) => d.companyName))];
  return createPortal(
    <div className="qd5-pick-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qd5-pick" role="dialog" aria-label={t('confirmation.dl.pickTitle', { w: wilaya })}>
        <div className="qd5-pick-h">
          <div>
            <b>{t('confirmation.dl.pickTitle', { w: wilaya })}</b>
            <small>{t('confirmation.dl.pickSub', { n: desks.length })}</small>
          </div>
          <button type="button" className="px-hist-x" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <input type="search" className="qd5-pick-q" placeholder={t('confirmation.dl.searchPh')} aria-label={t('confirmation.dl.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="qd5-pick-list">
          {list.length === 0 && <p className="muted small">{t('confirmation.dl.none')}</p>}
          {groups.map((g) => (
            <div key={g} className="qd5-pick-g">
              <div className="qd5-pick-gh">{g}</div>
              {list
                .filter((d) => d.companyName === g)
                .map((d) => (
                  <button key={d.id} type="button" className={`qd5-pick-it ${d.id === current ? 'on' : ''} ${d.served ? '' : 'no'}`} disabled={!d.served} title={d.served ? undefined : t('confirmation.dl.no')} onClick={() => onPick(d.id)}>
                    <span>
                      <b>{d.name}</b>
                      <small>{[d.commune, d.address].filter(Boolean).join(' · ')}</small>
                    </span>
                    <span className={`qd5-served mini ${d.served ? 'ok' : 'bad'}`}>
                      <i />
                      {d.served ? t('confirmation.dl.okShort') : t('confirmation.dl.noShort')}
                    </span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
