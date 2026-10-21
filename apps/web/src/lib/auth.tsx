import type { Language, Role, User } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setOnUnauthorized, setToken } from './api';
import { applyLanguage } from './i18n';
import { connectLive, disconnectLive } from './live';
import { store } from './store';

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setLanguage: (l: Language) => void;
  can: (...roles: Role[]) => boolean;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(() => {
    try {
      return JSON.parse(store.get('user') || 'null');
    } catch {
      return null;
    }
  });
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    store.set('user', null);
    setUser(null);
    disconnectLive();
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setOnUnauthorized(logout);
    const token = getToken();
    if (!token) {
      setReady(true);
      return;
    }
    // Refresh the profile; if the network is down, keep working with the saved one.
    api
      .me()
      .then((u) => {
        setUser(u);
        store.set('user', JSON.stringify(u));
        applyLanguage(u.language);
      })
      .catch(() => {})
      .finally(() => setReady(true));
    connectLive(token, qc);
  }, [logout, qc]);

  const login = async (email: string, password: string) => {
    const { token, user: u } = await api.login(email, password);
    setToken(token);
    store.set('user', JSON.stringify(u));
    setUser(u);
    applyLanguage(u.language);
    connectLive(token, qc);
  };

  const setLanguage = (l: Language) => {
    applyLanguage(l);
    if (user) {
      const u = { ...user, language: l };
      setUser(u);
      store.set('user', JSON.stringify(u));
      api.setMyLanguage(l).catch(() => {});
    }
  };

  const can = (...roles: Role[]) => !!user && (user.roles.includes('admin') || roles.some((r) => user.roles.includes(r)));

  return <Ctx.Provider value={{ user, ready, login, logout, setLanguage, can }}>{children}</Ctx.Provider>;
}
