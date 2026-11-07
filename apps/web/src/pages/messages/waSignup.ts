// « Connecter WhatsApp » the way Meta asks: Embedded Signup in Meta's own popup (its JavaScript SDK, FB.login with
// Pilotix's WhatsApp configuration). The popup gives back a code (exchanged by the server, never here) and Meta's window
// says which WhatsApp Business account and which number were chosen (a « WA_EMBEDDED_SIGNUP » message).

export interface WaSdk {
  appId: string;
  configId: string;
  version: string;
  extras: Record<string, unknown>;
}
export interface WaSignupResult {
  code: string;
  wabaId: string | null;
  phoneId: string | null;
}

type FbLogin = (cb: (r: { authResponse?: { code?: string } | null; status?: string }) => void, opts: Record<string, unknown>) => void;
type FbApi = { init: (o: Record<string, unknown>) => void; login: FbLogin };
declare global {
  interface Window {
    FB?: FbApi;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FbApi> | null = null;
let readyFor = '';

/** Meta's SDK, loaded once, set up for Pilotix's app. */
export function loadFacebookSdk(sdk: WaSdk): Promise<FbApi> {
  if (loading && readyFor === sdk.appId) return loading;
  readyFor = sdk.appId;
  loading = new Promise<FbApi>((resolve, reject) => {
    const init = () => {
      const fb = window.FB;
      if (!fb) return reject(new Error('Meta'));
      fb.init({ appId: sdk.appId, autoLogAppEvents: false, xfbml: false, version: sdk.version });
      resolve(fb);
    };
    if (window.FB) return init();
    window.fbAsyncInit = init;
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => {
      loading = null;
      reject(new Error('Meta'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Meta's window speaks only from facebook.com: what it says about the account and number chosen (or where it stopped). */
function signupMessage(e: MessageEvent): { wabaId?: string; phoneId?: string; cancelled?: boolean } | null {
  let host = '';
  try {
    host = new URL(e.origin).hostname;
  } catch {
    return null;
  }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null;
  let d: any = e.data;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return null;
  if (d.event === 'CANCEL') return { cancelled: true };
  const x = d.data ?? {};
  const ok = (v: unknown) => (/^\d{1,30}$/.test(String(v ?? '')) ? String(v) : undefined);
  return { wabaId: ok(x.waba_id), phoneId: ok(x.phone_number_id) };
}

/**
 * Opens Meta's popup. Call it in the click itself (with the SDK already loaded): browsers block a popup opened later.
 * Resolves with the code and the chosen account and number; rejects « cancelled » when the person closed or stopped it.
 */
export function openWaSignup(fb: FbApi, sdk: WaSdk): Promise<WaSignupResult> {
  return new Promise((resolve, reject) => {
    const said: { wabaId?: string; phoneId?: string } = {};
    const listen = (e: MessageEvent) => {
      const m = signupMessage(e);
      if (m && !m.cancelled) Object.assign(said, m);
    };
    window.addEventListener('message', listen);
    // FB.login wants a plain function (not async)
    fb.login(
      (r) => {
        // Meta's message can arrive just after the code: a moment to hear it
        window.setTimeout(() => {
          window.removeEventListener('message', listen);
          const code = r?.authResponse?.code;
          if (code) resolve({ code, wabaId: said.wabaId ?? null, phoneId: said.phoneId ?? null });
          else reject(new Error('cancelled'));
        }, 800);
      },
      { config_id: sdk.configId, response_type: 'code', override_default_response_type: true, extras: sdk.extras },
    );
  });
}
