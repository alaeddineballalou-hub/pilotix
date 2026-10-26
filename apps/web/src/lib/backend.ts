import type { REGISTRY } from '@pilotix/core';
import type { Session } from '@pilotix/shared';
import type { z } from 'zod';
import { pageAi } from './dellal-page-ai';
import { currentShop } from './features';
import { store } from './store';

// ---------------------------------------------------------------- support tab
/**
 * Pilotix support opens a shop from the control room in a new tab (#/support/<token>): that tab keeps the shop's token
 * for itself (sessionStorage), never in the browser's shared storage — the other tabs stay in their own shop.
 */
const SUPPORT_KEY = 'px.stoken';
const tabToken = (): string | null => {
  try {
    return sessionStorage.getItem(SUPPORT_KEY);
  } catch {
    return null;
  }
};
(() => {
  const m = location.hash.match(/^#\/support\/([A-Za-z0-9._-]{20,2000})$/);
  if (!m) return;
  try {
    sessionStorage.setItem(SUPPORT_KEY, m[1]);
  } catch {
    /* storage unavailable */
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#/accueil`);
})();
/** This tab was opened by Pilotix support (its session is not kept for the other tabs). */
export const isSupportTab = () => !!tabToken();

// ---------------------------------------------------------------- typed actions
type Reg = typeof REGISTRY;
export type ProcName = keyof Reg;
export type In<N extends ProcName> = z.input<Reg[N]['input']>;
export type Out<N extends ProcName> = Awaited<ReturnType<Reg[N]['run']>>;

export interface LiveEvent {
  type: string;
  id?: number;
  data?: unknown;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** "Couldn't reach the server" (the action can be queued and retried). */
export const isNetworkError = (e: unknown) => e instanceof ApiError && e.status === 0;

/** A shop the store picker offers (one person may work in several shops). */
export interface ShopChoice {
  id: number;
  name: string;
  slug: string;
  roles: string[];
  state: string;
  locked: boolean;
  primary: boolean;
  /** the shop open now (« Mes boutiques ») */
  current?: boolean;
  /** opens without the password again (it opened at login) */
  open?: boolean;
}
/** A login: the session, or the shops the password opens when there are several (the store picker). */
export type LoginResult = Session | { choose: ShopChoice[] };
export const isChoice = (r: LoginResult): r is { choose: ShopChoice[] } => 'choose' in r;

export interface Backend {
  kind: 'remote' | 'demo';
  login(email: string, password: string): Promise<LoginResult>;
  resume(): Promise<Session | null>;
  logout(): void;
  call<N extends ProcName>(name: N, input: In<N>): Promise<Out<N>>;
  onEvent(fn: (e: LiveEvent) => void): () => void;
}

// ---------------------------------------------------------------- real server
/**
 * The website of a shop (built with its server's address, opened at that address) always talks to that server: nobody
 * can talk an employee into typing another « server » that would receive their password. Only the phone apps (served
 * from localhost) and development ask for it.
 */
export const FIXED_SERVER = !!import.meta.env.VITE_API_URL && /^https?:$/.test(location.protocol) && !['localhost', '127.0.0.1'].includes(location.hostname);

export function serverUrl(): string {
  return ((FIXED_SERVER ? '' : store.get('server')) || import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
}
export function setServerUrl(url: string) {
  store.set('server', url.trim().replace(/\/+$/, '') || null);
}

/** "Mot de passe oublié" (no login): asks the server, at its own address, without a session. */
async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const base = serverUrl();
  if (!base) throw new ApiError(0, 'Adresse du serveur manquante');
  let res: Response;
  try {
    res = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, (data as any)?.message || res.statusText);
  return data as T;
}
/** Does this server send reset e-mails? (false when unknown: the link is then not shown) */
export const forgotAvailable = () =>
  authRequest<{ available: boolean }>('/auth/forgot')
    .then((r) => !!r.available)
    .catch(() => false);
export const requestPasswordReset = (email: string) => authRequest<{ ok: true }>('/auth/forgot', { email });
export const resetPasswordWithLink = (token: string, password: string) => authRequest<{ ok: true }>('/auth/reset', { token, password });

/** The server's demo shop (its button on the login page), when Pilotix turned it on. */
export const serverDemo = () =>
  authRequest<{ available: boolean; accounts: { key: string; name: string; role: string }[] }>('/auth/demo').catch(() => ({ available: false, accounts: [] as { key: string; name: string; role: string }[] }));

/**
 * The address of the shop's public links (webhooks, landing pages, given to customers and other services):
 * <server>/api, plus /s/<shop> for every shop but the server owner's.
 */
export function shopApi(base: string): string {
  const s = currentShop();
  return `${base.replace(/\/+$/, '')}/api${s && !s.primary ? `/s/${s.slug}` : ''}`;
}

class RemoteBackend implements Backend {
  kind = 'remote' as const;
  /** a support tab keeps its own token */
  private readonly support = !!tabToken();
  private token = this.support ? tabToken() : store.get('token');
  private listeners = new Set<(e: LiveEvent) => void>();
  private socket: { disconnect(): void } | null = null;
  onUnauthorized: () => void = () => {};
  /** the shop's subscription stopped (unpaid, suspended): the app reloads the session and shows the lock screen */
  onLocked: () => void = () => {};

  private keep(token: string | null) {
    this.token = token;
    if (!this.support) return store.set('token', token);
    try {
      if (token) sessionStorage.setItem(SUPPORT_KEY, token);
      else sessionStorage.removeItem(SUPPORT_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const base = serverUrl();
    if (!base) throw new ApiError(0, 'Adresse du serveur manquante');
    let res: Response;
    try {
      res = await fetch(`${base}/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.');
    }
    const data = await res.json().catch(() => undefined);
    // after a password change the server hands this session a fresh token (the old ones stop working)
    if (res.ok && path === '/rpc/me.password' && typeof (data as any)?.token === 'string') this.keep((data as any).token);
    if (res.status === 401 && this.token) this.onUnauthorized();
    if (res.status === 402 && this.token) this.onLocked();
    if (!res.ok) throw new ApiError(res.status, (data as any)?.message || res.statusText);
    return data as T;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const r = await this.req<{ token?: string; session?: Session; choose?: ShopChoice[]; ticket?: string }>('/auth/login', { email, password });
    if (r.ticket) store.set('pick-ticket', r.ticket);
    if (r.choose) return { choose: r.choose };
    this.keep(r.token!);
    this.connect();
    return r.session!;
  }
  /** Opens a shop: one of the login's (the ticket), or another shop of my e-mail with its password. */
  async enter(shop: number, cred?: { email: string; password: string }) {
    return this.adopt(await this.req<Entered>('/auth/enter', { shop, ticket: store.get('pick-ticket'), ...cred }));
  }
  /** A shop opened by the server (store picker, sign-up, « Ajouter une boutique »): its token becomes this app's. */
  adopt(r: Entered) {
    if (r.ticket) store.set('pick-ticket', r.ticket);
    this.keep(r.token);
    this.connect();
    return r.session;
  }
  /** A request with this app's token (the actions outside /rpc: shops, domain). */
  request<T>(path: string, body?: unknown) {
    return this.req<T>(path, body ?? {});
  }
  /** Opens the server's demo shop as one of its accounts. */
  async demo(key: string) {
    const r = await this.req<{ token: string; session: Session }>('/auth/demo', { key });
    this.keep(r.token);
    this.connect();
    return r.session;
  }
  async resume() {
    if (!this.token) return null;
    try {
      const s = await this.call('me.get', {});
      this.connect();
      return s as Session;
    } catch (e) {
      if (isNetworkError(e)) {
        const saved = store.get('session');
        return saved ? (JSON.parse(saved) as Session) : null;
      }
      return null;
    }
  }
  logout() {
    this.keep(null);
    if (!this.support) store.set('pick-ticket', null);
    this.socket?.disconnect();
  }
  call<N extends ProcName>(name: N, input: In<N>): Promise<Out<N>> {
    return this.req(`/rpc/${name}`, input ?? {});
  }
  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private async connect() {
    this.socket?.disconnect();
    const { io } = await import('socket.io-client');
    const s = io(serverUrl(), { path: '/live', auth: { token: this.token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
    s.on('event', (e: LiveEvent) => this.listeners.forEach((l) => l(e)));
    this.socket = s;
  }
}

// ---------------------------------------------------------------- demo (PostgreSQL in the browser, same rules)
/** Actions whose result the demo keeps in this browser across reloads (its database is rebuilt each time). */
const DEMO_KEEP = new Set(['confirmation.addColPreset', 'confirmation.deleteColPreset', 'me.setUi']);
class DemoBackend implements Backend {
  kind = 'demo' as const;
  private session: Session | null = null;
  private listeners = new Set<(e: LiveEvent) => void>();
  private ready: Promise<{ core: typeof import('@pilotix/core'); db: import('@pilotix/core').Db }> | null = null;
  progress: (msg: string) => void = () => {};

  private boot() {
    void pageAi(); // start talking to Claude early when the preview is opened in Claude
    if (!this.ready)
      this.ready = (async () => {
        this.progress('Démarrage de la base de démonstration…');
        const [{ PGlite }, core] = await Promise.all([import('@electric-sql/pglite'), import('@pilotix/core')]);
        const pg = new PGlite();
        const db = core.pgliteDb(pg as any);
        await core.migrate(db, async (sql) => {
          await pg.exec(sql);
        });
        this.progress('Création des commandes d’exemple…');
        await core.seedDemo(db, { orders: Number(import.meta.env.VITE_DEMO_ORDERS) || 1200 });
        // the demo database is rebuilt on every reload: put back the column presets and screen choices kept in this browser
        await core.demoRestore(db, store.json<import('@pilotix/core').DemoKeep | null>('demo-keep', null)).catch(() => {});
        return { core, db };
      })();
    return this.ready;
  }
  async login(email: string, password: string) {
    const { core, db } = await this.boot();
    try {
      this.session = await core.login(db, email, password);
    } catch (e: any) {
      throw new ApiError(401, e.message);
    }
    store.set('demo-user', email);
    return this.session;
  }
  async resume() {
    const email = store.get('demo-user');
    if (!email) return null;
    try {
      const { DEMO_PASSWORD } = await import('@pilotix/shared');
      return await this.login(email, DEMO_PASSWORD);
    } catch {
      return null;
    }
  }
  logout() {
    this.session = null;
    store.set('demo-user', null);
  }
  async call<N extends ProcName>(name: N, input: In<N>): Promise<Out<N>> {
    const { core, db } = await this.boot();
    if (!this.session) throw new ApiError(401, 'Session expirée');
    const s = this.session;
    // Dellal, the CM AI agent and AI Spy answer with Claude when the preview is opened in Claude (see dellal-page-ai.ts)
    const dellalAi = /^(dellal|cm|spy)\./.test(String(name)) ? await pageAi() : null;
    try {
      const out = (await core.call(name as string, { db, session: s, now: () => Date.now(), emit: (e) => setTimeout(() => this.listeners.forEach((l) => l(e)), 0), ...(dellalAi ? { dellalAi } : {}) }, input)) as Out<N>;
      if (DEMO_KEEP.has(name as string)) await core.demoSnapshot(db).then((k) => store.set('demo-keep', JSON.stringify(k))).catch(() => {});
      return out;
    } catch (e: any) {
      const status = { forbidden: 403, not_found: 404, bad_request: 400, conflict: 409, unauthorized: 401 }[e?.code as string] ?? 500;
      throw new ApiError(status, e?.message ?? 'Erreur');
    }
  }
  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const DEMO_AVAILABLE = import.meta.env.VITE_DEMO === '1';
/** In the preview build (no server) the demo is the only backend. */
export const DEMO_ONLY = import.meta.env.VITE_DEMO_ONLY === '1';

const remote = new RemoteBackend();
let demo: DemoBackend | null = null;
export let backend: Backend = DEMO_ONLY || (DEMO_AVAILABLE && store.get('mode') === 'demo') ? (demo = new DemoBackend()) : remote;

export function switchDemo(on: boolean) {
  store.set('mode', on ? 'demo' : null);
  backend = on ? (demo ??= new DemoBackend()) : remote;
  return backend;
}
export const onDemoProgress = (fn: (m: string) => void) => {
  if (backend instanceof DemoBackend) backend.progress = fn;
};
export const setOnUnauthorized = (fn: () => void) => (remote.onUnauthorized = fn);
export const setOnLocked = (fn: () => void) => (remote.onLocked = fn);
/** The server's demo shop, opened from the login page. */
export function loginServerDemo(key: string) {
  switchDemo(false);
  return remote.demo(key);
}

// ---------------------------------------------------------------- shops of one person, sign-up, own domain (server only)
interface Entered {
  token: string;
  session: Session;
  ticket?: string;
}
const onServer = () => {
  if (backend !== remote) throw new ApiError(400, 'Pas dans la démo');
  return remote;
};
export const enterShop = (shop: number, cred?: { email: string; password: string }) => remote.enter(shop, cred);
export const myShops = () => onServer().request<{ shops: ShopChoice[]; canAdd?: boolean; max?: number }>('/auth/shops', { ticket: store.get('pick-ticket') });
export async function addShop(body: { shopName: string; slug?: string; password: string }) {
  const r = await onServer().request<Entered & { mailSent: boolean }>('/shop/add', body);
  return { session: remote.adopt(r), mailSent: r.mailSent };
}
export interface SignupInfo {
  open: boolean;
  trialDays: number;
  plan: { name: string; priceMonth: number } | null;
  publicUrl: string;
}
export const signupInfo = () => authRequest<SignupInfo>('/auth/signup').catch(() => null);
export const slugCheck = (q: { name?: string; slug?: string }) => authRequest<{ slug: string; valid: boolean; available: boolean; suggestion: string }>('/auth/slug', q);
export async function signup(body: Record<string, unknown>) {
  switchDemo(false);
  const r = await authRequest<Entered & { mailSent: boolean }>('/auth/signup', body);
  return { session: remote.adopt(r), mailSent: r.mailSent };
}
export const confirmEmail = (token: string) => authRequest<{ ok: true; shop: string }>('/auth/confirm', { token });
export const confirmAgain = () => onServer().request<{ ok: true; sent: boolean }>('/shop/confirm-again');
export interface DomainState {
  domain: string | null;
  status: 'none' | 'pending' | 'ok';
  ips?: string[];
  host?: string;
}
export const domainGet = () => onServer().request<DomainState>('/shop/domain/get');
export const domainSet = (domain: string | null) => onServer().request<DomainState>('/shop/domain', { domain });
export const domainCheck = () => onServer().request<{ ok: boolean; found: string[]; expected: string[] }>('/shop/domain/check');

/** Call an action on the current backend (server or demo). */
export function rpc<N extends ProcName>(name: N, input: In<N>): Promise<Out<N>> {
  return backend.call(name, input);
}
