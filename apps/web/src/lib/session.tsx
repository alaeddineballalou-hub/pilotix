import type { Role, Session } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { backend, isPick, loginServerDemo, PickInfo, rpc, server, setOnLocked, setOnUnauthorized } from './backend';
import { setShop } from './features';
import { applyLanguage } from './i18n';
import { store } from './store';

interface SessionState {
  session: Session | null;
  ready: boolean;
  /** the password was right and the person has several stores (or none): the picker shows them */
  picker: PickInfo | null;
  login: (email: string, password: string) => Promise<void>;
  /** with Google (its token) */
  loginSocial: (provider: 'google', token: string) => Promise<void>;
  /** the store chosen in the picker */
  pick: (shop: number) => Promise<void>;
  cancelPick: () => void;
  /** the picker from elsewhere than the login (an account-only sign-up just confirmed) */
  showPicker: (p: PickInfo) => void;
  /** a session the server just gave (a confirmed sign-up, a store added, another store chosen) */
  enter: (s: Session) => void;
  /** another store of the same person, without the password again */
  switchStore: (shop: number) => Promise<void>;
  /** opens the server's demo shop as one of its accounts */
  loginDemo: (key: string) => Promise<void>;
  logout: () => void;
  /** Reload my profile (after I change my name or picture). */
  refresh: () => Promise<void>;
  /** True when the user has one of these roles (admins always). */
  has: (...roles: Role[]) => boolean;
  me: number;
}

const Ctx = createContext<SessionState>(null as unknown as SessionState);
export const useSession = () => useContext(Ctx);

/** The session as the browser keeps it for offline use. */
function keep(s: Session | null) {
  store.set('session', s ? JSON.stringify(s) : null);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [picker, setPicker] = useState<PickInfo | null>(null);
  // the shop's menus are known before anything renders with the new session
  const setSession = useCallback((s: Session | null) => {
    setShop(s?.shop);
    setSessionState(s);
  }, []);

  const logout = useCallback(() => {
    backend.logout();
    keep(null);
    setSession(null);
    setPicker(null);
    qc.clear();
  }, [qc, setSession]);

  const refresh = useCallback(async () => {
    const s = await rpc('me.get', {});
    keep(s);
    setSession(s);
  }, [setSession]);

  useEffect(() => {
    setOnUnauthorized(logout);
    // the subscription stopped while the app was open: the lock screen comes from the fresh session
    setOnLocked(() => void refresh().catch(() => {}));
    backend
      .resume()
      .then((s) => {
        if (s) {
          setSession(s);
          keep(s);
        }
      })
      .finally(() => setReady(true));
  }, [logout, refresh, setSession]);

  // Live updates refresh what is on screen.
  useEffect(() => {
    if (!session) return;
    let t: number | undefined;
    const off = backend.onEvent(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => qc.invalidateQueries(), 250);
    });
    return () => {
      off();
    };
  }, [session, qc]);

  const enter = useCallback(
    (s: Session) => {
      // another store: nothing of the previous one stays on screen
      qc.clear();
      keep(s);
      setPicker(null);
      if (!store.get('lang')) applyLanguage(s.profile.language);
      setSession(s);
    },
    [qc, setSession],
  );
  const login = async (email: string, password: string) => {
    const r = await backend.login(email, password);
    if (isPick(r)) setPicker(r);
    else enter(r);
  };
  const loginSocial = async (provider: 'google', token: string) => {
    const r = await server.socialLogin(provider, token, store.get('lang') || undefined);
    if (isPick(r)) setPicker(r);
    else enter(r);
  };
  const pick = async (shop: number) => {
    if (!picker) return;
    enter(await server.pick(picker.ticket, shop));
  };
  const switchStore = async (shop: number) => enter(await server.switchStore(shop));
  const loginDemo = async (key: string) => enter(await loginServerDemo(key));

  const has = (...roles: Role[]) => !!session && (session.isAdmin || roles.some((r) => session.roles.includes(r)));

  return (
    <Ctx.Provider value={{ session, ready, picker, login, loginSocial, pick, cancelPick: () => setPicker(null), showPicker: setPicker, enter, switchStore, loginDemo, logout, refresh, has, me: session?.profile.id ?? 0 }}>{children}</Ctx.Provider>
  );
}

/**
 * A partner's space, working for its sellers: the store's screens as one of the partner's people sees them there — an
 * agency's chief and supervisors do the confirmation and the suivi, its agents their own task; a marketer's people the
 * ads of their ad sets. Nobody is the store's administrator (no store settings, no new orders).
 */
export function AgentView({ children }: { children: ReactNode }) {
  const s = useContext(Ctx);
  const value = useMemo(() => {
    if (!s.session) return s;
    const own = s.session.roles;
    const lead = s.session.isAdmin || own.includes('agent_manager');
    const roles = (
      s.session.shop?.kind === 'marketer'
        ? lead || own.includes('marketer')
          ? ['marketer']
          : []
        : lead
          ? ['confirmation', 'suivi']
          : own.filter((r) => r === 'confirmation' || r === 'suivi')
    ) as Role[];
    const session: Session = { ...s.session, isAdmin: false, canManageUsers: false, roles, profile: { ...s.session.profile, agencyId: s.session.shop?.id ?? -1 } };
    return { ...s, session, has: (...want: Role[]) => want.some((r) => roles.includes(r)) };
  }, [s]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
