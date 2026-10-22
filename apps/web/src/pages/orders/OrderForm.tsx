// "Nouvelle commande" / "Modifier la commande X" / "Échange pour X" — the .pxo order form of the original app.
import { communesOf, FOLLOW_LOCKED, normalizePhone, Order, origOf, SALES_CHANNELS, upsellOf, WILAYAS } from '@pilotix/shared';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import type { OrderFormOpts } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorBox, Field, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import './orders.css';

type FormData = Out<'orders.formData'>;
type Product = FormData['products'][number];
type Variant = Product['variants'][number];

interface Line {
  key: number;
  productId: number | null;
  variantId: number | null;
  qty: number;
  unitPrice: number | null;
  isUpsell: boolean;
  name?: string;
}
let lineKey = 1;
const emptyLine = (isUpsell = false): Line => ({ key: lineKey++, productId: null, variantId: null, qty: 1, unitPrice: null, isUpsell });

const IC: Record<string, string> = {
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  sum: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
};
function Sec({ ic, title, right, children }: { ic: string; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="pxo-sec">
      <div className="pxo-h">
        <span className="ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: IC[ic] }} />
        </span>
        <h3>{title}</h3>
        {right && <div className="rt">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** Product search ("Chercher un produit…") with a drop-down list. */
function ProductPick({ products, value, onPick, disabled }: { products: Product[]; value: string; onPick: (p: Product) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const list = useMemo(() => {
    if (q === null) return [];
    const k = norm(q.trim());
    return products.filter((p) => p.active && (!k || norm(`${p.name} ${p.sku} ${p.variants.map((v) => `${v.title} ${v.sku}`).join(' ')}`).includes(k))).slice(0, 30);
  }, [q, products]);
  const pick = (p: Product) => {
    setQ(null);
    onPick(p);
  };
  return (
    <div className="combo">
      <input
        value={q ?? value}
        placeholder={t('orders.form.searchProduct')}
        aria-label={t('orders.form.product')}
        disabled={disabled}
        onFocus={() => setQ('')}
        onBlur={() => setTimeout(() => setQ(null), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHi((h) => Math.min(list.length - 1, h + 1));
          else if (e.key === 'ArrowUp') setHi((h) => Math.max(0, h - 1));
          else if (e.key === 'Enter' && list[hi]) {
            e.preventDefault();
            pick(list[hi]);
          } else if (e.key === 'Escape') setQ(null);
        }}
      />
      {q !== null && (
        <div className="combo-list" role="listbox">
          {list.length ? (
            list.map((p, i) => (
              <button type="button" key={p.id} className={i === hi ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
                <span>{p.name}</span>
                <small className="ltr">{da(p.price)}</small>
              </button>
            ))
          ) : (
            <button type="button" disabled>
              {t('orders.form.noProduct')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function OrderForm(p: OrderFormOpts & { onClose: () => void }) {
  const { t } = useTranslation();
  const fd = useRpc('orders.formData', {}, { staleTime: 60_000 });
  const editQ = useRpc('orders.get', { id: p.orderId ?? 0 }, { enabled: !!p.orderId, placeholderData: undefined });
  const exQ = useRpc('orders.get', { id: p.exchangeOf ?? 0 }, { enabled: !!p.exchangeOf, placeholderData: undefined });
  const loading = fd.isLoading || (p.orderId && editQ.isLoading) || (p.exchangeOf && exQ.isLoading);
  const error = fd.error || (p.orderId ? editQ.error : null) || (p.exchangeOf ? exQ.error : null);
  const title = p.orderId ? t('orders.form.titleEdit', { ref: editQ.data?.ref ?? '' }) : p.exchangeOf ? t('orders.form.titleExchange', { ref: exQ.data?.ref ?? '' }) : t('orders.form.titleNew');
  if (loading || error || !fd.data)
    return (
      <Modal title={title} onClose={p.onClose} wide>
        {error ? <ErrorBox error={error} /> : <Loading />}
      </Modal>
    );
  return <Form {...p} data={fd.data} order={p.orderId ? editQ.data : undefined} original={p.exchangeOf ? exQ.data : undefined} title={title} />;
}

function Form({ data, order, original, title, onClose, onSaved, prefill }: OrderFormOpts & { onClose: () => void; data: FormData; order?: Order; original?: Order; title: string }) {
  const { t, i18n } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const isEdit = !!order;
  const isExchange = !!original && !isEdit;
  const pre = (prefill ?? {}) as Record<string, any>;
  const base: Partial<Order> & Record<string, any> = order ?? (original ? { ...original, discount: 0 } : pre);
  const P = useMemo(() => new Map(data.products.map((x) => [x.id, x])), [data.products]);
  const V = useMemo(() => {
    const m = new Map<number, Variant & { productId: number }>();
    data.products.forEach((x) => x.variants.forEach((v) => m.set(v.id, { ...v, productId: x.id })));
    return m;
  }, [data.products]);
  const locked = !!order?.followStatus && FOLLOW_LOCKED.includes(order.followStatus);
  const canConf = has('confirmation') && !(order && (order.confStatus === 'confirmed' || order.followStatus));

  // ---- state
  const [name, setName] = useState<string>(base.customerName ?? '');
  const [phone, setPhone] = useState<string>(base.phone ?? '');
  const [phone2, setPhone2] = useState<string>(base.phone2 ?? '');
  const [show2, setShow2] = useState<boolean>(!!base.phone2);
  const [wil, setWil] = useState<number | ''>(base.wilayaId ?? '');
  const [commune, setCommune] = useState<string>(base.commune ?? '');
  const [address, setAddress] = useState<string>(base.address ?? '');
  const [desk, setDesk] = useState<boolean>(!!base.isStopdesk);
  const [deskId, setDeskId] = useState<number | ''>(base.stopdeskId ?? '');
  const [companyId, setCompanyId] = useState<number | ''>(base.companyId ?? '');
  const [channel, setChannel] = useState<string>(base.channel ?? 'appel');
  const [noteC, setNoteC] = useState<string>(base.customerNote ?? '');
  const [noteL, setNoteL] = useState<string>(base.deliveryNote ?? '');
  const [noteT, setNoteT] = useState<string>(isExchange ? '' : base.internalNote ?? '');
  const [lines, setLines] = useState<Line[]>(() => {
    const items = (base.items ?? []) as any[];
    if (!items.length) return [emptyLine()];
    return items.map((i) => ({ key: lineKey++, productId: i.productId ?? null, variantId: i.variantId ?? null, qty: Number(i.qty) || 1, unitPrice: isExchange ? 0 : i.unitPrice ?? null, isUpsell: !!i.isUpsell, name: i.name }));
  });
  const [fee, setFee] = useState<string>(isEdit || base.deliveryFee !== undefined ? String(base.deliveryFee ?? '') : '');
  const [feeAuto, setFeeAuto] = useState<boolean>(!isEdit && base.deliveryFee === undefined);
  const [discount, setDiscount] = useState<string>(String(base.discount ?? 0));
  const [pErr, setPErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const errRef = useRef<HTMLParagraphElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isEdit) setTimeout(() => nameRef.current?.focus(), 60);
  }, [isEdit]);

  // ---- delivery quote (fee from the client price grid, served, max discount)
  const coId = companyId === '' ? data.defaultCompanyId : companyId;
  const company = data.companies.find((c) => c.id === coId) ?? null;
  const isOwn = company?.kind === 'own';
  const quoteItems = lines.filter((l) => l.productId && l.variantId).map((l) => ({ productId: l.productId!, qty: l.qty }));
  const quote = useRpc('orders.quote', { wilayaId: wil === '' ? null : wil, isStopdesk: desk, companyId: companyId === '' ? null : companyId, items: quoteItems });
  const q = quote.data;
  useEffect(() => {
    if (feeAuto && q && wil !== '' && q.fee !== null) setFee(String(q.fee));
  }, [feeAuto, q, wil]);
  const maxD = q?.maxDiscount ?? null; // null = no limit

  // ---- lines helpers
  const stockOf = (v: Variant | undefined) => (v ? v.stock : null);
  const priceOf = (pr: Product, v: Variant) => v.price ?? pr.price;
  const freeVar = (pr: Product, it: Line | null) => {
    const used = new Set(lines.filter((x) => x !== it).map((x) => x.variantId));
    const cand = pr.variants.filter((v) => v.active && !used.has(v.id));
    return cand.find((v) => (stockOf(v) ?? 1) > 0) ?? cand[0] ?? null;
  };
  const update = (key: number, patch: Partial<Line>, items = true) => {
    setPErr('');
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    if (items) setFeeAuto(true);
  };
  const pickProduct = (it: Line, pr: Product) => {
    const v = freeVar(pr, it);
    if (!v) {
      setPErr(t('orders.form.allVariantsUsed', { name: pr.name }));
      return;
    }
    update(it.key, { productId: pr.id, variantId: v.id, unitPrice: isExchange ? 0 : priceOf(pr, v), name: pr.name });
  };
  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (key: number) => {
    setFeeAuto(true);
    setLines((ls) => {
      const r = ls.filter((l) => l.key !== key);
      return r.length ? r : [emptyLine()];
    });
  };

  // offers: packs of the products in the order, linked products not yet in it
  const offers = useMemo(() => {
    const inP = new Set(lines.map((l) => l.productId).filter(Boolean));
    const packs: { it: Line; pr: Product; pk: { qty: number; price: number } }[] = [];
    const rel = new Map<number, Product>();
    for (const it of lines) {
      if (!it.variantId || !it.productId) continue;
      const pr = P.get(it.productId);
      if (!pr) continue;
      for (const pk of pr.packs) if (pk.qty !== it.qty) packs.push({ it, pr, pk });
      for (const lid of pr.linked) {
        const lp = P.get(lid);
        if (lp && lp.active && !inP.has(lid)) rel.set(lid, lp);
      }
    }
    return { packs, rel: [...rel.values()] };
  }, [lines, P]);

  // ---- delivery state ("Livrable : OUI / NON / à compléter")
  const wName = wil === '' ? '' : WILAYAS[wil - 1];
  const desks = data.stopdesks.filter((d) => coId !== null && d.companyId === coId);
  const desksHere = desks.filter((d) => wil === '' || d.wilayaId === wil);
  const ship = (() => {
    const hard: string[] = [];
    const soft: string[] = [];
    const info: string[] = [];
    if (wil === '') return { k: 'wait', msgs: [t('orders.form.chooseWilaya')], hard, soft, info };
    const co = q?.companyName ?? company?.name ?? '';
    if (q && !q.served) hard.push(t('orders.form.notServed', { co, mode: desk ? t('orders.form.modeDesk') : t('orders.form.modeHome'), w: wName }));
    if (desk && coId === null) soft.push(t('orders.form.chooseCompanyDesk'));
    else if (desk && desks.length && !desksHere.length) hard.push(t('orders.form.noDeskHere', { co, w: wName }));
    else if (desk && desksHere.length && deskId === '') soft.push(t('orders.form.chooseDesk'));
    if (!desk && !commune) soft.push(t('orders.form.chooseCommune'));
    if (companyId === '' && data.defaultCompanyId === null) soft.push(t('orders.form.noCompanyYet'));
    if (companyId === '' && data.defaultCompanyId !== null) info.push(t('orders.form.defaultCompany', { name: company?.name ?? '—' }));
    if (isOwn) info.push(t('orders.form.ownOnlyHome'));
    return { k: hard.length ? 'no' : soft.length ? 'todo' : 'ok', msgs: [] as string[], hard, soft, info };
  })();

  // ---- totals
  const sub = lines.reduce((s, x) => s + (Number(x.unitPrice) || 0) * (x.variantId ? x.qty : 0), 0);
  const nItems = lines.reduce((s, x) => s + (x.variantId ? x.qty : 0), 0);
  const feeN = Number(fee) || 0;
  const disN = Number(discount) || 0;
  // editing an order: the upsell is counted by itself against what the customer first ordered (the same rule as the server)
  const autoUp =
    isEdit && order && !order.isExchange
      ? upsellOf(
          order.origItems ?? origOf(order.items),
          order.origItems ? order.origDiscount : order.discount,
          lines.map((x) => ({ productId: x.productId ?? 0, variantId: x.variantId, qty: x.variantId ? x.qty : 0, unitPrice: Number(x.unitPrice) || 0 })),
          disN,
        )
      : null;
  const over = maxD !== null && disN > maxD;

  const communes = wil === '' ? [] : communesOf(wil);
  const ar = i18n.language === 'ar';

  // ---- validate and save
  const validate = (strict: boolean): string | null => {
    if (!name.trim()) return t('orders.form.eName');
    if (!normalizePhone(phone)) return t('orders.form.ePhone');
    if (show2 && phone2.trim() && !normalizePhone(phone2)) return t('orders.form.ePhone');
    if (wil === '') return t('orders.form.eWilaya');
    if (!lines.some((x) => x.variantId)) return t('orders.form.eNoProduct');
    if (lines.some((x) => !x.variantId)) return t('orders.form.eEmptyLine');
    const seen = new Set<number>();
    for (const x of lines) {
      if (seen.has(x.variantId!)) return t('orders.form.eDupVariant');
      seen.add(x.variantId!);
    }
    if (over) return t('orders.form.eDiscount', { v: da(maxD) });
    if (strict) {
      if (!desk && !commune) return t('orders.form.eCommune');
      if (ship.hard.length) return t('orders.form.eNotDeliverable', { msg: ship.hard[0] });
      if (desk && desksHere.length && deskId === '') return t('orders.form.eDesk');
    }
    return null;
  };

  const save = async (confirm: boolean) => {
    setErr('');
    const v = validate(confirm);
    if (v) {
      setErr(v);
      setTimeout(() => errRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
      return;
    }
    setBusy(true);
    const payload = {
      customerName: name.trim(),
      phone: phone.trim(),
      phone2: show2 && phone2.trim() ? phone2.trim() : null,
      wilayaId: wil as number,
      commune: commune,
      address: address.trim(),
      isStopdesk: desk,
      stopdeskId: desk && deskId !== '' ? deskId : null,
      companyId: companyId === '' ? null : companyId,
      channel: channel as (typeof SALES_CHANNELS)[number],
      deliveryFee: fee === '' ? undefined : feeN,
      discount: disN,
      customerNote: noteC.trim() || null,
      deliveryNote: noteL.trim() || null,
      internalNote: (isExchange ? [noteT.trim(), `Échange de ${original!.ref}`].filter(Boolean).join(' · ') : noteT.trim()) || null,
    };
    const items = lines.filter((x) => x.variantId).map((x) => ({ productId: x.productId!, variantId: x.variantId!, qty: x.qty, unitPrice: x.unitPrice ?? undefined }));
    try {
      let saved: Order;
      if (isEdit) {
        saved = await rpc('orders.update', { id: order!.id, version: order!.version, ...payload, ...(locked ? {} : { items }) });
        if (confirm) {
          try {
            await rpc('orders.setConf', { ids: [saved.id], status: 'confirmed' });
            toast(t('orders.form.savedConfirmed', { ref: saved.ref }), 'ok');
          } catch (e: any) {
            toast(t('orders.form.notConfirmed', { msg: e.message }), 'bad');
          }
        } else toast(t('orders.form.saved', { ref: saved.ref }), 'ok');
      } else {
        saved = await rpc('orders.create', { ...payload, items, confirm, isExchange, originalOrderId: isExchange ? original!.id : null, source: (pre.source as string) ?? null });
        toast(confirm ? t('orders.form.savedConfirmed', { ref: saved.ref }) : t('orders.form.created', { ref: saved.ref }), 'ok');
      }
      qc.invalidateQueries();
      onSaved?.(saved.id);
      onClose();
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setBusy(false);
    }
  };

  // ---- render
  const dataChips: [string, string][] = order
    ? ([
        [t('orders.form.ref'), order.ref],
        [t('orders.form.received'), when(order.createdAt)],
        [t('orders.form.channel'), t(`status.channel.${order.channel}`)],
        [t('orders.form.source'), order.source ?? ''],
        ...Object.entries(order.utm ?? {}).map(([k, v]) => [k.replace(/^utm_/, ''), String(v)] as [string, string]),
      ].filter(([, v]) => v) as [string, string][])
    : [];

  const footer = (
    <>
      <button className="btn" type="button" onClick={onClose}>
        {t('orders.form.close')}
      </button>
      <button className={`btn${canConf ? '' : ' primary'}`} type="button" disabled={busy} onClick={() => save(false)}>
        {isEdit ? t('orders.form.save') : t('orders.form.create')}
      </button>
      {canConf && (
        <button className="btn primary" type="button" disabled={busy} onClick={() => save(true)}>
          {isEdit ? t('orders.form.saveConfirm') : t('orders.form.createConfirm')}
        </button>
      )}
    </>
  );

  return (
    <Modal title={title} onClose={onClose} wide footer={footer}>
      <form
        className="pxo-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        {isExchange && <div className="warnbox">{t('orders.form.exchangeInfo')}</div>}
        <div className="pxo">
          <Sec ic="note" title={t('orders.form.notes')}>
            <div className="pxo-data">
              <div className="pxo-drow">
                <span className="pxo-dl">{t('orders.form.orderData')}</span>
                {dataChips.map(([k, v]) => (
                  <span key={k} className="pxo-kv" title={v}>
                    <b>{k}</b>
                    <span className="ltr">{v}</span>
                  </span>
                ))}
                {!order && (
                  <label className="pxo-kv sel">
                    <b>{t('orders.form.source')}</b>
                    <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label={t('orders.form.source')}>
                      {SALES_CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {t(`status.channel.${c}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
            <div className="pxo-notes">
              <label className="pxo-note c">
                <span>{t('orders.form.noteClient')}</span>
                <textarea rows={2} value={noteC} onChange={(e) => setNoteC(e.target.value)} placeholder={t('orders.form.noteClientPh')} />
              </label>
              <label className="pxo-note l">
                <span>{t('orders.form.noteLivreur')}</span>
                <textarea rows={2} value={noteL} onChange={(e) => setNoteL(e.target.value)} placeholder={t('orders.form.noteLivreurPh')} />
              </label>
              <label className="pxo-note t">
                <span>{t('orders.form.noteTeam')}</span>
                <textarea rows={2} value={noteT} onChange={(e) => setNoteT(e.target.value)} placeholder={t('orders.form.noteTeamPh')} />
              </label>
            </div>
          </Sec>

          <Sec ic="user" title={t('orders.form.client')}>
            <div className="pxo-g2">
              <Field label={t('orders.form.name')}>
                <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('orders.form.namePh')} autoComplete="off" required />
              </Field>
              <div className="pxo-ph">
                <Field label={t('orders.form.phone')}>
                  <input className="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('orders.form.phonePh')} inputMode="tel" autoComplete="off" required />
                </Field>
                {!show2 && (
                  <button type="button" className="linkish pxo-t2b" onClick={() => setShow2(true)}>
                    {t('orders.form.addPhone2')}
                  </button>
                )}
              </div>
              <Field label={t('orders.form.wilaya')}>
                <select
                  value={wil}
                  onChange={(e) => {
                    setWil(e.target.value ? Number(e.target.value) : '');
                    setCommune('');
                    setDeskId('');
                    setFeeAuto(true);
                  }}
                >
                  <option value="">{t('orders.form.wilayaPh')}</option>
                  {WILAYAS.map((w, k) => (
                    <option key={k + 1} value={k + 1}>
                      {String(k + 1).padStart(2, '0')} {w}
                    </option>
                  ))}
                </select>
              </Field>
              {!desk && (
                <Field label={t('orders.form.commune')}>
                  <select value={commune} onChange={(e) => setCommune(e.target.value)}>
                    <option value="">{t('orders.form.communePh')}</option>
                    {commune && !communes.some((c) => c[1] === commune) && <option value={commune}>{commune}</option>}
                    {communes.map((c) => (
                      <option key={c[1]} value={c[1]}>
                        {ar ? c[2] || c[1] : c[1]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {show2 && (
                <Field label={t('orders.form.phone2')}>
                  <input className="ltr" value={phone2} onChange={(e) => setPhone2(e.target.value)} placeholder={t('orders.form.phone2Ph')} inputMode="tel" autoComplete="off" />
                </Field>
              )}
              {(address || isEdit || wil !== '') && (
                <div className={show2 ? '' : 'pxo-addr'}>
                  <Field label={t('orders.form.address')}>
                    <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('orders.form.addressPh')} autoComplete="off" />
                  </Field>
                </div>
              )}
            </div>
          </Sec>

          <Sec
            ic="box"
            title={t('orders.form.products')}
            right={
              !locked && (
                <div className="pxo-acts">
                  <button type="button" className="btn small" onClick={() => addLine()}>
                    {t('orders.form.addProduct')}
                  </button>
                </div>
              )
            }
          >
            {locked && <div className="warnbox">{t('orders.form.locked')}</div>}
            <div className="pxo-lines">
              <div className="pxo-lh">
                <span>{t('orders.form.product')}</span>
                <span>{t('orders.form.variant')}</span>
                <span>{t('orders.form.qty')}</span>
                <span className="n">{t('orders.form.price')}</span>
                <span className="n">{t('orders.form.total')}</span>
                <span />
              </div>
              {lines.map((it, idx) => {
                const pr = it.productId ? P.get(it.productId) : undefined;
                const ups = !!autoUp?.flags[idx];
                const v = it.variantId ? V.get(it.variantId) : undefined;
                const s = stockOf(v);
                const fixed = !!pr?.fixedPrice && !isExchange;
                const pk = pr && it.variantId ? pr.packs.find((x) => x.qty === it.qty && Math.round(x.price / x.qty) === Math.round(Number(it.unitPrice))) : undefined;
                const vs = pr?.variants ?? [];
                return (
                  <div key={it.key} className={`pxo-line${ups ? ' ups' : ''}`}>
                    <div className="pxo-li">
                      <div className="pxo-c-p">
                        <ProductPick products={data.products} value={pr?.name ?? it.name ?? ''} disabled={locked} onPick={(x) => pickProduct(it, x)} />
                      </div>
                      <div className="pxo-c-v">
                        {vs.length > 1 || (vs.length === 1 && vs[0].title) ? (
                          <select
                            aria-label={t('orders.form.variant')}
                            value={it.variantId ?? ''}
                            disabled={locked}
                            onChange={(e) => {
                              const nv = V.get(Number(e.target.value));
                              if (nv && pr) update(it.key, { variantId: nv.id, unitPrice: isExchange ? 0 : priceOf(pr, nv) });
                            }}
                          >
                            {!it.variantId && <option value="">{t('orders.form.variantPh')}</option>}
                            {vs.map((x) => {
                              const used = lines.some((y) => y !== it && y.variantId === x.id);
                              return (
                                <option key={x.id} value={x.id} disabled={used}>
                                  {(x.title || t('orders.form.standard')) + (x.stock <= 0 ? ` · ${t('orders.form.rupture')}` : ` · ${t('orders.form.inStock', { n: n(x.stock) })}`) + (used ? ` · ${t('orders.form.already')}` : '')}
                                </option>
                              );
                            })}
                          </select>
                        ) : (
                          <span className="pxo-novar">{pr ? (s === null ? t('orders.form.single') : s <= 0 ? t('orders.form.outOfStock') : t('orders.form.inStock', { n: n(s) })) : '—'}</span>
                        )}
                      </div>
                      <div className="pxo-c-q">
                        <div className="pxo-qty">
                          <button type="button" aria-label={t('orders.form.minus')} disabled={it.qty <= 1 || locked} onClick={() => update(it.key, { qty: Math.max(1, it.qty - 1) })}>
                            −
                          </button>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={it.qty}
                            disabled={locked}
                            aria-label={t('orders.form.qty')}
                            onChange={(e) => update(it.key, { qty: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
                          />
                          <button type="button" aria-label={t('orders.form.plus')} disabled={locked} onClick={() => update(it.key, { qty: it.qty + 1 })}>
                            +
                          </button>
                        </div>
                      </div>
                      <div className="pxo-c-pr">
                        <input
                          type="number"
                          min={0}
                          className={`pxo-num${fixed ? ' px-locked' : ''}`}
                          value={it.unitPrice ?? ''}
                          aria-label={t('orders.form.price')}
                          readOnly={fixed || locked}
                          tabIndex={fixed ? -1 : undefined}
                          title={fixed ? t('orders.form.lockedPrice') : undefined}
                          onChange={(e) => update(it.key, { unitPrice: e.target.value === '' ? null : Number(e.target.value) }, false)}
                        />
                      </div>
                      <div className="pxo-c-t ltr">{da((Number(it.unitPrice) || 0) * it.qty)}</div>
                      <div className="pxo-c-x">
                        {!locked && (
                          <button type="button" className="pxo-rm" aria-label={t('orders.form.remove')} title={t('orders.form.remove')} onClick={() => removeLine(it.key)}>
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const meta: ReactNode[] = [];
                      if (s !== null && it.variantId && it.qty > s)
                        meta.push(
                          <span key="s" className="pxo-tag bad">
                            {s <= 0 ? t('orders.form.outOfStock') : t('orders.form.onlyN', { n: n(s) })}
                          </span>,
                        );
                      if (pk)
                        meta.push(
                          <span key="pk" className="pxo-tag pk">
                            {t('orders.form.pack', { qty: pk.qty, price: da(pk.price) })}
                          </span>,
                        );
                      // editing: shown when Pilotix counts this line as upsell (never ticked by hand)
                      if (ups)
                        meta.push(
                          <span key="u" className="pxo-tag ups on" title={t('orders.form.upsellAuto')}>
                            {t('orders.form.isUpsell')}
                          </span>,
                        );
                      return meta.length ? <div className="pxo-meta">{meta}</div> : null;
                    })()}
                  </div>
                );
              })}
            </div>
            {pErr && <p className="pxo-perr">{pErr}</p>}
            {!locked && (
              <div className="pxo-offers">
                {offers.packs.length || offers.rel.length ? (
                  <>
                    {offers.packs.length > 0 && (
                      <div className="pxo-orow">
                        <span className="pxo-ol">{t('orders.form.packs')}</span>
                        {offers.packs.map(({ it, pr, pk }) => {
                          const v = it.variantId ? V.get(it.variantId) : undefined;
                          const unit = (v ? priceOf(pr, v) : pr.price) || Number(it.unitPrice) || 0;
                          const save = unit * pk.qty - pk.price;
                          return (
                            <button key={`${it.key}-${pk.qty}`} type="button" className="pxo-chip pk" onClick={() => update(it.key, { qty: pk.qty, unitPrice: Math.round(pk.price / pk.qty) })}>
                              <b>
                                {pk.qty} × {pr.name}
                              </b>
                              <span className="ltr">{da(pk.price)}</span>
                              {save > 0 && <small className="ltr">−{da(save)}</small>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {offers.rel.length > 0 && (
                      <div className="pxo-orow">
                        <span className="pxo-ol">{t('orders.form.linked')}</span>
                        {offers.rel.map((lp) => {
                          const v = freeVar(lp, null);
                          return (
                            <button
                              key={lp.id}
                              type="button"
                              className="pxo-chip rel"
                              disabled={!v}
                              onClick={() => {
                                if (!v) return;
                                setFeeAuto(true);
                                setLines((ls) => [...ls.filter((x) => x.variantId || x.productId), { key: lineKey++, productId: lp.id, variantId: v.id, qty: 1, unitPrice: isExchange ? 0 : priceOf(lp, v), isUpsell: false, name: lp.name }]);
                              }}
                            >
                              <b>+ {lp.name}</b>
                              <span className="ltr">{da(lp.price)}</span>
                              {lp.variants.length > 1 && <small>{t('orders.form.variants', { n: lp.variants.length })}</small>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="pxo-none">{t('orders.form.noOffers')}</p>
                )}
              </div>
            )}
          </Sec>

          <Sec ic="truck" title={t('orders.form.delivery')}>
            <div className="pxo-g3">
              <Field label={t('orders.form.partner')}>
                <select
                  value={companyId}
                  onChange={(e) => {
                    const v = e.target.value ? Number(e.target.value) : '';
                    setCompanyId(v);
                    setDeskId('');
                    setFeeAuto(true);
                    const c = data.companies.find((x) => x.id === (v === '' ? data.defaultCompanyId : v));
                    if (c?.kind === 'own') setDesk(false);
                  }}
                >
                  <option value="">{t('orders.form.later')}</option>
                  {data.companies
                    .filter((c) => c.active || c.id === base.companyId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.id === data.defaultCompanyId ? ` ${t('orders.form.byDefault')}` : ''}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="field">
                <span className="lab">{t('orders.form.type')}</span>
                <div className="pxo-seg" role="radiogroup" aria-label={t('orders.form.type')}>
                  {([false, true] as const).map((k) => (
                    <button
                      key={String(k)}
                      type="button"
                      role="radio"
                      aria-checked={desk === k}
                      className={desk === k ? 'on' : ''}
                      disabled={k && isOwn && !desk}
                      title={k && isOwn ? t('orders.form.ownNoDesk') : undefined}
                      onClick={() => {
                        if (desk === k) return;
                        setDesk(k);
                        setFeeAuto(true);
                      }}
                    >
                      {k ? t('orders.form.desk') : t('orders.form.home')}
                    </button>
                  ))}
                </div>
              </div>
              {desk && (
                <Field label={t('orders.form.deskOffice')}>
                  <select value={deskId} disabled={!desksHere.length} onChange={(e) => setDeskId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">{coId === null ? t('orders.form.deskFirst') : desksHere.length ? t('orders.form.deskPh') : t('orders.form.deskNone')}</option>
                    {desksHere.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.address ? ` · ${d.address}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="pxo-liv">
              <span className={`pxo-pill ${ship.k}`}>{ship.k === 'ok' ? t('orders.form.livOk') : ship.k === 'no' ? t('orders.form.livNo') : ship.k === 'todo' ? t('orders.form.livTodo') : t('orders.form.livWait')}</span>
              {[...ship.msgs, ...ship.hard, ...ship.soft, ...ship.info].map((m) => (
                <span key={m} className="pxo-why">
                  {m}
                </span>
              ))}
            </div>
          </Sec>

          <Sec ic="sum" title={t('orders.form.summary')}>
            <div className="pxo-sum">
              <div className="pxo-tr">
                <span>{t('orders.form.items', { count: nItems })}</span>
                <b className="ltr">{da(sub)}</b>
              </div>
              {autoUp && autoUp.value > 0 && (
                <div className="pxo-tr pxo-up" title={t('orders.form.upsellAuto')}>
                  <span>{t('orders.form.upsellLine')}</span>
                  <b className="ltr">+{da(autoUp.value)}</b>
                </div>
              )}
              <div className="pxo-tr">
                <span>
                  {t('orders.form.fee')}
                  <small className="pxo-fn">
                    {q?.fee === null || q?.fee === undefined || wil === '' ? (
                      t('orders.form.feeByWilaya')
                    ) : Number(fee) === q.fee ? (
                      quoteItems.length > 1 ? t('orders.form.feeAutoMax') : t('orders.form.feeAuto')
                    ) : (
                      <button type="button" className="linkish" onClick={() => setFeeAuto(true)}>
                        {t('orders.form.feeReset', { v: da(q.fee) })}
                      </button>
                    )}
                  </small>
                </span>
                <span className="pxo-in">
                  <input
                    type="number"
                    min={0}
                    className="pxo-num"
                    value={fee}
                    aria-label={t('orders.form.fee')}
                    onChange={(e) => {
                      setFeeAuto(false);
                      setFee(e.target.value);
                    }}
                  />{' '}
                  DA
                </span>
              </div>
              <div className="pxo-tr">
                <span>
                  {t('orders.form.discount')}
                  <small className="pxo-fn">{maxD === null ? '' : maxD ? t('orders.form.maxDiscount', { v: da(maxD) }) : t('orders.form.noDiscount')}</small>
                </span>
                <span className="pxo-in">
                  −{' '}
                  <input type="number" min={0} max={maxD ?? undefined} className={`pxo-num${over ? ' px-over' : ''}`} value={discount} aria-label={t('orders.form.discount')} onChange={(e) => setDiscount(e.target.value)} /> DA
                </span>
              </div>
              <div className="pxo-tr grand">
                <span>{t('orders.form.grand')}</span>
                <b className="ltr">{da(sub + feeN - disN)}</b>
              </div>
            </div>
          </Sec>
        </div>
        <p ref={errRef} className="form-err pxo-err" role="alert">
          {err}
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
