// The sign-in / sign-up / password pages: the form (the animated logo and the language at the top, the title with one
// marked word, the fields, the footer with help, terms and privacy) and one of the 20 designs (authThemes.tsx) beside
// it or behind it — drawn at random on each visit among those the control room turned on.
import { Language, LANGUAGES } from '@pilotix/shared';
import { InputHTMLAttributes, ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { signupInfo } from '../lib/backend';
import { applyLanguage } from '../lib/i18n';
import { Icon } from '../ui/kit';
import { ThemeGround, ThemePanel, useAuthTheme } from './authThemes';
import { BrandBig } from './PxWordmark';
import './auth.css';

const LANG: Record<Language, string> = { fr: 'Français', en: 'English', ar: 'العربية' };

/** « Bon <mark>retour</mark> »: the title with its marked words. */
export function AuthTitle({ a, b, sub }: { a: string; b?: string; sub?: ReactNode }) {
  return (
    <div className="pxa-head">
      <h1>
        {a}
        {b ? (
          <>
            {' '}
            <mark>{b}</mark>
          </>
        ) : null}
      </h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

/** « Connexion | Créer un compte »: the two pages, as tabs at the top of the form. */
export function AuthTabs({ on }: { on: 'login' | 'signup' }) {
  const { t } = useTranslation();
  return (
    <nav className="pxa-tabs" aria-label={t('auth.tabs')}>
      <a href="#/" className={on === 'login' ? 'on' : ''} aria-current={on === 'login' ? 'page' : undefined}>
        {t('auth.signIn')}
      </a>
      <a href="#/inscription" className={on === 'signup' ? 'on' : ''} aria-current={on === 'signup' ? 'page' : undefined}>
        {t('auth.createTab')}
      </a>
    </nav>
  );
}

/** A password field with its eye (show / hide). */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <span className="pxa-pw">
      <input {...props} type={show ? 'text' : 'password'} dir="ltr" />
      <button type="button" className="pxa-eye" aria-label={show ? t('auth.hidePw') : t('auth.showPw')} aria-pressed={show} onClick={() => setShow(!show)}>
        <Icon name={show ? 'eyeoff' : 'eye'} />
      </button>
    </span>
  );
}

export function AuthShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { t, i18n } = useTranslation();
  const theme = useAuthTheme();
  const [wa, setWa] = useState('');
  useEffect(() => {
    let on = true;
    signupInfo().then((r) => on && setWa(String(r.whatsapp ?? '').replace(/[^\d+]/g, '')));
    return () => {
      on = false;
    };
  }, []);
  const others = LANGUAGES.filter((l) => l !== i18n.language);
  const side = (
    <main className="pxa-side">
      <header className="pxa-top">
        <a href="#/" className="pxa-logo" aria-label="Pilotix">
          <BrandBig />
        </a>
        <nav className="pxa-lang" aria-label={t('auth.language')}>
          {others.map((l) => (
            <button key={l} type="button" lang={l} onClick={() => applyLanguage(l)}>
              {LANG[l]}
            </button>
          ))}
        </nav>
      </header>
      <div className={`pxa-form${wide ? ' wide' : ''}`}>{children}</div>
      <footer className="pxa-foot">
        {wa ? (
          <span>
            {t('auth.needHelp')}{' '}
            <a href={`https://wa.me/${wa.replace(/^\+/, '').replace(/^0/, '213')}`} target="_blank" rel="noreferrer">
              {t('auth.whatsapp')}
            </a>
          </span>
        ) : (
          <span />
        )}
        <span className="pxa-legal">
          <a href="#/conditions">{t('auth.terms')}</a>
          <a href="#/conditions">{t('auth.privacy')}</a>
        </span>
      </footer>
    </main>
  );
  const cls = `pxa pxt pxt-${theme.layout} pxt-s-${theme.side} pxt-id${theme.id} pxt-new${theme.dark ? ' pxt-dark' : ''}`;
  return theme.layout === 'split' ? (
    <div className={cls} data-design={theme.id}>
      {side}
      <ThemePanel theme={theme} />
    </div>
  ) : (
    <div className={cls} data-design={theme.id}>
      <ThemeGround theme={theme} />
      {side}
    </div>
  );
}
