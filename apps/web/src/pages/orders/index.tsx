// Commandes (all orders, Livré, Annulé) and the hidden Livrées / Retournées pages — as in the original app.
import { canSetFollow, cmOnly, CONF_DONE_BAD, CONF_STATUSES, CONF_TODO, FOLLOW_ON_ROAD, FOLLOW_STATUSES, FollowStatus, isLookupCode, LOOKUP_DIGITS, lookupDigits, Order, SALES_CHANNELS, WILAYAS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, n, pct, syncProblems } from '../../lib/format';
import { openOrder, openOrderForm } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useScope } from '../../lib/seller';
import { seesAll, useInAgency, useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { Card, ErrorBox, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { toastUndo } from '../../lib/undo';
import type { PageProps } from '../registry';
import { API_KINDS, callOptional } from './OrderCard';
import { ExtraColumn, OrderColumn, OrderSort, OrderTable } from './OrderTable';
import { ConfFilter, exportOrdersCsv, FollowFilter, ListFilter, printSlips, toListInput } from './shared';
import './orders.css';
import { useCounts } from './counts';
import { useSwap } from './swapAction';
import { useIsPhone } from '../../lib/useMedia';
import { useViewMode, ViewSwitch } from '../../ui/ViewSwitch';
import { AgentFilter, CashedFilter, ClearFilters, DateFilters, LivreurFilter, ProductFilter, ReasonFilter, TeamFilter } from '../../ui/filters';
import { PhoneAnnule, PhoneLivre } from './PhoneDone';
import { useAllMode } from '../../layout/AllBoutiques';
import { rightOn } from '../../lib/rights';
import { type ConfStage, ConfirmedStages, StageTag } from '../confirmation/stages';

export { OrderTable } from './OrderTable';
export type { OrderColumn, ExtraColumn, OrderTableProps } from './OrderTable';

/** The "Commandes" card with its 5 KPI tabs (Confirmation, Dépôt, Suivi, Livré, Annulé). */
function HeaderKpis({ on }: { on?: 'livrees' | 'annulees' }) {
  const { t } = useTranslation();
  const c = useCounts();
  const agency = useInAgency();
  const { session } = useSession();
  // the Community manager has no Dépôt or Suivi: her own Confirmées and En livraison
  const cm = !!session && !session.isAdmin && cmOnly(session.profile.roles);
  const k = (key: string, href: string, label: string, v: number | undefined, s: string, tone?: string) => (
    <a key={key} className={`kpi${tone ? ` t-${tone}` : ''}${v === 0 ? ' px-zero' : ''}${on === key ? ' bjsv-on' : ''}`} href={href}>
      <span className="l">{label}</span>
      <span className="v ltr">{v === undefined ? '…' : n(v)}</span>
      <span className="s">{s}</span>
    </a>
  );
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('orders.title')}</h2>
      </div>
      <div className="kpis bjcm-k">
        {k('confirmation', '#/confirmation', t('orders.kpi.confirmation'), c?.todo, t('orders.kpi.confirmationS'), 'warn')}
        {/* a confirmation agency has no Dépôt (the seller's); its Suivi starts with the parcels on the road */}
        {!agency && k('depot', cm ? '#/commandes/confirmees' : '#/depot', t('orders.kpi.depot'), c?.depot, t('orders.kpi.depotS'))}
        {k('suivi', cm ? '#/commandes/enroute' : agency ? '#/suivi/enlivraison' : '#/suivi', t('orders.kpi.suivi'), c?.suivi, t('orders.kpi.suiviS'))}
        {k('livrees', '#/commandes/livrees', t('orders.kpi.livre'), c?.delivered, t('orders.kpi.livreS', { pct: pct(c ? c.delivered / Math.max(1, c.all) : null) }), 'ok')}
        {k('annulees', '#/commandes/annulees', t('orders.kpi.annule'), c ? c.cancelledConf + c.back : undefined, t('orders.kpi.annuleS', { conf: c?.cancelledConf ?? 0, ret: c?.back ?? 0 }), 'bad')}
      </div>
      <p className="muted small">{t('orders.kpi.help')}</p>
    </div>
  );
}

/** Big search ("Service réclamation"). */
function BigSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="card bjf">
      <div className="bjf-row">
        <span className="bjf-ic" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input type="search" className="bjf-in" placeholder={t('orders.find.placeholder')} aria-label={t('orders.find.label')} autoComplete="off" enterKeyHint="search" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
      <p className="muted small bjf-info">{t('orders.find.info')}</p>
    </div>
  );
}


/**
 * « Tous » for everyone but the seller and the admins (the owner's rule, 25 Nov 2026): no list and no numbers; at least
 * 5 digits of a phone, or a whole reference or tracking code typed exactly (PX1374, 43-PCLONZDMHK-ZR), searches — a name
 * never does (shared lookup.ts): an agent his own orders, a manager his team's, the dépôt every order, whatever their
 * status or date. The same in Suivi › Réclamation › Recherche and « Toutes les boutiques » (`results`: the list of the
 * found orders there).
 */
export function LookupOnly({ actions, title, results, initial }: { actions?: ReactNode; title?: ReactNode; results?: (q: string) => ReactNode; initial?: string }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const [q, setQ] = useState(initial ?? '');
  const digits = lookupDigits(q);
  // a whole reference or tracking code opens it too: the shop's references have 4 digits, ZR's codes 2 (owner's choice
  // « A », 25 Nov 2026; the server finds it only typed exactly)
  const code = digits < LOOKUP_DIGITS && isLookupCode(q);
  const ready = digits >= LOOKUP_DIGITS || code;
  const roles = session?.roles ?? [];
  // what the search reaches (the server's listScopeSql): the dépôt every order, a manager his team's, the others their own
  const reach = roles.includes('depot') ? 'wide' : roles.includes('agent_manager') || session?.profile.agencyLead ? 'team' : 'mine';
  return (
    <>
      <Card title={title ?? t('orders.allOrders')} actions={actions} className="bjf px-lk">
        <div className="bjf-row">
          <span className="bjf-ic" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input type="search" className="bjf-in" placeholder={t('orders.lookup.placeholder')} aria-label={t('orders.lookup.label')} autoComplete="off" enterKeyHint="search" inputMode="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className={`px-lk-meter${ready ? ' ok' : ''}`} aria-live="polite">
          <span className="px-lk-dots" aria-hidden="true">
            {Array.from({ length: LOOKUP_DIGITS }, (_, i) => (
              <i key={i} className={i < digits || code ? 'on' : undefined} />
            ))}
          </span>
          <b>{code ? t('orders.lookup.okCode') : ready ? t('orders.lookup.ok') : t('orders.lookup.more', { count: LOOKUP_DIGITS - digits })}</b>
        </div>
        <p className="muted small bjf-info">
          {t('orders.lookup.info')} {t(`orders.lookup.${reach}`)}
        </p>
      </Card>
      {ready ? (
        results ? (
          results(q.trim())
        ) : (
          <OrderList id="tout-lookup" title={t('orders.lookup.results')} q={q.trim()} show={[]} />
        )
      ) : (
        <div className="card px-lk-hidden">
          <span className="px-lk-lock" aria-hidden="true">
            <Icon name="lock" />
          </span>
          <b>{t('orders.lookup.hidden')}</b>
          <span className="muted small">{t('orders.lookup.hiddenS')}</span>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- the generic filtered list
type FilterKey = 'search' | 'conf' | 'follow' | 'company' | 'wilaya' | 'channel' | 'agent' | 'team' | 'product' | 'livreur' | 'cashed' | 'reason' | 'dates';
interface Filters {
  conf: ConfFilter;
  follow: FollowFilter;
  company: string;
  wilaya: string;
  channel: string;
  agent: string;
  team: string;
  product: string;
  variant: string;
  livreur: string;
  cashed: string;
  reason: string;
  from: string;
  to: string;
  q: string;
}
const NO_FILTERS: Filters = { conf: '', follow: '', company: '', wilaya: '', channel: '', agent: '', team: '', product: '', variant: '', livreur: '', cashed: '', reason: '', from: '', to: '', q: '' };

interface ListProps {
  id: string;
  title: ReactNode;
  headActions?: ReactNode;
  /** fixed part of the query (e.g. only delivered orders) */
  base?: Partial<ListFilter>;
  show?: FilterKey[];
  /** whose reason the « Motif » filter is: cancelled at the confirmation, or sent back */
  reasonOf?: 'conf' | 'back';
  /** search text coming from the big search above */
  q?: string;
  tabs?: { value: string; label: string; count?: number; filter: Partial<ListFilter> }[];
  columns?: OrderColumn[];
  extra?: (rows: Order[]) => ExtraColumn[];
  defaultSort?: OrderSort;
  pageSize?: number;
}

const ALL_FILTERS: FilterKey[] = ['search', 'conf', 'follow', 'company', 'wilaya', 'channel', 'agent', 'team', 'product', 'livreur', 'dates'];

/** The seller of an order of a list over every seller (an agency's « Tous les vendeurs »), and its column (first). */
const sellerOf = (o: Order) => (o as { seller?: { id: number; name: string } }).seller;
const sellerColumn = (label: string): ExtraColumn => ({ key: 'seller', label, cell: (o) => <b>{sellerOf(o)?.name ?? '—'}</b> });

/** The filters whose choices are one shop's own (its companies, people, products): not with every seller together. */
const ONE_SHOP_FILTERS: FilterKey[] = ['company', 'agent', 'team', 'product', 'livreur'];

export function OrderList(p: ListProps) {
  const { t } = useTranslation();
  const { has, session } = useSession();
  const qc = useQueryClient();
  // an agency's « Tous les vendeurs »: every seller's orders in one list, each opened inside its store
  const together = useScope() === 'all';
  const show = (p.show ?? ALL_FILTERS).filter((k) => !together || !ONE_SHOP_FILTERS.includes(k));
  const [f, setF] = useState<Filters>(() => ({ ...NO_FILTERS, ...store.json<Partial<Filters>>(`orders-f-${p.id}`, {}), q: '' }));
  const [tab, setTab] = useState(p.tabs?.[0]?.value ?? '');
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(p.pageSize ?? 50);
  const [sort, setSort] = useState<OrderSort>(p.defaultSort ?? 'created_at');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Filters>) => {
    setF((x) => {
      const nx = { ...x, ...patch };
      const { q: _q, ...keep } = nx;
      store.set(`orders-f-${p.id}`, JSON.stringify(keep));
      return nx;
    });
    setPage(1);
  };
  useEffect(() => setPage(1), [p.q, tab]);

  const look = useRpc('orders.lookups', {}, { staleTime: 5 * 60_000, enabled: !together });
  const companies = look.data?.companies ?? [];
  const tabFilter = p.tabs?.find((x) => x.value === tab)?.filter ?? {};
  const q = (p.q ?? '').trim() || f.q.trim();
  // only the filters this list shows (one kept from another visit, now hidden, does not narrow it)
  const shown: Partial<Filters> = Object.fromEntries(
    (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter((k) => k === 'q' || show.includes(k === 'variant' ? 'product' : k === 'from' || k === 'to' ? 'dates' : (k as FilterKey))).map((k) => [k, f[k]]),
  );
  const input: ListFilter = { ...toListInput({ ...shown, q }, p.reasonOf), ...p.base, ...tabFilter, sort, dir, page, pageSize: size } as ListFilter;
  const anyOn = (Object.keys(shown) as (keyof Filters)[]).some((k) => k !== 'q' && !!shown[k]);
  // a search finds every order, whatever its status (like the original)
  if (q && p.q) {
    delete (input as any).conf;
    delete (input as any).follow;
  }
  const list = useRpc('orders.list', input);
  const rows = list.data?.rows;
  const resetKey = JSON.stringify({ ...input, page: 0 });
  const extra = p.extra && rows ? p.extra(rows) : [];

  const followChoices = (FOLLOW_STATUSES as readonly FollowStatus[]).filter((s) => canSetFollow(session!.roles, s));
  const doAll = async (fn: () => Promise<unknown>, ok?: string, clear?: () => void) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      clear?.();
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const bulk = (ids: number[], sel: Order[], clear: () => void) => (
    <>
      {has('depot', 'suivi', 'confirmation') && (
        <select
          aria-label={t('orders.bulk.company')}
          value=""
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            doAll(() => rpc('orders.assignCompany', { ids, companyId: v === 'none' ? null : Number(v) }), t('orders.bulk.assigned', { count: ids.length }), clear);
          }}
        >
          <option value="">{t('orders.bulk.company')}</option>
          {companies
            .filter((c) => c.active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      )}
      {followChoices.length > 0 && (
        <select
          aria-label={t('orders.bulk.follow')}
          value=""
          disabled={busy}
          onChange={(e) => {
            const s = e.target.value as FollowStatus;
            if (!s) return;
            doAll(async () => {
              const r = await rpc('orders.setFollow', { ids, status: s });
              toastUndo(t('orders.bulk.changed', { count: r.changed.length }), r.changed, () => qc.invalidateQueries());
            }, undefined, clear);
          }}
        >
          <option value="">{t('orders.bulk.follow')}</option>
          {followChoices.map((s) => (
            <option key={s} value={s}>
              {t(`status.follow.${s}`)}
            </option>
          ))}
        </select>
      )}
      {has('depot', 'suivi') && (
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await callOptional('delivery.send', { ids });
            setBusy(false);
            if (!r.ok) return toast(t('orders.bulk.unavailable', { msg: r.error }), 'bad');
            const res = (r.data?.results ?? []) as { ok: boolean; ref?: string; error?: string }[];
            const good = res.filter((x) => x.ok).length;
            const bad = res.filter((x) => !x.ok);
            if (good) toast(t('orders.bulk.sent', { count: good }), 'ok');
            if (bad.length) toast(`${t('orders.bulk.notSent', { count: bad.length })} : ${bad.map((x) => `${x.ref ?? ''} ${x.error ?? ''}`).join(' · ')}`, 'bad', 8000);
            clear();
            qc.invalidateQueries();
          }}
        >
          {t('orders.bulk.send')}
        </button>
      )}
      <button
        className="btn small"
        onClick={() =>
          printSlips(
            t,
            sel.map((o) => ({ ...o, companyKind: companies.find((c) => c.id === o.companyId)?.kind ?? null })),
            look.data ? { name: look.data.shopName, logo: look.data.logo } : undefined,
          )
        }
      >
        {t('orders.bulk.print')}
      </button>
      {/* export: the seller and the admins only (owner, 25 Nov 2026) */}
      {rightOn('act:orders.export') && seesAll(session) && (
        <button className="btn small" onClick={() => exportOrdersCsv(t, sel)}>
          {t('orders.bulk.export')}
        </button>
      )}
    </>
  );

  const sel = (key: keyof Filters, label: string, options: [string, string][], all = t('orders.f.all')) => (
    <label className="field more-f" key={key}>
      <span className="lab">{label}</span>
      <select value={f[key]} onChange={(e) => set({ [key]: e.target.value } as Partial<Filters>)}>
        <option value="">{all}</option>
        {options.map(([v, l], i) => (
          <option key={`${v}-${i}`} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  const confOpts: [string, string][] = [
    ['todo', t('orders.f.todo')],
    // (« Occupé » and « À rappeler » are actions since 25 Nov 2026: those orders are a « Tentative »)
    ...CONF_STATUSES.filter((s) => s !== 'busy' && s !== 'callback').map((s): [string, string] => [s, s === 'no_answer' ? t('orders.f.attempt') : t(`status.conf.${s}`)]),
  ];
  const followOpts: [string, string][] = [['prep', t('orders.f.prep')], ['active', t('orders.f.active')], ['back', t('orders.f.back')], ...FOLLOW_STATUSES.map((s): [string, string] => [s, t(`status.follow.${s}`)])];

  return (
    <Card title={p.title} actions={p.headActions}>
      {p.tabs && <Tabs value={tab} onChange={setTab} items={p.tabs.map((x) => ({ value: x.value, label: x.label, count: x.count }))} />}
      {/* no filter at all (« Tous » searched by an agent): no filter bar */}
      <div className={`filters${open ? ' open' : ''}`} hidden={show.length === 0}>
        {show.includes('search') && (
          <label className="field search-f" hidden={p.q !== undefined}>
            <span className="lab">{t('orders.f.search')}</span>
            <input type="search" aria-label={t('orders.f.searchPh')} placeholder={t('orders.f.searchPh')} value={f.q} onChange={(e) => set({ q: e.target.value })} />
          </label>
        )}
        <button type="button" className="btn filters-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('orders.f.filters')}
        </button>
        {show.includes('conf') && sel('conf', t('orders.f.conf'), confOpts)}
        {show.includes('follow') && sel('follow', t('orders.f.follow'), followOpts)}
        {show.includes('company') && sel('company', t('orders.f.company'), [['none', t('orders.f.noCompany')], ...companies.map((c): [string, string] => [String(c.id), c.name])])}
        {show.includes('wilaya') && sel('wilaya', t('orders.f.wilaya'), WILAYAS.map((w, i): [string, string] => [String(i + 1), `${String(i + 1).padStart(2, '0')} ${w}`]))}
        {show.includes('channel') && sel('channel', t('orders.f.source'), SALES_CHANNELS.map((c): [string, string] => [c, t(`status.channel.${c}`)]))}
        {show.includes('agent') && <AgentFilter kind="conf" value={f.agent} onChange={(v) => set({ agent: v })} />}
        {show.includes('team') && <TeamFilter value={f.team} onChange={(v) => set({ team: v })} />}
        {show.includes('product') && <ProductFilter product={f.product} variant={f.variant} onChange={(v) => set(v)} />}
        {show.includes('livreur') && <LivreurFilter value={f.livreur} onChange={(v) => set({ livreur: v })} />}
        {show.includes('cashed') && <CashedFilter value={f.cashed} onChange={(v) => set({ cashed: v })} />}
        {show.includes('reason') && p.reasonOf && <ReasonFilter of={p.reasonOf} value={f.reason} onChange={(v) => set({ reason: v })} />}
        {show.includes('dates') && <DateFilters from={f.from} to={f.to} onChange={(v) => set(v)} />}
        <ClearFilters on={anyOn} onClear={() => set({ ...NO_FILTERS, q: f.q })} />
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <OrderTable
          rows={rows}
          total={list.data?.total ?? 0}
          page={page}
          pageSize={size}
          onPage={setPage}
          onSize={(s) => {
            setSize(s);
            setPage(1);
          }}
          loading={list.isLoading}
          columns={p.columns}
          table={`orders-${p.id}`}
          extra={extra}
          sort={sort}
          dir={dir}
          onSort={(k, d) => {
            setSort(k);
            setDir(d);
            setPage(1);
          }}
          selectable={!together}
          bulk={together ? undefined : bulk}
          resetKey={resetKey}
          lead={together ? sellerColumn(t('agency.pick.short')) : undefined}
          onRow={together ? (o) => openOrder(o.id, sellerOf(o)?.id) : undefined}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- "Bilan des livraisons"
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoDay = (s: string, plus = 0) => new Date(Date.parse(`${s}T00:00:00+01:00`) + plus * 86_400_000).toISOString();

function DeliveredReport() {
  const { t } = useTranslation();
  const d0 = new Date();
  const first = ymd(new Date(d0.getFullYear(), d0.getMonth(), 1));
  const today = ymd(d0);
  const [tab, setTab] = useState<'total' | 'soc'>(() => (store.get('orders-bilan-tab') as 'total' | 'soc') || 'total');
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(today);
  const r = useRpc('orders.deliveredReport', { from: isoDay(from), to: isoDay(to, 1) });
  const quick = (label: string, a: string, b: string) => (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        setFrom(a);
        setTo(b);
      }}
    >
      {label}
    </button>
  );
  const lm0 = ymd(new Date(d0.getFullYear(), d0.getMonth() - 1, 1));
  const lm1 = ymd(new Date(d0.getFullYear(), d0.getMonth(), 0));
  const d30 = ymd(new Date(d0.getTime() - 30 * 86_400_000));
  const T = r.data?.total;
  // (a parcel given to another customer by a swap: its swap fee, like a return fee)
  const fees = T ? T.fees + T.overweight + T.returnFees + T.returnOverweight + T.swapFees : 0;
  const swapsS = (m: { swaps: number; swapFees: number }) => (m.swaps ? t('orders.bilan.swapsS', { count: m.swaps, v: da(m.swapFees) }) : '');
  const notes = T && (
    <>
      {T.noTariff > 0 && <p className="muted small">{t('orders.bilan.noTariff', { n: T.noTariff })}</p>}
      {r.data!.noOverweightRule.length > 0 && <p className="muted small">{t('orders.bilan.noRule', { list: r.data!.noOverweightRule.join(', ') })}</p>}
    </>
  );
  return (
    <Card
      title={t('orders.bilan.title')}
      actions={
        <Tabs
          value={tab}
          onChange={(v) => {
            setTab(v);
            store.set('orders-bilan-tab', v);
          }}
          items={[
            { value: 'total', label: t('orders.bilan.tabTotal') },
            { value: 'soc', label: t('orders.bilan.tabCompany') },
          ]}
        />
      }
    >
      <div className="row bjlb-per">
        <label className="field">
          <span className="lab">{t('orders.bilan.from')}</span>
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('orders.bilan.to')}</span>
          <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        {quick(t('orders.bilan.thisMonth'), first, today)}
        {quick(t('orders.bilan.lastMonth'), lm0, lm1)}
        {quick(t('orders.bilan.d30'), d30, today)}
      </div>
      {r.error ? (
        <ErrorBox error={r.error} onRetry={() => r.refetch()} />
      ) : !T ? (
        <Loading />
      ) : tab === 'total' ? (
        <>
          <Kpis>
            <Kpi label={t('orders.bilan.total')} value={da(T.amount)} sub={t('orders.bilan.totalS', { n: n(T.n) })} tone="ok" />
            <Kpi label={t('orders.bilan.cashed')} value={da(T.cashed)} sub={t('orders.bilan.cashedS', { n: n(T.cashedN) })} />
            <Kpi label={t('orders.bilan.uncashed')} value={da(T.uncashed)} sub={t('orders.bilan.uncashedS', { n: n(T.uncashedN) })} tone={T.uncashed ? 'warn' : undefined} />
            <Kpi label={t('orders.bilan.fees')} value={da(T.fees + T.overweight)} sub={T.overweight ? t('orders.bilan.feesOver', { v: da(T.overweight) }) : t('orders.bilan.feesS')} />
            <Kpi label={t('orders.bilan.ret')} value={da(T.returnFees + T.returnOverweight + T.swapFees)} sub={[t('orders.bilan.retS', { n: n(T.returns) }), swapsS(T)].filter(Boolean).join(' · ')} tone={T.returns || T.swaps ? 'bad' : undefined} />
            <Kpi label={t('orders.bilan.net')} value={da(T.amount - fees)} sub={t('orders.bilan.netS')} tone={T.amount - fees < 0 ? 'bad' : 'ok'} />
            <Kpi label={t('orders.bilan.recv')} value={da(T.netToReceive)} sub={t('orders.bilan.recvS')} tone={T.netToReceive < 0 ? 'bad' : undefined} />
          </Kpis>
          {notes}
          <p className="muted small">{t('orders.bilan.how')}</p>
        </>
      ) : (
        <>
          {r.data!.companies.length ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('orders.bilan.colCompany')}</th>
                    <th className="num">{t('orders.bilan.colN')}</th>
                    <th className="num">{t('orders.bilan.colAmount')}</th>
                    <th className="num">{t('orders.bilan.colReceived')}</th>
                    <th className="num">{t('orders.bilan.colUncashed')}</th>
                    <th className="num">{t('orders.bilan.colFees')}</th>
                    <th className="num">{t('orders.bilan.colOver')}</th>
                    <th className="num">{t('orders.bilan.colRet')}</th>
                    <th className="num">{t('orders.bilan.colNet')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.data!.companies, ...(r.data!.companies.length > 1 ? [{ ...T, name: t('common.total'), kind: null, companyId: -1 }] : [])].map((m) => (
                    <tr key={m.companyId ?? 0} className={m.companyId === -1 ? 'bjlb-tot' : undefined}>
                      <td data-l={t('orders.bilan.colCompany')}>
                        <b>{m.companyId === null ? t('orders.bilan.noCompanyName') : m.name}</b>
                        {m.kind === 'own' && <small>{t('orders.bilan.livreur')}</small>}
                      </td>
                      <td className="num" data-l={t('orders.bilan.colN')}>
                        {n(m.n)}
                      </td>
                      <td className="num ltr" data-l={t('orders.bilan.colAmount')}>
                        {da(m.amount)}
                      </td>
                      <td className="num" data-l={t('orders.bilan.colReceived')}>
                        <span className="ltr">{da(m.cashed)}</span>
                        <small>{t('orders.bilan.parcels', { n: n(m.cashedN) })}</small>
                      </td>
                      <td className="num" data-l={t('orders.bilan.colUncashed')}>
                        <b className={`ltr${m.uncashed ? ' stock-low' : ''}`}>{da(m.uncashed)}</b>
                        <small>{t('orders.bilan.parcels', { n: n(m.uncashedN) })}</small>
                      </td>
                      <td className="num ltr" data-l={t('orders.bilan.colFees')}>
                        {da(m.fees)}
                      </td>
                      <td className="num ltr" data-l={t('orders.bilan.colOver')}>
                        {da(m.overweight + m.returnOverweight)}
                      </td>
                      <td className="num" data-l={t('orders.bilan.colRet')}>
                        {n(m.returns)}
                        <small className="ltr">{da(m.returnFees)}</small>
                        {m.swaps > 0 && <small>{swapsS(m)}</small>}
                      </td>
                      <td className="num" data-l={t('orders.bilan.colNet')}>
                        <b className="ltr">{da(m.netToReceive)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-box">{t('orders.bilan.none')}</div>
          )}
          {notes}
          <p className="muted small">{t('orders.bilan.howCompany')}</p>
        </>
      )}
    </Card>
  );
}

/** Columns "Frais société" and "Encaissé" of the delivered list. */
function useDeliveredExtra() {
  const { t } = useTranslation();
  const [ids, setIds] = useState<number[]>([]);
  const fees = useRpc('orders.companyFees', { ids }, { enabled: ids.length > 0 });
  return (rows: Order[]): ExtraColumn[] => {
    const key = rows.map((o) => o.id).join(',');
    if (key !== ids.join(',')) setTimeout(() => setIds(rows.map((o) => o.id)), 0);
    return [
      {
        key: 'fee',
        label: t('orders.col.fee'),
        num: true,
        cell: (o) => {
          const f = fees.data?.[String(o.id)];
          if (!o.companyId || !f) return <small>—</small>;
          return (
            <>
              <b className="ltr">{da(f.fee)}</b>
              <small>
                {f.extra ? t('orders.overweight', { v: da(f.extra) }) : `${String(f.kg).replace('.', ',')} kg`}
                {f.fromApi && <span className="px-api-tag">{t('orders.col.feeApi')}</span>}
              </small>
            </>
          );
        },
      },
      {
        key: 'cashed',
        label: t('orders.col.cashed'),
        cell: (o) => <span className={`badge t-${o.cashed ? 'ok' : 'bad'}`}>{o.cashed ? t('orders.cashedYes') : t('orders.cashedNo')}</span>,
      },
    ];
  };
}

// ---------------------------------------------------------------- pages
/**
 * « Commandes »: this boutique's, or every boutique's with « Toutes les boutiques ». Livré, Annulé and Toutes les
 * commandes are the same screens for everyone (owner's choice, 24 Nov 2026), in a confirmation agency too: only the
 * orders change — each one sees his own, an agent manager his team's, the owner all of them (the server decides).
 */
/** Confirmées, all or one stage: the confirmed orders their company does not have yet (Confirmation › Confirmées' rule). */
const CONFIRMED_BASE: Partial<ListFilter> = { conf: ['confirmed', 'no_stock'], follow: ['none', 'to_prepare', 'prepared', 'shipped'], taken: false };
const STAGE_BASE: Record<ConfStage, Partial<ListFilter>> = {
  nostock: { conf: ['no_stock'], follow: ['none'] },
  preparer: { conf: ['confirmed'], follow: ['to_prepare'] },
  prepares: { conf: ['confirmed', 'no_stock'], follow: ['prepared'] },
  dispatchees: { conf: ['confirmed', 'no_stock'], follow: ['shipped'], taken: false },
};

/** The Community manager's Confirmées: the stage bar of Confirmation › Confirmées over her own orders, read-only. */
function MineConfirmed() {
  const { t } = useTranslation();
  const c = useCounts();
  const [stage, setStage] = useState<ConfStage | null>(null);
  const l = c?.raw.lists;
  return (
    <>
      <ConfirmedStages stage={stage} onChange={setStage} counts={l?.stages} total={l?.confirmees} />
      <OrderList
        key={stage ?? 'all'}
        id="cm-confirmees"
        title={t('nav.sub.confirmees')}
        base={stage ? STAGE_BASE[stage] : CONFIRMED_BASE}
        show={['search', 'wilaya', 'dates']}
        // (with the stage, five columns: a tablet shows them all)
        columns={['order', 'client', 'products', 'total']}
        extra={() => [{ key: 'stage', label: t('orders.cmStage'), cell: (o) => <StageTag o={o} /> }]}
      />
    </>
  );
}

export function Commandes(p: PageProps) {
  const all = useAllMode();
  return all.on ? <Suspense fallback={<Loading />}><AllOrdersPage {...p} /></Suspense> : <CommandesOne {...p} />;
}
const AllOrdersPage = lazy(() => import('../boutiques/all').then((m) => ({ default: m.BoutiquesOrders })));

function CommandesOne({ sub }: PageProps) {
  return <DoneScreen sub={sub} />;
}

/**
 * Livré and Annulé: the stats you tap and the cards (phones; computers too, laid out wide), or the big table; the other
 * tabs, the big table. The one screen of Livré and of Annulé, wherever it opens (Commandes, Suivi › Annulés, an agency).
 * `start`: Annulé opens on its returns (Suivi). Every seller together (an agency's « Tous les vendeurs »): the cards.
 */
export function DoneScreen({ sub, start }: { sub?: string; start?: 'conf' | 'back' }) {
  const phone = useIsPhone();
  const together = useScope() === 'all';
  const [mode, setMode] = useViewMode('orders-done');
  const done = sub === 'livrees' || sub === 'annulees';
  const toTable = together ? undefined : () => setMode('table');
  if (done && (phone || mode === 'cards' || together)) return sub === 'livrees' ? <PhoneLivre onTable={toTable} /> : <PhoneAnnule onTable={toTable} start={start} />;
  return (
    <>
      {done && (
        <div className="px-vsw-row">
          <ViewSwitch mode="table" onChange={setMode} />
        </div>
      )}
      <CommandesDesk sub={sub} />
    </>
  );
}

function CommandesDesk({ sub }: { sub?: string }) {
  const { t } = useTranslation();
  const { has, session } = useSession();
  const [q, setQ] = useState('');
  const c = useCounts();
  const deliveredExtra = useDeliveredExtra();
  const [syncing, setSyncing] = useState(false);
  const qc = useQueryClient();
  // a confirmation agency works on its sellers' orders: no new order, no sync with the companies, not the seller's money
  const agency = useInAgency();
  // the Community manager follows her orders: not the companies' fees, not the money
  const cm = !!session && !session.isAdmin && cmOnly(session.profile.roles);
  // « Swap » on a parcel coming back, always (Suivi's rule): in Annulé's returns too
  const swap = useSwap();

  const syncBtn = !agency && has('suivi', 'depot') && (
    <button
      className="btn"
      disabled={syncing}
      onClick={async () => {
        setSyncing(true);
        const r = await callOptional('delivery.sync', {});
        setSyncing(false);
        if (r.ok) {
          toast(t('orders.synced', { count: Number(r.data?.changed ?? 0) }), 'ok');
          const problems = syncProblems(r.data);
          if (problems.length) toast(t('suivi.syncProblems', { count: problems.length, list: problems.slice(0, 4).join(' · ') }), 'bad');
          qc.invalidateQueries();
        } else toast(t('orders.syncUnavailable', { msg: r.error }), 'bad');
      }}
    >
      {t('orders.sync')}
    </button>
  );
  const newBtn = !agency && has('confirmation', 'suivi', 'depot', 'cm') && rightOn('act:orders.create') && (
    <button className="btn primary" onClick={() => openOrderForm()}>
      {t('orders.plusNew')}
    </button>
  );

  if (sub === 'livrees')
    return (
      <>
        <HeaderKpis on="livrees" />
        {!agency && has('suivi', 'depot') && <DeliveredReport />}
        <OrderList
          id="livrees"
          title={t('orders.delivered')}
          base={{ follow: ['delivered'], dateField: 'delivered_at' }}
          show={['search', 'conf', 'company', 'wilaya', 'channel', 'agent', 'team', 'product', 'livreur', 'cashed', 'dates']}
          extra={agency || cm ? undefined : deliveredExtra}
          defaultSort="delivered_at"
        />
      </>
    );

  // the Community manager follows her orders (owner's yes, 25 Nov 2026), read-only: where each confirmed one is in the dépôt
  // (the stages of Confirmation › Confirmées), then her parcels their company has (Suivi › En livraison's rule)
  if (sub === 'confirmees') return <MineConfirmed />;
  if (sub === 'enroute')
    return (
      <OrderList
        id="cm-enroute"
        title={t('nav.sub.enroute')}
        base={{ follow: [...FOLLOW_ON_ROAD], pickedUp: true }}
        show={['search', 'company', 'wilaya', 'dates']}
        // (five columns: a tablet shows them all, the tracking number too)
        columns={['order', 'client', 'products', 'follow', 'company']}
        defaultSort="shipped_at"
      />
    );

  if (sub === 'annulees')
    return (
      <>
        <HeaderKpis on="annulees" />
        <OrderList id="annulees-conf" title={t('orders.cancelledConf')} base={{ conf: CONF_DONE_BAD }} show={['search', 'follow', 'company', 'wilaya', 'channel', 'agent', 'team', 'product', 'reason', 'dates']} reasonOf="conf" />
        <OrderList
          id="annulees-ret"
          title={t('orders.cancelledReturns')}
          base={{ follow: ['returning', 'returned'] }}
          show={['search', 'conf', 'company', 'wilaya', 'channel', 'agent', 'team', 'product', 'livreur', 'reason', 'dates']}
          reasonOf="back"
          defaultSort="updated_at"
          extra={swap.can ? () => [{ key: 'swap', label: t('suivi.act.swap'), cell: (o) => swap.button(o), fixed: true }] : undefined}
        />
        {swap.dialogs}
      </>
    );

  // « Tous »: the seller and the admins see everything; the others only search it, from 5 digits (owner's rule, 25 Nov 2026)
  if (!seesAll(session))
    return (
      <LookupOnly
        actions={
          <>
            {syncBtn}
            {newBtn}
          </>
        }
      />
    );

  // all orders
  // each status' tab counts the person's own orders (an agent manager: his team's), like the list below
  const F = c?.follow ?? {};
  const tab = (s: FollowStatus) => ({ value: s, label: t(`status.follow.${s}`), count: F[s] ?? 0, filter: { follow: [s] } as Partial<ListFilter> });
  const tabs = [
    { value: 'all', label: t('orders.tabs.all'), count: c?.all, filter: {} },
    tab('to_prepare'),
    { ...tab('prepared'), label: t('status.follow.prepared') },
    tab('shipped'),
    tab('out_for_delivery'),
    tab('failed'),
    tab('alert'),
    tab('in_exchange'),
    tab('returning'),
    tab('returned'),
    tab('delivered'),
    { value: 'cancelled', label: t('status.conf.cancelled'), count: c ? c.cancelledConf + (F.cancelled ?? 0) : undefined, filter: { conf: CONF_DONE_BAD } as Partial<ListFilter> },
  ].filter((x) => x.value === 'all' || x.value === 'cancelled' || (x.count ?? 0) > 0);
  return (
    <>
      <HeaderKpis />
      <BigSearch value={q} onChange={setQ} />
      <OrderList
        id="tout"
        title={t('orders.allOrders')}
        headActions={
          <>
            {syncBtn}
            {newBtn}
          </>
        }
        q={q}
        tabs={tabs}
      />
    </>
  );
}

/** Hidden pages "Livrées" / "Retournées": KPIs + list. */
function DoneKpis() {
  const { t } = useTranslation();
  const from = useMemo(() => new Date(Date.now() - 30 * 86_400_000).toISOString(), []);
  const d = useRpc('orders.list', { follow: ['delivered'], dateField: 'delivered_at', from, pageSize: 1 });
  const r = useRpc('orders.list', { follow: ['returned'], dateField: 'returned_at', from, pageSize: 1 });
  const c = useCounts();
  const nd = d.data?.total;
  const nr = r.data?.total;
  const rate = nd !== undefined && nr !== undefined && nd + nr > 0 ? nd / (nd + nr) : null;
  return (
    <Kpis>
      <Kpi label={t('orders.kpi.delivered')} value={nd ?? '…'} sub={t('orders.kpi.deliveredS')} tone="ok" />
      <Kpi label={t('orders.kpi.returned')} value={nr ?? '…'} sub={t('orders.kpi.returnedS')} tone="bad" />
      <Kpi label={t('orders.kpi.rate')} value={pct(rate)} sub={t('orders.kpi.rateS')} tone={rate === null ? undefined : rate >= 0.7 ? 'ok' : rate >= 0.5 ? 'warn' : 'bad'} />
      <Kpi label={t('orders.kpi.onWay')} value={c?.returning ?? '…'} sub={t('orders.kpi.onWayS')} tone={c?.returning ? 'warn' : undefined} />
    </Kpis>
  );
}

export function Livrees(_: PageProps) {
  const { t } = useTranslation();
  const extra = useDeliveredExtra();
  // a phone: the same short cards as Commandes › Livré (the big table's rows were one very long card each)
  const phone = useIsPhone();
  if (phone) return <PhoneLivre />;
  return (
    <>
      <DoneKpis />
      <OrderList id="p-livrees" title={t('orders.delivered')} base={{ follow: ['delivered'], dateField: 'delivered_at' }} show={['search', 'company', 'wilaya', 'channel', 'agent', 'team', 'product', 'livreur', 'cashed', 'dates']} extra={extra} defaultSort="delivered_at" />
    </>
  );
}

export function Retournees(_: PageProps) {
  const { t } = useTranslation();
  // a phone: the short cards of Commandes › Annulé, open on the returns (the big table's rows were one very long card each)
  const phone = useIsPhone();
  if (phone) return <PhoneAnnule start="back" />;
  return (
    <>
      <DoneKpis />
      <OrderList id="p-retournees" title={t('orders.returned')} base={{ follow: ['returning', 'returned'] }} show={['search', 'follow', 'company', 'wilaya', 'channel', 'agent', 'team', 'product', 'livreur', 'reason', 'dates']} reasonOf="back" defaultSort="updated_at" />
    </>
  );
}

export { API_KINDS };
