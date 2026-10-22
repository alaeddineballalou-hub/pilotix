// The open row of the queue (".qdetail"): notes, products (variant / qty / price), add a product,
// delivery price and total, packs and linked products, save bar. Saved with orders.update (version check).
import { CANCEL_REASONS, FOLLOW_LOCKED, Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../lib/backend';
import { defaultNext } from './shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { da, fromLocalInput, wilayaName } from '../../lib/format';
import { Icon, Loading, StatusBadge } from '../../ui/kit';
import { Float } from '../../ui/Float';
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
  const qc = useQueryClient();
  const cat = useCatalog();
  const grid = useRpc('confirmation.gridFee', { id: order.id }, { staleTime: 60_000 });
  const initial = useMemo<Line[]>(() => order.items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.name, variantTitle: i.variantTitle, qty: i.qty, unitPrice: i.unitPrice, isUpsell: i.isUpsell })), [order]);
  const [L, setL] = useState<Line[]>(initial);
  const [fee, setFee] = useState(order.deliveryFee);
  const [err, setErr] = useState('');
  const [desk, setDesk] = useState(order.isStopdesk);
  const [deskId, setDeskId] = useState<number | null>(order.stopdeskId);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const deskRef = useRef<HTMLElement>(null);
  const [disc, setDisc] = useState(order.discount);
  const [nOrigin, setNOrigin] = useState(order.customerNote ?? '');
  const [nLivreur, setNLivreur] = useState(order.deliveryNote ?? '');
  const [nTeam, setNTeam] = useState(order.internalNote ?? '');
  const [noteTab, setNoteTab] = useState<'origin' | 'livreur' | 'team'>('origin');
  useEffect(() => {
    setDisc(order.discount);
    setNOrigin(order.customerNote ?? '');
    setNLivreur(order.deliveryNote ?? '');
    setNTeam(order.internalNote ?? '');
  }, [order.discount, order.customerNote, order.deliveryNote, order.internalNote]);
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

  if (!cat.data) return <Loading />;
  const P = new Map(cat.data.map((p) => [p.id, p]));
  const editable = !(order.followStatus && FOLLOW_LOCKED.includes(order.followStatus)) && !order.shippedAt;
  const lockedPrice = !order.isExchange;
  const notesChanged = nOrigin !== (order.customerNote ?? '') || nLivreur !== (order.deliveryNote ?? '') || nTeam !== (order.internalNote ?? '');
  const dirty = key(L) !== key(initial) || fee !== order.deliveryFee || disc !== order.discount || notesChanged || desk !== order.isStopdesk || (desk && deskId !== order.stopdeskId);
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
  // the biggest discount the customer can get: each product's limit × quantity (a product without limit allows the whole cart)
  const maxDisc = L.some((l) => P.get(l.productId)?.maxDiscount == null) ? sub : L.reduce((s, l) => s + (P.get(l.productId)?.maxDiscount ?? 0) * l.qty, 0);
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

  const setMode = (d: boolean) => {
    if (!editable || d === desk) return;
    setDesk(d);
    setModeTouched(true);
    setErr('');
    if (d && !deskId) setPicker(true);
  };


  const out = L.filter((l) => {
    const n = stockOf(l);
    return n !== null && n < l.qty;
  });
  const cartBody = L.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, isUpsell: l.isUpsell }));
  /** Saves the cart and the delivery when they changed (before any status change). Returns false when it could not. */
  const saveFirst = async (): Promise<boolean> => {
    if (!L.length) return setErr(t('confirmation.d.keepOne')), false;
    if (desk && !deskId) return setErr(t('confirmation.dl.needDesk')), setPicker(true), false;
    if (!dirty) return true;
    const mode = desk !== order.isStopdesk || (desk && deskId !== order.stopdeskId) ? { isStopdesk: desk, stopdeskId: desk ? deskId : null, ...(desk && chosen ? { companyId: chosen.companyId } : {}) } : {};
    try {
      if (disc > maxDisc) return setErr(t('confirmation.d6.discTooBig', { v: da(maxDisc) })), false;
      const notes = notesChanged ? { customerNote: nOrigin.trim() || null, deliveryNote: nLivreur.trim() || null, internalNote: nTeam.trim() || null } : {};
      await rpc('orders.update', { id: order.id, version: order.version, deliveryFee: fee, discount: disc, ...notes, ...mode, ...(key(L) !== key(initial) ? { items: cartBody } : {}) });
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    }
  };
  const run = async (fn: () => Promise<unknown>, okMsg: string, tone: 'ok' | 'bad' = 'ok') => {
    setErr('');
    setBusy(true);
    try {
      if (!(await saveFirst())) return false;
      await fn();
      toast(okMsg, tone);
      qc.invalidateQueries();
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const confirm = () => run(() => rpc('orders.setConf', { ids: [order.id], status: 'confirmed' }), t('confirmation.d6.confirmed', { ref: order.ref }));

  return (
    <div className="qd2-main qd3 qd5 qd6">
      <div className="qd6-grid">
      <div className="qd6-left">
        <section className="qd6-card qd6-notes" aria-label={t('confirmation.d6.notes')}>
          {(() => {
            const notes = [
              ['origin', 'message', nOrigin, setNOrigin],
              ['livreur', 'truck', nLivreur, setNLivreur],
              ['team', 'users', nTeam, setNTeam],
            ] as const;
            const cur = notes.find((x) => x[0] === noteTab) ?? notes[0];
            return (
              <>
                <div className="qd6-ntabs" role="tablist">
                  {notes.map(([k, icon, v]) => (
                    <button key={k} type="button" role="tab" id={`qd6-nt-${order.id}-${k}`} aria-selected={k === cur[0]} className={k === cur[0] ? 'on' : ''} onClick={() => setNoteTab(k)}>
                      <Icon name={icon} />
                      {t(`confirmation.d6.note.${k}`)}
                      {v.trim() && <span className="qd6-ndot" aria-label="•" />}
                    </button>
                  ))}
                </div>
                <textarea
                  key={cur[0]}
                  className="qd6-ntext"
                  role="tabpanel"
                  aria-labelledby={`qd6-nt-${order.id}-${cur[0]}`}
                  rows={3}
                  value={cur[2]}
                  maxLength={1000}
                  placeholder={t(`confirmation.d6.notePh.${cur[0]}`)}
                  onChange={(e) => cur[3](e.target.value)}
                />
              </>
            );
          })()}
        </section>
        <section className="qd6-card">
          <div className="qd6-h">
            {t('confirmation.d6.cart')} <span className="qd6-cnt">{t('confirmation.d6.nProducts', { count: L.length })}</span>
            <button type="button" className="linkish qd6-hist" onClick={() => openOrder(order.id)}>
              {t('confirmation.d.history')}
            </button>
          </div>
          {L.length === 0 && <p className="muted small qd6-empty">{t('confirmation.d.noProduct')}</p>}
          {L.map((l, i) => {
            const p = P.get(l.productId);
            const vs = (p?.variants ?? []).filter((v) => v.title !== '');
            const pk = p?.packs.find((x) => x.qty === l.qty && Math.round(x.price / x.qty) === Math.round(l.unitPrice));
            const fixed = lockedPrice || !!p?.fixedPrice;
            const n = stockOf(l);
            return (
              <div key={`${l.productId}-${l.variantId}-${i}`} className="qd6-line">
                <span className="qd6-thumb" aria-hidden="true">
                  <Icon name="package" />
                </span>
                <div className="qd6-pn">
                  <b>
                    {l.name} {l.isUpsell && <span className="chip">upsell</span>} {pk && <span className="chip qd2-pk">pack {l.qty}</span>}
                  </b>
                  <div className="qd6-meta">
                    {p && (vs.length > 1 || (vs.length === 1 && vs[0].id !== l.variantId)) ? (
                      <VariantMenu product={p} value={l.variantId} lines={L} lineIndex={i} disabled={!editable} onPick={(vid) => setVar(i, vid)} />
                    ) : (
                      l.variantTitle && <span className="qd6-vt">{l.variantTitle}</span>
                    )}
                    {p && <span className="ltr">{p.variants.find((v) => v.id === l.variantId)?.sku ?? p.sku}</span>}
                  </div>
                </div>
                {n !== null && (
                  <span className={`qd5-stock ${n >= l.qty ? 'ok' : 'bad'}`}>
                    <i />
                    {n >= l.qty ? t('confirmation.d6.inStock', { n }) : t('confirmation.d6.outStock', { n })}
                  </span>
                )}
                <div className="qd2-qty">
                  <button type="button" className="btn qd2-st" aria-label={t('confirmation.d.minus')} disabled={!editable || l.qty <= 1} onClick={() => upd(i, { qty: Math.max(1, l.qty - 1) })}>
                    −
                  </button>
                  <input type="number" min={1} step={1} className="qd2-q ltr" aria-label={t('confirmation.d.qty')} disabled={!editable} value={l.qty} onChange={(e) => upd(i, { qty: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
                  <button type="button" className="btn qd2-st" aria-label={t('confirmation.d.plus')} disabled={!editable} onClick={() => upd(i, { qty: l.qty + 1 })}>
                    +
                  </button>
                </div>
                <div className="qd6-price">
                  {lockedPrice || fixed ? (
                    <b className="ltr">{da(l.qty * l.unitPrice)}</b>
                  ) : (
                    <label className="qd6-pu ltr">
                      <input type="number" min={0} className="qd2-p" aria-label={t('confirmation.d.unit')} disabled={!editable} value={l.unitPrice} onChange={(e) => upd(i, { unitPrice: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                    </label>
                  )}
                  {l.qty > 1 && (
                    <small className="ltr">
                      {l.qty} × {da(l.unitPrice)}
                    </small>
                  )}
                </div>
                {editable ? (
                  <button type="button" className="qd6-rm" aria-label={t('confirmation.d.remove', { name: l.name })} title={t('confirmation.d.removeShort')} onClick={() => setL((cur) => cur.filter((_, k) => k !== i))}>
                    <Icon name="x" />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
          <div className="qd6-add">{editable ? <AddProduct catalog={cat.data} lines={L} onPick={add} /> : <p className="muted small">{t('confirmation.d.locked')}</p>}</div>
          {editable && (packs.length > 0 || linked.size > 0) && (
            <div className="qd6-offers">
              <div className="qd6-h sub">
                <Icon name="sparkles" />
                {t('confirmation.d6.offer')}
              </div>
              <div className="qd6-chips">
                {packs.map((x, k) => {
                  const l = L[x.i];
                  return (
                    <button key={`p${k}`} type="button" className="qd6-chip" onClick={() => upd(x.i, { qty: x.qty, unitPrice: Math.round(x.price / x.qty) })}>
                      <span className="qd6-plus">
                        <Icon name="layers" />
                      </span>
                      <span>
                        <b>
                          {t('confirmation.d6.pack', { n: x.qty })} {l.name}
                          {l.variantTitle ? ` ${l.variantTitle}` : ''}
                        </b>
                        <small className="ltr">
                          {da(x.price)}
                          {x.save > 0 && <span className="qd6-save"> · −{da(x.save)}</span>}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {[...linked.values()].map((p) => (
                  <button key={p.id} type="button" className="qd6-chip" onClick={() => add(p, p.variants[0]?.id ?? null)}>
                    <span className="qd6-plus">
                      <Icon name="plus" />
                    </span>
                    <span>
                      <b>{p.name}</b>
                      <small className="ltr">
                        {da(priceOf(p, p.variants[0]?.id ?? null))}
                        {p.variants.length > 1 ? ` · ${t('confirmation.d.variants', { n: p.variants.length })}` : ` · ${t('confirmation.d6.often')}`}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="qd6-card qd6-deliv" ref={deskRef}>
          <div className="qd6-h">{t('confirmation.dl.title')}</div>
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
          {desk ? (
            chosen ? (
              <div className="qd6-desk click" role="button" tabIndex={editable ? 0 : -1} onClick={() => editable && setPicker((o) => !o)} onKeyDown={(e) => e.key === 'Enter' && editable && setPicker(true)}>
                <span>
                  <b>{chosen.name}</b> <small>· {[chosen.address, chosen.commune || wilayaName(order.wilayaId)].filter(Boolean).join(' · ')}</small>
                </span>
                <span className={`qd5-served mini ${chosen.served ? 'ok' : 'bad'}`}>
                  <i />
                  {chosen.served ? t('confirmation.dl.ok') : t('confirmation.dl.no')}
                </span>
                {editable && <Icon name="chevron" />}
              </div>
            ) : (
              <div className="qd6-desk miss click" role="button" tabIndex={editable ? 0 : -1} onClick={() => editable && setPicker((o) => !o)} onKeyDown={(e) => e.key === 'Enter' && editable && setPicker(true)}>
                {t('confirmation.d6.noDesk')}
                <Icon name="chevron" />
              </div>
            )
          ) : (
            <div className="qd6-desk">
              <span>
                <b>{wilayaName(order.wilayaId)}</b> <small>· {[order.commune, company?.name].filter(Boolean).join(' · ')}</small>
              </span>
              {served !== null && (
                <span className={`qd5-served mini ${served ? 'ok' : 'bad'}`}>
                  <i />
                  {served ? t('confirmation.dl.ok') : t('confirmation.dl.no')}
                </span>
              )}
            </div>
          )}
          <div className="qd6-fee">
            <span className="qd6-lab">{t('confirmation.d6.fee')}</span>
            <label className="qd6-dv ltr">
              <input type="number" min={0} style={{ ['--w' as string]: String(fee).length }} aria-label={t('confirmation.d.fee')} disabled={!editable} value={fee} onChange={(e) => setFee(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
              <span className="qd6-unit">{da(0).replace(/^[\d\s\u00a0\u202f]+/, '')}</span>
            </label>
            {modeFee.data?.fee != null && modeFee.data.fee !== fee && editable && (
              <button type="button" className="linkish qd2-gf" onClick={() => setFee(modeFee.data!.fee!)}>
                {t('confirmation.d.grid', { v: da(modeFee.data.fee) })}
              </button>
            )}
          </div>
        </section>
      </div>
      <aside className="qd6-rail" aria-label={t('confirmation.d6.decision')}>
        <dl className="qd5-sum">
          <div>
            <dt>{t('confirmation.d.sub')}</dt>
            <dd className="ltr">{da(sub)}</dd>
          </div>
          <div>
            <dt>{desk ? t('confirmation.d6.feeDesk') : t('confirmation.d6.feeHome')}</dt>
            <dd className="ltr">{da(fee)}</dd>
          </div>
          <div className={`qd6-disc${disc > maxDisc ? ' over' : ''}`}>
            <dt>
              {t('confirmation.d.discount')}
              <small>{t('confirmation.d6.maxDisc', { v: da(maxDisc) })}</small>
            </dt>
            <dd>
              <label className="qd6-dv ltr">
                <span className="qd6-minus">−</span>
                <input type="number" min={0} max={maxDisc} step={50} style={{ ['--w' as string]: String(disc).length }} aria-label={t('confirmation.d.discount')} disabled={!editable} value={disc} onChange={(e) => setDisc(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                <span className="qd6-unit">{da(0).replace(/^[\d\s\u00a0\u202f]+/, '')}</span>
              </label>
            </dd>
          </div>
          <div className="qd5-total">
            <dt>{t('confirmation.d.total')}</dt>
            <dd className="ltr">{da(sub + fee - disc)}</dd>
          </div>
        </dl>
        {out.length > 0 && (
          <div className="qd6-warn" role="alert">
            <Icon name="alert" />
            <span>{t('confirmation.d6.warn', { names: out.map((l) => l.name).join(', ') })}</span>
          </div>
        )}
        {err && <p className="form-err">{err}</p>}
        <div className="qd6-fill" aria-hidden="true" />
        {order.confStatus !== 'confirmed' && (
          <>
            <button type="button" className="qd6-cta" disabled={busy || !editable} onClick={confirm}>
              <Icon name="checkcircle" />
              {t('confirmation.d6.confirm')}
            </button>
            <p className="qd6-hint">{t('confirmation.d6.hint')}</p>
          </>
        )}
        {dirty && (
          <div className="qd6-dirty">
            <span>{t('confirmation.d.modified')}</span>
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setL(initial);
                setFee(order.deliveryFee);
                setDesk(order.isStopdesk);
                setDeskId(order.stopdeskId);
                setDisc(order.discount);
                setNOrigin(order.customerNote ?? '');
                setNLivreur(order.deliveryNote ?? '');
                setNTeam(order.internalNote ?? '');
                setErr('');
              }}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => run(async () => {}, t('confirmation.d.saved', { ref: order.ref }))}>
              {t('common.save')}
            </button>
          </div>
        )}
        <StatusMenu order={order} busy={busy} run={run} />
      </aside>
      </div>
      {picker && opts.data && (
        <DeskMenu
          anchor={deskRef}
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

type Step = null | 'menu' | 'cancelled' | 'postponed' | 'callback';
/** "Changer le statut": a small menu opening upwards; Annulée asks the reason, Reportée the date, Rappel the date and hour. */
function StatusMenu({ order, busy, run }: { order: Order; busy: boolean; run: (fn: () => Promise<unknown>, ok: string, tone?: 'ok' | 'bad') => Promise<boolean> }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!step) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setStep(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setStep(null);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [step]);
  const label = (c: string) => t(`status.conf.${c}`);
  const nextTry = Math.min(9, (order.attempts || 0) + 1);
  const done = (ok: boolean) => ok && (setStep(null), setReason(''), setNote(''));
  const pickAsk = (s: 'cancelled' | 'postponed' | 'callback') => {
    setStep(s);
    setReason('');
    setNote('');
    setWhen(s === 'callback' ? defaultNext('callback') : defaultNext('postponed').slice(0, 10));
  };
  const direct = async (status: 'busy' | 'duplicate' | 'wrong_number' | 'fake' | 'try') => {
    const ok =
      status === 'try'
        ? await run(() => rpc('confirmation.setTry', { ids: [order.id], n: nextTry }), `${order.ref} → ${t('confirmation.try', { n: String(nextTry).padStart(2, '0') })}`)
        : await run(() => rpc('orders.setConf', { ids: [order.id], status, reason: status === 'wrong_number' || status === 'fake' ? label(status) : null }), `${order.ref} → ${label(status)}`, status === 'busy' || status === 'duplicate' ? 'ok' : 'bad');
    done(ok);
  };
  const submitAsk = async () => {
    if (step === 'cancelled') {
      if (!reason) return;
      done(await run(() => rpc('orders.setConf', { ids: [order.id], status: 'cancelled', reason: t(`status.cancelReason.${reason}`), note: note.trim() || null }), `${order.ref} → ${label('cancelled')}`, 'bad'));
    } else if (step === 'postponed' || step === 'callback') {
      if (!when) return;
      const at = step === 'postponed' ? `${when}T10:00` : when;
      done(await run(() => rpc('orders.setConf', { ids: [order.id], status: step, nextCallAt: fromLocalInput(at), note: note.trim() || null }), `${order.ref} → ${label(step)}`));
    }
  };
  const item = (icon: string, cls: string, text: string, hint: string | null, on: () => void) => (
    <button type="button" role="menuitem" className={`qd6-mi ${cls}`} disabled={busy} onClick={on}>
      <Icon name={icon} />
      {text}
      {hint && <small>{hint}</small>}
    </button>
  );
  const shortDate = (d: string) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
  return (
    <div className="qd6-dd" ref={box}>
      {step === 'menu' && (
        <div className="qd6-mini" role="menu">
          {item('phoneoff', 'c-mid', label('no_answer'), t('confirmation.d6.attempt', { n: nextTry }), () => direct('try'))}
          {item('phone', 'c-mid', label('busy'), null, () => direct('busy'))}
          {item('timer', 'c-info', t('confirmation.d6.callback'), t('confirmation.d6.dateHour'), () => pickAsk('callback'))}
          {item('calendar', 'c-info', label('postponed'), t('confirmation.d6.date'), () => pickAsk('postponed'))}
          <div className="qd6-msep" />
          {item('ban', 'c-bad', label('cancelled'), t('confirmation.d6.reason'), () => pickAsk('cancelled'))}
          {item('xcircle', 'c-off', label('wrong_number'), null, () => direct('wrong_number'))}
          {item('copy', 'c-off', label('duplicate'), null, () => direct('duplicate'))}
          {item('alert', 'c-off', label('fake'), null, () => direct('fake'))}
        </div>
      )}
      {(step === 'cancelled' || step === 'postponed' || step === 'callback') && (
        <form
          className="qd6-ask"
          onSubmit={(e) => {
            e.preventDefault();
            submitAsk();
          }}
        >
          <div className={`qd6-askh ${step === 'cancelled' ? 'c-bad' : 'c-info'}`}>
            <Icon name={step === 'cancelled' ? 'ban' : step === 'callback' ? 'timer' : 'calendar'} />
            {t(`confirmation.d6.ask.${step}`)}
            <button type="button" className="linkish" onClick={() => setStep('menu')}>
              ‹ {t('common.back')}
            </button>
          </div>
          {step === 'cancelled' ? (
            <>
              <span className="qd6-lab">{t('confirmation.d6.reasonReq')}</span>
              <div className="qd6-reasons">
                {CANCEL_REASONS.map((r) => (
                  <button key={r} type="button" className={reason === r ? 'on' : ''} aria-pressed={reason === r} onClick={() => setReason(r)}>
                    {t(`status.cancelReason.${r}`)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <span className="qd6-lab">{step === 'callback' ? t('confirmation.d6.callWhen') : t('confirmation.d6.postWhen')}</span>
              <input type={step === 'callback' ? 'datetime-local' : 'date'} className="qd6-in ltr" value={when} required onChange={(e) => setWhen(e.target.value)} aria-label={t(`confirmation.d6.ask.${step}`)} />
            </>
          )}
          <input className="qd6-in" value={note} maxLength={300} placeholder={step === 'cancelled' ? t('confirmation.d6.detail') : t('confirmation.d6.noteOpt')} onChange={(e) => setNote(e.target.value)} />
          <div className="qd6-acts">
            <button type="button" className="btn small" onClick={() => setStep('menu')}>
              {t('common.back')}
            </button>
            {step === 'cancelled' ? (
              <button type="submit" className="btn small danger qd6-red" disabled={busy || !reason}>
                {t('confirmation.d6.ask.cancelled')}
              </button>
            ) : (
              <button type="submit" className="btn small primary" disabled={busy || !when}>
                {step === 'postponed' ? t('confirmation.d6.postTo', { d: shortDate(when) }) : t('confirmation.d6.callAt')}
              </button>
            )}
          </div>
        </form>
      )}
      <button type="button" className={`qd6-ddb ${step ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={!!step} onClick={() => setStep(step ? null : 'menu')}>
        <Icon name="list" />
        {t('confirmation.d6.change')}
        <span className="qd6-cur">
          <StatusBadge kind="conf" status={order.confStatus} />
          <Icon name="chevron" />
        </span>
      </button>
    </div>
  );
}

/** "+ Ajouter un produit": a menu with every product and variant (price, stock, remise), and under it the products often bought with the cart. */
function AddProduct({ catalog, lines, onPick }: { catalog: Catalog; lines: Line[]; onPick: (p: Prod, vid: number | null) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [k, setK] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  type Opt = { p: Prod; v: Prod['variants'][number] | null; label: string; hay: string; price: number; stock: number | null };
  const opts = useMemo<Opt[]>(
    () =>
      catalog
        .filter((p) => !p.isService)
        .flatMap((p) =>
          (p.variants.length ? p.variants : [null]).map((v) => ({
            p,
            v,
            label: v?.title ?? '',
            hay: norm(`${p.name} ${v?.title ?? ''} ${v?.sku ?? ''} ${p.sku}`),
            price: v?.price ?? p.price,
            stock: v ? (v.stock ?? null) : null,
          })),
        ),
    [catalog],
  );
  const inCart = new Set(lines.map((l) => l.productId));
  const linkedIds = [...new Set(lines.flatMap((l) => catalog.find((p) => p.id === l.productId)?.linked ?? []))].filter((id) => !inCart.has(id));
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  const hits = opts.filter((o) => words.every((w) => o.hay.includes(w)));
  const related = opts.filter((o) => linkedIds.includes(o.p.id) && (o.v === null || o.v.id === o.p.variants[0]?.id) && words.every((w) => o.hay.includes(w)));
  const list = [...hits.filter((o) => !linkedIds.includes(o.p.id)), ...related];
  const pick = (o: Opt) => {
    onPick(o.p, o.v?.id ?? null);
    setQ('');
    setOpen(false);
    ref.current?.blur();
  };
  const row = (o: Opt, i: number) => {
    const pk = o.p.packs[0];
    const save = pk ? o.price * pk.qty - pk.price : 0;
    const has = lines.some((l) => l.productId === o.p.id && l.variantId === (o.v?.id ?? null));
    return (
      <button key={`${o.p.id}-${o.v?.id ?? 0}`} type="button" role="option" aria-selected={i === k} className={`pxf-it ${i === k ? 'on' : ''}`} onMouseEnter={() => setK(i)} onMouseDown={(e) => (e.preventDefault(), pick(o))}>
        <span className="pxf-ic">
          <Icon name="package" />
        </span>
        <span className="pxf-main">
          <b>
            {o.p.name}
            {o.label && <span className="pxf-v"> · {o.label}</span>}
          </b>
          <small>
            {o.stock !== null && <span className={o.stock > 0 ? 'pxf-ok' : 'pxf-bad'}>{o.stock > 0 ? t('confirmation.d6.inStock', { n: o.stock }) : t('confirmation.d6.outStock', { n: o.stock })}</span>}
            {has && <span> · {t('confirmation.d.inOrder')}</span>}
          </small>
        </span>
        <span className="pxf-price ltr">
          <b>{da(o.price)}</b>
          {pk && save > 0 && (
            <small>
              {t('confirmation.d6.pack', { n: pk.qty })} {da(pk.price)} <em>−{da(save)}</em>
            </small>
          )}
        </span>
      </button>
    );
  };
  const main = list.filter((o) => !linkedIds.includes(o.p.id));
  return (
    <div className="combo qd2-add" ref={wrap}>
      <input
        ref={ref}
        type="search"
        className="qd2-add-in"
        autoComplete="off"
        placeholder={t('confirmation.d.addPh')}
        aria-label={t('confirmation.d.add')}
        role="combobox"
        aria-expanded={open}
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setK(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!list.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setK((k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(list[k]);
          }
        }}
      />
      {open && (
        <Float anchor={wrap} onClose={() => setOpen(false)} className="pxf-prod" minWidth={420}>
          <div role="listbox" aria-label={t('confirmation.d.add')}>
            {list.length === 0 && <p className="pxf-none">{t('common.noResults')}</p>}
            {main.length > 0 && <div className="pxf-gh">{t('confirmation.d6.allProducts')}</div>}
            {main.map((o, i) => row(o, i))}
            {related.length > 0 && (
              <div className="pxf-gh rel">
                <Icon name="sparkles" />
                {t('confirmation.d6.offer')}
              </div>
            )}
            {related.map((o, i) => row(o, main.length + i))}
          </div>
        </Float>
      )}
    </div>
  );
}

/** The variant of a cart line, in our dropdown: each variant with its price and stock. */
function VariantMenu({ product, value, lines, lineIndex, disabled, onPick }: { product: Prod; value: number | null; lines: Line[]; lineIndex: number; disabled: boolean; onPick: (vid: number) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = product.variants.find((v) => v.id === value);
  return (
    <>
      <button type="button" ref={btn} className={`qd6-var ${open ? 'on' : ''}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={t('confirmation.d.variant')} onClick={() => setOpen((o) => !o)}>
        {cur?.title || '—'}
        <Icon name="chevron" />
      </button>
      {open && (
        <Float anchor={btn} onClose={() => setOpen(false)} minWidth={260} maxHeight={320}>
          <div role="listbox">
            {product.variants
              .filter((v) => v.title !== '')
              .map((v) => (
                <button key={v.id} type="button" role="option" aria-selected={v.id === value} className={`pxf-it slim ${v.id === value ? 'cur' : ''}`} onClick={() => (onPick(v.id), setOpen(false))}>
                  <span className="pxf-main">
                    <b>{v.title}</b>
                    <small>
                      <span className={(v.stock ?? 0) > 0 ? 'pxf-ok' : 'pxf-bad'}>{(v.stock ?? 0) > 0 ? t('confirmation.d6.inStock', { n: v.stock ?? 0 }) : t('confirmation.d6.outStock', { n: v.stock ?? 0 })}</span>
                      {lines.some((x, k) => k !== lineIndex && x.variantId === v.id) && <span> · {t('confirmation.d.already')}</span>}
                    </small>
                  </span>
                  <span className="pxf-price ltr">
                    <b>{da(v.price ?? product.price)}</b>
                  </span>
                </button>
              ))}
          </div>
        </Float>
      )}
    </>
  );
}

type Desk = { id: number; companyId: number; companyName: string; name: string; commune: string; address: string; served: boolean };

/** The bureaus of the wilaya, in a menu right under the bureau box: search, grouped by company, green when it delivers, red when not. */
function DeskMenu({ anchor, wilaya, desks, current, onPick, onClose }: { anchor: React.RefObject<HTMLElement>; wilaya: string; desks: Desk[]; current: number | null; onPick: (id: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  const list = desks.filter((d) => words.every((w) => norm(`${d.name} ${d.companyName} ${d.commune} ${d.address}`).includes(w)));
  const groups = [...new Set(list.map((d) => d.companyName))];
  return (
    <Float anchor={anchor} onClose={onClose} className="pxf-desk" minWidth={380} maxHeight={440}>
      <div className="pxf-head">
        <b>{t('confirmation.dl.pickTitle', { w: wilaya })}</b>
        <small>{t('confirmation.dl.pickSub', { n: desks.length })}</small>
        {desks.length > 4 && <input type="search" className="pxf-q" placeholder={t('confirmation.dl.searchPh')} aria-label={t('confirmation.dl.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
      </div>
      <div role="listbox" aria-label={t('confirmation.dl.pickTitle', { w: wilaya })}>
        {list.length === 0 && <p className="pxf-none">{t('confirmation.dl.none')}</p>}
        {groups.map((g) => (
          <div key={g}>
            <div className="pxf-gh">{g}</div>
            {list
              .filter((d) => d.companyName === g)
              .map((d) => (
                <button key={d.id} type="button" role="option" aria-selected={d.id === current} className={`pxf-it ${d.id === current ? 'cur' : ''}`} disabled={!d.served} title={d.served ? undefined : t('confirmation.dl.no')} onClick={() => onPick(d.id)}>
                  <span className="pxf-ic">
                    <Icon name="building" />
                  </span>
                  <span className="pxf-main">
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
    </Float>
  );
}
