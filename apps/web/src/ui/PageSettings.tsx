// A page's « Réglages » tab (owner's ask, 24 Nov 2026: no more one place for every setting — each page keeps its own; he
// picked design 1 « Onglet »: the last tab of the page's bar, with a gear, set apart). The page's settings, each part a
// card folded on its state (« Résumé », his rule of 20 Nov 2026 for settings pages), opened from its title row; an opened
// part takes the whole width. Nothing is copied: each part is the same form as before, saved where the server keeps it,
// and keeps who may change it (the server checks it too).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Empty, Icon, type IconName } from './kit';
import './pageSettings.css';

/** The page: its title, who sees it, then its parts (none the person may change: a short line instead). */
export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  const parts = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  if (!parts.length) return <Empty>{t('common.settingsNothing')}</Empty>;
  return (
    <div className="cfs">
      <div className="cfs-top">
        <h2>{title}</h2>
        <span className="cfs-who">
          <Icon name="lock" />
          {t('common.settingsWho')}
        </span>
      </div>
      <div className="cfs-grid">{parts}</div>
    </div>
  );
}

/** Opens one part of the page and brings it into view: a « Modifier » or « Ouvrir » inside another part of the same page. */
export function openFold(id: string) {
  window.dispatchEvent(new CustomEvent<string>('cfs:open', { detail: id }));
}

/** One part: folded on its state, opened from its title row (or by openFold). */
export function Fold({ id, icon, title, desc, state, children }: { id: string; icon: IconName; title: string; desc: string; state?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLElement>(null);
  const body = `cfs-${id}`;
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setOpen(true);
      // once open, its title row comes to the top of the screen
      window.requestAnimationFrame(() => box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
    window.addEventListener('cfs:open', on);
    return () => window.removeEventListener('cfs:open', on);
  }, [id]);
  return (
    <section ref={box} className={`card cfs-fold${open ? ' open' : ''}`}>
      <button type="button" className="cfs-head" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
        <span className="cfs-ic">
          <Icon name={icon} />
        </span>
        {/* the state sits on the title row (it wraps under the title when there is no room) */}
        <span className="cfs-t">
          <span className="cfs-tl">
            <b>{title}</b>
            {state ? <span className="cfs-state">{state}</span> : null}
          </span>
          <small>{desc}</small>
        </span>
        <Icon name="chevron" className="cfs-chev" />
      </button>
      {open && (
        <div id={body} className="cfs-body">
          {children}
        </div>
      )}
    </section>
  );
}
