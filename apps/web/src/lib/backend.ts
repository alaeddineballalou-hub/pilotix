import type { REGISTRY } from '@pilotix/core';
import type { Session } from '@pilotix/shared';
import type { z } from 'zod';
import { pageAi } from './dellal-page-ai';
import { currentShop } from './features';
import { ambientSeller, Seller } from './seller';
import { store } from './store';

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

/** One of the person's stores, as the picker shows it. */
export interface StoreChoice {
  id: number;
  name: string;
  slug: string;
  state: string;
  locked: boolean;
  owner: boolean;
  primary: boolean;
  /** a store, or a partner's own space (a confirmation agency, a marketer) */
  kind?: 'store' | 'agency' | 'marketer';
}
/** After the password: several stores (or none) → the picker, with a ticket to choose without the password again. */
export interface PickInfo {
  pick: true;
  ticket: string;
  account: { name: string; email: string; verified: boolean };
  stores: StoreChoice[];
  canAddStore: boolean;
  /** « Créer mon agence » (the person has no confirmation agency yet) */
  canAddAgency?: boolean;
  /** « Créer mon espace marketer » (the person has no marketer space yet) */
  canAddMarketer?: boolean;
}
/**
 * After the password: the account has no number of its own yet (or it is not proven while the WhatsApp code is on) →
 * « Vérifiez votre numéro », with the same ticket; then the store (`shop`), the picker or the only store.
 */
export interface PhoneInfo {
  phone: true;
  ticket: string;
  account: { name: string; email: string };
  /** the number already known (to prove), or null (the person types it) */
  current: string | null;
  /** a code is sent by WhatsApp */
  otp: boolean;
  shop: number | null;
}
/** The WhatsApp code left: where, when the next one can be asked, how long it lives (seconds). */
export interface PhoneSent {
  sent: true;
  phone: string;
  masked: string;
  wait: number;
  ttl: number;
}
export type LoginResult = Session | PickInfo | PhoneInfo;
export const isPick = (r: LoginResult): r is PickInfo => (r as PickInfo).pick === true;
export const isPhone = (r: unknown): r is PhoneInfo => (r as PhoneInfo)?.phone === true;

export interface Backend {
  kind: 'remote' | 'demo';
  login(email: string, password: string): Promise<LoginResult>;
  resume(): Promise<Session | null>;
  logout(): void;
  /** `seller`: in a confirmation agency's space, the seller (store) whose orders the action works on */
  call<N extends ProcName>(name: N, input: In<N>, seller?: Seller): Promise<Out<N>>;
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

/**
 * The backup door: the same app and server at direct.<platform> (pilotix.online → direct.pilotix.online), reached
 * WITHOUT Cloudflare, for when Cloudflare's road from a country is cut. Opened there, the app talks to the address it
 * was opened from (the platform's own address may be the one that does not answer); the links it shows keep the
 * platform's address (serverUrl).
 */
export const BACKUP_DOOR =
  FIXED_SERVER &&
  (() => {
    try {
      return location.hostname === `direct.${new URL(import.meta.env.VITE_API_URL).hostname}`;
    } catch {
      return false;
    }
  })();
/** Where the app sends its requests and opens its live updates: the server's address, or the backup door it was opened from. */
export function apiUrl(): string {
  return BACKUP_DOOR ? location.origin : serverUrl();
}
export function setServerUrl(url: string) {
  store.set('server', url.trim().replace(/\/+$/, '') || null);
}

/** "Mot de passe oublié" (no login): asks the server, at its own address, without a session. */
async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const base = apiUrl();
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
/** What a link is: an invitation (« choose your password »), a new-password link, or nothing (used, too old). */
export const linkKind = (token: string) => authRequest<{ kind: 'reset' | 'invite' | null }>(`/auth/link/${encodeURIComponent(token)}`).catch(() => ({ kind: null }));
/** The e-mail check link. */
export const verifyEmail = (token: string) => authRequest<{ ok: true }>('/auth/verify', { token });

// ---------------------------------------------------------------- « Créer ma boutique »
export interface SignupInfo {
  open: boolean;
  trialDays: number;
  site: string;
  /** the WhatsApp of the « Besoin d'aide ? » link */
  whatsapp?: string;
  /** the sign-in page designs turned on in the control room (missing: an older server, all of them) */
  designs?: number[];
  /** the Google client id (control room); empty: no button */
  googleClientId?: string;
  /** the form proves the phone with a WhatsApp code before the account is opened */
  phoneCode?: boolean;
}
export const signupInfo = () => authRequest<SignupInfo>('/auth/signup').catch((): SignupInfo => ({ open: false, trialDays: 0, site: '', whatsapp: '' }));
export const storeNameCheck = (name: string, slug?: string) =>
  authRequest<{ slug: string; free: boolean; reason: string | null }>(`/auth/store-name?name=${encodeURIComponent(name)}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`);
export interface SignupForm {
  name: string;
  email: string;
  password: string;
  phone?: string | null;
  /** the WhatsApp code sent to the phone (when the server asks it) */
  phoneCode?: string;
  storeName: string;
  slug?: string;
  language: 'fr' | 'en' | 'ar';
  referral?: string;
  terms: true;
  /** « Créer mon agence » / « Créer mon espace marketer »: a partner's space (storeName is its name) */
  kind?: 'store' | 'agency' | 'marketer';
}
export const signup = (f: SignupForm) => authRequest<{ ok: true }>('/auth/signup', f);
/** While a phone is typed: not a mobile (« invalid »), another account's (« taken »), or free (null). */
export const phoneCheck = (phone: string, ticket?: string) =>
  authRequest<{ phone: string | null; problem: 'invalid' | 'taken' | null }>('/auth/phone-check', { phone, ...(ticket ? { ticket } : {}) });
/** « Recevoir le code »: a WhatsApp code to the phone typed in the sign-up form. */
export const signupCode = (phone: string) => authRequest<PhoneSent>('/auth/signup/code', { phone });
/** The terms of use and privacy page (Pilotix's own text, else the app's standard one). */
export const legalText = () => authRequest<{ text: string; company: string; email: string }>('/legal').catch(() => ({ text: '', company: 'Pilotix', email: '' }));

/** Pilotix's list of Pro marketers (the public page #/pro), or one of them by its code. */
export const publicPros = () => authRequest<{ pros: import('@pilotix/shared').ProCard[] }>('/pro');
export const publicPro = (code: string) => authRequest<import('@pilotix/shared').ProCard>(`/pro/${encodeURIComponent(code)}`);

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
  private token = store.get('token');
  private listeners = new Set<(e: LiveEvent) => void>();
  private socket: { disconnect(): void } | null = null;
  onUnauthorized: () => void = () => {};
  /** the shop's subscription stopped (unpaid, suspended): the app reloads the session and shows the lock screen */
  onLocked: () => void = () => {};

  private keep(token: string | null) {
    this.token = token;
    store.set('token', token);
  }

  private async req<T>(path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const base = apiUrl();
    if (!base) throw new ApiError(0, 'Adresse du serveur manquante');
    // the token this request carries: an answer to an older one (a store just left or deleted) does not log out
    const sent = this.token;
    let res: Response;
    try {
      res = await fetch(`${base}/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.');
    }
    const data = await res.json().catch(() => undefined);
    // after a password change the server hands this session a fresh token (the old ones stop working in every store)
    if (res.ok && path === '/rpc/me.password' && typeof (data as any)?.token === 'string') this.keep((data as any).token);
    if (res.status === 401 && this.token && this.token === sent) this.onUnauthorized();
    if (res.status === 402 && this.token && this.token === sent) this.onLocked();
    if (!res.ok) throw new ApiError(res.status, (data as any)?.message || res.statusText);
    return data as T;
  }

  /** A token and a session from the server: kept, live updates connected. */
  private enterWith(r: { token: string; session: Session }) {
    this.keep(r.token);
    this.connect();
    return r.session;
  }
  async login(email: string, password: string): Promise<LoginResult> {
    const r = await this.req<{ token: string; session: Session } | PickInfo | PhoneInfo>('/auth/login', { email, password });
    return 'pick' in r || 'phone' in r ? r : this.enterWith(r);
  }
  /** « Vérifiez votre numéro »: the number (code off: saved, then on), or the WhatsApp code asked / checked. */
  async phone(input: { ticket: string; phone: string; code?: string; shop?: number | null }): Promise<LoginResult | PhoneSent> {
    const r = await this.req<{ token: string; session: Session } | PickInfo | PhoneInfo | PhoneSent>('/auth/phone', { ticket: input.ticket, phone: input.phone, ...(input.code ? { code: input.code } : {}), ...(input.shop ? { shop: input.shop } : {}) });
    if ('session' in r && 'token' in r && !('pick' in r)) return this.enterWith(r as { token: string; session: Session });
    return r as PickInfo | PhoneInfo | PhoneSent;
  }
  /** Google: its token, checked by the server; a new person gets an account. */
  async socialLogin(provider: 'google', token: string, language?: string): Promise<LoginResult> {
    const r = await this.req<{ token: string; session: Session } | PickInfo | PhoneInfo>('/auth/social', { provider, token, language });
    return 'pick' in r || 'phone' in r ? r : this.enterWith(r);
  }
  /** The store chosen in the picker. */
  async pick(ticket: string, shop: number) {
    return this.enterWith(await this.req<{ token: string; session: Session }>('/auth/pick', { ticket, shop }));
  }
  /** Another store of the same person (account menu). */
  async switchStore(shop: number) {
    return this.enterWith(await this.req<{ token: string; session: Session }>('/auth/switch', { shop }));
  }
  stores() {
    return this.req<StoreChoice[]>('/auth/stores');
  }
  /** « Ajouter une boutique »: made, then entered (from the picker: with its ticket). */
  async addStore(input: { name: string; slug?: string; kind?: 'store' | 'agency' | 'marketer' }, ticket?: string) {
    return this.enterWith(await this.req<{ token: string; session: Session }>(ticket ? '/auth/add-store/ticket' : '/auth/add-store', { ...input, ...(ticket ? { ticket } : {}) }));
  }
  /** The sign-up e-mail's link: the store is made and entered (or « you already have an account »). */
  /** The sign-up e-mail's link: the store is made and entered, or (account-only sign-up) the picker to create it, or « you already have an account ». */
  async confirmSignup(token: string): Promise<Session | PickInfo | PhoneInfo | { exists: true; email: string }> {
    const r = await this.req<{ token: string; session: Session } | PickInfo | PhoneInfo | { exists: true; email: string }>('/auth/signup/confirm', { token });
    return 'exists' in r ? r : 'pick' in r || 'phone' in r ? r : this.enterWith(r);
  }
  /** The e-mail check link (from the store picker: with its ticket). */
  verifySend(ticket?: string) {
    return this.req<{ ok: true; already?: boolean; email?: string }>(ticket ? '/auth/verify/send/ticket' : '/auth/verify/send', ticket ? { ticket } : {});
  }
  /** Only the owner: the store and all its data are deleted; the person goes on in another store of theirs (if any). */
  async deleteStore(password: string, name: string): Promise<{ stores: StoreChoice[]; next: Session | null }> {
    const r = await this.req<{ ok: true; stores: StoreChoice[]; next: { token: string; session: Session } | null }>('/auth/delete-store', { password, name });
    return { stores: r.stores, next: r.next ? this.enterWith(r.next) : null };
  }
  /** « Contacter Pilotix » */
  /** A request with this app's token outside /rpc (a shop's own domain…). */
  request<T>(path: string, body?: unknown) {
    return this.req<T>(path, body ?? {});
  }
  support<T>(path: string, body?: unknown) {
    return this.req<T>(`/support${path}`, body);
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
    this.socket?.disconnect();
  }
  call<N extends ProcName>(name: N, input: In<N>, seller?: Seller): Promise<Out<N>> {
    return this.req(`/rpc/${name}`, input ?? {}, seller === undefined ? undefined : { 'X-Seller': String(seller) });
  }
  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private async connect() {
    this.socket?.disconnect();
    const { io } = await import('socket.io-client');
    const s = io(apiUrl(), { path: '/live', auth: { token: this.token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
    s.on('event', (e: LiveEvent) => this.listeners.forEach((l) => l(e)));
    this.socket = s;
  }
}

// ---------------------------------------------------------------- demo (PostgreSQL in the browser, same rules)
/** Actions whose result the demo keeps in this browser across reloads (its database is rebuilt each time). */
const DEMO_KEEP = new Set(['confirmation.addColPreset', 'confirmation.deleteColPreset', 'me.setUi']);
/** Actions that need the demo's partners (a confirmation agency, a marketer): they are made the first time. */
const NEEDS_PARTNERS = /^(partners|agency|mk)\./;
type Core = typeof import('@pilotix/core');
type ShopCtx = NonNullable<import('@pilotix/core').Ctx['shop']>;
class DemoBackend implements Backend {
  kind = 'demo' as const;
  private session: Session | null = null;
  /** the partner's space opened (its schema and rules); null: the demo store */
  private space: { schema: string; shop: ShopCtx } | null = null;
  /** the demo store's rules, once the platform's tables exist (with the partners) */
  private storeShop: ShopCtx | null = null;
  private listeners = new Set<(e: LiveEvent) => void>();
  private ready: Promise<{ core: Core; db: import('@pilotix/core').Db; t: import('@pilotix/core').Tenancy }> | null = null;
  private partners: Promise<void> | null = null;
  progress: (msg: string) => void = () => {};

  private boot() {
    void pageAi(); // start talking to Claude early when the preview is opened in Claude
    if (!this.ready)
      this.ready = (async () => {
        this.progress('Démarrage de la base de démonstration…');
        const [{ PGlite }, core] = await Promise.all([import('@electric-sql/pglite'), import('@pilotix/core')]);
        const pg = new PGlite();
        // several shops in one database (the store, and the partners made when first needed), as on a server
        const t = core.pgliteTenancy(pg as any);
        const db = t.shop('public');
        await core.migrate(db, (sql) => t.exec('public', sql));
        this.progress('Création des commandes d’exemple…');
        await core.seedDemo(db, { orders: Number(import.meta.env.VITE_DEMO_ORDERS) || 1200 });
        await core.seedPilotDemo(db);
        // the demo database is rebuilt on every reload: put back the column presets and screen choices kept in this browser
        await core.demoRestore(db, store.json<import('@pilotix/core').DemoKeep | null>('demo-keep', null)).catch(() => {});
        return { core, db, t };
      })();
    return this.ready;
  }
  /** The demo's confirmation agency and marketer, with their teams, contracts, orders, ad sets and bills (once). */
  private withPartners() {
    if (!this.partners)
      this.partners = (async () => {
        const { core, t } = await this.boot();
        this.progress('Création de l’agence et du marketer d’exemple…');
        await core.seedDemoPartners(t);
        const s = (await core.loadShop(t, { primary: true }))!;
        this.storeShop = core.shopCtx(s, core.shopStatus(s, Date.now(), (await core.platformSettings(t)).trial.graceDays));
      })();
    return this.partners;
  }
  async login(email: string, password: string): Promise<LoginResult> {
    const { core, db, t } = await this.boot();
    const { DEMO_PARTNER_ACCOUNTS } = await import('@pilotix/shared');
    const partner = DEMO_PARTNER_ACCOUNTS.find((a) => a.email === email.trim().toLowerCase());
    try {
      if (partner) {
        // the partner's own space: its shop, its rules, what the app shows of it
        await this.withPartners();
        const s = (await core.loadShops(t)).find((x) => x.kind === partner.kind)!;
        const set = await core.platformSettings(t);
        const st = core.shopStatus(s, Date.now(), set.trial.graceDays);
        const session = await core.login(t.shop(s.schema), email, password);
        this.session = { ...session, shop: core.shopInfo(s, st, set, Date.now()) };
        this.space = { schema: s.schema, shop: core.shopCtx(s, st) };
      } else {
        this.session = await core.login(db, email, password);
        this.space = null;
      }
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
      const r = await this.login(email, DEMO_PASSWORD);
      return isPick(r) || isPhone(r) ? null : r;
    } catch {
      return null;
    }
  }
  logout() {
    this.session = null;
    this.space = null;
    store.set('demo-user', null);
  }
  async call<N extends ProcName>(name: N, input: In<N>, seller?: Seller): Promise<Out<N>> {
    const { core, db, t } = await this.boot();
    if (!this.session) throw new ApiError(401, 'Session expirée');
    const s = this.session;
    if (this.space || NEEDS_PARTNERS.test(String(name))) await this.withPartners();
    // Dellal, the CM AI agent and AI Spy answer with Claude when the preview is opened in Claude (see dellal-page-ai.ts)
    const dellalAi = /^(dellal|cm|spy)\./.test(String(name)) ? await pageAi() : null;
    const base = { session: s, now: () => Date.now(), emit: (e: LiveEvent) => setTimeout(() => this.listeners.forEach((l) => l(e)), 0), ...(dellalAi ? { dellalAi } : {}) };
    // a partner's space: its own shop, and the seller chosen at the top of the page (its work runs in that store)
    const ctx = this.space
      ? { ...base, db: t.shop(this.space.schema), t, shop: this.space.shop, ...(seller !== undefined ? { seller } : {}) }
      : { ...base, db, ...(this.storeShop ? { t, shop: this.storeShop } : {}) };
    try {
      const out = (await core.call(name as string, ctx as import('@pilotix/core').Ctx, input)) as Out<N>;
      if (DEMO_KEEP.has(name as string) && !this.space) await core.demoSnapshot(db).then((k) => store.set('demo-keep', JSON.stringify(k))).catch(() => {});
      return out;
    } catch (e: any) {
      const status = { forbidden: 403, not_found: 404, bad_request: 400, conflict: 409, unauthorized: 401, payment_required: 402 }[e?.code as string] ?? 500;
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
/** The server (several stores, sign-up, « Contacter Pilotix »): its own calls. */
export const server = remote;

// ---------------------------------------------------------------- a shop's own domain name (server only)
export interface DomainState {
  domain: string | null;
  status: 'none' | 'pending' | 'ok';
  ips?: string[];
  host?: string;
}
const onServer = () => {
  if (backend !== remote) throw new ApiError(400, 'Pas dans la démo');
  return remote;
};
export const domainGet = () => onServer().request<DomainState>('/shop/domain/get');
export const domainSet = (domain: string | null) => onServer().request<DomainState>('/shop/domain', { domain });
export const domainCheck = () => onServer().request<{ ok: boolean; found: string[]; expected: string[] }>('/shop/domain/check');

/**
 * Call an action on the current backend (server or demo). `seller` (a confirmation agency's space): the seller whose
 * orders it works on — null: none (the agency itself); not given: the seller of what is open on screen, if any.
 */
export function rpc<N extends ProcName>(name: N, input: In<N>, seller?: Seller | null): Promise<Out<N>> {
  const s = seller === undefined ? ambientSeller() : seller === null ? undefined : seller;
  return backend.call(name, input, s);
}

// The browser demo only (data made up, in this page): its actions reachable from the console, to try a scenario fast
// (e.g. change an order as the owner, then open the depot). Never on a real server.
if (typeof window !== 'undefined')
  (window as unknown as { pxDemo?: unknown }).pxDemo = (name: ProcName, input: unknown) => {
    if (backend.kind !== 'demo') throw new Error('demo only');
    return backend.call(name, input as never);
  };
