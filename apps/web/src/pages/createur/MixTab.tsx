// Espace créateur › 2. Mélanger: the strategy (its editing style), the format, the hooks' texts, what Pilotix adds
// (subtitles, zooms, price, logo), which pairs hook + body to make, then « Créer les pubs »: one after the other, made on
// this computer and written into pubs/. The subtitles are asked once per piece (they cost credits) and kept in
// pilotix.json, next to the videos.
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { CrState } from './Credits';
import { adHandle, Clip, Notes } from './folder';
import { encodeOn, Format, FORMATS, goodMix, Look, makeAd, pieceSound, Stopped } from './mix';
import { clipInfoNow } from './probe';

const K = 'createur.mx.';
type Script = 'arabic' | 'latin' | 'fr';
type Run = { n: number; total: number; share: number; step: 'words' | 'video' };

export function MixTab(p: {
  dir: FileSystemDirectoryHandle;
  hooks: Clip[];
  bodies: Clip[];
  notes: Notes;
  saveNotes: (f: (n: Notes) => void) => Promise<Notes>;
  st: CrState;
  product: { id: number; name: string; price: number };
  onCredits: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const strategies = p.st.strategies;
  const [strategy, setStrategy] = useState(strategies[0]?.key ?? '');
  const strat = strategies.find((s) => s.key === strategy) ?? strategies[0];
  const [format, setFormat] = useState<Format>('9:16');
  const has4k = [...p.hooks, ...p.bodies].some((c) => {
    const i = clipInfoNow(c.key);
    return !!i && Math.min(i.w, i.h) >= 2160;
  });
  const [big, setBig] = useState(false);
  const [hookText, setHookText] = useState(true);
  const wordsTool = p.st.tools.find((x) => x.key === 'subtitles');
  const hooksTool = p.st.tools.find((x) => x.key === 'hookideas');
  const [subtitles, setSubtitles] = useState(!!wordsTool);
  const [script, setScript] = useState<Script>('arabic');
  const [zoom, setZoom] = useState(true);
  const [circle, setCircle] = useState(false);
  const [price, setPrice] = useState(p.product.price ? String(p.product.price) : '');
  const [cod, setCod] = useState(true);
  const [delivery, setDelivery] = useState(true);
  const [logo, setLogo] = useState(!!p.st.shop.logo);
  const total = p.hooks.length * p.bodies.length;
  const [pick, setPick] = useState<Set<string>>(() => new Set(goodMix(p.hooks.length, p.bodies.length, 10).map(([h, b]) => `${h}:${b}`)));
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [ideasFor, setIdeasFor] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const stop = useRef(false);

  const pairs = useMemo(
    () =>
      [...pick]
        .map((k) => k.split(':').map(Number) as [number, number])
        .filter(([h, b]) => h < p.hooks.length && b < p.bodies.length)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [pick, p.hooks.length, p.bodies.length],
  );
  const used = useMemo(() => {
    const m = new Map<string, Clip>();
    for (const [h, b] of pairs) (m.set(p.hooks[h].key, p.hooks[h]), m.set(p.bodies[b].key, p.bodies[b]));
    return [...m.values()];
  }, [pairs, p.hooks, p.bodies]);
  const toListen = subtitles ? used.filter((c) => !p.notes.words[c.key]) : [];
  const minutes = toListen.reduce((s, c) => s + Math.max(1, Math.ceil((clipInfoNow(c.key)?.duration ?? 60) / 60)), 0);
  const cost = (wordsTool ? minutes * wordsTool.credits : 0) + (strat?.credits ?? 0) * pairs.length;
  const left = p.st.wallet?.left ?? -1;
  const short = left >= 0 && cost > left;

  const label = (h: number, b: number) => `H${h + 1}+B${b + 1}`;
  const setAll = (all: boolean) => setPick(new Set((all ? goodMix(p.hooks.length, p.bodies.length, total) : goodMix(p.hooks.length, p.bodies.length, 10)).map(([h, b]) => `${h}:${b}`)));
  const toggle = (k: string) =>
    setPick((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const askIdeas = async (hook: string) => {
    setIdeasFor(hook);
    setIdeas(null);
    try {
      const r = await rpc('createur.hooks', { productId: p.product.id, strategy, lang: script === 'fr' ? 'fr' : 'darija' });
      setIdeas(r.lines);
      p.onCredits();
      if (r.demo) toast(t(K + 'demoIdeas'), 'info');
    } catch (e: any) {
      setIdeasFor(null);
      toast(e?.message ?? t('common.error'), 'bad');
    }
  };

  const start = async () => {
    if (!pairs.length || run) return;
    stop.current = false;
    let notes = p.notes;
    // 1. the subtitles of the pieces not listened to yet
    if (subtitles && wordsTool) {
      for (let i = 0; i < toListen.length; i++) {
        if (stop.current) return setRun(null);
        const c = toListen[i];
        setRun({ n: i + 1, total: toListen.length, share: 0, step: 'words' });
        try {
          const snd = await pieceSound(c.file);
          if (!snd) {
            notes = await p.saveNotes((n) => void (n.words[c.key] = []));
            continue;
          }
          const r = await rpc('createur.words', { audio: snd.audio, mime: snd.mime, seconds: snd.seconds, script });
          notes = await p.saveNotes((n) => void (n.words[c.key] = r.segments));
          if (r.demo) toast(t(K + 'demoWords'), 'info');
        } catch (e: any) {
          toast(`${c.name} : ${e?.message ?? t('common.error')}`, 'bad');
          setRun(null);
          p.onCredits();
          return;
        }
      }
      p.onCredits();
    }
    // 2. the ads, one after the other
    const look: Look = {
      style: strat?.style === 'clean' ? 'clean' : 'ugly',
      format,
      big: big && has4k,
      zoom,
      hookText,
      subtitles,
      circle,
      end: { price: price.replace(/[^\d ]/g, '').trim(), cod, delivery, logo: logo ? p.st.shop.logo : null },
    };
    let made = 0;
    for (let i = 0; i < pairs.length; i++) {
      if (stop.current) break;
      const [h, b] = pairs[i];
      const hook = p.hooks[h];
      const body = p.bodies[b];
      const name = `${label(h, b)}.mp4`;
      setRun({ n: i + 1, total: pairs.length, share: 0, step: 'video' });
      let target: FileSystemFileHandle | null = null;
      try {
        target = await adHandle(p.dir, name);
        await makeAd({
          hook: { file: hook.file, text: notes.text[hook.name] ?? '', words: notes.words[hook.key] },
          body: { file: body.file, words: notes.words[body.key] },
          look,
          target,
          progress: (share) => setRun((r) => (r ? { ...r, share } : r)),
          stop: () => stop.current,
        });
        made++;
        notes = await p.saveNotes((n) => void (n.ads[name] = { hook: hook.name, body: body.name, strategy: strat?.key ?? '', at: new Date().toISOString() }));
        if (strat && strat.credits > 0) await rpc('createur.made', { strategy: strat.key, count: 1 }).catch((e) => toast(e?.message ?? '', 'bad'));
      } catch (e: any) {
        // a half-made file is removed
        await p.dir
          .getDirectoryHandle('pubs')
          .then((d) => d.removeEntry(name))
          .catch(() => undefined);
        if (e instanceof Stopped) break;
        toast(`${name} : ${e?.message ?? t('common.error')}`, 'bad');
        break;
      }
    }
    setRun(null);
    p.onCredits();
    if (made) {
      toast(t(K + 'made', { count: made }), 'ok');
      p.onDone();
    }
  };

  if (!encodeOn()) return <p className="card cr-notice">{t(K + 'noEncoder')}</p>;
  if (!p.hooks.length || !p.bodies.length) return <p className="card cr-notice">{t(K + 'needPieces')}</p>;

  return (
    <div className="mx">
      <section className="card mx-sec">
        <h2>{t(K + 'strategy')}</h2>
        <div className="mx-strats">
          {strategies.map((s) => (
            <button type="button" key={s.key} className={`mx-strat${s.key === strat?.key ? ' on' : ''}`} onClick={() => setStrategy(s.key)} disabled={!!run}>
              <b>{s.name}</b>
              <span className="mx-tags">
                <span className={s.credits ? 'mx-tag paid' : 'mx-tag free'}>{s.credits ? t(K + 'perAd', { n: s.credits }) : t(K + 'free')}</span>
                {s.trend && <span className="mx-tag trend">{t(K + 'trend')}</span>}
              </span>
              <small>{s.desc}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="mx-two">
        <section className="card mx-sec">
          <h2>{t(K + 'format')}</h2>
          <div className="mx-row">
            {(Object.keys(FORMATS) as Format[]).map((f) => (
              <label key={f} className={`mx-chip${format === f ? ' on' : ''}`}>
                <input type="radio" name="mx-format" checked={format === f} onChange={() => setFormat(f)} disabled={!!run} /> <b className="ltr">{f}</b>{' '}
                <small>{t(K + `formats.${f.replace(':', '')}`)}</small>
              </label>
            ))}
          </div>
          <p className="small">
            <Icon name="check" /> {t(K + 'quality')}
          </p>
          <label className="check">
            <input type="checkbox" checked={big && has4k} disabled={!has4k || !!run} onChange={(e) => setBig(e.target.checked)} /> {t(K + 'big')}
            {!has4k && <small className="muted"> — {t(K + 'no4k')}</small>}
          </label>
        </section>

        <section className="card mx-sec">
          <h2>{t(K + 'adds')}</h2>
          <label className="check">
            <input type="checkbox" checked={hookText} onChange={(e) => setHookText(e.target.checked)} disabled={!!run} /> {t(K + 'hookText')}
          </label>
          {wordsTool && (
            <label className="check">
              <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} disabled={!!run} /> {t(K + 'subtitles', { n: wordsTool.credits })}
              <select value={script} onChange={(e) => setScript(e.target.value as Script)} disabled={!subtitles || !!run} aria-label={t(K + 'script')}>
                <option value="arabic">{t(K + 'scripts.arabic')}</option>
                <option value="latin">{t(K + 'scripts.latin')}</option>
                <option value="fr">{t(K + 'scripts.fr')}</option>
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} disabled={!!run} /> {t(K + 'zoom')}
          </label>
          <label className="check">
            <input type="checkbox" checked={circle} onChange={(e) => setCircle(e.target.checked)} disabled={!!run} /> {t(K + 'circle')}
          </label>
          <div className="mx-end">
            <b>{t(K + 'end')}</b>
            <label className="field">
              <span className="lab">{t(K + 'price')}</span>
              <input inputMode="numeric" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!!run} placeholder="2900" />
            </label>
            <label className="check">
              <input type="checkbox" checked={cod} onChange={(e) => setCod(e.target.checked)} disabled={!!run} /> « الدفع عند الاستلام »
            </label>
            <label className="check">
              <input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} disabled={!!run} /> « التوصيل لـ 58 ولاية »
            </label>
            <label className="check">
              <input type="checkbox" checked={logo && !!p.st.shop.logo} onChange={(e) => setLogo(e.target.checked)} disabled={!p.st.shop.logo || !!run} /> {t(K + 'logo')}
              {!p.st.shop.logo && <small className="muted"> — {t(K + 'noLogo')}</small>}
            </label>
          </div>
        </section>
      </div>

      {hookText && (
        <section className="card mx-sec">
          <h2>{t(K + 'texts')}</h2>
          <p className="small muted">{t(K + 'textsHelp')}</p>
          <div className="mx-hooks">
            {p.hooks.map((c, i) => (
              <div key={c.key} className="mx-hook">
                <span className="mx-hl ltr">H{i + 1}</span>
                {clipInfoNow(c.key)?.thumb && <img src={clipInfoNow(c.key)!.thumb} alt="" />}
                <input
                  key={p.notes.text[c.name] ?? ''}
                  defaultValue={p.notes.text[c.name] ?? ''}
                  placeholder={t(K + 'textPh')}
                  maxLength={140}
                  dir="auto"
                  disabled={!!run}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if ((p.notes.text[c.name] ?? '') !== v) void p.saveNotes((n) => void (v ? (n.text[c.name] = v) : delete n.text[c.name]));
                  }}
                />
                {hooksTool && (
                  <button type="button" className="btn small" onClick={() => void askIdeas(c.name)} disabled={!!run}>
                    ✨ {t(K + 'ideas', { n: hooksTool.credits })}
                  </button>
                )}
                {ideasFor === c.name && (
                  <div className="mx-ideas">
                    {!ideas ? (
                      <small>{t(K + 'thinking')}</small>
                    ) : (
                      ideas.map((x, k) => (
                        <button
                          type="button"
                          key={k}
                          className="mx-idea"
                          dir="auto"
                          onClick={async () => {
                            await p.saveNotes((n) => void (n.text[c.name] = x));
                            setIdeasFor(null);
                          }}
                        >
                          {x}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card mx-sec">
        <div className="mx-h">
          <h2>{t(K + 'which', { n: pairs.length, total })}</h2>
          <div className="mx-row">
            <button type="button" className="btn small" onClick={() => setAll(false)} disabled={!!run}>
              {t(K + 'good', { n: Math.min(10, total) })}
            </button>
            <button type="button" className="btn small" onClick={() => setAll(true)} disabled={!!run}>
              {t(K + 'all', { n: total })}
            </button>
          </div>
        </div>
        <div className="mx-pairs">
          {p.hooks.map((_, h) =>
            p.bodies.map((__, b) => {
              const k = `${h}:${b}`;
              return (
                <label key={k} className={`mx-pair${pick.has(k) ? ' on' : ''}`}>
                  <input type="checkbox" checked={pick.has(k)} onChange={() => toggle(k)} disabled={!!run} />
                  <span className="ltr">{label(h, b)}</span>
                </label>
              );
            }),
          )}
        </div>
      </section>

      <div className="cr-total mx-go" role="status">
        <div className="cr-total-txt">
          <b>{t(K + 'cost', { n: cost })}</b>
          <span>{left < 0 ? t(K + 'unlimited') : t(K + 'left', { n: left })}</span>
          {short && <span className="cr-warn">{t(K + 'short')}</span>}
        </div>
        {run ? (
          <div className="mx-run">
            <span>{run.step === 'words' ? t(K + 'listening', { n: run.n, total: run.total }) : t(K + 'making', { n: run.n, total: run.total, pct: Math.round(run.share * 100) })}</span>
            <i>
              <b style={{ width: `${Math.round(run.share * 100)}%` }} />
            </i>
            <button type="button" className="btn small" onClick={() => (stop.current = true)}>
              {t(K + 'stop')}
            </button>
          </div>
        ) : (
          <button type="button" className="btn primary big" disabled={!pairs.length || short} onClick={() => void start()}>
            {t(K + 'go', { count: pairs.length })}
          </button>
        )}
      </div>
      <p className="small muted">{t(K + 'keepOpen')}</p>
    </div>
  );
}
