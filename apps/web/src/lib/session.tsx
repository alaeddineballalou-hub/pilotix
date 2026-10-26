import type { Role, Session } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { backend, enterShop, isChoice, isSupportTab, loginServerDemo, rpc, setOnLocked, setOnUnauthorized, ShopChoice } from './backend';
import { setShop } from './features';
import { applyLanguage } from './i18n';
import { store } from './store';

interface SessionState {
  session: Session | null;
  ready: boolean;
  /** Logs in; when the password opens several shops, returns them (the store picker) instead */
  login: (email: string, password: string) => Promise<ShopChoice[] | null>;
  /** Opens one of my shops (store picker, « Mes boutiques »): the app restarts in it */
  enter: (shop: number, cred?: { email: string; password: string }) => Promise<void>;
  /** A session the server just opened (sign-up, « Ajouter une boutique ») */
  adopt: (s: Session) => void;
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

/** The session as the browser keeps it for offline use (never for a support tab: it belongs to another shop). */
function keep(s: Session | null) {
  if (!isSupportTab()) store.set('session', s ? JSON.stringify(s) : null);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // the shop's menus are known before anything renders with the new session
  const setSession = useCallback((s: Session | null) => {
    setShop(s?.shop);
    setSessionState(s);
  }, []);

  const logout = useCallback(() => {
    backend.logout();
    keep(null);
    setSession(null);
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

  const start = (s: Session) => {
    keep(s);
    if (!store.get('lang')) applyLanguage(s.profile.language);
    setSession(s);
  };
  const login = async (email: string, password: string) => {
    const r = await backend.login(email, password);
    if (isChoice(r)) return r.choose;
    start(r);
    return null;
  };
  // another shop: nothing of the previous one stays on screen
  const adopt = (s: Session) => {
    qc.clear();
    start(s);
    location.hash = '#/accueil';
  };
  const enter = async (shop: number, cred?: { email: string; password: string }) => adopt(await enterShop(shop, cred));
  const loginDemo = async (key: string) => start(await loginServerDemo(key));

  const has = (...roles: Role[]) => !!session && (session.isAdmin || roles.some((r) => session.roles.includes(r)));

  return <Ctx.Provider value={{ session, ready, login, enter, adopt, loginDemo, logout, refresh, has, me: session?.profile.id ?? 0 }}>{children}</Ctx.Provider>;
}
