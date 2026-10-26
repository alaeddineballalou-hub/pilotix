import type { Role, Session } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { backend, isSupportTab, loginServerDemo, rpc, setOnLocked, setOnUnauthorized } from './backend';
import { setShop } from './features';
import { applyLanguage } from './i18n';
import { store } from './store';

interface SessionState {
  session: Session | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
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
  const login = async (email: string, password: string) => start(await backend.login(email, password));
  const loginDemo = async (key: string) => start(await loginServerDemo(key));

  const has = (...roles: Role[]) => !!session && (session.isAdmin || roles.some((r) => session.roles.includes(r)));

  return <Ctx.Provider value={{ session, ready, login, loginDemo, logout, refresh, has, me: session?.profile.id ?? 0 }}>{children}</Ctx.Provider>;
}
