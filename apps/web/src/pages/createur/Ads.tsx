// Espace créateur › 3. Mes pubs (the videos of pubs/: watch, download, delete, pick some) and › 4. Publier: each picked
// ad becomes a Facebook and/or Instagram post (Pilot Content's calendar does the rest). Its text = the part that changes
// (written by the AI from the ad's hook, or by hand) + the fixed part (price, delivery, payment), the same for all.
// A video leaves the computer only here: Meta must download it, so it goes to the Pilotix server for that post.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc } from '../../lib/backend';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { readVideo, sendPieces, videoBody } from '../social/video';
import type { CrState } from './Credits';
import { AdFile, Notes, removeAd } from './folder';
import { clipInfo, clipInfoNow, ClipInfo } from './probe';

type Lists = Out<'cm.plan.list'>;
const K = 'createur.ad.';
const P = 'createur.pb.';

function AdThumb({ ad }: { ad: AdFile }) {
  const [info, setInfo] = useState<ClipInfo | null | undefined>(() => clipInfoNow(ad.key));
  useEffect(() => {
    if (info !== undefined) return;
    let live = true;
    clipInfo(ad.key, ad.file).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [ad.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cr-th-img">
      {info?.thumb ? (
        <img src={info.thumb} alt="" loading="lazy" />
      ) : (
        <span className="cr-th-ph">
          <Icon name="film" />
        </span>
      )}
      {info?.duration ? <span className="cr-res ltr">{Math.round(info.duration)} s</span> : null}
    </div>
  );
}

export function AdsTab({
  dir,
  ads,
  notes,
  picked,
  setPicked,
  onChange,
  onPublish,
}: {
  dir: FileSystemDirectoryHandle;
  ads: AdFile[];
  notes: Notes;
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  onChange: () => void;
  onPublish: () => void;
}) {
  const { t } = useTranslation();
  const [watch, setWatch] = useState<{ name: string; url: string } | null>(null);
  const [del, setDel] = useState<AdFile | null>(null);
  useEffect(() => () => void (watch && URL.revokeObjectURL(watch.url)), [watch]);
  const toggle = (n: string) => {
    const s = new Set(picked);
    if (s.has(n)) s.delete(n);
    else s.add(n);
    setPicked(s);
  };
  const download = (a: AdFile) => {
    const url = URL.createObjectURL(a.file);
    const el = document.createElement('a');
    el.href = url;
    el.download = a.name;
    el.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  if (!ads.length) return <p className="card cr-notice">{t(K + 'none')}</p>;
  return (
    <>
      <section className="card cr-bar">
        <b>{t(K + 'count', { count: ads.length })}</b>
        <span className="muted small">{t(K + 'where')}</span>
        <button type="button" className="btn small" onClick={() => setPicked(picked.size === ads.length ? new Set() : new Set(ads.map((a) => a.name)))}>
          {picked.size === ads.length ? t(K + 'none2') : t(K + 'allPick')}
        </button>
        <button type="button" className="btn primary" disabled={!picked.size} onClick={onPublish}>
          {t(K + 'publish', { count: picked.size })}
        </button>
      </section>
      <ul className="ad-grid">
        {ads.map((a) => {
          const how = notes.ads[a.name];
          return (
            <li key={a.key} className={`card ad-card${picked.has(a.name) ? ' on' : ''}`}>
              <label className="ad-pick">
                <input type="checkbox" checked={picked.has(a.name)} onChange={() => toggle(a.name)} />
                <b className="ltr">{a.name.replace(/\.mp4$/i, '')}</b>
              </label>
              <button type="button" className="ad-play" onClick={() => setWatch({ name: a.name, url: URL.createObjectURL(a.file) })} aria-label={t(K + 'watch', { name: a.name })}>
                <AdThumb ad={a} />
              </button>
              <small className="muted ltr">{(a.file.size / 1024 / 1024).toFixed(1)} Mo</small>
              {how && (
                <small className="muted" title={`${how.hook} + ${how.body}`}>
                  {how.strategy}
                </small>
              )}
              <div className="ad-acts">
                <button type="button" className="btn small" onClick={() => download(a)}>
                  <Icon name="download" />
                </button>
                <button type="button" className="btn small" onClick={() => setDel(a)} aria-label={t(K + 'delete')}>
                  <Icon name="x" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {watch && (
        <Modal title={watch.name} onClose={() => setWatch(null)}>
          <video src={watch.url} controls autoPlay playsInline style={{ width: '100%', maxHeight: '70vh', background: '#000', borderRadius: 12 }} />
        </Modal>
      )}
      {del && (
        <Modal
          title={t(K + 'delTitle')}
          onClose={() => setDel(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDel(null)}>
                {t('createur.del.no')}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  const a = del;
                  setDel(null);
                  await removeAd(dir, a.name).catch(() => toast(t('createur.deleteFail'), 'bad'));
                  onChange();
                }}
              >
                {t('createur.del.yes')}
              </button>
            </>
          }
        >
          <p>{t(K + 'delText', { name: del.name })}</p>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 4. Publier
const pad = (n: number) => String(n).padStart(2, '0');

export function PublishTab(p: {
  ads: AdFile[];
  notes: Notes;
  saveNotes: (f: (n: Notes) => void) => Promise<Notes>;
  st: CrState;
  lists: Lists;
  product: { id: number; name: string; price: number };
  onCredits: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const acc = p.lists.accounts;
  const [fb, setFb] = useState(!!acc.facebook);
  const [ig, setIg] = useState(!!acc.instagram);
  const [when, setWhen] = useState<'now' | 'daily' | 'date'>('daily');
  const [hour, setHour] = useState('20:00');
  const tomorrow = useMemo(() => {
    const d = new Date(Date.now() + 86_400_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);
  const [day, setDay] = useState(tomorrow);
  const [product, setProduct] = useState<Record<string, number>>(() => Object.fromEntries(p.ads.map((a) => [a.name, p.product.id])));
  const [allProducts, setAllProducts] = useState<number[]>([p.product.id]);
  const fixedDefault = `💰 ${p.product.price ? `${p.product.price.toLocaleString('fr-FR')} دج` : '[السعر] دج'} · الدفع عند الاستلام · التوصيل لـ 58 ولاية\n📩 اطلب الآن في الرسائل`;
  const [fixed, setFixed] = useState(p.notes.fixed ?? fixedDefault);
  const [parts, setParts] = useState<Record<string, string>>(() => Object.fromEntries(p.ads.map((a) => [a.name, p.notes.ads[a.name]?.post ?? ''])));
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState<{ n: number; total: number; share: number } | null>(null);
  const textTool = p.st.tools.find((x) => x.key === 'posttext');
  const channels = [...(fb ? ['facebook' as const] : []), ...(ig ? ['instagram' as const] : [])];

  // « Pour quel produit ? »: one or several; the ads are shared between them in turn
  const setProducts = (ids: number[]) => {
    setAllProducts(ids);
    if (ids.length) setProduct(Object.fromEntries(p.ads.map((a, k) => [a.name, ids[k % ids.length]])));
  };

  const write = async () => {
    setWriting(true);
    try {
      const items = p.ads.map((a) => {
        const how = p.notes.ads[a.name];
        const hookText = how ? (p.notes.text[how.hook] ?? '') : '';
        return { hook: hookText, body: '' };
      });
      const first = p.notes.ads[p.ads[0]?.name];
      const r = await rpc('createur.texts', { productId: p.product.id, strategy: first?.strategy, ...(first?.stage ? { stage: first.stage } : {}), lang: 'darija', items });
      const next = Object.fromEntries(p.ads.map((a, k) => [a.name, r.lines[k] ?? '']));
      setParts(next);
      if (r.demo) toast(t(P + 'demo'), 'info');
      p.onCredits();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setWriting(false);
    }
  };

  const go = async () => {
    if (!channels.length) return toast(t(P + 'pickNet'), 'bad');
    if (!backend.upload) return toast(t(P + 'noServer'), 'bad');
    await p.saveNotes((n) => {
      n.fixed = fixed;
      for (const a of p.ads) if (n.ads[a.name]) n.ads[a.name].post = parts[a.name] ?? '';
    });
    const [hh, mm] = hour.split(':').map(Number);
    let done = 0;
    for (let k = 0; k < p.ads.length; k++) {
      const a = p.ads[k];
      setBusy({ n: k + 1, total: p.ads.length, share: 0 });
      try {
        const meta = await readVideo(a.file);
        URL.revokeObjectURL(meta.local);
        const r = await rpc('cm.plan.videoStart', { mime: meta.mime, size: a.file.size, w: meta.w, h: meta.h, duration: meta.duration, thumb: meta.thumb, name: a.file.name });
        if (r.upload) {
          const body = await videoBody(a.file, meta.mime);
          await sendPieces(
            body,
            r.chunk,
            (part, piece) => backend.upload!(`/cm/video/${r.id}/${r.key}?part=${part}`, piece),
            (share) => setBusy((b) => (b ? { ...b, share } : b)),
          );
          await rpc('cm.plan.videoDone', { id: r.id });
        }
        // an awareness video made with « commentez CODE »: the post asks the same, before the fixed part
        const cta = p.notes.ads[a.name]?.cta ? t(P + 'ctaLine') : '';
        const caption = [parts[a.name]?.trim(), cta, fixed.trim()].filter(Boolean).join('\n\n');
        let at: string | null = null;
        if (when !== 'now') {
          const base = new Date(`${when === 'date' ? day : tomorrow}T${pad(hh || 0)}:${pad(mm || 0)}:00`);
          base.setDate(base.getDate() + (when === 'daily' ? k : 0));
          at = base.toISOString();
        }
        const saved = await rpc('cm.plan.save', {
          caption,
          photos: [r.id],
          channels,
          productId: product[a.name] ?? p.product.id,
          publishAt: at,
          schedule: when !== 'now',
          lang: 'darija',
          kind: 'post',
        });
        if (when === 'now') await rpc('cm.plan.publishNow', { id: saved.id });
        done++;
      } catch (e: any) {
        toast(`${a.name} : ${e?.message ?? t('common.error')}`, 'bad');
        break;
      }
    }
    setBusy(null);
    if (done) {
      toast(when === 'now' ? t(P + 'out', { count: done }) : t(P + 'planned', { count: done }), 'ok');
      p.onDone();
    }
  };

  if (!p.ads.length) return <p className="card cr-notice">{t(P + 'pickFirst')}</p>;
  return (
    <div className="mx">
      <section className="card mx-sec">
        <h2>{t(P + 'product')}</h2>
        <div className="mx-row">
          {p.lists.products.map((x) => (
            <label key={x.id} className={`mx-chip${allProducts.includes(x.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={allProducts.includes(x.id)} onChange={(e) => setProducts(e.target.checked ? [...allProducts, x.id] : allProducts.filter((y) => y !== x.id))} /> {x.name}
            </label>
          ))}
        </div>
        <p className="small muted">{t(P + 'productHelp')}</p>
      </section>

      <div className="mx-two">
        <section className="card mx-sec">
          <h2>{t(P + 'where')}</h2>
          <label className="check">
            <input type="checkbox" checked={fb} disabled={!acc.facebook} onChange={(e) => setFb(e.target.checked)} /> {t(P + 'fb')}
            {!acc.facebook && <small className="muted"> — {t(P + 'noFb')}</small>}
          </label>
          <label className="check">
            <input type="checkbox" checked={ig} disabled={!acc.instagram} onChange={(e) => setIg(e.target.checked)} /> {t(P + 'ig')}
            {!acc.instagram && <small className="muted"> — {t(P + 'noIg')}</small>}
          </label>
        </section>
        <section className="card mx-sec">
          <h2>{t(P + 'when')}</h2>
          {(['now', 'daily', 'date'] as const).map((w) => (
            <label key={w} className="check">
              <input type="radio" name="pb-when" checked={when === w} onChange={() => setWhen(w)} /> {t(P + `w_${w}`)}
            </label>
          ))}
          {when !== 'now' && (
            <div className="mx-row">
              {when === 'date' && <input type="date" value={day} min={tomorrow} onChange={(e) => setDay(e.target.value)} />}
              <input type="time" value={hour} onChange={(e) => setHour(e.target.value)} />
            </div>
          )}
        </section>
      </div>

      <section className="card mx-sec">
        <div className="mx-h">
          <h2>{t(P + 'text')}</h2>
          {textTool && (
            <button type="button" className="btn small" disabled={writing || !!busy} onClick={() => void write()}>
              ✨ {writing ? t(P + 'writing') : t(P + 'write', { n: textTool.credits * p.ads.length })}
            </button>
          )}
        </div>
        <label className="field">
          <span className="lab">{t(P + 'fixed')}</span>
          <textarea rows={3} dir="auto" value={fixed} onChange={(e) => setFixed(e.target.value)} />
        </label>
        <div className="pb-list">
          {p.ads.map((a) => (
            <div key={a.name} className="pb-item">
              <b className="ltr">{a.name.replace(/\.mp4$/i, '')}</b>
              <label className="field">
                <span className="lab">{t(P + 'changing')}</span>
                <textarea rows={2} dir="auto" value={parts[a.name] ?? ''} onChange={(e) => setParts((o) => ({ ...o, [a.name]: e.target.value }))} placeholder={t(P + 'changingPh')} />
              </label>
              {allProducts.length > 1 && (
                <select value={product[a.name]} onChange={(e) => setProduct((o) => ({ ...o, [a.name]: Number(e.target.value) }))} aria-label={t(P + 'product')}>
                  {p.lists.products
                    .filter((x) => allProducts.includes(x.id))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="cr-total mx-go" role="status">
        <div className="cr-total-txt">
          <b>{t(P + 'quality')}</b>
          <span>{t(P + 'serverNote')}</span>
        </div>
        {busy ? (
          <div className="mx-run">
            <span>{t(P + 'sending', { n: busy.n, total: busy.total, pct: Math.round(busy.share * 100) })}</span>
            <i>
              <b style={{ width: `${Math.round(busy.share * 100)}%` }} />
            </i>
          </div>
        ) : (
          <button type="button" className="btn primary big" disabled={!channels.length || !allProducts.length} onClick={() => void go()}>
            {t(P + 'go', { count: p.ads.length })}
          </button>
        )}
      </div>
    </div>
  );
}
