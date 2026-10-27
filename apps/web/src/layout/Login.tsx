import { DEMO_ACCOUNTS, DEMO_PASSWORD, Language, LANGUAGES } from '@pilotix/shared';
import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, DEMO_AVAILABLE, DEMO_ONLY, FIXED_SERVER, forgotAvailable, onDemoProgress, requestPasswordReset, serverDemo, serverUrl, setServerUrl, signupInfo, switchDemo } from '../lib/backend';
import { applyLanguage } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Icon } from '../ui/kit';

const LANG: Record<Language, string> = { fr: 'Français', en: 'English', ar: 'العربية' };

export function Login() {
  const { t, i18n } = useTranslation();
  const { login, loginDemo } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(serverUrl());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState('');

  // "Mot de passe oublié": shown only when the server can send the e-mail
  const [canReset, setCanReset] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);

  // the server's demo shop (Pilotix turned its button on): a few of its accounts
  const [srvDemo, setSrvDemo] = useState<{ key: string; name: string; role: string }[]>([]);
  // « Créer ma boutique » when Pilotix opened sign-ups
  const [canSignup, setCanSignup] = useState(false);

  useEffect(() => onDemoProgress(setProgress), [busy]);
  useEffect(() => {
    if (DEMO_ONLY || !serverUrl()) return;
    let on = true;
    forgotAvailable().then((ok) => on && setCanReset(ok));
    signupInfo().then((r) => on && setCanSignup(r.open));
    serverDemo().then((d) => on && d.available && setSrvDemo(d.accounts.filter((a) => ['admin', 'conf1', 'depot', 'livreur', 'marketer'].includes(a.key))));
    return () => {
      on = false;
    };
  }, []);

  async function tryServerDemo(key: string) {
    setError('');
    setBusy(`demo:${key}`);
    try {
      await loginDemo(key);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function sendReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy('forgot');
    try {
      if (!FIXED_SERVER) setServerUrl(server);
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  function backToLogin() {
    setForgot(false);
    setSent(false);
    setError('');
  }

  if (forgot)
    return (
      <div className="login">
        <form className="card login-card" onSubmit={sendReset}>
          <span className="brand-big" role="img" aria-label="Pilotix">
            Pilotix
          </span>
          <h2 className="login-title">{t('login.forgotTitle')}</h2>
          {sent ? (
            <p className="login-note">{t('login.forgotSent')}</p>
          ) : (
            <>
              <p className="login-note">{t('login.forgotText')}</p>
              <label className="field">
                <span className="lab">{t('login.email')}</span>
                <input id="forgot-email" type="email" dir="ltr" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              {error && <p className="form-err">{error}</p>}
              <button className="btn primary big" disabled={!!busy}>
                {busy ? '…' : t('login.forgotSend')}
              </button>
            </>
          )}
          <button type="button" className="login-link" onClick={backToLogin}>
            {t('login.backToLogin')}
          </button>
        </form>
      </div>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy('login');
    if (!DEMO_ONLY) {
      switchDemo(false);
      setServerUrl(server);
    }
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err?.message || t('login.error'));
    } finally {
      setBusy(null);
    }
  }

  async function demo(email: string) {
    setError('');
    setBusy(email);
    switchDemo(true);
    onDemoProgress(setProgress);
    try {
      await login(email, DEMO_PASSWORD);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
          {t('login.tagline')}
        </p>
        <div className="tabs" style={{ justifyContent: 'center' }}>
          {LANGUAGES.map((l) => (
            <button type="button" key={l} className={`tab ${i18n.language === l ? 'on' : ''}`} onClick={() => applyLanguage(l)}>
              {LANG[l]}
            </button>
          ))}
        </div>
        {!DEMO_ONLY && (
          <>
            <label className="field">
              <span className="lab">{t('login.email')}</span>
              <input id="login-email" type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="lab">{t('login.password')}</span>
              <input id="login-password" type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {!FIXED_SERVER && (
            <label className="field">
              <span className="lab">{t('login.server')}</span>
              <input id="login-server" type="url" dir="ltr" required value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://api.votre-boutique.dz" />
              <span className="hint">{t('login.serverHint')}</span>
            </label>
            )}
            {error && <p className="form-err">{error}</p>}
            <button className="btn primary big" disabled={!!busy}>
              {t('login.submit')}
            </button>
            {canReset && (
              <button type="button" className="login-link" onClick={() => (setForgot(true), setError(''))}>
                {t('login.forgot')}
              </button>
            )}
            {canSignup && (
              <div className="px-signup-cta">
                <span className="muted">{t('login.noAccount')}</span>
                <a className="btn" href="#/inscription">
                  <Icon name="store" /> {t('login.createStore')}
                </a>
              </div>
            )}
          </>
        )}
        {!DEMO_ONLY && srvDemo.length > 0 && (
          <div className="demo-accounts">
            <p className="small">
              <b>{t('login.demoServer')}</b> — {t('login.demoServerText')}
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {srvDemo.map((a) => (
                <button key={a.key} type="button" className="btn small" disabled={!!busy} onClick={() => tryServerDemo(a.key)}>
                  {busy === `demo:${a.key}` ? '…' : t(`roles.${a.role}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {(DEMO_AVAILABLE || DEMO_ONLY) && (
          <div className="demo-accounts">
            <p className="small">
              <b>{t('login.demo')}</b> — {t('login.demoText')}
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {DEMO_ACCOUNTS.map((a) => (
                <button key={a.email} type="button" className="btn small" disabled={!!busy} onClick={() => demo(a.email)}>
                  {busy === a.email ? '…' : `${t(`roles.${a.roles[0]}`)} (${a.name.replace(/ \(.*\)/, '')})`}
                </button>
              ))}
            </div>
            {busy && busy !== 'login' && <p className="muted small">{progress}</p>}
            {DEMO_ONLY && error && <p className="form-err">{error}</p>}
          </div>
        )}
        {!DEMO_ONLY && (
          <a className="login-link small" href="#/conditions">
            {t('login.terms')}
          </a>
        )}
      </form>
      {backend.kind === 'demo' && <span hidden>{progress}</span>}
    </div>
  );
}
