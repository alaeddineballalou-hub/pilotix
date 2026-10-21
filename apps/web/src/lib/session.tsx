import type { Role, Session } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { backend, setOnUnauthorized } from './backend';
import { applyLanguage } from './i18n';
import { store } from './store';

interface SessionState {
  session: Session | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** True when the user has one of these roles (admins always). */
  has: (...roles: Role[]) => boolean;
  me: number;
}

const Ctx = createContext<SessionState>(null as unknown as SessionState);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    backend.logout();
    store.set('session', null);
    setSession(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setOnUnauthorized(logout);
    backend
      .resume()
      .then((s) => {
        if (s) {
          setSession(s);
          store.set('session', JSON.stringify(s));
        }
      })
      .finally(() => setReady(true));
  }, [logout]);

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

  const login = async (email: string, password: string) => {
    const s = await backend.login(email, password);
    store.set('session', JSON.stringify(s));
    if (!store.get('lang')) applyLanguage(s.profile.language);
    setSession(s);
  };

  const has = (...roles: Role[]) => !!session && (session.isAdmin || roles.some((r) => session.roles.includes(r)));

  return <Ctx.Provider value={{ session, ready, login, logout, has, me: session?.profile.id ?? 0 }}>{children}</Ctx.Provider>;
}
