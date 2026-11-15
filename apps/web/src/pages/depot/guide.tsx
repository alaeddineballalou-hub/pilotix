// The sales guide of a product (Guide de vente): written by the team in the product form (tab « Guide de vente ») or in
// Produits & stock › Guide de vente, with « Écrire avec l'IA » for a first draft, the size guide (age and weight for each
// size) when the product has a size option, a small one (age, weight, measures) when it has one size only, fixed
// questions to pick, and the products to offer picked in the catalog;
// the confirmation agencies write it too for their products. The agents read it during a call (the « Guide » button on
// each product of the order opens it beside the order, without hiding it) and in Produits & stock, in the app's language:
// Pilot AI translates each line after a save, the team corrects the translations in the editor's language tabs, and the
// original words stay one click away. Dellal and CM AI read the original guide.
import { ReactNode, TextareaHTMLAttributes, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, dateOnly, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Seller, useScope } from '../../lib/seller';
import { useIsPhone } from '../../lib/useMedia';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/toast';
import { hdPhoto } from '../messages/photo';
import './guide.css';

export interface GuidePair {
  q: string;
  a: string;
  /** the pictures that go with this answer (their ids): Dellal sends them to the customer when it gives it */
  photos?: number[];
}
/**
 * A picture of an answer, in the form: one already saved (id), or one just picked, waiting for the guide's save (send:
 * what leaves then). thumb: its small copy for the screen.
 */
export interface GuidePic {
  key: string;
  thumb: string;
  id?: number;
  send?: { data: string; w: number; h: number; thumb: string; mini: string };
}
/** an answer in the form: its words and its pictures */
export interface GuideFormPair {
  q: string;
  a: string;
  pics: GuidePic[];
}
/** the pictures of a guide's answers: id → a small copy */
export type GuidePics = Record<number, string>;
/** one size (a value of the product's « Taille » option) with the age and the weight it fits */
export interface GuideSize {
  size: string;
  age: string;
  weight: string;
}
/** the small size guide of a product with one size only: the age and the weight it fits, how big it is */
export interface GuideFit {
  age: string;
  weight: string;
  measures: string;
}
/** a product offered on top (Vente en plus), as the server gives it with the guide */
export interface UpsellProduct {
  id: number;
  name: string;
  price: number;
  photo: string | null;
}
/** the languages a guide is written in (Darija: Algerian, in Latin letters), and the ones the app is read in */
export type GuideLang = 'fr' | 'ar' | 'dz' | 'en';
export type ReadLang = 'fr' | 'ar' | 'en';
export const READ_LANGS: ReadLang[] = ['fr', 'ar', 'en'];
export const readLang = (l: string | undefined): ReadLang => (l?.startsWith('ar') ? 'ar' : l?.startsWith('en') ? 'en' : 'fr');
/** the guide in each other reading language: one of its lines → the translation (Pilot AI's, or the team's) */
export type GuideTr = Partial<Record<ReadLang, Record<string, string>>>;
export interface Guide {
  brief: string;
  strengths: string[];
  faq: GuidePair[];
  doubts: GuidePair[];
  upsell: string;
  upsellIds: number[];
  never: string[];
  sizes: GuideSize[];
  fit: GuideFit;
  lang: GuideLang;
}
/** The form: the one-per-line parts as plain text, the translations as the team corrects them (trBase: as loaded). */
export interface GuideForm {
  brief: string;
  strengths: string;
  faq: GuideFormPair[];
  doubts: GuideFormPair[];
  upsell: string;
  upsellIds: number[];
  never: string;
  sizes: GuideSize[];
  fit: GuideFit;
  lang: GuideLang;
  tr: GuideTr;
  trBase: GuideTr;
}

/** An answer the AI could not know: the team writes it (the AI agents never use it). */
export const TO_FILL = '[À compléter]';
const TO_FILL_RE = /\[\s*(?:à|a)\s+compl[ée]ter\s*\]/i;
export const toFill = (s: string) => TO_FILL_RE.test(s) || !s.trim();
/**
 * The guide's room (the same as the server's, modules/guide.ts): every part takes what the team writes — no size for a
 * line, no count of lines. One ceiling only, for the whole guide (`total`): Dellal reads all of it each time it opens it.
 * Nothing is counted on screen while a guide is of an ordinary length. `long`: past it the editor says that a longer
 * guide costs more at each answer (nothing is blocked); `near`: past it, it shows how far the ceiling is. `perAnswer`:
 * the pictures of one answer (what one message carries); `pictures`: of the whole guide.
 */
export const GUIDE_MAX = { lines: 500, upsellIds: 10, sizes: 40, long: 15_000, near: 40_000, total: 50_000, perAnswer: 6, pictures: 60 };
/** The option that holds the sizes (the same as the server's): its values get an age and a weight. */
const SIZE_OPTION = /taille|size|pointure|mesure|âge|\bage\b|مقاس|القياس|العمر/i;
const COLOR_OPTION = /couleur|color|colour|لون|الألوان/i;
type Option = { name: string; values: string[] };
export const sizeValues = (options: Option[] | null | undefined): string[] =>
  [...new Set((options ?? []).filter((o) => SIZE_OPTION.test(o.name)).flatMap((o) => o.values.map((v) => v.trim()).filter(Boolean)))].slice(0, GUIDE_MAX.sizes);
/** Is this option the product's sizes (Taille, Pointure, Âge…): its values are the size guide's lines. */
export const isSizeOption = (name: string) => SIZE_OPTION.test(name);

export const EMPTY_FIT: GuideFit = { age: '', weight: '', measures: '' };
/** Is something written in the small size guide. */
export const fitFilled = (f: GuideFit | null | undefined) => !!f && !!(f.age || f.weight || f.measures);

const lines = (s: string) => s.split('\n').map((x) => x.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A size renamed in the product's options (« 0-3 mois » → « 0-3 m »): its line of the size guide follows (age, weight). */
export const renameGuideSize = (f: GuideForm, from: string, to: string): GuideForm =>
  f.sizes.some((x) => same(x.size, from)) ? { ...f, sizes: f.sizes.map((x) => (same(x.size, from) ? { ...x, size: to } : x)) } : f;
const copyTr = (tr: GuideTr | null | undefined): GuideTr => Object.fromEntries(Object.entries(tr ?? {}).map(([l, m]) => [l, { ...m }]));
const formPair = (p: GuidePair, pics: GuidePics): GuideFormPair => ({ q: p.q, a: p.a, pics: (p.photos ?? []).filter((x) => pics[x]).map((x) => ({ key: `s${x}`, id: x, thumb: pics[x] })) });
/** lang: the language of a new guide (the writer's); pics: the small copies of its answers' pictures */
export const guideToForm = (g: Guide | null | undefined, tr?: GuideTr | null, lang: GuideLang = 'fr', pics: GuidePics = {}): GuideForm => ({
  brief: g?.brief ?? '',
  strengths: (g?.strengths ?? []).join('\n'),
  faq: (g?.faq ?? []).map((p) => formPair(p, pics)),
  doubts: (g?.doubts ?? []).map((p) => formPair(p, pics)),
  upsell: g?.upsell ?? '',
  upsellIds: [...(g?.upsellIds ?? [])],
  never: (g?.never ?? []).join('\n'),
  sizes: (g?.sizes ?? []).map((x) => ({ ...x })),
  fit: { ...EMPTY_FIT, ...(g?.fit ?? {}) },
  lang: g?.lang ?? lang,
  tr: copyTr(tr),
  trBase: copyTr(tr),
});
const savedPair = (p: GuideFormPair): GuidePair => ({ q: p.q.trim(), a: p.a.trim(), photos: p.pics.flatMap((x) => (x.id ? [x.id] : [])) });
/**
 * sizes: the product's sizes now (a size it no longer has leaves the guide; a product with sizes has no small size
 * guide, one without has no size lines); undefined: keep them all. An answer's pictures: the saved ones it still has
 * (always said, even none: the save removes the ones taken off); the ones just picked leave after it (sendGuidePics).
 */
export const formToGuide = (f: GuideForm, sizes?: string[]): Guide => ({
  brief: f.brief.trim(),
  strengths: lines(f.strengths),
  faq: f.faq.map(savedPair).filter((p) => p.q),
  doubts: f.doubts.map(savedPair).filter((p) => p.q),
  upsell: f.upsell.trim(),
  upsellIds: [...new Set(f.upsellIds)].slice(0, GUIDE_MAX.upsellIds),
  never: lines(f.never),
  sizes: f.sizes
    .map((x) => ({ size: x.size.trim(), age: x.age.trim(), weight: x.weight.trim() }))
    .filter((x) => x.size && (x.age || x.weight) && (!sizes || sizes.some((y) => same(y, x.size)))),
  fit: sizes?.length ? EMPTY_FIT : { age: f.fit.age.trim(), weight: f.fit.weight.trim(), measures: f.fit.measures.trim() },
  lang: f.lang,
});

/** The guide's lines to translate, each once and in order (the same as the server's, modules/guide.ts). */
export function guideSources(g: Guide): string[] {
  const all = [
    g.brief,
    ...g.sizes.flatMap((x) => [x.age, x.weight]),
    g.fit.age,
    g.fit.weight,
    g.fit.measures,
    ...g.strengths,
    ...g.faq.flatMap((p) => [p.q, p.a]),
    ...g.doubts.flatMap((p) => [p.q, p.a]),
    g.upsell,
    ...g.never,
  ];
  return [...new Set(all.map((x) => x.trim()).filter((x) => x && !toFill(x)))];
}
/** The reading languages a guide is translated into: all but its own. */
export const trTargets = (lang: GuideLang) => READ_LANGS.filter((l) => l !== lang);
/** The team's corrections to save: the lines changed in the tabs (emptied: Pilot AI translates them again). */
export function formTr(f: GuideForm, g: Guide): GuideTr {
  const src = guideSources(g);
  const out: GuideTr = {};
  for (const l of trTargets(g.lang)) {
    const changed = src.filter((x) => (f.tr[l]?.[x] ?? '').trim() !== (f.trBase[l]?.[x] ?? '').trim());
    if (changed.length) out[l] = Object.fromEntries(changed.map((x) => [x, (f.tr[l]?.[x] ?? '').trim()]));
  }
  return out;
}
/** The guide in another language: each line through its translation (a line not translated yet stays as written). */
export function inLang(g: Guide, tr: Record<string, string>): Guide {
  const t = (x: string) => (x && !toFill(x) ? tr[x.trim()] ?? x : x);
  return {
    ...g,
    brief: t(g.brief),
    strengths: g.strengths.map(t),
    faq: g.faq.map((p) => ({ ...p, q: t(p.q), a: t(p.a) })),
    doubts: g.doubts.map((p) => ({ ...p, q: t(p.q), a: t(p.a) })),
    upsell: t(g.upsell),
    never: g.never.map(t),
    sizes: g.sizes.map((x) => ({ ...x, age: t(x.age), weight: t(x.weight) })),
    fit: { age: t(g.fit.age), weight: t(g.fit.weight), measures: t(g.fit.measures) },
  };
}
const sizeOf = (g: Guide) =>
  g.brief.length +
  g.upsell.length +
  [...g.strengths, ...g.never].reduce((a, x) => a + x.length, 0) +
  [...g.faq, ...g.doubts].reduce((a, p) => a + p.q.length + p.a.length, 0) +
  g.sizes.reduce((a, x) => a + x.size.length + x.age.length + x.weight.length, 0) +
  g.fit.age.length +
  g.fit.weight.length +
  g.fit.measures.length;
export const guideIsEmpty = (g: Guide) => !g.brief && !g.strengths.length && !g.faq.length && !g.doubts.length && !g.upsell && !g.upsellIds.length && !g.never.length && !g.sizes.length && !fitFilled(g.fit);

/** The pictures picked in the form and not sent yet, each with the answer (its part, its question) it goes with. */
export const guideWaiting = (f: GuideForm) =>
  (['faq', 'doubts'] as const).flatMap((part) => f[part].flatMap((p) => (p.q.trim() ? p.pics.flatMap((x) => (x.send ? [{ part, q: p.q.trim(), send: x.send }] : [])) : [])));

/**
 * Once the guide is saved: its new pictures leave one by one, each for its answer (the server finds it by its
 * question). The first refusal stops the rest; returns how many did not leave and why.
 */
export async function sendGuidePics(productId: number, f: GuideForm, seller: Seller | null | undefined, onStep?: (done: number, total: number) => void): Promise<{ failed: number; error: string | null }> {
  const todo = guideWaiting(f);
  let done = 0;
  for (const x of todo) {
    try {
      await rpc('catalog.guidePhotoAdd', { id: productId, part: x.part, q: x.q, ...x.send }, seller);
    } catch (e) {
      return { failed: todo.length - done, error: (e as Error)?.message || null };
    }
    onStep?.(++done, todo.length);
  }
  return { failed: 0, error: null };
}

/** What would stop the save (the server says the same), in words, or null. */
export function guideProblem(g: Guide, t: (k: string, o?: any) => string): string | null {
  const M = GUIDE_MAX;
  for (const k of ['strengths', 'never', 'faq', 'doubts'] as const) if (g[k].length > M.lines) return t('produits.guide.ed.tooMany', { part: t(`produits.guide.${k}`), max: M.lines });
  const total = sizeOf(g);
  if (total > M.total) return t('produits.guide.ed.tooBig', { n: n(total), max: n(M.total) });
  return null;
}

// ---------------------------------------------------------------- an answer's pictures
/** the whole pictures already opened: id → its address (a link good for ten minutes: kept nine) */
const WHOLE = new Map<number, { src: string; at: number }>();
const wholeOf = (id: number) => {
  const x = WHOLE.get(id);
  return x && Date.now() - x.at < 9 * 60_000 ? x.src : null;
};

/**
 * A picture opened big, over everything (the guide beside an order, the product form): its small copy first, then the
 * whole picture; the others of the same answer one arrow away. A tap on it (or the magnifier) brings it closer, to read
 * a size table on a phone; it then moves under the finger. Closes with Escape, the × or a tap outside.
 */
function PicViewer({ items, start, onClose }: { items: GuidePic[]; start: number; onClose: () => void }) {
  const { t } = useTranslation();
  const seller = useScope();
  const [at, setAt] = useState(Math.min(Math.max(0, start), items.length - 1));
  const [state, setState] = useState<{ key: string; src: string | null; error: boolean }>({ key: '', src: null, error: false });
  const [turn, setTurn] = useState(0);
  // closer: `fit` is its width as it fits the screen, `room` whether it has more to show than that
  const [big, setBig] = useState(false);
  const [fit, setFit] = useState<{ w: number; full: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const shut = useRef<HTMLButtonElement>(null);
  // (the page under it may draw again while it is open: its keys and its focus do not start over for that)
  const close = useRef(onClose);
  close.current = onClose;
  const it = items[at];
  const many = items.length > 1;
  const go = useCallback((d: number) => setAt((x) => (x + d + items.length) % items.length), [items.length]);
  // the whole picture: the one just picked is here; a saved one is asked for (once)
  useEffect(() => {
    setBig(false);
    setFit(null);
    if (!it) return;
    const local = it.send ? `data:image/jpeg;base64,${it.send.data}` : it.id ? wholeOf(it.id) : it.thumb;
    setState({ key: it.key, src: local, error: false });
    if (local || !it.id) return;
    let alive = true;
    const id = it.id;
    rpc('catalog.guidePhoto', { id }, seller)
      .then((r) => {
        WHOLE.set(id, { src: r.src, at: Date.now() });
        if (alive) setState({ key: it.key, src: r.src, error: false });
      })
      .catch(() => alive && setState({ key: it.key, src: null, error: true }));
    return () => {
      alive = false;
    };
  }, [it?.key, turn]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape and the arrows are this picture's while it is open (the form under it keeps its own Escape for later)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && !(many && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.key === 'Escape') return close.current();
      const rtl = document.documentElement.dir === 'rtl';
      go((e.key === 'ArrowRight') !== rtl ? 1 : -1);
    };
    window.addEventListener('keydown', k, true);
    const prev = document.activeElement as HTMLElement | null;
    shut.current?.focus();
    document.documentElement.classList.add('gd-zoom');
    return () => {
      window.removeEventListener('keydown', k, true);
      document.documentElement.classList.remove('gd-zoom');
      prev?.focus?.();
    };
  }, [go, many]);
  // brought closer: its middle stays in the middle
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !big) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2 * (document.documentElement.dir === 'rtl' ? -1 : 1);
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [big]);
  if (!it) return null;
  const ready = state.key === it.key ? state : { key: it.key, src: null, error: false };
  const room = !!ready.src && !!fit && fit.full > fit.w * 1.15;
  const closer = big && room;
  return createPortal(
    <div className={`gd-zoom-wrap ${many ? 'is-many' : ''}`} role="dialog" aria-modal="true" aria-label={t('produits.guide.pics.title')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gd-zoom-bar">
        {many && (
          <span className="gd-zoom-n ltr" aria-live="polite">
            {at + 1} / {items.length}
          </span>
        )}
        {room && (
          <button type="button" className="gd-zoom-b" aria-pressed={closer} aria-label={t(closer ? 'produits.guide.pics.zoomOut' : 'produits.guide.pics.zoomIn')} onClick={() => setBig((x) => !x)}>
            <Icon name={closer ? 'zoomout' : 'zoomin'} />
          </button>
        )}
        <button ref={shut} type="button" className="gd-zoom-b" aria-label={t('common.close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div ref={stage} className={`gd-zoom-stage ${closer ? 'is-big' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {ready.error ? (
          <div className="gd-zoom-msg" role="alert">
            <p>{t('produits.guide.pics.openFailed')}</p>
            <button type="button" className="btn" onClick={() => setTurn((x) => x + 1)}>
              {t('common.retry')}
            </button>
          </div>
        ) : (
          <>
            {/* its small copy holds the place (and shows what is coming) until the whole picture is there */}
            <img
              key={it.key}
              className={`gd-zoom-img ${ready.src ? '' : 'is-wait'} ${room ? (closer ? 'is-out' : 'is-in') : ''}`}
              style={closer ? { inlineSize: Math.min(fit!.full, Math.round(fit!.w * 2.5)) } : undefined}
              src={ready.src ?? it.thumb}
              alt=""
              onLoad={(e) => ready.src && !big && setFit({ w: e.currentTarget.getBoundingClientRect().width, full: e.currentTarget.naturalWidth })}
              onClick={() => room && setBig((x) => !x)}
              onError={() => ready.src && it.id && (WHOLE.delete(it.id), setState({ key: it.key, src: null, error: true }))}
            />
            {!ready.src && (
              <span className="gd-zoom-load" role="status">
                {t('produits.guide.pics.opening')}
              </span>
            )}
          </>
        )}
      </div>
      {many && (
        <>
          <button type="button" className="gd-zoom-b gd-zoom-prev" aria-label={t('produits.guide.pics.prev')} onClick={() => go(-1)}>
            <Icon name="chevl" />
          </button>
          <button type="button" className="gd-zoom-b gd-zoom-next" aria-label={t('produits.guide.pics.next')} onClick={() => go(1)}>
            <Icon name="chevr" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * The pictures of one answer, small: each opens big. onRemove: the writer takes one off (the editor); children: what
 * follows them on the same line (the editor's « Préparation de l'image… »).
 */
function PicRow({ items, onRemove, children }: { items: GuidePic[]; onRemove?: (key: string) => void; children?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length && !children) return null;
  return (
    <div className="gd-pics">
      {items.map((x, k) => (
        <span key={x.key} className={`gd-pic ${x.send ? 'is-new' : ''}`}>
          <button type="button" className="gd-pic-b" aria-label={t('produits.guide.pics.open', { n: k + 1 })} onClick={() => setOpen(k)}>
            <img src={x.thumb} alt="" loading="lazy" />
          </button>
          {onRemove && (
            <button type="button" className="gd-pic-x" aria-label={t('produits.guide.pics.remove', { n: k + 1 })} onClick={() => onRemove(x.key)}>
              <Icon name="x" />
            </button>
          )}
        </span>
      ))}
      {children}
      {open !== null && items[open] && <PicViewer items={items} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
/** An answer's saved pictures, as the reader gets them (ids and their small copies). */
const picsOf = (ids: number[] | undefined, pics: GuidePics): GuidePic[] => (ids ?? []).filter((x) => pics[x]).map((x) => ({ key: `s${x}`, id: x, thumb: pics[x] }));

// ---------------------------------------------------------------- reading (agents, during the call)
/**
 * The guide's parts, for reading fast during a call: the brief, the size guide, then each part with what it holds. tr:
 * its lines in the reader's language (null: written in it); the original words are one click away. onTranslate: a
 * writer's « Traduire maintenant » when nothing is translated yet. pics: the small copies of its answers' pictures (the
 * ones Dellal sends with that answer): each opens big.
 */
export function GuideView({
  guide: original,
  id,
  upsell = [],
  pics = {},
  tr = null,
  trMissing = 0,
  onTranslate,
  translating = false,
}: {
  guide: Guide;
  id: string;
  upsell?: UpsellProduct[];
  pics?: GuidePics;
  tr?: Record<string, string> | null;
  trMissing?: number;
  onTranslate?: () => void;
  translating?: boolean;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [asWritten, setAsWritten] = useState(false);
  const has = !!tr && Object.keys(tr).length > 0;
  const guide = has && !asWritten ? inLang(original, tr!) : original;
  // one size only: its small size guide (the lines written)
  const fit = guide.sizes.length || !guide.fit ? [] : (['age', 'weight', 'measures'] as const).filter((k) => guide.fit[k] && !toFill(guide.fit[k]));
  const parts = [
    { k: 'sizes', icon: 'shirt', n: guide.sizes.length || (fit.length ? 1 : 0) },
    { k: 'strengths', icon: 'check', n: guide.strengths.length },
    { k: 'faq', icon: 'help', n: guide.faq.length },
    { k: 'doubts', icon: 'message', n: guide.doubts.length },
    { k: 'upsell', icon: 'gift', n: guide.upsell || upsell.length ? 1 : 0 },
    { k: 'never', icon: 'ban', n: guide.never.length },
  ].filter((p) => p.n > 0);
  // to a part, just under the parts bar that stays at the top
  const go = (k: string) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-part="${k}"]`);
    const sc = box.current?.closest<HTMLElement>('.gd-body, .gd-detail-body, .pxk-body');
    if (!el || !sc) return el?.scrollIntoView({ block: 'start' });
    const bar = box.current?.querySelector<HTMLElement>('.gd-jump')?.offsetHeight ?? 0;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    sc.scrollTo({ top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - bar - 6, behavior: reduce ? 'auto' : 'smooth' });
  };
  const head = (k: string, icon: string, count?: number) => (
    <h3 className="gd-h">
      <Icon name={icon} />
      {t(`produits.guide.${k}`)}
      {count !== undefined && count > 1 && <span className="gd-n ltr">{count}</span>}
    </h3>
  );
  return (
    <div className="gd-view" ref={box}>
      {tr && (
        <p className="gd-lang" role="status">
          <Icon name="languages" />
          <span>
            {!has ? t('produits.guide.tr.none') : asWritten ? t(`produits.guide.tr.as_${original.lang}`) : t(`produits.guide.tr.from_${original.lang}`)}
            {has && !asWritten && trMissing > 0 && <> · {t('produits.guide.tr.missing', { count: trMissing })}</>}
          </span>
          {has ? (
            <button type="button" className="linkish" aria-pressed={asWritten} onClick={() => setAsWritten(!asWritten)}>
              {asWritten ? t('produits.guide.tr.seeTr') : t('produits.guide.tr.seeOriginal')}
            </button>
          ) : (
            onTranslate && (
              <button type="button" className="linkish" disabled={translating} onClick={onTranslate}>
                {translating ? t('produits.guide.tr.working') : t('produits.guide.tr.now')}
              </button>
            )
          )}
        </p>
      )}
      {guide.brief && !toFill(guide.brief) && <p className="gd-brief" dir="auto">{guide.brief}</p>}
      {parts.length > 2 && (
        <nav className="gd-jump" aria-label={t('produits.guide.jump')}>
          {parts.map((p) => (
            <button key={p.k} type="button" className="gd-jump-b" onClick={() => go(p.k)} aria-controls={`${id}-${p.k}`}>
              {t(`produits.guide.${p.k}`)}
              {p.k !== 'upsell' && p.n > 1 && <span className="ltr">{p.n}</span>}
            </button>
          ))}
        </nav>
      )}
      {guide.sizes.length > 0 && (
        <section className="gd-sec" data-part="sizes" id={`${id}-sizes`}>
          {head('sizes', 'shirt')}
          <p className="gd-hint">{t('produits.guide.sizesAsk')}</p>
          <table className="gd-sizes">
            <thead>
              <tr>
                <th scope="col">{t('produits.guide.sizeCol')}</th>
                <th scope="col">{t('produits.guide.ageCol')}</th>
                <th scope="col">{t('produits.guide.weightCol')}</th>
              </tr>
            </thead>
            <tbody>
              {guide.sizes.map((x) => (
                <tr key={x.size}>
                  <th scope="row" dir="auto">{x.size}</th>
                  <td dir="auto">{x.age || '—'}</td>
                  <td dir="auto">{x.weight || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {fit.length > 0 && (
        <section className="gd-sec" data-part="sizes" id={`${id}-sizes`}>
          {head('sizes', 'shirt')}
          <p className="gd-hint">{t('produits.guide.fitAsk')}</p>
          <table className="gd-sizes gd-fit">
            <tbody>
              {fit.map((k) => (
                <tr key={k}>
                  <th scope="row">{t(`produits.guide.${k}Col`)}</th>
                  <td>
                    <bdi>{guide.fit[k]}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {guide.strengths.length > 0 && (
        <section className="gd-sec" data-part="strengths" id={`${id}-strengths`}>
          {head('strengths', 'check')}
          <ul className="gd-points">
            {guide.strengths.map((x, k) => (
              <li key={k} className={toFill(x) ? 'gd-fill' : ''} dir="auto">
                {toFill(x) ? t('produits.guide.toFillPoint') : x}
              </li>
            ))}
          </ul>
        </section>
      )}
      {guide.faq.length > 0 && (
        <section className="gd-sec" data-part="faq" id={`${id}-faq`}>
          {head('faq', 'help', guide.faq.length)}
          <dl className="gd-qa">
            {guide.faq.map((p, k) => (
              <div key={k} className="gd-pair">
                <dt dir="auto">{p.q}</dt>
                <dd className={toFill(p.a) ? 'gd-fill' : ''} dir="auto">{toFill(p.a) ? t('produits.guide.toFill') : p.a}</dd>
                {!!p.photos?.length && (
                  <dd className="gd-pics-dd">
                    <PicRow items={picsOf(p.photos, pics)} />
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </section>
      )}
      {guide.doubts.length > 0 && (
        <section className="gd-sec" data-part="doubts" id={`${id}-doubts`}>
          {head('doubts', 'message', guide.doubts.length)}
          <dl className="gd-qa gd-doubts">
            {guide.doubts.map((p, k) => (
              <div key={k} className="gd-pair">
                <dt>
                  <span className="gd-says">{t('produits.guide.says')}</span> <bdi>{p.q}</bdi>
                </dt>
                <dd className={toFill(p.a) ? 'gd-fill' : ''} dir="auto">{toFill(p.a) ? t('produits.guide.toFill') : p.a}</dd>
                {!!p.photos?.length && (
                  <dd className="gd-pics-dd">
                    <PicRow items={picsOf(p.photos, pics)} />
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </section>
      )}
      {(guide.upsell || upsell.length > 0) && (
        <section className="gd-sec" data-part="upsell" id={`${id}-upsell`}>
          {head('upsell', 'gift')}
          {upsell.length > 0 && (
            <ul className="gd-offers">
              {upsell.map((p) => (
                <li key={p.id}>
                  <span className="gd-offer-thumb" aria-hidden="true">
                    {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <Icon name="package" />}
                  </span>
                  <b dir="auto">{p.name}</b>
                  <span className="ltr">{da(p.price)}</span>
                </li>
              ))}
            </ul>
          )}
          {guide.upsell && <p className="gd-text" dir="auto">{guide.upsell}</p>}
        </section>
      )}
      {guide.never.length > 0 && (
        <section className="gd-sec gd-never" data-part="never" id={`${id}-never`}>
          {head('never', 'ban')}
          <ul>
            {guide.never.map((x, k) => (
              <li key={k} dir="auto">{x}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// one guide open at a time on the screen: opening another one closes the first
let openKey: string | null = null;
const subs = new Set<() => void>();
const setOpenKey = (k: string | null) => {
  openKey = k;
  subs.forEach((f) => f());
};
const useOpenKey = () =>
  useSyncExternalStore(
    (cb) => (subs.add(cb), () => void subs.delete(cb)),
    () => openKey,
  );

/**
 * « Guide »: opens the product's sales guide. On a computer it stands beside the page (the order stays usable during the
 * call); on a phone it rises from the bottom.
 */
export function GuideButton({ productId, className = '', label, icon = true }: { productId: number; className?: string; label?: ReactNode; icon?: boolean }) {
  const { t } = useTranslation();
  const key = useId();
  const open = useOpenKey() === key;
  const close = useCallback(() => {
    if (openKey === key) setOpenKey(null);
  }, [key]);
  useEffect(() => () => close(), [close]);
  return (
    <>
      <button type="button" className={`gd-btn ${open ? 'on' : ''} ${className}`} aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpenKey(open ? null : key))}>
        {icon && <Icon name="book" />}
        {label ?? t('produits.guide.open')}
      </button>
      {open && <GuidePanel productId={productId} onClose={close} />}
    </>
  );
}

function GuidePanel({ productId, onClose }: { productId: number; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const phone = useIsPhone();
  const id = useId().replace(/:/g, '');
  const q = useRpc('catalog.guide', { id: productId, lang: readLang(i18n.language) }, { staleTime: 60_000 });
  const d = q.data;
  const meta = d?.updatedAt ? (d.updatedBy ? t('produits.guide.updated', { date: dateOnly(d.updatedAt), name: d.updatedBy }) : t('produits.guide.updatedNoName', { date: dateOnly(d.updatedAt) })) : null;
  const body = q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !d ? <Loading /> : d.guide ? <GuideView guide={d.guide} id={id} upsell={d.upsell} pics={d.pics} tr={d.tr} trMissing={d.trMissing} /> : <Empty>{t('produits.guide.empty')}</Empty>;
  if (phone)
    return (
      <Sheet title={d?.name ?? t('produits.guide.title')} sub={[t('produits.guide.title'), meta].filter(Boolean).join(' · ')} onClose={onClose} tall className="gd-sheet">
        {body}
      </Sheet>
    );
  return <SidePanel title={d?.name ?? '…'} photo={d?.photo ?? null} meta={meta} onClose={onClose} label={t('produits.guide.title')}>{body}</SidePanel>;
}

/** Beside the page, not over it: the order under it can still be read and changed. Échap (inside it) or × closes it. */
function SidePanel({ title, photo, meta, label, onClose, children }: { title: ReactNode; photo: string | null; meta: string | null; label: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const hid = useId();
  // under the top bar, and the page makes room for it on a wide screen (html.gd-open): nothing of the order is hidden
  const [top, setTop] = useState(12);
  useLayoutEffect(() => {
    const place = () => setTop(Math.max(12, Math.round((document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 10)));
    place();
    window.addEventListener('resize', place);
    document.documentElement.classList.add('gd-open');
    return () => {
      window.removeEventListener('resize', place);
      document.documentElement.classList.remove('gd-open');
    };
  }, []);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (ref.current?.contains(document.activeElement)) prev?.focus?.({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <aside
      ref={ref}
      className="gd-panel"
      style={{ top }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={hid}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="gd-head">
        <span className="gd-thumb" aria-hidden="true">
          {photo ? <img src={photo} alt="" /> : <Icon name="package" />}
        </span>
        <div className="gd-tt">
          <h2 id={hid} dir="auto">{title}</h2>
          <span className="gd-meta">{[label, meta].filter(Boolean).join(' · ')}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="x" />
        </button>
      </header>
      <div className="gd-body">{children}</div>
    </aside>,
    document.body,
  );
}

// ---------------------------------------------------------------- writing (the product form's tab)
export interface DraftFacts {
  productId?: number;
  name: string;
  brand?: string;
  description?: string;
  price?: number;
  variants: string[];
  packs: { qty: number; price: number }[];
  linked: string[];
  services: { name: string; price: number }[];
  /** Taille, Couleur…: the sizes get a line in the size guide, the colours answer « Quelles couleurs ? » */
  options?: Option[];
  /** Produits liés: the draft's Vente en plus picks them */
  linkedIds?: number[];
}
/** Does the browser give a text box the height of its text by itself (CSS field-sizing, guide.css)? */
const SELF_SIZED = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
/** What a field scrolls in (the form, the sheet, the page). */
const scrollerOf = (el: HTMLElement): HTMLElement | null => {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return document.scrollingElement as HTMLElement | null;
};
/**
 * A text box as tall as what is written in it (up to most of the screen, guide.css; then it scrolls): a long answer is
 * read whole, not through a two-line window. Most browsers do it by themselves; in the others its height is measured
 * here, when its text or its width changes (and when its tab opens: a closed tab has no size).
 */
function Area(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !el.offsetParent) return;
    const sc = scrollerOf(el);
    const top = sc?.scrollTop ?? 0;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    if (sc && sc.scrollTop !== top) sc.scrollTop = top; // the form stays where it was
  }, []);
  useLayoutEffect(() => {
    if (!SELF_SIZED) fit();
  }, [fit, props.value]);
  useEffect(() => {
    const el = ref.current;
    if (SELF_SIZED || !el || typeof ResizeObserver === 'undefined') return;
    let width = -1;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // its height only (set here): nothing to measure again
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fit]);
  return <textarea ref={ref} {...props} />;
}

const LANGS: GuideLang[] = ['fr', 'ar', 'dz', 'en'];
/** The questions every guide can pick (in this order), and the answers Pilotix knows for them. */
const FIXED = ['pay', 'delivery', 'delay', 'colors', 'size', 'age', 'weight', 'measures', 'warranty', 'exchange', 'quality', 'assembled', 'use'] as const;
type Fixed = (typeof FIXED)[number];

/**
 * The guide's parts as a form, with « Écrire avec l'IA » (a first draft to correct; nothing is saved before
 * Enregistrer). products: what Vente en plus can pick (this shop's, the writer's ones). An answer (a question's, a
 * hesitation's) takes pictures: Dellal sends them to the customer with that answer; the ones just picked wait here and
 * leave once the guide is saved (sendGuidePics). pictures: false where no picture can be kept (a server whose photo
 * storage is not set): the ones already there stay, none is added.
 */
export function GuideEditor({
  value,
  onChange,
  facts,
  products,
  pictures = true,
}: {
  value: GuideForm;
  onChange: (v: GuideForm) => void;
  facts: () => DraftFacts;
  products: { id: number; name: string }[];
  pictures?: boolean;
}) {
  const { t } = useTranslation();
  const seller = useScope();
  const lang = value.lang;
  // the guide as written (its own language), or its translation into one of the other reading languages
  const [view, setView] = useState<'main' | ReadLang>('main');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ before: GuideForm; by: 'ai' | 'rules' } | null>(null);
  const [find, setFind] = useState('');
  const [phrase, setPhrase] = useState(!!value.upsell);
  const set = <K extends keyof GuideForm>(k: K, v: GuideForm[K]) => onChange({ ...value, [k]: v });
  const f = facts();
  const sizes = sizeValues(f.options);
  const g = formToGuide(value, sizes);
  const missing = [...g.faq, ...g.doubts].filter((p) => toFill(p.a)).length + g.strengths.filter((x) => toFill(x)).length;
  const size = sizeOf(g);
  const draft = async () => {
    if (!f.name) return toast(t('produits.guide.ed.needName'), 'bad');
    setBusy(true);
    try {
      const r = await rpc('catalog.guideDraft', { ...f, lang }, seller);
      setUndo({ before: value, by: r.by });
      // an answer the draft kept (the same question) keeps its pictures
      const drafted = guideToForm(r.guide);
      const kept = (k: 'faq' | 'doubts') => drafted[k].map((p) => ({ ...p, pics: value[k].find((o) => same(o.q, p.q))?.pics ?? [] }));
      onChange({ ...drafted, faq: kept('faq'), doubts: kept('doubts'), tr: value.tr, trBase: value.trBase });
      if (r.guide.upsell) setPhrase(true);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  // the size guide: one line per size of the product, the age and the weight it fits
  const sizeRow = (s: string) => value.sizes.find((x) => same(x.size, s)) ?? { size: s, age: '', weight: '' };
  const setSize = (s: string, p: Partial<GuideSize>) => set('sizes', sizes.map((x) => (same(x, s) ? { ...sizeRow(x), ...p, size: x } : sizeRow(x))));
  // one size only: the small size guide (the age, the weight, the measures)
  const setFit = (k: keyof GuideFit, v: string) => set('fit', { ...value.fit, [k]: v });
  // the fixed questions: what Pilotix knows answers them; the rest is the team's
  const colors = [...new Set((f.options ?? []).filter((o) => COLOR_OPTION.test(o.name)).flatMap((o) => o.values))];
  const ages = sizes.length ? g.sizes.filter((x) => x.age).map((x) => `${x.size} : ${x.age}`) : [g.fit.age].filter(Boolean);
  const weights = sizes.length ? g.sizes.filter((x) => x.weight).map((x) => `${x.size} : ${x.weight}`) : [g.fit.weight].filter(Boolean);
  const known: Partial<Record<Fixed, string>> = {
    pay: t('produits.guide.qa.payAns'),
    delivery: t('produits.guide.qa.deliveryAns'),
    colors: colors.length ? `${t('produits.guide.qa.colorsAns')} ${colors.join(', ')}.` : '',
    size: sizes.length ? t('produits.guide.qa.sizeAns') : '',
    age: ages.join(' · '),
    weight: weights.join(' · '),
    measures: sizes.length ? '' : g.fit.measures,
  };
  const has = (q: string) => value.faq.some((p) => same(p.q, q));
  // « Quelle taille choisir ? » for a product with sizes, « Quelles sont ses mesures ? » for one with one size
  const fixed = FIXED.filter((k) => (k !== 'size' || sizes.length > 0) && (k !== 'measures' || !sizes.length) && !has(t(`produits.guide.qa.${k}`)));
  const pick = (k: Fixed) => value.faq.length < GUIDE_MAX.lines && set('faq', [...value.faq, { q: t(`produits.guide.qa.${k}`), a: known[k] ?? '', pics: [] }]);
  // an answer's pictures: picked for one answer, made small enough here (the phone's file never leaves as it is), then
  // kept in the form until the save. What finishes later writes on the form as it is then, never on an older copy.
  const latest = useRef(value);
  latest.current = value;
  const file = useRef<HTMLInputElement>(null);
  const fileFor = useRef<{ k: 'faq' | 'doubts'; i: number } | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const picCount = (f: GuideForm) => [...f.faq, ...f.doubts].reduce((a, p) => a + p.pics.length, 0);
  const pickPics = (k: 'faq' | 'doubts', i: number) => {
    // why not, said when it is asked (the button stays the same on every answer)
    if (!value[k][i]?.q.trim()) return toast(t('produits.guide.pics.needQ'), 'bad');
    if (value[k][i].pics.length >= GUIDE_MAX.perAnswer) return toast(t('produits.guide.pics.full', { max: GUIDE_MAX.perAnswer }), 'bad');
    if (picCount(value) >= GUIDE_MAX.pictures) return toast(t('produits.guide.pics.fullGuide', { max: GUIDE_MAX.pictures }), 'bad');
    fileFor.current = { k, i };
    file.current?.click();
  };
  const addPics = async (files: File[]) => {
    const to = fileFor.current;
    if (!to || !files.length) return;
    const room = Math.max(0, Math.min(GUIDE_MAX.perAnswer - (latest.current[to.k][to.i]?.pics.length ?? 0), GUIDE_MAX.pictures - picCount(latest.current)));
    if (files.length > room) toast(t('produits.guide.pics.full', { max: GUIDE_MAX.perAnswer }), 'bad');
    setPreparing(`${to.k}:${to.i}`);
    const got: GuidePic[] = [];
    for (const f of files.slice(0, room)) {
      try {
        const p = await hdPhoto(f);
        got.push({ key: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, thumb: p.mini, send: { data: p.data, w: p.w, h: p.h, thumb: p.thumb, mini: p.mini } });
      } catch (e) {
        const why = (e as Error)?.message;
        toast(why === 'not_image' ? t('produits.hd.notImage') : why === 'too_big' ? t('produits.hd.tooBig') : t('produits.guide.pics.failed'), 'bad');
      }
    }
    setPreparing(null);
    if (!got.length) return;
    const now = latest.current;
    onChange({ ...now, [to.k]: now[to.k].map((x, j) => (j === to.i ? { ...x, pics: [...x.pics, ...got] } : x)) });
  };
  // Vente en plus: products picked (not this one), the chosen ones first
  const others = products.filter((p) => p.id !== f.productId);
  const chosen = value.upsellIds.map((x) => others.find((p) => p.id === x)).filter((p): p is { id: number; name: string } => !!p);
  const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const found = useMemo(() => {
    const w = fold(find.trim());
    return others.filter((p) => !value.upsellIds.includes(p.id) && (!w || fold(p.name).includes(w))).slice(0, w ? 12 : 6);
  }, [others, find, value.upsellIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: number) =>
    set('upsellIds', value.upsellIds.includes(id) ? value.upsellIds.filter((x) => x !== id) : value.upsellIds.length >= GUIDE_MAX.upsellIds ? (toast(t('produits.guide.ed.upsellMax', { max: GUIDE_MAX.upsellIds }), 'bad'), value.upsellIds) : [...value.upsellIds, id]);

  const pairs = (k: 'faq' | 'doubts') => {
    const list = value[k];
    const max = GUIDE_MAX.lines;
    const upd = (i: number, p: Partial<GuideFormPair>) => set(k, list.map((x, j) => (j === i ? { ...x, ...p } : x)));
    return (
      <div className="gd-pairs">
        {k === 'faq' && fixed.length > 0 && list.length < max && (
          <div className="gd-fixed" role="group" aria-label={t('produits.guide.ed.pick')}>
            <span className="gd-fixed-l">{t('produits.guide.ed.pick')}</span>
            {fixed.map((q) => (
              <button key={q} type="button" className="gd-fixed-b" onClick={() => pick(q)}>
                <Icon name="plus" /> {t(`produits.guide.qa.${q}`)}
              </button>
            ))}
          </div>
        )}
        {list.map((p, i) => (
          <div key={i} className={`gd-ed-pair ${pictures ? '' : 'no-img'}`}>
            <label className="gd-ed-q">
              <span className="sr-only">{k === 'faq' ? t('produits.guide.ed.q') : t('produits.guide.ed.dq')}</span>
              <Area dir="auto" rows={1} value={p.q} placeholder={k === 'faq' ? t('produits.guide.ed.qPh') : t('produits.guide.ed.dqPh')} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} onChange={(e) => upd(i, { q: e.target.value.replace(/\s*\n\s*/g, ' ') })} />
            </label>
            <div className="gd-ed-a">
              <label>
                <span className="sr-only">{k === 'faq' ? t('produits.guide.ed.a') : t('produits.guide.ed.da')}</span>
                <Area dir="auto" rows={2} value={p.a} className={p.q.trim() && toFill(p.a) ? 'gd-fill' : ''} placeholder={k === 'faq' ? t('produits.guide.ed.aPh') : t('produits.guide.ed.daPh')} onChange={(e) => upd(i, { a: e.target.value })} />
              </label>
              {/* the pictures that go with this answer: each opens big, a × takes it off */}
              <PicRow items={p.pics} onRemove={(key) => upd(i, { pics: p.pics.filter((x) => x.key !== key) })}>
                {preparing === `${k}:${i}` ? (
                  <span className="gd-pic-note" role="status">
                    {t('produits.guide.pics.preparing')}
                  </span>
                ) : null}
              </PicRow>
            </div>
            {pictures && (
              <button type="button" className="icon-btn gd-ed-img" disabled={preparing !== null} title={t('produits.guide.pics.add')} aria-label={p.q.trim() ? t('produits.guide.pics.addFor', { q: p.q.trim() }) : t('produits.guide.pics.add')} onClick={() => pickPics(k, i)}>
                <Icon name="imageplus" />
              </button>
            )}
            <button type="button" className="icon-btn gd-ed-del" aria-label={t('produits.guide.ed.remove')} onClick={() => set(k, list.filter((_, j) => j !== i))}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
        {list.length < max && (
          <div>
            <button type="button" className="btn small" onClick={() => set(k, [...list, { q: '', a: '', pics: [] }])}>
              <Icon name="plus" /> {k === 'faq' ? t('produits.guide.ed.addQ') : t('produits.guide.ed.addD')}
            </button>
          </div>
        )}
      </div>
    );
  };
  const part = (k: string, icon: string, hint: string, children: ReactNode) => (
    <section className="pf-sec gd-ed-sec">
      <h3 className="gd-h">
        <Icon name={icon} />
        {t(`produits.guide.${k}`)}
      </h3>
      <p className="gd-hint">{hint}</p>
      {children}
    </section>
  );
  const targets = trTargets(lang);
  const sources = guideSources(g);
  const langTabs = (
    <div className="gd-ed-langs" role="tablist" aria-label={t('produits.guide.ed.trTabs')}>
      <button type="button" role="tab" aria-selected={view === 'main'} className={`gd-filter ${view === 'main' ? 'on' : ''}`} onClick={() => setView('main')}>
        {t(`produits.guide.langs.${lang}`)} <small>{t('produits.guide.ed.original')}</small>
      </button>
      {targets.map((l) => (
        <button key={l} type="button" role="tab" aria-selected={view === l} className={`gd-filter ${view === l ? 'on' : ''}`} onClick={() => setView(l)}>
          {t(`produits.guide.langs.${l}`)}{' '}
          <span className="ltr">
            {sources.filter((x) => (value.tr[l]?.[x] ?? '').trim()).length}/{sources.length}
          </span>
        </button>
      ))}
    </div>
  );
  if (view !== 'main' && targets.includes(view))
    return (
      <div className="gd-ed">
        {langTabs}
        <TrTab lang={view} g={g} value={value} onChange={onChange} />
      </div>
    );
  return (
    <div className="gd-ed">
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = '';
          void addPics(picked);
        }}
      />
      {langTabs}
      <div className="gd-ed-top">
        <p>{t('produits.guide.ed.help')}</p>
        <div className="gd-ed-ai">
          <select value={lang} aria-label={t('produits.guide.ed.lang')} onChange={(e) => set('lang', e.target.value as GuideLang)}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {t(`produits.guide.langs.${l}`)}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={busy} onClick={draft}>
            <Icon name="sparkles" /> {busy ? t('produits.guide.ed.drafting') : t('produits.guide.ed.draft')}
          </button>
        </div>
      </div>
      {undo && (
        <div className="gd-drafted" role="status">
          <Icon name="sparkles" />
          <span>
            {undo.by === 'ai' ? t('produits.guide.ed.draftedAi') : t('produits.guide.ed.draftedRules')}
            {missing > 0 && <b> {t('produits.guide.ed.toFillCount', { count: missing })}</b>}
          </span>
          <button type="button" className="linkish" onClick={() => (onChange(undo.before), setUndo(null))}>
            {t('produits.guide.ed.undo')}
          </button>
        </div>
      )}
      {part('brief', 'info', t('produits.guide.ed.briefHint'), <Area dir="auto" rows={2} aria-label={t('produits.guide.brief')} value={value.brief} onChange={(e) => set('brief', e.target.value)} />)}
      {sizes.length > 0 &&
        part(
          'sizes',
          'shirt',
          t('produits.guide.ed.sizesHint'),
          <div className="gd-ed-sizes" role="table" aria-label={t('produits.guide.sizes')}>
            <div className="gd-ed-size gd-ed-size-head" role="row">
              <span role="columnheader">{t('produits.guide.sizeCol')}</span>
              <span role="columnheader">{t('produits.guide.ageCol')}</span>
              <span role="columnheader">{t('produits.guide.weightCol')}</span>
            </div>
            {sizes.map((x) => (
              <div key={x} className="gd-ed-size" role="row">
                <b role="rowheader" dir="auto">{x}</b>
                <input dir="auto" role="cell" aria-label={`${x} · ${t('produits.guide.ageCol')}`} placeholder={t('produits.guide.ed.agePh')} value={sizeRow(x).age} onChange={(e) => setSize(x, { age: e.target.value })} />
                <input dir="auto" role="cell" aria-label={`${x} · ${t('produits.guide.weightCol')}`} placeholder={t('produits.guide.ed.weightPh')} value={sizeRow(x).weight} onChange={(e) => setSize(x, { weight: e.target.value })} />
              </div>
            ))}
          </div>,
        )}
      {!sizes.length &&
        part(
          'sizes',
          'shirt',
          t('produits.guide.ed.fitHint'),
          <div className="gd-ed-fit">
            {(['age', 'weight', 'measures'] as const).map((k) => (
              <label key={k} className="gd-ed-fit-row">
                <span>{t(`produits.guide.${k}Col`)}</span>
                <input dir="auto" placeholder={t(`produits.guide.ed.fit${k[0].toUpperCase()}${k.slice(1)}Ph`)} value={value.fit[k]} onChange={(e) => setFit(k, e.target.value)} />
              </label>
            ))}
          </div>,
        )}
      <div className="pf-two">
        {part('strengths', 'check', t('produits.guide.ed.strengthsHint'), <Area dir="auto" rows={5} aria-label={t('produits.guide.strengths')} className={lines(value.strengths).some((x) => toFill(x)) ? 'gd-fill' : ''} value={value.strengths} onChange={(e) => set('strengths', e.target.value)} />)}
        {part('never', 'ban', t('produits.guide.ed.neverHint'), <Area dir="auto" rows={5} aria-label={t('produits.guide.never')} value={value.never} onChange={(e) => set('never', e.target.value)} />)}
      </div>
      {part('faq', 'help', t('produits.guide.ed.faqHint'), pairs('faq'))}
      {part('doubts', 'message', t('produits.guide.ed.doubtsHint'), pairs('doubts'))}
      {part(
        'upsell',
        'gift',
        t('produits.guide.ed.upsellHint'),
        <div className="gd-ed-upsell">
          {chosen.length > 0 ? (
            <ul className="gd-picked" aria-label={t('produits.guide.ed.upsellChosen')}>
              {chosen.map((p) => (
                <li key={p.id}>
                  <span dir="auto">{p.name}</span>
                  <button type="button" className="gd-picked-x" aria-label={`${t('produits.guide.ed.remove')} ${p.name}`} onClick={() => toggle(p.id)}>
                    <Icon name="x" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="gd-ed-none">{t('produits.guide.ed.upsellNone')}</p>
          )}
          {others.length > 0 && (
            <>
              <label className="gd-search">
                <Icon name="search" />
                <input type="search" value={find} placeholder={t('produits.guide.ed.upsellSearch')} aria-label={t('produits.guide.ed.upsellSearch')} onChange={(e) => setFind(e.target.value)} />
              </label>
              <div className="gd-pick-list">
                {found.map((p) => (
                  <button key={p.id} type="button" className="gd-pick" onClick={() => toggle(p.id)}>
                    <Icon name="plus" />
                    <span dir="auto">{p.name}</span>
                  </button>
                ))}
                {!found.length && <p className="gd-ed-none">{t('produits.guide.page.noMatch')}</p>}
              </div>
            </>
          )}
          {phrase ? (
            <Area dir="auto" rows={2} aria-label={t('produits.guide.ed.upsellPhrasePh')} placeholder={t('produits.guide.ed.upsellPhrasePh')} value={value.upsell} onChange={(e) => set('upsell', e.target.value)} />
          ) : (
            <button type="button" className="linkish gd-phrase" onClick={() => setPhrase(true)}>
              {t('produits.guide.ed.upsellPhrase')}
            </button>
          )}
        </div>,
      )}
      {size > GUIDE_MAX.long && (
        <p className={`gd-size ${size > GUIDE_MAX.total ? 'bad' : ''}`} role="status">
          <Icon name={size > GUIDE_MAX.total ? 'alert' : 'info'} />
          <span>
            {size > GUIDE_MAX.total
              ? t('produits.guide.ed.tooBig', { n: n(size), max: n(GUIDE_MAX.total) })
              : size > GUIDE_MAX.near
                ? t('produits.guide.ed.nearFull', { n: n(size), max: n(GUIDE_MAX.total) })
                : t('produits.guide.ed.long', { n: n(size) })}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * One other reading language: each line of the guide (in its part) with its translation, to correct. A line emptied,
 * or « Tout refaire par Pilot AI », is translated again when the guide is saved.
 */
function TrTab({ lang, g, value, onChange }: { lang: ReadLang; g: Guide; value: GuideForm; onChange: (v: GuideForm) => void }) {
  const { t } = useTranslation();
  const mem = value.tr[lang] ?? {};
  const set = (src: string, v: string) => onChange({ ...value, tr: { ...value.tr, [lang]: { ...mem, [src]: v } } });
  const groups = [
    { k: 'brief', icon: 'info', lines: [g.brief] },
    { k: 'sizes', icon: 'shirt', lines: [...g.sizes.flatMap((x) => [x.age, x.weight]), g.fit.age, g.fit.weight, g.fit.measures] },
    { k: 'strengths', icon: 'check', lines: g.strengths },
    { k: 'faq', icon: 'help', lines: g.faq.flatMap((p) => [p.q, p.a]) },
    { k: 'doubts', icon: 'message', lines: g.doubts.flatMap((p) => [p.q, p.a]) },
    { k: 'upsell', icon: 'gift', lines: [g.upsell] },
    { k: 'never', icon: 'ban', lines: g.never },
  ];
  // each line once (in the first part that has it), the answers still to write left out: the same lines as the server's
  const seen = new Set<string>();
  const shown = groups
    .map((x) => ({ ...x, lines: x.lines.map((l) => l.trim()).filter((l) => l && !toFill(l) && !seen.has(l) && !!seen.add(l)) }))
    .filter((x) => x.lines.length);
  if (!shown.length) return <p className="gd-ed-none">{t('produits.guide.ed.trEmpty')}</p>;
  return (
    <div className="gd-tr">
      <div className="gd-tr-top">
        <p>{t('produits.guide.ed.trHint')}</p>
        <button type="button" className="btn small" onClick={() => onChange({ ...value, tr: { ...value.tr, [lang]: {} } })}>
          <Icon name="refresh" /> {t('produits.guide.ed.trRedo')}
        </button>
      </div>
      {shown.map((x) => (
        <section key={x.k} className="pf-sec gd-ed-sec">
          <h3 className="gd-h">
            <Icon name={x.icon} />
            {t(`produits.guide.${x.k}`)}
          </h3>
          {x.lines.map((src) => (
            <label key={src} className="gd-tr-line">
              <span dir="auto">{src}</span>
              <Area
                dir={lang === 'ar' ? 'rtl' : 'ltr'}
                lang={lang}
                rows={Math.min(5, Math.max(1, Math.ceil(src.length / 64)))}
                value={mem[src] ?? ''}
                placeholder={t('produits.guide.ed.trPh')}
                onChange={(e) => set(src, e.target.value)}
              />
            </label>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * After a save (the Guide de vente tab, the product form): Pilot AI translates the lines still without a translation;
 * then everything on screen is read again. quiet: say nothing when there was nothing to translate.
 */
export function useGuideTranslate() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const seller = useScope();
  const [busy, setBusy] = useState<number | null>(null);
  const run = async (id: number) => {
    setBusy(id);
    try {
      const r = await rpc('catalog.translateGuide', { id }, seller);
      if (r.by === 'done') return;
      qc.invalidateQueries();
      if (r.by === 'none') toast(t('produits.guide.tr.noAi'), 'bad');
      else if (r.error || Object.keys(r.missing).length) toast(t('produits.guide.tr.failed'), 'bad');
      else toast(t('produits.guide.tr.done'), 'ok');
    } catch (e) {
      const m = (e as Error).message;
      if (!/déjà en cours/.test(m)) toast(m, 'bad');
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}
