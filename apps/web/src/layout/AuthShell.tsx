// The sign-in / sign-up / password pages: a split screen. One side is the form (logo and language at the top, the title
// with one marked word, the fields, the footer with help, terms and privacy); the other side shows Pilotix at work — a
// headline, the app in a browser frame, a phone with the order list and a « Nouvelle commande » notification. All drawn
// here (no photos). On phones only the form is shown. The form comes first in the page, so in Arabic it is on the right.
import { Language, LANGUAGES } from '@pilotix/shared';
import { InputHTMLAttributes, ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { signupInfo } from '../lib/backend';
import { applyLanguage } from '../lib/i18n';
import { Icon } from '../ui/kit';
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
  const [wa, setWa] = useState('');
  useEffect(() => {
    let on = true;
    signupInfo().then((r) => on && setWa(String(r.whatsapp ?? '').replace(/[^\d+]/g, '')));
    return () => {
      on = false;
    };
  }, []);
  const others = LANGUAGES.filter((l) => l !== i18n.language);
  return (
    <div className="pxa">
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
      <Showcase />
    </div>
  );
}

/** Pilotix at work: the headline, the app in a browser, a phone with orders and a new-order notification. */
function Showcase() {
  const { t } = useTranslation();
  const bars = [38, 52, 45, 63, 58, 72, 80];
  return (
    <aside className="pxa-show" aria-hidden="true">
      <h2>
        {t('auth.show1')} <mark>{t('auth.show2')}</mark>
      </h2>
      <div className="pxa-stage">
        <div className="pxa-browser">
          <div className="pxa-bbar">
            <i />
            <i />
            <i />
            <span>{t('auth.showUrl')}</span>
          </div>
          <div className="pxa-app">
            <div className="pxa-app-nav">
              <b>pilotix</b>
              {['home', 'phone', 'package', 'truck', 'wallet'].map((n, k) => (
                <span key={n} className={k === 0 ? 'on' : ''}>
                  <Icon name={n} />
                </span>
              ))}
            </div>
            <div className="pxa-app-main">
              <div className="pxa-kpis">
                <div>
                  <small>{t('auth.k1')}</small>
                  <b>128</b>
                </div>
                <div>
                  <small>{t('auth.k2')}</small>
                  <b className="ok">86 %</b>
                </div>
                <div>
                  <small>{t('auth.k3')}</small>
                  <b>412 600 DA</b>
                </div>
              </div>
              <div className="pxa-chart">
                {bars.map((h, k) => (
                  <i key={k} style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="pxa-rows">
                {[0, 1, 2].map((k) => (
                  <div key={k}>
                    <span />
                    <span />
                    <em className={k === 1 ? 'or' : 'ok'} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="pxa-phone">
          <div className="pxa-notch" />
          <div className="pxa-ph-title">{t('auth.phTitle')}</div>
          {[
            ['Amina B.', 'Sétif', '7 700 DA', 'ok'],
            ['Yacine K.', 'Oran', '12 600 DA', 'or'],
            ['Sara M.', 'Alger', '4 550 DA', 'ok'],
            ['Nadir H.', 'Blida', '9 300 DA', 'ok'],
          ].map(([n, w, v, c]) => (
            <div key={n} className="pxa-ph-row">
              <span className="pxa-av">{n.slice(0, 1)}</span>
              <span className="pxa-ph-n">
                <b>{n}</b>
                <small>{w}</small>
              </span>
              <span className="pxa-ph-v">
                <b>{v}</b>
                <em className={c} />
              </span>
            </div>
          ))}
        </div>
        <div className="pxa-toast">
          <span className="pxa-toast-ic">
            <Icon name="package" />
          </span>
          <span>
            <b>{t('auth.toast', { ref: 'PX01051', city: 'Sétif' })}</b>
            <small>{t('auth.toastNow')}</small>
          </span>
        </div>
      </div>
    </aside>
  );
}
