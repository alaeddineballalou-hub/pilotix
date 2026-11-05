// Cloudflare's robot check (Turnstile), asked by the server after a few wrong passwords (apps/server/src/robot.ts):
// an invisible check (a person sees nothing), its token sent with the same login again.
import { ApiError } from './backend';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<any> | null = null;

function turnstile(): Promise<any> {
  const w = window as any;
  if (w.turnstile) return Promise.resolve(w.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** A token from Cloudflare for this site key (30 seconds at most). */
export async function robotToken(siteKey: string): Promise<string> {
  const ts = await turnstile().catch(() => {
    throw new ApiError(0, 'La vérification anti-robot n’a pas pu se charger. Vérifiez votre connexion, puis réessayez.');
  });
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999';
  document.body.appendChild(box);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new ApiError(0, 'La vérification anti-robot n’a pas abouti. Réessayez.')), 30_000);
      ts.render(box, {
        sitekey: siteKey,
        callback: (token: string) => {
          window.clearTimeout(timer);
          resolve(token);
        },
        'error-callback': () => {
          window.clearTimeout(timer);
          reject(new ApiError(0, 'La vérification anti-robot n’a pas abouti. Réessayez.'));
        },
      });
    });
  } finally {
    box.remove();
  }
}

/** A login: when the server asks the robot check (after a few wrong passwords), it is done and the login sent again. */
export async function withRobotCheck<T>(send: (turnstile?: string) => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    const site = e instanceof ApiError ? (e.data as { challenge?: unknown } | undefined)?.challenge : undefined;
    if (typeof site !== 'string' || !site) throw e;
    return send(await robotToken(site));
  }
}
