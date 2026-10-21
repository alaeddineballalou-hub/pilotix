import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useNetwork } from '../lib/offline';
import { Icon } from './ui';

export function Layout() {
  const { t } = useTranslation();
  const { user, logout, can } = useAuth();
  const net = useNetwork();
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  const links = [
    can('manager', 'confirmation', 'suivi', 'depot') && { to: '/', label: t('nav.dashboard'), icon: Icon.dashboard, end: true },
    { to: '/orders', label: t('nav.orders'), icon: Icon.orders },
    can('manager', 'depot') && { to: '/products', label: t('nav.products'), icon: Icon.products },
    can('manager') && { to: '/team', label: t('nav.team'), icon: Icon.team },
    { to: '/settings', label: t('nav.settings'), icon: Icon.settings },
  ].filter(Boolean) as { to: string; label: string; icon: () => JSX.Element; end?: boolean }[];

  const title = links.find((l) => (l.end ? loc.pathname === l.to : loc.pathname.startsWith(l.to)))?.label ?? '';

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="side" onClick={() => setOpen(false)}>
        <span className="logo" role="img" aria-label="Pilotix" />
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}>
            <l.icon />
            {l.label}
          </NavLink>
        ))}
        <div className="side-foot">
          <b>{user?.name}</b>
          <span className="small muted">{user?.roles.map((r) => t(`roles.${r}`)).join(' · ')}</span>
          <button className="btn small" onClick={logout}>
            <Icon.logout /> {t('nav.logout')}
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label={t('nav.menu')} onClick={() => setOpen(true)}>
            <Icon.menu />
          </button>
          <span className="logo" role="img" aria-label="Pilotix" />
          <h1 className="grow">{title}</h1>
        </header>
        {!net.online && <div className="banner off">{t('net.offline')}</div>}
        {net.online && net.pending > 0 && <div className="banner sync">{t('net.syncing', { count: net.pending })}</div>}
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
