// « Espace créateur » (AI Pilot, under Pilot Content), step 1 « Mes morceaux »: the small video pieces of each product —
// Hooks (the start) and Corps (the rest, ending with « commandez ») — then 2. Mélanger (the ads made on this computer),
// 3. Mes pubs, 4. Publier (Facebook / Instagram through Pilot Content). The AI tools take credits (./Credits.tsx).
// Nothing is sent to the server: the videos stay in a folder of the user's computer (./folder.ts), their pictures and
// lengths are read in this browser (./probe.ts). Chrome or Edge on a computer only (the File System Access API).
import { DragEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../lib/session';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { Empty, ErrorBox, Help, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import {
  AdFile,
  askPermission,
  Clip,
  copyInto,
  ensureKindFolders,
  folderApiOn,
  hasPermission,
  isVideoName,
  Kind,
  KINDS,
  listAds,
  listClips,
  lostAccess,
  Notes,
  pickFolder,
  pickVideos,
  productFolder,
  readNotes,
  removeClip,
  saveFolder,
  savedFolder,
  writeNotes,
} from './folder';
import { AdsTab, PublishTab } from './Ads';
import { BuyCredits, CreditPill } from './Credits';
import { MixTab } from './MixTab';
import { Studio } from './Studio';
import { ClipInfo, clipInfo, clipInfoNow, resolutionTag } from './probe';
import '../ai/ai.css';
import './createur.css';

const K = 'createur.';
/** the length each piece should have (a soft hint, never a block) */
const RANGE: Record<Kind, [number, number]> = { hooks: [2, 4], corps: [10, 30] };
const LETTER: Record<Kind, string> = { hooks: 'H', corps: 'B' };
const ICON: Record<Kind, string> = { hooks: 'zap', corps: 'film' };
const TABS = ['pieces', 'mix', 'ads', 'publish'] as const;
type Tab = (typeof TABS)[number];

type Stage = { s: 'loading' } | { s: 'none' } | { s: 'reopen'; dir: FileSystemDirectoryHandle } | { s: 'ready'; dir: FileSystemDirectoryHandle };

export function Createur({ sub }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const boutique = String(session?.shop?.id ?? 0);
  const on = useMemo(folderApiOn, []);
  const [stage, setStage] = useState<Stage>({ s: 'loading' });

  useEffect(() => {
    if (!on) return;
    let live = true;
    (async () => {
      const dir = await savedFolder(boutique);
      if (!live) return;
      if (!dir) return setStage({ s: 'none' });
      setStage((await hasPermission(dir)) ? { s: 'ready', dir } : { s: 'reopen', dir });
    })();
    return () => {
      live = false;
    };
  }, [boutique, on]);

  const choose = async () => {
    try {
      const dir = await pickFolder();
      if (!dir) return;
      await saveFolder(boutique, dir);
      setStage({ s: 'ready', dir });
    } catch {
      toast(t(K + 'pickFail'), 'bad');
    }
  };
  const reopen = async (dir: FileSystemDirectoryHandle) => {
    if (await askPermission(dir)) setStage({ s: 'ready', dir });
    else toast(t(K + 'denied'), 'bad');
  };
  const lost = useCallback(
    (e: unknown, dir: FileSystemDirectoryHandle) => {
      if ((e as DOMException)?.name === 'NotFoundError') {
        toast(t(K + 'lost'), 'bad');
        void saveFolder(boutique, null);
        setStage({ s: 'none' });
      } else setStage({ s: 'reopen', dir });
    },
    [boutique, t],
  );

  const studio = sub === 'studio';
  const ready = studio ? null : stage.s === 'ready' ? stage.dir : null;
  return (
    <div className="cr">
      <header className="ai-head ai-sec cr-head">
        <div className="ai-id">
          <span className="ai-face" aria-hidden="true">
            <Icon name="film" />
          </span>
          <div className="ai-name">
            <h1>
              {t(K + 'title')}
              <Help text={t(K + 'help')} label={t(K + 'title')} />
            </h1>
            <p>{studio ? t('studio.about') : t(K + 'about')}</p>
          </div>
          {ready && (
            <div className="cr-folder">
              {ready.name && (
                <span className="cr-folder-name" title={t(K + 'folderTitle')}>
                  <Icon name="folder" />
                  <bdi>{ready.name}</bdi>
                </span>
              )}
              <button type="button" className="btn small" onClick={choose}>
                {t(K + 'change')}
              </button>
            </div>
          )}
        </div>
      </header>

      <nav className="cr-mode" aria-label={t(K + 'mode.label')}>
        <a href="#/createur" className={studio ? '' : 'on'} aria-current={studio ? undefined : 'page'}>
          <Icon name="film" /> {t(K + 'mode.videos')}
        </a>
        <a href="#/createur/studio" className={studio ? 'on' : ''} aria-current={studio ? 'page' : undefined}>
          <Icon name="image" /> {t(K + 'mode.studio')}
        </a>
      </nav>

      {studio ? (
        <Studio />
      ) : !on ? (
        <Notice icon="alert" title={t(K + 'unsupported')} text={t(K + 'unsupportedHelp')} />
      ) : stage.s === 'loading' ? (
        <Loading />
      ) : stage.s === 'none' ? (
        <Notice icon="folder" title={t(K + 'intro.title')} text={t(K + 'intro.text')}>
          <button type="button" className="btn primary big" onClick={choose}>
            {t(K + 'choose')}
          </button>
        </Notice>
      ) : stage.s === 'reopen' ? (
        <Notice icon="lock" title={t(K + 'reopenTitle')} text={t(K + 'reopenText', { name: stage.dir.name })}>
          <div className="cr-row">
            <button type="button" className="btn primary big" onClick={() => reopen(stage.dir)}>
              {t(K + 'reopen')}
            </button>
            <button type="button" className="btn" onClick={choose}>
              {t(K + 'other')}
            </button>
          </div>
        </Notice>
      ) : (
        <Workspace key={boutique} root={stage.dir} boutique={boutique} onLost={(e) => lost(e, stage.dir)} />
      )}
    </div>
  );
}

function Notice({ icon, title, text, children }: { icon: string; title: string; text: string; children?: ReactNode }) {
  return (
    <section className="card cr-notice">
      <span className="cr-notice-ic" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- the product's folders
type Clips = Record<Kind, Clip[]>;
type Copying = { kind: Kind; n: number; total: number; share: number };

function Workspace({ root, boutique, onLost }: { root: FileSystemDirectoryHandle; boutique: string; onLost: (e: unknown) => void }) {
  const { t } = useTranslation();
  // the products Pilot Content offers (same people, same plan switch): the boutique's active products
  const day = useMemo(() => new Date(new Date().setHours(0, 0, 0, 0)).toISOString(), []);
  const q = useRpc('cm.plan.list', { from: day, to: day }, { staleTime: 5 * 60_000 });
  const products = q.data?.products ?? [];
  const pKey = `createur.product.${boutique}`;
  const [pid, setPid] = useState<number | null>(() => Number(store.get(pKey)) || null);
  const product = products.find((p) => p.id === pid) ?? products[0] ?? null;
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [clips, setClips] = useState<Clips | null>(null);
  const [copying, setCopying] = useState<Copying | null>(null);
  const [ask, setAsk] = useState<Clip | null>(null);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [ads, setAds] = useState<AdFile[]>([]);
  const [tab, setTab] = useState<Tab>('pieces');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [buying, setBuying] = useState(false);
  const cs = useRpc('createur.state', {}, { staleTime: 30_000 });
  const lostRef = useRef(onLost);
  const notesRef = useRef<Notes | null>(null);
  notesRef.current = notes;
  lostRef.current = onLost;

  // the product's folder (made when needed), then its videos
  useEffect(() => {
    setDir(null);
    setClips(null);
    setNotes(null);
    setAds([]);
    setPicked(new Set());
    if (!product) return;
    let live = true;
    (async () => {
      try {
        const d = await productFolder(root, product.name, product.id, true);
        if (!d || !live) return;
        await ensureKindFolders(d);
        const c = await listClips(d);
        const nt = await readNotes(d);
        const a = await listAds(d);
        if (!live) return;
        setDir(d);
        setClips(c);
        setNotes(nt);
        setAds(a);
      } catch (e) {
        if (live) lostRef.current(e);
      }
    })();
    return () => {
      live = false;
    };
  }, [root, product?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!dir) return;
    try {
      setClips(await listClips(dir));
      setAds(await listAds(dir));
    } catch (e) {
      lostRef.current(e);
    }
  }, [dir]);

  // videos put in the folders by hand (Windows Explorer): read again when the user comes back to the page
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && !copying && void refresh();
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [refresh, copying]);

  // a copy is running: leaving the page would cut the video
  useEffect(() => {
    if (!copying) return;
    const stay = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [copying]);

  const add = async (kind: Kind, files: File[]) => {
    if (!dir || copying) return;
    const videos = files.filter((f) => isVideoName(f.name));
    const other = files.find((f) => !isVideoName(f.name));
    if (other) toast(t(K + 'notVideo', { name: other.name }), 'bad');
    if (!videos.length) return;
    let copied = 0;
    let same = 0;
    try {
      for (let i = 0; i < videos.length; i++) {
        const f = videos[i];
        let last = 0;
        setCopying({ kind, n: i + 1, total: videos.length, share: 0 });
        const r = await copyInto(dir, kind, f, (bytes) => {
          const now = performance.now();
          if (now - last < 150) return;
          last = now;
          setCopying({ kind, n: i + 1, total: videos.length, share: f.size ? bytes / f.size : 1 });
        });
        if (r === 'copied') copied++;
        else if (r === 'same') same++;
        else toast(t(K + 'copyFail', { name: f.name }), 'bad');
      }
    } catch (e) {
      if (lostAccess(e)) return lostRef.current(e);
      toast(t(K + 'copyStop'), 'bad');
    } finally {
      setCopying(null);
      await refresh();
    }
    if (copied) toast(t(K + 'copied', { count: copied }), 'ok');
    if (same) toast(t(K + 'same', { count: same }), 'info');
  };

  const pick = async (kind: Kind) => {
    try {
      const files = await pickVideos();
      if (files.length) await add(kind, files);
    } catch {
      toast(t(K + 'pickFail'), 'bad');
    }
  };

  const remove = async (c: Clip) => {
    setAsk(null);
    if (!dir) return;
    try {
      await removeClip(dir, c.kind, c.name);
      toast(t(K + 'deleted'), 'ok');
    } catch (e) {
      if (lostAccess(e) && (e as DOMException).name !== 'NotFoundError') return lostRef.current(e);
      toast(t(K + 'deleteFail'), 'bad');
    }
    await refresh();
  };

  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  if (!products.length) return <Empty>{t(K + 'noProducts')}</Empty>;

  const n = { hooks: clips?.hooks.length ?? 0, corps: clips?.corps.length ?? 0 };
  const total = n.hooks * n.corps;
  // pilotix.json, next to the videos: changed and written back at once
  const saveNotes = async (f: (x: Notes) => void): Promise<Notes> => {
    const next = structuredClone(notesRef.current ?? { text: {}, words: {}, ads: {} });
    f(next);
    notesRef.current = next;
    setNotes(next);
    if (dir) await writeNotes(dir, next).catch(() => toast(t(K + 'notesFail'), 'bad'));
    return next;
  };
  const st = cs.data;
  const pickedAds = ads.filter((a) => picked.has(a.name));
  const missing = KINDS.filter((k) => !n[k]);

  return (
    <>
      <section className="card cr-bar">
        <label className="cr-pick">
          <span>{t(K + 'product')}</span>
          <select
            value={product?.id ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPid(v);
              store.set(pKey, String(v));
            }}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="cr-where muted small">
          <Icon name="lock" />
          {t(K + 'private')}
        </p>
        {st && <CreditPill s={st} onBuy={() => setBuying(true)} />}
        <button type="button" className="btn small" onClick={() => void refresh()} disabled={!dir || !!copying}>
          <Icon name="refresh" />
          {t(K + 'refresh')}
        </button>
      </section>

      <nav className="cr-tabs" role="tablist">
        {TABS.map((x, k) => (
          <button type="button" role="tab" key={x} aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
            <span className="ltr">{k + 1}</span> {t(K + `tabs.${x}`)}
            {x === 'ads' && ads.length > 0 && <span className="badge ltr">{ads.length}</span>}
          </button>
        ))}
      </nav>

      {tab === 'mix' && dir && clips && notes && st && product ? (
        <MixTab
          dir={dir}
          hooks={clips.hooks}
          bodies={clips.corps}
          notes={notes}
          saveNotes={saveNotes}
          st={st}
          product={product}
          onCredits={() => void cs.refetch()}
          onDone={() => (void refresh(), setTab('ads'))}
        />
      ) : tab === 'ads' && dir && notes ? (
        <AdsTab dir={dir} ads={ads} notes={notes} picked={picked} setPicked={setPicked} onChange={() => void refresh()} onPublish={() => setTab('publish')} />
      ) : tab === 'publish' && notes && st && product && q.data ? (
        <PublishTab
          key={[...picked].join('|')}
          ads={pickedAds}
          notes={notes}
          saveNotes={saveNotes}
          st={st}
          lists={q.data}
          product={product}
          onCredits={() => void cs.refetch()}
          onDone={() => setPicked(new Set())}
        />
      ) : tab !== 'pieces' ? (
        cs.error ? (
          <ErrorBox error={cs.error} onRetry={() => cs.refetch()} />
        ) : (
          <Loading />
        )
      ) : !clips ? (
        <Loading />
      ) : (
        <>
          <div className="cr-cols">
            {KINDS.map((k) => (
              <Column key={k} kind={k} clips={clips[k]} copying={copying?.kind === k ? copying : null} busy={!!copying} onPick={() => pick(k)} onDrop={(f) => add(k, f)} onDelete={setAsk} />
            ))}
          </div>

          <div className="cr-total" role="status">
            <div className="cr-total-txt">
              <b>
                {t(K + 'formula', { h: n.hooks, b: n.corps })} {t(K + 'ads', { count: total })}
              </b>
              {missing.length > 0 && clips && <span>{t(K + 'missing', { list: missing.map((k) => t(K + `need.${k}`)).join(t(K + 'and')) })}</span>}
            </div>
            <div className="cr-mix">
              <button type="button" className="btn primary" disabled={!total} onClick={() => setTab('mix')}>
                {t(K + 'mix')}
              </button>
            </div>
          </div>
        </>
      )}
      {buying && st && <BuyCredits s={st} onClose={() => (setBuying(false), void cs.refetch())} />}

      {ask && (
        <Modal
          title={t(K + 'del.title')}
          onClose={() => setAsk(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsk(null)}>
                {t(K + 'del.no')}
              </button>
              <button type="button" className="btn danger" onClick={() => remove(ask)}>
                {t(K + 'del.yes')}
              </button>
            </>
          }
        >
          <p>{t(K + 'del.text', { name: ask.name, folder: ask.kind })}</p>
        </Modal>
      )}
    </>
  );
}

function Column({
  kind,
  clips,
  copying,
  busy,
  onPick,
  onDrop,
  onDelete,
}: {
  kind: Kind;
  clips: Clip[];
  copying: Copying | null;
  busy: boolean;
  onPick: () => void;
  onDrop: (files: File[]) => void;
  onDelete: (c: Clip) => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return (
    <section
      className={`card cr-col cr-${kind}${over ? ' cr-over' : ''}`}
      onDragEnter={(e) => {
        if (!hasFiles(e) || busy) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || busy) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (busy) return;
        onDrop(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="cr-col-head">
        <span className="cr-col-ic" aria-hidden="true">
          <Icon name={ICON[kind]} />
        </span>
        <div className="cr-col-t">
          <h2>
            {t(K + `kinds.${kind}.title`)} <span className="badge cr-count ltr">{clips.length}</span>
          </h2>
          <small>{t(K + `kinds.${kind}.sub`)}</small>
        </div>
        <button type="button" className="btn small primary" onClick={onPick} disabled={busy}>
          {t(K + 'add')}
        </button>
      </div>
      <p className="cr-hint">{t(K + `kinds.${kind}.hint`)}</p>
      {copying && (
        <div className="cr-copy" role="status">
          <span>{t(K + 'copying', { n: copying.n, total: copying.total })}</span>
          <i>
            <b style={{ width: `${Math.round(copying.share * 100)}%` }} />
          </i>
        </div>
      )}
      {clips.length ? (
        <ul className="cr-grid">
          {clips.map((c, i) => (
            <Thumb key={c.key} clip={c} label={`${LETTER[kind]}${i + 1}`} onDelete={() => onDelete(c)} busy={busy} />
          ))}
        </ul>
      ) : (
        <div className="cr-empty">
          <Icon name="upload" />
          <span>{t(K + 'empty')}</span>
        </div>
      )}
      {over && <div className="cr-drop">{t(K + 'drop')}</div>}
    </section>
  );
}

function Thumb({ clip, label, onDelete, busy }: { clip: Clip; label: string; onDelete: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<ClipInfo | null | undefined>(() => clipInfoNow(clip.key));
  useEffect(() => {
    if (info !== undefined) return;
    let live = true;
    clipInfo(clip.key, clip.file).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [clip.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [min, max] = RANGE[clip.kind];
  const d = info ? Math.round(info.duration * 10) / 10 : 0;
  const warn = info && d ? (d < min ? 'short' : d > max ? 'long' : null) : null;
  const res = info ? resolutionTag(info.w, info.h) : '';
  return (
    <li className="cr-th" title={clip.name}>
      <div className="cr-th-img">
        {info?.thumb ? <img src={info.thumb} alt="" loading="lazy" /> : <span className="cr-th-ph">{info === undefined ? t(K + 'reading') : <Icon name="film" />}</span>}
        {res && <span className="cr-res ltr">{res}</span>}
        <button type="button" className="cr-x" aria-label={t(K + 'delete', { name: clip.name })} onClick={onDelete} disabled={busy}>
          <Icon name="x" />
        </button>
      </div>
      <span className="cr-th-l ltr">
        {label}
        {d ? ` · ${Math.max(1, Math.round(d))} s` : ''}
      </span>
      {warn && <span className="cr-warn">{t(K + (warn === 'short' ? 'tooShort' : 'tooLong'), { min, max })}</span>}
      {info === null && <span className="cr-warn">{t(K + 'unreadable')}</span>}
    </li>
  );
}
