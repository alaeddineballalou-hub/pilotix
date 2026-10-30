// The open row of the queue (".qdetail"): notes, products (variant / qty / price), add a product,
// delivery price and total, packs and linked products, save bar. Saved with orders.update (version check).
import { CANCEL_REASONS, communesOf, FOLLOW_LOCKED, Order, origOf, upsellOf, WILAYAS, WILAYAS_AR } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../lib/backend';
import { defaultNext } from './shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { da, fromLocalInput, wilayaName } from '../../lib/format';
import i18n from '../../lib/i18n';
import { Icon, Loading, StatusBadge } from '../../ui/kit';
import { Float } from '../../ui/Float';
import { mayChangeCompany, pilotLine } from '../../lib/pilot';
import { useSession } from '../../lib/session';
import { toast } from '../../ui/toast';
import './check.css';
import { askRisk } from '../../ui/clientScore';

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

/** onDone: called after a status change, Confirmer or Enregistrer worked, so the list can move on to the next order. */
/** phone: the order full screen on a phone — the customer first (name, phones, address editable), then delivery, products, the totals, and the Statut / Confirmer bar. */
export function Detail({ order, onDone, phone }: { order: Order; onDone?: (id: number) => void; phone?: boolean }) {
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
  /** the delivery wilaya and commune (the agent can correct them) */
  const [wil, setWil] = useState(order.wilayaId);
  const [com, setCom] = useState(order.commune ?? '');
  /** home delivery: the order's company, or one picked on this card (the Préférences say who may) */
  const [co, setCo] = useState<number | null>(order.companyId);
  const { session } = useSession();
  const prefs = useRpc('prefs.get', {}, { staleTime: 5 * 60_000 });
  const pg = useRpc('pilot.get', {}, { staleTime: 5 * 60_000 });
  const [geoPick, setGeoPick] = useState<null | 'wil' | 'com'>(null);
  const wilRef = useRef<HTMLButtonElement>(null);
  const comRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const deskRef = useRef<HTMLElement>(null);
  const [disc, setDisc] = useState(order.discount);
  const [nOrigin, setNOrigin] = useState(order.customerNote ?? '');
  const [nLivreur, setNLivreur] = useState(order.deliveryNote ?? '');
  const [nTeam, setNTeam] = useState(order.internalNote ?? '');
  /** the customer (phone mode): name, phones, address */
  const [cName, setCName] = useState(order.customerName);
  const [cPhone, setCPhone] = useState(order.phone);
  const [cPhone2, setCPhone2] = useState(order.phone2 ?? '');
  const [cAddr, setCAddr] = useState(order.address ?? '');
  const [noteTab, setNoteTab] = useState<'origin' | 'livreur' | 'team'>('origin');
  /** the status picked in "Changer le statut": applied only with Enregistrer */
  const [pend, setPend] = useState<Pend | null>(null);
  /** Enregistrer needs a new status: a status picked in the menu that differs from the current one (another call attempt always counts) */
  const canSave = !!pend && (pend.status === 'try' || pend.status !== order.confStatus);
  useEffect(() => setPend(null), [order.id, order.confStatus, order.version]);
  useEffect(() => {
    setDisc(order.discount);
    setNOrigin(order.customerNote ?? '');
    setNLivreur(order.deliveryNote ?? '');
    setNTeam(order.internalNote ?? '');
  }, [order.discount, order.customerNote, order.deliveryNote, order.internalNote]);
  useEffect(() => {
    setCName(order.customerName);
    setCPhone(order.phone);
    setCPhone2(order.phone2 ?? '');
    setCAddr(order.address ?? '');
  }, [order.customerName, order.phone, order.phone2, order.address]);
  const [modeTouched, setModeTouched] = useState(false);
  const opts = useRpc('confirmation.deskOptions', { wilayaId: wil }, { staleTime: 5 * 60_000 });
  const modeFee = useRpc('confirmation.gridFee', { id: order.id, isStopdesk: desk, ...(wil !== order.wilayaId ? { wilayaId: wil } : {}) }, { staleTime: 60_000 });
  // the two checks before « Confirmer » (the server runs the same ones): each product's state, and whether we deliver
  // there — for the cart and the place as they are on screen, saved or not
  const deskCompany = desk && deskId ? (opts.data?.desks.find((d) => d.id === deskId)?.companyId ?? null) : null;
  const chk = useRpc(
    'orders.confirmCheck',
    {
      id: order.id,
      items: L.map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty })),
      wilayaId: wil ?? null,
      commune: desk ? null : com || null,
      isStopdesk: desk,
      stopdeskId: desk ? deskId : null,
      companyId: deskCompany ?? (desk ? order.companyId : co) ?? null,
      // the company was not picked on this card: Pilot says who takes the order once the new place / products are saved
      pilot: !desk && co === order.companyId,
    },
    { staleTime: 10_000 },
  );
  useEffect(() => {
    setL(initial);
    setFee(order.deliveryFee);
    setDesk(order.isStopdesk);
    setDeskId(order.stopdeskId);
    setWil(order.wilayaId);
    setCom(order.commune ?? '');
    setCo(order.companyId);
    setModeTouched(false);
    setErr('');
  }, [initial, order.deliveryFee, order.isStopdesk, order.stopdeskId, order.wilayaId, order.commune, order.companyId]);
  // switching Domicile / Bureau puts that type's price from the grid
  useEffect(() => {
    if (modeTouched && modeFee.data?.fee != null) setFee(modeFee.data.fee);
  }, [modeTouched, modeFee.data]);

  if (!cat.data) return <Loading />;
  const P = new Map(cat.data.map((p) => [p.id, p]));
  const editable = !(order.followStatus && FOLLOW_LOCKED.includes(order.followStatus)) && !order.shippedAt;
  // prices are not typed in here: products keep their catalog / pack price and delivery its grid price; only the remise changes
  const notesChanged = nOrigin !== (order.customerNote ?? '') || nLivreur !== (order.deliveryNote ?? '') || nTeam !== (order.internalNote ?? '');
  const geoChanged = wil !== order.wilayaId || com !== (order.commune ?? '');
  const clientChanged = cName.trim() !== order.customerName || cPhone.trim() !== order.phone || cPhone2.trim() !== (order.phone2 ?? '') || cAddr.trim() !== (order.address ?? '');
  const coChanged = !desk && co !== order.companyId;
  const dirty = key(L) !== key(initial) || fee !== order.deliveryFee || disc !== order.discount || notesChanged || geoChanged || clientChanged || desk !== order.isStopdesk || (desk && deskId !== order.stopdeskId) || coChanged;
  /** another wilaya: pick its commune, forget a bureau of the old one, and take that wilaya's price from the grid */
  const pickWilaya = (w: number) => {
    setGeoPick(null);
    if (w === wil) return;
    setWil(w);
    setCom('');
    if (desk) setDeskId(null);
    setModeTouched(true);
    setErr('');
    setTimeout(() => setGeoPick('com'), 0);
  };
  const chosen = opts.data?.desks.find((d) => d.id === deskId) ?? null;
  // at home: Pilot's choice for the place / products on screen (once saved), or the company of the card
  const pilotNext = !desk ? (chk.data?.pilot ?? null) : null;
  const homeCo = pilotNext ? pilotNext.companyId : co;
  const company = opts.data?.companies.find((c) => c.id === (desk ? (chosen?.companyId ?? order.companyId) : homeCo)) ?? null;
  const coWhy = pilotNext
    ? `${t('pilot.card.next')} · ${pilotLine(t, pilotNext, pg.data?.rules ?? []) ?? ''}`
    : coChanged
      ? t('pilot.card.yours')
      : pilotLine(t, { by: order.pilotBy, rule: order.pilotRule, why: order.pilotWhy }, pg.data?.rules ?? []);
  const canCo = mayChangeCompany(session, prefs.data?.prefs, order);
  // can it be delivered? Bureau: the chosen bureau's company serves it. Domicile: the order's company (or any active one) delivers here.
  const served: boolean | null = !opts.data ? null : desk ? (chosen ? chosen.served : null) : company ? company.home : opts.data.companies.some((c) => c.home);
  const stockOf = (l: Line) => {
    const p = P.get(l.productId);
    if (!p || p.isService) return null;
    const vs = l.variantId ? p.variants.filter((v) => v.id === l.variantId) : p.variants;
    return vs.length ? vs.reduce((n, v) => n + (v.stock ?? 0), 0) : null;
  };
  const sub = L.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  // the upsell, counted by itself against what the customer first ordered (the same rule as the server): no box to tick
  const up = order.isExchange ? null : upsellOf(order.origItems ?? origOf(order.items), order.origItems ? order.origDiscount : order.discount, L, disc);
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
      return [...cur, { productId: p.id, variantId: vid, name: p.name, variantTitle: v?.title ?? '', qty: 1, unitPrice: priceOf(p, vid), isUpsell: false }];
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
  const C = chk.data;
  // the check's answer for a cart line (undefined: the check is not back yet for this cart)
  const lineOf = (i: number) => {
    const c = C?.lines[i];
    const l = L[i];
    return c && l && c.productId === l.productId && c.variantId === (l.variantId ?? null) ? c : undefined;
  };
  const lineState = (i: number) => lineOf(i)?.state;
  const lineLeft = (i: number) => lineOf(i)?.available;
  const wName = (w: number | null) => (w ? `${String(w).padStart(2, '0')} ${wilayaName(w)}` : '');
  /** why « Confirmer » is off, or what « Confirmer sans stock » means — one short line under the totals */
  const chkNote: { tone: 'bad' | 'warn'; text: string; fix?: () => void } | null = !C
    ? out.length
      ? { tone: 'warn', text: t('confirmation.d6.warn', { names: out.map((l) => l.name).join(', ') }) }
      : null
    : !L.length
      ? { tone: 'bad', text: t('confirmation.d.keepOne') }
      : C.off
        ? { tone: 'bad', text: t('confirmation.chk.offNote', { names: C.lines.filter((x) => x.state === 'off').map((x) => x.name).join(', ') }) }
        : !C.deliver.ok
          ? C.deliver.why === 'commune'
            ? { tone: 'bad', text: t('confirmation.chk.commune'), fix: () => setGeoPick('com') }
            : C.deliver.why === 'wilaya'
              ? { tone: 'bad', text: t('confirmation.chk.wilaya'), fix: () => setGeoPick('wil') }
              : C.deliver.why === 'desk'
                ? { tone: 'bad', text: t('confirmation.chk.desk'), fix: () => setPicker(true) }
                : C.deliver.why === 'company'
                  ? { tone: 'bad', text: t(C.deliver.desk ? 'confirmation.chk.companyDesk' : 'confirmation.chk.companyHome', { co: C.deliver.companyName ?? '', w: wName(C.deliver.wilayaId) }) }
                  : { tone: 'bad', text: t(C.deliver.desk ? 'confirmation.chk.nobodyDesk' : 'confirmation.chk.nobodyHome', { w: wName(C.deliver.wilayaId) }) }
          : C.noStock
            ? { tone: 'warn', text: t(order.confStatus === 'no_stock' ? 'confirmation.chk.stillNote' : 'confirmation.chk.noStockNote', { names: C.lines.filter((x) => x.state === 'empty').map((x) => x.name).join(', ') }) }
            : null;
  const blockedNow = !!C && (!C.canConfirm || !L.length);
  const sansStock = !!C && C.canConfirm && C.noStock;
  const stillNoStock = sansStock && order.confStatus === 'no_stock';
  const cartBody = L.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, isUpsell: l.isUpsell }));
  /** Saves the cart and the delivery when they changed (before any status change). Returns false when it could not. */
  const saveFirst = async (): Promise<boolean> => {
    if (!L.length) return setErr(t('confirmation.d.keepOne')), false;
    if (desk && !deskId) return setErr(t('confirmation.dl.needDesk')), setPicker(true), false;
    if (geoChanged && !desk && !com) return setErr(t('confirmation.dl.needCommune')), setGeoPick('com'), false;
    if (!dirty) return true;
    const mode = desk !== order.isStopdesk || (desk && deskId !== order.stopdeskId) ? { isStopdesk: desk, stopdeskId: desk ? deskId : null, ...(desk && chosen ? { companyId: chosen.companyId } : {}) } : {};
    try {
      if (disc > maxDisc) return setErr(t('confirmation.d6.discTooBig', { v: da(maxDisc) })), false;
      const notes = notesChanged ? { customerNote: nOrigin.trim() || null, deliveryNote: nLivreur.trim() || null, internalNote: nTeam.trim() || null } : {};
      const geo = geoChanged ? { wilayaId: wil, commune: com } : {};
      const client = clientChanged ? { customerName: cName.trim(), phone: cPhone.trim(), phone2: cPhone2.trim() || null, address: cAddr.trim() } : {};
      await rpc('orders.update', { id: order.id, version: order.version, deliveryFee: fee, discount: disc, ...notes, ...geo, ...client, ...mode, ...(coChanged ? { companyId: co } : {}), ...(key(L) !== key(initial) ? { items: cartBody } : {}) });
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
      onDone?.(order.id);
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  // a « Risqué » customer: the agent reads why first, and chooses
  const confirm = async () => (await askRisk(order)) && run(() => rpc('orders.setConf', { ids: [order.id], status: 'confirmed' }), t('confirmation.d6.confirmed', { ref: order.ref }));
  /** nothing left for a product: confirmed « sans stock », it waits for stock (oldest first) before the depot */
  const confirmNoStock = async () => (await askRisk(order)) && run(() => rpc('orders.setConf', { ids: [order.id], status: 'no_stock' }), t('confirmation.chk.doneNoStock', { ref: order.ref }));

  return (
    <div className={`qd2-main qd3 qd5 qd6${phone ? ' qd6-ph' : ''}`}>
      <div className="qd6-grid">
      {phone && (
        <section className="qd6-card qd6-client" aria-label={t('confirmation.ph.client')}>
          <div className="qd6-h">{t('confirmation.ph.client')}</div>
          <div className="qd6-flds">
            <label className="qd6-fld">
              <small>{t('confirmation.ph.name')}</small>
              <input value={cName} maxLength={120} disabled={!editable} onChange={(e) => setCName(e.target.value)} />
            </label>
            <label className="qd6-fld">
              <small>{t('confirmation.ph.phone')}</small>
              <input className="ltr" type="tel" inputMode="tel" value={cPhone} maxLength={20} disabled={!editable} onChange={(e) => setCPhone(e.target.value)} />
            </label>
            <label className="qd6-fld wide">
              <small>{t('confirmation.ph.phone2')}</small>
              <input className="ltr" type="tel" inputMode="tel" value={cPhone2} maxLength={20} placeholder={t('confirmation.ph.addPhone')} disabled={!editable} onChange={(e) => setCPhone2(e.target.value)} />
            </label>
          </div>
        </section>
      )}
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
                <div className="qd6-nrow">
                <div className="qd6-ntabs" role="tablist">
                  {notes.map(([k, icon, v]) => (
                    <button key={k} type="button" role="tab" id={`qd6-nt-${order.id}-${k}`} aria-selected={k === cur[0]} className={k === cur[0] ? 'on' : ''} onClick={() => setNoteTab(k)}>
                      <Icon name={icon} />
                      {t(`confirmation.d6.note.${k}`)}
                      {v.trim() && <span className="qd6-ndot" aria-label="•" />}
                    </button>
                  ))}
                </div>
                <Clocks since={order.createdAt} />
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
            const n = stockOf(l);
            return (
              <div key={`${l.productId}-${l.variantId}-${i}`} className={`qd6-line${lineState(i) === 'off' ? ' off' : ''}`}>
                <span className="qd6-thumb" aria-hidden="true">
                  <Icon name="package" />
                </span>
                <div className="qd6-pn">
                  <b>
                    {l.name}{' '}
                    {up?.flags[i] && (
                      <span className="chip qd6-upc" title={t('confirmation.d6.upsellHint')}>
                        <Icon name="sparkles" />
                        {t('confirmation.d6.upsell')}
                      </span>
                    )}{' '}
                    {pk && <span className="chip qd2-pk">pack {l.qty}</span>}
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
                {lineState(i) === 'off' ? (
                  <span className="qd5-stock off">
                    <i />
                    {t('confirmation.chk.off')}
                  </span>
                ) : lineLeft(i) !== undefined ? (
                  lineLeft(i) !== null && (
                    <span className={`qd5-stock ${lineState(i) === 'ok' ? 'ok' : 'bad'}`}>
                      <i />
                      {lineState(i) === 'ok' ? t('confirmation.d6.inStock', { n: lineLeft(i) }) : t('confirmation.chk.left', { n: lineLeft(i) })}
                    </span>
                  )
                ) : (
                  n !== null && (
                    <span className={`qd5-stock ${n >= l.qty ? 'ok' : 'bad'}`}>
                      <i />
                      {n >= l.qty ? t('confirmation.d6.inStock', { n }) : t('confirmation.d6.outStock', { n })}
                    </span>
                  )
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
                  <b className="ltr">{da(l.qty * l.unitPrice)}</b>
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
        </section>
          {editable && (
            <section className="qd6-card qd6-related" aria-label={t('confirmation.d6.offer')}>
              <div className="qd6-h">
                <Icon name="sparkles" />
                {t('confirmation.d6.offer')}
              </div>
              {packs.length === 0 && linked.size === 0 && <p className="qd6-none">{t('confirmation.d6.noOffer')}</p>}
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
            </section>
          )}
      </div>
      <div className="qd6-right">
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
          <div className="qd6-geo">
            <button type="button" ref={wilRef} className={`qd6-pick${geoPick === 'wil' ? ' on' : ''}`} disabled={!editable} aria-haspopup="listbox" aria-expanded={geoPick === 'wil'} onClick={() => setGeoPick(geoPick === 'wil' ? null : 'wil')}>
              <small>{t('confirmation.dl.wilaya')}</small>
              <b className="ltr-n">
                {String(wil).padStart(2, '0')} · {wilayaName(wil)}
              </b>
              {editable && <Icon name="chevron" />}
            </button>
            <button type="button" ref={comRef} className={`qd6-pick${com ? '' : ' miss'}${geoPick === 'com' ? ' on' : ''}`} disabled={!editable} aria-haspopup="listbox" aria-expanded={geoPick === 'com'} onClick={() => setGeoPick(geoPick === 'com' ? null : 'com')}>
              <small>{t('confirmation.dl.commune')}</small>
              <b>{com ? communeName(wil, com) : t('confirmation.dl.pickCommune')}</b>
              {editable && <Icon name="chevron" />}
            </button>
          </div>
          {desk ? (
            chosen ? (
              <div className="qd6-desk click" role="button" tabIndex={editable ? 0 : -1} onClick={() => editable && setPicker((o) => !o)} onKeyDown={(e) => e.key === 'Enter' && editable && setPicker(true)}>
                <span>
                  <b>{chosen.name}</b> <small>· {[chosen.address, chosen.commune || wilayaName(wil)].filter(Boolean).join(' · ')}</small>
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
                <b>{company ? (company.kind === 'own' ? t('pilot.card.private') : company.name) : homeCo === null ? t('pilot.card.toAssign') : t('confirmation.d.home')}</b>{' '}
                {order.address ? <small>· {order.address}</small> : null}
                {coWhy && <small className="qd6-why">{coWhy}</small>}
              </span>
              {served !== null && (
                <span className={`qd5-served mini ${served ? 'ok' : 'bad'}`}>
                  <i />
                  {served ? t('confirmation.dl.ok') : t('confirmation.dl.no')}
                </span>
              )}
            </div>
          )}
          {!desk && editable && canCo && opts.data && (
            <label className="qd6-co">
              <small>{t('pilot.card.change')}</small>
              <select value={co ?? ''} onChange={(e) => setCo(e.target.value ? Number(e.target.value) : null)}>
                {co === null && <option value="">{t('pilot.card.toAssign')}</option>}
                {opts.data.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.kind === 'own' ? t('pilot.card.private') : c.name}
                    {c.home ? '' : ` — ${t('pilot.card.noHome')}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!desk && editable && !canCo && order.pilotBy === 'strict' && (
            <p className="qd6-lock">
              <Icon name="lock" /> {t('pilot.card.locked')}
            </p>
          )}
          {phone && !desk && (
            <label className="qd6-fld wide qd6-addr">
              <small>{t('confirmation.ph.address')}</small>
              <input value={cAddr} maxLength={300} disabled={!editable} onChange={(e) => setCAddr(e.target.value)} />
            </label>
          )}
          <div className="qd6-fee ro" title={t('confirmation.d6.feeLocked')}>
            <span className="qd6-lab">{t('confirmation.d6.fee')}</span>
            <span className="qd6-feev ltr">
              <Icon name="lock" />
              {da(fee)}
            </span>
          </div>
        </section>
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
              <label className={`qd6-dv ltr${editable ? ' ed' : ''}`}>
                {editable && <Icon name="pencil" />}
                <span className="qd6-minus">−</span>
                <input type="number" min={0} max={maxDisc} step={50} style={{ ['--w' as string]: String(disc).length }} aria-label={t('confirmation.d.discount')} disabled={!editable} value={disc} onChange={(e) => setDisc(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                <span className="qd6-unit">{da(0).replace(/^[\d\s\u00a0\u202f]+/, '')}</span>
              </label>
            </dd>
          </div>
          {up && up.value > 0 && (
            <div className="qd6-up" title={t('confirmation.d6.upsellHint')}>
              <dt>
                <Icon name="sparkles" />
                {t('confirmation.d6.upsell')}
              </dt>
              <dd className="ltr">+{da(up.value)}</dd>
            </div>
          )}
          <div className="qd5-total">
            <dt>{t('confirmation.d.total')}</dt>
            <dd className="ltr">{da(sub + fee - disc)}</dd>
          </div>
        </dl>
        {chkNote && (
          <div className={`qd6-warn ${chkNote.tone}`} role="alert">
            <Icon name={chkNote.tone === 'bad' ? 'alert' : 'clock'} />
            <span>
              {chkNote.text}
              {chkNote.fix && editable && (
                <>
                  {' '}
                  <button type="button" className="qd6-fix" onClick={chkNote.fix}>
                    {t('confirmation.chk.fix')}
                  </button>
                </>
              )}
            </span>
          </div>
        )}
        {err && <p className="form-err">{err}</p>}
      </aside>
      </div>
      </div>
      <div className="qd6-bar">
        <div className="qd6-bl">
        {(dirty || pend) && (
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
                setWil(order.wilayaId);
                setCom(order.commune ?? '');
                setDisc(order.discount);
                setNOrigin(order.customerNote ?? '');
                setNLivreur(order.deliveryNote ?? '');
                setNTeam(order.internalNote ?? '');
                setCName(order.customerName);
                setCPhone(order.phone);
                setCPhone2(order.phone2 ?? '');
                setCAddr(order.address ?? '');
                setPend(null);
                setErr('');
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
        </div>
        <StatusMenu order={order} busy={busy} pending={pend} onPick={setPend} />
        {(!phone || canSave || order.confStatus === 'confirmed') && <button
          type="button"
          className={`qd6-savebtn ${canSave ? 'on' : ''}`}
          disabled={busy || !canSave}
          title={canSave ? undefined : t('confirmation.d6.pickStatus')}
          onClick={() => pend && run(pend.fn, pend.ok, pend.tone)}
        >
          <Icon name="check" />
          {t('common.save')}
        </button>}
        {order.confStatus !== 'confirmed' && !(phone && canSave) && (
          <>
            <button
              type="button"
              className={`qd6-cta${sansStock ? ' sans' : ''}`}
              disabled={busy || !editable || blockedNow || stillNoStock}
              title={blockedNow && chkNote ? chkNote.text : t('confirmation.d6.hint')}
              onClick={sansStock ? confirmNoStock : confirm}
            >
              <Icon name={sansStock ? 'clock' : 'checkcircle'} />
              {stillNoStock ? t('confirmation.chk.still') : sansStock ? t('confirmation.chk.confirmNoStock') : t('confirmation.d6.confirm')}
            </button>
          </>
        )}
      </div>
      {geoPick === 'wil' && (
        <PickList
          anchor={wilRef}
          title={t('confirmation.dl.wilTitle')}
          searchPh={t('confirmation.dl.searchWil')}
          items={WILAYAS.map((name, i) => ({ value: i + 1, label: `${String(i + 1).padStart(2, '0')} · ${wilayaName(i + 1)}`, hay: `${i + 1} ${String(i + 1).padStart(2, '0')} ${name} ${WILAYAS_AR[i + 1] ?? ''}` }))}
          current={wil}
          onPick={(v) => pickWilaya(Number(v))}
          onClose={() => setGeoPick(null)}
        />
      )}
      {geoPick === 'com' && (
        <PickList
          anchor={comRef}
          title={t('confirmation.dl.comTitle', { w: wilayaName(wil) })}
          searchPh={t('confirmation.dl.searchCom')}
          items={communesOf(wil).map((c) => ({ value: c[1], label: i18n.language === 'ar' ? c[2] || c[1] : c[1], hay: `${c[1]} ${c[2]}` }))}
          current={com}
          onPick={(v) => (setCom(String(v)), setGeoPick(null), setErr(''))}
          onClose={() => setGeoPick(null)}
        />
      )}
      {picker && opts.data && (
        <DeskMenu
          anchor={deskRef}
          wilaya={wilayaName(wil)}
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
/** A status picked in the menu, waiting for Enregistrer. */
interface Pend {
  /** the status it leads to ('try' = one more call attempt) */
  status: string;
  label: string;
  tone: 'ok' | 'bad';
  cls: string;
  fn: () => Promise<unknown>;
  ok: string;
}
function StatusMenu({ order, busy, pending, onPick }: { order: Order; busy: boolean; pending: Pend | null; onPick: (p: Pend | null) => void }) {
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
  const shortDate = (d: string) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
  const nextTry = Math.min(9, (order.attempts || 0) + 1);
  const done = (p: Pend) => (onPick(p), setStep(null), setReason(''), setNote(''));
  const pickAsk = (s: 'cancelled' | 'postponed' | 'callback') => {
    setStep(s);
    setReason('');
    setNote('');
    setWhen(s === 'callback' ? defaultNext('callback') : defaultNext('postponed').slice(0, 10));
  };
  const direct = (status: 'busy' | 'duplicate' | 'wrong_number' | 'fake' | 'competitor' | 'try') => {
    if (status === 'competitor') {
      // a fake order placed by a competitor: the device that sent it is blocked for good (landing pages)
      const txt = t('status.fakeReason.competitor');
      return done({ status: 'fake', label: `${label('fake')} · ${txt}`, tone: 'bad', cls: 'c-off', fn: () => rpc('orders.setConf', { ids: [order.id], status: 'fake', reason: txt }), ok: `${order.ref} → ${txt}` });
    }
    if (status === 'try') {
      const txt = t('confirmation.try', { n: String(nextTry).padStart(2, '0') });
      return done({ status: 'try', label: txt, tone: 'ok', cls: 'c-mid', fn: () => rpc('confirmation.setTry', { ids: [order.id], n: nextTry }), ok: `${order.ref} → ${txt}` });
    }
    const soft = status === 'busy' || status === 'duplicate';
    done({ status, label: label(status), tone: soft ? 'ok' : 'bad', cls: status === 'busy' ? 'c-mid' : 'c-off', fn: () => rpc('orders.setConf', { ids: [order.id], status, reason: status === 'wrong_number' || status === 'fake' ? label(status) : null }), ok: `${order.ref} → ${label(status)}` });
  };
  const submitAsk = async () => {
    if (step === 'cancelled') {
      if (!reason) return;
      const r = t(`status.cancelReason.${reason}`);
      const n = note.trim() || null;
      done({ status: 'cancelled', label: `${label('cancelled')} · ${r}`, tone: 'bad', cls: 'c-bad', fn: () => rpc('orders.setConf', { ids: [order.id], status: 'cancelled', reason: r, note: n }), ok: `${order.ref} → ${label('cancelled')}` });
    } else if (step === 'postponed' || step === 'callback') {
      if (!when) return;
      const at = step === 'postponed' ? `${when}T10:00` : when;
      const st = step;
      const n = note.trim() || null;
      const shown = st === 'postponed' ? shortDate(when) : `${shortDate(when.slice(0, 10))} ${when.slice(11, 16)}`;
      done({ status: st, label: `${label(st)} · ${shown}`, tone: 'ok', cls: 'c-info', fn: () => rpc('orders.setConf', { ids: [order.id], status: st, nextCallAt: fromLocalInput(at), note: n }), ok: `${order.ref} → ${label(st)}` });
    }
  };
  const item = (icon: string, cls: string, text: string, hint: string | null, on: () => void) => (
    <button type="button" role="menuitem" className={`qd6-mi ${cls}`} disabled={busy} onClick={on}>
      <Icon name={icon} />
      {text}
      {hint && <small>{hint}</small>}
    </button>
  );
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
          {item('flag', 'c-off', t('status.fakeReason.competitor'), t('confirmation.d6.competitorHint'), () => direct('competitor'))}
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
        <span className="qd6-ddt">{t('confirmation.d6.change')}</span>
        <span className="qd6-ddt-s">{t('confirmation.ph.status')}</span>
        <span className="qd6-cur">
          {pending ? <span className={`qd6-pend ${pending.cls}`}>{pending.label}</span> : <StatusBadge kind="conf" status={order.confStatus} />}
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
/** A commune shown in the screen language (the order keeps its French name). */
function communeName(wilayaId: number, fr: string) {
  if (i18n.language !== 'ar') return fr;
  return communesOf(wilayaId).find((c) => c[1] === fr)?.[2] || fr;
}

/** Our own list menu (wilaya, commune): search on top, the current one marked and brought into view. */
function PickList({ anchor, title, searchPh, items, current, onPick, onClose }: { anchor: React.RefObject<HTMLElement>; title: string; searchPh: string; items: { value: string | number; label: string; hay: string }[]; current: string | number; onPick: (v: string | number) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  const list = items.filter((it) => words.every((w) => norm(it.hay).includes(w)));
  useEffect(() => {
    box.current?.querySelector('.cur')?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <Float anchor={anchor} onClose={onClose} className="pxf-desk pxf-geo" minWidth={300} maxHeight={420}>
      <div className="pxf-head">
        <b>{title}</b>
        <input
          type="search"
          className="pxf-q"
          placeholder={searchPh}
          aria-label={searchPh}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) onPick(list[0].value);
          }}
          autoFocus
        />
      </div>
      <div role="listbox" aria-label={title} ref={box}>
        {list.length === 0 && <p className="pxf-none">{i18n.t('common.noResults')}</p>}
        {list.map((it) => (
          <button key={String(it.value)} type="button" role="option" aria-selected={it.value === current} className={`pxf-it ${it.value === current ? 'cur' : ''}`} onClick={() => onPick(it.value)}>
            <span className="pxf-main">
              <b>{it.label}</b>
            </span>
            {it.value === current && <Icon name="check" />}
          </button>
        ))}
      </div>
    </Float>
  );
}

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

/** "1 h 05 min" from an hour on, "4 min 12 s" under it. */
const span = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h >= 24) return `${Math.floor(h / 24)} j ${h % 24} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min ${String(s).padStart(2, '0')} s`;
};
/** Beside the note tabs: how long ago the order came in, and a chrono of the time spent on it since it was opened. */
function Clocks({ since }: { since: string }) {
  const { t } = useTranslation();
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="qd6-clocks ltr">
      <span className="qd6-clk" title={t('confirmation.d6.ageHint')}>
        <Icon name="hourglass" />
        {t('confirmation.d6.age')} <b>{span(now - Date.parse(since))}</b>
      </span>
      <span className="qd6-clk run" title={t('confirmation.d6.chronoHint')}>
        <Icon name="timer" />
        {t('confirmation.d6.chrono')} <b>{span(now - start)}</b>
      </span>
    </div>
  );
}
