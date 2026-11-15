// Produits › a product › Photos: the one place where a product's pictures are added. A photo (or more) for each
// colour / size, or for the whole product: Dellal sends it in HD, and its small copy is that line's picture in the lists,
// the orders and the depot. The product's first photo is its main picture (« Photo principale » puts another one first).
// Each picked photo is shrunk here to 2048 px before it leaves the phone; it is saved at once, photo by photo (not with
// the form's « Enregistrer ») — but for a product or a line that is not saved yet, it waits here and is sent when the
// form is saved. The small pictures from before (the old « Image » and the buttons on each line) stay, marked
// « Petite photo », until a real photo replaces them. A server without photo storage keeps the small copy only.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { hdPhoto, smallPhoto } from '../messages/photo';
import { bidi } from './stockui';

type View = Out<'photos.list'>;
type Photo = View['photos'][number];
const K = 'produits.hd.';

/** a colour / size of the form as it is now: saved (its id) or not yet */
export interface PhotoLine {
  id?: number;
  title: string;
  /** its small picture, as the form will save it */
  photo: string;
}
/** a photo picked for a product or a line that is not saved yet: sent when the form is saved */
interface Waiting {
  key: number;
  /** its line's name (null: the whole product) */
  line: string | null;
  data: string;
  w: number;
  h: number;
  thumb: string;
  mini: string;
  small?: string;
}
export interface PhotosHandle {
  /** how many photos wait for the form to be saved */
  waiting: () => number;
  /** the product is saved: its waiting photos are sent now, each to its line */
  flush: (saved: { id: number; variants: { id: number; title: string }[] }, onStep: (done: number, total: number) => void) => Promise<void>;
}

const low = (s: string) => s.trim().toLowerCase();
let nextKey = 1;

/** 1,4 Mo / 820 Ko (MB / KB in English and Arabic), kept left to right inside an Arabic sentence */
const size = (b: number, lang: string) => {
  const [mb, kb] = lang === 'fr' ? ['Mo', 'Ko'] : ['MB', 'KB'];
  return `⁦${b >= 1_000_000 ? `${(b / 1_000_000).toLocaleString(lang, { maximumFractionDigits: 1 })} ${mb}` : `${Math.max(1, Math.round(b / 1000))} ${kb}`}⁩`;
};

export const ProductPhotos = forwardRef<
  PhotosHandle,
  {
    productId: number | null;
    /** the product's colours / sizes that are on (none: a product with one model) */
    lines: PhotoLine[];
    /** the product's main small picture, as the form will save it */
    photo: string;
    onMain: (photo: string) => void;
    onLine: (line: { id?: number; title: string }, photo: string) => void;
  }
>(function ProductPhotos({ productId, lines, photo, onMain, onLine }, ref) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = ['photos.list', { productId }];
  const q = useQuery<View, Error>({ queryKey: key, queryFn: () => rpc('photos.list', { productId: productId! }), enabled: !!productId });
  const [target, setTarget] = useState<string>('all');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const waitingRef = useRef<Waiting[]>([]);
  waitingRef.current = waiting;
  // the small pictures the form opened with: a line whose waiting photo is taken back gets its own again
  const was = useRef({ main: photo, lines: new Map(lines.map((l) => [low(l.title), l.photo])) });
  const pick = useRef<HTMLInputElement>(null);
  const pickFor = useRef<PhotoLine | null>(null);
  const chart = useRef<HTMLInputElement>(null);

  const d = q.data;
  const off = d?.store === 'off';
  const loading = !!productId && !d && !q.error;
  const saved = (d?.photos ?? []).filter((p) => p.kind === 'photo');
  const charts = (d?.photos ?? []).filter((p) => p.kind === 'sizes');
  const keyOf = (l: PhotoLine) => (l.id ? `v${l.id}` : `t${low(l.title)}`);
  const hdOf = (l: PhotoLine) => (l.id ? saved.filter((p) => p.variantId === l.id) : []);
  const waitOf = (l: PhotoLine, list = waiting) => list.filter((x) => x.line !== null && low(x.line) === low(l.title));
  const title = (p: Photo) => (p.variantId ? lines.find((l) => l.id === p.variantId)?.title ?? t(K + 'gone') : t(K + 'all'));

  /** the server's answer: its photos, and the small pictures that followed (the form saves what it shows) */
  const dirty = useRef(false);
  const apply = (v: View) => {
    qc.setQueryData(key, v);
    if ('product' in v.changed) onMain(v.changed.product ?? '');
    for (const [id, p] of Object.entries(v.changed.variants)) onLine({ id: Number(id), title: '' }, p ?? '');
    if ('product' in v.changed || Object.keys(v.changed.variants).length) dirty.current = true;
  };
  /** after a change: the lists and the product (opened again later) show the new pictures */
  const refresh = () => {
    if (!dirty.current) return;
    dirty.current = false;
    void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'photos.list' });
  };

  /**
   * The photos that wait for the form to be saved, and the pictures the form saves meanwhile: a line's first waiting
   * photo is its picture, and the first of all is the main one when the product has no photo yet.
   */
  const queue = (next: Waiting[]) => {
    const before = waitingRef.current;
    waitingRef.current = next;
    setWaiting(next);
    const light = (x: Waiting) => x.small ?? x.thumb;
    for (const l of lines) {
      const [a, b] = [waitOf(l, before)[0], waitOf(l, next)[0]];
      if (a?.key !== b?.key) onLine(l, b ? light(b) : was.current.lines.get(low(l.title)) ?? '');
    }
    if (!saved.length && before[0]?.key !== next[0]?.key) onMain(next[0] ? light(next[0]) : was.current.main);
  };

  const fail = (e: any) => toast(e?.message === 'not_image' ? t(K + 'notImage') : e?.message === 'too_big' ? t(K + 'tooBig') : e?.message || t(K + 'failed'), 'bad');

  /** Photos picked for a line (null: the whole product). */
  const add = async (files: FileList | null, line: PhotoLine | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy({ done: 0, total: list.length });
    let ok = 0;
    let kept = 0;
    for (const f of list) {
      try {
        if (off) {
          // no photo storage on this server: the small picture only, saved with the form
          const s = await smallPhoto(f);
          if (line) onLine(line, s);
          else onMain(s);
          kept++;
        } else {
          const p = await hdPhoto(f);
          if (productId && (!line || line.id)) {
            apply(await rpc('photos.add', { productId, variantId: line?.id ?? null, kind: 'photo', ...p }));
            ok++;
          } else {
            queue([...waitingRef.current, { key: nextKey++, line: line ? line.title : null, ...p }]);
            kept++;
          }
        }
      } catch (e: any) {
        fail(e);
        break;
      } finally {
        setBusy((b) => (b ? { ...b, done: b.done + 1 } : b));
      }
    }
    setBusy(null);
    refresh();
    if (ok) toast(t(K + 'added', { count: ok }), 'ok');
    else if (kept) toast(t(K + (off ? 'keptSmall' : 'kept'), { count: kept }), 'ok');
  };
  const addChart = async (files: FileList | null) => {
    const f = Array.from(files ?? []).find((x) => x.type.startsWith('image/'));
    if (!f || !productId) return;
    setBusy({ done: 0, total: 1 });
    try {
      apply(await rpc('photos.add', { productId, variantId: null, kind: 'sizes', ...(await hdPhoto(f)) }));
      toast(t(K + 'added', { count: 1 }), 'ok');
    } catch (e: any) {
      fail(e);
    }
    setBusy(null);
  };
  const change = async (p: Photo, patch: { variantId?: number | null; position?: number }) => {
    try {
      apply(await rpc('photos.update', { id: p.id, ...patch }));
      refresh();
    } catch (e: any) {
      fail(e);
    }
  };
  const remove = async (p: Photo) => {
    try {
      apply(await rpc('photos.remove', { id: p.id }));
      refresh();
    } catch (e: any) {
      fail(e);
    }
  };

  useImperativeHandle(ref, () => ({
    waiting: () => waitingRef.current.length,
    flush: async (to, onStep) => {
      const todo = waitingRef.current;
      let done = 0;
      let lost = 0;
      for (const x of todo) {
        const v = x.line === null ? null : to.variants.find((y) => low(y.title) === low(x.line!));
        if (x.line !== null && !v) lost++;
        else {
          try {
            await rpc('photos.add', { productId: to.id, variantId: v ? v.id : null, kind: 'photo', data: x.data, w: x.w, h: x.h, thumb: x.thumb, mini: x.mini, ...(x.small ? { small: x.small } : {}) });
          } catch (e: any) {
            fail(e);
            break;
          }
        }
        onStep(++done, todo.length);
      }
      waitingRef.current = [];
      if (lost) toast(t(K + 'lost', { count: lost }), 'bad');
      void qc.invalidateQueries();
    },
  }));

  const open = (line: PhotoLine | null) => {
    pickFor.current = line;
    pick.current?.click();
  };
  const chosen = target === 'all' ? null : lines.find((l) => keyOf(l) === target) ?? null;
  // without a real photo yet (a server without storage: without any picture)
  const missing = lines.filter((l) => (off ? !l.photo : !hdOf(l).length && !waitOf(l).length));
  // the small pictures from before: a line's, and the product's own when it has no photo at all
  const oldLines = lines.filter((l) => l.photo && !hdOf(l).length && !waitOf(l).length);
  const oldMain = photo && !saved.length && !waiting.length ? photo : '';
  const count = saved.length + waiting.length + charts.length;

  return (
    <div className="hd" aria-busy={!!busy}>
      <div className="pf-head">
        <h3 className="hd-h">
          <Icon name="image" /> {t(K + 'title')}
        </h3>
        <span className="muted small">{count > 0 ? t(K + 'count', { count, size: size((d?.bytes ?? 0) + waiting.reduce((a, x) => a + Math.floor((x.data.length * 3) / 4), 0), i18n.language) }) : ''}</span>
      </div>
      <p className="muted small hd-help">{t(K + 'help')}</p>
      {q.error && <p className="form-err small">{q.error.message}</p>}
      {off && <p className="warnbox small">{t(K + 'off')}</p>}
      <div className="hd-add">
        {lines.length > 0 && (
          <label className="hd-for">
            <span className="small muted">{t(K + 'for')}</span>
            <select value={chosen ? target : 'all'} onChange={(e) => setTarget(e.target.value)} disabled={!!busy}>
              <option value="all">{t(K + 'all')}</option>
              {lines.map((l) => (
                <option key={keyOf(l)} value={keyOf(l)}>
                  {bidi(l.title)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn small primary" disabled={loading || !!busy} onClick={() => open(chosen)}>
          <Icon name="plus" /> {busy ? t(K + 'sending', { done: busy.done, total: busy.total }) : t(K + 'add')}
        </button>
        <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files, pickFor.current).finally(() => (e.target.value = ''))} />
      </div>
      {lines.length > 0 &&
        (missing.length > 0 ? (
          <div className="hd-miss">
            <span className="small muted">{t(K + 'missing', { count: missing.length })}</span>
            <ul>
              {missing.map((l) => (
                <li key={keyOf(l)}>
                  <button type="button" className="hd-chip" disabled={loading || !!busy} aria-label={t(K + 'addFor', { line: l.title })} title={t(K + 'addFor', { line: l.title })} onClick={() => open(l)}>
                    <Icon name="plus" />
                    <bdi>{l.title}</bdi>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          !loading && (
            <p className="hd-done small">
              <Icon name="check" /> {t(K + 'allDone')}
            </p>
          )
        ))}
      {waiting.length > 0 && <p className="small hd-wait">{t(K + 'waitHelp', { count: waiting.length })}</p>}
      {(saved.length > 0 || waiting.length > 0 || oldMain || oldLines.length > 0) && (
        <ul className="hd-grid">
          {saved.map((p, i) => (
            <li key={p.id} className={`hd-card ${i === 0 ? 'is-main' : ''}`}>
              <span className="hd-pic">
                <img src={p.thumb} alt={title(p)} loading="lazy" />
                {i === 0 && <b className="hd-tag hd-tag-main">{t(K + 'main')}</b>}
              </span>
              {lines.length > 0 ? (
                <select aria-label={t(K + 'for')} value={p.variantId ? `v${p.variantId}` : 'all'} onChange={(e) => void change(p, { variantId: e.target.value === 'all' ? null : Number(e.target.value.slice(1)) })}>
                  <option value="all">{t(K + 'all')}</option>
                  {p.variantId && !lines.some((l) => l.id === p.variantId) && <option value={`v${p.variantId}`}>{t(K + 'gone')}</option>}
                  {lines
                    .filter((l) => l.id)
                    .map((l) => (
                      <option key={l.id} value={`v${l.id}`}>
                        {bidi(l.title)}
                      </option>
                    ))}
                </select>
              ) : (
                <span className="hd-name small">{t(K + 'all')}</span>
              )}
              <span className="hd-meta small muted">
                <bdi className="ltr">
                  {p.w}×{p.h}
                </bdi>
                <span>{size(p.bytes, i18n.language)}</span>
              </span>
              <span className="hd-do">
                <button type="button" className="icon-btn" disabled={i === 0} aria-pressed={i === 0} aria-label={t(K + 'makeMain')} title={t(K + (i === 0 ? 'isMain' : 'makeMain'))} onClick={() => void change(p, { position: 0 })}>
                  <Icon name="star" />
                </button>
                <button type="button" className="icon-btn" aria-label={t(K + 'remove')} title={t(K + 'remove')} onClick={() => void remove(p)}>
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
          {waiting.map((x, i) => {
            const main = !saved.length && i === 0;
            return (
              <li key={`w${x.key}`} className={`hd-card is-wait ${main ? 'is-main' : ''}`}>
                <span className="hd-pic">
                  <img src={x.thumb} alt={x.line ?? t(K + 'all')} />
                  {main && <b className="hd-tag hd-tag-main">{t(K + 'main')}</b>}
                </span>
                <span className="hd-name small">
                  <bdi>{x.line ?? t(K + 'all')}</bdi>
                </span>
                <span className="hd-meta small">
                  <b className="hd-tag hd-tag-wait">{t(K + 'wait')}</b>
                </span>
                <span className="hd-do">
                  {!saved.length ? (
                    <button type="button" className="icon-btn" disabled={main} aria-pressed={main} aria-label={t(K + 'makeMain')} title={t(K + (main ? 'isMain' : 'makeMain'))} onClick={() => queue([x, ...waiting.filter((y) => y.key !== x.key)])}>
                      <Icon name="star" />
                    </button>
                  ) : (
                    <span />
                  )}
                  <button type="button" className="icon-btn" aria-label={t(K + 'remove')} title={t(K + 'remove')} onClick={() => queue(waiting.filter((y) => y.key !== x.key))}>
                    <Icon name="trash" />
                  </button>
                </span>
              </li>
            );
          })}
          {oldMain && (
            <li className="hd-card is-old is-main">
              <span className="hd-pic">
                <img src={oldMain} alt={t(K + 'main')} loading="lazy" />
                <b className="hd-tag hd-tag-main">{t(K + 'main')}</b>
              </span>
              <span className="hd-name small">{t(K + 'all')}</span>
              <span className="hd-meta small">{!off && <b className="hd-tag hd-tag-old" title={t(K + 'oldHelp')}>{t(K + 'old')}</b>}</span>
              <span className="hd-do">
                <span />
                <button type="button" className="icon-btn" aria-label={t(K + 'remove')} title={t(K + 'remove')} onClick={() => onMain('')}>
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          )}
          {oldLines.map((l) => (
            <li key={`o${keyOf(l)}`} className="hd-card is-old">
              <span className="hd-pic">
                <img src={l.photo} alt={l.title} loading="lazy" />
              </span>
              <span className="hd-name small">
                <bdi>{l.title}</bdi>
              </span>
              <span className="hd-meta small">{!off && <b className="hd-tag hd-tag-old" title={t(K + 'oldHelp')}>{t(K + 'old')}</b>}</span>
              <span className="hd-do">
                <span />
                <button type="button" className="icon-btn" aria-label={t(K + 'remove')} title={t(K + 'remove')} onClick={() => onLine(l, '')}>
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!off && (oldMain || oldLines.length > 0) && <p className="muted small">{t(K + 'oldHelp')}</p>}
      <div className="hd-chart">
        <div>
          <b className="small">{t(K + 'chart')}</b>
          <p className="muted small">{productId ? t(K + 'chartHelp') : t(K + 'chartLater')}</p>
        </div>
        {!!productId && !off && charts.length < (d?.limits.sizeCharts ?? 2) && (
          <>
            <button type="button" className="btn small" disabled={!d || !!busy} onClick={() => chart.current?.click()}>
              <Icon name="plus" /> {t(K + 'chartAdd')}
            </button>
            <input ref={chart} type="file" accept="image/*" hidden onChange={(e) => void addChart(e.target.files).finally(() => (e.target.value = ''))} />
          </>
        )}
      </div>
      {charts.length > 0 && (
        <ul className="hd-grid">
          {charts.map((p) => (
            <li key={p.id} className="hd-card hd-card-chart">
              <span className="hd-pic">
                <img src={p.thumb} alt={t(K + 'chart')} loading="lazy" />
              </span>
              <span className="hd-meta small muted">
                <bdi className="ltr">
                  {p.w}×{p.h}
                </bdi>
                <span>{size(p.bytes, i18n.language)}</span>
              </span>
              <span className="hd-do">
                <span />
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
});
