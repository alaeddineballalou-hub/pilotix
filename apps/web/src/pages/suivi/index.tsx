import { MENU_TABS, type Order, WILAYAS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { when, wilayaName, syncProblems } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { SellerScope } from '../../lib/seller';
import { AgencyChip, Empty, ErrorBox, Icon, Loading, Pager, RemovableChip, StatusBadge } from '../../ui/kit';
import { useAgentName } from '../../lib/agentName';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { ConfirmModal, daysSince, productsText } from './common';
import { namesOf, variantsOf, trackOf } from '../../lib/items';
import { NewClaimModal } from './Claims';
import { Reclamation } from './Reclamation';
import { SwapModal, SwapResult, SwapSheetModal } from './Swap';
import './suivi.css';
import { colDrag, ColumnMenu, DensitySwitch, useDensity, useResizable, useTableColumns } from '../../ui/ColumnMenu';
import { TabletColsButton, useTabletCols } from '../../ui/tabletCols';
import { HistoryButton, PhoneCell } from '../confirmation/History';
import { RotateChip } from '../confirmation/Countdown';
import { store } from '../../lib/store';
import { CopyCode } from '../../ui/CopyCode';
import { useIsPhone } from '../../lib/useMedia';
import { useViewMode, ViewSwitch } from '../../ui/ViewSwitch';
import { AlertClock, AlertTries, CancelSheet, ClockChip, TriesChip, ParcelAction, ParcelCards, ParcelPage, MotifChip } from './PhoneSuivi';
import { Traiter } from './Traiter';
import { SuiviSettings } from './Settings';
import { StuckChips, StuckDialog, type StuckInfo } from './Stuck';
import { ScoreChip } from '../../ui/clientScore';
import { AgentFilter, ClearFilters, CompanyFilter, DateFilters, dayIso, LivreurFilter, ProductFilter, useFilterOptions, WilayaFilter } from '../../ui/filters';
import { useDebounced } from '../depot/OrderList';
import type { In } from '../../lib/backend';
import { useAllMode } from '../../layout/AllBoutiques';
import { DemoCourier } from './DemoCourier';
import { rightOn, tabOn } from '../../lib/rights';
import { AssignSwitch, type Assign } from '../../ui/AssignSwitch';
import { DoneScreen } from '../orders';
import { AlertPanel, ClairCards, ClairCounters, ClairTable, clairKey, GiveBar, HistorySheet, isClairTab, RappelSheet, StatusMenu, type ClairHandlers, type ClairPick, type ClairTab, type ClairX, type StatusKey } from './Clair';
import { PickBar, PickToggle } from '../confirmation/PhoneList';
import { FaultSheet } from '../faults/FaultSheet';

const LIST_TABS = ['enlivraison', 'alertes', 'alertes_new', 'alertes_encours', 'erreurs', 'resolus', 'traites', 'bloques', 'livres', 'annules', 'swap'] as const;
/** the alert lists: all of them, the new ones (nobody acted yet), the ones in progress */
/** in a confirmation agency's space (its agents, its chief) */
const useInAgency = () => {
  const s = useSession().session;
  return s?.shop?.kind === 'agency' || !!s?.profile.agencyId;
};
const isAlertTab = (tab: string) => tab === 'alertes' || tab === 'alertes_new' || tab === 'alertes_encours' || tab === 'erreurs';
/** the menu « Suivi »'s row (Suivi · Clair): Nouvelles alertes · En cours · Résolu · Swap · Réclamation */
const inAlertBar = (tab: string) => isAlertTab(tab) || ['resolus', 'reclamation', 'annules', 'swap'].includes(tab);
type ListTab = (typeof LIST_TABS)[number];
type Sub = ListTab | 'reclamation' | 'messages';
/** the tabs that show orders (« Messages » shows the journal) */
type ListSub = Exclude<Sub, 'messages'>;
// The bar is drawn by hand (Alertes and its parts, an agency's steps), but its tabs are the menu's (MENU_TABS.suivi,
// packages/shared/src/menu.ts, shared with Utilisateurs › Rôles): a tab added on one side only stops the build here.
type MenuSuivi = (typeof MENU_TABS.suivi)[number];
const sameTabs: [Exclude<MenuSuivi, Sub | 'reglages'>, Exclude<Sub, MenuSuivi | 'alertes_new' | 'alertes_encours' | 'erreurs' | 'resolus'>] extends [never, never] ? true : false = true;
void sameTabs;

/** « Suivi »: this boutique's, or every boutique's with « Toutes les boutiques ». */
export function Suivi(p: PageProps) {
  const all = useAllMode();
  if (!all.on) return <SuiviOne {...p} />;
  return (
    <Suspense fallback={<Loading />}>
      <AllSuiviPage {...p} />
    </Suspense>
  );
}
/** An old address that now lives elsewhere: replaced at once (the back button does not return to it). */
function GoTo({ href }: { href: string }) {
  useEffect(() => location.replace(href), [href]);
  return null;
}
const AllSuiviPage = lazy(() => import('../boutiques/all').then((m) => ({ default: m.BoutiquesSuivi })));

function SuiviOne({ sub: asked0 }: PageProps) {
  const { t } = useTranslation();
  // « alertes-encours » is « alertes_encours » (the Deploy page's « Essayer » links carry dashes, never « _ »)
  const sub = asked0?.replace(/-/g, '_');
  const agency = useInAgency();
  const { has } = useSession();
  // « Messages » left Suivi (the owner, 25 Nov 2026): it is Pilot Automations › Messages; the old address opens it
  if (sub === 'messages' && !agency) return <GoTo href="#/notify/messages" />;
  // « Réglages »: every setting of Suivi (a store's own; an agency has its own settings page)
  if (sub === 'reglages' && !agency && tabOn('suivi', 'reglages'))
    return (
      <>
        <SuiviBar tab="alertes_new" cfgOn />
        <SuiviSettings />
      </>
    );
  // the claims with couriers and the swaps: the store's suivi agents and the agencies (on their own orders)
  const tabs: readonly string[] = (!has('suivi') && !has('confirmation') ? LIST_TABS.filter((k) => k !== 'swap') : [...LIST_TABS, 'reclamation']).filter((k) => tabOn('suivi', k));
  const asked: ListSub = tabs.includes(sub ?? '') ? (sub as ListSub) : 'enlivraison';
  // an agency's confirmation agent (no suivi): En livraison, Livré, Annulé — to watch its orders move (no alert, claim, swap)
  const tab0: ListSub = agency && !has('suivi') && !['enlivraison', 'livres', 'annules', 'alertes', 'alertes_new', 'alertes_encours', 'erreurs', 'resolus', 'swap', 'reclamation'].includes(asked) ? 'enlivraison' : asked;
  // « Alertes » opens « Nouvelles alertes » (Suivi · Clair: the owner's design 1, 25 Nov 2026). A store's old addresses
  // (the owner, 25 Nov 2026): « Traités » (the handled alerts, now En cours › Attend ZR and Résolu) opens Résolu,
  // « Bloqués » En livraison, « Swap » Annulés (the swaps are made there)
  const OLD: Partial<Record<ListSub, ListSub>> = { alertes: 'alertes_new', traites: 'resolus', bloques: 'enlivraison', swap: 'annules' };
  const tab: ListSub = tab0 === 'alertes' ? 'alertes_new' : agency ? tab0 : OLD[tab0] ?? tab0;
  return (
    <>
      <SuiviBar tab={tab} />
      {tab === 'reclamation' ? (
        <Reclamation />
      ) : tab === 'annules' && agency ? (
        // an agency: « Annulé » is the same screen as everywhere (owner's choice, 24 Nov 2026), on its returns
        <DoneScreen sub="annulees" start="back" />
      ) : tab === 'annules' ? (
        // a store's Suivi › Annulés (the owner, 25 Nov 2026): the parcels coming back and back, the ones a swap can take,
        // Client annulé · ZR annulé · Tous, « Swap » on a line when a swap is possible; then the swapped ones
        <>
          <ClairList key={tab} tab="annules" />
          <SwappedList />
          <p className="svc-note">
            <Icon name="info" /> {t('suivi.clair.confCancelled')} <a href="#/commandes/annulees">{t('suivi.clair.confCancelledGo')}</a>
          </p>
        </>
      ) : (
        isClairTab(tab) ? (
          <>
            <ClairList key={tab} tab={tab} />
            {tab === 'swap' && <SwappedList />}
          </>
        ) : !agency && tab === 'enlivraison' ? (
          // the menu « En livraison »: one list of every parcel on the road, no Suivi tab or counter over it (the owner,
          // 25 Nov 2026); its title, « Actualiser » and one sentence are in the list's own head
          <List key={tab} tab={tab} />
        ) : (
          <>
            <Head tab={tab} />
            <List key={tab} tab={tab} />
          </>
        )
      )}
    </>
  );
}

/** The menu « Suivi »'s one row (Nouvelles alertes · En cours · Résolu · Annulés · Réclamation); an agency's steps. */
function SuiviBar({ tab, cfgOn = false }: { tab: Sub; cfgOn?: boolean }) {
  const { t } = useTranslation();
  const agency = useInAgency();
  const { has, session } = useSession();
  // the gear only for who has something to change there (not a page that says « nothing for your role »): an
  // administrator, or a person allowed to share the alerts (« Affectation »); a store's, not an agency's
  const cfg = !agency && tabOn('suivi', 'reglages') && (!!session?.isAdmin || !!session?.profile.canAffect);
  const c = useRpc('suivi.counts', {}, { refetchInterval: 60_000 }).data;
  // a phone shows a few steps at a time: the current one is brought into view
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bar.current;
    const on = el?.querySelector<HTMLElement>('.bjm-p.on');
    if (!el || !on || el.scrollWidth <= el.clientWidth + 1) return;
    const r = el.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    // the gear « Réglages » stays at the end, over the steps: the step must show before it (« Messages », the last one)
    const gear = el.querySelector<HTMLElement>('.bjm-cfg');
    const right = r.right - (gear ? gear.getBoundingClientRect().width : 0) - 8;
    if (b.left >= r.left + 8 && b.right <= right) return;
    el.scrollBy({ left: b.left + b.width / 2 - (r.left + (right - r.left) / 2) });
    // again once the counts are in: they widen the steps
  }, [tab, c]);
  const active = (k: Sub) => !cfgOn && (tab === k || (k === 'alertes' && ['alertes_new', 'alertes_encours', 'erreurs', 'resolus', 'reclamation', 'annules', 'swap'].includes(tab)));
  // (a tab taken from the role in Utilisateurs › Rôles is not drawn)
  const item = (k: Sub, count?: number, x = false, label?: string) => !tabOn('suivi', k) ? null : (
    <a className={`bjm-p ${active(k) ? 'on' : ''} ${x ? 'x' : ''}`} href={`#/suivi/${k}`} data-k={k} aria-current={tab === k ? 'page' : active(k) ? 'location' : undefined}>
      <span className="bjm-l">{label ?? t(agency && k === 'traites' ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${k}`)}</span>
      {count !== undefined && <b className="bjm-n ltr">{count}</b>}
    </a>
  );
  // a confirmation agency: the tabs of the step chosen in its menu (En livraison · Alertes · Livré · Annulé)
  if (agency) {
    const step = ['alertes', 'alertes_new', 'alertes_encours', 'erreurs', 'resolus', 'traites', 'reclamation'].includes(tab) ? 'alert' : tab === 'bloques' || tab === 'enlivraison' ? 'road' : tab;
    return (
      <nav ref={bar} className="bjm-bar flow" aria-label="Étapes" data-g="suivi">
        {step === 'alert' ? (
          <>
            {item('alertes_new', c?.alertes_new ?? 0)}
            <span className="bjm-ar" aria-hidden="true">›</span>
            {item('alertes_encours', c?.alertes_encours ?? 0)}
            {!!c?.erreursTab && item('erreurs', c?.erreurs ?? 0)}
            <span className="bjm-ar" aria-hidden="true">›</span>
            {item('traites', c?.traites ?? 0)}
            <span className="bjm-sep" aria-hidden="true" />
            {(has('suivi') || has('confirmation')) && item('reclamation', c?.claims, true)}
            {item('annules', c?.annules ?? 0)}
          </>
        ) : step === 'road' ? (
          <>
            {item('enlivraison', c?.enlivraison ?? 0)}
            {has('suivi') && <span className="bjm-sep" aria-hidden="true" />}
            {has('suivi') && item('bloques', c?.bloquesTodo ?? 0, true)}
          </>
        ) : step === 'annules' || step === 'swap' ? (
          <>
            {item('annules', c?.annules ?? 0)}
            {has('suivi') && <span className="bjm-sep" aria-hidden="true" />}
            {(has('suivi') || has('confirmation')) && item('swap', c?.swap ?? 0, true)}
          </>
        ) : (
          item(tab, c?.livres ?? 0)
        )}
      </nav>
    );
  }
  const gear = cfg && (
    <a className={`bjm-p bjm-cfg ${cfgOn ? 'on' : ''}`} href="#/suivi/reglages" aria-label={t('suivi.tabs.reglages')} title={t('suivi.tabs.reglages')} aria-current={cfgOn ? 'page' : undefined}>
      <Icon name="settings" />
      <span className="bjm-l">{t('suivi.tabs.reglages')}</span>
    </a>
  );
  // The owner (25 Nov 2026): the menu's « Suivi » shows only the alerts, the swaps and the réclamations; the menu's « En
  // livraison » everything about the delivery. One row each, never mixed. (« Traités » became En cours › Attend ZR and
  // Résolu; « Messages » is Pilot Automations › Messages: their addresses still open.)
  if (inAlertBar(tab) || cfgOn)
    return (
      <nav ref={bar} className="bjm-bar flow" aria-label={t('suivi.tabs.alertes')} data-g="suivi-alertes">
        {item('alertes_new', c?.alertes_new ?? 0, false, t('suivi.clair.tab.alertes_new'))}
        {item('alertes_encours', c?.alertes_encours ?? 0, false, t('suivi.clair.tab.alertes_encours'))}
        {/* « Erreurs »: the problems to fix, on their own (Suivi › Réglages › « Quand une alerte commence ») */}
        {!!c?.erreursTab && item('erreurs', c?.erreurs ?? 0, false, t('suivi.clair.tab.erreurs'))}
        {item('resolus', c?.resolus ?? 0, false, t('suivi.clair.tab.resolus'))}
        {item('annules', c?.annulesClair ?? 0, false, t('suivi.clair.tab.annules'))}
        {(has('suivi') || has('confirmation')) && item('reclamation', c?.claims, true, t('suivi.clair.tab.reclamation'))}
        {/* « Réglages »: apart at the end, with a gear (Utilisateurs › Rôles: the owners and the agent managers by default) */}
        {gear}
      </nav>
    );
  // the menu « En livraison » (and a store's other delivery lists): no Suivi tab row
  return null;
}

/** « Actualiser »: asks the delivery companies for their news (the demo simulates them). */
function SyncButton() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      // built by the delivery feature; the demo simulates the couriers
      const r = (await (rpc as unknown as (n: string, i: unknown) => Promise<any>)('delivery.sync', {})) ?? {};
      toast(t('suivi.syncDone', { checked: r.checked ?? 0, changed: r.changed ?? 0 }), 'ok');
      const problems = syncProblems(r);
      if (problems.length) toast(t('suivi.syncProblems', { count: problems.length, list: problems.slice(0, 4).join(' · ') }), 'bad');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(t('suivi.syncFail', { msg: e?.message ?? '' }), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn sv-sync" onClick={sync} disabled={busy}>
      <Icon name="refresh" /> {t('suivi.sync')}
    </button>
  );
}

function Head({ tab }: { tab: ListTab }) {
  const { t } = useTranslation();
  const agency = useInAgency();
  const { has } = useSession();
  const c = useRpc('suivi.counts', {}).data;
  const kpis: [ListTab, 'warn' | ''][] = [
    ['enlivraison', ''],
    ['alertes', c?.alertes ? 'warn' : ''],
    ['traites', ''],
    ['bloques', c?.bloquesTodo ? 'warn' : ''],
    ['livres', ''],
    ['annules', ''],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('suivi.title')}</h2>
        {!agency && has('suivi') && <SyncButton />}
      </div>
      <div className="kpis bjsv-kpis">
        {kpis.map(([k, tone]) => (
          <a key={k} className={`kpi${k === tab ? ' bjsv-on' : ''}${tone ? ` t-${tone}` : ''}`} href={`#/suivi/${k}`}>
            <span className="l">{t(`suivi.tabs.${k}`)}</span>
            <span className="v ltr">{c ? (k === 'bloques' ? c.bloquesTodo : c[k]) : '—'}</span>
            <span className="s">{t(`suivi.kpiSub.${k}`)}</span>
          </a>
        ))}
      </div>
      {!!c?.lateCall && (
        <a className="sv-late" href="#/suivi/alertes">
          <Icon name="alert" /> {t('suivi.clock.lateCount', { count: c.lateCall })}
        </a>
      )}
      <p className="muted small">{t(agency && tab === 'enlivraison' ? 'suivi.help.enlivraisonAgency' : `suivi.help.${tab}`)}</p>
    </div>
  );
}

type Extra = { rotateAt?: number | null; stuck?: StuckInfo | null; motif?: { outcome: 'resolved' | 'lost'; label: string } | null; clock?: AlertClock | null; tries?: AlertTries | null; companyKind: string | null; livreurPhone: string | null; alertReason: string | null; claim: { id: number; status: string; createdAt: string; sentAt: string | null } | null };

/** What the courier or the livreur said: the alert note while in alert, else the courier's own status. */
const reasonOf = (o: Order, x?: Extra) => (o.followStatus === 'alert' ? x?.alertReason || o.extStatus : o.extStatus);

/** Suivi columns. Keys shared with Confirmation, so one saved preset works in both. */
type SCol = 'order' | 'name' | 'phone' | 'wilaya' | 'product' | 'variant' | 'tracking' | 'follow' | 'agent' | 'fagent' | 'since' | 'passed' | 'status';
const SCOLS: SCol[] = ['order', 'name', 'phone', 'wilaya', 'product', 'variant', 'tracking', 'follow', 'agent', 'fagent', 'since', 'passed', 'status'];
const SDEFAULT: SCol[] = ['order', 'name', 'phone', 'wilaya', 'product', 'variant', 'follow', 'agent', 'fagent', 'since', 'passed', 'status'];
const SKEY = 'suivi-cols';
/** The columns a suivi agent works with, most useful first (a tablet shows the first 6 the table has). */
const SUIVI_USEFUL: SCol[] = ['name', 'phone', 'follow', 'since', 'wilaya', 'status', 'product', 'order'];

export type ParcelRow = Order & { seller?: { id: number; name: string }; extra?: Extra | null };
export const parcelKey = (o: ParcelRow) => `${o.seller?.id ?? 0}:${o.id}`;
const extraOf = (o: ParcelRow, extra: Record<number, Extra>) => o.seller ? o.extra ?? undefined : extra[o.id];
function ParcelScope({ order, children, ambient = true }: { order: ParcelRow; children: ReactNode; ambient?: boolean }) {
  return order.seller ? <SellerScope seller={order.seller.id} ambient={ambient}>{children}</SellerScope> : <>{children}</>;
}

/** The table shared by every Suivi list, with the column menu and the shared presets. */
export function ParcelTable({ rows, actions, empty, extra = {} }: { rows: ParcelRow[]; actions?: (o: ParcelRow) => ReactNode; empty: string; extra?: Record<number, Extra> }) {
  const { t } = useTranslation();
  // the seller sees his agency on its orders, never its agents
  const who = useAgentName();
  const { has } = useSession();
  const qc = useQueryClient();
  const unFollow = useAction('suivi.unassign', { success: (o) => t('suivi.agentRemoved', { ref: o.ref }) });
  // columns saved with the account; a chosen preset is used by every list until the columns are changed by hand
  const tc = useTableColumns<SCol>('suivi', SCOLS, { defaults: SDEFAULT, legacy: () => ({ cols: store.json<SCol[] | null>(SKEY, null), order: store.json<SCol[] | null>('suivi-order', null) }) });
  const visible = tc.visible;
  const [menu, setMenu] = useState(false);
  const label: Record<SCol, string> = {
    order: t('suivi.col.order'), name: t('suivi.col.client'), phone: t('suivi.col.phone'), wilaya: t('suivi.col.wilaya'), product: t('suivi.col.products'), variant: t('suivi.col.variant'),
    tracking: t('suivi.col.tracking'), follow: t('suivi.col.delivery'), agent: t('suivi.col.agent'), fagent: t('suivi.col.fagent'), since: t('suivi.col.since'), passed: t('confirmation.col.passed'), status: t('suivi.col.status'),
  };
  const { order, setOrder } = tc;
  // on a tablet: the 6 columns a suivi agent works with, « +N colonnes » shows the others (ui/tabletCols)
  const tcols = useTabletCols(order.filter((k) => visible.has(k)), (k) => k, SUIVI_USEFUL);
  const cols = tcols.cols;
  const drag = colDrag(order, setOrder);
  // column widths: each user's own
  const wkeys: string[] = [...cols, ...(actions ? ['_act'] : [])];
  const [dens, setDens] = useDensity();
  const rs = useResizable(tc.widths, tc.setWidths, t('common.resizeCol'), wkeys, dens);
  const cell = (o: ParcelRow, k: SCol): ReactNode => {
    switch (k) {
      case 'order':
        return (
          <>
            <b className="ltr">{o.ref}</b>
            <small>{when(o.createdAt)}</small>
            {o.seller && <small>{o.seller.name}</small>}
          </>
        );
      case 'name':
        return (
          <>
            {o.customerName}
            {o.clientScore && <ScoreChip s={o.clientScore} short />}
          </>
        );
      case 'phone':
        return <PhoneCell order={o} />;
      case 'wilaya':
        return (
          <>
            {wilayaName(o.wilayaId)}
            <small>{o.commune}</small>
          </>
        );
      case 'product':
        return <div className="px-clamp">{namesOf(o.items)}</div>;
      case 'variant':
        return <div className="px-clamp">{variantsOf(o.items)}</div>;
      case 'tracking':
        return <CopyCode code={trackOf(o)} />;
      case 'follow':
        return (
          <>
            {o.companyName || o.livreurName || '—'}
            <small>
              {trackOf(o) && <CopyCode code={trackOf(o)} />}
              {reasonOf(o, extraOf(o, extra)) ? ` · ${reasonOf(o, extraOf(o, extra))}` : ''}
            </small>
          </>
        );
      case 'agent':
        return who.confAgency(o) ? <AgencyChip name={who.confAgency(o)!} /> : <RemovableChip name={o.agentName} />;
      case 'fagent':
        if (who.storeSide && o.followAgencyId) return <AgencyChip name={who.follow(o)!} />;
        return <RemovableChip name={o.followAgentName} removeLabel={t('suivi.removeAgent')} disabled={unFollow.isPending} onRemove={has('suivi') ? () => {
          if (o.seller) void rpc('suivi.unassign', { id: o.id }, o.seller.id).then(() => qc.invalidateQueries(), (e) => toast(e.message, 'bad'));
          else unFollow.mutate({ id: o.id });
        } : undefined} />;
      case 'since': {
        const d = daysSince(o.shippedAt);
        return (
          <>
            {d === null ? '—' : <span className={`badge ${d >= 10 ? 't-bad' : d >= 5 ? 't-warn' : 't-info'} ltr`}>{t('suivi.days', { n: d })}</span>}
            {extraOf(o, extra)?.clock && <ClockChip c={extraOf(o, extra)!.clock} />}
            {extraOf(o, extra)?.tries && <TriesChip tr={extraOf(o, extra)!.tries} />}
            {o.followStatus === 'alert' && <RotateChip at={extraOf(o, extra)?.rotateAt} />}
            {extraOf(o, extra)?.stuck && <StuckChips s={extraOf(o, extra)!.stuck} />}
          </>
        );
      }
      case 'passed':
        return (
          <HistoryButton orderId={o.id} refLabel={o.ref} className="px-histcell" title={t('confirmation.hist.open', { ref: o.ref })}>
            <Icon name="history" />
            <span className="muted">{t('confirmation.hist.see')}</span>
          </HistoryButton>
        );
      case 'status':
        return (
          <>
            <StatusBadge kind="follow" status={o.followStatus} sub={o.subStatus} />
            {extraOf(o, extra)?.motif && <MotifChip m={extraOf(o, extra)!.motif} />}
          </>
        );
    }
  };
  return (
    <>
      <div className="px-scols">
        <DensitySwitch value={dens} onChange={setDens} />
        <ColumnMenu
          order={order}
          onOrder={setOrder}
          cols={SCOLS.map((k) => ({ k, label: label[k] }))}
          visible={visible}
          onChange={tc.setVisible}
          onReset={tc.reset}
          presetId={tc.presetId}
          teamId={tc.teamId}
          presetShows={tc.presetShows}
          onPreset={tc.applyPreset}
          widthsSet={Object.keys(tc.widths).length > 0}
          onResetWidths={tc.resetWidths}
          open={menu}
          onToggle={() => setMenu((v) => !v)}
        />
        <TabletColsButton more={tcols.more} all={tcols.all} toggle={tcols.toggle} />
      </div>
      {!rows.length ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className={`tbl-wrap px-d-${dens}`} ref={rs.wrapRef}>
          <table className={`tbl${rs.fixed ? ' px-fixed' : ''}`} style={rs.tableStyle()}>
            {rs.cols()}
            <thead>
              <tr>
                {cols.map((k) => (
                  <th key={k} {...drag(k)} title={t('common.dragCol')} className={`px-drag px-c-${k} ${k === 'product' ? 'wide' : k === 'since' ? 'num' : ''}`}>
                    {label[k]}
                    {rs.handle(k)}
                  </th>
                ))}
                {actions && <th data-col="_act" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <ParcelScope key={parcelKey(o)} order={o} ambient={false}><tr className="clickable" onClick={() => openOrder(o.id, o.seller?.id)}>
                  {cols.map((k) => (
                    <td key={k} data-l={label[k]} className={`px-c-${k}${k === 'product' ? ' wide px-cw' : k === 'since' ? ' num' : ''}`}>
                      {cell(o, k)}
                    </td>
                  ))}
                  {actions && (
                    <td data-l="" onClick={(e) => e.stopPropagation()}>
                      {actions(o)}
                    </td>
                  )}
                </tr></ParcelScope>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Dialog =
  | { kind: 'treat'; o: ParcelRow }
  | { kind: 'cancel'; o: Order }
  | { kind: 'swap'; o: ParcelRow }
  | { kind: 'claim'; o: ParcelRow; toLivreur: boolean }
  | { kind: 'sheet'; data: SwapResult & { fresh?: boolean }; seller?: ParcelRow['seller'] }
  | { kind: 'stuck'; o: Order }
  | null;

/** The filters of the Suivi lists ('' = all), kept in this browser from one tab to another (the search apart). */
interface SuiviF {
  q: string;
  fagent: string;
  product: string;
  variant: string;
  company: string;
  livreur: string;
  wilaya: string;
  from: string;
  to: string;
}
const NO_SF: SuiviF = { q: '', fagent: '', product: '', variant: '', company: '', livreur: '', wilaya: '', from: '', to: '' };

/** The filters as suivi.list reads them. */
function suiviInput(f: SuiviF, q: string): Partial<In<'suivi.list'>> {
  const x: Partial<In<'suivi.list'>> = {};
  if (q.trim()) x.q = q.trim();
  if (f.fagent) x.followAgentId = f.fagent === 'none' ? 'none' : Number(f.fagent);
  if (f.product) x.productId = Number(f.product);
  if (f.product && f.variant) x.variantId = Number(f.variant);
  if (f.company) x.companyId = f.company === 'none' ? 'none' : Number(f.company);
  if (f.livreur) x.livreurId = Number(f.livreur);
  if (f.wilaya) x.wilayaId = Number(f.wilaya);
  if (f.from) x.from = dayIso(f.from);
  if (f.to) x.to = dayIso(f.to, true);
  return x;
}

/** Recherche, Agent suivi (for the managers), Produit, Société, Livreur, Wilaya, Du / Au. */
function SuiviFilters({ f, set, combined }: { f: SuiviF; set: (patch: Partial<SuiviF>) => void; combined?: boolean }) {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const [open, setOpen] = useState(false);
  const boss = !!session?.isAdmin || has('vendeur', 'agent_manager');
  const on = (Object.keys(NO_SF) as (keyof SuiviF)[]).filter((k) => k !== 'q' && f[k]).length;
  return (
    <div className={`filters px-sv-f${open ? ' open' : ''}`}>
      <label className="field search-f">
        <span className="lab">{t('filters.search')}</span>
        <input type="search" aria-label={t('filters.searchPh')} placeholder={t('filters.searchPh')} value={f.q} onChange={(e) => set({ q: e.target.value })} />
      </label>
      <button type="button" className="btn filters-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('filters.toggle')}
        {on > 0 && <b className="ltr"> · {on}</b>}
      </button>
      {!combined && boss && <AgentFilter kind="follow" value={f.fagent} onChange={(v) => set({ fagent: v })} />}
      {!combined && <>
        <ProductFilter product={f.product} variant={f.variant} onChange={(v) => set(v)} />
        <CompanyFilter value={f.company} onChange={(v) => set({ company: v })} />
        <LivreurFilter value={f.livreur} onChange={(v) => set({ livreur: v })} />
      </>}
      <WilayaFilter value={f.wilaya} onChange={(v) => set({ wilaya: v })} />
      <DateFilters from={f.from} to={f.to} onChange={(v) => set(v)} />
      <ClearFilters on={on > 0} onClear={() => set({ ...NO_SF, q: f.q })} />
    </div>
  );
}

/**
 * « Suivi · Clair » filters (the owner's design): on a computer one line without labels — a wide search, the wilaya, the
 * product, the period — and « Filtres » (a small panel) for the agent, the company and the livreur; on a phone the
 * search and « Filtres » only.
 */
function ClairFilters({ f, set, phone }: { f: SuiviF; set: (patch: Partial<SuiviF>) => void; phone: boolean }) {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const [open, setOpen] = useState(false);
  const boss = !!session?.isAdmin || has('vendeur', 'agent_manager');
  const opts = useFilterOptions();
  const inPanel: (keyof SuiviF)[] = phone ? ['fagent', 'product', 'variant', 'company', 'livreur', 'wilaya', 'from', 'to'] : ['fagent', 'variant', 'company', 'livreur'];
  const on = inPanel.filter((k) => f[k]).length;
  const anyOn = (Object.keys(NO_SF) as (keyof SuiviF)[]).some((k) => k !== 'q' && f[k]);
  const variants = opts?.products.find((p) => String(p.id) === f.product)?.variants ?? [];
  return (
    <div className="svc-fbar">
      <label className="svc-fs">
        <Icon name="search" />
        <input type="search" aria-label={t('filters.searchPh')} placeholder={t('filters.searchPh')} value={f.q} onChange={(e) => set({ q: e.target.value })} />
      </label>
      {!phone && (
        <>
          <select className="svc-fsel" aria-label={t('filters.wilaya')} value={f.wilaya} onChange={(e) => set({ wilaya: e.target.value })}>
            <option value="">{t('suivi.clair.f.allWilayas')}</option>
            {WILAYAS.map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {wilayaName(i + 1)}
              </option>
            ))}
          </select>
          <select className="svc-fsel" aria-label={t('filters.product')} value={f.product} onChange={(e) => set({ product: e.target.value, variant: '' })}>
            <option value="">{t('filters.allProducts')}</option>
            {(opts?.products ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.active ? p.name : `${p.name} ${t('filters.off')}`}
              </option>
            ))}
          </select>
          <span className="svc-fd">
            <Icon name="calendar" />
            <input type="date" aria-label={t('filters.from')} title={t('filters.from')} value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <span aria-hidden="true">→</span>
            <input type="date" aria-label={t('filters.to')} title={t('filters.to')} value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </span>
        </>
      )}
      <span className="svc-fmore">
        <button type="button" className={`px-fbtn svc-fbtn${on ? ' on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="sliders" /> {t('filters.toggle')}
          {on > 0 && <b className="ltr">{on}</b>}
        </button>
        {open && (
          <div className="filters open svc-fpanel">
            {phone && <WilayaFilter value={f.wilaya} onChange={(v) => set({ wilaya: v })} />}
            {phone && <ProductFilter product={f.product} variant={f.variant} onChange={(v) => set(v)} />}
            {phone && <DateFilters from={f.from} to={f.to} onChange={(v) => set(v)} />}
            {!phone && !!variants.length && (
              <label className="field more-f">
                <span className="lab">{t('filters.variant')}</span>
                <select value={f.variant} onChange={(e) => set({ variant: e.target.value })}>
                  <option value="">{t('filters.allF')}</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {boss && <AgentFilter kind="follow" value={f.fagent} onChange={(v) => set({ fagent: v })} />}
            <CompanyFilter value={f.company} onChange={(v) => set({ company: v })} />
            <LivreurFilter value={f.livreur} onChange={(v) => set({ livreur: v })} />
            <ClearFilters on={anyOn} onClear={() => set({ ...NO_SF, q: f.q })} />
          </div>
        )}
      </span>
    </div>
  );
}

export type CombinedSuivi = { input?: Record<string, unknown>; bar?: ReactNode; chip: ReactNode; canWork?: (sellerId: number) => boolean };
export function List({ tab, combined }: { tab: ListTab; combined?: CombinedSuivi }) {
  const { t } = useTranslation();
  const agency = useInAgency();
  const { has, session } = useSession();
  const canFollow = has('suivi');
  const qc = useQueryClient();
  const canTreat = (o: ParcelRow) => canFollow && (!o.seller || !combined?.canWork || combined.canWork(o.seller.id));
  const canHandle = canFollow || has('confirmation');
  // Utilisateurs › Rôles: « Traiter les alertes » (treat, back to alert, stuck parcels)
  const treats = rightOn('act:suivi.treat');
  const [page, setPage] = useState(1);
  // « Toutes / Non affectées / Affectées » on the alerts (ui/AssignSwitch): the owner, the agent managers, an agency's
  // chiefs; never a suivi agent. It starts on « Toutes »; the « Agent suivi » filter and it never fight
  const showAssign = isAlertTab(tab) && (has('vendeur', 'agent_manager') || !!session?.profile.agencyLead);
  const [assign, setAssignState] = useState<Assign>('all');
  const [f, setF] = useState<SuiviF>(() => ({ ...NO_SF, ...store.json<Partial<SuiviF>>('suivi-f', {}), q: '' }));
  const setFilter = (patch: Partial<SuiviF>) => {
    if (patch.fagent) setAssignState('all');
    setF((x) => {
      const nx = { ...x, ...patch };
      const { q: _q, ...keep } = nx;
      store.set('suivi-f', JSON.stringify(keep));
      return nx;
    });
    setPage(1);
  };
  const dq = useDebounced(f.q);
  const scopeKey = JSON.stringify(combined?.input ?? {});
  useEffect(() => setPage(1), [scopeKey]);
  const agencyFilters = combined ? { ...NO_SF, q: f.q, wilaya: f.wilaya, from: f.from, to: f.to } : f;
  const setAssign = (v: Assign) => {
    setAssignState(v);
    if (v !== 'all' && f.fagent) setFilter({ fagent: '' });
    setPage(1);
  };
  const q = useRpc('suivi.list', { tab, page, pageSize: 100, ...suiviInput(agencyFilters, dq), ...(showAssign && assign !== 'all' ? { assigned: assign } : {}), ...combined?.input });
  const [dlg, setDlg] = useState<Dialog>(null);
  const act = useAction('suivi.act');
  // phones: journey cards; a tap opens the parcel full screen. Computers: the same cards, the parcel in a side panel
  // (« Tableau » goes back to the table)
  const phone = useIsPhone();
  const [mode, setMode] = useViewMode('suivi');
  const cards = phone || mode === 'cards';
  const [openId, setOpenId] = useState<ParcelRow | null>(null);
  // « Alerte suivante »: the most urgent alert, taken (15 minutes) by this agent; when it leaves the alerts, the next one
  const [focus, setFocus] = useState<{ id: number; x: Extra | null; kind: 'alert' | 'stuck' } | null>(null);
  const [nexting, setNexting] = useState(false);
  const skip = useRef<number[]>([]);
  const nextAlert = async () => {
    setNexting(true);
    try {
      const r = await rpc('suivi.next', { skip: skip.current.slice(-200), release: focus?.id ?? null, ...(tab === 'bloques' ? { only: 'stuck' as const } : {}) });
      if (!r.id) {
        setFocus(null);
        toast(t('suivi.nextNone'), 'ok');
        return;
      }
      skip.current.push(r.id);
      setFocus({ id: r.id, x: (r.extra as Extra | null) ?? null, kind: r.kind === 'stuck' ? 'stuck' : 'alert' });
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setNexting(false);
    }
  };
  const closeFocus = () => {
    if (focus) rpc('suivi.release', { id: focus.id }).catch(() => {});
    setFocus(null);
    skip.current = [];
  };
  const run = (o: ParcelRow, action: 'cancel' | 'delivered' | 'realert', details?: { by?: 'client' | 'early'; note?: string | null }) => {
    const input = { id: o.id, action, ...details };
    const done = () => toast(t(`suivi.msg.${action === 'cancel' ? 'cancelled' : action}`, { ref: o.ref }), 'ok');
    if (o.seller) void rpc('suivi.act', input, o.seller.id).then(() => { done(); void qc.invalidateQueries(); }, (e) => toast(e.message, 'bad'));
    else act.mutate(input, { onSuccess: done });
  };

  const extra = (q.data?.extra ?? {}) as Record<number, Extra>;
  let actions: ((o: ParcelRow) => ReactNode) | undefined;
  if (isAlertTab(tab))
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        {!agency && <AlertClaim o={o} x={extraOf(o, extra)} onClaim={(toLivreur) => setDlg({ kind: 'claim', o, toLivreur })} />}
        {treats && (
          <button type="button" className="btn small primary" onClick={() => setDlg({ kind: 'treat', o })}>
            {t('suivi.act.treat')}
          </button>
        )}
        <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} />
      </div>
    );
  if (tab === 'enlivraison')
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        {!treats ? null : o.followStatus === 'alert' ? <button type="button" className="btn small primary" onClick={() => setDlg({ kind: 'treat', o })}>{t('suivi.act.treat')}</button> :
          <button type="button" className="btn small" disabled={act.isPending} onClick={() => run(o, 'realert')}><Icon name="alert" /> {t('suivi.act.toAlert')}</button>}
        <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} />
      </div>
    );
  if (tab === 'bloques' && treats)
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        <button type="button" className="btn small primary" onClick={() => setDlg({ kind: 'stuck', o })}>
          {t('suivi.stuck.btn')}
        </button>
      </div>
    );
  if (tab === 'traites')
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        <button type="button" className="btn small ok" disabled={act.isPending} onClick={() => run(o, 'delivered')}>
          {t('suivi.act.delivered')}
        </button>
        <button type="button" className="btn small ghost danger" disabled={act.isPending} onClick={() => run(o, 'cancel')}>
          {t('suivi.act.cancelled')}
        </button>
        <button type="button" className="btn small" disabled={act.isPending} onClick={() => run(o, 'realert')}>
          {t('suivi.act.realert')}
        </button>
      </div>
    );
  // Swap: every parcel a swap can take now; Annulés: a parcel the customer cancelled can be swapped from here too
  if (tab === 'swap' || tab === 'annules') actions = (o) => <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} />;
  // the same buttons on the cards (Réclamation on each alert, Swap on a parcel coming back), without opening them
  const cardAct = (o: ParcelRow): ReactNode => {
    if (!canHandle) return null;
    if (isAlertTab(tab))
      return (
        <>
          {!agency && <AlertClaim o={o} x={extraOf(o, extra)} onClaim={(toLivreur) => setDlg({ kind: 'claim', o, toLivreur })} />}
          <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} />
        </>
      );
    if (tab === 'annules' || tab === 'swap') return <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} />;
    return null;
  };

  return (
    <div className={`card${cards && !phone ? ' px-wide' : ''}`}>
      <div className={`card-head${showAssign ? ' px-ahead' : ''}`}>
        <h2>{tab === 'swap' ? t('suivi.toSwap') : t(`suivi.tabs.${tab}`)}</h2>
        {showAssign && <AssignSwitch value={assign} onChange={setAssign} counts={q.data?.assign} />}
        {combined?.chip}
        <span className="muted small">{q.data ? t('suivi.parcels', { count: q.data.rows.length }) : ''}</span>
        {!combined && canFollow && (isAlertTab(tab) || tab === 'bloques') && !cards && !!q.data?.rows.length && (
          <button type="button" className="btn primary sv-next" disabled={nexting} onClick={nextAlert}>
            {tab === 'bloques' ? t('suivi.stuck.next') : t('suivi.ph.next')} <Icon name="chevr" />
          </button>
        )}
        {!agency && !combined && tab === 'enlivraison' && canFollow && <SyncButton />}
        {!phone && <ViewSwitch mode={mode} onChange={setMode} />}
      </div>
      {!agency && !combined && tab === 'enlivraison' && <p className="muted small sv-help">{t('suivi.help.enlivraisonStore')}</p>}
      {combined?.bar}
      <SuiviFilters f={agencyFilters} set={setFilter} combined={!!combined} />
      {!agency && !combined && <DemoCourier rows={q.data?.rows ?? []} />}
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : cards ? (
        (() => {
          const rows: ParcelRow[] = q.data?.rows ?? [];
          const cur = rows.find((r) => openId && parcelKey(r) === parcelKey(openId)) ?? null;
          const phoneActions = (o: ParcelRow): ParcelAction[] => {
            if (combined?.canWork && o.seller && !combined.canWork(o.seller.id)) return [];
            if (!canFollow) {
              if (!canHandle) return [];
              const swapNow: ParcelAction[] = o.swapWay && rightOn('act:suivi.swap') ? [{ key: 'swap', label: t('suivi.act.swap'), run: () => setDlg({ kind: 'swap', o }) }] : [];
              if (isAlertTab(tab) && !agency && rightOn('act:suivi.claim')) return [{ key: 'claim', label: t('suivi.ph.claimBtn'), run: () => setDlg({ kind: 'claim', o, toLivreur: extraOf(o, extra)?.companyKind === 'own' }) }, ...swapNow];
              if (isAlertTab(tab) || tab === 'annules' || tab === 'swap') return swapNow;
              return [];
            }
            const claim: ParcelAction = { key: 'claim', label: t('suivi.ph.claimBtn'), run: () => setDlg({ kind: 'claim', o, toLivreur: extraOf(o, extra)?.companyKind === 'own' }) };
            if (!treats) return isAlertTab(tab) && !agency && rightOn('act:suivi.claim') ? [claim] : [];
            if (tab === 'enlivraison') return [o.followStatus === 'alert'
              ? { key: 'treat', label: t('suivi.act.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o }) }
              : { key: 'realert', label: t('suivi.act.toAlert'), run: () => run(o, 'realert') }];
            // ZR still takes a swap of it (the customer cancelled): « Swap » next to « Traiter »
            const swapIt: ParcelAction[] = o.swapWay && rightOn('act:suivi.swap') ? [{ key: 'swap', label: t('suivi.act.swap'), run: () => setDlg({ kind: 'swap', o }) }] : [];
            if (isAlertTab(tab))
              return [{ key: 'treat', label: t('suivi.ph.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o }) }, ...(!agency && rightOn('act:suivi.claim') ? [claim] : []), ...swapIt];
            if (tab === 'traites')
              return [
                { key: 'deliv', label: t('suivi.ph.deliv'), tone: 'ok', run: () => run(o, 'delivered') },
                { key: 'realert', label: t('suivi.ph.realert'), run: () => run(o, 'realert') },
                { key: 'cancelled', label: t('suivi.ph.cancelled'), tone: 'bad', run: () => run(o, 'cancel') },
              ];
            if (tab === 'bloques') return [{ key: 'stuck', label: t('suivi.stuck.btn'), tone: 'main', run: () => setDlg({ kind: 'stuck', o }) }];
            if ((tab === 'swap' || tab === 'annules') && o.swapWay && rightOn('act:suivi.swap')) return [{ key: 'swap', label: t('suivi.act.swap'), tone: 'main', run: () => setDlg({ kind: 'swap', o }) }];
            return [];
          };
          return (
            <>
              <ParcelCards rows={rows} extra={extra} reasonOf={reasonOf} empty={t(`suivi.empty.${tab}`)} onOpen={setOpenId} act={cardAct} />
              {!combined && canFollow && (isAlertTab(tab) || tab === 'bloques') && rows.length > 0 && (
                <button type="button" className="pxp-next" disabled={nexting} onClick={nextAlert}>
                  {tab === 'bloques' ? t('suivi.stuck.next') : t('suivi.ph.next')}
                  <Icon name="chevr" />
                </button>
              )}
              {cur && (
                <ParcelScope order={cur}><ParcelPage
                  o={cur}
                  x={extraOf(cur, extra)}
                  reason={reasonOf(cur, extraOf(cur, extra))}
                  actions={phoneActions(cur)}
                  onClaim={agency || !canHandle || !isAlertTab(tab) ? undefined : () => setDlg({ kind: 'claim', o: cur, toLivreur: extraOf(cur, extra)?.companyKind === 'own' })}
                  onClose={() => setOpenId(null)}
                /></ParcelScope>
              )}
            </>
          );
        })()
      ) : (
        <ParcelTable rows={q.data?.rows ?? []} extra={extra} actions={actions && canFollow ? (o) => canTreat(o) ? actions(o) : null : canHandle && tab === 'swap' ? actions : canHandle ? cardAct : undefined} empty={t(`suivi.empty.${tab}`)} />
      )}
      {q.data && <Pager page={page} pageSize={100} total={q.data.total} onPage={setPage} />}
      {focus && (
        <FocusAlert
          kind={focus.kind}
          id={focus.id}
          x={extra[focus.id] ?? focus.x}
          onLeft={nextAlert}
          onClose={closeFocus}
          actions={(o) => ([
            focus.kind === 'stuck'
              ? { key: 'stuck', label: t('suivi.stuck.btn'), tone: 'main', run: () => setDlg({ kind: 'stuck', o }) }
              : { key: 'treat', label: t('suivi.ph.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o }) },
            ...(!agency && focus.kind === 'alert' && rightOn('act:suivi.claim') ? [{ key: 'claim', label: t('suivi.ph.claimBtn'), run: () => setDlg({ kind: 'claim', o, toLivreur: focus.x?.companyKind === 'own' }) }] : []),
          ] as ParcelAction[]).filter((a) => treats || a.key === 'claim')}
          onClaim={agency || focus.kind !== 'alert' || !rightOn('act:suivi.claim') ? undefined : (o) => setDlg({ kind: 'claim', o, toLivreur: focus.x?.companyKind === 'own' })}
        />
      )}
      {dlg?.kind === 'stuck' && (
        <ParcelScope order={dlg.o}><StuckDialog
          o={dlg.o}
          s={extraOf(dlg.o, extra)?.stuck ?? (focus?.id === dlg.o.id ? focus.x?.stuck : null)}
          own={(extraOf(dlg.o, extra) ?? (focus?.id === dlg.o.id ? focus.x : null))?.companyKind === 'own'}
          onClose={() => setDlg(null)}
          onDone={() => (focus?.id === dlg.o.id ? void nextAlert() : undefined)}
        /></ParcelScope>
      )}
      {dlg?.kind === 'treat' && (
        <ParcelScope order={dlg.o}><Traiter
          o={dlg.o}
          reason={reasonOf(dlg.o, extraOf(dlg.o, extra) ?? (focus?.id === dlg.o.id ? focus.x ?? undefined : undefined))}
          tries={extraOf(dlg.o, extra)?.tries ?? (focus?.id === dlg.o.id ? focus.x?.tries : null)}
          own={(extraOf(dlg.o, extra) ?? (focus?.id === dlg.o.id ? focus.x : null))?.companyKind === 'own'}
          onClose={() => setDlg(null)}
        /></ParcelScope>
      )}
      {dlg?.kind === 'cancel' && (
        <ParcelScope order={dlg.o}><CancelSheet
          o={dlg.o}
          tries={dlg.o.followStatus === 'alert' ? extraOf(dlg.o, extra)?.tries ?? (focus?.id === dlg.o.id ? focus.x?.tries : null) : null}
          busy={act.isPending}
          onClose={() => setDlg(null)}
          onOk={(by, note) => {
            run(dlg.o, 'cancel', { by, note: note ?? null });
            setDlg(null);
          }}
        /></ParcelScope>
      )}
      {dlg?.kind === 'swap' && <ParcelScope order={dlg.o}><SwapModal o={dlg.o} onClose={() => setDlg(null)} onDone={(data) => setDlg({ kind: 'sheet', data: { ...data, fresh: true }, seller: dlg.o.seller })} /></ParcelScope>}
      {dlg?.kind === 'sheet' && (dlg.seller ? <SellerScope seller={dlg.seller.id}><SwapSheetModal {...dlg.data} onClose={() => setDlg(null)} /></SellerScope> : <SwapSheetModal {...dlg.data} onClose={() => setDlg(null)} />)}
      {dlg?.kind === 'claim' && <NewClaimModal pre={dlg.o} toLivreur={dlg.toLivreur} reason="relivrer" details={reasonOf(dlg.o, extraOf(dlg.o, extra)) ? t('suivi.rec.alertDetails', { v: reasonOf(dlg.o, extraOf(dlg.o, extra)) }) : ''} onClose={() => setDlg(null)} />}
    </div>
  );
}

type CDialog =
  | { kind: 'treat'; o: ParcelRow; start?: 'resolved' }
  | { kind: 'claim'; o: ParcelRow; toLivreur: boolean }
  | { kind: 'swap'; o: ParcelRow }
  | { kind: 'sheet'; data: SwapResult & { fresh?: boolean } }
  | { kind: 'rappel'; o: ParcelRow }
  | { kind: 'fault'; o: ParcelRow }
  | { kind: 'hist'; o: ParcelRow }
  | null;

/**
 * Suivi · « Clair » (the owner's design 1, 25 Nov 2026): Nouvelles alertes · En cours · Résolu · Swap. Three counters on
 * top that filter, one line per parcel (a card on a phone), the alert opened under its line (a page on a phone) with
 * « Statut » and « Relivrer ». Résolu fills itself when the company delivers; « Client annule » sends it to Swap.
 */
function ClairList({ tab }: { tab: ClairTab }) {
  const { t } = useTranslation();
  const agency = useInAgency();
  const { has, session } = useSession();
  const qc = useQueryClient();
  const canFollow = has('suivi');
  const canHandle = canFollow || has('confirmation');
  const treats = rightOn('act:suivi.treat');
  const phone = useIsPhone();
  const [page, setPage] = useState(1);
  const [bucket, setBucketState] = useState<string | null>(null);
  const setBucket = (k: string | null) => (setBucketState(k), setPage(1));
  const working = tab === 'alertes_new' || tab === 'alertes_encours' || tab === 'erreurs';
  const showAssign = working && (has('vendeur', 'agent_manager') || !!session?.profile.agencyLead);
  // « Attribuer » (the owner, 26 Nov 2026: like Confirmation's, in Nouvelles alertes and En cours): the managers tick
  // alerts and give them to a suivi agent (a phone: « Sélectionner », then the bar at the bottom)
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState(false);
  const fo = useFilterOptions();
  const giveTo = (fo?.agents ?? []).filter((a) => a.active && a.roles.some((r) => ['suivi', 'vendeur', 'admin'].includes(r))).map((a) => ({ id: a.id, name: a.name }));
  const [assign, setAssignState] = useState<Assign>('all');
  const [f, setF] = useState<SuiviF>(() => ({ ...NO_SF, ...store.json<Partial<SuiviF>>('suivi-f', {}), q: '' }));
  const setFilter = (patch: Partial<SuiviF>) => {
    if (patch.fagent) setAssignState('all');
    setF((x) => {
      const nx = { ...x, ...patch };
      const { q: _q, ...keep } = nx;
      store.set('suivi-f', JSON.stringify(keep));
      return nx;
    });
    setPage(1);
  };
  const dq = useDebounced(f.q);
  const setAssign = (v: Assign) => {
    setAssignState(v);
    if (v !== 'all' && f.fagent) setFilter({ fagent: '' });
    setPage(1);
  };
  const q = useRpc('suivi.list', { tab, page, pageSize: 100, ...suiviInput(f, dq), ...(showAssign && assign !== 'all' ? { assigned: assign } : {}), ...(bucket ? { bucket: bucket as any } : {}) });
  const rows = (q.data?.rows ?? []) as ParcelRow[];
  const extra = (q.data?.extra ?? {}) as Record<number, ClairX>;
  const picked = rows.filter((o) => sel.has(clairKey(o)));
  const give = async (rs: ParcelRow[], agentId: number | null) => {
    try {
      // « Toutes les boutiques »: each boutique gives its own alerts
      const bySeller = new Map<number | undefined, number[]>();
      for (const o of rs) bySeller.set(o.seller?.id, [...(bySeller.get(o.seller?.id) ?? []), o.id]);
      for (const [seller, ids] of bySeller) await rpc('suivi.assign', { ids, agentId }, seller);
      const name = giveTo.find((a) => a.id === agentId)?.name ?? '';
      toast(agentId ? t('suivi.give.done', { count: rs.length, name }) : t('suivi.give.undone', { count: rs.length }), 'ok');
      setSel(new Set());
      setPicking(false);
      void qc.invalidateQueries();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    }
  };
  const pickOf: ClairPick | undefined = showAssign && (!phone || picking)
    ? {
        picked: sel,
        toggle: (o) => setSel((s0) => {
          const s1 = new Set(s0);
          if (s1.has(clairKey(o))) s1.delete(clairKey(o));
          else s1.add(clairKey(o));
          return s1;
        }),
        all: (on) => setSel(on ? new Set(rows.map(clairKey)) : new Set()),
        removeAgent: (o) => void give([o as ParcelRow], null),
      }
    : undefined;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [dlg, setDlg] = useState<CDialog>(null);
  const opened = rows.find((r) => parcelKey(r) === openKey) ?? null;
  // « Alerte suivante »: the most urgent alert, taken (15 minutes) by this agent (as before)
  const [focus, setFocus] = useState<{ id: number; x: Extra | null } | null>(null);
  const [nexting, setNexting] = useState(false);
  const skip = useRef<number[]>([]);
  const nextAlert = async () => {
    setNexting(true);
    try {
      const r = await rpc('suivi.next', { skip: skip.current.slice(-200), release: focus?.id ?? null });
      if (!r.id) {
        setFocus(null);
        toast(t('suivi.nextNone'), 'ok');
        return;
      }
      skip.current.push(r.id);
      setFocus({ id: r.id, x: (r.extra as Extra | null) ?? null });
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setNexting(false);
    }
  };
  const closeFocus = () => {
    if (focus) rpc('suivi.release', { id: focus.id }).catch(() => {});
    setFocus(null);
    skip.current = [];
  };
  const works = canFollow && treats;
  const h: ClairHandlers = {
    onOpen: (o) => {
      if (!working) return openOrder(o.id, o.seller?.id);
      setMenu(false);
      setOpenKey((k) => (k === parcelKey(o) ? null : parcelKey(o)));
    },
    onSwap: (o) => setDlg({ kind: 'swap', o }),
    canSwap: (o) => canHandle && !!o.swapWay && rightOn('act:suivi.swap'),
    canWork: () => works,
  };
  const pick = async (o: ParcelRow, k: StatusKey) => {
    if (k === 'no_answer' || k === 'busy') {
      try {
        await rpc('suivi.callResult', { id: o.id, result: k });
        toast(t(`suivi.clair.done.${k}`, { ref: o.ref }), 'ok');
        void qc.invalidateQueries();
      } catch (e: any) {
        toast(e?.message ?? String(e), 'bad');
      }
      return;
    }
    if (k === 'callback') return setDlg({ kind: 'rappel', o });
    if (k === 'claim') return setDlg({ kind: 'claim', o, toLivreur: extra[o.id]?.companyKind === 'own' });
    setDlg({ kind: 'fault', o });
  };
  // « Client annule »: the problems report first (who is responsible; no photo, the customer never had it), then Swap
  const cancelClient = (o: ParcelRow) =>
    rpc('suivi.act', { id: o.id, action: 'cancel', by: 'client' }).then(
      () => {
        toast(t('suivi.clair.done.cancel', { ref: o.ref }), 'ok');
        setOpenKey(null);
        void qc.invalidateQueries();
      },
      (e) => toast(e.message, 'bad'),
    );
  const menuFor = (o: ParcelRow) => <StatusMenu o={o} x={extra[o.id]} onPick={(k) => void pick(o, k)} onClose={() => setMenu(false)} />;
  const relivrer = (o: ParcelRow) => (works && o.followStatus === 'alert' ? () => setDlg({ kind: 'treat', o, start: 'resolved' }) : undefined);
  const claimOf = (o: ParcelRow) => (agency || !canHandle || !rightOn('act:suivi.claim') ? undefined : () => setDlg({ kind: 'claim', o, toLivreur: extra[o.id]?.companyKind === 'own' }));
  const title = t(`suivi.clair.tab.${tab}`);
  return (
    <div className="card">
      <div className={`card-head${showAssign ? ' px-ahead' : ''}`}>
        <h2>{title}</h2>
        {showAssign && <AssignSwitch value={assign} onChange={setAssign} counts={q.data?.assign} />}
        <span className="muted small">{q.data ? t('suivi.parcels', { count: q.data.total }) : ''}</span>
        {canFollow && working && !phone && !!rows.length && (
          <button type="button" className="btn primary sv-next" disabled={nexting} onClick={nextAlert}>
            {t('suivi.ph.next')} <Icon name="chevr" />
          </button>
        )}
      </div>
      {/* a phone: the counters first, under the title (seen without scrolling); a computer: as the design, under the filters */}
      {phone && <ClairCounters tab={tab} counts={q.data?.buckets} value={bucket} onPick={setBucket} />}
      <ClairFilters f={f} set={setFilter} phone={phone} />
      {!phone && <ClairCounters tab={tab} counts={q.data?.buckets} value={bucket} onPick={setBucket} />}
      {phone && showAssign && (picking || rows.length > 0) && (
        <div className="pxp-sum">
          <PickToggle
            on={picking}
            allOn={rows.length > 0 && rows.every((o) => sel.has(clairKey(o)))}
            onToggle={() => {
              setPicking((v) => !v);
              setSel(new Set());
            }}
            onAll={() => setSel(rows.every((o) => sel.has(clairKey(o))) ? new Set() : new Set(rows.map(clairKey)))}
          />
        </div>
      )}
      {!phone && showAssign && rows.length > 0 && <GiveBar rows={picked} agents={giveTo} onGive={(rs, id) => void give(rs as ParcelRow[], id)} onClear={() => setSel(new Set())} />}
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : phone ? (
        <ClairCards tab={tab} rows={rows} extra={extra} reasonOf={reasonOf} h={h} pick={pickOf} />
      ) : (
        <ClairTable
          tab={tab}
          rows={rows}
          extra={extra}
          reasonOf={reasonOf}
          openKey={openKey}
          h={h}
          pick={pickOf}
          open={(o) =>
            o.followStatus === 'alert' || extra[o.id]?.bucket === 'zr' ? (
              <AlertPanel
                o={o}
                x={extra[o.id]}
                reason={reasonOf(o, extra[o.id])}
                statusOpen={menu}
                onStatus={() => setMenu((v) => !v)}
                menu={works ? menuFor(o) : null}
                onRelivrer={relivrer(o)}
                onClaim={claimOf(o)}
              />
            ) : null
          }
        />
      )}
      {phone && picking && (
        <PickBar
          n={picked.length}
          options={giveTo.map((a) => ({ value: String(a.id), label: a.name }))}
          anyAgent={picked.some((o) => o.followAgentId)}
          onGive={(v) => give(picked, v ? Number(v) : null)}
        />
      )}
      {phone && canFollow && working && rows.length > 0 && !picking && (
        <button type="button" className="pxp-next" disabled={nexting} onClick={nextAlert}>
          {t('suivi.ph.next')}
          <Icon name="chevr" />
        </button>
      )}
      {q.data && <Pager page={page} pageSize={100} total={q.data.total} onPage={setPage} />}
      {/* the demo's carrier simulation: after the list (the counters and the lines come first) */}
      {!agency && <DemoCourier rows={rows} />}
      {phone && opened && working && (
        <ParcelPage
          o={opened}
          x={extra[opened.id]}
          reason={reasonOf(opened, extra[opened.id])}
          actions={[]}
          onClaim={claimOf(opened)}
          onClose={() => (setOpenKey(null), setMenu(false))}
          clair={
            works
              ? { statusLabel: t('suivi.clair.status'), menuOpen: menu, onStatus: () => setMenu((v) => !v), menu: menuFor(opened), onRelivrer: relivrer(opened), onHistory: () => setDlg({ kind: 'hist', o: opened }) }
              : { statusLabel: t('suivi.clair.status'), menuOpen: false, onStatus: () => {}, menu: null, onHistory: () => setDlg({ kind: 'hist', o: opened }) }
          }
        />
      )}
      {focus && (
        <FocusAlert
          kind="alert"
          id={focus.id}
          x={extra[focus.id] ?? focus.x}
          onLeft={nextAlert}
          onClose={closeFocus}
          actions={(o) => (treats ? [{ key: 'treat', label: t('suivi.ph.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o: o as ParcelRow }) }] : []) as ParcelAction[]}
          onClaim={agency || !rightOn('act:suivi.claim') ? undefined : (o) => setDlg({ kind: 'claim', o: o as ParcelRow, toLivreur: focus.x?.companyKind === 'own' })}
        />
      )}
      {dlg?.kind === 'treat' && (
        <Traiter o={dlg.o} reason={reasonOf(dlg.o, extra[dlg.o.id])} tries={extra[dlg.o.id]?.tries} own={extra[dlg.o.id]?.companyKind === 'own'} start={dlg.start} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'rappel' && <RappelSheet o={dlg.o} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'hist' && <HistorySheet o={dlg.o} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'fault' && (
        <FaultSheet
          orderId={dlg.o.id}
          moment="swap"
          cancel
          onClose={() => setDlg(null)}
          onDone={() => {
            const o = dlg.o;
            void cancelClient(o);
          }}
        />
      )}
      {dlg?.kind === 'swap' && <SwapModal o={dlg.o} onClose={() => setDlg(null)} onDone={(data) => setDlg({ kind: 'sheet', data: { ...data, fresh: true } })} />}
      {dlg?.kind === 'sheet' && <SwapSheetModal {...dlg.data} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'claim' && <NewClaimModal pre={dlg.o} toLivreur={dlg.toLivreur} reason="relivrer" details={reasonOf(dlg.o, extra[dlg.o.id]) ? t('suivi.rec.alertDetails', { v: reasonOf(dlg.o, extra[dlg.o.id]) }) : ''} onClose={() => setDlg(null)} />}
    </div>
  );
}

/** The parcel taken with « Alerte suivante », kept fresh; once it is no longer an alert (treated, cancelled…), the next one. */
function FocusAlert({ kind, id, x, actions, onClaim, onLeft, onClose }: { kind: 'alert' | 'stuck'; id: number; x: Extra | null; actions: (o: Order) => ParcelAction[]; onClaim?: (o: Order) => void; onLeft: () => void; onClose: () => void }) {
  const q = useRpc('orders.get', { id }, { refetchInterval: 20_000 });
  const o = q.data;
  const left = !!o && o.id === id && (kind === 'alert' ? o.followStatus !== 'alert' : !['shipped', 'out_for_delivery', 'failed', 'in_exchange'].includes(String(o.followStatus)));
  useEffect(() => {
    if (left) onLeft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, id]);
  if (!o || o.id !== id || left) return null;
  return <ParcelPage o={o} x={x ?? undefined} reason={reasonOf(o, x ?? undefined)} actions={actions(o)} onClaim={onClaim ? () => onClaim(o) : undefined} onClose={onClose} onSkip={onLeft} />;
}

/** On every alert, always: « Réclamation ». To the delivery company: by its API when it has one, otherwise the message
 *  to send. To our own livreur: written to him (his number shown to call too). A réclamation already sent since the
 *  alert is shown next to it, and another one can still be sent. */
function AlertClaim({ o, x, onClaim }: { o: Order; x?: Extra; onClaim: (toLivreur: boolean) => void }) {
  const { t } = useTranslation();
  if (!x) return null;
  const own = x.companyKind === 'own';
  if (!own && !o.companyId) return null;
  const sentAfterAlert = x.claim && x.claim.status !== 'resolved' && x.claim.sentAt && Date.parse(x.claim.createdAt) >= Date.parse(o.updatedAt) - 7 * 86_400_000;
  return (
    <span className="bjr-al">
      {own && x.livreurPhone && (
        <a className="bjr-call c" href={`tel:${x.livreurPhone}`}>
          <Icon name="phone" />
          <span>
            <b>{t('suivi.act.call')} </b>
            <span className="ltr">{x.livreurPhone}</span>
          </span>
        </a>
      )}
      {sentAfterAlert && (
        <span className="bjr-sentat">
          <span className="badge t-ok bjr-sent">{t('suivi.act.claimSent')}</span>
          <small className="muted">{when(x.claim!.sentAt)}</small>
        </span>
      )}
      {rightOn('act:suivi.claim') && (
        <button type="button" className="btn small bjr-recb" title={own ? t('suivi.act.write', { name: o.livreurName ?? '' }) : undefined} onClick={() => onClaim(own)}>
          <span className="bjr-ic">
            <Icon name={own ? 'message' : 'copy'} />
          </span>
          {t('suivi.act.claim')}
        </button>
      )}
    </span>
  );
}

/** « Swap » on a parcel the customer cancelled: with ZR while ZR takes a swap (« Commande annulée » or « Ne répond pas 3 »,
 *  before its return — ZR makes it by API in one click), with the others on a parcel coming back. */
function SwapButton({ o, onSwap }: { o: Order; onSwap: () => void }) {
  const { t } = useTranslation();
  if (!o.swapWay || !rightOn('act:suivi.swap')) return null;
  return (
    <button type="button" className="btn small primary nowrap" style={{ whiteSpace: 'nowrap' }} onClick={onSwap}>
      {t('suivi.act.swap')}
    </button>
  );
}

/** « Traiter » an alert (also used by a confirmation agency's « Suivi »). */
export function TreatModal({ o, reason, onClose }: { o: Order; reason: string | null; onClose: () => void }) {
  return <Traiter o={o} reason={reason} onClose={onClose} />;
}

/** Below the swap list: parcels already swapped, with « Copier pour ZR ». */
function SwappedList() {
  const { t } = useTranslation();
  const q = useRpc('suivi.list', { tab: 'swapped' });
  const [sheet, setSheet] = useState<SwapResult | null>(null);
  const extra = (q.data?.extra ?? {}) as Record<number, Extra>;
  if (!q.data?.rows.length) return null;
  const open = async (o: Order) => {
    try {
      setSheet(await rpc('suivi.swapTarget', { id: o.id }));
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('suivi.swapped')}</h2>
        <span className="muted small">{t('suivi.parcels', { count: q.data.rows.length })}</span>
      </div>
      <ParcelTable
        rows={q.data.rows}
        extra={extra}
        empty=""
        actions={(o) => (
          <button type="button" className="btn small" onClick={() => open(o)}>
            {extra[o.id]?.companyKind === 'zr' ? t('suivi.act.seeSwap') : t('suivi.act.copyFor', { who: extra[o.id]?.companyKind === 'own' ? t('suivi.theLivreur') : o.companyName || t('suivi.zr') })}
          </button>
        )}
      />
      {sheet && <SwapSheetModal {...sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
