import { LANGUAGES, Language } from '@pilotix/shared';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, demoAvailable, serverUrl, setServerUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { applyLanguage } from '../lib/i18n';

const DEMO_USERS: { role: 'admin' | 'agent' | 'depot' | 'livreur'; id: number }[] = [
  { role: 'admin', id: 1 },
  { role: 'agent', id: 4 },
  { role: 'depot', id: 7 },
  { role: 'livreur', id: 8 },
];

const langLabel: Record<Language, string> = { fr: 'Français', en: 'English', ar: 'العربية' };

export function Login() {
  const { t, i18n } = useTranslation();
  const { login, loginDemo } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(serverUrl());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    setServerUrl(server);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 0 ? t('login.noServer') : t('login.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <span className="logo" role="img" aria-label="Pilotix" />
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
          {t('app.tagline')}
        </p>
        <div className="lang-switch">
          {LANGUAGES.map((l) => (
            <button type="button" key={l} className={`tab ${i18n.language === l ? 'on' : ''}`} onClick={() => applyLanguage(l)}>
              {langLabel[l]}
            </button>
          ))}
        </div>
        <label className="field">
          <span>{t('login.email')}</span>
          <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.dz" />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('login.server')}</span>
          <input type="url" dir="ltr" required value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://api.pilotix.dz" />
          <small className="muted">{t('login.serverHint')}</small>
        </label>
        {error && <p className="err">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {t('login.submit')}
        </button>
        {demoAvailable && (
          <div className="demo-box">
            <b>{t('demo.title')}</b>
            <span className="small muted">{t('demo.hint')}</span>
            <div className="row">
              {DEMO_USERS.map((d) => (
                <button type="button" key={d.id} className="btn small" onClick={() => loginDemo(d.id)}>
                  {t(`roles.${d.role}`)}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
