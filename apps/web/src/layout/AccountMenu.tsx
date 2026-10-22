import type { Session } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../pages/profil/Avatar';
import { Icon } from '../ui/kit';

/** The signed-in account at the right of the header (moved from the sidebar): picture, name and role; the menu opens my profile pages and signs out. */
/** On phones the header has no room for the language and theme buttons: they are in this menu instead (lang / onTheme). */
export function AccountMenu({ session, onLogout, lang, onTheme }: { session: Session; onLogout: () => void; lang?: { value: string; options: string[]; onChange: (l: string) => void }; onTheme?: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [open]);
  const p = session.profile;
  const role = session.roles.map((r) => t(`roles.${r}`)).join(' · ');
  const go = (tab: string) => {
    setOpen(false);
    location.hash = `#/profil/${tab}`;
  };
  const item = (icon: string, label: string, on: () => void, cls?: string) => (
    <button type="button" role="menuitem" className={cls} onClick={on}>
      <Icon name={icon} />
      {label}
    </button>
  );
  return (
    <div className="px-me" ref={box}>
      <button type="button" className="px-me-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('shell.account', { name: p.name })} onClick={() => setOpen((v) => !v)}>
        <Avatar p={p} />
        <span className="px-me-t">
          <b>{p.name}</b>
          <small>{role}</small>
        </span>
        <Icon name="chevron" className="px-me-ch" />
      </button>
      {open && (
        <div className="px-me-menu" role="menu">
          <a className="px-me-head" href="#/profil/infos" onClick={() => setOpen(false)}>
            <Avatar p={p} size="big" />
            <span className="px-me-t">
              <b>{p.name}</b>
              <small>{p.email || role}</small>
            </span>
          </a>
          {item('usercog', t('profil.title'), () => go('infos'))}
          {item('settings', t('profil.tSettings'), () => go('parametres'))}
          {item('gift', t('profil.tRef'), () => go('parrainage'))}
          {item('lock', t('profil.pwd'), () => go('securite'))}
          {(lang || onTheme) && (
            <div className="px-me-phone">
              <hr />
              {lang && (
                <div className="px-me-lang" role="group" aria-label={t('shell.language')}>
                  <Icon name="globe" />
                  {lang.options.map((l) => (
                    <button key={l} type="button" className={l === lang.value ? 'on' : ''} aria-pressed={l === lang.value} onClick={() => lang.onChange(l)}>
                      {l.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              {onTheme && item('moon', t('shell.theme'), () => onTheme())}
            </div>
          )}
          <hr />
          {item('logout', t('shell.logout'), () => (setOpen(false), onLogout()), 'px-me-out')}
        </div>
      )}
    </div>
  );
}
