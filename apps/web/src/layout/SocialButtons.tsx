// « Continuer avec Google » on the sign-in and sign-up pages: Pilotix's own plain button in Google's look (its official
// « G » and words), never a name or a photo on it (26 Nov 2026: Google's own button showed « Continue as Ala Eddine » to
// whoever used the computer). A click opens Google's window, where the person always chooses the account; Google gives
// a key, the server checks it with Google (made for Pilotix's app, e-mail proven). It shows only when Pilotix put its
// Google client id in the control room (Paramètres → Connexion Google).
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

/** Google's « G », as Google gives it for sign-in buttons (its four colours, never changed) */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function SocialButtons({ mode, kind, onError }: { mode: 'login' | 'signup'; kind?: string; onError: (m: string) => void }) {
  const { t } = useTranslation();
  const { loginSocial } = useSession();
  const [ids, setIds] = useState<{ google: string } | null>(null);
  const [busy, setBusy] = useState<'' | 'google'>('');
  // Google's window, made as soon as its script is here: a click must open it at once (browsers block a late window)
  const client = useRef<{ requestAccessToken: (o?: Record<string, unknown>) => void } | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const tRef = useRef(t);
  tRef.current = t;
  const errRef = useRef(onError);
  errRef.current = onError;

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
    errRef.current('');
    setBusy(provider);
    try {
      try {
        if (mode === 'signup' && kindRef.current) sessionStorage.setItem(SOCIAL_KIND, kindRef.current);
        else sessionStorage.removeItem(SOCIAL_KIND);
      } catch {}
      await loginSocial(provider, token, 'access');
    } catch (e: any) {
      errRef.current(e?.message || tRef.current('common.error'));
    } finally {
      setBusy('');
    }
  };
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    if (!ids?.google) return;
    let on = true;
    script('https://accounts.google.com/gsi/client')
      .then(() => {
        if (!on || !window.google?.accounts?.oauth2) return;
        client.current = window.google.accounts.oauth2.initTokenClient({
          client_id: ids.google,
          scope: 'openid email profile',
          // always the list of accounts: never the last one used on this computer without asking
          prompt: 'select_account',
          callback: (r: { access_token?: string; error?: string }) => {
            if (r?.access_token) void goRef.current('google', r.access_token);
            // « Annuler » in Google's window is the person's choice: nothing to say
            else if (r?.error && r.error !== 'access_denied') errRef.current(tRef.current('auth.social.failed'));
          },
          error_callback: (e: { type?: string }) => {
            // the window closed by the person: nothing to say; blocked by the browser: how to let it open
            if (e?.type === 'popup_failed_to_open') errRef.current(tRef.current('auth.social.popup'));
          },
        });
      })
      .catch(() => on && errRef.current(tRef.current('auth.social.noScript')));
    return () => {
      on = false;
    };
  }, [ids?.google]);

  if (!ids?.google) return null;
  return (
    <div className="pxa-social">
      <div className="pxa-g">
        <button
          type="button"
          className="pxa-gbtn"
          disabled={!!busy}
          aria-busy={busy === 'google'}
          onClick={() => {
            errRef.current('');
            client.current?.requestAccessToken({ prompt: 'select_account' });
          }}
        >
          <span className="pxa-gbtn-in">
            <GoogleG />
            <span className="pxa-gbtn-txt">{mode === 'signup' ? t('auth.social.googleSignup') : t('auth.social.google')}</span>
          </span>
        </button>
      </div>
      {busy && <p className="muted small pxa-social-wait">{t('auth.social.wait')}</p>}
      <div className="pxa-sep">{t('auth.social.orEmail')}</div>
    </div>
  );
}
