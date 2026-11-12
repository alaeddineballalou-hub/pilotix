// Espace créateur › Studio photo (#/createur/studio): the AI poses each colour of a product in the shop's own showroom.
// 1. Fonds: the shop's backgrounds, blurred once here (the table stays sharp) with the box of its logo, which the
//    product must never cover. 2. Photos: a product, then for each colour / size 2 to 5 photos of it alone → 3 versions,
//    each checked by the AI (✅ / ⚠️ with the reason); the one picked goes to that colour (Dellal sends it first) and
//    becomes its small picture. 3. Affiche: when every colour has its photo, the poster — the AI only suggests the
//    words; the price, the old price, the phone and the colours are Pilotix's, written here — becomes the main photo.
// Every photo also downloads in the ad sizes (4:5, 1:1, 9:16). Who pays the AI: the shop's credits, or its own key.
import { PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Field, Help, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { BuyCredits, CreditPill } from './Credits';
import { adSize, AiPhoto, aiPhoto, download, drawPoster, exampleShot, fileImage, Logo, makeBackground, savable } from './studioimg';
import './studio.css';

const K = 'studio.';
type St = Out<'createur.studio'>;
type Bg = St['backgrounds'][number];
type Product = St['products'][number];
type Check = { ok: boolean; problems: string[] } | null;
type Version = { src: string; check: Check; checked: boolean; redone: boolean; demo: boolean };
type Row = { key: string; variantId: number | null; title: string; photos: { photo: AiPhoto; preview: string }[]; versions: (Version | { error: string } | null)[]; busy: boolean; picked: number | null; saved: string | null };

const errText = (e: any) => String(e?.message ?? e ?? '').slice(0, 300);

export function Studio() {
  const { t } = useTranslation();
  const { has } = useSession();
  const q = useRpc('createur.studio', {});
  const cr = useRpc('createur.state', {});
  const [buy, setBuy] = useState(false);
  const [bgs, setBgs] = useState<Bg[] | null>(null);
  const [bgId, setBgId] = useState<number | null>(null);
  const [editBg, setEditBg] = useState<Bg | 'new' | null>(null);
  const [keyBox, setKeyBox] = useState(false);
  const [productId, setProductId] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [find, setFind] = useState('');

  useEffect(() => {
    if (q.data && bgs === null) {
      setBgs(q.data.backgrounds);
      setBgId(q.data.backgrounds[0]?.id ?? null);
    }
  }, [q.data, bgs]);

  const product = useMemo(() => q.data?.products.find((p) => p.id === productId) ?? null, [q.data, productId]);
  useEffect(() => {
    if (!product) return setRows([]);
    const vs = product.variants.length ? product.variants.map((v) => ({ variantId: v.id as number | null, title: v.title })) : [{ variantId: null, title: product.name }];
    setRows(vs.map((v) => ({ key: `${product.id}-${v.variantId ?? 0}`, ...v, photos: [], versions: [], busy: false, picked: null, saved: null })));
  }, [product]);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const st = q.data;
  const list = bgs ?? st.backgrounds;
  const bg = list.find((b) => b.id === bgId) ?? null;
  const patch = (key: string, f: (r: Row) => Row) => setRows((old) => old.map((r) => (r.key === key ? f(r) : r)));
  const payLine =
    st.key.mode === 'credits' ? t(K + 'pay.credits', { n: st.tool.credits }) : st.key.mode === 'gemini' ? t(K + 'pay.gemini') : t(K + 'pay.openai');
  const allSaved = rows.length > 0 && rows.every((r) => r.saved);
  const shown = st.products.filter((p) => !find.trim() || p.name.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 60);

  const addPhotos = async (r: Row, files: FileList | null) => {
    const list = Array.from(files ?? []).slice(0, st.limits.photos - r.photos.length);
    const got: Row['photos'] = [];
    for (const f of list) {
      try {
        got.push(await aiPhoto(f));
      } catch {
        toast(t(K + 'notImage'), 'bad');
      }
    }
    if (got.length) patch(r.key, (x) => ({ ...x, photos: [...x.photos, ...got].slice(0, st.limits.photos) }));
  };

  const make = async (r: Row) => {
    if (!bg || !product) return;
    if (r.photos.length < 2) return toast(t(K + 'needTwo'), 'bad');
    patch(r.key, (x) => ({ ...x, busy: true, versions: [null, null, null], picked: null, saved: null }));
    const photos = r.photos.map((p) => p.photo);
    let bgData: string | null = null;
    await Promise.all(
      [0, 1, 2].map(async (k) => {
        let v: Version | { error: string };
        try {
          const res = await rpc('createur.studioMake', { productId: product.id, variantId: r.variantId, backgroundId: bg.id, photos });
          if (res.demo) {
            bgData ??= (await rpc('createur.studioBg', { id: bg.id })).data;
            v = { src: await exampleShot(bgData, photos[k % photos.length], bg.logo, k, t(K + 'example')), check: null, checked: false, redone: false, demo: true };
          } else v = { src: `data:image/jpeg;base64,${res.image}`, check: res.check, checked: res.checked, redone: res.redone, demo: false };
        } catch (e) {
          v = { error: errText(e) };
        }
        patch(r.key, (x) => ({ ...x, versions: x.versions.map((o, i) => (i === k ? v : o)) }));
      }),
    );
    patch(r.key, (x) => ({ ...x, busy: false }));
    void cr.refetch();
  };

  const save = async (r: Row, k: number) => {
    const v = r.versions[k];
    if (!v || 'error' in v || !product) return;
    patch(r.key, (x) => ({ ...x, picked: k, busy: true }));
    try {
      const s = await savable(v.src);
      await rpc('createur.studioSave', { productId: product.id, variantId: r.variantId, ...s });
      patch(r.key, (x) => ({ ...x, saved: v.src, busy: false }));
      toast(t(K + 'saved', { name: r.title }), 'ok');
    } catch (e) {
      patch(r.key, (x) => ({ ...x, busy: false, picked: null }));
      toast(errText(e) || t(K + 'saveFail'), 'bad');
    }
  };

  return (
    <div className="st">
      <div className="st-top">
        <div className="st-pay">
          {cr.data && <CreditPill s={cr.data} onBuy={() => setBuy(true)} />}
          <span className="muted small">{payLine}</span>
          {has('admin') && (
            <button type="button" className="btn small ghost" onClick={() => setKeyBox(true)}>
              <Icon name="key" /> {t(K + 'pay.change')}
            </button>
          )}
        </div>
      </div>
      {!st.server && <p className="st-note">{t(K + 'previewNote')}</p>}
      {!st.tool.on && <p className="st-note bad">{t(K + 'off')}</p>}

      {/* 1. the backgrounds */}
      <section className="st-step">
        <h2>
          <span className="st-n ltr">1</span> {t(K + 'bg.title')}
          <Help text={t(K + 'bg.help')} label={t(K + 'bg.title')} />
        </h2>
        <div className="st-bgs">
          {list.map((b) => (
            <div key={b.id} className={`st-bg${b.id === bgId ? ' on' : ''}`}>
              <button type="button" className="st-bg-pick" onClick={() => setBgId(b.id)} aria-pressed={b.id === bgId}>
                <span className="st-bg-img">
                  <img src={b.thumb} alt="" />
                  {b.logo && <i className="st-logo-box" style={{ left: `${b.logo.x * 100}%`, top: `${b.logo.y * 100}%`, width: `${b.logo.w * 100}%`, height: `${b.logo.h * 100}%` }} />}
                </span>
                <b>{b.name}</b>
                <span className="muted small">{t(K + `bg.${b.surface}`)}</span>
              </button>
              <button type="button" className="btn small ghost" onClick={() => setEditBg(b)} aria-label={t(K + 'bg.edit')}>
                <Icon name="edit" />
              </button>
            </div>
          ))}
          {list.length < st.limits.backgrounds && (
            <button type="button" className="st-bg st-bg-add" onClick={() => setEditBg('new')}>
              <Icon name="plus" />
              <span>{t(K + 'bg.add')}</span>
            </button>
          )}
        </div>
        {!list.length && <p className="muted small">{t(K + 'bg.none')}</p>}
      </section>

      {/* 2. the product's photos, colour by colour */}
      <section className={`st-step${bg ? '' : ' st-dim'}`}>
        <h2>
          <span className="st-n ltr">2</span> {t(K + 'ph.title')}
          <Help text={t(K + 'ph.help')} label={t(K + 'ph.title')} />
        </h2>
        {!product ? (
          <>
            <input className="st-find" placeholder={t(K + 'ph.find')} value={find} onChange={(e) => setFind(e.target.value)} />
            {shown.length ? (
              <div className="st-products">
                {shown.map((p) => (
                  <button key={p.id} type="button" className="st-product" onClick={() => setProductId(p.id)} disabled={!bg}>
                    {p.photo ? <img src={p.photo} alt="" /> : <Icon name="package" />}
                    <b>{p.name}</b>
                    <span className="muted small">{p.variants.length ? t(K + 'ph.variants', { count: p.variants.length }) : t(K + 'ph.noVariant')}</span>
                  </button>
                ))}
              </div>
            ) : (
              <Empty>{t(K + 'ph.noProduct')}</Empty>
            )}
          </>
        ) : (
          <>
            <div className="st-chosen">
              {product.photo ? <img src={product.photo} alt="" /> : <Icon name="package" />}
              <b>{product.name}</b>
              <button type="button" className="btn small ghost" onClick={() => setProductId(null)}>
                {t(K + 'ph.other')}
              </button>
            </div>
            {rows.map((r) => (
              <VariantRow key={r.key} r={r} max={st.limits.photos} ready={!!bg} onAdd={(f) => addPhotos(r, f)} onRemove={(k) => patch(r.key, (x) => ({ ...x, photos: x.photos.filter((_, i) => i !== k) }))} onMake={() => make(r)} onPick={(k) => save(r, k)} />
            ))}
          </>
        )}
      </section>

      {/* 3. the poster */}
      {product && (
        <section className={`st-step${allSaved ? '' : ' st-dim'}`}>
          <h2>
            <span className="st-n ltr">3</span> {t(K + 'po.title')}
            <Help text={t(K + 'po.help')} label={t(K + 'po.title')} />
          </h2>
          {allSaved ? <PosterMaker product={product} rows={rows} shop={cr.data?.shop ?? null} /> : <p className="muted">{t(K + 'po.wait', { done: rows.filter((r) => r.saved).length, of: rows.length })}</p>}
        </section>
      )}

      {editBg && (
        <BgEditor
          bg={editBg === 'new' ? null : editBg}
          onClose={() => setEditBg(null)}
          onDone={(next, pick) => {
            setBgs(next);
            if (pick) setBgId(pick);
            else if (!next.some((b) => b.id === bgId)) setBgId(next[0]?.id ?? null);
            setEditBg(null);
          }}
        />
      )}
      {keyBox && <KeyBox st={st} onClose={() => setKeyBox(false)} onDone={() => (setKeyBox(false), void q.refetch())} />}
      {buy && cr.data && <BuyCredits s={cr.data} onClose={() => (setBuy(false), void cr.refetch())} />}
    </div>
  );
}

function VariantRow({ r, max, ready, onAdd, onRemove, onMake, onPick }: { r: Row; max: number; ready: boolean; onAdd: (f: FileList | null) => void; onRemove: (k: number) => void; onMake: () => void; onPick: (k: number) => void }) {
  const { t } = useTranslation();
  const pick = useRef<HTMLInputElement>(null);
  return (
    <div className={`st-row${r.saved ? ' done' : ''}`}>
      <div className="st-row-head">
        <b>{r.title}</b>
        {r.saved ? <span className="st-tag ok">✅ {t(K + 'ph.done')}</span> : <span className="muted small">{t(K + 'ph.count', { n: r.photos.length, max })}</span>}
      </div>
      <div className="st-photos">
        {r.photos.map((p, k) => (
          <span key={k} className="st-photo">
            <img src={p.preview} alt="" />
            <button type="button" onClick={() => onRemove(k)} aria-label={t(K + 'ph.remove')} disabled={r.busy}>
              ×
            </button>
          </span>
        ))}
        {r.photos.length < max && (
          <button type="button" className="st-photo st-photo-add" onClick={() => pick.current?.click()} disabled={r.busy}>
            <Icon name="camera" />
            <span>{t(K + 'ph.add')}</span>
          </button>
        )}
        <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => (onAdd(e.target.files), (e.target.value = ''))} />
      </div>
      <div className="st-row-go">
        <button type="button" className="btn primary" disabled={!ready || r.busy || r.photos.length < 2} onClick={onMake}>
          <Icon name="zap" /> {r.versions.length ? t(K + 'ph.again') : t(K + 'ph.make')}
        </button>
        {r.photos.length < 2 && <span className="muted small">{t(K + 'needTwo')}</span>}
      </div>
      {r.versions.length > 0 && (
        <div className="st-versions">
          {r.versions.map((v, k) =>
            v === null ? (
              <div key={k} className="st-version wait">
                <span className="st-spin" aria-hidden="true" />
                <span className="muted small">{t(K + 'ph.making')}</span>
              </div>
            ) : 'error' in v ? (
              <div key={k} className="st-version err">
                <Icon name="alert" />
                <span className="small">{v.error}</span>
              </div>
            ) : (
              <div key={k} className={`st-version${r.picked === k ? ' picked' : ''}`}>
                <img src={v.src} alt={t(K + 'ph.version', { n: k + 1 })} />
                <div className="st-check">
                  {v.demo ? (
                    <span className="st-tag">{t(K + 'example')}</span>
                  ) : !v.checked ? (
                    <span className="st-tag">{t(K + 'ck.none')}</span>
                  ) : v.check === null ? (
                    <span className="st-tag warn">⚠️ {t(K + 'ck.unread')}</span>
                  ) : v.check.ok ? (
                    <span className="st-tag ok">✅ {t(K + 'ck.ok')}</span>
                  ) : (
                    <span className="st-tag warn" title={v.check.problems.join(' · ')}>
                      ⚠️ {v.check.problems[0] ?? t(K + 'ck.bad')}
                    </span>
                  )}
                  {v.redone && <span className="muted small">{t(K + 'ck.redone')}</span>}
                </div>
                <div className="st-version-go">
                  <button type="button" className="btn small primary" disabled={r.busy || r.saved === v.src} onClick={() => onPick(k)}>
                    {r.saved === v.src ? `✅ ${t(K + 'ph.chosen')}` : t(K + 'ph.choose')}
                  </button>
                  <Sizes src={v.src} name={`${r.title}-${k + 1}`} />
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** The downloads in the ad sizes. */
function Sizes({ src, name }: { src: string; name: string }) {
  const { t } = useTranslation();
  const file = name.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 40) || 'photo';
  const get = async (kind: '45' | 'square' | 'story') => {
    try {
      download(kind === '45' ? src : await adSize(src, kind), `${file}-${kind === '45' ? '4x5' : kind === 'square' ? '1x1' : '9x16'}.jpg`);
    } catch {
      toast(t(K + 'dlFail'), 'bad');
    }
  };
  return (
    <span className="st-sizes" aria-label={t(K + 'sizes')}>
      <Icon name="download" />
      {(['45', 'square', 'story'] as const).map((k) => (
        <button key={k} type="button" className="btn small ghost ltr" onClick={() => void get(k)}>
          {k === '45' ? '4:5' : k === 'square' ? '1:1' : '9:16'}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- a background: the photo, the blur, the logo box
function BgEditor({ bg, onClose, onDone }: { bg: Bg | null; onClose: () => void; onDone: (next: Bg[], pick?: number) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(bg?.name ?? t(K + 'bg.defaultName'));
  const [surface, setSurface] = useState<'table' | 'floor'>(bg?.surface ?? 'table');
  const [logo, setLogo] = useState<Logo | null>(bg?.logo ?? null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [blur, setBlur] = useState(14);
  const [focus, setFocus] = useState(72);
  const [view, setView] = useState<string | null>(bg?.thumb ?? null);
  const [made, setMade] = useState<ReturnType<typeof makeBackground> | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!img) return;
    const h = setTimeout(() => {
      const m = makeBackground(img, blur, focus / 100);
      setMade(m);
      setView(m.canvas.toDataURL('image/jpeg', 0.8));
    }, 120);
    return () => clearTimeout(h);
  }, [img, blur, focus]);

  const at = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    setDrag(p);
    setLogo({ x: p.x, y: p.y, w: 0.01, h: 0.01 });
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const p = at(e);
    setLogo({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.max(0.01, Math.abs(p.x - drag.x)), h: Math.max(0.01, Math.abs(p.y - drag.y)) });
  };
  const up = () => {
    setDrag(null);
    setLogo((l) => (l && (l.w < 0.03 || l.h < 0.02) ? null : l));
  };

  const save = async () => {
    setBusy(true);
    try {
      if (bg) {
        const r = await rpc('createur.studioEditBg', { id: bg.id, name: name.trim() || bg.name, surface, logo });
        onDone(r.backgrounds);
      } else {
        if (!made) return toast(t(K + 'bg.needPhoto'), 'bad');
        const r = await rpc('createur.studioAddBg', { name: name.trim() || t(K + 'bg.defaultName'), data: made.data, thumb: made.thumb, w: made.w, h: made.h, logo, surface });
        onDone(r.backgrounds, r.backgrounds.at(-1)?.id);
      }
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!bg || !window.confirm(t(K + 'bg.removeAsk', { name: bg.name }))) return;
    try {
      onDone((await rpc('createur.studioRemoveBg', { id: bg.id })).backgrounds);
    } catch (e) {
      toast(errText(e), 'bad');
    }
  };

  return (
    <Modal
      wide
      title={bg ? t(K + 'bg.edit') : t(K + 'bg.add')}
      onClose={onClose}
      footer={
        <>
          {bg && (
            <button type="button" className="btn ghost danger" onClick={remove}>
              {t(K + 'bg.remove')}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || (!bg && !made)} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="st-editor">
        <div className="st-canvas-wrap">
          {view ? (
            <div ref={box} className="st-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
              <img src={view} alt="" draggable={false} />
              {logo && <i className="st-logo-box" style={{ left: `${logo.x * 100}%`, top: `${logo.y * 100}%`, width: `${logo.w * 100}%`, height: `${logo.h * 100}%` }} />}
              {!bg && <i className="st-focus-line" style={{ top: `${focus}%` }} />}
            </div>
          ) : (
            <button type="button" className="st-canvas st-canvas-empty" onClick={() => pick.current?.click()}>
              <Icon name="image" />
              <span>{t(K + 'bg.pick')}</span>
            </button>
          )}
          <input
            ref={pick}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                setImg(await fileImage(f));
              } catch {
                toast(t(K + 'notImage'), 'bad');
              }
            }}
          />
        </div>
        <div className="st-editor-side">
          <Field label={t(K + 'bg.name')}>
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t(K + 'bg.surface')}>
            <select value={surface} onChange={(e) => setSurface(e.target.value as 'table' | 'floor')}>
              <option value="table">{t(K + 'bg.table')}</option>
              <option value="floor">{t(K + 'bg.floor')}</option>
            </select>
          </Field>
          {!bg && (
            <>
              <Field label={t(K + 'bg.blur', { n: blur })} hint={t(K + 'bg.blurHint')}>
                <input type="range" min={0} max={30} value={blur} onChange={(e) => setBlur(Number(e.target.value))} disabled={!img} />
              </Field>
              <Field label={t(K + 'bg.focus')} hint={t(K + 'bg.focusHint')}>
                <input type="range" min={40} max={100} value={focus} onChange={(e) => setFocus(Number(e.target.value))} disabled={!img} />
              </Field>
              {img && (
                <button type="button" className="btn small" onClick={() => pick.current?.click()}>
                  {t(K + 'bg.otherPhoto')}
                </button>
              )}
            </>
          )}
          <div className="st-logo-help">
            <b>{t(K + 'bg.logo')}</b>
            <p className="muted small">{t(K + 'bg.logoHint')}</p>
            {logo && (
              <button type="button" className="btn small ghost" onClick={() => setLogo(null)}>
                {t(K + 'bg.logoClear')}
              </button>
            )}
          </div>
          {bg && <p className="muted small">{t(K + 'bg.photoFixed')}</p>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- who pays the AI
function KeyBox({ st, onClose, onDone }: { st: St; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(st.key.mode);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(st.key.model);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await rpc('createur.studioKey', { mode, ...(key.trim() ? { key: key.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) });
      toast(t(K + 'key.saved'), 'ok');
      onDone();
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t(K + 'key.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="st-key">
        {(['credits', 'gemini', 'openai'] as const).map((m) => (
          <label key={m} className={`st-key-opt${mode === m ? ' on' : ''}`}>
            <input type="radio" name="st-key" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <b>{t(K + `key.${m}`)}</b>
              <span className="muted small">{t(K + `key.${m}Help`)}</span>
            </span>
          </label>
        ))}
        {mode !== 'credits' && (
          <>
            <Field label={t(K + 'key.key')} hint={st.key.has && st.key.mode === mode ? t(K + 'key.kept') : t(K + 'key.keyHint')}>
              <input type="password" autoComplete="off" className="ltr" value={key} onChange={(e) => setKey(e.target.value)} placeholder={mode === 'gemini' ? 'AIza…' : 'sk-…'} />
            </Field>
            <Field label={t(K + 'key.model')} hint={t(K + 'key.modelHint')}>
              <input className="ltr" value={model} onChange={(e) => setModel(e.target.value)} placeholder={mode === 'gemini' ? 'gemini-3.1-flash-image-preview' : 'gpt-image-1'} />
            </Field>
            {mode === 'openai' && <p className="muted small">{t(K + 'key.openaiNoCheck')}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the poster
type Shop = { name: string; phone: string; logo: string | null } | null;

function PosterMaker({ product, rows, shop }: { product: Product; rows: Row[]; shop: Shop }) {
  const { t, i18n } = useTranslation();
  const [lang, setLang] = useState<'ar' | 'fr'>(i18n.language === 'fr' ? 'fr' : 'ar');
  const saved = rows.filter((r) => r.saved);
  const [hero, setHero] = useState(saved[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [features, setFeatures] = useState(['', '', '', '']);
  const [price, setPrice] = useState(product.price != null ? String(product.price) : '');
  const [oldPrice, setOldPrice] = useState('');
  const [phone, setPhone] = useState(shop?.phone ?? '');
  const [shopName, setShopName] = useState(shop?.name ?? '');
  const [delivery, setDelivery] = useState(true);
  const [cod, setCod] = useState(true);
  const [accent, setAccent] = useState('#d6246e');
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState<'texts' | 'save' | null>(null);
  const L = (k: string) => t(K + `po.${lang}.${k}`);

  useEffect(() => {
    const src = saved.find((r) => r.key === hero)?.saved ?? saved[0]?.saved;
    if (!src) return;
    let live = true;
    const h = setTimeout(async () => {
      const url = await drawPoster(src, {
        shop: shopName.trim(),
        title: title.trim(),
        subtitle: subtitle.trim(),
        features: features.map((f) => f.trim()),
        price: price.trim() ? Number(price) : null,
        oldPrice: oldPrice.trim() ? Number(oldPrice) : null,
        currency: L('currency'),
        cta: L('cta'),
        phone: phone.trim(),
        delivery: delivery ? L('delivery') : '',
        cod: cod ? L('cod') : '',
        colorsLabel: L('colors'),
        colors: saved.length > 1 ? saved.map((r) => ({ name: r.title, src: r.saved! })) : [],
        rtl: lang === 'ar',
        accent,
      }).catch(() => null);
      if (live) setOut(url);
    }, 200);
    return () => {
      live = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hero, title, subtitle, features, price, oldPrice, phone, shopName, delivery, cod, accent, lang, rows]);

  const suggest = async () => {
    setBusy('texts');
    try {
      const r = await rpc('createur.studioTexts', { productId: product.id, lang });
      setTitle(r.title);
      setSubtitle(r.subtitle);
      setFeatures([0, 1, 2, 3].map((k) => r.features[k] ?? ''));
      if (r.demo) toast(t(K + 'po.example'), 'info');
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!out) return;
    setBusy('save');
    try {
      const s = await savable(out);
      await rpc('createur.studioSave', { productId: product.id, variantId: null, main: true, ...s });
      toast(t(K + 'po.saved'), 'ok');
    } catch (e) {
      toast(errText(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const bad = price.trim() !== '' && !(Number(price) > 0);

  return (
    <div className="st-poster">
      <div className="st-poster-view">{out ? <img src={out} alt={t(K + 'po.title')} /> : <Loading />}</div>
      <div className="st-poster-form">
        <div className="st-poster-row">
          <Field label={t(K + 'po.lang')}>
            <select value={lang} onChange={(e) => setLang(e.target.value as 'ar' | 'fr')}>
              <option value="ar">العربية</option>
              <option value="fr">Français</option>
            </select>
          </Field>
          {saved.length > 1 && (
            <Field label={t(K + 'po.hero')}>
              <select value={hero} onChange={(e) => setHero(e.target.value)}>
                {saved.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <button type="button" className="btn" disabled={busy !== null} onClick={suggest}>
          <Icon name="zap" /> {t(K + 'po.suggest')}
        </button>
        <Field label={t(K + 'po.titleField')}>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} dir="auto" />
        </Field>
        <Field label={t(K + 'po.subtitle')}>
          <input value={subtitle} maxLength={60} onChange={(e) => setSubtitle(e.target.value)} dir="auto" />
        </Field>
        <div className="st-feats">
          {features.map((f, k) => (
            <input key={k} value={f} maxLength={40} dir="auto" placeholder={t(K + 'po.feature', { n: k + 1 })} onChange={(e) => setFeatures((old) => old.map((x, i) => (i === k ? e.target.value : x)))} />
          ))}
        </div>
        <div className="st-poster-row">
          <Field label={t(K + 'po.price')} hint={bad ? t(K + 'po.priceBad') : t(K + 'po.priceHint')}>
            <input inputMode="numeric" className="ltr" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} />
          </Field>
          <Field label={t(K + 'po.oldPrice')}>
            <input inputMode="numeric" className="ltr" value={oldPrice} onChange={(e) => setOldPrice(e.target.value.replace(/[^\d]/g, ''))} />
          </Field>
        </div>
        <div className="st-poster-row">
          <Field label={t(K + 'po.shop')}>
            <input value={shopName} maxLength={40} onChange={(e) => setShopName(e.target.value)} dir="auto" />
          </Field>
          <Field label={t(K + 'po.phone')}>
            <input className="ltr" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <div className="st-poster-row">
          <label className="st-check-line">
            <input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} /> {L('delivery')}
          </label>
          <label className="st-check-line">
            <input type="checkbox" checked={cod} onChange={(e) => setCod(e.target.checked)} /> {L('cod')}
          </label>
          <label className="st-check-line">
            {t(K + 'po.accent')} <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
          </label>
        </div>
        <p className="muted small">{t(K + 'po.rule')}</p>
        <div className="st-poster-go">
          <button type="button" className="btn primary" disabled={!out || bad || busy !== null} onClick={save}>
            {t(K + 'po.save')}
          </button>
          {out && <Sizes src={out} name={`${product.name}-affiche`} />}
        </div>
      </div>
    </div>
  );
}
