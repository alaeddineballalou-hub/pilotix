import { Language, normalizePhone, Order, WILAYAS } from '@pilotix/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/ui';
import { api } from '../lib/api';
import { formatDZD } from '../lib/i18n';

interface Line {
  productId: number | '';
  variant: string;
  quantity: number;
}

export function NewOrderDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (o: Order) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Language;
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ['products'], queryFn: () => api.products(), staleTime: 300_000 });
  const [f, setF] = useState({ customerName: '', phone: '', wilaya: 16, commune: '', address: '', deliveryFee: 400, discount: 0, note: '' });
  const [lines, setLines] = useState<Line[]>([{ productId: '', variant: '', quantity: 1 }]);
  const [err, setErr] = useState('');

  const price = (pid: number | '') => products.data?.find((p) => p.id === pid)?.price ?? 0;
  const subtotal = lines.reduce((s, l) => s + price(l.productId) * l.quantity, 0);
  const total = subtotal - Math.min(f.discount, subtotal) + f.deliveryFee;

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        ...f,
        note: f.note || null,
        items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, variant: l.variant || null, quantity: l.quantity })),
      }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      onCreated(o);
    },
    onError: (e: Error) => setErr(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!normalizePhone(f.phone)) return setErr(t('orders.phone') + ' ?');
    if (!lines.some((l) => l.productId)) return setErr(t('orders.items') + ' ?');
    create.mutate();
  }

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  return (
    <div className="drawer-wrap" onClick={onClose}>
      <form className="drawer" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">{t('orders.new')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('orders.close')}>
            <Icon.close />
          </button>
        </div>
        <section className="card">
          <div className="grid2">
            <label className="field">
              <span>{t('orders.customer')}</span>
              <input required value={f.customerName} onChange={(e) => set('customerName', e.target.value)} />
            </label>
            <label className="field">
              <span>{t('orders.phone')}</span>
              <input required type="tel" dir="ltr" inputMode="tel" placeholder="0661 23 45 67" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
            </label>
            <label className="field">
              <span>{t('orders.wilaya')}</span>
              <select value={f.wilaya} onChange={(e) => set('wilaya', Number(e.target.value))}>
                {WILAYAS.map((w, i) => (
                  <option key={i} value={i + 1}>
                    {String(i + 1).padStart(2, '0')} · {w}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('orders.commune')}</span>
              <input value={f.commune} onChange={(e) => set('commune', e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>{t('orders.address')}</span>
            <input value={f.address} onChange={(e) => set('address', e.target.value)} />
          </label>
        </section>

        <section className="card">
          <h2>{t('orders.items')}</h2>
          {lines.map((l, i) => {
            const prod = products.data?.find((p) => p.id === l.productId);
            const update = (patch: Partial<Line>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div className="row" key={i}>
                <select className="grow" style={{ flexBasis: 180 }} value={l.productId} onChange={(e) => update({ productId: e.target.value ? Number(e.target.value) : '', variant: '' })}>
                  <option value="" />
                  {products.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatDZD(p.price, lang)}
                    </option>
                  ))}
                </select>
                {prod && prod.variants.length > 0 && (
                  <select style={{ width: 'auto' }} value={l.variant} onChange={(e) => update({ variant: e.target.value })} required>
                    <option value="" />
                    {prod.variants.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                )}
                <input type="number" min={1} max={999} dir="ltr" style={{ width: 80 }} aria-label={t('orders.quantity')} value={l.quantity} onChange={(e) => update({ quantity: Math.max(1, Number(e.target.value) || 1) })} />
                {lines.length > 1 && (
                  <button type="button" className="icon-btn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={t('orders.cancel')}>
                    <Icon.close />
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className="btn small" onClick={() => setLines((ls) => [...ls, { productId: '', variant: '', quantity: 1 }])}>
            <Icon.plus /> {t('orders.addItem')}
          </button>
          <div className="grid2">
            <label className="field">
              <span>{t('orders.deliveryFee')}</span>
              <input type="number" min={0} dir="ltr" value={f.deliveryFee} onChange={(e) => set('deliveryFee', Math.max(0, Number(e.target.value) || 0))} />
            </label>
            <label className="field">
              <span>{t('orders.discount')}</span>
              <input type="number" min={0} dir="ltr" value={f.discount} onChange={(e) => set('discount', Math.max(0, Number(e.target.value) || 0))} />
            </label>
          </div>
          <label className="field">
            <span>{t('orders.note')}</span>
            <textarea value={f.note} onChange={(e) => set('note', e.target.value)} />
          </label>
          <div className="row">
            <b className="grow">{t('orders.total')}</b>
            <b className="ltr">{formatDZD(total, lang)}</b>
          </div>
        </section>
        {err && <p className="err">{err}</p>}
        <button className="btn primary" disabled={create.isPending}>
          {t('orders.create')}
        </button>
      </form>
    </div>
  );
}
