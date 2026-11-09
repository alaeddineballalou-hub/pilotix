// « Envoyer des photos »: the order's products (with their colour) are ticked; the agent takes one off, changes a colour
// or adds others, then WhatsApp opens on the customer's chat with the message: the products' names and one link
// (WhatsApp shows its first photo, the customer opens it to see them all). From the agent's own WhatsApp: nothing to set
// up. The photos are the shop's own (Produits & stock); the page shows the shop and the products only.
import { Order, phoneIntl } from '@pilotix/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { copyText, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { AddProduct, Catalog } from './Detail';
import './photos.css';

type Pick = { productId: number; variantId: number | null };
const keyOf = (i: Pick) => `${i.productId}:${i.variantId ?? 0}`;
const uniq = (a: Pick[]) => a.filter((x, k) => a.findIndex((y) => keyOf(y) === keyOf(x)) === k);
/** at most this many products in one send (the server says the same) */
const MAX = 10;
/** where the link goes in the message */
const LINK = '{lien}';

/** `start`: the products on the screen (the order's, as the agent sees them now): ticked first. */
export function SendPhotos({ order, start, catalog, onClose }: { order: Order; start: Pick[]; catalog: Catalog; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const P = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  // the order's products first, each with its colour (a service has no photo)
  const [items, setItems] = useState<Pick[]>(() => uniq(start.filter((i) => !P.get(i.productId)?.isService)).slice(0, MAX));
  const thumbs = useRpc('confirmation.photoThumbs', { items: items.length ? items : [{ productId: 0, variantId: null }] }, { enabled: items.length > 0, staleTime: 60_000 });
  const shotOf = (i: Pick) => thumbs.data?.find((x) => x.productId === i.productId && x.variantId === i.variantId);
  const nameOf = (i: Pick) => {
    const p = P.get(i.productId);
    const v = p?.variants.find((x) => x.id === i.variantId);
    return `${p?.name ?? order.items.find((x) => x.productId === i.productId)?.name ?? '—'}${v?.title?.trim() ? ` — ${v.title.trim()}` : ''}`;
  };
  const withPhotos = items.filter((i) => (shotOf(i)?.count ?? 0) > 0);
  // the message: written for the products chosen, until the agent changes it himself
  const auto = [
    t('confirmation.photos.hello', { nom: order.customerName.trim() || '', ref: order.ref, boutique: meta.data?.shopName ?? '' }).replace(/\s+👋/, ' 👋'),
    ...withPhotos.map((i) => `• ${nameOf(i)}`),
    `👉 ${LINK}`,
  ].join('\n');
  const [own, setOwn] = useState<string | null>(null);
  const text = own ?? auto;
  const [busy, setBusy] = useState(false);
  /** the message ready (its link made): when the browser kept WhatsApp from opening, or in the preview */
  const [ready, setReady] = useState<{ href: string | null; body: string } | null>(null);

  const setAt = (k: number, next: Pick) => setItems((cur) => uniq(cur.map((x, j) => (j === k ? next : x))));
  const add = (productId: number, variantId: number | null) => {
    if (items.length >= MAX) return toast(t('confirmation.photos.max', { n: MAX }), 'info');
    setItems((cur) => uniq([...cur, { productId, variantId }]));
  };

  const make = async () => {
    if (!withPhotos.length) return toast(t('confirmation.photos.none'), 'info');
    if (!text.includes(LINK)) return toast(t('confirmation.photos.needLink', { link: LINK }), 'info', 6000);
    setBusy(true);
    try {
      const r = await rpc('confirmation.photoShare', { orderId: order.id, items: withPhotos });
      if (r.missing.length) toast(t('confirmation.photos.missing', { names: r.missing.join(', ') }), 'info', 6000);
      if (!r.url) {
        // the preview has no public address: the message is shown, WhatsApp opens on the real Pilotix
        setReady({ href: null, body: text.replace(LINK, 'https://pilotix.online/…') });
        return;
      }
      const body = text.replace(LINK, r.url);
      const href = `https://wa.me/${phoneIntl(order.phone)}?text=${encodeURIComponent(body)}`;
      const w = window.open(href, '_blank');
      if (w) {
        w.opener = null;
        toast(t('confirmation.photos.opened'), 'ok');
        onClose();
      } else setReady({ href, body });
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad', 6000);
    } finally {
      setBusy(false);
    }
  };

  const lines = items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: '', variantTitle: '', qty: 1, unitPrice: 0, isUpsell: false }));
  return (
    <Modal
      sheet
      title={
        <span className="sph-title">
          <Icon name="image" /> {t('confirmation.photos.title')}
        </span>
      }
      onClose={onClose}
      className="sph"
      footer={
        ready ? (
          <>
            <button type="button" className="btn" onClick={() => setReady(null)}>
              {t('confirmation.photos.back')}
            </button>
            <button type="button" className="btn" onClick={async () => toast(t((await copyText(ready.body)) ? 'confirmation.msg.copied' : 'confirmation.photos.copyFail'), 'ok')}>
              <Icon name="copy" /> {t('confirmation.photos.copy')}
            </button>
            {ready.href && (
              <a className="btn primary sph-wa" href={ready.href} target="_blank" rel="noreferrer" onClick={() => onClose()}>
                <Icon name="whatsapp" /> {t('confirmation.photos.open')}
              </a>
            )}
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn primary sph-wa" disabled={busy || !withPhotos.length} onClick={make}>
              <Icon name="whatsapp" /> {busy ? t('confirmation.photos.making') : t('confirmation.photos.send', { count: withPhotos.length })}
            </button>
          </>
        )
      }
    >
      {ready ? (
        <div className="sph-ready">
          <p className="sph-help">{ready.href ? t('confirmation.photos.blocked') : t('confirmation.photos.demo')}</p>
          <pre className="sph-msg-ready">{ready.body}</pre>
        </div>
      ) : (
        <>
          <p className="sph-help">
            {t('confirmation.photos.help', { nom: order.customerName.trim() || order.phone })} <span className="ltr">{order.phone}</span>
          </p>
          <ul className="sph-list">
            {items.map((i, k) => {
              const p = P.get(i.productId);
              const shot = shotOf(i);
              const vs = (p?.variants ?? []).filter((v) => v.title.trim() !== '');
              const none = shot && shot.count === 0;
              return (
                <li key={keyOf(i)} className={`sph-it${none ? ' none' : ''}`}>
                  <span className="sph-pic" aria-hidden="true">
                    {shot?.thumbs[0] ? <img src={shot.thumbs[0]} alt="" /> : <Icon name={thumbs.isLoading ? 'image' : 'package'} />}
                    {(shot?.count ?? 0) > 1 && <b className="sph-n ltr">{shot!.count}</b>}
                  </span>
                  <span className="sph-main">
                    <b>{p?.name ?? nameOf(i)}</b>
                    {vs.length > 0 ? (
                      <select className="sph-var" dir="auto" aria-label={t('confirmation.photos.colour', { name: p?.name ?? '' })} value={i.variantId ?? ''} onChange={(e) => setAt(k, { productId: i.productId, variantId: e.target.value ? Number(e.target.value) : null })}>
                        {i.variantId === null && <option value="">{t('confirmation.photos.anyColour')}</option>}
                        {vs.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.title}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <small className={none ? 'sph-bad' : 'sph-ok'}>{!shot ? '…' : none ? t('confirmation.photos.noPhoto') : t('confirmation.photos.nPhotos', { count: shot.count })}</small>
                  </span>
                  <button type="button" className="sph-rm" aria-label={t('confirmation.photos.remove', { name: nameOf(i) })} onClick={() => setItems((cur) => cur.filter((_, j) => j !== k))}>
                    <Icon name="x" />
                  </button>
                </li>
              );
            })}
            {items.length === 0 && <li className="sph-empty">{t('confirmation.photos.empty')}</li>}
          </ul>
          <div className="sph-add">
            <AddProduct catalog={catalog.filter((p) => !p.isService)} lines={lines} onPick={(p, vid) => add(p.id, vid)} markLabel={t('confirmation.photos.chosen')} placeholder={t('confirmation.photos.addPh')} />
          </div>
          <label className="sph-msg">
            <span>
              {t('confirmation.photos.message')}
              {own !== null && (
                <button type="button" className="linkish" onClick={() => setOwn(null)}>
                  {t('confirmation.photos.reset')}
                </button>
              )}
            </span>
            <textarea rows={Math.min(9, 3 + withPhotos.length)} value={text} onChange={(e) => setOwn(e.target.value)} dir="auto" />
            <small>{t('confirmation.photos.linkHint', { link: LINK })}</small>
          </label>
        </>
      )}
    </Modal>
  );
}
