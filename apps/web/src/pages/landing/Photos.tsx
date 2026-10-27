// Landing page editor › Photos: the compressor. Each picture added (from the phone, a link, or the product's photo) is
// made as light as it can be without visible loss (webp.ts), the shop sees what it gained and the quality kept, and can
// compare before / after. Pictures still used from an address (heavy, not compressed) can be compressed in one click.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { store } from '../../lib/store';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { fetchImage, ImageInfo, make320, measure, optimize, Preset, PRESETS } from './webp';

export type Img = { id: number | null; url: string | null; w: number; h: number; thumb: string; src: string; info?: ImageInfo | null };

const PRESET_KEYS = Object.keys(PRESETS) as Preset[];
const presetOf = (): Preset => {
  const v = store.get('lp-img-preset');
  return PRESET_KEYS.includes(v as Preset) ? (v as Preset) : 'balanced';
};
/** what most phones download of a picture (the 720 width when there is one) */
export const phoneBytes = (i: ImageInfo) => i.bytes.w720 ?? i.bytes.w960;
const phoneSsim = (i: ImageInfo) => i.ssim.w720 ?? i.ssim.w960;
const pct = (x: number) => `${Math.round(x * 1000) / 10}`;
/** a picture used from its address that the compressor would make lighter (a drawing in SVG is already light) */
const heavyUrl = (x: Img) => !x.id && !!x.url && !/^data:image\/svg|\.svg(\?|#|$)/i.test(x.url);

export function Photos({ images, onChange, onBusy }: { images: Img[]; onChange: (f: (a: Img[]) => Img[]) => void; onBusy: (n: number) => void }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<Preset>(presetOf);
  const [work, setWork] = useState<{ i: number; n: number; step: string } | null>(null);
  const [url, setUrl] = useState('');
  const [cmp, setCmp] = useState<number | null>(null);
  // before / after of the pictures compressed in this visit (object URLs, freed when leaving)
  const views = useRef(new Map<number, { orig: string; opt: string }>());
  useEffect(() => () => views.current.forEach((v) => (URL.revokeObjectURL(v.orig), URL.revokeObjectURL(v.opt))), []);
  // pictures stored before the 320 width existed get it now, quietly (computers then load a lighter file for the small box)
  const upgraded = useRef(new Set<number>());
  useEffect(() => {
    const todo = images.filter((x) => x.id && x.info && x.info.bytes.w320 === undefined && !upgraded.current.has(x.id) && x.src.startsWith('data:'));
    if (!todo.length) return;
    let live = true;
    (async () => {
      for (const x of todo) {
        upgraded.current.add(x.id!);
        try {
          const made = await make320(await (await fetch(x.src)).blob(), (x.info?.preset as Preset) ?? presetOf());
          if (!live || !made) continue;
          const r = await rpc('landing.addW320', { id: x.id!, w320: made.b64, bytes: made.bytes, ssim: made.ssim });
          if (live && r.info) onChange((a) => a.map((y) => (y.id === x.id ? { ...y, info: r.info } : y)));
        } catch {
          /* the page keeps its 480 file: nothing to tell */
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [images]); // eslint-disable-line react-hooks/exhaustive-deps
  const kb = (b: number) => t('landing.ph.kb', { n: b < 10_240 ? (b / 1024).toFixed(1) : Math.round(b / 1024) });

  const choose = (p: Preset) => {
    setPreset(p);
    store.set('lp-img-preset', p === 'balanced' ? null : p);
  };

  /** compresses one picture and stores it; returns its row (null: failed, already told) */
  const compress = async (blob: Blob, i: number, n: number): Promise<Img | null> => {
    setWork({ i, n, step: '' });
    try {
      const e = await optimize(blob, preset, (step) => setWork({ i, n, step }));
      const row = await rpc('landing.addImage', { w: e.w, h: e.h, t160: e.t160, w320: e.w320, w480: e.w480, w720: e.w720, w960: e.w960, lqip: e.lqip, info: e.info });
      if (row.id) views.current.set(row.id, e.compare);
      return row as Img;
    } catch (err) {
      toast((err as Error).message, 'bad');
      return null;
    }
  };

  const run = async (jobs: (() => Promise<void>)[]) => {
    onBusy(1);
    try {
      for (const j of jobs) await j();
    } finally {
      setWork(null);
      onBusy(-1);
    }
  };

  const addFiles = (files: FileList | null) => {
    const list = Array.from(files ?? []).slice(0, 12 - images.length);
    let before = 0;
    let after = 0;
    let done = 0;
    return run([
      ...list.map((f, k) => async () => {
        const row = await compress(f, k + 1, list.length);
        if (!row) return;
        before += f.size;
        after += row.info ? phoneBytes(row.info) : 0;
        done++;
        onChange((a) => [...a, row]);
      }),
      async () => {
        if (done) toast(t('landing.ph.done', { count: done, before: kb(before), after: kb(after) }), 'ok');
      },
    ]);
  };

  /** a picture used from an address (heavy, not compressed): fetched, compressed, put in its place */
  const optimizeUrls = (only?: string) => {
    const todo = images.filter((x) => heavyUrl(x) && (!only || x.url === only)).map((x) => x.url!);
    return run(
      todo.map((u, k) => async () => {
        let blob: Blob;
        try {
          blob = await fetchImage(u);
        } catch {
          toast(t('landing.ph.fetchFail'), 'bad');
          return;
        }
        const row = await compress(blob, k + 1, todo.length);
        if (row) onChange((a) => a.map((x) => (x.url === u && !x.id ? row : x)));
      }),
    );
  };

  const addUrl = async () => {
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) return toast(t('landing.ed.urlBad'), 'bad');
    if (images.length >= 12) return;
    const svg = !heavyUrl({ id: null, url: u, w: 0, h: 0, thumb: '', src: '' });
    // compressed like a picture from the phone when the site lets us read it (a drawing in SVG is kept: already light);
    // otherwise used from its address
    let blob: Blob | null = null;
    try {
      blob = svg ? null : await fetchImage(u);
    } catch {
      blob = null;
    }
    if (blob) {
      setUrl('');
      return run([
        async () => {
          const row = await compress(blob!, 1, 1);
          if (row) onChange((a) => [...a, row]);
        },
      ]);
    }
    try {
      const { w, h } = await measure(u);
      onChange((a) => [...a, { id: null, url: u, w, h, thumb: u, src: u }]);
      setUrl('');
      if (!svg) toast(t('landing.ph.urlKept'), 'bad');
    } catch {
      toast(t('landing.ed.urlBad'), 'bad');
    }
  };

  const move = (i: number, by: number) =>
    onChange((x) => {
      const a = [...x];
      const j = i + by;
      if (j < 0 || j >= a.length) return x;
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    });

  const heavy = images.filter(heavyUrl).length;
  const open = cmp !== null ? images[cmp] : null;
  return (
    <section className="card">
      <h2>
        {t('landing.ed.sImages')} <small className="muted">{images.length}/12</small>
      </h2>
      <div className="lp-ph-preset">
        <span className="lp-ph-l">
          <Icon name="sliders" /> {t('landing.ph.preset')}
        </span>
        <div className="lp-dev" role="radiogroup" aria-label={t('landing.ph.preset')}>
          {PRESET_KEYS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={preset === k} className={preset === k ? 'on' : ''} onClick={() => choose(k)}>
              {t(`landing.ph.p.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="pd-note">{t(`landing.ph.pHelp.${preset}`)}</p>
      {heavy > 0 && (
        <div className="lp-ph-warn">
          <Icon name="alert" />
          <span>{t('landing.ph.heavy', { count: heavy })}</span>
          <button type="button" className="btn small primary" disabled={!!work} onClick={() => optimizeUrls()}>
            <Icon name="sparkles" /> {t('landing.ph.optimizeAll')}
          </button>
        </div>
      )}
      <div className="lp-imgs">
        {images.map((im, i) => (
          <figure key={`${im.id ?? im.url}-${i}`} className="lp-img">
            <img src={im.thumb} alt="" />
            {i === 0 && <span className="chip">{t('landing.ed.main')}</span>}
            {im.info ? (
              <button type="button" className="lp-gain" onClick={() => setCmp(i)} title={t('landing.ph.gainHelp')}>
                −{Math.max(0, Math.round((1 - phoneBytes(im.info) / Math.max(1, im.info.orig)) * 100))} % · {kb(phoneBytes(im.info))}
              </button>
            ) : heavyUrl(im) ? (
              <button type="button" className="lp-gain warn" disabled={!!work} onClick={() => optimizeUrls(im.url!)}>
                <Icon name="sparkles" /> {t('landing.ph.optimize')}
              </button>
            ) : null}
            <div className="lp-img-a">
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('landing.ed.before')}>
                <Icon name="chevl" />
              </button>
              <button type="button" className="icon-btn" disabled={i === images.length - 1} onClick={() => move(i, 1)} aria-label={t('landing.ed.after')}>
                <Icon name="chevr" />
              </button>
              <button type="button" className="icon-btn" onClick={() => onChange((a) => a.filter((_, k) => k !== i))} aria-label={t('landing.ed.removeImg')}>
                <Icon name="x" />
              </button>
            </div>
          </figure>
        ))}
        {images.length < 12 && (
          <label className={`lp-img lp-add ${work ? 'busy' : ''}`}>
            <input type="file" accept="image/*" multiple disabled={!!work} onChange={(e) => addFiles(e.target.files).then(() => (e.target.value = ''))} />
            <Icon name={work ? 'hourglass' : 'camera'} />
            <span>{work ? t('landing.ph.working', { i: work.i, n: work.n }) : t('landing.ed.addImages')}</span>
            {work?.step && <small className="lp-ph-step">{t(`landing.ph.step.${work.step}`)}</small>}
          </label>
        )}
      </div>
      <p className="pd-note">{t('landing.ph.hint')}</p>
      <div className="lp-url">
        <input className="ltr" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button type="button" className="btn small" disabled={!!work} onClick={addUrl}>
          {t('landing.ed.addUrl')}
        </button>
      </div>
      {open?.info && <Compare img={open} view={open.id ? views.current.get(open.id) : undefined} kb={kb} onClose={() => setCmp(null)} />}
    </section>
  );
}

/** Before / after: the original and what most phones get, one over the other with a slider, zoom to look closely. */
function Compare({ img, view, kb, onClose }: { img: Img; view?: { orig: string; opt: string }; kb: (b: number) => string; onClose: () => void }) {
  const { t } = useTranslation();
  const [x, setX] = useState(50);
  const [zoom, setZoom] = useState(1);
  const i = img.info!;
  const rows: [string, number | undefined, number | undefined][] = [
    ['960', i.bytes.w960, i.ssim.w960],
    ['720', i.bytes.w720, i.ssim.w720],
    ['480', i.bytes.w480, i.ssim.w480],
    ['320', i.bytes.w320, i.ssim.w320],
    ['160', i.bytes.t160, i.ssim.t160],
  ];
  return (
    <Modal title={t('landing.ph.cmpTitle')} onClose={onClose} wide>
      {view ? (
        <>
          <div className="lp-cmp" style={{ aspectRatio: `${img.w}/${img.h}` }}>
            <div className="lp-cmp-z" style={{ transform: `scale(${zoom})` }}>
              <img src={view.opt} alt="" />
              <img src={view.orig} alt="" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }} />
            </div>
            <span className="lp-cmp-l">{t('landing.ph.before')}</span>
            <span className="lp-cmp-r">{t('landing.ph.after')}</span>
            <i className="lp-cmp-bar" style={{ left: `${x}%` }} />
          </div>
          <div className="lp-cmp-tools">
            <input type="range" min={0} max={100} value={x} onChange={(e) => setX(Number(e.target.value))} aria-label={t('landing.ph.slider')} />
            <div className="lp-dev" role="radiogroup" aria-label={t('landing.ph.zoom')}>
              {[1, 2, 3].map((z) => (
                <button key={z} type="button" role="radio" aria-checked={zoom === z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>
                  {z}×
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <p className="pd-note">{t('landing.ph.cmpLater')}</p>
      )}
      <p className="lp-cmp-sum">
        {t('landing.ph.cmpSum', { orig: kb(i.orig), ow: i.ow, oh: i.oh, phone: kb(phoneBytes(i)), q: pct(phoneSsim(i)) })}
      </p>
      <table className="lp-cmp-t">
        <thead>
          <tr>
            <th>{t('landing.ph.tWidth')}</th>
            <th>{t('landing.ph.tWeight')}</th>
            <th>{t('landing.ph.tSame')}</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((r) => r[1] !== undefined)
            .map(([w, b, s]) => (
              <tr key={w}>
                <td className="ltr">{w} px</td>
                <td className="ltr">{kb(b!)}</td>
                <td className="ltr">{s === 1 ? t('landing.ph.lossless') : `${pct(s!)} %`}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="muted small">{t('landing.ph.ssimHelp')}</p>
    </Modal>
  );
}
