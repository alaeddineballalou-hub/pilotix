// « Continuer avec Google » on the sign-in and sign-up pages. The button is Google's own (its official logo and words);
// it shows only when Pilotix put its Google client id in the control room (Paramètres → Connexion Google). Google
// gives a token, the server checks it with Google.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BACKUP_DOOR, DEMO_ONLY, serverUrl, signupInfo } from '../lib/backend';
import { useSession } from '../lib/session';

declare global {
  interface Window {
    google?: any;
  }
}

const loaded = new Map<string, Promise<void>>();
function script(src: string) {
  if (!loaded.has(src))
    loaded.set(
      src,
      new Promise<void>((ok, bad) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.defer = true;
        s.onload = () => ok();
        s.onerror = () => (loaded.delete(src), bad(new Error('script')));
        document.head.appendChild(s);
      }),
    );
  return loaded.get(src)!;
}

/** the account type chosen on the sign-up page: the welcome step after Google opens that kind */
export const SOCIAL_KIND = 'px-social-kind';

export function SocialButtons({ mode, kind, onError }: { mode: 'login' | 'signup'; kind?: string; onError: (m: string) => void }) {
  const { t, i18n } = useTranslation();
  const { loginSocial } = useSession();
  const [ids, setIds] = useState<{ google: string } | null>(null);
  const [busy, setBusy] = useState<'' | 'google'>('');
  const gRef = useRef<HTMLDivElement>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const lang = (i18n.language || 'fr').slice(0, 2);

  useEffect(() => {
    // the backup door (direct.<platform>): Google only accepts the platform's own address, so e-mail and password there
    if (DEMO_ONLY || BACKUP_DOOR || !serverUrl()) return;
    let on = true;
    signupInfo().then((r) => on && setIds({ google: r.googleClientId || '' }));
    return () => {
      on = false;
    };
  }, []);

  const go = async (provider: 'google', token: string) => {
    onError('');
    setBusy(provider);
    try {
      try {
        if (mode === 'signup' && kindRef.current) sessionStorage.setItem(SOCIAL_KIND, kindRef.current);
        else sessionStorage.removeItem(SOCIAL_KIND);
      } catch {}
      await loginSocial(provider, token);
    } catch (e: any) {
      onError(e?.message || t('common.error'));
    } finally {
      setBusy('');
    }
  };
  const goRef = useRef(go);
  goRef.current = go;

  // Google: its own button, drawn by Google in the div
  useEffect(() => {
    if (!ids?.google || !gRef.current) return;
    let on = true;
    script('https://accounts.google.com/gsi/client')
      .then(() => {
        if (!on || !window.google || !gRef.current) return;
        window.google.accounts.id.initialize({
          client_id: ids.google,
          callback: (r: { credential?: string }) => r.credential && goRef.current('google', r.credential),
          ux_mode: 'popup',
          context: mode === 'signup' ? 'signup' : 'signin',
        });
        gRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(gRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: mode === 'signup' ? 'signup_with' : 'continue_with',
          logo_alignment: 'center',
          width: Math.min(400, Math.max(200, Math.round(gRef.current.parentElement?.clientWidth || 360))),
          locale: lang,
        });
      })
      .catch(() => on && onError(t('auth.social.noScript')));
    return () => {
      on = false;
    };
  }, [ids?.google, mode, lang]);

  if (!ids?.google) return null;
  return (
    <div className="pxa-social">
      {ids.google && <div className="pxa-g" ref={gRef} aria-busy={busy === 'google'} />}
      {busy && <p className="muted small pxa-social-wait">{t('auth.social.wait')}</p>}
      <div className="pxa-sep">{t('auth.social.orEmail')}</div>
    </div>
  );
}
