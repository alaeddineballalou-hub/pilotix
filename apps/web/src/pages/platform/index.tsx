// Pilotix's control room (#/platform): Pilotix staff run every shop of the server from here — shops, trials, payments,
// plans and their menus, the demo shop, staff, settings, the journal. Its own login (staff accounts, not shop accounts).
import { Language, LANGUAGES } from '@pilotix/shared';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY } from '../../lib/backend';
import { applyLanguage } from '../../lib/i18n';
import { savedStaff, setOnStaffLogout, Staff, staffLogin, staffLogout, usePAction } from '../../lib/platform';
import { Field, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { can } from './bits';
import { Dashboard } from './Dashboard';
import { Demo } from './Demo';
import { DoctorPage } from './Doctor';
import { Journal } from './Journal';
import { Payments } from './Payments';
import { Plans } from './Plans';
import { Settings } from './Settings';
import { ShopDetail } from './ShopDetail';
import { Shops } from './Shops';
import { StaffPage } from './Staff';
import './platform.css';

type Section = { id: string; icon: string; roles?: Staff['role'][] };
const SECTIONS: Section[] = [
  { id: 'dashboard', icon: 'grid' },
  { id: 'doctor', icon: 'sparkles', roles: ['owner', 'manager'] },
  { id: 'shops', icon: 'store' },
  { id: 'payments', icon: 'coins', roles: ['owner', 'manager'] },
  { id: 'plans', icon: 'layers' },
  { id: 'demo', icon: 'sparkles' },
  { id: 'staff', icon: 'users', roles: ['owner'] },
  { id: 'journal', icon: 'history', roles: ['owner', 'manager'] },
  { id: 'settings', icon: 'settings' },
];

export function PlatformApp({ parts }: { parts: string[] }) {
  const [staff, setStaff] = useState<Staff | null>(savedStaff());
  useEffect(() => {
    setOnStaffLogout(() => setStaff(null));
    document.title = 'Pilotix — Centre de contrôle';
    return () => {
      document.title = 'Pilotix';
    };
  }, []);
  // the preview has no server: only the Doctor can be seen there, with an example
  if (DEMO_ONLY) return parts[0] === 'doctor' ? <PlatformShell staff={DEMO_STAFF} parts={parts} demo onLogout={() => (location.hash = '#/accueil')} /> : <ServerOnly />;
  if (!staff) return <PlatformLogin onDone={setStaff} />;
  return (
    <PlatformShell
      staff={staff}
      parts={parts}
      onLogout={() => {
        staffLogout();
        setStaff(null);
      }}
    />
  );
}

const DEMO_STAFF: Staff = { id: 0, name: 'Pilotix', email: '', role: 'owner' };

function ServerOnly() {
  const { t } = useTranslation();
  return (
    <div className="login">
      <div className="card login-card">
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <h2 className="login-title">{t('platform.title')}</h2>
        <p className="login-note">{t('platform.serverOnly')}</p>
        <a className="login-link" href="#/accueil">
          {t('platform.backToShop')}
        </a>
      </div>
    </div>
  );
}

function PlatformLogin({ onDone }: { onDone: (s: Staff) => void }) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onDone(await staffLogin(email.trim(), password));
    } catch (err: any) {
      setError(err?.message || t('login.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login pp-login">
      <form className="card login-card" onSubmit={submit}>
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <h2 className="login-title">
          <Icon name="shield" /> {t('platform.title')}
        </h2>
        <p className="login-note">{t('platform.loginText')}</p>
        <div className="tabs" style={{ justifyContent: 'center' }}>
          {LANGUAGES.map((l) => (
            <button type="button" key={l} className={`tab ${i18n.language === l ? 'on' : ''}`} onClick={() => applyLanguage(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="lab">{t('login.email')}</span>
          <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('login.password')}</span>
          <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="form-err">{error}</p>}
        <button className="btn primary big" disabled={busy}>
          {busy ? '…' : t('login.submit')}
        </button>
        <a className="login-link" href="#/accueil">
          {t('platform.backToShop')}
        </a>
      </form>
    </div>
  );
}

function PlatformShell({ staff, parts, onLogout, demo }: { staff: Staff; parts: string[]; onLogout: () => void; demo?: boolean }) {
  const { t, i18n } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const sections = SECTIONS.filter((s) => !s.roles || can(staff, ...s.roles));
  const cur = sections.find((s) => s.id === parts[0])?.id ?? 'dashboard';
  useEffect(() => setNavOpen(false), [parts.join('/')]);
  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
    return () => document.body.classList.remove('nav-open');
  }, [navOpen]);
  let page: ReactNode;
  if (cur === 'shops' && parts[1] && /^\d+$/.test(parts[1])) page = <ShopDetail id={Number(parts[1])} staff={staff} />;
  else if (cur === 'shops') page = <Shops staff={staff} creating={parts[1] === 'new'} filter={parts[1] === 'f' ? parts[2] : undefined} />;
  else if (cur === 'doctor') page = <DoctorPage demo={demo} />;
  else if (cur === 'payments') page = <Payments staff={staff} />;
  else if (cur === 'plans') page = <Plans staff={staff} />;
  else if (cur === 'demo') page = <Demo staff={staff} />;
  else if (cur === 'staff') page = <StaffPage staff={staff} />;
  else if (cur === 'journal') page = <Journal />;
  else if (cur === 'settings') page = <Settings staff={staff} />;
  else page = <Dashboard staff={staff} />;
  return (
    <div className="shell pp-shell">
      <nav className="side" aria-label={t('platform.title')}>
        <div className="px-side-head pp-side-head">
          <a href="#/platform" className="px-logo-btn" aria-label="Pilotix">
            <span className="px-logo-full" aria-hidden="true" />
          </a>
          <span className="pp-badge">{t('platform.badge')}</span>
        </div>
        <div className="px-side-scroll">
          {sections.map((s) => (
            <a key={s.id} href={s.id === 'dashboard' ? '#/platform' : `#/platform/${s.id}`} className={`nav-item ${cur === s.id ? 'on' : ''}`} aria-current={cur === s.id ? 'page' : undefined}>
              <Icon name={s.icon} className="ic" />
              <span className="nav-l">{t(`platform.nav.${s.id}`)}</span>
            </a>
          ))}
          <a href="#/accueil" className="nav-item pp-back">
            <Icon name="store" className="ic" />
            <span className="nav-l">{t('platform.myShop')}</span>
          </a>
        </div>
      </nav>
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <div className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn pp-menu-btn" aria-label={t('nav.menu')} onClick={() => setNavOpen(!navOpen)}>
            <Icon name="menu" />
          </button>
          <span className="page-title">{t(`platform.nav.${cur}`)}</span>
          <span className="grow" />
          <select className="icon-btn px-hdr-lang" aria-label={t('shell.language')} value={i18n.language} onChange={(e) => applyLanguage(e.target.value as Language)} style={{ width: 'auto', padding: '0 6px', fontWeight: 700 }}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
          <div className="px-me">
            <button type="button" className="px-me-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <span className="pp-av">{staff.name.slice(0, 1).toUpperCase()}</span>
              <span className="px-me-t">
                <b>{staff.name}</b>
                <small>{t(`platform.roles.${staff.role}`)}</small>
              </span>
              <Icon name="chevron" className="px-me-ch" />
            </button>
            {menu && (
              <div className="px-me-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" role="menuitem" onClick={() => (setMenu(false), setPw(true))}>
                  <Icon name="lock" />
                  {t('platform.changePassword')}
                </button>
                <button type="button" role="menuitem" onClick={() => (location.hash = '#/accueil')}>
                  <Icon name="store" />
                  {t('platform.myShop')}
                </button>
                <hr />
                <button type="button" role="menuitem" className="px-me-out" onClick={onLogout}>
                  <Icon name="logout" />
                  {t('shell.logout')}
                </button>
              </div>
            )}
          </div>
        </header>
        <main className="page pp-page">{page}</main>
      </div>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const save = usePAction('p.me.password', { success: t('shell.passwordChanged'), onDone: onClose });
  return (
    <Modal
      title={t('platform.changePassword')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={next.length < 10 || save.isPending} onClick={() => save.mutate({ current: cur, next })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label={t('shell.currentPassword')}>
          <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label={t('shell.newPassword')} hint={t('platform.passwordHint')}>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
