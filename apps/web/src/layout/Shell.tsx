import { CONF_DONE_BAD, CONF_TODO, Language, LANGUAGES, normalizePhone } from '@pilotix/shared';
import { lazy, ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, rpc } from '../lib/backend';
import { compact, when } from '../lib/format';
import { applyLanguage } from '../lib/i18n';
import { openOrder, openOrderForm } from '../lib/modals';
import { useAction, useRpc } from '../lib/query';
import { useSession } from '../lib/session';
import { chime, unlockAudio } from '../lib/sound';
import { store } from '../lib/store';
import { toast } from '../ui/toast';
import { Field, Icon, StageBar, TicketTag } from '../ui/kit';
import { Modal } from '../ui/modal';
import { canSee, canSeeChild, NAV, NavItem } from './nav';
import { AccountMenu } from './AccountMenu';
import { ShopBanner } from './ShopBanner';

const AgentBanner = lazy(() => import('../pages/confirmation/AgentBanner').then((m) => ({ default: m.AgentBanner })));

type Theme = 'light' | 'dark' | null;
export function applyTheme(t: Theme) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  store.set('theme', t);
}

/** Menu counts, refreshed every minute and on live updates. */
export function useMenuCounts() {
  const q = useRpc('orders.counts', {}, { refetchInterval: 60_000 });
  return useMemo(() => {
    const c = q.data;
    if (!c) return {} as Record<string, number>;
    const sum = (o: Record<string, number>, keys: string[]) => keys.reduce((s, k) => s + (o[k] ?? 0), 0);
    // SAV ticket parcels are not orders, but the depot, scanner, livreurs and caisse handle them too
    const tk = c.tickets ?? { toShip: 0, prepared: 0, onRoad: 0, uncashed: 0 };
    return {
      conf: sum(c.conf, CONF_TODO),
      new: c.conf.new ?? 0,
      attente: sum(c.conf, CONF_TODO.filter((k) => k !== 'new')),
      confirmees: sum(c.conf, ['confirmed', 'no_stock']),
      depot: sum(c.follow, ['to_prepare', 'prepared']) + tk.toShip,
      suivi: sum(c.follow, ['alert']),
      delivered: c.follow.delivered ?? 0,
      cancelled: sum(c.conf, CONF_DONE_BAD) + (c.follow.returned ?? 0),
      sav: c.sav,
      uncashed: c.uncashed + tk.uncashed,
      late: c.lateCalls,
      toShip: (c.follow.prepared ?? 0) + tk.prepared,
      onRoad: sum(c.follow, ['shipped', 'out_for_delivery', 'failed']) + tk.onRoad,
      lowStock: (c as { lowStock?: number }).lowStock ?? 0,
      msgs: c.ai?.messages ?? 0,
      cm: c.ai?.cm ?? 0,
      notify: c.ai?.notify ?? 0,
      // landing pages (marketers and agents only: undefined hides the badge): blocked + abandoned to handle, and for
      // marketers the products still without a page
      ...(c.landing ? { landing: c.landing.blocked + c.landing.abandoned + c.landing.noPage } : {}),
    } as Record<string, number>;
  }, [q.data]);
}

/** Live count shown on each menu item: [count key, colour]. */
const ITEM_COUNT: Record<string, [string, string]> = {
  accueil: ['new', 'nc-n'],
  dashboard: ['late', 'nc-a'],
  scanner: ['toShip', 'nc-n'],
  sav: ['sav', 'nc-a'],
  tournee: ['onRoad', 'nc-n'],
  produits: ['lowStock', 'nc-a'],
  landing: ['landing', 'nc-a'],
  caisse: ['uncashed', 'nc-c'],
  livraison: ['toShip', 'nc-n'],
};

function Count({ v, tone }: { v: number; tone: string }) {
  return (
    <span className={`nav-count ${tone} ${v === 0 ? 'zero' : ''}`} title={String(v)}>
      {compact(v)}
    </span>
  );
}

export function Shell({ page, sub, children }: { page: string; sub?: string; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { session, logout, has } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const counts = useMenuCounts();
  const [folded, setFolded] = useState(() => store.get('sidebar') === 'folded');
  const toggleFold = () => {
    // On a phone the logo just closes the menu; on a computer it folds / unfolds the sidebar.
    if (window.matchMedia('(max-width: 900px)').matches) return setNavOpen(false);
    setFolded((f) => {
      store.set('sidebar', f ? null : 'folded');
      return !f;
    });
  };
  const roles = session!.roles;
  const isAdmin = session!.isAdmin;

  // A new order from a landing page: a toast and a chime for the people who confirm orders (sound: once the page was touched).
  useEffect(
    () =>
      backend.onEvent((e) => {
        const c = (e.data as { created?: { ref: string; channel: string } } | undefined)?.created;
        if (e.type !== 'orders' || !c || !(isAdmin || roles.includes('confirmation')) || store.get('lp-sound') === 'off') return;
        toast(t('shell.newLandingOrder', { ref: c.ref }), 'ok', 6000);
        chime();
      }),
    [isAdmin, roles, t],
  );

  // Presence heartbeat, every minute (online / idle after 5 min without activity).
  useEffect(() => {
    let last = Date.now();
    const act = () => {
      last = Date.now();
      unlockAudio();
    };
    window.addEventListener('pointerdown', act);
    window.addEventListener('keydown', act);
    const beat = () => rpc('me.seen', { presence: Date.now() - last > 5 * 60_000 ? 'idle' : 'online' }).catch(() => {});
    beat();
    const id = window.setInterval(beat, 60_000);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('pointerdown', act);
      window.removeEventListener('keydown', act);
    };
  }, []);

  useEffect(() => setNavOpen(false), [page, sub]);
  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
  }, [navOpen]);

  /** a group's children this user sees */
  const kids = (n: NavItem) => (n.children ?? []).filter((c) => canSeeChild(c, roles, isAdmin));
  // a group whose children are all out of the shop's plan is not shown
  const items = NAV.filter((n) => !n.hidden && canSee(n, roles, isAdmin, !!session!.canManageUsers) && (!n.children || kids(n).length > 0));
  /** the group of the page on screen: its children show in a bar under the header when the sidebar is folded */
  const curGrp = items.find((n) => n.children && n.pages?.includes(page));
  /** the child of a group shown as current */
  const childOn = (n: NavItem, id: string) => id === page || (page === n.id && sub === id);
  // each group remembers whether it is open (Commandes keeps its old key)
  const grpKey = (id: string) => (id === 'commandes' ? 'cmdgrp' : `grp-${id}`);
  const [grpOpen, setGrpOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(NAV.filter((n) => n.children).map((n) => [n.id, store.get(grpKey(n.id)) !== 'closed'])));
  const toggleGrp = (id: string) =>
    setGrpOpen((o) => {
      const next = !(o[id] ?? true);
      store.set(grpKey(id), next ? 'open' : 'closed');
      return { ...o, [id]: next };
    });
  const theme = store.get('theme') as Theme;

  return (
    <div className={`shell ${folded ? 'px-folded' : ''}`}>
      <nav className="side" id="side" aria-label={t('nav.menu')}>
        <div className="px-side-head">
          <a
            href="#/accueil"
            className="px-logo-btn"
            aria-label={folded ? t('shell.unfold') : t('shell.fold')}
            aria-expanded={!folded}
            aria-controls="side"
            title={folded ? t('shell.unfold') : t('shell.fold')}
            onClick={(e) => {
              // Desktop: the logo opens and closes the sidebar (folded "p" shows an arrow on hover).
              if (!window.matchMedia('(max-width: 900px)').matches) {
                e.preventDefault();
                toggleFold();
              }
            }}
          >
            <span className="px-logo-full" aria-hidden="true" />
            <span className="px-logo-icon" aria-hidden="true" />
            <span className="px-logo-open" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
          </a>
        </div>
        <div className="px-side-scroll">
        {items.map((n) =>
          n.children ? (
            <div key={n.id} className={`nav-group open bjcn ${n.pages?.includes(page) ? 'bjcn-on in' : ''}`} data-grp={n.id}>
              <a
                href={n.href ?? kids(n)[0]?.href ?? '#/'}
                className="nav-item nav-group-head"
                title={t(`nav.${n.id}`)}
                aria-current={page === n.id && (!sub || sub === 'tout') ? 'page' : undefined}
                aria-expanded={folded ? undefined : grpOpen[n.id] !== false}
                onClick={(e) => {
                  // open sidebar (or phone menu): the parent only shows / hides its children; folded: it opens the group's page
                  if (!folded || window.matchMedia('(max-width: 900px)').matches) {
                    e.preventDefault();
                    toggleGrp(n.id);
                  }
                }}
              >
                <Icon name={n.icon} className="ic" />
                <span className="nav-l">{t(`nav.${n.id}`)}</span>
                <svg className="px-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={grpOpen[n.id] !== false ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
                </svg>
              </a>
              <div className={`nav-sub${grpOpen[n.id] !== false ? '' : ' px-sub-closed'}`} style={{ display: 'flex' }}>
                {kids(n).map((c) => {
                  const on = childOn(n, c.id);
                  const v = c.count ? counts[c.count] : undefined;
                  return (
                    <a key={c.id} href={c.href} className={`nav-item nav-sub-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} title={`${t(`nav.sub.${c.id}`)}${v !== undefined ? ` · ${v}` : ''}`}>
                      <Icon name={c.icon ?? 'list'} className="ic px-sub-ic" />
                      <span className="nav-l">{t(`nav.sub.${c.id}`)}</span>
                      {v !== undefined && <Count v={v} tone={c.tone ?? 'nc-a'} />}
                    </a>
                  );
                })}
              </div>
            </div>
          ) : (
            <a key={n.id} href={`#/${n.id}`} className={`nav-item ${page === n.id ? 'on' : ''}`} data-page={n.id} aria-current={page === n.id ? 'page' : undefined} title={`${t(`nav.${n.id}`)}${ITEM_COUNT[n.id] && counts[ITEM_COUNT[n.id][0]] !== undefined ? ` · ${counts[ITEM_COUNT[n.id][0]]}` : ''}`}>
              <Icon name={n.icon} className="ic" />
              <span className="nav-l">{t(`nav.${n.id}`)}</span>
              {ITEM_COUNT[n.id] && counts[ITEM_COUNT[n.id][0]] !== undefined && <Count v={counts[ITEM_COUNT[n.id][0]]} tone={ITEM_COUNT[n.id][1]} />}
            </a>
          ),
        )}
        </div>
      </nav>
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <div className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn px-fold-btn" aria-label={folded ? t('shell.unfold') : t('nav.menu')} title={folded ? t('shell.unfold') : t('shell.fold')} aria-expanded={!folded} onClick={() => (window.matchMedia('(max-width: 900px)').matches ? setNavOpen(!navOpen) : toggleFold())}>
            <Icon name="menu" />
          </button>
          <a className="brand" href="#/accueil" aria-label="Pilotix">
            Pilotix
          </a>
          <span id="page-title" className="page-title">
            {t(`nav.${page}`, { defaultValue: '' })}
          </span>
          {has('confirmation', 'suivi', 'depot') && <GlobalSearch />}
          {has('confirmation', 'suivi', 'depot') && (
            page === 'confirmation' && (!sub || sub === 'nouvelles' || sub === 'attente') && has('confirmation') ? (
              <button type="button" className="btn primary pxs-new pxs-next" title={t('confirmation.next').replace(/\s*[→←]\s*$/, '')} onClick={() => window.dispatchEvent(new Event('px:next-order'))}>
                <span className="pxs-t">{t('confirmation.next').replace(/\s*[→←]\s*$/, '')}</span>
                <Icon name="chevr" className="pxs-ar" />
              </button>
            ) : page === 'sav' ? (
              <button type="button" className="btn primary pxs-new" title={t('sav.new').replace(/^\+\s*/, '')} onClick={() => (location.hash = '#/sav/nouveau')}>
                +<span className="pxs-t"> {t('sav.new').replace(/^\+\s*/, '')}</span>
              </button>
            ) : (
              <button type="button" className="btn primary pxs-new" title={t('orders.new')} onClick={() => openOrderForm()}>
                +<span className="pxs-t"> {t('orders.new')}</span>
              </button>
            )
          )}
          <select
            className="icon-btn px-hdr-lang"
            aria-label={t('shell.language')}
            value={i18n.language}
            onChange={(e) => {
              applyLanguage(e.target.value as Language);
              rpc('me.language', { language: e.target.value as Language }).catch(() => {});
            }}
            style={{ width: 'auto', padding: '0 6px', fontWeight: 700 }}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
          <button
            className="icon-btn theme-btn px-hdr-theme"
            aria-label={t('shell.theme')}
            title={t('shell.theme')}
            onClick={() => {
              const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
              applyTheme(dark ? 'light' : 'dark');
            }}
          >
            <Icon name="moon" />
          </button>
          <AccountMenu
            session={session!}
            onLogout={logout}
            lang={{
              value: i18n.language,
              options: [...LANGUAGES],
              onChange: (l) => {
                applyLanguage(l as Language);
                rpc('me.language', { language: l as Language }).catch(() => {});
              },
            }}
            onTheme={() => {
              const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
              applyTheme(dark ? 'light' : 'dark');
            }}
          />
        </header>
        <ShopBanner session={session!} />
        {has('confirmation') && !isAdmin && (
          <Suspense fallback={null}>
            <AgentBanner />
          </Suspense>
        )}
        <main id="page" className="page">
          {/* Folded sidebar: only the parent items stay in the menu; a group's children move into a bar under the header. */}
          {folded && curGrp && (
            <div className="px-grp-bar">
              <StageBar
                flow={false}
                current={kids(curGrp).find((c) => childOn(curGrp, c.id))?.id ?? ''}
                items={kids(curGrp).map((c) => ({ key: c.id, label: t(`nav.sub.${c.id}`), href: c.href, count: c.count ? counts[c.count] : undefined }))}
              />
            </div>
          )}
          {children}
        </main>
      </div>
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}

/** Top bar search: BJ…/PX…, phone, name, tracking — with a keyboard list. */
function GlobalSearch() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [debounced, setDebounced] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const res = useRpc('orders.list', { q: debounced, pageSize: 8, tickets: 'include' }, { enabled: debounced.length >= 2 });
  const rows = debounced.length >= 2 ? res.data?.rows ?? [] : [];
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const go = (id: number) => {
    setOpen(false);
    setQ('');
    openOrder(id);
  };
  return (
    <div className="pxs" ref={box}>
      <Icon name="search" />
      <input
        type="search"
        className="pxs-in"
        placeholder={t('shell.search')}
        aria-label={t('shell.search')}
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setSel(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel((s) => Math.min(rows.length - 1, s + 1));
          else if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
          else if (e.key === 'Enter' && rows[sel]) go(rows[sel].id);
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && debounced.length >= 2 && (
        <div className="pxs-res" role="listbox">
          {rows.length === 0 && <div className="muted small" style={{ padding: 10 }}>{res.isFetching ? t('common.loading') : t('shell.noResult')}</div>}
          {rows.map((o, i) => (
            <button key={o.id} type="button" role="option" aria-selected={i === sel} className={`pxs-it ${i === sel ? 'on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => go(o.id)}>
              <b className="ltr">{o.ref}</b> <TicketTag savRef={o.savRef} /> {o.customerName} <span className="muted ltr">{o.phone}</span>
              <span className="muted small"> · {when(o.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const save = useAction('me.password', { success: t('shell.passwordChanged'), onDone: onClose });
  return (
    <Modal
      title={t('shell.changePassword')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={next.length < 8 || save.isPending} onClick={() => save.mutate({ current: cur, next })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="grid2" style={{ display: 'grid', gap: 12 }}>
        <Field label={t('shell.currentPassword')}>
          <input id="pw-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label={t('shell.newPassword')} hint={t('shell.passwordHint')}>
          <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export { normalizePhone };
