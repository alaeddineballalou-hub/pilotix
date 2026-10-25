// The editor of one landing page: the form on one side, the page itself on the other (live, desktop or phone), drawn
// by the very function the server uses, so what is seen here is what customers get.
import { LANDING_COLORS, LANDING_DEFAULT_COLOR, LandingView, renderLanding } from '@pilotix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc, serverUrl } from '../../lib/backend';
import { da } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SaveBar } from '../ai/agent';
import { useDebounced } from '../depot/OrderList';
import { useLandingFrame } from './frame';
import { publicUrl } from './index';
import { measure, toWebp } from './webp';

type Img = { id: number | null; url: string | null; w: number; h: number; thumb: string; src: string };
type Page = Out<'landing.get'>;
type Level = 'relaxed' | 'normal' | 'strict';
const DESKTOP_W = 1280;

export function Editor({ id }: { id: number | null }) {
  const cur = useRpc('landing.get', { id: id ?? 0 }, { enabled: !!id, refetchOnWindowFocus: false });
  if (id && cur.isLoading) return <Loading />;
  if (id && cur.error) return <ErrorBox error={cur.error} onRetry={() => cur.refetch()} />;
  return <Form key={id ?? 'new'} p={id ? cur.data ?? null : null} />;
}

const draftOf = (p: Page | null) => ({
  productId: p?.productId ?? 0,
  slug: p?.slug ?? '',
  active: p ? p.active : true,
  title: p?.title ?? '',
  color: p?.color ?? LANDING_DEFAULT_COLOR,
  price: p?.price === null || p?.price === undefined ? '' : String(p.price),
  oldPrice: p?.oldPrice === null || p?.oldPrice === undefined ? '' : String(p.oldPrice),
  description: p?.description ?? '',
  variantLabel: p?.variantLabel ?? 'اللون',
  fraudLevel: (p?.fraudLevel ?? 'normal') as Level,
  images: (p?.images ?? []) as Img[],
});
type Draft = ReturnType<typeof draftOf>;
const keyOf = (d: Draft) => JSON.stringify({ ...d, images: d.images.map((i) => i.id ?? i.url) });

function Form({ p }: { p: Page | null }) {
  const { t } = useTranslation();
  const [d, setD] = useState<Draft>(() => draftOf(p));
  const [saved, setSaved] = useState(() => keyOf(draftOf(p)));
  const [slugTouched, setSlugTouched] = useState(!!p);
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');
  const [busy, setBusy] = useState(0);
  const [url, setUrl] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const products = useRpc('landing.products', {});
  const ctx = useRpc('landing.context', { productId: d.productId }, { enabled: !!d.productId });
  const save = useAction('landing.save', {
    success: t('landing.ed.saved'),
    onDone: (r) => {
      setSaved(keyOf(d));
      if (!p) location.hash = `#/landing/pages/${r.id}`;
    },
  });
  const dirty = keyOf(d) !== saved;

  // a new page takes its product's name as address, until the address is typed by hand
  useEffect(() => {
    const prod = products.data?.find((x) => x.id === d.productId);
    if (!prod || slugTouched) return;
    let live = true;
    rpc('landing.freeSlug', { name: prod.name, id: p?.id }).then((r) => live && set('slug', r.slug));
    return () => {
      live = false;
    };
  }, [d.productId, products.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? []).slice(0, 12 - d.images.length)) {
      setBusy((b) => b + 1);
      try {
        const img = await rpc('landing.addImage', await toWebp(f));
        setD((x) => ({ ...x, images: [...x.images, img] }));
      } catch (e) {
        toast((e as Error).message, 'bad');
      } finally {
        setBusy((b) => b - 1);
      }
    }
  };
  const addUrl = async () => {
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) return toast(t('landing.ed.urlBad'), 'bad');
    try {
      const { w, h } = await measure(u);
      setD((x) => ({ ...x, images: [...x.images, { id: null, url: u, w, h, thumb: u, src: u }] }));
      setUrl('');
    } catch {
      toast(t('landing.ed.urlBad'), 'bad');
    }
  };
  const move = (i: number, by: number) =>
    setD((x) => {
      const a = [...x.images];
      const j = i + by;
      if (j < 0 || j >= a.length) return x;
      [a[i], a[j]] = [a[j], a[i]];
      return { ...x, images: a };
    });

  const submit = () => {
    if (!d.productId) return toast(t('landing.ed.pickProduct'), 'bad');
    save.mutate({
      id: p?.id,
      productId: d.productId,
      slug: d.slug.trim(),
      active: d.active,
      title: d.title.trim(),
      color: d.color,
      price: d.price === '' ? null : Math.round(Number(d.price) || 0),
      oldPrice: d.oldPrice === '' ? null : Math.round(Number(d.oldPrice) || 0),
      description: d.description,
      variantLabel: d.variantLabel.trim(),
      fraudLevel: d.fraudLevel,
      images: d.images.map((i) => (i.id ? { id: i.id } : { url: i.url!, w: i.w, h: i.h })),
    });
  };
  const remove = async () => {
    if (!p || !window.confirm(t('landing.ed.removeAsk'))) return;
    await rpc('landing.remove', { id: p.id });
    toast(t('landing.ed.removed'), 'ok');
    location.hash = '#/landing/pages';
  };

  // the preview: the public page drawn from the form (debounced so typing stays smooth)
  const view = useDebounced(d, 250);
  const { html, weight } = useMemo(() => {
    const c = ctx.data;
    if (!c) return { html: '', weight: 0 };
    const v: LandingView = {
      slug: view.slug || 'apercu',
      title: view.title.trim() || c.name,
      color: view.color,
      price: view.price === '' ? c.price : Math.round(Number(view.price) || 0),
      oldPrice: view.oldPrice === '' ? null : Math.round(Number(view.oldPrice) || 0),
      description: view.description,
      variantLabel: view.variantLabel.trim() || 'اللون',
      variants: c.variants,
      images: view.images.map((i) => ({ src: i.src, srcset: `${i.src} 480w`, thumb: i.thumb, w: i.w, h: i.h })),
      fees: c.fees,
      shopName: c.shopName,
    };
    const r = { mode: 'preview' as const, post: '', geo: '', challenge: 'apercu', bits: c.bits };
    // the weight customers download before pictures (here the pictures are inside the page, as data)
    const bare = renderLanding({ ...v, images: v.images.map((i) => ({ ...i, src: 'x', srcset: 'x 480w', thumb: 'x' })) }, r);
    return { html: renderLanding(v, r), weight: new Blob([bare]).size };
  }, [view, ctx.data]);
  const frame = useRef<HTMLIFrameElement>(null);
  useLandingFrame(frame);
  // « Ordinateur »: the page drawn 1280 px wide, then scaled down to fit the box
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, (el.clientWidth - 28) / DESKTOP_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const prod = products.data?.find((x) => x.id === d.productId);

  return (
    <div className="pd lp">
      <div className="lp-ed-top">
        <a className="btn small" href="#/landing/pages">
          <Icon name="chevl" /> {t('landing.ed.back')}
        </a>
        <h1 dir="auto">{p ? d.title || p.productName : t('landing.ed.newTitle')}</h1>
        {p && (
          <a className="btn small" href={publicUrl(p.slug)} target={backend.kind === 'demo' ? undefined : '_blank'} rel="noreferrer">
            <Icon name="external" /> {t('landing.list.open')}
          </a>
        )}
      </div>
      <div className="lp-ed">
        <form
          className="lp-ed-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <section className="card">
            <h2>{t('landing.ed.sProduct')}</h2>
            <Field label={t('landing.ed.product')}>
              <select value={d.productId || ''} onChange={(e) => set('productId', Number(e.target.value))}>
                <option value="">{t('landing.ed.pickProduct')}</option>
                {(products.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {da(x.price)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('landing.ed.slug')} hint={t('landing.ed.slugHint')}>
              <div className="lp-slug">
                <span className="ltr">{backend.kind === 'demo' ? '…/lp/' : `${serverUrl() || ''}/api/lp/`.replace(/^https?:\/\//, '')}</span>
                <input
                  className="ltr"
                  value={d.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                  }}
                />
              </div>
            </Field>
            <label className="check">
              <input type="checkbox" checked={d.active} onChange={(e) => set('active', e.target.checked)} />
              {t('landing.ed.active')}
            </label>
          </section>

          <section className="card">
            <h2>{t('landing.ed.sLook')}</h2>
            <Field label={t('landing.ed.color')}>
              <div className="lp-colors" role="radiogroup" aria-label={t('landing.ed.color')}>
                {LANDING_COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={c} className={`lp-sw ${d.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} />
                ))}
                <label className="lp-sw lp-sw-pick" title={t('landing.ed.colorOther')}>
                  <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} aria-label={t('landing.ed.colorOther')} />
                  <Icon name="pipette" />
                </label>
                <code className="ltr">{d.color}</code>
              </div>
            </Field>
            <Field label={t('landing.ed.title')} hint={t('landing.ed.titleHint')}>
              <input dir="auto" value={d.title} placeholder={prod?.name ?? ''} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <div className="grid2">
              <Field label={t('landing.ed.price')} hint={ctx.data ? t('landing.ed.priceHint', { price: da(ctx.data.price) }) : undefined}>
                <input type="number" min={0} step={50} value={d.price} placeholder={ctx.data ? String(ctx.data.price) : ''} onChange={(e) => set('price', e.target.value)} />
              </Field>
              <Field label={t('landing.ed.oldPrice')} hint={t('landing.ed.oldPriceHint')}>
                <input type="number" min={0} step={50} value={d.oldPrice} onChange={(e) => set('oldPrice', e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="card">
            <h2>
              {t('landing.ed.sImages')} <small className="muted">{d.images.length}/12</small>
            </h2>
            <div className="lp-imgs">
              {d.images.map((im, i) => (
                <figure key={`${im.id ?? im.url}-${i}`} className="lp-img">
                  <img src={im.thumb} alt="" />
                  {i === 0 && <span className="chip">{t('landing.ed.main')}</span>}
                  <div className="lp-img-a">
                    <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('landing.ed.before')}>
                      <Icon name="chevl" />
                    </button>
                    <button type="button" className="icon-btn" disabled={i === d.images.length - 1} onClick={() => move(i, 1)} aria-label={t('landing.ed.after')}>
                      <Icon name="chevr" />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => set('images', d.images.filter((_, k) => k !== i))} aria-label={t('landing.ed.removeImg')}>
                      <Icon name="x" />
                    </button>
                  </div>
                </figure>
              ))}
              {d.images.length < 12 && (
                <label className={`lp-img lp-add ${busy ? 'busy' : ''}`}>
                  <input type="file" accept="image/*" multiple onChange={(e) => addFiles(e.target.files).then(() => (e.target.value = ''))} />
                  <Icon name="camera" />
                  <span>{busy ? t('landing.ed.converting') : t('landing.ed.addImages')}</span>
                </label>
              )}
            </div>
            <p className="pd-note">{t('landing.ed.imagesHint')}</p>
            <div className="lp-url">
              <input className="ltr" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button type="button" className="btn small" onClick={addUrl}>
                {t('landing.ed.addUrl')}
              </button>
            </div>
          </section>

          <section className="card">
            <h2>{t('landing.ed.sText')}</h2>
            {!!ctx.data?.variants.length && (
              <Field label={t('landing.ed.variantLabel')} hint={t('landing.ed.variantHint', { list: ctx.data.variants.map((v) => v.title).join(', ') })}>
                <input dir="auto" value={d.variantLabel} onChange={(e) => set('variantLabel', e.target.value)} />
              </Field>
            )}
            <Field label={t('landing.ed.description')} hint={t('landing.ed.descriptionHint')}>
              <textarea dir="auto" rows={10} value={d.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
          </section>

          <section className="card">
            <h2>{t('landing.ed.sFraud')}</h2>
            <p className="pd-note">{t('landing.ed.fraudHelp')}</p>
            <div className="lp-levels" role="radiogroup">
              {(['relaxed', 'normal', 'strict'] as Level[]).map((k) => (
                <label key={k} className={`lp-level ${d.fraudLevel === k ? 'on' : ''}`}>
                  <input type="radio" name="lvl" checked={d.fraudLevel === k} onChange={() => set('fraudLevel', k)} />
                  <b>{t(`landing.ed.lvl.${k}`)}</b>
                  <small>{t(`landing.ed.lvlHelp.${k}`)}</small>
                </label>
              ))}
            </div>
          </section>

          <div className="lp-ed-foot">
            {p && (
              <button type="button" className="btn ghost danger" onClick={remove}>
                <Icon name="trash" /> {t('landing.ed.remove')}
              </button>
            )}
            <SaveBar dirty={dirty || !p} busy={save.isPending} disabled={!d.productId || busy > 0} onSave={submit} label={t('common.save')} />
          </div>
        </form>

        <aside className="lp-pv card">
          <div className="lp-pv-bar">
            <b>{t('landing.ed.preview')}</b>
            <span className="muted small">{weight ? t('landing.ed.weight', { kb: (weight / 1024).toFixed(1) }) : ''}</span>
            <div className="lp-dev" role="tablist">
              {(['phone', 'desktop'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={device === k} className={device === k ? 'on' : ''} onClick={() => setDevice(k)}>
                  <Icon name={k === 'phone' ? 'phone' : 'columns'} /> {t(`landing.ed.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div ref={box} className={`lp-pv-box ${device}`} style={device === 'desktop' ? { ['--s' as string]: scale, ['--dw' as string]: `${DESKTOP_W}px` } : undefined}>
            {html ? <iframe ref={frame} title={t('landing.ed.preview')} srcDoc={html} sandbox="allow-scripts allow-forms" /> : <p className="muted">{t('landing.ed.pickProduct')}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
