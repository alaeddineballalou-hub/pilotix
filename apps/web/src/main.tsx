import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import './lib/i18n';
import { initOffline } from './lib/offline';
import { store } from './lib/store';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Orders } from './pages/Orders';
import { Products } from './pages/Products';
import { applyTheme, Settings } from './pages/Settings';
import { Team } from './pages/Team';
import './styles.css';

applyTheme((store.get('theme') as 'system' | 'light' | 'dark') || 'system');
initOffline();

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 30 * 60_000,
      // Don't hammer the server: retry network errors only, with backoff.
      retry: (n, e) => n < 3 && e instanceof ApiError && e.status === 0,
      refetchOnWindowFocus: true,
    },
  },
});

function Routed() {
  const { user, ready, can } = useAuth();
  if (!user) return ready ? <Login /> : <Loading />;
  const home = can('manager', 'confirmation', 'suivi', 'depot') ? <Dashboard /> : <Navigate to="/orders" replace />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={home} />
        <Route path="orders" element={<Orders />} />
        {can('manager', 'depot') && <Route path="products" element={<Products />} />}
        {can('manager') && <Route path="team" element={<Team />} />}
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <HashRouter>
          <Routed />
        </HashRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
