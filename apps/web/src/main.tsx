import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Legal, PhoneStep, Signup, SignupConfirm, StorePicker, VerifyEmail } from './layout/Accounts';
import { LockScreen } from './layout/LockScreen';
import { Login } from './layout/Login';
import { ResetPassword } from './layout/ResetPassword';
import { AGENCY_NAV, canSee, canSeeChild, homeFor, isPlainAgent, MARKETER_NAV, NAV, NavItem } from './layout/nav';
import { applyTheme, Shell } from './layout/Shell';
import { ApiError, server } from './lib/backend';
import { firstSubOn, hasPlanSubs, pageIsOn } from './lib/features';
import './lib/i18n';
import { ModalHost } from './lib/modals';
import { addressShop, fixAddress, go, PATHS, useRoute } from './lib/route';
import { startFreshness } from './lib/freshness';
import { RiskAskHost } from './ui/clientScore';
import { initSeller } from './lib/seller';
import { SessionProvider, useSession } from './lib/session';
import { useCanRules } from './lib/pilot';
import { useShopModules } from './lib/modules';
import { store } from './lib/store';
import { AGENCY_PAGES, MARKETER_PAGES, PAGES } from './pages/registry';
import { Loading } from './ui/kit';
import { Toasts } from './ui/toast';
import { installEdgeScroll } from './ui/edgeScroll';
import './styles/tokens.css';
import './styles/legacy.css';
import './styles/pilotix.css';
import './styles/responsive.css';
import './styles/ux.css';
import './styles/skins.css';
import './styles/app.css';

applyTheme(store.get('theme') as 'light' | 'dark' | null);
// the Pilotix look (styles/skins.css); also set in index.html so the first paint already has it
document.documentElement.setAttribute('data-skin', 'doux');
// inside the Pilotix phone app (mobile/: its web view adds « PilotixApp » to the user agent): styles/app.css
if (/\bPilotixApp\b/.test(navigator.userAgent)) document.documentElement.classList.add('in-app');
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

/**
 * The boutique named in the address (lib/route: pilotix.online/<boutique>/<page>) is the one open. Opened from a bookmark
 * or a link that names another of the person's boutiques, that boutique opens by itself (once, when the site loads:
 * meanwhile nothing of the other boutique is shown); otherwise, and after that, the address follows the boutique open
 * now and the page shown. True while that boutique is being opened.
 */
function useAddressBoutique(slug: string | null | undefined, logged: boolean, route: string): boolean {
  const { switchStore } = useSession();
  const open = useRef(switchStore);
  open.current = switchStore;
  const first = useRef(true);
  // while that boutique opens, the address keeps naming it
  const busy = useRef(false);
  const [opening, setOpening] = useState(false);
  // decided at the first look with a session: another boutique's address waits for it
  const named = PATHS && logged && first.current ? addressShop() : null;
  const waiting = !!named && !!slug && named !== slug;
  useEffect(() => {
    if (!PATHS || !logged) return;
    const other = addressShop();
    if (first.current && other && slug && other !== slug) {
      first.current = false;
      busy.current = true;
      setOpening(true);
      server
        .stores()
        .then((list) => {
          const s = list.find((x) => x.slug === other && !x.locked);
          // still the page asked for (nothing was clicked meanwhile): its boutique opens
          if (s && addressShop() === other) return open.current(s.id);
        })
        .catch(() => {})
        .finally(() => {
          busy.current = false;
          fixAddress();
          setOpening(false);
        });
      return;
    }
    first.current = false;
    if (!busy.current) fixAddress();
  }, [slug, logged, route]);
  return waiting || opening;
}

const ALIASES: Record<string, [string, string?]> = { livreurs: ['dashboard', 'livreurs'], publicite: ['marketing', 'publicite'], marketer: ['marketing', 'marketer'] };
/** An agency's older links: its team is « Utilisateurs », its prices are in « Réglages ». */
const AGENCY_ALIASES: Record<string, [string, string?]> = { tarifs: ['vendeurs', 'plans'], macaisse: ['gains'], caisse: ['equipe', 'paie'], affectation: ['equipe', 'repartition'] };
/**
 * A confirmation agency's menu is sorted by who: « Équipe » (its people: accounts, who gets which order, their pay, their
 * scores) and « Vendeurs » (its sellers: the list, their plans and prices, the bills). An old link opens the new place.
 */
function agencyMoved(page: string | undefined, sub: string | undefined, rest: (string | undefined)[]): string | null {
  if (page === 'utilisateurs') return `#/equipe/personnes${sub && sub !== 'affectations' ? `/${sub}` : ''}`;
  if (page !== 'facturation') return null;
  if (sub === 'paie') return '#/equipe/paie';
  if (sub === 'agents') return '#/equipe/paie';
  if (sub === 'plans') return '#/vendeurs/plans';
  return `#/vendeurs/factures${sub && sub !== 'vendeurs' ? `/${[sub, ...rest].filter(Boolean).join('/')}` : ''}`;
}
/** A marketer's short links: its ads are in « Marketing ». */
const MARKETER_ALIASES: Record<string, [string, string?]> = { equipe: ['utilisateurs'], tarifs: ['reglages'], publicite: ['marketing', 'publicite'], marketer: ['marketing', 'marketer'], adsets: ['marketing', 'marketer'] };

/** Pilotix's control room (#/platform): its own login and pages, loaded only when opened. */
const PlatformApp = lazy(() => import('./pages/platform').then((m) => ({ default: m.PlatformApp })));
/** Pilotix's public list of Pro marketers (#/pro, #/pro/MK-7K2Q), open to everyone. */
const PublicPros = lazy(() => import('./pages/pro').then((m) => ({ default: m.PublicPros })));
/** « Contacter Pilotix » (the store's administrators). */
const Support = lazy(() => import('./pages/aide').then((m) => ({ default: m.Support })));

function App() {
  const { session, ready, picker, phoneStep } = useSession();
  // #/page/sub/rest… — on the site: /<boutique>/page/sub/rest… (lib/route)
  const parts = useRoute();
  const canRules = useCanRules();
  // the boutique's modules (Point de vente…): the menu shows their pages once they are on (Management › Modules)
  useShopModules();
  const opening = useAddressBoutique(session?.shop?.slug, !!session && ready, parts.join('/'));
  if (parts[0] === 'platform')
    return (
      <Suspense fallback={<Loading />}>
        <PlatformApp parts={parts.slice(1)} />
      </Suspense>
    );
  // the terms of use and privacy page, open to everyone
  if (parts[0] === 'conditions') return <Legal />;
  // the Pro marketers, open to everyone
  if (parts[0] === 'pro')
    return (
      <Suspense fallback={<Loading />}>
        <PublicPros code={parts[1]} />
      </Suspense>
    );
  if (!ready) return <Loading />;
  // the links of e-mails work logged in or not: new password, invitation (choose your password), sign-up, e-mail check
  if (parts[0] === 'reset' && parts[1]) return <ResetPassword token={parts[1]} />;
  if (parts[0] === 'invite' && parts[1]) return <ResetPassword token={parts[1]} invite />;
  if (parts[0] === 'signup' && parts[1]) return <SignupConfirm token={parts[1]} />;
  if (parts[0] === 'verify' && parts[1]) return <VerifyEmail token={parts[1]} />;
  if (parts[0] === 'inscription') return <Signup referral={parts[1]} />;
  // « Créer mon agence » / « Créer mon espace marketer »: a partner signs up the same way (its kind chosen already)
  if (parts[0] === 'inscription-agence') return <Signup kind="agency" />;
  if (parts[0] === 'inscription-marketer') return <Signup kind="marketer" />;
  // the link of the first sign-up e-mails (before accounts): every account counts as confirmed now, the app opens
  if (parts[0] === 'confirmer') go('#/accueil', { replace: true });
  // the account's own number first (« Vérifiez votre numéro »), then the store picker
  if (!session) return phoneStep ? <PhoneStep /> : picker ? <StorePicker /> : <Login />;
  // the address names another of the person's boutiques: it opens first
  if (opening) return <Loading />;
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
  // whose space this is: a store's, or a partner's — a confirmation agency (it works on its sellers' orders) or a
  // marketer (on its sellers' ads), one seller or all of them
  const space: 'store' | 'agency' | 'marketer' = session.shop?.kind === 'agency' || session.shop?.kind === 'marketer' ? session.shop.kind : 'store';
  if (space !== 'store') initSeller(session.shop!.id);
  const nav: NavItem[] = space === 'agency' ? AGENCY_NAV : space === 'marketer' ? MARKETER_NAV : NAV;
  const pages = space === 'agency' ? AGENCY_PAGES : space === 'marketer' ? MARKETER_PAGES : PAGES;
  // an agency's agent who leads no one has no Accueil: his Dashboard is his home
  const homeOf = () => (space === 'agency' && isPlainAgent(session.roles, session.isAdmin) ? 'dashboard' : space !== 'store' ? 'accueil' : homeFor(session.roles, session.isAdmin));
  let [page, sub, ...rest]: (string | undefined)[] = parts;
  if (page && ALIASES[page] && space === 'store') [page, sub] = [ALIASES[page][0], ALIASES[page][1] ?? sub];
  const moved = space === 'agency' ? agencyMoved(page, sub, rest) : null;
  if (moved) {
    go(moved, { replace: true });
    [page, sub, ...rest] = moved.slice(2).split('/');
  }
  const partnerAliases = space === 'agency' ? AGENCY_ALIASES : space === 'marketer' ? MARKETER_ALIASES : null;
  if (page && partnerAliases?.[page]) {
    [page, sub] = partnerAliases[page];
    go(`#/${page}${sub ? `/${sub}` : ''}`, { replace: true });
  }
  // Confirmation › Livrées was removed: an old link opens Confirmation › Nouvelles
  if (page === 'confirmation' && sub === 'livrees') {
    go('#/confirmation/nouvelles', { replace: true });
    sub = 'nouvelles';
  }
  // Pilot Auto Assign's rules and the Préférences left Sociétés de livraison: an old link opens Pilot Automations › Auto Pilot Assign
  if (space === 'store' && page === 'livraison' && (sub === 'pilot' || sub === 'preferences')) {
    go('#/notify/assign', { replace: true });
    [page, sub] = ['notify', 'assign'];
  }
  // AI Spy left Marketing for AI Pilot: an old link (#/marketing/spy, #/marketing/spy/reglages) opens #/spy
  if (space === 'store' && page === 'marketing' && sub === 'spy') {
    const more = rest.filter((x): x is string => !!x);
    go(`#/spy${more.length ? `/${more.join('/')}` : ''}`, { replace: true });
    [page, sub, ...rest] = ['spy', ...more];
  }
  // Influenceurs left Marketing for Partenaires: an old link (#/marketing/influenceurs) opens #/influenceurs
  if (space === 'store' && page === 'marketing' && sub === 'influenceurs') {
    go('#/influenceurs', { replace: true });
    page = 'influenceurs';
    sub = undefined;
    rest = [];
  }
  // the agents' pay left Management for Caisse: an old link (#/management/paie) opens #/caisse/paie
  if (space === 'store' && page === 'management' && sub === 'paie') {
    go('#/caisse/paie', { replace: true });
    page = 'caisse';
    rest = [];
  }
  // a group without a page of its own (Pilot AI) opens its first child the user can see
  const group = nav.find((n) => n.id === page && n.children && !pages[n.id]);
  const first = group?.children!.find((c) => canSeeChild(c, session.roles, session.isAdmin, canRules));
  if (first) {
    go(first.href, { replace: true });
    [page, sub] = first.href.replace(/^#\/?/, '').split('/');
  }
  const item = nav.find((n) => n.id === page);
  const extra = space === 'store' && ['livrees', 'retournees'].includes(page ?? '') && pageIsOn(page ?? '');
  const allowed = (item && canSee(item, session.roles, session.isAdmin, !!session.canManageUsers, canRules, !!session.profile.canAffect)) || (extra && (session.isAdmin || session.roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r))));
  if (!page || !allowed || !pages[page]) {
    const home = homeOf();
    go(`#/${home}`, { replace: true });
    page = home;
    sub = undefined;
    rest = [];
  }
  if (!sub && item?.subs?.length) sub = item.subs[0];
  // a sub-page the shop's plan does not include: its first sub-page that is included
  if (page && sub && hasPlanSubs(page) && !pageIsOn(page, sub)) {
    const first = firstSubOn(page);
    if (first) {
      go(`#/${page}/${first}`, { replace: true });
      sub = first;
    } else {
      const home = homeOf();
      go(`#/${home}`, { replace: true });
      page = home;
      sub = undefined;
      rest = [];
    }
  }
  const Page = pages[page!];
  return (
    <Shell page={page!} sub={sub} nav={nav} space={space}>
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
        <RiskAskHost />
        <Toasts />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// the site on its own server moves to each new version by itself (lib/freshness); the preview in Claude has none
if (PATHS && import.meta.env.PROD) startFreshness();
