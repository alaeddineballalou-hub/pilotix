// Produits › a product › Photos HD pour Dellal: the photos Dellal sends when a customer asks for a photo of a colour or
// a size (that variant's first), and the size chart, sent when he asks which size to take. Each picked photo is shrunk
// here to 2048 px before it leaves the phone; on the server it goes to Pilotix's photo storage (Cloudflare R2), and only
// its small copy stays with the shop. Saved at once, photo by photo (not with the form's « Enregistrer »).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { hdPhoto } from '../messages/photo';

type View = Out<'photos.list'>;
type Photo = View['photos'][number];
const K = 'produits.hd.';

/** 1,4 Mo / 820 Ko */
const size = (b: number, lang: string) => (b >= 1_000_000 ? `${(b / 1_000_000).toLocaleString(lang, { maximumFractionDigits: 1 })} Mo` : `${Math.max(1, Math.round(b / 1000))} Ko`);

export function HdPhotos({ productId, variants }: { productId: number | null; variants: { id: number; title: string }[] }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = ['photos.list', { productId }];
  const q = useQuery<View, Error>({ queryKey: key, queryFn: () => rpc('photos.list', { productId: productId! }), enabled: !!productId });
  const [target, setTarget] = useState<string>('all');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const chart = useRef<HTMLInputElement>(null);
  const put = (v: View) => qc.setQueryData(key, v);

  if (!productId) return <p className="muted small hd-note">{t(K + 'saveFirst')}</p>;
  const d = q.data;
  const off = d?.store === 'off';
  const label = (p: Photo) => (p.variantId ? variants.find((v) => v.id === p.variantId)?.title ?? t(K + 'gone') : t(K + 'all'));

  const upload = async (files: FileList | null, kind: 'photo' | 'sizes') => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const variantId = kind === 'sizes' || target === 'all' ? null : Number(target);
    setBusy({ done: 0, total: list.length });
    let ok = 0;
    for (const f of list) {
      try {
        const p = await hdPhoto(f);
        put(await rpc('photos.add', { productId, variantId, kind, ...p }));
        ok++;
      } catch (e: any) {
        toast(e?.message === 'not_image' ? t(K + 'notImage') : e?.message === 'too_big' ? t(K + 'tooBig') : e?.message || t(K + 'failed'), 'bad');
        break;
      } finally {
        setBusy((b) => (b ? { ...b, done: b.done + 1 } : b));
      }
    }
    setBusy(null);
    if (ok) toast(t(K + 'added', { count: ok }), 'ok');
  };
  const change = async (p: Photo, patch: { variantId?: number | null; position?: number }) => {
    try {
      put(await rpc('photos.update', { id: p.id, ...patch }));
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    }
  };
  const remove = async (p: Photo) => {
    try {
      put(await rpc('photos.remove', { id: p.id }));
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    }
  };

  const photos = (d?.photos ?? []).filter((p) => p.kind === 'photo');
  const charts = (d?.photos ?? []).filter((p) => p.kind === 'sizes');
  return (
    <div className="hd">
      <div className="pf-head">
        <h4 className="hd-h">
          <Icon name="image" /> {t(K + 'title')}
        </h4>
        <span className="muted small">{d ? t(K + 'count', { count: d.photos.length, size: size(d.bytes, i18n.language) }) : ''}</span>
      </div>
      <p className="muted small">{t(K + 'help')}</p>
      {q.error ? (
        <p className="form-err small">{q.error.message}</p>
      ) : off ? (
        <p className="warnbox small">{t(K + 'off')}</p>
      ) : (
        <div className="hd-add">
          <label className="hd-for">
            <span className="small muted">{t(K + 'for')}</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!busy}>
              <option value="all">{t(K + 'all')}</option>
              {variants.map((v) => (
                <option key={v.id} value={String(v.id)}>
                  {v.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn small primary" disabled={!d || !!busy} onClick={() => pick.current?.click()}>
            <Icon name="plus" /> {busy ? t(K + 'sending', { done: busy.done, total: busy.total }) : t(K + 'add')}
          </button>
          <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files, 'photo').finally(() => (e.target.value = ''))} />
        </div>
      )}
      {photos.length > 0 && (
        <ul className="hd-grid">
          {photos.map((p, i) => (
            <li key={p.id} className="hd-card">
              <img src={p.thumb} alt={label(p)} loading="lazy" />
              <select aria-label={t(K + 'for')} value={p.variantId ? String(p.variantId) : 'all'} onChange={(e) => void change(p, { variantId: e.target.value === 'all' ? null : Number(e.target.value) })}>
                <option value="all">{t(K + 'all')}</option>
                {variants.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.title}
                  </option>
                ))}
              </select>
              <span className="hd-meta small muted">
                <bdi className="ltr">
                  {p.w}×{p.h}
                </bdi>{' '}
                · {size(p.bytes, i18n.language)}
              </span>
              <span className="hd-do">
                <button type="button" className="icon-btn" disabled={i === 0} aria-label={t(K + 'first')} title={t(K + 'first')} onClick={() => void change(p, { position: 0 })}>
                  <Icon name="flag" />
                </button>
                <button type="button" className="icon-btn" aria-label={t(K + 'remove')} title={t(K + 'remove')} onClick={() => void remove(p)}>
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="hd-chart">
        <div>
          <b className="small">{t(K + 'chart')}</b>
          <p className="muted small">{t(K + 'chartHelp')}</p>
        </div>
        {!off && charts.length < (d?.limits.sizeCharts ?? 2) && (
          <>
            <button type="button" className="btn small" disabled={!d || !!busy} onClick={() => chart.current?.click()}>
              <Icon name="plus" /> {t(K + 'chartAdd')}
            </button>
            <input ref={chart} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files, 'sizes').finally(() => (e.target.value = ''))} />
          </>
        )}
      </div>
      {charts.length > 0 && (
        <ul className="hd-grid">
          {charts.map((p) => (
            <li key={p.id} className="hd-card">
              <img src={p.thumb} alt={t(K + 'chart')} loading="lazy" />
              <span className="hd-meta small muted">
                <bdi className="ltr">
                  {p.w}×{p.h}
                </bdi>{' '}
                · {size(p.bytes, i18n.language)}
              </span>
              <span className="hd-do">
                <button type="button" className="icon-btn" aria-label={t(K + 'remove')} title={t(K + 'remove')} onClick={() => void remove(p)}>
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
