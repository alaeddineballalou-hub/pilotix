import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Legal, Signup, SignupConfirm, StorePicker, VerifyEmail } from './layout/Accounts';
import { LockScreen } from './layout/LockScreen';
import { Login } from './layout/Login';
import { ResetPassword } from './layout/ResetPassword';
import { canSee, canSeeChild, homeFor, NAV } from './layout/nav';
import { applyTheme, Shell } from './layout/Shell';
import { ApiError } from './lib/backend';
import { firstSubOn, hasPlanSubs, pageIsOn } from './lib/features';
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

const ALIASES: Record<string, [string, string?]> = { livreurs: ['dashboard', 'livreurs'], publicite: ['marketing', 'publicite'], marketer: ['marketing', 'marketer'], spy: ['marketing', 'spy'] };

/** Pilotix's control room (#/platform): its own login and pages, loaded only when opened. */
const PlatformApp = lazy(() => import('./pages/platform').then((m) => ({ default: m.PlatformApp })));
/** « Contacter Pilotix » (the store's administrators). */
const Support = lazy(() => import('./pages/aide').then((m) => ({ default: m.Support })));

function App() {
  const { session, ready, picker } = useSession();
  const parts = useHash();
  if (parts[0] === 'platform')
    return (
      <Suspense fallback={<Loading />}>
        <PlatformApp parts={parts.slice(1)} />
      </Suspense>
    );
  // the terms of use and privacy page, open to everyone
  if (parts[0] === 'conditions') return <Legal />;
  if (!ready) return <Loading />;
  // the links of e-mails work logged in or not: new password, invitation (choose your password), sign-up, e-mail check
  if (parts[0] === 'reset' && parts[1]) return <ResetPassword token={parts[1]} />;
  if (parts[0] === 'invite' && parts[1]) return <ResetPassword token={parts[1]} invite />;
  if (parts[0] === 'signup' && parts[1]) return <SignupConfirm token={parts[1]} />;
  if (parts[0] === 'verify' && parts[1]) return <VerifyEmail token={parts[1]} />;
  if (parts[0] === 'inscription') return <Signup referral={parts[1]} />;
  if (!session) return picker ? <StorePicker /> : <Login />;
  // unpaid or suspended: the lock screen (how to pay), nothing else
  if (session.shop?.locked) return <LockScreen />;

  // « Contacter Pilotix »: the store's administrators
  if (parts[0] === 'aide' && session.isAdmin && !session.shop?.demo)
    return (
      <Shell page="aide" sub={undefined}>
        <Suspense fallback={<Loading />}>
          <Support id={parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null} />
        </Suspense>
      </Shell>
    );
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
  const extra = ['livrees', 'retournees'].includes(page ?? '') && pageIsOn(page ?? '');
  const allowed = (item && canSee(item, session.roles, session.isAdmin, !!session.canManageUsers)) || (extra && (session.isAdmin || session.roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r))));
  if (!page || !allowed || !PAGES[page]) {
    const home = homeFor(session.roles, session.isAdmin);
    if (location.hash !== `#/${home}`) location.replace(`#/${home}`);
    page = home;
    sub = undefined;
    rest = [];
  }
  if (!sub && item?.subs?.length) sub = item.subs[0];
  // a sub-page the shop's plan does not include: its first sub-page that is included
  if (page && sub && hasPlanSubs(page) && !pageIsOn(page, sub)) {
    const first = firstSubOn(page);
    if (first) {
      location.replace(`#/${page}/${first}`);
      sub = first;
    } else {
      const home = homeFor(session.roles, session.isAdmin);
      location.replace(`#/${home}`);
      page = home;
      sub = undefined;
      rest = [];
    }
  }
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
