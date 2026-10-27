import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resetPasswordWithLink } from '../lib/backend';
import { AuthShell, AuthTitle, PasswordInput } from './AuthShell';

/**
 * The page opened from the "mot de passe oublié" e-mail (#/reset/<secret>), or from an invitation (#/invite/<secret>):
 * the person chooses their password, for every store they work in. Only they know it.
 */
export function ResetPassword({ token, invite }: { token: string; invite?: boolean }) {
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
    <AuthShell>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <AuthTitle a={invite ? t('login.inviteTitle') : t('login.resetTitle')} sub={invite && !done ? t('login.inviteText') : done ? t('login.resetDone') : undefined} />
        {done ? (
          <button type="button" className="pxa-submit" onClick={toLogin}>
            {t('login.submit')}
          </button>
        ) : (
          <>
            <label className="field">
              <span className="lab">{t('login.resetNew')}</span>
              <PasswordInput id="reset-password" autoComplete="new-password" required minLength={8} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="hint">{t('login.resetHint')}</span>
            </label>
            <label className="field">
              <span className="lab">{t('login.resetAgain')}</span>
              <PasswordInput id="reset-password-again" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            {error && <p className="form-err">{error}</p>}
            <button className="pxa-submit" disabled={busy}>
              {busy ? '…' : t('login.resetSave')}
            </button>
            <button type="button" className="pxa-back" onClick={toLogin}>
              ← {t('login.backToLogin')}
            </button>
          </>
        )}
      </form>
    </AuthShell>
  );
}
