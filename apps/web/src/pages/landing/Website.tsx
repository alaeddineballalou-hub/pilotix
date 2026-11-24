// Landing pages › Site web: the boutique's own site (its home page made of parts), made on a phone first. The tab shows
// the site and where it is; #/landing/site/edit opens the editor over the whole screen: the page is drawn by the very
// function the server uses (renderSite), the shop taps a part of it and changes that part in the card beside it (a sheet
// under it on a phone). What the shop types is saved as it goes; customers see it only after « Publier ».
// #/landing/site/design: the designs to start from (or to start again from).
import {
  newSiteBlock,
  renderSite,
  SITE_BLOCK_TYPES,
  SITE_CORNER_KEYS,
  SITE_FONT_KEYS,
  SITE_LANGS,
  SITE_LIMITS,
  SITE_PALETTE_KEYS,
  SITE_PALETTES,
  SITE_TRUST_ICONS,
  siteFromDesign,
  siteMissing,
  siteSampleSessions,
  siteText,
  SiteBlock,
  SiteBlockType,
  SiteDoc,
  SiteLang,
  SiteText,
  SiteTrustIcon,
} from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { da, when } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { LandingPreview } from './Preview';
import './website.css';

type Data = Out<'site.get'>;
type Panel = 'add' | 'sections' | 'theme' | 'products' | 'settings' | 'block';
const RAIL: [Exclude<Panel, 'block'>, string][] = [
  ['add', 'plus'],
  ['sections', 'layers'],
  ['theme', 'pipette'],
  ['products', 'package'],
  ['settings', 'settings'],
];
const DESKTOP_W = 1280;
const ICON_OF: Record<SiteBlockType, string> = { header: 'menu', hero: 'image', sessions: 'calendar', trust: 'checkcircle', best: 'trophy', products: 'grid', why: 'medal', faq: 'help', whatsapp: 'whatsapp', footer: 'layers' };
const SITE = '#/landing/site';
const newId = (taken: Set<string>) => {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (/^[a-z0-9]{6}$/.test(id) && !taken.has(id)) return id;
  }
};
const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

function useMedia(q: string) {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}

/** mode: the tab (home), the editor (edit), the designs (design) */
export function Website({ mode }: { mode: 'home' | 'edit' | 'design' }) {
  const q = useRpc('site.get', {}, { refetchOnMount: 'always' });
  const qc = useQueryClient();
  if (q.error && !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  // the editor starts from what is saved now, never from an older copy kept on screen
  if (!q.data || (mode !== 'home' && !q.isFetchedAfterMount)) return <Loading />;
  const d = q.data;
  if (!d.draft || mode === 'design')
    return (
      <DesignPicker
        data={d}
        standalone={mode !== 'home'}
        onDone={async () => {
          await qc.invalidateQueries({ queryKey: ['site.get'] });
          location.hash = `${SITE}/edit`;
        }}
      />
    );
  if (mode === 'edit') return <SiteEditor data={d} draft={d.draft} />;
  return <SiteHome data={d} />;
}

// ---------------------------------------------------------------- a page drawn small (it keeps its own width)
function Scaled({ html, title, w = 390, h = 720 }: { html: string; title: string; w?: number; h?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [s, setS] = useState(0.5);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientWidth && setS(el.clientWidth / w));
    ro.observe(el);
    return () => ro.disconnect();
  }, [w]);
  return (
    <div ref={box} className="ws-scaled" style={{ height: Math.round(h * s), ['--s' as string]: s, ['--w' as string]: `${w}px`, ['--h' as string]: `${h}px` }}>
      <LandingPreview frame={frame} title={title} html={html} />
    </div>
  );
}

// ---------------------------------------------------------------- the tab: the site, where it is, what waits
function SiteHome({ data }: { data: Data }) {
  const { t } = useTranslation();
  const doc = data.draft!;
  const html = useMemo(() => renderSite({ doc, lang: doc.langs[0], ...data.view }, { mode: 'live', base: '#' }), [doc, data.view]);
  const live = data.live;
  const design = data.designs.find((x) => x.key === doc.design);
  return (
    <div className="ws-home">
      <section className="card ws-home-card">
        <span className={`ws-pill ${live ? (live.same ? 'ok' : 'warn') : ''}`}>{live ? (live.same ? t('site.home.live') : t('site.home.waiting')) : t('site.home.notLive')}</span>
        <h2>{t('site.home.title')}</h2>
        <p className="muted">{live ? (live.same ? t('site.home.liveHelp', { when: when(live.at) }) : t('site.home.waitingHelp')) : t('site.home.notLiveHelp')}</p>
        <dl className="ws-facts">
          <div>
            <dt>{t('site.home.address')}</dt>
            <dd>
              {data.url ? (
                <a className="ltr" href={data.url} target="_blank" rel="noreferrer">
                  {host(data.url)}
                </a>
              ) : (
                <span className="muted">{t('site.home.noAddress')}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('site.home.design')}</dt>
            <dd>{design?.name ?? doc.design}</dd>
          </div>
          <div>
            <dt>{t('site.home.langs')}</dt>
            <dd>{doc.langs.map((l) => t(`site.lang.${l}`)).join(' · ')}</dd>
          </div>
          <div>
            <dt>{t('site.home.products')}</dt>
            <dd>{data.view.products.length}</dd>
          </div>
          <div>
            <dt>{t('site.home.saved')}</dt>
            <dd>{when(data.savedAt)}</dd>
          </div>
        </dl>
        {!data.url && <p className="hint">{t('site.set.addressNone')}</p>}
        <div className="ws-home-a">
          <a className="btn primary" href={`${SITE}/edit`}>
            <Icon name="pencil" /> {t('site.home.edit')}
          </a>
          {live && data.url && (
            <a className="btn" href={data.url} target="_blank" rel="noreferrer">
              <Icon name="external" /> {t('site.bar.open')}
            </a>
          )}
          <a className="btn ghost" href={`${SITE}/design`}>
            <Icon name="refresh" /> {t('site.theme.change')}
          </a>
        </div>
      </section>
      <div className="ws-home-pv">
        <Scaled html={html} title={t('site.preview')} h={880} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the designs
function DesignPicker({ data, standalone, onDone }: { data: Data; standalone: boolean; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const replace = !!data.draft;
  const [langs, setLangs] = useState<SiteLang[]>(data.draft?.langs?.length ? data.draft.langs : ['ar', 'fr']);
  const [pick, setPick] = useState<string>(data.draft?.design ?? data.designs[0]?.key ?? 'candy');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [niche, setNiche] = useState<string | null>(null);
  // a training design shows three sample sessions while the boutique has none of its own (the picker only)
  const view = useMemo(() => (data.view.sessions?.length ? data.view : { ...data.view, sessions: siteSampleSessions(Date.now(), langs[0]) }), [data.view, langs]);
  const html = useMemo(
    () => Object.fromEntries(data.designs.map((d) => [d.key, renderSite({ doc: siteFromDesign(d.key, langs), lang: langs[0], ...view }, { mode: 'live', base: '#' })])),
    [data.designs, view, langs],
  );
  const flip = (l: SiteLang) => setLangs((ls) => (ls.includes(l) ? (ls.length > 1 ? ls.filter((x) => x !== l) : ls) : [...ls, l]));
  const back = () => (history.length > 1 ? history.back() : (location.hash = SITE));
  const start = async () => {
    if (replace && !sure) return setSure(true);
    setBusy(true);
    try {
      await rpc('site.start', { design: pick, langs, replace });
      await onDone();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const niches = [...new Set(data.designs.map((d) => d.niche))];
  return (
    <div className={`ws-pickp ${standalone ? 'alone' : ''}`}>
      {standalone && (
        <div className="ws-pick-top">
          <button type="button" className="btn ghost" onClick={back}>
            <Icon name="chevl" className="ws-flip" /> {t('site.pick.back')}
          </button>
        </div>
      )}
      <section className="card ws-pick">
        <div>
          <h2>{replace ? t('site.pick.titleAgain') : t('site.pick.title')}</h2>
          <p className="muted">{replace ? t('site.pick.helpAgain') : t('site.pick.help')}</p>
        </div>
        <div className="ws-pick-row" role="group" aria-label={t('site.pick.langs')}>
          <span className="lab">{t('site.pick.langs')}</span>
          {SITE_LANGS.map((l) => (
            <label key={l} className={`ws-chip ${langs.includes(l) ? 'on' : ''}`}>
              <input type="checkbox" checked={langs.includes(l)} onChange={() => flip(l)} />
              <span lang={l}>{t(`site.lang.${l}`)}</span>
              {langs[0] === l && langs.length > 1 && <em>{t('site.pick.main')}</em>}
            </label>
          ))}
        </div>
        <div className="ws-pick-row">
          <span className="lab">{t('site.pick.niche')}</span>
          {niches.length > 1 && (
            <button type="button" className={`ws-chip ${niche === null ? 'on' : ''}`} aria-pressed={niche === null} onClick={() => setNiche(null)}>
              {t('site.pick.allNiches')} <b>{data.designs.length}</b>
            </button>
          )}
          {niches.map((n) => (
            <button key={n} type="button" className={`ws-chip ${niche === n || niches.length === 1 ? 'on' : ''}`} aria-pressed={niche === n} onClick={() => setNiche(niche === n ? null : n)}>
              {t(`site.niche.${n}`, { defaultValue: n })} <b>{data.designs.filter((d) => d.niche === n).length}</b>
            </button>
          ))}
          <span className="hint">{t('site.pick.more')}</span>
        </div>
        <div className="ws-designs" role="radiogroup" aria-label={t('site.pick.title')}>
          {data.designs
            .filter((d) => !niche || d.niche === niche)
            .map((d) => (
            <label key={d.key} className={`ws-design ${pick === d.key ? 'on' : ''}`}>
              <Scaled html={html[d.key]} title={d.name} />
              <span className="ws-design-n">
                <input type="radio" name="ws-design" checked={pick === d.key} onChange={() => setPick(d.key)} />
                <b>{d.name}</b>
                <span className="ws-dots" aria-hidden="true">
                  {(['accent', 'soft', 'ink'] as const).map((k) => (
                    <i key={k} style={{ background: SITE_PALETTES[d.theme.palette][k] }} />
                  ))}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="ws-pick-foot">
          {sure && <span className="ws-warn">{t('site.pick.replaceAsk')}</span>}
          {sure && (
            <button type="button" className="btn ghost" onClick={() => setSure(false)}>
              {t('site.cancel')}
            </button>
          )}
          <button type="button" className="btn primary" disabled={busy} onClick={start}>
            {sure ? t('site.pick.replaceYes') : t('site.pick.use')}
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- the editor (over the whole screen)
function SiteEditor({ data, draft }: { data: Data; draft: SiteDoc }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const wide = useMedia('(min-width: 1024px)');
  const narrow = useMedia('(max-width: 760px)');
  const [doc, setDoc] = useState<SiteDoc>(draft);
  const [lang, setLang] = useState<SiteLang>(draft.langs[0]);
  const [sel, setSel] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('sections');
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<'phone' | 'desktop'>('phone');
  const device = narrow ? 'phone' : screen;
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [live, setLive] = useState(data.live);
  const [changed, setChanged] = useState(!data.live?.same);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  // the page under the editor stays still
  useEffect(() => {
    document.documentElement.classList.add('ws-lock');
    return () => document.documentElement.classList.remove('ws-lock');
  }, []);

  // ---- changes, and « Annuler » (a burst of typing is one step)
  const latest = useRef(doc);
  const past = useRef<SiteDoc[]>([]);
  const lastStep = useRef(0);
  const [steps, setSteps] = useState(0);
  const change = (fn: (d: SiteDoc) => SiteDoc) => {
    const d = latest.current;
    const n = fn(d);
    if (n === d) return;
    const now = Date.now();
    if (now - lastStep.current > 900) {
      past.current = [...past.current.slice(-59), d];
      setSteps(past.current.length);
    }
    lastStep.current = now;
    latest.current = n;
    setDoc(n);
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    setSteps(past.current.length);
    lastStep.current = 0;
    latest.current = prev;
    setDoc(prev);
  };

  // ---- saving: a pause in the typing saves; leaving the editor saves what still waits
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the copy last seen here: the first one (and React's second look at it) is the saved one, nothing to save
  const known = useRef(draft);
  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState('saving');
    try {
      await rpc('site.save', { doc: latest.current });
      setState('saved');
    } catch (e) {
      setState('error');
      toast((e as Error).message, 'bad');
      throw e;
    }
  }, []);
  useEffect(() => {
    latest.current = doc;
    if (doc === known.current) return;
    known.current = doc;
    setChanged(true);
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save().catch(() => undefined), 800);
  }, [doc, save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (timer.current) e.preventDefault();
    };
    addEventListener('beforeunload', warn);
    return () => {
      removeEventListener('beforeunload', warn);
      const left = timer.current;
      if (left) clearTimeout(left);
      (left ? rpc('site.save', { doc: latest.current }) : Promise.resolve())
        .catch(() => undefined)
        .finally(() => qc.invalidateQueries({ queryKey: ['site.get'] }));
    };
  }, [qc]);

  // ---- the page: drawn a moment after the typing stops, where it was scrolled
  const [shown, setShown] = useState(doc);
  useEffect(() => {
    const tm = setTimeout(() => setShown(doc), 300);
    return () => clearTimeout(tm);
  }, [doc]);
  const scrollY = useRef(0);
  const hints = useMemo(
    () => ({ noProducts: t('site.hints.noProducts'), noWhatsapp: t('site.hints.noWhatsapp'), hidden: t('site.hints.hidden'), noSessions: t(data.view.rdv ? 'site.hints.noSessions' : 'site.hints.rdvOff') }),
    [t, data.view.rdv],
  );
  const html = useMemo(
    () => renderSite({ doc: shown, lang, ...data.view }, { mode: 'edit', base: '#', selected: sel, hints, scrollY: scrollY.current }),
    [shown, lang, sel, data.view, hints],
  );

  // ---- a tap on the page chooses that part; the page says where it is scrolled
  const ids = useRef(new Set<string>());
  ids.current = new Set(doc.home.map((b) => b.id));
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (!m || typeof m !== 'object' || m.lp !== 'site' || e.source !== frame.current?.contentWindow) return;
      if (typeof m.y === 'number' && Number.isFinite(m.y)) {
        scrollY.current = Math.max(0, m.y);
        return;
      }
      const id = String(m.tap ?? '');
      if (!ids.current.has(id)) return;
      setSel(id);
      setPanel('block');
      setOpen(true);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);

  // ---- the computer's width, made small enough to fit
  const view = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDim({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = dim.w ? Math.min(1, dim.w / DESKTOP_W) : 0.5;

  // ---- the parts of the page
  const setBlock = (id: string, patch: Partial<SiteBlock>) => change((d) => ({ ...d, home: d.home.map((b) => (b.id === id ? ({ ...b, ...patch } as SiteBlock) : b)) }));
  const move = (id: string, by: -1 | 1) =>
    change((d) => {
      const k = d.home.findIndex((b) => b.id === id);
      const j = k + by;
      if (k < 0 || j < 0 || j >= d.home.length) return d;
      const home = [...d.home];
      [home[k], home[j]] = [home[j], home[k]];
      return { ...d, home };
    });
  const full = () => doc.home.length >= SITE_LIMITS.blocks && (toast(t('site.add.max', { n: SITE_LIMITS.blocks }), 'bad'), true);
  const insert = (b: SiteBlock, after: string | null) => {
    change((d) => {
      const at = after ? d.home.findIndex((x) => x.id === after) + 1 : d.home.findIndex((x) => x.type === 'footer');
      const home = [...d.home];
      home.splice(at > 0 ? at : home.length, 0, b);
      return { ...d, home };
    });
    setSel(b.id);
    setPanel('block');
    setOpen(true);
  };
  const add = (type: SiteBlockType) => !full() && insert(newSiteBlock(type, newId(ids.current)), sel);
  const duplicate = (b: SiteBlock) => !full() && insert({ ...(JSON.parse(JSON.stringify(b)) as SiteBlock), id: newId(ids.current) }, b.id);
  const remove = (id: string) => {
    change((d) => ({ ...d, home: d.home.filter((b) => b.id !== id) }));
    setSel(null);
    setPanel('sections');
  };
  const block = doc.home.find((b) => b.id === sel) ?? null;
  const missing = useMemo(() => siteMissing(doc), [doc]);

  // ---- the panels
  const show = (p: Panel) => {
    if (p !== 'block' && !wide && open && (panel === p || (p === 'sections' && panel === 'block'))) return setOpen(false);
    setPanel(p);
    setOpen(true);
    if (p !== 'block') setSel(null);
  };
  const close = () => {
    setOpen(false);
    if (panel === 'block') {
      setSel(null);
      setPanel('sections');
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return el.blur();
      setOpen(false);
      setSel(null);
      setPanel('sections');
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  const publish = async () => {
    setBusy(true);
    try {
      if (timer.current || state !== 'saved') await save();
      const r = await rpc('site.publish', {});
      setLive({ at: r.at, same: true });
      setChanged(false);
      toast(r.url ? t('site.bar.publishedAt', { url: host(r.url) }) : t('site.bar.published'), 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const offline = async () => {
    setBusy(true);
    try {
      await rpc('site.unpublish', {});
      setLive(null);
      setChanged(true);
      toast(t('site.set.offlined'), 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const upToDate = !!live && !changed && state === 'saved';
  const status =
    state === 'saving' ? t('site.bar.saving') : state === 'error' ? t('site.bar.error') : !live ? t('site.bar.notLive') : changed ? t('site.bar.waiting') : t('site.bar.live');
  const cur: Panel = panel === 'block' ? 'sections' : panel;
  const shop = data.view.shop;
  const multi = doc.langs.length > 1;

  return (
    <div className={`ws-full ${open ? 'open' : ''} ${device}`}>
      <header className="ws-top">
        <a className="btn icon ghost" href={SITE} aria-label={t('site.bar.back')} title={t('site.bar.back')}>
          <Icon name="chevl" className="ws-flip" />
        </a>
        <span className={`ws-id ${multi ? 'ws-wide' : 'solo'}`}>
          <span className="ws-mark" aria-hidden="true">
            {shop.logo ? <img src={shop.logo} alt="" /> : shop.name.slice(0, 2)}
          </span>
          <span className="ws-id-t">
            <b>{shop.name}</b>
            <small className={state === 'error' ? 'bad' : ''}>
              {data.url && <span className="ltr">{host(data.url)} · </span>}
              {status}
            </small>
          </span>
        </span>
        <span className="ws-sp ws-wide" />
        {multi && (
          <div className="ws-seg ws-lang" role="group" aria-label={t('site.bar.lang')}>
            {doc.langs.map((l) => (
              <button key={l} type="button" className={l === lang ? 'on' : ''} aria-pressed={l === lang} onClick={() => setLang(l)} lang={l}>
                {t(`site.langShort.${l}`)}
                {missing.some((m) => m.lang === l) && <i className="ws-dot" title={t('site.ed.missingIn')} />}
              </button>
            ))}
          </div>
        )}
        <div className="ws-seg ws-wide" role="group" aria-label={t('site.bar.screen')}>
          <button type="button" className={screen === 'phone' ? 'on' : ''} aria-pressed={screen === 'phone'} onClick={() => setScreen('phone')} title={t('site.bar.phone')}>
            <Icon name="smartphone" /> <span className="ws-long">{t('site.bar.phone')}</span>
          </button>
          <button type="button" className={screen === 'desktop' ? 'on' : ''} aria-pressed={screen === 'desktop'} onClick={() => setScreen('desktop')} title={t('site.bar.computer')}>
            <Icon name="columns" /> <span className="ws-long">{t('site.bar.computer')}</span>
          </button>
        </div>
        <span className="ws-sp ws-wide" />
        <button type="button" className="btn icon ghost ws-undo" disabled={!steps} onClick={undo} aria-label={t('site.bar.undo')} title={t('site.bar.undo')}>
          <Icon name="undo" />
        </button>
        {live && data.url && (
          <a className="btn ws-wide" href={data.url} target="_blank" rel="noreferrer" title={t('site.bar.open')}>
            <Icon name="external" /> <span className="ws-long">{t('site.bar.open')}</span>
          </a>
        )}
        <button type="button" className={`btn ${upToDate ? 'ws-done' : 'primary'}`} disabled={busy || upToDate} onClick={publish}>
          {upToDate && <Icon name="check" />}
          {busy ? t('site.bar.publishing') : upToDate ? t('site.bar.isLive') : t('site.bar.publish')}
        </button>
      </header>

      <div className="ws-body">
        <nav className="ws-rail" aria-label={t('site.rail.label')}>
          {RAIL.map(([k, ic]) => (
            <button key={k} type="button" className={`${k === 'add' ? 'add ' : ''}${cur === k && (open || wide) ? 'on' : ''}`} aria-pressed={cur === k && (open || wide)} onClick={() => show(k)}>
              <Icon name={ic} />
              <span>{t(`site.rail.${k}`)}</span>
            </button>
          ))}
        </nav>

        <main className="ws-stage">
          <div ref={view} className="ws-view">
            {device === 'desktop' ? (
              <div className="ws-desk" style={{ ['--s' as string]: scale, ['--dw' as string]: `${DESKTOP_W}px`, ['--vh' as string]: `${dim.h}px` }}>
                <LandingPreview frame={frame} title={t('site.preview')} html={html} />
              </div>
            ) : (
              <div className="ws-phone">
                <LandingPreview frame={frame} title={t('site.preview')} html={html} />
              </div>
            )}
          </div>
          {!sel && <p className="ws-tip ws-wide">{t('site.ed.tip')}</p>}
        </main>

        <aside className="ws-aside" aria-label={t(`site.rail.${cur}`)}>
          {panel === 'block' && block ? (
            <BlockPanel
              key={block.id}
              block={block}
              index={doc.home.indexOf(block)}
              total={doc.home.length}
              doc={doc}
              lang={lang}
              data={data}
              onChange={(p) => setBlock(block.id, p)}
              onMove={(by) => move(block.id, by)}
              onDuplicate={() => duplicate(block)}
              onRemove={() => remove(block.id)}
              onBack={() => show('sections')}
              onDone={close}
            />
          ) : panel === 'add' ? (
            <AddPanel onAdd={add} onClose={close} rdv={!!data.view.rdv} />
          ) : panel === 'theme' ? (
            <ThemePanel doc={doc} onChange={(theme) => change((d) => ({ ...d, theme }))} onClose={close} />
          ) : panel === 'products' ? (
            <ProductsPanel data={data} onClose={close} />
          ) : panel === 'settings' ? (
            <SettingsPanel
              doc={doc}
              data={data}
              live={live}
              busy={busy}
              missing={missing}
              status={status}
              onLangs={(langs) => {
                change((d) => ({ ...d, langs }));
                if (!langs.includes(lang)) setLang(langs[0]);
              }}
              onGo={(id, l) => {
                setLang(l);
                setSel(id);
                setPanel('block');
              }}
              onOffline={offline}
              onClose={close}
            />
          ) : (
            <SectionsPanel
              doc={doc}
              lang={lang}
              onPick={(id) => {
                setSel(id);
                setPanel('block');
                setOpen(true);
              }}
              onClose={close}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- panels
function PanelHead({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="ws-ph">
      <h3>{title}</h3>
      {children}
      <button type="button" className="btn icon ghost small ws-x" onClick={onClose} aria-label={t('site.ed.close')} title={t('site.ed.close')}>
        <Icon name="x" />
      </button>
    </div>
  );
}

const blockLine = (b: SiteBlock, lang: SiteLang, langs: SiteLang[]) =>
  b.type === 'hero' || b.type === 'best' || b.type === 'products' || b.type === 'why' || b.type === 'faq' || b.type === 'sessions'
    ? siteText(b.title, lang, langs)
    : b.type === 'whatsapp' || b.type === 'footer'
      ? siteText(b.text, lang, langs)
      : b.type === 'trust'
        ? b.items.map((x) => siteText(x.text, lang, langs)).join(' · ')
        : '';

function SectionsPanel({ doc, lang, onPick, onClose }: { doc: SiteDoc; lang: SiteLang; onPick: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ws-panel">
      <PanelHead title={t('site.sections.title')} onClose={onClose} />
      <p className="muted ws-note">{t('site.sections.help')}</p>
      <ul className="ws-list">
        {doc.home.map((b) => (
          <li key={b.id}>
            <button type="button" className={b.hidden ? 'off' : ''} onClick={() => onPick(b.id)}>
              <Icon name={ICON_OF[b.type]} />
              <span>
                <b>{t(`site.block.${b.type}`)}</b>
                <small dir="auto">{b.hidden ? t('site.hints.hidden') : blockLine(b, lang, doc.langs) || t(`site.about.${b.type}`)}</small>
              </span>
              <Icon name="chevr" className="ws-flip ws-go" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddPanel({ onAdd, onClose, rdv }: { onAdd: (t: SiteBlockType) => void; onClose: () => void; rdv: boolean }) {
  const { t } = useTranslation();
  // « Sessions » is a service's (Rendez-vous): shown once the boutique has turned Rendez-vous on
  const types = SITE_BLOCK_TYPES.filter((k) => k !== 'sessions' || rdv);
  return (
    <div className="ws-panel">
      <PanelHead title={t('site.add.title')} onClose={onClose} />
      <p className="muted ws-note">{t('site.add.help')}</p>
      <ul className="ws-list">
        {types.map((k) => (
          <li key={k}>
            <button type="button" onClick={() => onAdd(k)}>
              <Icon name={ICON_OF[k]} />
              <span>
                <b>{t(`site.block.${k}`)}</b>
                <small>{t(`site.about.${k}`)}</small>
              </span>
              <Icon name="plus" className="ws-go" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThemePanel({ doc, onChange, onClose }: { doc: SiteDoc; onChange: (th: SiteDoc['theme']) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const th = doc.theme;
  return (
    <div className="ws-panel">
      <PanelHead title={t('site.theme.title')} onClose={onClose} />
      <div className="field">
        <span className="lab">{t('site.theme.colors')}</span>
        <div className="ws-opts">
          {SITE_PALETTE_KEYS.map((k) => (
            <button key={k} type="button" className={`ws-opt ${th.palette === k ? 'on' : ''}`} aria-pressed={th.palette === k} onClick={() => onChange({ ...th, palette: k })}>
              <span className="ws-dots" aria-hidden="true">
                {(['accent', 'soft', 'bg', 'ink'] as const).map((c) => (
                  <i key={c} style={{ background: SITE_PALETTES[k][c] }} />
                ))}
              </span>
              {t(`site.theme.palette.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="lab">{t('site.theme.font')}</span>
        <div className="ws-opts">
          {SITE_FONT_KEYS.map((k) => (
            <button key={k} type="button" className={`ws-opt ${th.font === k ? 'on' : ''}`} aria-pressed={th.font === k} onClick={() => onChange({ ...th, font: k })}>
              {t(`site.theme.fonts.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="lab">{t('site.theme.corners')}</span>
        <div className="ws-seg wide">
          {SITE_CORNER_KEYS.map((k) => (
            <button key={k} type="button" className={th.corners === k ? 'on' : ''} aria-pressed={th.corners === k} onClick={() => onChange({ ...th, corners: k })}>
              {t(`site.theme.corner.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="lab">{t('site.theme.design')}</span>
        <a className="btn" href={`${SITE}/design`}>
          <Icon name="refresh" /> {t('site.theme.change')}
        </a>
        <span className="hint">{t('site.theme.changeHint')}</span>
      </div>
    </div>
  );
}

function ProductsPanel({ data, onClose }: { data: Data; onClose: () => void }) {
  const { t } = useTranslation();
  const rank = new Map(data.view.best.map((id, k) => [id, k + 1]));
  const list = data.view.products;
  return (
    <div className="ws-panel">
      <PanelHead title={t('site.products.title')} onClose={onClose} />
      <p className="muted ws-note">{t('site.products.help')}</p>
      {list.length ? (
        <ul className="ws-prods">
          {list.map((p) => (
            <li key={p.id}>
              <span className="ws-prods-i">{p.img && <img src={p.img.src} alt="" loading="lazy" />}</span>
              <span className="ws-prods-t">
                <b dir="auto">{p.title}</b>
                <small>
                  {da(p.price)}
                  {rank.has(p.id) && (rank.get(p.id) ?? 99) <= 12 && <em className="ws-chip on">{t('site.products.best', { n: rank.get(p.id) })}</em>}
                </small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ws-empty">{t('site.hints.noProducts')}</p>
      )}
      <a className="btn" href="#/landing/pages">
        <Icon name="plus" /> {t('site.products.add')}
      </a>
    </div>
  );
}

function SettingsPanel({
  doc,
  data,
  live,
  busy,
  missing,
  status,
  onLangs,
  onGo,
  onOffline,
  onClose,
}: {
  doc: SiteDoc;
  data: Data;
  live: Data['live'];
  busy: boolean;
  missing: { lang: SiteLang; blocks: string[] }[];
  status: string;
  onLangs: (l: SiteLang[]) => void;
  onGo: (id: string, l: SiteLang) => void;
  onOffline: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sure, setSure] = useState(false);
  const langs = doc.langs;
  const flip = (l: SiteLang) => onLangs(langs.includes(l) ? (langs.length > 1 ? langs.filter((x) => x !== l) : langs) : [...langs, l]);
  const main = (l: SiteLang) => onLangs([l, ...langs.filter((x) => x !== l)]);
  return (
    <div className="ws-panel">
      <PanelHead title={t('site.set.title')} onClose={onClose} />
      <div className="field">
        <span className="lab">{t('site.set.state')}</span>
        <b className="ws-state">{status}</b>
        {live && <span className="hint">{t('site.set.since', { when: when(live.at) })}</span>}
      </div>
      <div className="field">
        <span className="lab">{t('site.set.address')}</span>
        {data.url ? (
          <a className="ltr ws-url" href={data.url} target="_blank" rel="noreferrer">
            {host(data.url)}
          </a>
        ) : (
          <span className="hint">{t('site.set.addressNone')}</span>
        )}
      </div>
      <div className="field">
        <span className="lab">{t('site.set.langs')}</span>
        {SITE_LANGS.map((l) => (
          <div key={l} className="ws-lang-row">
            <label>
              <input type="checkbox" checked={langs.includes(l)} disabled={langs.length === 1 && langs[0] === l} onChange={() => flip(l)} /> <span lang={l}>{t(`site.lang.${l}`)}</span>
            </label>
            {langs.includes(l) &&
              langs.length > 1 &&
              (langs[0] === l ? (
                <em className="ws-chip on">{t('site.set.main')}</em>
              ) : (
                <button type="button" className="btn small ghost" onClick={() => main(l)}>
                  {t('site.set.makeMain')}
                </button>
              ))}
          </div>
        ))}
        <span className="hint">{t('site.set.langsHint')}</span>
      </div>
      <div className="field">
        <span className="lab">{t('site.set.missing')}</span>
        {missing.length ? (
          missing.map((m) => (
            <div key={m.lang} className="ws-miss-row">
              <b lang={m.lang}>{t(`site.lang.${m.lang}`)}</b>
              {m.blocks.map((id) => {
                const b = doc.home.find((x) => x.id === id);
                return b ? (
                  <button key={id} type="button" className="ws-chip" onClick={() => onGo(id, m.lang)}>
                    {t(`site.block.${b.type}`)}
                  </button>
                ) : null;
              })}
            </div>
          ))
        ) : (
          <span className="hint">{t('site.set.missingNone')}</span>
        )}
      </div>
      {live && (
        <div className="field">
          <span className="lab">{t('site.set.online')}</span>
          {sure ? (
            <div className="ws-row">
              <span className="ws-warn">{t('site.set.offlineAsk')}</span>
              <button type="button" className="btn danger small" disabled={busy} onClick={onOffline}>
                {t('site.set.offline')}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setSure(false)}>
                {t('site.cancel')}
              </button>
            </div>
          ) : (
            <button type="button" className="btn ghost danger" onClick={() => setSure(true)}>
              {t('site.set.offline')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one part of the page
function TextField({ label, value, lang, langs, onChange, max, area }: { label: string; value: SiteText; lang: SiteLang; langs: SiteLang[]; onChange: (v: SiteText) => void; max: number; area?: boolean }) {
  const { t } = useTranslation();
  const v = value[lang] ?? '';
  const common = {
    value: v,
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    maxLength: max,
    placeholder: siteText({ ...value, [lang]: '' }, lang, langs),
    onChange: (e: { target: { value: string } }) => onChange({ ...value, [lang]: e.target.value }),
  };
  return (
    <label className="field">
      <span className="lab">
        {label}
        {!v.trim() && <em className="ws-miss">{t('site.ed.empty', { lang: t(`site.lang.${lang}`) })}</em>}
      </span>
      {area ? <textarea rows={3} {...common} /> : <input type="text" {...common} />}
    </label>
  );
}

function BlockPanel({
  block,
  index,
  total,
  doc,
  lang,
  data,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onBack,
  onDone,
}: {
  block: SiteBlock;
  index: number;
  total: number;
  doc: SiteDoc;
  lang: SiteLang;
  data: Data;
  onChange: (p: Partial<SiteBlock>) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [sure, setSure] = useState(false);
  const langs = doc.langs;
  const tf = (label: string, value: SiteText, set: (v: SiteText) => void, max: number, area = false) => (
    <TextField label={label} value={value} lang={lang} langs={langs} onChange={set} max={max} area={area} />
  );
  const b = block;
  const shop = data.view.shop;
  return (
    <div className="ws-panel">
      <div className="ws-ph">
        <button type="button" className="btn icon ghost small" onClick={onBack} aria-label={t('site.ed.back')} title={t('site.ed.back')}>
          <Icon name="chevl" className="ws-flip" />
        </button>
        <h3>{t(`site.block.${b.type}`)}</h3>
        <span className="ws-ph-a">
          <button type="button" className="btn icon small" disabled={index <= 0} onClick={() => onMove(-1)} aria-label={t('site.ed.up')} title={t('site.ed.up')}>
            <Icon name="chevron" className="ws-up" />
          </button>
          <button type="button" className="btn icon small" disabled={index >= total - 1} onClick={() => onMove(1)} aria-label={t('site.ed.down')} title={t('site.ed.down')}>
            <Icon name="chevron" />
          </button>
          <button type="button" className="btn icon small" onClick={onDuplicate} aria-label={t('site.ed.duplicate')} title={t('site.ed.duplicate')}>
            <Icon name="copy" />
          </button>
        </span>
      </div>
      <p className="muted ws-note">{t(`site.about.${b.type}`)}</p>
      {langs.length > 1 && b.type !== 'header' && (
        <p className="ws-inlang">
          <Icon name="languages" /> {t('site.ed.inLang', { lang: t(`site.lang.${lang}`) })}
        </p>
      )}

      {b.type === 'header' && <Toggle label={t('site.ed.phone')} on={b.phone} set={(phone) => onChange({ phone })} hint={shop.phone || t('site.ed.noPhone')} />}

      {b.type === 'hero' && (
        <>
          <div className="field">
            <span className="lab">{t('site.ed.layout')}</span>
            <div className="ws-seg wide">
              {(['side', 'center', 'plain'] as const).map((k) => (
                <button key={k} type="button" className={b.layout === k ? 'on' : ''} aria-pressed={b.layout === k} onClick={() => onChange({ layout: k })}>
                  {t(`site.ed.${k}`)}
                </button>
              ))}
            </div>
          </div>
          {tf(t('site.ed.title'), b.title, (title) => onChange({ title }), SITE_LIMITS.title)}
          {tf(t('site.ed.text'), b.text, (text) => onChange({ text }), SITE_LIMITS.text, true)}
          {tf(t('site.ed.button'), b.button, (button) => onChange({ button }), 60)}
          <label className="field">
            <span className="lab">{t('site.ed.opens')}</span>
            <select value={b.link} onChange={(e) => onChange({ link: e.target.value as 'products' | 'whatsapp' | 'sessions' })}>
              <option value="products">{t('site.ed.toProducts')}</option>
              <option value="whatsapp">{t('site.ed.toWhatsapp')}</option>
              {(data.view.rdv || b.link === 'sessions') && <option value="sessions">{t('site.ed.toSessions')}</option>}
            </select>
          </label>
          {b.layout !== 'plain' && (
          <label className="field">
            <span className="lab">{t('site.ed.picture')}</span>
            <select value={b.productId ?? ''} onChange={(e) => onChange({ productId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('site.ed.auto')}</option>
              {data.view.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          )}
        </>
      )}

      {b.type === 'sessions' && (
        <>
          {tf(t('site.ed.title'), b.title, (title) => onChange({ title }), SITE_LIMITS.title)}
          {tf(t('site.ed.text'), b.text, (text) => onChange({ text }), SITE_LIMITS.text, true)}
          {tf(t('site.ed.barButton'), b.button, (button) => onChange({ button }), 60)}
          <p className="ws-hintbox">
            <Icon name="calendar" />
            <span>
              {data.view.rdv ? t('site.ed.sessionsNote', { count: data.view.sessions?.length ?? 0 }) : t('site.hints.rdvOff')}{' '}
              <a href={data.view.rdv ? '#/rendezvous/sessions' : '#/management/modules'}>{t(data.view.rdv ? 'site.ed.sessionsGo' : 'site.ed.modulesGo')}</a>
            </span>
          </p>
        </>
      )}

      {b.type === 'trust' && (
        <ItemList
          items={b.items}
          max={SITE_LIMITS.items}
          addLabel={t('site.ed.addPoint')}
          onChange={(items) => onChange({ items })}
          make={() => ({ icon: 'check' as SiteTrustIcon, text: {} })}
          render={(x, set) => (
            <>
              <div className="ws-icons" role="group" aria-label={t('site.ed.icon')}>
                {SITE_TRUST_ICONS.map((ic) => (
                  <button key={ic} type="button" className={x.icon === ic ? 'on' : ''} aria-pressed={x.icon === ic} onClick={() => set({ ...x, icon: ic })}>
                    {t(`site.icons.${ic}`)}
                  </button>
                ))}
              </div>
              {tf(t('site.ed.text'), x.text, (text) => set({ ...x, text }), 80)}
            </>
          )}
        />
      )}

      {b.type === 'best' && (
        <>
          {tf(t('site.ed.title'), b.title, (title) => onChange({ title }), SITE_LIMITS.title)}
          <div className="ws-line">
            <span>
              <b>{t('site.ed.count')}</b>
              <small>{t('site.ed.bestNote')}</small>
            </span>
            <span className="ws-step">
              <button type="button" disabled={b.count <= 1} onClick={() => onChange({ count: b.count - 1 })} aria-label={t('site.ed.fewer')}>
                <Icon name="minus" />
              </button>
              <b>{b.count}</b>
              <button type="button" disabled={b.count >= SITE_LIMITS.count} onClick={() => onChange({ count: b.count + 1 })} aria-label={t('site.ed.more')}>
                <Icon name="plus" />
              </button>
            </span>
          </div>
          <Toggle label={t('site.ed.oldPrice')} on={b.oldPrice} set={(oldPrice) => onChange({ oldPrice })} />
          {tf(t('site.ed.cardButton'), b.button, (button) => onChange({ button }), 60)}
        </>
      )}

      {b.type === 'products' && (
        <>
          {tf(t('site.ed.title'), b.title, (title) => onChange({ title }), SITE_LIMITS.title)}
          {tf(t('site.ed.cardButton'), b.button, (button) => onChange({ button }), 60)}
          <span className="hint">{t('site.ed.productsNote', { n: data.view.products.length })}</span>
        </>
      )}

      {b.type === 'why' && (
        <>
          {tf(t('site.ed.title'), b.title, (title) => onChange({ title }), SITE_LIMITS.title)}
          <ItemList items={b.points} max={SITE_LIMITS.items} addLabel={t('site.ed.addPoint')} onChange={(points) => onChange({ points })} make={() => ({})} render={(x, set) => tf(t('site.ed.point'), x, set, 200)} />
        </>
      )}

      {b.type === 'faq' && (
        <>
          {tf(t('site.ed.title'), b.title, (title) => onChange({ title }), SITE_LIMITS.title)}
          <ItemList
            items={b.items}
            max={SITE_LIMITS.items}
            addLabel={t('site.ed.addQuestion')}
            onChange={(items) => onChange({ items })}
            make={() => ({ q: {}, a: {} })}
            render={(x, set) => (
              <>
                {tf(t('site.ed.question'), x.q, (q) => set({ ...x, q }), 160)}
                {tf(t('site.ed.answer'), x.a, (a) => set({ ...x, a }), SITE_LIMITS.text, true)}
              </>
            )}
          />
        </>
      )}

      {b.type === 'whatsapp' && (
        <>
          {tf(t('site.ed.text'), b.text, (text) => onChange({ text }), 80)}
          <span className="hint">{shop.whatsapp ? t('site.ed.waNote', { n: shop.whatsapp }) : t('site.hints.noWhatsapp')}</span>
        </>
      )}

      {b.type === 'footer' && tf(t('site.ed.text'), b.text, (text) => onChange({ text }), 200)}

      <div className="ws-foot">
        {sure ? (
          <>
            <span className="ws-warn ws-sp">{t('site.ed.removeAsk')}</span>
            <button type="button" className="btn ghost" onClick={() => setSure(false)}>
              {t('site.cancel')}
            </button>
            <button type="button" className="btn danger" onClick={onRemove}>
              {t('site.ed.sure')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => onChange({ hidden: !b.hidden })}>
              <Icon name={b.hidden ? 'eye' : 'eyeoff'} /> {b.hidden ? t('site.ed.show') : t('site.ed.hide')}
            </button>
            <button type="button" className="btn icon ghost danger" onClick={() => setSure(true)} aria-label={t('site.ed.remove')} title={t('site.ed.remove')}>
              <Icon name="trash" />
            </button>
            <span className="ws-sp" />
            <button type="button" className="btn primary" onClick={onDone}>
              {t('site.ed.done')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, on, set, hint }: { label: string; on: boolean; set: (v: boolean) => void; hint?: string }) {
  return (
    <label className="ws-line ws-toggle">
      <span>
        <b>{label}</b>
        {hint && <small className="ltr">{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => set(e.target.checked)} />
    </label>
  );
}

function ItemList<X>({ items, max, addLabel, onChange, make, render }: { items: X[]; max: number; addLabel: string; onChange: (v: X[]) => void; make: () => X; render: (x: X, set: (v: X) => void) => ReactNode }) {
  const { t } = useTranslation();
  const swap = (k: number) => onChange(items.map((y, j) => (j === k - 1 ? items[k] : j === k ? items[k - 1] : y)));
  return (
    <div className="ws-items">
      {items.map((x, k) => (
        <div key={k} className="ws-item">
          <div className="ws-item-h">
            <b>{k + 1}</b>
            <span className="ws-sp" />
            <button type="button" className="btn icon small ghost" disabled={k === 0} onClick={() => swap(k)} aria-label={t('site.ed.up')} title={t('site.ed.up')}>
              <Icon name="chevron" className="ws-up" />
            </button>
            <button type="button" className="btn icon small ghost danger" onClick={() => onChange(items.filter((_, j) => j !== k))} aria-label={t('site.ed.remove')} title={t('site.ed.remove')}>
              <Icon name="trash" />
            </button>
          </div>
          {render(x, (v) => onChange(items.map((y, j) => (j === k ? v : y))))}
        </div>
      ))}
      {items.length < max && (
        <button type="button" className="btn ws-additem" onClick={() => onChange([...items, make()])}>
          <Icon name="plus" /> {addLabel}
        </button>
      )}
    </div>
  );
}
