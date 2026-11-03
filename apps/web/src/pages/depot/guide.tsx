// The sales guide of a product (Guide de vente): written by the team in the product form (tab « Guide de vente », with
// « Écrire avec l'IA » for a first draft), read by the agents during a call (the « Guide » button on each product of the
// order opens it beside the order, without hiding it) and in Produits & stock. Dellal and CM AI read the same guide.
import { ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { dateOnly, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useScope } from '../../lib/seller';
import { useIsPhone } from '../../lib/useMedia';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/toast';
import './guide.css';

export interface GuidePair {
  q: string;
  a: string;
}
export interface Guide {
  brief: string;
  strengths: string[];
  faq: GuidePair[];
  doubts: GuidePair[];
  upsell: string;
  never: string[];
}
/** The form: the one-per-line parts as plain text. */
export interface GuideForm {
  brief: string;
  strengths: string;
  faq: GuidePair[];
  doubts: GuidePair[];
  upsell: string;
  never: string;
}

/** An answer the AI could not know: the team writes it (the AI agents never use it). */
export const TO_FILL = '[À compléter]';
const TO_FILL_RE = /\[\s*(?:à|a)\s+compl[ée]ter\s*\]/i;
export const toFill = (s: string) => TO_FILL_RE.test(s) || !s.trim();
/** The guide's sizes (the same as the server's, modules/guide.ts). */
export const GUIDE_MAX = { brief: 400, strengths: 12, strength: 200, faq: 20, question: 200, answer: 600, doubts: 12, doubt: 160, upsell: 800, never: 10, neverLine: 200, total: 15_000 };

const lines = (s: string) => s.split('\n').map((x) => x.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
export const guideToForm = (g: Guide | null | undefined): GuideForm => ({
  brief: g?.brief ?? '',
  strengths: (g?.strengths ?? []).join('\n'),
  faq: (g?.faq ?? []).map((p) => ({ ...p })),
  doubts: (g?.doubts ?? []).map((p) => ({ ...p })),
  upsell: g?.upsell ?? '',
  never: (g?.never ?? []).join('\n'),
});
export const formToGuide = (f: GuideForm): Guide => ({
  brief: f.brief.trim(),
  strengths: lines(f.strengths),
  faq: f.faq.map((p) => ({ q: p.q.trim(), a: p.a.trim() })).filter((p) => p.q),
  doubts: f.doubts.map((p) => ({ q: p.q.trim(), a: p.a.trim() })).filter((p) => p.q),
  upsell: f.upsell.trim(),
  never: lines(f.never),
});
const sizeOf = (g: Guide) => g.brief.length + g.upsell.length + [...g.strengths, ...g.never].reduce((a, x) => a + x.length, 0) + [...g.faq, ...g.doubts].reduce((a, p) => a + p.q.length + p.a.length, 0);
export const guideIsEmpty = (g: Guide) => !g.brief && !g.strengths.length && !g.faq.length && !g.doubts.length && !g.upsell && !g.never.length;

/** What would stop the save (the server says the same), in words, or null. */
export function guideProblem(g: Guide, t: (k: string, o?: any) => string): string | null {
  const M = GUIDE_MAX;
  if (g.strengths.length > M.strengths) return t('produits.guide.ed.tooMany', { part: t('produits.guide.strengths'), max: M.strengths });
  if (g.never.length > M.never) return t('produits.guide.ed.tooMany', { part: t('produits.guide.never'), max: M.never });
  if (g.strengths.some((x) => x.length > M.strength)) return t('produits.guide.ed.tooLong', { part: t('produits.guide.strengths'), max: M.strength });
  if (g.never.some((x) => x.length > M.neverLine)) return t('produits.guide.ed.tooLong', { part: t('produits.guide.never'), max: M.neverLine });
  const total = sizeOf(g);
  if (total > M.total) return t('produits.guide.ed.tooBig', { n: n(total), max: n(M.total) });
  return null;
}

// ---------------------------------------------------------------- reading (agents, during the call)
/** The guide's parts, for reading fast during a call: the brief, then each part with what it holds. */
export function GuideView({ guide, id }: { guide: Guide; id: string }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const parts = [
    { k: 'strengths', icon: 'check', n: guide.strengths.length },
    { k: 'faq', icon: 'help', n: guide.faq.length },
    { k: 'doubts', icon: 'message', n: guide.doubts.length },
    { k: 'upsell', icon: 'gift', n: guide.upsell ? 1 : 0 },
    { k: 'never', icon: 'ban', n: guide.never.length },
  ].filter((p) => p.n > 0);
  // to a part, just under the parts bar that stays at the top
  const go = (k: string) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-part="${k}"]`);
    const sc = box.current?.closest<HTMLElement>('.gd-body, .pxk-body');
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
      {guide.strengths.length > 0 && (
        <section className="gd-sec" data-part="strengths" id={`${id}-strengths`}>
          {head('strengths', 'check')}
          <ul className="gd-points">
            {guide.strengths.map((x, k) => (
              <li key={k} className={toFill(x) ? 'gd-fill' : ''} dir="auto">
                {toFill(x) ? t('produits.guide.toFill') : x}
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
              </div>
            ))}
          </dl>
        </section>
      )}
      {guide.upsell && (
        <section className="gd-sec" data-part="upsell" id={`${id}-upsell`}>
          {head('upsell', 'gift')}
          <p className="gd-text" dir="auto">{guide.upsell}</p>
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
  const { t } = useTranslation();
  const phone = useIsPhone();
  const id = useId().replace(/:/g, '');
  const q = useRpc('catalog.guide', { id: productId }, { staleTime: 60_000 });
  const d = q.data;
  const meta = d?.updatedAt ? (d.updatedBy ? t('produits.guide.updated', { date: dateOnly(d.updatedAt), name: d.updatedBy }) : t('produits.guide.updatedNoName', { date: dateOnly(d.updatedAt) })) : null;
  const body = q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !d ? <Loading /> : d.guide ? <GuideView guide={d.guide} id={id} /> : <Empty>{t('produits.guide.empty')}</Empty>;
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
}
const LANGS = ['fr', 'ar', 'dz', 'en'] as const;
type Lang = (typeof LANGS)[number];

/** The six parts as a form, with « Écrire avec l'IA » (a first draft to correct; nothing is saved before Enregistrer). */
export function GuideEditor({ value, onChange, facts }: { value: GuideForm; onChange: (v: GuideForm) => void; facts: () => DraftFacts }) {
  const { t, i18n } = useTranslation();
  const seller = useScope();
  const [lang, setLang] = useState<Lang>(() => (i18n.language === 'ar' ? 'ar' : i18n.language === 'en' ? 'en' : 'fr'));
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ before: GuideForm; by: 'ai' | 'rules' } | null>(null);
  const set = <K extends keyof GuideForm>(k: K, v: GuideForm[K]) => onChange({ ...value, [k]: v });
  const g = formToGuide(value);
  const missing = [...g.faq, ...g.doubts].filter((p) => toFill(p.a)).length + g.strengths.filter((x) => toFill(x)).length;
  const size = sizeOf(g);
  const draft = async () => {
    const f = facts();
    if (!f.name) return toast(t('produits.guide.ed.needName'), 'bad');
    setBusy(true);
    try {
      const r = await rpc('catalog.guideDraft', { ...f, lang }, seller);
      setUndo({ before: value, by: r.by });
      onChange(guideToForm(r.guide));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const pairs = (k: 'faq' | 'doubts') => {
    const list = value[k];
    const max = k === 'faq' ? GUIDE_MAX.faq : GUIDE_MAX.doubts;
    const qMax = k === 'faq' ? GUIDE_MAX.question : GUIDE_MAX.doubt;
    const upd = (i: number, p: Partial<GuidePair>) => set(k, list.map((x, j) => (j === i ? { ...x, ...p } : x)));
    return (
      <div className="gd-pairs">
        {list.map((p, i) => (
          <div key={i} className="gd-ed-pair">
            <label className="gd-ed-q">
              <span className="sr-only">{k === 'faq' ? t('produits.guide.ed.q') : t('produits.guide.ed.dq')}</span>
              <input dir="auto" value={p.q} maxLength={qMax} placeholder={k === 'faq' ? t('produits.guide.ed.qPh') : t('produits.guide.ed.dqPh')} onChange={(e) => upd(i, { q: e.target.value })} />
            </label>
            <label className="gd-ed-a">
              <span className="sr-only">{k === 'faq' ? t('produits.guide.ed.a') : t('produits.guide.ed.da')}</span>
              <textarea dir="auto" rows={2} value={p.a} maxLength={GUIDE_MAX.answer} className={p.q.trim() && toFill(p.a) ? 'gd-fill' : ''} placeholder={k === 'faq' ? t('produits.guide.ed.aPh') : t('produits.guide.ed.daPh')} onChange={(e) => upd(i, { a: e.target.value })} />
            </label>
            <button type="button" className="icon-btn" aria-label={t('produits.guide.ed.remove')} onClick={() => set(k, list.filter((_, j) => j !== i))}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
        {list.length < max && (
          <div>
            <button type="button" className="btn small" onClick={() => set(k, [...list, { q: '', a: '' }])}>
              <Icon name="plus" /> {k === 'faq' ? t('produits.guide.ed.addQ') : t('produits.guide.ed.addD')}
            </button>
          </div>
        )}
      </div>
    );
  };
  const part = (k: keyof GuideForm, icon: string, hint: string, children: ReactNode) => (
    <section className="pf-sec gd-ed-sec">
      <h3 className="gd-h">
        <Icon name={icon} />
        {t(`produits.guide.${k}`)}
      </h3>
      <p className="gd-hint">{hint}</p>
      {children}
    </section>
  );
  return (
    <div className="gd-ed">
      <div className="gd-ed-top">
        <p>{t('produits.guide.ed.help')}</p>
        <div className="gd-ed-ai">
          <select value={lang} aria-label={t('produits.guide.ed.lang')} onChange={(e) => setLang(e.target.value as Lang)}>
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
      {part('brief', 'info', t('produits.guide.ed.briefHint'), <textarea dir="auto" rows={2} maxLength={GUIDE_MAX.brief} aria-label={t('produits.guide.brief')} value={value.brief} onChange={(e) => set('brief', e.target.value)} />)}
      <div className="pf-two">
        {part('strengths', 'check', t('produits.guide.ed.strengthsHint'), <textarea dir="auto" rows={5} aria-label={t('produits.guide.strengths')} className={lines(value.strengths).some((x) => toFill(x)) ? 'gd-fill' : ''} value={value.strengths} onChange={(e) => set('strengths', e.target.value)} />)}
        {part('never', 'ban', t('produits.guide.ed.neverHint'), <textarea dir="auto" rows={5} aria-label={t('produits.guide.never')} value={value.never} onChange={(e) => set('never', e.target.value)} />)}
      </div>
      {part('faq', 'help', t('produits.guide.ed.faqHint'), pairs('faq'))}
      {part('doubts', 'message', t('produits.guide.ed.doubtsHint'), pairs('doubts'))}
      {part('upsell', 'gift', t('produits.guide.ed.upsellHint'), <textarea dir="auto" rows={3} maxLength={GUIDE_MAX.upsell} aria-label={t('produits.guide.upsell')} value={value.upsell} onChange={(e) => set('upsell', e.target.value)} />)}
      <p className={`gd-size ${size > GUIDE_MAX.total ? 'bad' : ''}`}>{t('produits.guide.ed.size', { n: n(size), max: n(GUIDE_MAX.total) })}</p>
    </div>
  );
}
