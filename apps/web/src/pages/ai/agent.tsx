// Pilot AI — what the three agents (Message AI agent, CM AI agent, Delivery AI agent) share on screen:
// the agent's header (its portrait with the live dot, its name, what it does, on or paused) and its section tabs,
// the filters of a feed (a column beside the list on a wide screen, a row above it on a phone), the period
// switch of the results, the bar that saves the settings, the height that lets a chat fill the screen, and
// the initials of a customer.
import { ReactNode, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Help, Icon } from '../../ui/kit';
import './ai.css';

/** A row that scrolls sideways: says which side hides more of it (data-more="l r"), for the faded edges. */
export function useEdges<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const hidden = el.scrollWidth - el.clientWidth;
      let more = '';
      if (hidden > 1) {
        // right to left: scrollLeft goes from 0 (start, on the right) down to -hidden
        const x = Math.abs(el.scrollLeft);
        const before = x > 1;
        const after = x < hidden - 1;
        const rtl = getComputedStyle(el).direction === 'rtl';
        more = `${(rtl ? after : before) ? 'l' : ''} ${(rtl ? before : after) ? 'r' : ''}`.trim();
      }
      if ((el.dataset.more ?? '') !== more) el.dataset.more = more;
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      ro?.disconnect();
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** Brings the selected item of a sideways row into view (the last tab is often off screen on a phone). */
function centerOn(el: HTMLElement | null) {
  const on = el?.querySelector<HTMLElement>('.on');
  if (!el || !on || el.scrollWidth <= el.clientWidth + 1) return;
  const r = el.getBoundingClientRect();
  const b = on.getBoundingClientRect();
  if (b.left >= r.left + 8 && b.right <= r.right - 8) return;
  el.scrollBy({ left: b.left + b.width / 2 - (r.left + r.width / 2) });
}

export type AgentKind = 'messages' | 'cm' | 'notify';
const FACE: Record<AgentKind, string> = { messages: 'chat', cm: 'comments', notify: 'truck' };
/** A section of a page; `alert` draws its count in red (something waits). */
export type AgentTab = { key: string; label: string; icon: string; href: string; count?: number; alert?: boolean };

/** The sections of a page, as tabs along the bottom edge of its header. */
function SectionTabs({ tabs, current, label }: { tabs: AgentTab[]; current: string; label: string }) {
  const nav = useEdges<HTMLElement>([tabs.length]);
  useLayoutEffect(() => centerOn(nav.current), [current, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <nav className="ai-tabs" ref={nav} aria-label={label}>
      {tabs.map((x) => (
        <a key={x.key} href={x.href} className={`ai-tab ${current === x.key ? 'on' : ''}`} aria-current={current === x.key ? 'page' : undefined}>
          <Icon name={x.icon} />
          <span>{x.label}</span>
          {!!x.count && <b className={`ltr ${x.alert ? 'alert' : ''}`}>{x.count}</b>}
        </a>
      ))}
    </nav>
  );
}

/** The top of a page that is not an agent (Produits & stock): its icon, its name, what it is for, and its sections. */
export function SectionHeader({ icon, title, help, about, tabs, current, aside }: { icon: string; title: string; help?: string; about: string; tabs: AgentTab[]; current: string; aside?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <header className="ai-head ai-sec">
      <div className="ai-id">
        <span className="ai-face" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <div className="ai-name">
          <h1>
            {title}
            {help && <Help text={help} label={title} />}
          </h1>
          <p>{about}</p>
        </div>
        {aside}
      </div>
      <SectionTabs tabs={tabs} current={current} label={t('ai.sections', { name: title })} />
    </header>
  );
}

/** The top of an agent's page: who it is, whether it works right now, and its sections. */
export function AgentHeader({ agent, title, help, about, on, settings, tabs, current }: {
  agent: AgentKind;
  title: string;
  help: string;
  /** one sentence: what the agent does */
  about: string;
  /** undefined while it loads */
  on?: boolean;
  /** an admin's way to switch it on (the "paused" chip links there) */
  settings?: string;
  tabs: AgentTab[];
  current: string;
}) {
  const { t } = useTranslation();
  return (
    <header className={`ai-head ai-${agent}`}>
      <div className="ai-id">
        <span className={`ai-face ${on ? 'on' : ''}`} aria-hidden="true">
          <Icon name={FACE[agent]} />
          <i />
        </span>
        <div className="ai-name">
          <h1>
            {title}
            <Help text={help} label={title} />
          </h1>
          <p>{about}</p>
        </div>
        {on !== undefined &&
          (on || !settings ? (
            <span className={`ai-state ${on ? 'on' : 'off'}`}>{on ? t('ai.on') : t('ai.off')}</span>
          ) : (
            <a className="ai-state off" href={settings} title={t('ai.turnOn')}>
              {t('ai.off')}
            </a>
          ))}
      </div>
      <SectionTabs tabs={tabs} current={current} label={t('ai.sections', { name: title })} />
    </header>
  );
}

/** The filters of a feed: a list in the column beside it on a wide screen, a row of pills on a phone. */
export function Filters<T extends string>({ value, onChange, items, label, extra }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number; alert?: boolean }[]; label: string; extra?: ReactNode }) {
  const ref = useEdges<HTMLDivElement>([items.length]);
  useLayoutEffect(() => centerOn(ref.current), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ai-filters" ref={ref}>
      <div className="ai-filters-g" role="tablist" aria-label={label}>
        {items.map((it) => (
          <button key={it.value} type="button" role="tab" aria-selected={value === it.value} className={`ai-filter ${value === it.value ? 'on' : ''} ${it.alert && it.count ? 'alert' : ''}`} onClick={() => onChange(it.value)}>
            <span>{it.label}</span>
            {it.count !== undefined && <b className="ltr">{it.count}</b>}
          </button>
        ))}
      </div>
      {extra}
    </div>
  );
}

/** A search field with its magnifier. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="ai-search">
      <Icon name="search" />
      <input type="search" value={value} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** 24 h · 7 d · 30 d · 90 d */
export function PeriodSwitch({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="ai-seg" role="radiogroup" aria-label={t('ai.period')}>
      {[1, 7, 30, 90].map((d) => (
        <button key={d} type="button" role="radio" aria-checked={value === d} className={value === d ? 'on' : ''} title={t('ai.periodLong', { count: d })} onClick={() => onChange(d)}>
          {t(`ai.periodShort.${d}`)}
        </button>
      ))}
    </div>
  );
}

/** The settings' save button, kept at the bottom of the screen; it says when something is not saved yet. */
export function SaveBar({ dirty, busy, disabled, onSave, label }: { dirty: boolean; busy?: boolean; disabled?: boolean; onSave: () => void; label: string }) {
  const { t } = useTranslation();
  return (
    <div className={`ai-save ${dirty ? 'dirty' : ''}`}>
      <span className="ai-save-t" aria-live="polite">
        {dirty ? t('ai.unsaved') : t('ai.allSaved')}
      </span>
      <button type="button" className="btn primary" disabled={!dirty || busy || disabled} onClick={onSave}>
        {busy ? t('ai.saving') : label}
      </button>
    </div>
  );
}

/** Sets --fill on the element: the height left under it on the screen, so a chat fills the screen without the page scrolling. */
export function useFillHeight<T extends HTMLElement>(deps: unknown[] = [], min = 460, gap = 18) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty('--fill', `${Math.max(min, Math.round(window.innerHeight - top - gap))}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    document.fonts?.ready.then(fit).catch(() => null);
    return () => window.removeEventListener('resize', fit);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** "Nesrine B." → NB, "@amel.store" → AS, "yacine_dz" → YD, "0661 23 45 67" → 67. */
export function initials(name: string | null | undefined): string {
  const s = (name ?? '').replace(/^@/, '').trim();
  if (!s) return '?';
  if (/^[+\d\s]+$/.test(s)) return s.replace(/\D/g, '').slice(-2);
  const words = s.split(/[\s._\-]+/).filter(Boolean);
  const a = Array.from(words[0] ?? s)[0] ?? '?';
  const b = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : Array.from(words[0] ?? '')[1] ?? '';
  return (a + b).toUpperCase();
}
