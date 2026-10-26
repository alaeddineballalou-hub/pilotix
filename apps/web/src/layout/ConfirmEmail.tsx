import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmEmail } from '../lib/backend';

/** The page opened from the welcome e-mail: #/confirmer/<secret>. */
export function ConfirmEmail({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  useEffect(() => {
    confirmEmail(token)
      .then((r) => setState({ ok: r.shop }))
      .catch((e) => setState({ error: e?.message || t('common.error') }));
  }, [token, t]);
  const go = () => {
    // the secret leaves the address bar and the history
    history.replaceState(null, '', `${location.pathname}${location.search}#/accueil`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  return (
    <div className="login">
      <div className="card login-card">
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <h2 className="login-title">{t('shop.confirm.title')}</h2>
        <p className={state.error ? 'form-err' : 'login-note'}>{state.ok ? t('shop.confirm.done', { shop: state.ok }) : state.error ?? '…'}</p>
        <button type="button" className="btn primary big" onClick={go}>
          {t('shop.confirm.open')}
        </button>
      </div>
    </div>
  );
}
