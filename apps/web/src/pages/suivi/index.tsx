import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { when, wilayaName, syncProblems } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Icon, Loading, Pager, RemovableChip, StatusBadge } from '../../ui/kit';
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
import { HistoryButton, PhoneCell } from '../confirmation/History';
import { RotateChip } from '../confirmation/Countdown';
import { store } from '../../lib/store';
import { CopyCode } from '../../ui/CopyCode';
import { useIsPhone } from '../../lib/useMedia';
import { useViewMode, ViewSwitch } from '../../ui/ViewSwitch';
import { AlertClock, AlertTries, CancelSheet, ClockChip, TriesChip, ParcelAction, ParcelCards, ParcelPage, MotifChip } from './PhoneSuivi';
import { Traiter } from './Traiter';
import { StuckChips, StuckDialog, type StuckInfo } from './Stuck';
import { ScoreChip } from '../../ui/clientScore';
import { AgentFilter, ClearFilters, CompanyFilter, DateFilters, dayIso, LivreurFilter, ProductFilter, WilayaFilter } from '../../ui/filters';
import { useDebounced } from '../depot/OrderList';
import type { In } from '../../lib/backend';
import { useAllMode } from '../../layout/AllBoutiques';

const LIST_TABS = ['enlivraison', 'alertes', 'alertes_new', 'alertes_encours', 'traites', 'bloques', 'livres', 'annules', 'swap'] as const;
/** the alert lists: all of them, the new ones (nobody acted yet), the ones in progress */
/** in a confirmation agency's space (its agents, its chief) */
const useInAgency = () => {
  const s = useSession().session;
  return s?.shop?.kind === 'agency' || !!s?.profile.agencyId;
};
const isAlertTab = (tab: string) => tab === 'alertes' || tab === 'alertes_new' || tab === 'alertes_encours';
type ListTab = (typeof LIST_TABS)[number];
type Sub = ListTab | 'reclamation';

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
const AllSuiviPage = lazy(() => import('../boutiques/all').then((m) => ({ default: m.BoutiquesSuivi })));

function SuiviOne({ sub }: PageProps) {
  const agency = useInAgency();
  const { has } = useSession();
  // the claims with couriers and the swaps: the store's suivi agents and the agencies (on their own orders)
  const tabs: readonly string[] = !has('suivi') && !agency ? LIST_TABS.filter((k) => k !== 'swap') : [...LIST_TABS, 'reclamation'];
  const asked: Sub = tabs.includes(sub ?? '') ? (sub as Sub) : 'enlivraison';
  // an agency's confirmation agent (no suivi): En livraison, Livré, Annulé — to watch its orders move (no alert, claim, swap)
  const tab: Sub = agency && !has('suivi') && !['enlivraison', 'livres', 'annules'].includes(asked) ? 'enlivraison' : asked;
  return (
    <>
      <SuiviBar tab={tab} />
      {tab === 'reclamation' ? (
        <Reclamation />
      ) : (
        <>
          <Head tab={tab} />
          <List key={tab} tab={tab} />
          {tab === 'swap' && <SwappedList />}
        </>
      )}
    </>
  );
}

/** "Alertes › Traités | Annulés  Réclamation  Swap" — same markup as the original stage bar. */
function SuiviBar({ tab }: { tab: Sub }) {
  const { t } = useTranslation();
  const agency = useInAgency();
  const { has } = useSession();
  const c = useRpc('suivi.counts', {}, { refetchInterval: 60_000 }).data;
  // a phone shows a few steps at a time: the current one is brought into view
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bar.current;
    const on = el?.querySelector<HTMLElement>('.bjm-p.on');
    if (!el || !on || el.scrollWidth <= el.clientWidth + 1) return;
    const r = el.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    if (b.left >= r.left + 8 && b.right <= r.right - 8) return;
    el.scrollBy({ left: b.left + b.width / 2 - (r.left + r.width / 2) });
  }, [tab]);
  const item = (k: Sub, count?: number, x = false) => (
    <a className={`bjm-p ${tab === k ? 'on' : ''} ${x ? 'x' : ''}`} href={`#/suivi/${k}`} data-k={k} aria-current={tab === k ? 'page' : undefined}>
      <span className="bjm-l">{t(agency && k === 'traites' ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${k}`)}</span>
      {count !== undefined && <b className="bjm-n ltr">{count}</b>}
    </a>
  );
  // a confirmation agency: the tabs of the step chosen in its menu (En livraison · Alertes · Livré · Annulé)
  if (agency) {
    const step = ['alertes', 'alertes_new', 'alertes_encours', 'traites', 'reclamation'].includes(tab) ? 'alert' : tab === 'bloques' || tab === 'enlivraison' ? 'road' : tab;
    return (
      <nav ref={bar} className="bjm-bar flow" aria-label="Étapes" data-g="suivi">
        {step === 'alert' ? (
          <>
            {item('alertes_new', c?.alertes_new ?? 0)}
            <span className="bjm-ar" aria-hidden="true">›</span>
            {item('alertes_encours', c?.alertes_encours ?? 0)}
            <span className="bjm-ar" aria-hidden="true">›</span>
            {item('traites', c?.traites ?? 0)}

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

          </>
        ) : (
          item(tab, c?.livres ?? 0)
        )}
        {has('suivi') && <span className="bjm-sep" aria-hidden="true" />}
        {has('suivi') && item('reclamation', c?.claims, true)}
        {has('suivi') && item('swap', c?.swap ?? 0, true)}
      </nav>
    );
  }
  return (
    <nav ref={bar} className="bjm-bar flow" aria-label="Étapes" data-g="suivi">
      {item('enlivraison', c?.enlivraison ?? 0)}
      <span className="bjm-ar" aria-hidden="true">
        ›
      </span>
      {item('alertes', c?.alertes ?? 0)}
      <span className="bjm-ar" aria-hidden="true">
        ›
      </span>
      {item('traites', c?.traites ?? 0)}
      <span className="bjm-sep" aria-hidden="true" />
      {item('bloques', c?.bloquesTodo ?? 0, true)}
      {item('annules', c?.annules ?? 0, true)}
      {!agency && has('suivi') && item('reclamation', undefined, true)}
      {!agency && has('suivi') && item('swap', c?.swap ?? 0, true)}
    </nav>
  );
}

function Head({ tab }: { tab: ListTab }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const agency = useInAgency();
  const { has } = useSession();
  const c = useRpc('suivi.counts', {}).data;
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
        {!agency && has('suivi') && (
          <button className="btn" onClick={sync} disabled={busy}>
            <Icon name="refresh" /> {t('suivi.sync')}
          </button>
        )}
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

/** The table shared by every Suivi list, with the column menu and the shared presets. */
export function ParcelTable({ rows, actions, empty, extra = {} }: { rows: Order[]; actions?: (o: Order) => ReactNode; empty: string; extra?: Record<number, Extra> }) {
  const { t } = useTranslation();
  const { has } = useSession();
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
  const cols = order.filter((k) => visible.has(k));
  const drag = colDrag(order, setOrder);
  // column widths: each user's own
  const wkeys: string[] = [...cols, ...(actions ? ['_act'] : [])];
  const [dens, setDens] = useDensity();
  const rs = useResizable(tc.widths, tc.setWidths, t('common.resizeCol'), wkeys, dens);
  const cell = (o: Order, k: SCol): ReactNode => {
    switch (k) {
      case 'order':
        return (
          <>
            <b className="ltr">{o.ref}</b>
            <small>{when(o.createdAt)}</small>
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
              {reasonOf(o, extra[o.id]) ? ` · ${reasonOf(o, extra[o.id])}` : ''}
            </small>
          </>
        );
      case 'agent':
        return <RemovableChip name={o.agentName} />;
      case 'fagent':
        return <RemovableChip name={o.followAgentName} removeLabel={t('suivi.removeAgent')} disabled={unFollow.isPending} onRemove={has('suivi') ? () => unFollow.mutate({ id: o.id }) : undefined} />;
      case 'since': {
        const d = daysSince(o.shippedAt);
        return (
          <>
            {d === null ? '—' : <span className={`badge ${d >= 10 ? 't-bad' : d >= 5 ? 't-warn' : 't-info'} ltr`}>{t('suivi.days', { n: d })}</span>}
            {extra[o.id]?.clock && <ClockChip c={extra[o.id]!.clock} />}
            {extra[o.id]?.tries && <TriesChip tr={extra[o.id]!.tries} />}
            {o.followStatus === 'alert' && <RotateChip at={extra[o.id]?.rotateAt} />}
            {extra[o.id]?.stuck && <StuckChips s={extra[o.id]!.stuck} />}
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
            <StatusBadge kind="follow" status={o.followStatus} />
            {extra[o.id]?.motif && <MotifChip m={extra[o.id]!.motif} />}
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
          onPreset={tc.applyPreset}
          locked={tc.locked}
          widthsSet={Object.keys(tc.widths).length > 0}
          onResetWidths={tc.resetWidths}
          open={menu}
          onToggle={() => setMenu((v) => !v)}
        />
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
                <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Dialog =
  | { kind: 'treat'; o: Order }
  | { kind: 'cancel'; o: Order }
  | { kind: 'swap'; o: Order }
  | { kind: 'claim'; o: Order; toLivreur: boolean }
  | { kind: 'sheet'; data: SwapResult & { fresh?: boolean } }
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
function SuiviFilters({ f, set }: { f: SuiviF; set: (patch: Partial<SuiviF>) => void }) {
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
      {boss && <AgentFilter kind="follow" value={f.fagent} onChange={(v) => set({ fagent: v })} />}
      <ProductFilter product={f.product} variant={f.variant} onChange={(v) => set(v)} />
      <CompanyFilter value={f.company} onChange={(v) => set({ company: v })} />
      <LivreurFilter value={f.livreur} onChange={(v) => set({ livreur: v })} />
      <WilayaFilter value={f.wilaya} onChange={(v) => set({ wilaya: v })} />
      <DateFilters from={f.from} to={f.to} onChange={(v) => set(v)} />
      <ClearFilters on={on > 0} onClear={() => set({ ...NO_SF, q: f.q })} />
    </div>
  );
}

function List({ tab }: { tab: ListTab }) {
  const { t } = useTranslation();
  const agency = useInAgency();
  const { has } = useSession();
  const canFollow = has('suivi');
  const [page, setPage] = useState(1);
  const [f, setF] = useState<SuiviF>(() => ({ ...NO_SF, ...store.json<Partial<SuiviF>>('suivi-f', {}), q: '' }));
  const setFilter = (patch: Partial<SuiviF>) => {
    setF((x) => {
      const nx = { ...x, ...patch };
      const { q: _q, ...keep } = nx;
      store.set('suivi-f', JSON.stringify(keep));
      return nx;
    });
    setPage(1);
  };
  const dq = useDebounced(f.q);
  const q = useRpc('suivi.list', { tab, page, pageSize: 100, ...suiviInput(f, dq) });
  const [dlg, setDlg] = useState<Dialog>(null);
  const act = useAction('suivi.act');
  // phones: journey cards; a tap opens the parcel full screen. Computers: the same cards, the parcel in a side panel
  // (« Tableau » goes back to the table)
  const phone = useIsPhone();
  const [mode, setMode] = useViewMode('suivi');
  const cards = phone || mode === 'cards';
  const [openId, setOpenId] = useState<number | null>(null);
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
  const run = (o: Order, action: 'cancel' | 'delivered' | 'realert') =>
    act.mutate({ id: o.id, action }, { onSuccess: () => toast(t(`suivi.msg.${action === 'cancel' ? 'cancelled' : action}`, { ref: o.ref }), 'ok') });

  const extra = (q.data?.extra ?? {}) as Record<number, Extra>;
  let actions: ((o: Order) => ReactNode) | undefined;
  if (isAlertTab(tab))
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        {!agency && <AlertClaim o={o} x={extra[o.id]} onClaim={(toLivreur) => setDlg({ kind: 'claim', o, toLivreur })} />}
        <button type="button" className="btn small primary" onClick={() => setDlg({ kind: 'treat', o })}>
          {t('suivi.act.treat')}
        </button>
      </div>
    );
  if (tab === 'enlivraison')
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        {o.followStatus === 'alert' ? <button type="button" className="btn small primary" onClick={() => setDlg({ kind: 'treat', o })}>{t('suivi.act.treat')}</button> :
          <button type="button" className="btn small" disabled={act.isPending} onClick={() => run(o, 'realert')}><Icon name="alert" /> {t('suivi.act.toAlert')}</button>}
      </div>
    );
  if (tab === 'bloques')
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
  if (tab === 'swap')
    actions = (o) => (
      <button type="button" className="btn small primary nowrap" style={{ whiteSpace: 'nowrap' }} onClick={() => setDlg({ kind: 'swap', o })}>
        {t('suivi.act.swap')}
      </button>
    );
  // Annulés: a parcel the customer cancelled, on its way back, can always be swapped from here too
  if (tab === 'annules') actions = (o) => <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} />;
  // the same buttons on the cards (Réclamation on each alert, Swap on a parcel coming back), without opening them
  const cardAct = (o: Order): ReactNode => {
    if (!canFollow) return null;
    if (isAlertTab(tab)) return agency ? null : <AlertClaim o={o} x={extra[o.id]} onClaim={(toLivreur) => setDlg({ kind: 'claim', o, toLivreur })} />;
    if (tab === 'annules') return o.followStatus === 'returning' ? <SwapButton o={o} onSwap={() => setDlg({ kind: 'swap', o })} /> : null;
    return null;
  };

  return (
    <div className={`card${cards && !phone ? ' px-wide' : ''}`}>
      <div className="card-head">
        <h2>{tab === 'swap' ? t('suivi.toSwap') : t(`suivi.tabs.${tab}`)}</h2>
        <span className="muted small">{q.data ? t('suivi.parcels', { count: q.data.rows.length }) : ''}</span>
        {canFollow && (isAlertTab(tab) || tab === 'bloques') && !cards && !!q.data?.rows.length && (
          <button type="button" className="btn primary sv-next" disabled={nexting} onClick={nextAlert}>
            {tab === 'bloques' ? t('suivi.stuck.next') : t('suivi.ph.next')} <Icon name="chevr" />
          </button>
        )}
        {!phone && <ViewSwitch mode={mode} onChange={setMode} />}
      </div>
      <SuiviFilters f={f} set={setFilter} />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : cards ? (
        (() => {
          const rows = q.data?.rows ?? [];
          const cur = rows.find((r) => r.id === openId) ?? null;
          const phoneActions = (o: Order): ParcelAction[] => {
            if (!canFollow) return [];
            const claim: ParcelAction = { key: 'claim', label: t('suivi.ph.claimBtn'), run: () => setDlg({ kind: 'claim', o, toLivreur: extra[o.id]?.companyKind === 'own' }) };
            if (tab === 'enlivraison') return [o.followStatus === 'alert'
              ? { key: 'treat', label: t('suivi.act.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o }) }
              : { key: 'realert', label: t('suivi.act.toAlert'), run: () => run(o, 'realert') }];
            if (isAlertTab(tab))
              return [{ key: 'treat', label: t('suivi.ph.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o }) }, ...(!agency ? [claim] : [])];
            if (tab === 'traites')
              return [
                { key: 'deliv', label: t('suivi.ph.deliv'), tone: 'ok', run: () => run(o, 'delivered') },
                claim,
                { key: 'realert', label: t('suivi.ph.realert'), run: () => run(o, 'realert') },
                { key: 'cancelled', label: t('suivi.ph.cancelled'), tone: 'bad', run: () => run(o, 'cancel') },
              ];
            if (tab === 'bloques') return [{ key: 'stuck', label: t('suivi.stuck.btn'), tone: 'main', run: () => setDlg({ kind: 'stuck', o }) }, claim];
            if (tab === 'swap') return [{ key: 'swap', label: t('suivi.act.swap'), tone: 'main', run: () => setDlg({ kind: 'swap', o }) }, claim];
            if (tab === 'annules' && o.followStatus === 'returning') return [{ key: 'swap', label: t('suivi.act.swap'), tone: 'main', run: () => setDlg({ kind: 'swap', o }) }, ...(!agency ? [claim] : [])];
            return agency ? [] : [claim];
          };
          return (
            <>
              <ParcelCards rows={rows} extra={extra} reasonOf={reasonOf} empty={t(`suivi.empty.${tab}`)} onOpen={setOpenId} act={cardAct} />
              {canFollow && (isAlertTab(tab) || tab === 'bloques') && rows.length > 0 && (
                <button type="button" className="pxp-next" disabled={nexting} onClick={nextAlert}>
                  {tab === 'bloques' ? t('suivi.stuck.next') : t('suivi.ph.next')}
                  <Icon name="chevr" />
                </button>
              )}
              {cur && (
                <ParcelPage
                  o={cur}
                  x={extra[cur.id]}
                  reason={reasonOf(cur, extra[cur.id])}
                  actions={phoneActions(cur)}
                  onClaim={agency || !canFollow ? undefined : () => setDlg({ kind: 'claim', o: cur, toLivreur: extra[cur.id]?.companyKind === 'own' })}
                  onClose={() => setOpenId(null)}
                />
              )}
            </>
          );
        })()
      ) : (
        <ParcelTable rows={q.data?.rows ?? []} extra={extra} actions={canFollow ? actions : undefined} empty={t(`suivi.empty.${tab}`)} />
      )}
      {q.data && <Pager page={page} pageSize={100} total={q.data.total} onPage={setPage} />}
      {focus && (
        <FocusAlert
          kind={focus.kind}
          id={focus.id}
          x={extra[focus.id] ?? focus.x}
          onLeft={nextAlert}
          onClose={closeFocus}
          actions={(o) => [
            focus.kind === 'stuck'
              ? { key: 'stuck', label: t('suivi.stuck.btn'), tone: 'main', run: () => setDlg({ kind: 'stuck', o }) }
              : { key: 'treat', label: t('suivi.ph.treat'), tone: 'main', run: () => setDlg({ kind: 'treat', o }) },
            { key: 'claim', label: t('suivi.ph.claimBtn'), run: () => setDlg({ kind: 'claim', o, toLivreur: focus.x?.companyKind === 'own' }) },
          ]}
          onClaim={agency ? undefined : (o) => setDlg({ kind: 'claim', o, toLivreur: focus.x?.companyKind === 'own' })}
        />
      )}
      {dlg?.kind === 'stuck' && (
        <StuckDialog
          o={dlg.o}
          s={extra[dlg.o.id]?.stuck ?? (focus?.id === dlg.o.id ? focus.x?.stuck : null)}
          own={(extra[dlg.o.id] ?? (focus?.id === dlg.o.id ? focus.x : null))?.companyKind === 'own'}
          onClose={() => setDlg(null)}
          onDone={() => (focus?.id === dlg.o.id ? void nextAlert() : undefined)}
        />
      )}
      {dlg?.kind === 'treat' && (
        <Traiter
          o={dlg.o}
          reason={reasonOf(dlg.o, extra[dlg.o.id] ?? (focus?.id === dlg.o.id ? focus.x ?? undefined : undefined))}
          tries={extra[dlg.o.id]?.tries ?? (focus?.id === dlg.o.id ? focus.x?.tries : null)}
          own={(extra[dlg.o.id] ?? (focus?.id === dlg.o.id ? focus.x : null))?.companyKind === 'own'}
          onClose={() => setDlg(null)}
        />
      )}
      {dlg?.kind === 'cancel' && (
        <CancelSheet
          o={dlg.o}
          tries={dlg.o.followStatus === 'alert' ? extra[dlg.o.id]?.tries ?? (focus?.id === dlg.o.id ? focus.x?.tries : null) : null}
          busy={act.isPending}
          onClose={() => setDlg(null)}
          onOk={(by, note) => {
            act.mutate({ id: dlg.o.id, action: 'cancel', by, note: note ?? null }, { onSuccess: () => toast(t('suivi.msg.cancelled', { ref: dlg.o.ref }), 'ok') });
            setDlg(null);
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
      <button type="button" className="btn small bjr-recb" title={own ? t('suivi.act.write', { name: o.livreurName ?? '' }) : undefined} onClick={() => onClaim(own)}>
        <span className="bjr-ic">
          <Icon name={own ? 'message' : 'copy'} />
        </span>
        {t('suivi.act.claim')}
      </button>
    </span>
  );
}

/** On a parcel the customer cancelled, on its way back: « Swap », always (to another customer; through the delivery
 *  company's API when it has one, the swap window says what is possible). */
function SwapButton({ o, onSwap }: { o: Order; onSwap: () => void }) {
  const { t } = useTranslation();
  if (o.followStatus !== 'returning') return null;
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
            {t('suivi.act.copyFor', { who: extra[o.id]?.companyKind === 'own' ? t('suivi.theLivreur') : t('suivi.zr') })}
          </button>
        )}
      />
      {sheet && <SwapSheetModal {...sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
