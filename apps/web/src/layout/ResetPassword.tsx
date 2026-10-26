import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resetPasswordWithLink } from '../lib/backend';

/** The page opened from the "mot de passe oublié" e-mail: #/reset/<secret>. */
export function ResetPassword({ token }: { token: string }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError(t('login.resetShort'));
    if (password !== again) return setError(t('login.resetMismatch'));
    setBusy(true);
    try {
      await resetPasswordWithLink(token, password);
      setDone(true);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  const toLogin = () => {
    // the secret leaves the address bar and the history
    history.replaceState(null, '', location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <h2 className="login-title">{t('login.resetTitle')}</h2>
        {done ? (
          <>
            <p className="login-note">{t('login.resetDone')}</p>
            <button type="button" className="btn primary big" onClick={toLogin}>
              {t('login.submit')}
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span className="lab">{t('login.resetNew')}</span>
              <input id="reset-password" type="password" dir="ltr" autoComplete="new-password" required minLength={8} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="hint">{t('login.resetHint')}</span>
            </label>
            <label className="field">
              <span className="lab">{t('login.resetAgain')}</span>
              <input id="reset-password-again" type="password" dir="ltr" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            {error && <p className="form-err">{error}</p>}
            <button className="btn primary big" disabled={busy}>
              {busy ? '…' : t('login.resetSave')}
            </button>
            <button type="button" className="login-link" onClick={toLogin}>
              {t('login.backToLogin')}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
