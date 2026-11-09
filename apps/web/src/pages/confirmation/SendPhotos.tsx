// « Envoyer des photos »: the order's products (with their colour) are ticked; the agent takes one off, changes a colour
// (or takes « Toutes les couleurs ») or adds others. On a phone it goes in two steps from the agent's own WhatsApp:
// 1 the message opens in the customer's chat (it makes the chat), 2 the real photos go in (the Pilotix app puts them
// straight into that chat, a phone's browser through its share menu; a link carries text only: lib/waShare). On a
// computer, one step: the message carries one link to the photos (WhatsApp shows the first). The photos are the shop's
// own (Produits & stock); their page shows the shop and the products only.
import { Order, phoneWa } from '@pilotix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { photoFiles, sendMode, sharePhotoFiles, WA_APPS, waApps, waChat, waPhotos } from '../../lib/waShare';
import { copyText, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { AddProduct, Catalog } from './Detail';
import './photos.css';

/** a product and its colour; `all`: every colour of it, each with its own photos */
type Pick = { productId: number; variantId: number | null; all?: boolean };
const keyOf = (i: Pick) => `${i.productId}:${i.all ? 'all' : (i.variantId ?? 0)}`;
const uniq = (a: Pick[]) => a.filter((x, k) => a.findIndex((y) => keyOf(y) === keyOf(x)) === k);
/** at most this many products, and this many photos, in one send (the server says the same) */
const MAX = 10;
const MAX_PHOTOS = 30;
/** where the link goes in the message (a computer's) */
const LINK = '{lien}';
/** the WhatsApp the agent uses in the app, when the phone has both */
const APP_KEY = 'waApp';

type Sent = {
  body: string;
  /** the customer's chat with the message (a browser's step 1) */
  href: string | null;
  photos: string[];
  /** opened · blocked: the browser kept WhatsApp from opening · demo: the preview, nothing opens */
  step1: 'opened' | 'blocked' | 'demo';
  step2: 'todo' | 'busy' | 'done';
};

/** `start`: the products on the screen (the order's, as the agent sees them now): ticked first. */
export function SendPhotos({ order, start, catalog, onClose }: { order: Order; start: Pick[]; catalog: Catalog; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const P = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const mode = useMemo(sendMode, []);
  // the order's products first, each with its colour (a service has no photo)
  const [items, setItems] = useState<Pick[]>(() => uniq(start.filter((i) => !P.get(i.productId)?.isService)).slice(0, MAX));
  const thumbs = useRpc('confirmation.photoThumbs', { items: items.length ? items : [{ productId: 0, variantId: null }] }, { enabled: items.length > 0, staleTime: 60_000 });
  const shotOf = (i: Pick) => thumbs.data?.find((x) => x.productId === i.productId && x.variantId === i.variantId && !!x.all === !!i.all);
  const nameOf = (i: Pick) => {
    const p = P.get(i.productId);
    const name = p?.name ?? order.items.find((x) => x.productId === i.productId)?.name ?? '—';
    if (i.all) {
      const cs = shotOf(i)?.colours ?? [];
      return cs.length ? `${name} — ${cs.join(', ')}` : name;
    }
    const v = p?.variants.find((x) => x.id === i.variantId);
    return `${name}${v?.title?.trim() ? ` — ${v.title.trim()}` : ''}`;
  };
  const withPhotos = items.filter((i) => (shotOf(i)?.count ?? 0) > 0);
  const total = withPhotos.reduce((s, i) => s + (shotOf(i)?.count ?? 0), 0);
  // the message: written for the products chosen, until the agent changes it himself (a computer's carries the link)
  const auto = [
    t('confirmation.photos.hello', { nom: order.customerName.trim() || '', ref: order.ref, boutique: meta.data?.shopName ?? '' }).replace(/\s+👋/, ' 👋'),
    ...withPhotos.map((i) => `• ${nameOf(i)}`),
    ...(mode === 'link' ? [`👉 ${LINK}`] : []),
  ].join('\n');
  const [own, setOwn] = useState<string | null>(null);
  const text = own ?? auto;
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  /** the share menu's photos, fetched while the agent sends the message */
  const files = useRef<Promise<File[] | null> | null>(null);

  // the app: which WhatsApp (normal, Business) — asked once when the phone has both, then remembered
  const [apps, setApps] = useState<string[]>([]);
  const [app, setApp] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'app') return;
    let live = true;
    void waApps().then((a) => {
      if (!live) return;
      setApps(a);
      const kept = store.get(APP_KEY);
      setApp(kept && a.includes(kept) ? kept : (a[0] ?? null));
    });
    return () => {
      live = false;
    };
  }, [mode]);
  const chooseApp = (a: string) => {
    setApp(a);
    store.set(APP_KEY, a);
  };

  const setAt = (k: number, next: Pick) => setItems((cur) => uniq(cur.map((x, j) => (j === k ? next : x))));
  const add = (productId: number, variantId: number | null) => {
    if (items.length >= MAX) return toast(t('confirmation.photos.max', { n: MAX }), 'info');
    setItems((cur) => uniq([...cur, { productId, variantId }]));
  };
  const failed = (e: any) => toast(e?.code === 'NO_WHATSAPP' ? t('confirmation.photos.noWhatsapp') : (e?.message ?? String(e)), 'bad', 6000);

  /** step 1 (a computer: the only one): the photos made, then the customer's chat opens with the message */
  const make = async () => {
    if (!withPhotos.length) return toast(t('confirmation.photos.none'), 'info');
    if (mode === 'link' && !text.includes(LINK)) return toast(t('confirmation.photos.needLink', { link: LINK }), 'info', 6000);
    setBusy(true);
    try {
      const r = await rpc('confirmation.photoShare', { orderId: order.id, items: withPhotos });
      if (r.missing.length) toast(t('confirmation.photos.missing', { names: r.missing.join(', ') }), 'info', 6000);
      if (r.cut) toast(t('confirmation.photos.cut', { count: r.cut, n: MAX_PHOTOS }), 'info', 6000);
      const phone = phoneWa(order.phone);
      const body = text.replace(LINK, r.url ?? 'https://pilotix.online/…');
      if (!r.url) {
        // the preview has no public address: what would go is shown, nothing opens
        setSent({ body, href: null, photos: r.photos, step1: 'demo', step2: 'todo' });
        return;
      }
      if (mode === 'share') files.current = photoFiles(r.photos).catch(() => null);
      if (mode === 'app') {
        await waChat(phone, body, app);
        setSent({ body, href: null, photos: r.photos, step1: 'opened', step2: 'todo' });
        return;
      }
      const href = `https://wa.me/${phone}?text=${encodeURIComponent(body)}`;
      const w = window.open(href, '_blank');
      if (w) w.opener = null;
      if (mode === 'link' && w) {
        toast(t('confirmation.photos.opened'), 'ok');
        onClose();
        return;
      }
      setSent({ body, href, photos: r.photos, step1: w ? 'opened' : 'blocked', step2: 'todo' });
    } catch (e: any) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  /** step 1 again (the agent closed WhatsApp before sending) */
  const reopen = async () => {
    if (!sent || sent.step1 === 'demo') return;
    if (mode === 'app') await waChat(phoneWa(order.phone), sent.body, app).catch(failed);
    else if (sent.href) window.open(sent.href, '_blank');
    setSent({ ...sent, step1: 'opened' });
  };

  /** step 2: the real photos into the customer's chat (the message copied too, to paste under them) */
  const sendPhotos = async () => {
    if (!sent) return;
    if (sent.step1 === 'demo') return toast(t('confirmation.photos.demoStep'), 'info', 6000);
    void copyText(sent.body);
    setSent({ ...sent, step2: 'busy' });
    try {
      if (mode === 'app') {
        await waPhotos(phoneWa(order.phone), sent.photos, app);
        toast(t('confirmation.photos.photosOpened'), 'ok', 6000);
      } else {
        const f = await (files.current ??= photoFiles(sent.photos).catch(() => null));
        if (!f?.length) {
          files.current = null;
          throw new Error(t('confirmation.photos.photosFail'));
        }
        if ((await sharePhotoFiles(f)) === 'cancelled') return setSent((s) => s && { ...s, step2: 'todo' });
      }
      setSent((s) => s && { ...s, step2: 'done' });
    } catch (e: any) {
      setSent((s) => s && { ...s, step2: 'todo' });
      if (e?.name === 'NotAllowedError') toast(t('confirmation.photos.again'), 'info', 6000);
      else failed(e);
    }
  };

  const lines = items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: '', variantTitle: '', qty: 1, unitPrice: 0, isUpsell: false }));
  /** the phone's two steps (a computer's message has one) */
  const steps = mode !== 'link' ? sent : null;
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
        steps ? (
          <>
            <button type="button" className="btn" onClick={() => setSent(null)}>
              {t('confirmation.photos.back')}
            </button>
            <button type="button" className="btn" onClick={async () => toast(t((await copyText(steps.body)) ? 'confirmation.msg.copied' : 'confirmation.photos.copyFail'), 'ok')}>
              <Icon name="copy" /> {t('confirmation.photos.copy')}
            </button>
            <button type="button" className={`btn${steps.step2 === 'done' ? ' primary' : ''}`} onClick={onClose}>
              {t('confirmation.photos.done')}
            </button>
          </>
        ) : sent ? (
          <>
            <button type="button" className="btn" onClick={() => setSent(null)}>
              {t('confirmation.photos.back')}
            </button>
            <button type="button" className="btn" onClick={async () => toast(t((await copyText(sent.body)) ? 'confirmation.msg.copied' : 'confirmation.photos.copyFail'), 'ok')}>
              <Icon name="copy" /> {t('confirmation.photos.copy')}
            </button>
            {sent.href && (
              <a className="btn primary sph-wa" href={sent.href} target="_blank" rel="noreferrer" onClick={() => onClose()}>
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
              <Icon name="whatsapp" /> {busy ? t('confirmation.photos.making') : mode === 'link' ? t('confirmation.photos.send', { count: withPhotos.length }) : t('confirmation.photos.step1')}
            </button>
          </>
        )
      }
    >
      {steps ? (
        <div className="sph-steps">
          {steps.step1 === 'demo' && <p className="sph-help">{t('confirmation.photos.demoSteps')}</p>}
          <div className={`sph-step${steps.step1 === 'blocked' ? '' : ' done'}`}>
            <span className="sph-sn" aria-hidden="true">
              {steps.step1 === 'blocked' ? '1' : <Icon name="check" />}
            </span>
            <div className="sph-sb">
              <b>{t('confirmation.photos.step1')}</b>
              <small>{steps.step1 === 'blocked' ? t('confirmation.photos.blocked') : t('confirmation.photos.step1Done')}</small>
              {steps.step1 === 'blocked' && steps.href ? (
                <a className="btn primary sph-wa" href={steps.href} target="_blank" rel="noreferrer" onClick={() => setSent({ ...steps, step1: 'opened' })}>
                  <Icon name="whatsapp" /> {t('confirmation.photos.open')}
                </a>
              ) : steps.step1 === 'opened' ? (
                <button type="button" className="linkish sph-again" onClick={reopen}>
                  {t('confirmation.photos.reopen')}
                </button>
              ) : null}
            </div>
          </div>
          <div className={`sph-step${steps.step2 === 'done' ? ' done' : ' now'}`}>
            <span className="sph-sn" aria-hidden="true">
              {steps.step2 === 'done' ? <Icon name="check" /> : '2'}
            </span>
            <div className="sph-sb">
              <b>{t('confirmation.photos.step2Title', { count: steps.photos.length })}</b>
              <small>{steps.step2 === 'done' ? t('confirmation.photos.photosOpened') : mode === 'app' ? t('confirmation.photos.step2App') : t('confirmation.photos.step2Share')}</small>
              <button type="button" className="btn primary sph-wa" disabled={steps.step2 === 'busy'} onClick={sendPhotos}>
                <Icon name="image" /> {steps.step2 === 'busy' ? t('confirmation.photos.making') : t('confirmation.photos.step2', { count: steps.photos.length })}
              </button>
              <small className="sph-note">{t('confirmation.photos.copiedToo')}</small>
            </div>
          </div>
          <pre className="sph-msg-ready" dir="auto">{steps.body}</pre>
        </div>
      ) : sent ? (
        <div className="sph-ready">
          <p className="sph-help">{sent.href ? t('confirmation.photos.blocked') : t('confirmation.photos.demo')}</p>
          <pre className="sph-msg-ready" dir="auto">{sent.body}</pre>
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
                      <select
                        className="sph-var"
                        dir="auto"
                        aria-label={t('confirmation.photos.colour', { name: p?.name ?? '' })}
                        value={i.all ? 'all' : (i.variantId ?? '')}
                        onChange={(e) => {
                          const v = e.target.value;
                          setAt(k, v === 'all' ? { productId: i.productId, variantId: null, all: true } : { productId: i.productId, variantId: v ? Number(v) : null });
                        }}
                      >
                        {vs.length > 1 && <option value="all">{t('confirmation.photos.allColours')}</option>}
                        {i.variantId === null && !i.all && <option value="">{t('confirmation.photos.anyColour')}</option>}
                        {vs.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.title}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <small className={none ? 'sph-bad' : 'sph-ok'}>
                      {!shot ? '…' : none ? t('confirmation.photos.noPhoto') : i.all && shot.colours.length ? t('confirmation.photos.nColours', { count: shot.colours.length, photos: t('confirmation.photos.nPhotos', { count: shot.count }) }) : t('confirmation.photos.nPhotos', { count: shot.count })}
                    </small>
                  </span>
                  <button type="button" className="sph-rm" aria-label={t('confirmation.photos.remove', { name: nameOf(i) })} onClick={() => setItems((cur) => cur.filter((_, j) => j !== k))}>
                    <Icon name="x" />
                  </button>
                </li>
              );
            })}
            {items.length === 0 && <li className="sph-empty">{t('confirmation.photos.empty')}</li>}
          </ul>
          {total > MAX_PHOTOS && <p className="sph-help sph-bad">{t('confirmation.photos.maxPhotos', { n: MAX_PHOTOS })}</p>}
          <div className="sph-add">
            <AddProduct catalog={catalog.filter((p) => !p.isService)} lines={lines} onPick={(p, vid) => add(p.id, vid)} markLabel={t('confirmation.photos.chosen')} placeholder={t('confirmation.photos.addPh')} />
          </div>
          {mode === 'app' && apps.length > 1 && (
            <div className="sph-apps">
              <span>{t('confirmation.photos.whichApp')}</span>
              <div className="sph-seg" role="group" aria-label={t('confirmation.photos.whichApp')}>
                {apps.map((a) => (
                  <button key={a} type="button" aria-pressed={app === a} onClick={() => chooseApp(a)}>
                    {WA_APPS[a]}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            <small>{mode === 'link' ? t('confirmation.photos.linkHint', { link: LINK }) : t('confirmation.photos.photosHint')}</small>
          </label>
        </>
      )}
    </Modal>
  );
}
