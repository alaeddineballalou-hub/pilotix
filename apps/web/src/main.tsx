import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Login } from './layout/Login';
import { ResetPassword } from './layout/ResetPassword';
import { canSee, canSeeChild, homeFor, NAV } from './layout/nav';
import { applyTheme, Shell } from './layout/Shell';
import { ApiError } from './lib/backend';
import './lib/i18n';
import { ModalHost } from './lib/modals';
import { SessionProvider, useSession } from './lib/session';
import { store } from './lib/store';
import { PAGES } from './pages/registry';
import { Loading } from './ui/kit';
import { Toasts } from './ui/toast';
import { installEdgeScroll } from './ui/edgeScroll';
import './styles/legacy.css';
import './styles/pilotix.css';
import './styles/responsive.css';

applyTheme(store.get('theme') as 'light' | 'dark' | null);
installEdgeScroll();

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 30 * 60_000,
      retry: (n, e) => n < 2 && e instanceof ApiError && e.status === 0,
      refetchOnWindowFocus: true,
    },
  },
});

/** #/page/sub/rest… */
function useHash() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

const ALIASES: Record<string, [string, string?]> = { livreurs: ['dashboard', 'livreurs'], publicite: ['marketing', 'publicite'], marketer: ['marketing', 'marketer'] };

function App() {
  const { session, ready } = useSession();
  const parts = useHash();
  if (!ready) return <Loading />;
  // the link of the "mot de passe oublié" e-mail works logged in or not
  if (parts[0] === 'reset' && parts[1]) return <ResetPassword token={parts[1]} />;
  if (!session) return <Login />;

  let [page, sub, ...rest]: (string | undefined)[] = parts;
  if (page && ALIASES[page]) [page, sub] = [ALIASES[page][0], ALIASES[page][1] ?? sub];
  // Confirmation › Livrées was removed: an old link opens Confirmation › Nouvelles
  if (page === 'confirmation' && sub === 'livrees') {
    location.replace('#/confirmation/nouvelles');
    sub = 'nouvelles';
  }
  // a group without a page of its own (Pilot AI) opens its first child the user can see
  const group = NAV.find((n) => n.id === page && n.children && !PAGES[n.id]);
  const first = group?.children!.find((c) => canSeeChild(c, session.roles, session.isAdmin));
  if (first) {
    location.replace(first.href);
    [page, sub] = first.href.replace(/^#\/?/, '').split('/');
  }
  const item = NAV.find((n) => n.id === page);
  const extra = ['livrees', 'retournees'].includes(page ?? '');
  const allowed = (item && canSee(item, session.roles, session.isAdmin)) || (extra && (session.isAdmin || session.roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r))));
  if (!page || !allowed || !PAGES[page]) {
    const home = homeFor(session.roles, session.isAdmin);
    if (location.hash !== `#/${home}`) location.replace(`#/${home}`);
    page = home;
    sub = undefined;
    rest = [];
  }
  if (!sub && item?.subs?.length) sub = item.subs[0];
  const Page = PAGES[page!];
  return (
    <Shell page={page!} sub={sub}>
      <Suspense fallback={<Loading />}>
        <Page key={page} sub={sub} rest={rest as string[]} />
      </Suspense>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <SessionProvider>
        <App />
        <ModalHost />
        <Toasts />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
