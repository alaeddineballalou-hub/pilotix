// Marketing › AI Spy (#/marketing/spy): the competitors' Facebook ads in Algeria for the shop's own products — the
// creative, the page, days online, copies, the site and its price, a 0–100 score, Claude's reading, a « Comment battre
// la concurrence » brief, a price strip, followed pages and their alerts. Everything comes from core (spy.*): the free
// Chrome extension reads Facebook's Ad Library in the user's own Chrome (one keyword at a time, then spy.ingest), or a
// paid key searches on the server (spy.search). Facebook does not publish ad spend for Algeria: none is shown or guessed.
// #/marketing/spy/reglages opens the settings (SpySettings.tsx).
import type { RawAd, SpyAd, SpyFinding, SpyKeyword } from '@pilotix/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc, type Out } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { adLibraryUrl, detectExtension, extensionSearch, type ExtStatus, type ExtStep } from '../../lib/spyExtension';
import { copyText, Empty, ErrorBox, Icon, KpiBody, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SpyDetail } from './SpyDetail';
import { ExtensionCard, SpySettingsView } from './SpySettings';
import { arLang, Creative, dayTone, firstLine, isAr, LandLine, Rich, type View } from './spyShared';
import './spy.css';

type Filters = { site: boolean; chat: boolean; video: boolean; hideOwn: boolean };
const NO_FILTERS: Filters = { site: false, chat: false, video: false, hideOwn: false };
const FILTERS = ['site', 'chat', 'video', 'hideOwn'] as const;
const SORTS = ['score', 'days', 'copies', 'recent'] as const;
type Sort = (typeof SORTS)[number];
/** an ad (or a page's ads) to open once its product is on screen */
type Want = { productId: number; gkey?: string | null; pageKey?: string | null };
type Product = Out<'spy.products'>[number];
type FollowedEvent = Out<'spy.followed'>['events'][number];

/** Marketing › AI Spy, or its settings (#/marketing/spy/reglages). */
export function Spy({ rest }: { rest?: string[] }) {
  return rest?.[0] === 'reglages' ? <SpySettingsView /> : <SpyMain />;
}

// ---------------------------------------------------------------- the search (extension or paid source)
type Prog = { k: 'kw'; i: number; n: number; q: string; step: ExtStep | 'save' } | { k: 'finish' | 'analyze' | 'brief' | 'paid' };
type KwError = { q: string; message: string };

const cut = (s: string | null | undefined, max: number): string | null => (typeof s === 'string' ? s.slice(0, max) : null);
/** What the extension hands over, kept inside spy.ingest's limits (one oversized field must not refuse the keyword). */
function cleanAd(a: RawAd): RawAd | null {
  const id = String(a.id ?? '').trim();
  if (id.length < 3 || id.length > 40) return null;
  const num = (x: unknown) => (typeof x === 'number' && isFinite(x) ? x : null);
  const copies = num(a.copies);
  const started = num(a.startedAt);
  return {
    id,
    collationId: cut(a.collationId, 40),
    copies: copies === null ? null : Math.max(1, Math.min(1000, Math.round(copies))),
    pageId: cut(a.pageId, 40),
    pageName: (a.pageName || '—').slice(0, 200),
    pageUrl: cut(a.pageUrl, 500),
    startedAt: started === null ? null : Math.round(started),
    active: typeof a.active === 'boolean' ? a.active : null,
    platforms: Array.isArray(a.platforms) ? a.platforms.slice(0, 12).map((p) => String(p).slice(0, 40)) : null,
    body: cut(a.body, 6000),
    title: cut(a.title, 600),
    linkUrl: cut(a.linkUrl, 3000),
    cta: cut(a.cta, 100),
    isVideo: typeof a.isVideo === 'boolean' ? a.isVideo : null,
    mediaUrl: cut(a.mediaUrl, 4000),
    media: typeof a.media === 'string' && a.media.length <= 600_000 ? a.media : null,
  };
}

function useSearch() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [prog, setProg] = useState<Prog | null>(null);
  const [errors, setErrors] = useState<KwError[]>([]);
  const [needExt, setNeedExt] = useState(false);
  const busy = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  // leaving AI Spy stops the extension's search
  useEffect(() => () => ctrl.current?.abort(), []);

  /** Extension: each keyword in the user's Chrome, then spy.ingest; at the end spy.finish, Claude and the brief. */
  const viaExtension = async (v: View, max: number) => {
    const productId = v.product.id;
    const ext = await detectExtension();
    if (!ext.installed) {
      if (v.demo) toast(t('spy.demoNote'), 'info', 6000);
      else setNeedExt(true);
      return;
    }
    const kws = v.keywords;
    if (!kws.length) {
      toast(t('spy.kw.empty'), 'info');
      return;
    }
    const ac = new AbortController();
    ctrl.current = ac;
    const since = new Date().toISOString();
    const errs: KwError[] = [];
    let found = 0;
    let added = 0;
    let done = 0;
    for (let i = 0; i < kws.length && !ac.signal.aborted; i++) {
      const q = kws[i].q;
      const at = (step: ExtStep | 'save') => setProg({ k: 'kw', i: i + 1, n: kws.length, q, step });
      at('open');
      try {
        const r = await extensionSearch(q, { country: 'DZ', max, signal: ac.signal, onProgress: at });
        at('save');
        const ads = r.ads.map(cleanAd).filter((a): a is RawAd => a !== null).slice(0, 200);
        const count = r.count === null || !isFinite(r.count) ? null : Math.max(0, Math.round(r.count));
        const ing = await rpc('spy.ingest', { productId, keyword: q, count, ads });
        found += ads.length;
        added += ing.added;
        done++;
        void qc.invalidateQueries({ queryKey: ['spy.view'] });
      } catch (e) {
        if (ac.signal.aborted) break;
        errs.push({ q, message: (e as Error).message });
      }
    }
    if (ac.signal.aborted) {
      setErrors(errs);
      toast(t('spy.search.stopped'), 'info');
      return;
    }
    if (done) {
      // every keyword was read again: what was not seen has stopped (a failed keyword would mark its ads stopped by mistake)
      if (!errs.length) {
        setProg({ k: 'finish' });
        await rpc('spy.finish', { productId, since }).catch((e: Error) => errs.push({ q: t('spy.prog.finish'), message: e.message }));
      }
      setProg({ k: 'analyze' });
      await rpc('spy.analyze', { productId }).catch((e: Error) => errs.push({ q: t('spy.prog.analyze'), message: e.message }));
      setProg({ k: 'brief' });
      await rpc('spy.brief', { productId, refresh: true }).catch((e: Error) => errs.push({ q: t('spy.prog.brief'), message: e.message }));
    }
    setErrors(errs);
    if (done) toast(t('spy.search.done', { found: n(found), added: n(added), count: done }), errs.length ? 'info' : 'ok', 6000);
    else toast(t('spy.search.failed'), 'bad', 6000);
  };

  /** Paid source: the server searches every keyword (pictures, sites and Claude included), then the brief. */
  const viaServer = async (v: View) => {
    const productId = v.product.id;
    if (v.demo) {
      toast(t('spy.demoNote'), 'info', 6000);
      return;
    }
    if (!v.hasKey) {
      toast(t('spy.noKey'), 'bad', 6000);
      return;
    }
    setProg({ k: 'paid' });
    const r = await rpc('spy.search', { productId });
    setProg({ k: 'brief' });
    await rpc('spy.brief', { productId, refresh: true }).catch(() => null);
    toast(t('spy.search.donePaid', { found: n(r.found), added: n(r.added), stopped: n(r.stopped) }), 'ok', 6000);
  };

  const run = async (v: View, max: number) => {
    if (busy.current) return;
    busy.current = true;
    setErrors([]);
    setNeedExt(false);
    try {
      if (v.source === 'extension') await viaExtension(v, max);
      else await viaServer(v);
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    } finally {
      busy.current = false;
      ctrl.current = null;
      setProg(null);
      void qc.invalidateQueries();
    }
  };
  const stop = () => ctrl.current?.abort();
  return { prog, errors, needExt, run, stop, closeExt: () => setNeedExt(false), clearErrors: () => setErrors([]) };
}
type Search = ReturnType<typeof useSearch>;

// ---------------------------------------------------------------- the page
function SpyMain() {
  const { t } = useTranslation();
  const products = useRpc('spy.products', {});
  const findings = useRpc('spy.findings', {});
  const settings = useRpc('spy.settings.get', {});
  const [pid, setPid] = useState<number | null>(() => Number(store.get('spy-product')) || null);
  const list = products.data ?? [];
  const productId = pid !== null && list.some((p) => p.id === pid) ? pid : list[0]?.id ?? null;
  const view = useRpc('spy.view', { productId: productId ?? 0 }, { enabled: productId !== null });
  // the previous product's data stays on screen while the next one loads: never show it under the new product
  const v = view.data && view.data.product.id === productId ? view.data : null;
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>(() => {
    const s = store.get('spy-sort');
    return (SORTS as readonly string[]).includes(s ?? '') ? (s as Sort) : 'score';
  });
  const [want, setWant] = useState<Want | null>(null);
  const [ext, setExt] = useState<ExtStatus | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const search = useSearch();
  const source = v?.source ?? settings.data?.settings.source ?? 'extension';

  useEffect(() => {
    if (source === 'extension') void detectExtension().then(setExt);
  }, [source]);

  const pick = (id: number) => {
    setPid(id);
    store.set('spy-product', String(id));
    setSel(null);
  };
  const openAt = (w: Want) => {
    if (!list.some((p) => p.id === w.productId)) {
      toast(t('spy.productGone'), 'info');
      return;
    }
    if (w.productId !== productId) pick(w.productId);
    setWant(w);
  };
  // a finding, an alert or a followed page: once its product is loaded, select the ad and bring the detail into view
  useEffect(() => {
    if (!want || !v || v.product.id !== want.productId) return;
    const target = v.ads.find((a) => (want.gkey ? a.gkey === want.gkey : !!want.pageKey && a.pageKey === want.pageKey));
    if (target) {
      setF(NO_FILTERS);
      setSel(target.gkey);
    }
    setWant(null);
    requestAnimationFrame(() => (target ? detailRef.current : resultsRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [want, v]);

  const shown = useMemo(() => {
    if (!v) return [];
    const keep = v.ads.filter(
      (a) => (!f.site || a.linkType === 'site') && (!f.chat || a.linkType === 'messenger' || a.linkType === 'whatsapp') && (!f.video || a.isVideo) && (!f.hideOwn || !a.own),
    );
    const by: Record<Sort, (a: SpyAd, b: SpyAd) => number> = {
      score: (a, b) => b.score - a.score || b.days - a.days,
      days: (a, b) => b.days - a.days || b.score - a.score,
      copies: (a, b) => b.copies - a.copies || b.score - a.score,
      recent: (a, b) => a.days - b.days || Date.parse(b.firstSeen) - Date.parse(a.firstSeen),
    };
    return [...keep].sort(by[sort]);
  }, [v, f, sort]);
  const cur = shown.find((a) => a.gkey === sel) ?? shown[0] ?? null;

  const select = (gkey: string) => {
    setSel(gkey);
    if (v && !shown.some((a) => a.gkey === gkey)) setF(NO_FILTERS);
    if (window.matchMedia('(max-width: 1180px)').matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="spy view">
      <SearchCard products={list} loading={products.isLoading} productId={productId} onPick={pick} v={v} ext={ext} search={search} source={source} settings={settings.data ?? null} />
      {search.needExt && <ExtensionCard onClose={search.closeExt} />}
      <Findings q={findings} onOpen={(x) => openAt({ productId: x.productId, gkey: 'gkey' in x ? x.gkey : null })} />
      {products.error ? (
        <ErrorBox error={products.error} onRetry={() => products.refetch()} />
      ) : productId === null ? (
        products.isLoading ? <Loading /> : <Empty>{t('spy.noProducts')}</Empty>
      ) : !v ? (
        view.error ? <ErrorBox error={view.error} onRetry={() => view.refetch()} /> : <Loading />
      ) : (
        <>
          <KpiRow v={v} />
          <div className="spy-split">
            <Results v={v} shown={shown} cur={cur} f={f} setF={setF} sort={sort} setSort={setSort} onSelect={select} innerRef={resultsRef} />
            <div className="spy-detail" ref={detailRef}>
              <SpyDetail ad={cur} v={v} />
            </div>
          </div>
          <div className="spy-two">
            <Brief v={v} busy={!!search.prog} />
            <PriceStrip v={v} onOpen={select} />
          </div>
        </>
      )}
      <Followed v={v} onOpen={openAt} />
      <Sources v={v} source={source} />
    </div>
  );
}

// ---------------------------------------------------------------- search card: product, source, keywords
function SearchCard({ products, loading, productId, onPick, v, ext, search, source, settings }: { products: Product[]; loading: boolean; productId: number | null; onPick: (id: number) => void; v: View | null; ext: ExtStatus | null; search: Search; source: string; settings: Out<'spy.settings.get'> | null }) {
  const { t } = useTranslation();
  const p = v?.product ?? products.find((x) => x.id === productId) ?? null;
  const watch = useAction('spy.watch', { success: t('spy.watchSaved') });
  const paid = source !== 'extension';
  const demo = !!(v?.demo ?? settings?.demo);
  const busy = !!search.prog;
  const srcState = paid ? (v ? (v.hasKey ? 'ok' : 'bad') : '') : ext ? (ext.installed ? 'ok' : demo ? '' : 'bad') : '';
  const srcText = paid ? (v ? (v.hasKey ? t('spy.keyOk') : t('spy.keyMissing')) : '…') : !ext ? '…' : ext.installed ? t('spy.extOn') : demo ? t('spy.extDemo') : t('spy.extOff');
  return (
    <section className="card spy-search" aria-labelledby="spy-t">
      <div className="spy-head">
        <div className="spy-title">
          <h2 id="spy-t">
            <span className="spy-face" aria-hidden="true">
              <Icon name="sparkles" />
            </span>
            AI Spy
          </h2>
          <p className="note">{t('spy.intro')}</p>
        </div>
        <div className="row">
          <span className={`spy-live ${demo ? 'demo' : ''}`}>
            <i aria-hidden="true" />
            {demo ? t('spy.liveDemo') : p?.scannedAt ? t('spy.liveAt', { when: when(p.scannedAt) }) : t('spy.liveNever')}
          </span>
          <a className="btn small" href="#/marketing/spy/reglages">
            <Icon name="settings" /> {t('spy.settings')}
          </a>
        </div>
      </div>

      <div className="spy-ctrl">
        <label className="field spy-prod">
          <span className="lab">{t('spy.product')}</span>
          <select value={productId ?? ''} disabled={busy || !products.length} onChange={(e) => e.target.value && onPick(Number(e.target.value))}>
            {!products.length && <option value="">{loading ? t('common.loading') : '—'}</option>}
            {products.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {t('spy.orders30', { n: n(x.orders30) })}
                {x.ads ? ` · ${t('spy.adsN', { n: n(x.ads) })}` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="lab">{t('spy.source')}</span>
          <a className={`spy-srcpill ${srcState}`} href="#/marketing/spy/reglages" title={t('spy.sourceTip')}>
            <i aria-hidden="true" />
            <b>{t(`spy.set.src.${source}.name`)}</b>
            <span>{srcText}</span>
          </a>
        </div>
        <div className="spy-go">
          {busy && search.prog?.k === 'kw' ? (
            <button type="button" className="btn" onClick={search.stop}>
              <Icon name="x" /> {t('spy.search.stop')}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!v || busy || (!paid && !v.keywords.length)} onClick={() => v && search.run(v, settings?.settings.maxPerKeyword ?? 30)}>
              <Icon name="search" /> {busy ? t('spy.search.running') : t('spy.search.go')}
            </button>
          )}
        </div>
      </div>

      {demo && (
        <p className="spy-demo" role="note">
          <Icon name="info" /> {t('spy.demoNote')}
        </p>
      )}
      {paid && v && !v.hasKey && !demo && (
        <div className="warnbox">
          {t('spy.noKey')}{' '}
          <a href="#/marketing/spy/reglages" className="spy-a">
            {t('spy.settings')}
          </a>
        </div>
      )}
      {search.prog && <ProgressLine p={search.prog} source={source} />}
      {search.errors.length > 0 && (
        <div className="spy-errs" role="alert">
          <div className="spy-errs-h">
            <b>{t('spy.search.errors', { count: search.errors.length })}</b>
            <button type="button" className="btn small ghost" onClick={search.clearErrors} aria-label={t('spy.close')}>
              <Icon name="x" />
            </button>
          </div>
          <ul>
            {search.errors.map((e, i) => (
              <li key={i}>
                <bdi>{e.q}</bdi> : {e.message}
              </li>
            ))}
          </ul>
          <p className="note">{t('spy.search.partial')}</p>
        </div>
      )}
      {v && <Keywords v={v} disabled={busy} />}
      {v && paid && (
        <label className="spy-switch">
          <input type="checkbox" checked={v.product.watch} disabled={watch.isPending} onChange={(e) => watch.mutate({ productId: v.product.id, on: e.target.checked })} />
          <span>
            <b>{t('spy.watch')}</b>
            <small>{settings?.settings.dailyScan ? t('spy.watchHelp', { h: String(settings.settings.scanHour).padStart(2, '0') }) : t('spy.watchOff')}</small>
          </span>
        </label>
      )}
    </section>
  );
}

const STEP_FRAC: Record<ExtStep | 'save', number> = { open: 0.15, read: 0.45, pictures: 0.75, save: 0.92 };
function ProgressLine({ p, source }: { p: Prog; source: string }) {
  const { t } = useTranslation();
  const frac = p.k === 'kw' ? (p.i - 1 + STEP_FRAC[p.step]) / p.n : p.k === 'paid' ? 0.45 : p.k === 'finish' ? 0.94 : p.k === 'analyze' ? 0.97 : 0.99;
  return (
    <div className="spy-prog" role="status" aria-live="polite">
      <span>
        {p.k === 'kw' ? (
          <Rich k="spy.prog.kw" v={{ i: p.i, n: p.n, q: p.q, step: t(`spy.prog.${p.step}`) }} />
        ) : (
          t(`spy.prog.${p.k}`, { source: t(`spy.set.src.${source}.name`) })
        )}
      </span>
      <span className="spy-prog-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(frac * 100)}%` }} />
      </span>
    </div>
  );
}

const langOf = (q: string): SpyKeyword['lang'] => (/\d/.test(q) && /(دج|د\.ج|\bda\b|dzd)/i.test(q) ? 'price' : isAr(q) ? 'ar' : 'fr');

function Keywords({ v, disabled }: { v: View; disabled: boolean }) {
  const { t } = useTranslation();
  const productId = v.product.id;
  const save = useAction('spy.keywords.save');
  const suggest = useAction('spy.keywords.suggest', { success: (r) => t('spy.kw.suggested', { count: r.length }) });
  const [q, setQ] = useState('');
  const list = v.keywords;
  const full = list.length >= 12;
  const payload = (l: SpyKeyword[]) => l.map((k) => ({ q: k.q, lang: k.lang }));
  const add = () => {
    const s = q.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (s.length < 2 || full) return;
    if (list.some((k) => k.q.toLowerCase() === s.toLowerCase())) return setQ('');
    save.mutate({ productId, keywords: [...payload(list), { q: s, lang: langOf(s) }] }, { onSuccess: () => setQ('') });
  };
  const remove = (k: SpyKeyword) => save.mutate({ productId, keywords: payload(list.filter((x) => x !== k)) });
  const propose = () => (!list.length || window.confirm(t('spy.kw.replaceAsk'))) && suggest.mutate({ productId });
  return (
    <div className="spy-kw">
      <div className="spy-kw-top">
        <Icon name="search" />
        <b>{t('spy.kw.title')}</b>
        <span className="note">{t('spy.kw.help')}</span>
      </div>
      {list.length ? (
        <ul className="spy-kw-list">
          {list.map((k) => (
            <li key={k.q} className="spy-chip">
              <a href={adLibraryUrl(k.q)} target="_blank" rel="noopener noreferrer" title={k.at ? t('spy.kw.at', { when: when(k.at) }) : t('spy.kw.open')}>
                <span dir="auto" lang={arLang(k.q)}>
                  {k.q}
                </span>
                {k.count !== null && <b className="ltr">{n(k.count)}</b>}
                <Icon name="external" />
              </a>
              <button type="button" aria-label={t('spy.kw.remove', { q: k.q })} title={t('spy.kw.remove', { q: k.q })} disabled={disabled || save.isPending} onClick={() => remove(k)}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="spy-kw-empty">
          <span>{t('spy.kw.empty')}</span>
        </div>
      )}
      <div className="spy-kw-add">
        <input
          type="text"
          dir="auto"
          value={q}
          maxLength={60}
          placeholder={t('spy.kw.addPh')}
          aria-label={t('spy.kw.addPh')}
          disabled={disabled || full}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn small" disabled={disabled || full || q.trim().length < 2 || save.isPending} onClick={add}>
          <Icon name="plus" /> {t('spy.kw.add')}
        </button>
        <button type="button" className={`btn small ${list.length ? '' : 'primary'}`} disabled={disabled || suggest.isPending} onClick={propose}>
          <Icon name="sparkles" /> {suggest.isPending ? t('spy.kw.suggesting') : t('spy.kw.suggest')}
        </button>
      </div>
      {full && <p className="note">{t('spy.kw.full')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- what the scans found (all products)
const FIND_ICON: Record<SpyFinding['kind'], string> = { scaling: 'trend', longest: 'clock', yourBest: 'trophy', cheaper: 'tag', noOwnAd: 'alert', newcomer: 'userplus' };

function FindingText({ f }: { f: SpyFinding }) {
  switch (f.kind) {
    case 'scaling':
      return <Rich k={f.price ? 'spy.find.scalingPrice' : 'spy.find.scaling'} count={f.days} v={{ page: f.page, copies: n(f.copies), days: n(f.days), product: f.product, price: f.price ? da(f.price) : '' }} />;
    case 'longest':
      return <Rich k="spy.find.longest" count={f.days} v={{ page: f.page, days: n(f.days), product: f.product }} />;
    case 'yourBest':
      return <Rich k="spy.find.yourBest" count={f.days} v={{ copies: n(f.copies), days: n(f.days), product: f.product }} />;
    case 'cheaper':
      return <Rich k="spy.find.cheaper" v={{ page: f.page, price: da(f.price), yours: da(f.yours), product: f.product }} />;
    case 'noOwnAd':
      return <Rich k="spy.find.noOwnAd" count={f.competitors} v={{ product: f.product, orders: n(f.orders), competitors: n(f.competitors) }} />;
    case 'newcomer':
      return <Rich k="spy.find.newcomer" count={f.creatives} v={{ page: f.page, creatives: n(f.creatives), product: f.product }} />;
  }
}

function Findings({ q, onOpen }: { q: ReturnType<typeof useRpc<'spy.findings'>>; onOpen: (f: SpyFinding) => void }) {
  const { t } = useTranslation();
  const list = q.data ?? [];
  return (
    <section className="card" aria-labelledby="spy-find-h">
      <div className="card-head">
        <h2 id="spy-find-h">
          <Icon name="sparkles" /> {t('spy.find.title')}
        </h2>
        <span className="note">{t('spy.find.note')}</span>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !list.length ? (
        <p className="note">{t('spy.find.none')}</p>
      ) : (
        <div className="spy-finds">
          {list.map((f, i) => (
            <button key={`${f.kind}-${i}`} type="button" className="spy-find" onClick={() => onOpen(f)}>
              <Icon name={FIND_ICON[f.kind]} />
              <span>
                <FindingText f={f} />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- KPIs of the product
function KpiRow({ v }: { v: View }) {
  const { t } = useTranslation();
  const comp = v.ads.filter((a) => !a.own);
  const own = v.ads.filter((a) => a.own && a.active);
  const pages = new Set(comp.map((a) => a.pageKey)).size;
  const sites = comp.filter((a) => a.linkType === 'site').length;
  const oldest = comp.reduce<SpyAd | null>((m, a) => (!m || a.days > m.days ? a : m), null);
  const prices = comp
    .filter((a) => a.same !== false && a.price)
    .map((a) => a.price as number)
    .sort((a, b) => a - b);
  const p = v.product;
  return (
    <div className="kpis spy-kpis" aria-label={t('spy.k.title')}>
      <div className="kpi">
        <KpiBody label={t('spy.k.pages')} value={n(pages)} sub={comp.length ? t('spy.k.pagesSub', { site: n(sites), chat: n(comp.length - sites) }) : t('spy.k.none')} icon="users" />
      </div>
      <div className="kpi">
        <KpiBody label={t('spy.k.oldest')} value={oldest ? t('spy.daysN', { n: n(oldest.days) }) : '—'} sub={<bdi>{oldest?.pageName ?? t('spy.k.none')}</bdi>} icon="clock" />
      </div>
      <div className="kpi">
        <KpiBody
          label={t('spy.k.prices')}
          value={!prices.length ? '—' : prices.length === 1 || prices[0] === prices[prices.length - 1] ? da(prices[0]) : `${n(prices[0])} – ${da(prices[prices.length - 1])}`}
          sub={prices.length ? t('spy.k.pricesSub', { count: prices.length }) : t('spy.k.noPrice')}
          icon="tag"
        />
      </div>
      <div className="kpi spy-net">
        <KpiBody label={t('spy.k.yours')} value={p.price ? da(p.price) : '—'} sub={p.cost ? t('spy.k.cost', { cost: da(p.cost) }) : t('spy.k.noCost')} icon="wallet" />
      </div>
      <div className="kpi">
        <KpiBody
          label={t('spy.k.own')}
          value={n(own.length)}
          sub={
            own.length
              ? own
                  .slice(0, 3)
                  .map((a) => `×${a.copies} · ${t('spy.daysN', { n: n(a.days) })}`)
                  .join(', ')
              : t('spy.k.ownNone')
          }
          icon="megaphone"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the ads found
function Results({ v, shown, cur, f, setF, sort, setSort, onSelect, innerRef }: { v: View; shown: SpyAd[]; cur: SpyAd | null; f: Filters; setF: Dispatch<SetStateAction<Filters>>; sort: Sort; setSort: (s: Sort) => void; onSelect: (gkey: string) => void; innerRef: RefObject<HTMLElement> }) {
  const { t } = useTranslation();
  const toggle = (k: keyof Filters) =>
    setF((x) => {
      const on = !x[k];
      // « avec site » and « Messenger / WhatsApp » exclude each other
      return { ...x, [k]: on, ...(on && k === 'site' ? { chat: false } : {}), ...(on && k === 'chat' ? { site: false } : {}) };
    });
  return (
    <section className="card spy-results" ref={innerRef} aria-labelledby="spy-res-h">
      <div className="card-head">
        <h2 id="spy-res-h">
          {t('spy.res.title')}{' '}
          <span className="count ltr">
            {shown.length}
            {shown.length !== v.ads.length ? ` / ${v.ads.length}` : ''}
          </span>
        </h2>
        <span className="note">{t(`spy.res.sorted.${sort}`)}</span>
      </div>
      <div className="spy-toolbar">
        <div className="spy-fchips" role="group" aria-label={t('spy.res.filters')}>
          {FILTERS.map((k) => (
            <button key={k} type="button" className={`spy-fchip ${f[k] ? 'on' : ''}`} aria-pressed={f[k]} onClick={() => toggle(k)}>
              {t(`spy.f.${k}`)}
            </button>
          ))}
        </div>
        <select
          className="spy-sort"
          aria-label={t('spy.res.sort')}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            store.set('spy-sort', e.target.value);
          }}
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`spy.sort.${s}`)}
            </option>
          ))}
        </select>
      </div>
      {!v.ads.length ? (
        <Empty>{v.demo ? t('spy.res.emptyDemo') : v.keywords.length ? t('spy.res.empty') : t('spy.res.emptyKw')}</Empty>
      ) : !shown.length ? (
        <Empty>
          <p>{t('spy.res.noneFiltered')}</p>
          <button type="button" className="btn small" onClick={() => setF(NO_FILTERS)}>
            {t('spy.res.clear')}
          </button>
        </Empty>
      ) : (
        <div className="spy-grid">
          {shown.map((a) => (
            <AdCard key={a.gkey} ad={a} sel={a.gkey === cur?.gkey} onClick={() => onSelect(a.gkey)} />
          ))}
        </div>
      )}
      <HiddenAds productId={v.product.id} />
    </section>
  );
}

function AdCard({ ad, sel, onClick }: { ad: SpyAd; sel: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const d = dayTone(ad.days);
  const line = firstLine(ad);
  return (
    <button type="button" className={`spy-ad ${sel ? 'sel' : ''} ${ad.own ? 'own' : ''}`} aria-pressed={sel} onClick={onClick}>
      <Creative ad={ad} />
      <span className="spy-ad-b">
        <span className="spy-ad-page" dir="auto">
          {ad.pageName}
        </span>
        <span className="spy-ad-text" dir="auto" lang={arLang(line)}>
          {line || '—'}
        </span>
        <span className="spy-ad-meta">
          <span className={`badge t-${d.tone}`} title={t(`spy.dayTone.${d.k}`)}>
            <Icon name="clock" /> {t('spy.daysN', { n: n(ad.days) })}
          </span>
          {ad.own && <span className="badge spy-own">{t('spy.you')}</span>}
          {ad.same === false && <span className="badge t-off">{t('spy.near')}</span>}
          {!ad.active && <span className="badge t-bad">{t('spy.stopped')}</span>}
        </span>
        <LandLine ad={ad} />
      </span>
    </button>
  );
}

/** The ads marked « pas pertinente » (to bring one back). */
function HiddenAds({ productId }: { productId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const q = useRpc('spy.hidden', { productId }, { enabled: open });
  const back = useAction('spy.hide', { success: t('spy.hid.restored') });
  const rows = q.data && open ? q.data : [];
  return (
    <details className="spy-hidden" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t('spy.hid.title')}</summary>
      {!open ? null : q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <p className="note">{t('spy.hid.none')}</p>
      ) : (
        <ul>
          {rows.map((a) => (
            <li key={a.gkey}>
              <span>
                <b dir="auto">{a.pageName}</b> · <span dir="auto">{firstLine(a) || '—'}</span>
              </span>
              <button type="button" className="btn small" disabled={back.isPending} onClick={() => back.mutate({ productId, gkey: a.gkey, hidden: false })}>
                <Icon name="undo" /> {t('spy.hid.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// ---------------------------------------------------------------- « Comment battre la concurrence »
function Brief({ v, busy }: { v: View; busy: boolean }) {
  const { t } = useTranslation();
  const productId = v.product.id;
  const auto = useAction('spy.brief', { silent: true });
  const regen = useAction('spy.brief', { success: t('spy.brief.done') });
  const asked = useRef(new Set<number>());
  const b = v.brief;
  const has = v.ads.length > 0;
  const autoRun = auto.mutate;
  // a product with ads and no brief yet: prepared once when it is opened (then kept until the next search)
  useEffect(() => {
    if (b || !has || busy || asked.current.has(productId)) return;
    asked.current.add(productId);
    autoRun({ productId });
  }, [b, has, busy, productId, autoRun]);
  const pending = auto.isPending || regen.isPending;
  const copy = async (text: string) => ((await copyText(text)) ? toast(t('spy.brief.copied'), 'ok') : toast(t('spy.copyFail'), 'bad'));
  return (
    <section className="card spy-brief" aria-labelledby="spy-brief-h" aria-busy={pending}>
      <div className="card-head">
        <h2 id="spy-brief-h">
          <Icon name="sparkles" /> {t('spy.brief.title')}
        </h2>
        <div className="row">
          {b && <span className="note">{t(b.demo ? 'spy.brief.atPlain' : 'spy.brief.at', { when: when(b.at) })}</span>}
          {has && (
            <button type="button" className="btn small" disabled={pending || busy} onClick={() => regen.mutate({ productId, refresh: true })}>
              <Icon name="refresh" /> {pending ? t('spy.brief.working') : t('spy.brief.regen')}
            </button>
          )}
        </div>
      </div>
      {!has ? (
        <Empty>{t('spy.brief.empty')}</Empty>
      ) : !b ? (
        pending ? (
          <Loading />
        ) : (
          <Empty>
            <p>{t('spy.brief.none')}</p>
            <button type="button" className="btn small primary" onClick={() => regen.mutate({ productId })}>
              <Icon name="sparkles" /> {t('spy.brief.make')}
            </button>
          </Empty>
        )
      ) : (
        <>
          <div className="spy-callout" dir="auto">
            {b.summary}
          </div>
          {b.hooks.length > 0 && (
            <div className="spy-hooks">
              <h3 className="spy-sub-h">{t('spy.brief.hooks')}</h3>
              {b.hooks.map((h, i) => (
                <div key={i} className="spy-hook">
                  <span className="spy-hook-n ltr">{i + 1}</span>
                  <p>
                    <span className="spy-hook-ar" lang="ar" dir="rtl">
                      {h.ar}
                    </span>
                    {h.fr && <small dir="auto">{h.fr}</small>}
                  </p>
                  <button type="button" className="spy-iconbtn" aria-label={t('spy.brief.copy', { n: i + 1 })} title={t('spy.brief.copy', { n: i + 1 })} onClick={() => copy(h.ar)}>
                    <Icon name="copy" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {(b.offer || b.page) && (
            <dl className="spy-kv">
              {b.offer && (
                <>
                  <dt>{t('spy.brief.offer')}</dt>
                  <dd dir="auto">{b.offer}</dd>
                </>
              )}
              {b.page && (
                <>
                  <dt>{t('spy.brief.page')}</dt>
                  <dd dir="auto">{b.page}</dd>
                </>
              )}
            </dl>
          )}
          {b.demo && (
            <p className="note">
              {t('spy.brief.plain')}{' '}
              <a className="spy-a" href="#/marketing/spy/reglages">
                {t('spy.settings')}
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the price strip
const kfmt = (v: number) => `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`;

function PriceStrip({ v, onOpen }: { v: View; onOpen: (gkey: string) => void }) {
  const { t } = useTranslation();
  const p = v.product;
  const pts = v.ads.filter((a) => !a.own && a.price);
  const head = (
    <div className="card-head">
      <h2 id="spy-price-h">
        <Icon name="wallet" /> {t('spy.price.title')}
      </h2>
      <span className="note">{t('spy.price.note')}</span>
    </div>
  );
  if (!pts.length)
    return (
      <section className="card spy-price" aria-labelledby="spy-price-h">
        {head}
        <Empty>
          <p>{t('spy.price.none')}</p>
          <small>{t('spy.price.noneHelp')}</small>
        </Empty>
      </section>
    );
  const vals = [...pts.map((a) => a.price as number), p.price, p.cost].filter((x) => x > 0);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06 || 500;
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  const x = (val: number) => `${(((val - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  const step = [500, 1000, 2000, 5000, 10000, 20000, 50000].find((s) => (hi - lo) / s <= 8) ?? 100000;
  const ticks: number[] = [];
  for (let tk = Math.ceil(lo / step) * step; tk <= hi; tk += step) ticks.push(tk);
  const used = new Map<number, number>();
  const below = pts.filter((a) => p.cost > 0 && (a.price as number) < p.cost).length;
  return (
    <section className="card spy-price" aria-labelledby="spy-price-h">
      {head}
      <div className="spy-strip-wrap">
        <div className="spy-strip" dir="ltr">
          {p.cost > 0 && <span className="spy-zone" style={{ width: x(p.cost) }} aria-hidden="true" />}
          <span className="spy-axis" aria-hidden="true" />
          {pts.map((a) => {
            const k = Math.round((a.price as number) / ((hi - lo) / 40));
            const nth = (used.get(k) ?? 0) + 1;
            used.set(k, nth);
            const label = `${a.pageName} · ${da(a.price)}${a.same === false ? ` (${t('spy.near')})` : ''}`;
            return <button key={a.gkey} type="button" className={`spy-pdot ${a.same === false ? 'near' : ''}`} style={{ left: x(a.price as number), marginTop: (nth - 1) * -20 }} title={label} aria-label={label} onClick={() => onOpen(a.gkey)} />;
          })}
          {p.price > 0 && (
            <span className="spy-pmark you" style={{ left: x(p.price) }}>
              <span>{t('spy.price.you', { v: da(p.price) })}</span>
            </span>
          )}
          {p.cost > 0 && (
            <span className="spy-pmark cost" style={{ left: x(p.cost) }}>
              <span>{t('spy.price.cost', { v: da(p.cost) })}</span>
            </span>
          )}
          {ticks.map((tk) => (
            <span key={tk} className="spy-tick" style={{ left: x(tk) }} aria-hidden="true">
              {kfmt(tk)}
            </span>
          ))}
        </div>
      </div>
      <div className="spy-legend">
        <span>
          <i className="spy-ldot" /> {t('spy.price.same')}
        </span>
        <span>
          <i className="spy-ldot near" /> {t('spy.near')}
        </span>
        {p.cost > 0 && (
          <span>
            <i className="spy-ldot zone" /> {t('spy.price.under')}
          </span>
        )}
      </div>
      <p className="note">
        {t('spy.price.foot', { count: pts.length })}
        {below ? ` ${t('spy.price.below', { count: below })}` : ''}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- followed pages and their alerts
const EV_ICON: Record<FollowedEvent['kind'], string> = { new_ad: 'plus', stopped: 'ban', price: 'tag' };

function EventText({ e }: { e: FollowedEvent }) {
  if (e.kind === 'price') return <Rich k="spy.ev.price" v={{ page: e.page, from: e.data.from ? da(e.data.from) : '—', to: e.data.to ? da(e.data.to) : '—' }} />;
  if (e.kind === 'new_ad') return <Rich k={e.data.price ? 'spy.ev.newAdPrice' : 'spy.ev.newAd'} v={{ page: e.page, price: e.data.price ? da(e.data.price) : '' }} />;
  return <Rich k="spy.ev.stopped" v={{ page: e.page }} />;
}

function Followed({ v, onOpen }: { v: View | null; onOpen: (w: Want) => void }) {
  const { t } = useTranslation();
  const q = useRpc('spy.followed', {});
  const follow = useAction('spy.follow');
  const pages = q.data?.pages ?? [];
  const events = q.data?.events ?? [];
  // pages worth following for the product on screen: competitors whose ad lasts or is copied, not followed yet
  const suggestions = useMemo(() => {
    if (!v) return [];
    const followed = new Set((q.data?.pages ?? []).map((p) => p.pageKey));
    const best = new Map<string, SpyAd>();
    for (const a of v.ads) {
      if (a.own || !a.active || a.followed || followed.has(a.pageKey)) continue;
      const b = best.get(a.pageKey);
      if (!b || a.score > b.score) best.set(a.pageKey, a);
    }
    return [...best.values()]
      .filter((a) => a.days >= 14 || a.copies >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [v, q.data]);
  const setFollow = (x: { pageKey: string; pageName: string; productId: number | null }, on: boolean) =>
    follow.mutate({ pageKey: x.pageKey, pageName: x.pageName, productId: x.productId, on }, { onSuccess: () => toast(on ? t('spy.d.followed') : t('spy.d.unfollowed'), 'ok') });
  return (
    <section className="card" aria-labelledby="spy-fol-h">
      <div className="card-head">
        <h2 id="spy-fol-h">
          <Icon name="bell" /> {t('spy.fol.title')} {pages.length > 0 && <span className="count ltr">{pages.length}</span>}
        </h2>
        <span className="note">{t('spy.fol.note')}</span>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {pages.length ? (
            <div className="spy-watch">
              {pages.map((p) => (
                <div key={p.pageKey} className="spy-w">
                  <div className="spy-w-top">
                    <b dir="auto">{p.pageName}</b>
                    {p.product && <span className="badge t-off">{p.product}</span>}
                  </div>
                  <p>
                    {t('spy.fol.active', { count: p.activeAds })}
                    {p.lastEvent ? ` · ${t('spy.fol.last', { when: when(p.lastEvent) })}` : ''}
                  </p>
                  <div className="spy-w-a">
                    {p.productId !== null && (
                      <button type="button" className="btn small" onClick={() => onOpen({ productId: p.productId as number, pageKey: p.pageKey })}>
                        <Icon name="eye" /> {t('spy.fol.see')}
                      </button>
                    )}
                    <button type="button" className="btn small ghost" disabled={follow.isPending} onClick={() => setFollow(p, false)}>
                      {t('spy.fol.stop')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="note">{t('spy.fol.none')}</p>
          )}
          {v && suggestions.length > 0 && (
            <>
              <h3 className="spy-sub-h">{t('spy.fol.suggest')}</h3>
              <div className="spy-watch">
                {suggestions.map((a) => (
                  <div key={a.pageKey} className="spy-w">
                    <div className="spy-w-top">
                      <b dir="auto">{a.pageName}</b>
                      <span className="badge t-off">{v.product.name}</span>
                    </div>
                    <p>{t('spy.fol.why', { days: n(a.days), copies: n(a.copies), score: a.score })}</p>
                    <div className="spy-w-a">
                      <button type="button" className="btn small" disabled={follow.isPending} onClick={() => setFollow({ pageKey: a.pageKey, pageName: a.pageName, productId: v.product.id }, true)}>
                        <Icon name="bell" /> {t('spy.d.follow')}
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => onOpen({ productId: v.product.id, gkey: a.gkey })}>
                        <Icon name="eye" /> {t('spy.fol.seeAd')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <h3 className="spy-sub-h">{t('spy.fol.alerts')}</h3>
          {events.length ? (
            <ul className="spy-events">
              {events.map((e) => (
                <li key={e.id}>
                  <button type="button" className="spy-ev" disabled={e.productId === null} onClick={() => e.productId !== null && onOpen({ productId: e.productId, gkey: e.gkey })}>
                    <span className={`spy-ev-i ${e.kind}`} aria-hidden="true">
                      <Icon name={EV_ICON[e.kind] ?? 'info'} />
                    </span>
                    <span className="spy-ev-t">
                      <span>
                        <EventText e={e} />
                      </span>
                      <small>
                        {e.product ? (
                          <>
                            <bdi>{e.product}</bdi> ·{' '}
                          </>
                        ) : null}
                        {when(e.at)}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">{t('spy.fol.noAlerts')}</p>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- where the data comes from
function Sources({ v, source }: { v: View | null; source: string }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-labelledby="spy-srcs-h">
      <div className="card-head">
        <h2 id="spy-srcs-h">
          <Icon name="info" /> {t('spy.src.title')}
        </h2>
        {v?.product.scannedAt && <span className="note">{t('spy.src.scanned', { when: when(v.product.scannedAt) })}</span>}
      </div>
      <div className="spy-src-note">
        <div className="spy-src-box">
          <h3>
            <i className="spy-fbdot" aria-hidden="true" /> {t('spy.src.fbTitle')}
          </h3>
          <p>{t('spy.src.fb')}</p>
          <p className="note">{t('spy.src.noSpend')}</p>
        </div>
        <div className="spy-src-box">
          <h3>
            <Icon name={source === 'extension' ? 'puzzle' : 'globe'} /> {t(`spy.set.src.${source}.name`)}
          </h3>
          <p>{t(`spy.src.via.${source}`)}</p>
          <p className="note">{v?.ai ? t('spy.src.aiOn') : t('spy.src.aiOff')}</p>
          <a className="spy-a" href="#/marketing/spy/reglages">
            {t('spy.src.change')}
          </a>
        </div>
      </div>
    </section>
  );
}
