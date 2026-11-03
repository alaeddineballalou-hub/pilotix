// « Toutes les boutiques » (layout/AllBoutiques.tsx): the screens that show every boutique of the person together.
// - Accueil and Dashboard: what is waiting now and the period, added up, then boutique by boutique;
// - Commandes: one list of every boutique's orders (each with its boutique), opened inside its boutique;
// - Confirmation and Suivi: the lists of a partner's « Tous les vendeurs » (agency/work.tsx), with the boutiques' filters;
// - Dépôt: what waits at each stage, boutique by boutique, the orders of the stage, and a return received wherever it is;
// - Caisse: the money of every boutique added up, and boutique by boutique (its movements stay in its own caisse).
// The « Boutique » filter keeps some of them; Agent, Équipe, Produit, Société and Livreur list each boutique's own.
import { CONF_DONE_BAD, CONF_TODO, FOLLOW_STATUSES, FollowStatus, Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, dayRange, n, pct } from '../../lib/format';
import { trackOf } from '../../lib/items';
import { openOrder } from '../../lib/modals';
import { useRpcFor } from '../../lib/query';
import { SellerScope } from '../../lib/seller';
import { useSession } from '../../lib/session';
import { useIsPhone } from '../../lib/useMedia';
import { CopyCode } from '../../ui/CopyCode';
import { Card, Empty, ErrorBox, Icon, Kpis, Loading, StatusBadge, Tabs, Trend } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { allCount, AllF, AllFields, AllKey, allScope, BoutiqueChips, BoutiqueTag, setAllOn, StackLogo, useAllFilters, useAllMode, useAllOptions, useShopFilter } from '../../layout/AllBoutiques';
import { BoutiqueLogo } from '../../layout/Boutiques';
import { AllConfirmation, AllScope, AllSuivi } from '../agency/work';
import { PeriodChips } from '../dashboard/board/parts';
import { useBoardPeriod } from '../dashboard/board/Board';
import { delivTone, KpiBox, prevRangeOf } from '../dashboard/util';
import { itemsLine, useDebounced } from '../depot/OrderList';
import { DEPOT_STAGES, DepotStage, depotStage, DepotStageBar } from '../depot/StageNav';
import { OrderTable, type OrderSort } from '../orders/OrderTable';
import { ListFilter, toListInput } from '../orders/shared';
import type { PageProps } from '../registry';
import '../dashboard/board/board.css';

type Row<T> = T & { seller: { id: number; name: string } };
/** What every « all » call adds: the boutiques kept (none: all of them). */
const keptInput = (kept: number[] | null) => (kept ? { shops: kept } : {});
const dayIso = (d: string, end = false) => new Date(Date.parse(`${d}T00:00:00+01:00`) + (end ? 86_400_000 : 0)).toISOString();

/** The chip of the lists' head: « Toutes les boutiques », their logos. */
function AllChip() {
  const { t } = useTranslation();
  const all = useAllMode();
  return (
    <span className="chip agx-all-chip bq-allchip">
      <StackLogo list={all.boutiques} size={18} />
      {t('boutiques.all.title')}
    </span>
  );
}

/** The « Boutique » chips, then the filters, with « Effacer les filtres ». */
function AllBar({ f, set, clear, show, agentKind, reasonOf, search, chips = true }: { f: AllF; set: (p: Partial<AllF>) => void; clear: () => void; show: AllKey[]; agentKind?: 'conf' | 'follow'; reasonOf?: 'conf' | 'back'; search?: { value: string; onChange: (v: string) => void }; chips?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const on = allCount(f);
  return (
    <div className="bq-allbar">
      {chips && <BoutiqueChips />}
      <div className={`filters${open ? ' open' : ''}`}>
        {search && (
          <label className="field search-f">
            <span className="lab">{t('filters.search')}</span>
            <input type="search" aria-label={t('filters.searchPh')} placeholder={t('filters.searchPh')} value={search.value} onChange={(e) => search.onChange(e.target.value)} />
          </label>
        )}
        <button type="button" className="btn filters-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('filters.toggle')}
          {on > 0 && <b className="ltr"> · {on}</b>}
        </button>
        <AllFields f={f} set={set} show={show} agentKind={agentKind} reasonOf={reasonOf} />
        {on > 0 && (
          <div className="field more-f px-f-clear">
            <button type="button" className="btn ghost" onClick={clear}>
              {t('filters.clear')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** What a list's scope says: its words, each row's boutique, the names (« Commande suivante »). */
function useScopeBase(): Pick<AllScope, 'label' | 'chip' | 'tag' | 'nameOf'> {
  const { t } = useTranslation();
  const all = useAllMode();
  return {
    label: t('boutiques.all.col'),
    chip: <AllChip />,
    tag: (s) => <BoutiqueTag id={s.id} name={s.name} />,
    nameOf: (id) => all.boutiques.find((b) => b.id === id)?.name ?? '',
  };
}

// ---------------------------------------------------------------- Accueil / Dashboard
export function BoutiquesHome({ dash }: { dash?: boolean }) {
  const { t } = useTranslation();
  const { session, has } = useSession();
  const all = useAllMode();
  const kept = useShopFilter();
  const per = useBoardPeriod(dash ? 'dash.all' : 'home', 'today');
  const prev = prevRangeOf(per.range);
  const vs = t('dashboard.tb.vs', { range: dayRange(prev.from, prev.to) });
  const scope = keptInput(kept);
  const now = useRpcFor('all', 'stats.now', scope as never, { refetchInterval: 60_000 });
  const cur = useRpcFor('all', 'stats.overview', { ...per.range, ...scope } as never);
  const old = useRpcFor('all', 'stats.overview', { ...prev, ...scope } as never);
  const N = now.data as (typeof now.data & { byBoutique?: any[] }) | undefined;
  const d = cur.data as (typeof cur.data & { byBoutique?: any[] }) | undefined;
  const p = old.data;
  const ch = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || b === 0 ? null : (a - b) / b);
  const rows = (d?.byBoutique ?? []).map((b: any) => ({ ...b, now: N?.byBoutique?.find((x: any) => x.id === b.id) }));
  return (
    <div className="tb hm">
      <header className="tb-head hm-head">
        <div className="tb-ht">
          <h2>{dash ? t('boutiques.all.title') : t('home.hello', { name: session!.profile.name })}</h2>
          <p className="tb-cap">
            {dayRange(per.range.from, per.range.to)}
            <span className="tb-capvs"> · {vs}</span>
          </p>
        </div>
        <PeriodChips value={per.period} onChange={per.setPeriod} custom={per.custom} onCustom={per.setCustom} />
      </header>
      <BoutiqueChips />
      <section className="card hm-now">
        <div className="card-head">
          <h2>{t('home.now')}</h2>
          <AllChip />
        </div>
        {now.error ? (
          <ErrorBox error={now.error} onRetry={() => now.refetch()} />
        ) : !N ? (
          <Loading />
        ) : (
          <Kpis>
            <KpiBox icon="phone" label={t('home.toCall')} value={n(N.toCall)} sub={t('home.callbacksLater', { n: N.callbacksLater })} tone={N.toCall ? 'warn' : undefined} href={has('confirmation') ? '#/confirmation' : undefined} />
            <KpiBox icon="alert" label={t('home.noStock')} value={n(N.noStock)} sub={t('home.noStockSub')} tone={N.noStock ? 'bad' : undefined} href="#/commandes" />
            <KpiBox icon="package" label={t('home.toPrepare')} value={n(N.toPrepare)} sub={t('home.prepared', { n: N.prepared })} href={has('depot') ? '#/depot' : undefined} />
            <KpiBox icon="truck" label={t('home.onRoad')} value={n(N.onRoad)} sub={t('home.failed', { n: N.failed })} tone={N.failed ? 'warn' : undefined} href={has('suivi') ? '#/suivi' : undefined} />
            {N.moneyDue !== null && N.moneyDue !== undefined && <KpiBox icon="wallet" label={t('home.moneyDue')} value={da(N.moneyDue)} sub={t('home.moneyDueSub', { n: N.moneyDueCount ?? 0 })} tone={N.moneyDue ? 'info' : undefined} href="#/caisse" />}
          </Kpis>
        )}
      </section>
      <section className="card hm-per">
        <div className="card-head">
          <h2>
            {t('home.period')} <small className="px-vs">{vs}</small>
          </h2>
        </div>
        {cur.error ? (
          <ErrorBox error={cur.error} onRetry={() => cur.refetch()} />
        ) : !d ? (
          <Loading />
        ) : (
          <Kpis>
            <KpiBox icon="list" href="#/commandes" label={t('home.received')} value={n(d.received)} trend={<Trend v={ch(d.received, p?.received)} vs={vs} />} sub={t('home.receivedTodo', { n: d.receivedTodo })} />
            <KpiBox icon="check" href="#/confirmation/confirmees" label={t('home.confirmed')} value={n(d.confirmed)} trend={<Trend v={ch(d.confirmed, p?.confirmed)} vs={vs} />} sub={t('home.rate', { v: pct(d.confRate) })} rate={d.confRate} tone="ok" />
            <KpiBox icon="xcircle" href="#/commandes/annulees" label={t('home.cancelled')} value={n(d.cancelled)} trend={<Trend v={ch(d.cancelled, p?.cancelled)} goodDown vs={vs} />} sub={t('home.cancelledSub')} tone={d.cancelled ? 'bad' : undefined} zero={!d.cancelled} />
            <KpiBox icon="route" href="#/suivi" label={t('home.shipped')} value={n(d.shipped)} trend={<Trend v={ch(d.shipped, p?.shipped)} vs={vs} />} sub={t('home.shippedSub', { n: d.shippedOnRoad })} />
            <KpiBox icon="truck" href="#/commandes/livrees" label={t('home.delivered')} value={n(d.delivered)} trend={<Trend v={ch(d.delivered, p?.delivered)} vs={vs} />} sub={t('home.deliveryRate', { v: pct(d.deliveryRate) })} rate={d.deliveryRate} tone="ok" />
            <KpiBox icon="undo" label={t('home.returns')} value={n(d.returns)} trend={<Trend v={ch(d.returns, p?.returns)} goodDown vs={vs} />} sub={t('home.returnsSub')} tone={d.returns ? 'bad' : undefined} zero={!d.returns} />
            <KpiBox icon="coins" label={t('home.cashed')} value={da(d.cashed)} trend={<Trend v={ch(d.cashed, p?.cashed)} vs={vs} />} sub={t('home.cashedSub', { v: da(d.cashedProducts) })} />
          </Kpis>
        )}
      </section>
      <Card title={t('boutiques.all.byBoutique')}>
        {!d ? (
          <Loading />
        ) : !rows.length ? (
          <Empty>{t('agency.work.noParcel')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl bq-by">
              <thead>
                <tr>
                  <th>{t('boutiques.all.col')}</th>
                  <th className="num">{t('boutiques.all.toCall')}</th>
                  <th className="num">{t('boutiques.all.toPrepare')}</th>
                  <th className="num">{t('boutiques.all.onRoad')}</th>
                  <th className="num">{t('boutiques.all.received')}</th>
                  <th className="num">{t('boutiques.all.confirmed')}</th>
                  <th className="num">{t('boutiques.all.confRate')}</th>
                  <th className="num">{t('boutiques.all.delivered')}</th>
                  <th className="num">{t('boutiques.all.delivRate')}</th>
                  <th className="num">{t('boutiques.all.returns')}</th>
                  <th className="num">{t('boutiques.all.cashed')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b: any) => {
                  const bq = all.boutiques.find((x) => x.id === b.id);
                  return (
                    <tr key={b.id}>
                      <td data-l={t('boutiques.all.col')}>
                        <span className="bq-tag">
                          <BoutiqueLogo name={b.name} logo={bq?.logo ?? null} size={24} />
                          <span>{b.name}</span>
                        </span>
                      </td>
                      <td className="num" data-l={t('boutiques.all.toCall')}>{n(b.now?.toCall ?? 0)}</td>
                      <td className="num" data-l={t('boutiques.all.toPrepare')}>{n(b.now?.toPrepare ?? 0)}</td>
                      <td className="num" data-l={t('boutiques.all.onRoad')}>{n(b.now?.onRoad ?? 0)}</td>
                      <td className="num" data-l={t('boutiques.all.received')}>{n(b.received)}</td>
                      <td className="num" data-l={t('boutiques.all.confirmed')}>{n(b.confirmed)}</td>
                      <td className="num" data-l={t('boutiques.all.confRate')}>{pct(b.confRate)}</td>
                      <td className="num" data-l={t('boutiques.all.delivered')}>{n(b.delivered)}</td>
                      <td className={`num bq-${delivTone(b.deliveryRate) ?? 'none'}`} data-l={t('boutiques.all.delivRate')}>{pct(b.deliveryRate)}</td>
                      <td className="num" data-l={t('boutiques.all.returns')}>{n(b.returns)}</td>
                      <td className="num" data-l={t('boutiques.all.cashed')}>{da(b.cashed)}</td>
                    </tr>
                  );
                })}
                {rows.length > 1 && d && (
                  <tr className="bq-by-total">
                    <td data-l="">
                      <b>{t('boutiques.all.total')}</b>
                    </td>
                    <td className="num">{n(N?.toCall ?? 0)}</td>
                    <td className="num">{n(N?.toPrepare ?? 0)}</td>
                    <td className="num">{n(N?.onRoad ?? 0)}</td>
                    <td className="num">{n(d.received)}</td>
                    <td className="num">{n(d.confirmed)}</td>
                    <td className="num">{pct(d.confRate)}</td>
                    <td className="num">{n(d.delivered)}</td>
                    <td className="num">{pct(d.deliveryRate)}</td>
                    <td className="num">{n(d.returns)}</td>
                    <td className="num">{da(d.cashed)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {dash && <p className="muted small">{t('boutiques.all.dashNote')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Commandes
/** The KPI card of Commandes (Confirmation, Dépôt, Suivi, Livré, Annulé), every boutique kept added up. */
function AllCounts({ on }: { on?: 'livrees' | 'annulees' }) {
  const { t } = useTranslation();
  const kept = useShopFilter();
  const q = useRpcFor('all', 'orders.counts', keptInput(kept) as never, { refetchInterval: 60_000 });
  const c = q.data as any;
  const sum = (o: Record<string, number> | undefined, keys: string[]) => keys.reduce((s, k) => s + (o?.[k] ?? 0), 0);
  const v = c
    ? {
        todo: sum(c.conf, CONF_TODO),
        depot: sum(c.follow, ['to_prepare', 'prepared']),
        suivi: sum(c.follow, ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange']),
        delivered: c.follow?.delivered ?? 0,
        cancelled: sum(c.conf, CONF_DONE_BAD) + sum(c.follow, ['returning', 'returned']),
        all: c.all ?? 0,
      }
    : null;
  const k = (key: string, href: string, label: string, val: number | undefined, tone?: string) => (
    <a key={key} className={`kpi${tone ? ` t-${tone}` : ''}${val === 0 ? ' px-zero' : ''}${on === key ? ' bjsv-on' : ''}`} href={href}>
      <span className="l">{label}</span>
      <span className="v ltr">{val === undefined ? '…' : n(val)}</span>
    </a>
  );
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('orders.title')}</h2>
        <AllChip />
      </div>
      <BoutiqueChips />
      <div className="kpis bjcm-k">
        {k('confirmation', '#/confirmation', t('orders.kpi.confirmation'), v?.todo, 'warn')}
        {k('depot', '#/depot', t('orders.kpi.depot'), v?.depot)}
        {k('suivi', '#/suivi', t('orders.kpi.suivi'), v?.suivi)}
        {k('livrees', '#/commandes/livrees', t('orders.kpi.livre'), v?.delivered, 'ok')}
        {k('annulees', '#/commandes/annulees', t('orders.kpi.annule'), v?.cancelled, 'bad')}
      </div>
    </div>
  );
}

/** One list of every boutique kept: its filters, its tabs, each order with its boutique (opened inside it). */
function AllOrderList({ id, title, base, show, reasonOf, defaultSort = 'created_at', defaultDir = 'desc', tabs }: { id: string; title: string; base?: Partial<ListFilter>; show: AllKey[]; reasonOf?: 'conf' | 'back'; defaultSort?: OrderSort; defaultDir?: 'asc' | 'desc'; tabs?: boolean }) {
  const { t } = useTranslation();
  const kept = useShopFilter();
  const opts = useAllOptions();
  const [f, set, clear] = useAllFilters(`orders-${id}`);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [tab, setTab] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [sort, setSort] = useState<OrderSort>(defaultSort);
  const [dir, setDir] = useState<'asc' | 'desc'>(defaultDir);
  const counts = useRpcFor('all', 'orders.counts', keptInput(kept) as never, { refetchInterval: 60_000, enabled: !!tabs }).data as any;
  const F = (counts?.follow ?? {}) as Record<string, number>;
  const tabList = tabs
    ? [
        { value: 'all', label: t('orders.tabs.all'), count: counts?.all, filter: {} as Partial<ListFilter> },
        ...(['to_prepare', 'prepared', 'shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'returning', 'returned', 'delivered'] as FollowStatus[])
          .filter((s) => (FOLLOW_STATUSES as readonly string[]).includes(s) && (F[s] ?? 0) > 0)
          .map((s) => ({ value: s, label: t(`status.follow.${s}`), count: F[s], filter: { follow: [s] } as Partial<ListFilter> })),
        { value: 'cancelled', label: t('status.conf.cancelled'), count: undefined, filter: { conf: CONF_DONE_BAD } as Partial<ListFilter> },
      ]
    : null;
  const tabFilter = tabList?.find((x) => x.value === tab)?.filter ?? {};
  const common = toListInput({ wilaya: f.wilaya, channel: f.channel, reason: f.reason, from: f.from, to: f.to, q: dq }, reasonOf);
  const input = { ...common, ...base, ...tabFilter, sort, dir, page, pageSize: size, ...allScope(f, opts, kept, 'agentId') };
  const key = JSON.stringify({ ...input, page: 0 });
  useEffect(() => setPage(1), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRpcFor('all', 'orders.list', input as never, { refetchInterval: 60_000 });
  const rows = (list.data?.rows ?? undefined) as Row<Order>[] | undefined;
  return (
    <Card title={title} actions={<AllChip />}>
      {tabList && <Tabs value={tab} onChange={setTab} items={tabList.map((x) => ({ value: x.value, label: x.label, count: x.count }))} />}
      <AllBar f={f} set={set} clear={clear} show={show} reasonOf={reasonOf} search={{ value: q, onChange: setQ }} chips={false} />
      {list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <OrderTable
          rows={rows}
          total={list.data?.total ?? 0}
          page={page}
          pageSize={size}
          onPage={setPage}
          onSize={(s) => (setSize(s), setPage(1))}
          loading={list.isLoading}
          lead={{ key: 'boutique', label: t('boutiques.all.col'), cell: (o) => <BoutiqueTag id={(o as Row<Order>).seller.id} name={(o as Row<Order>).seller.name} /> }}
          sort={sort}
          dir={dir}
          onSort={(k, d) => (setSort(k), setDir(d), setPage(1))}
          onRow={(o) => openOrder(o.id, (o as Row<Order>).seller.id)}
          resetKey={key}
        />
      )}
    </Card>
  );
}

export function BoutiquesOrders({ sub }: PageProps) {
  const { t } = useTranslation();
  const base: AllKey[] = ['agent', 'team', 'product', 'company', 'livreur', 'wilaya', 'channel', 'dates'];
  if (sub === 'livrees')
    return (
      <>
        <AllCounts on="livrees" />
        <AllOrderList id="livrees" title={t('orders.delivered')} base={{ follow: ['delivered'], dateField: 'delivered_at' }} show={base} defaultSort="delivered_at" />
      </>
    );
  if (sub === 'annulees')
    return (
      <>
        <AllCounts on="annulees" />
        <AllOrderList id="annulees-conf" title={t('orders.cancelledConf')} base={{ conf: CONF_DONE_BAD }} show={['agent', 'team', 'product', 'wilaya', 'channel', 'reason', 'dates']} reasonOf="conf" />
        <AllOrderList id="annulees-ret" title={t('orders.cancelledReturns')} base={{ follow: ['returning', 'returned'] }} show={[...base, 'reason']} reasonOf="back" defaultSort="updated_at" />
      </>
    );
  return (
    <>
      <AllCounts />
      <AllOrderList id="tout" title={t('orders.allOrders')} show={base} tabs />
    </>
  );
}

// ---------------------------------------------------------------- Confirmation, Suivi
export function BoutiquesConfirmation(props: PageProps) {
  const kept = useShopFilter();
  const opts = useAllOptions();
  const [f, set, clear] = useAllFilters('conf');
  const input = {
    ...allScope(f, opts, kept, 'agentId'),
    ...(f.wilaya ? { wilayaId: Number(f.wilaya) } : {}),
    ...(f.channel ? { channel: f.channel } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
  };
  const scope: AllScope = {
    ...useScopeBase(),
    bar: <AllBar f={f} set={set} clear={clear} show={['agent', 'team', 'product', 'wilaya', 'channel', 'dates']} />,
    input,
    counts: keptInput(kept),
  };
  return (
    <SellerScope seller="all" ambient={false}>
      <AllConfirmation {...props} scope={scope} />
    </SellerScope>
  );
}

/**
 * Opens one of the boutiques at an address (« Ouvrir »): « Toutes les boutiques » goes off, else the page would show them
 * all again.
 */
function useOpenBoutique() {
  const { t } = useTranslation();
  const { switchStore } = useSession();
  const all = useAllMode();
  const [busy, setBusy] = useState<number | null>(null);
  const open = async (id: number, hash: string) => {
    setBusy(id);
    try {
      if (!all.boutiques.find((b) => b.id === id)?.current) await switchStore(id);
      setAllOn(false);
      location.hash = hash;
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(null);
    }
  };
  return { open, busy };
}

/** What works one boutique at a time (Suivi › Réclamation, Swap, Bloqués; Caisse › À recevoir…): the boutique to open. */
function OneBoutique({ what, hash }: { what: string; hash: string }) {
  const { t } = useTranslation();
  const all = useAllMode();
  const ob = useOpenBoutique();
  return (
    <Empty>
      <p>{t('boutiques.all.oneAtATime', { what })}</p>
      <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        {all.boutiques.map((b) => (
          <button key={b.id} type="button" className="btn" disabled={ob.busy !== null} onClick={() => void ob.open(b.id, hash)}>
            <BoutiqueLogo name={b.name} logo={b.logo} size={22} /> {b.name}
          </button>
        ))}
      </div>
    </Empty>
  );
}

export function BoutiquesSuivi(props: PageProps) {
  const { t } = useTranslation();
  const kept = useShopFilter();
  const opts = useAllOptions();
  const [f, set, clear] = useAllFilters('suivi');
  const input = {
    ...allScope(f, opts, kept, 'followAgentId'),
    ...(f.wilaya ? { wilayaId: Number(f.wilaya) } : {}),
    ...(f.from ? { from: dayIso(f.from) } : {}),
    ...(f.to ? { to: dayIso(f.to, true) } : {}),
  };
  const scope: AllScope = {
    ...useScopeBase(),
    bar: <AllBar f={f} set={set} clear={clear} show={['agent', 'product', 'company', 'livreur', 'wilaya', 'dates']} agentKind="follow" />,
    input,
    counts: keptInput(kept),
    tabs: ['enlivraison', 'alertes', 'traites', 'livres', 'annules'],
  };
  if (props.sub === 'reclamation' || props.sub === 'swap' || props.sub === 'bloques') return <OneBoutique what={t(`suivi.tabs.${props.sub}`)} hash={`#/suivi/${props.sub}`} />;
  return (
    <SellerScope seller="all" ambient={false}>
      <AllSuivi {...props} scope={scope} />
    </SellerScope>
  );
}

// ---------------------------------------------------------------- what each boutique answers
/** The boutiques kept that gave no answer (no access to that page there): named under the totals. */
function useLeftOut(rows: { id: number }[] | undefined): string[] {
  const all = useAllMode();
  const kept = useShopFilter();
  if (!rows) return [];
  return all.boutiques.filter((b) => (!kept || kept.includes(b.id)) && !rows.some((r) => r.id === b.id)).map((b) => b.name);
}

/** A boutique's name and logo, first cell of a « Par boutique » row. */
function ByName({ id, name }: { id: number; name: string }) {
  const all = useAllMode();
  const bq = all.boutiques.find((x) => x.id === id);
  return (
    <span className="bq-tag">
      <BoutiqueLogo name={name} logo={bq?.logo ?? null} size={24} />
      <span>{name}</span>
    </span>
  );
}

// ---------------------------------------------------------------- Dépôt
type DepotN = { preparer: number; prepares: number; dispatchees: number; retours: number; noStock: number; noStockLate: number; prepAlerts: number };
type DepotAll = DepotN & { byBoutique?: (DepotN & { id: number; name: string })[] };
type DepotCol = DepotStage | 'noStock';

/** « Par boutique »: what waits at each stage in each boutique; « Ouvrir » goes to that boutique's Dépôt. */
function DepotByBoutique({ c, error, retry, stage }: { c?: DepotAll; error: Error | null; retry: () => void; stage: DepotStage }) {
  const { t } = useTranslation();
  const ob = useOpenBoutique();
  const rows = c?.byBoutique ?? [];
  const left = useLeftOut(c ? rows : undefined);
  const cols: { k: DepotCol; label: string }[] = [...DEPOT_STAGES.map((k) => ({ k: k as DepotCol, label: t(`depot.stage.${k}`) })), { k: 'noStock', label: t('depot.ns.tab') }];
  const cls = (k: DepotCol) => `num${k === stage ? ' bq-on' : ''}`;
  // « En dispatch »: refused by the company, to cancel by hand, waiting over 24 h; « Sans stock »: waiting too long
  const cell = (r: DepotN, k: DepotCol) => {
    const warn = k === 'prepares' ? r.prepAlerts : k === 'noStock' ? r.noStockLate : 0;
    return (
      <>
        <span className="ltr">{n(r[k] ?? 0)}</span>
        {warn > 0 && (
          <span className="badge t-bad bq-alert ltr" title={t(k === 'prepares' ? 'boutiques.all.prepAlerts' : 'boutiques.all.noStockLate', { count: warn })}>
            <Icon name="alert" /> {n(warn)}
          </span>
        )}
      </>
    );
  };
  return (
    <Card title={t('boutiques.all.byBoutique')} actions={<AllChip />}>
      <BoutiqueChips />
      {error ? (
        <ErrorBox error={error} onRetry={retry} />
      ) : !c ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>{t('depot.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl bq-by">
            <thead>
              <tr>
                <th>{t('boutiques.all.col')}</th>
                {cols.map((x) => (
                  <th key={x.k} className={cls(x.k)}>
                    {x.label}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-l={t('boutiques.all.col')}>
                    <ByName id={r.id} name={r.name} />
                  </td>
                  {cols.map((x) => (
                    <td key={x.k} className={cls(x.k)} data-l={x.label}>
                      {cell(r, x.k)}
                    </td>
                  ))}
                  <td className="bq-go" data-l="">
                    <button type="button" className="btn small" disabled={ob.busy !== null} onClick={() => void ob.open(r.id, `#/depot/${stage}`)}>
                      {t('boutiques.all.open')}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length > 1 && (
                <tr className="bq-by-total">
                  <td data-l="">
                    <b>{t('boutiques.all.total')}</b>
                  </td>
                  {cols.map((x) => (
                    <td key={x.k} className={cls(x.k)} data-l={x.label}>
                      {cell(c, x.k)}
                    </td>
                  ))}
                  <td data-l="" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {left.length > 0 && <p className="muted small">{t('boutiques.all.leftOutDepot', { names: left.join(', ') })}</p>}
    </Card>
  );
}

/** « Réceptionner un retour » over every boutique kept: the parcel is found in its boutique and received there. */
function AllReceive() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const kept = useShopFilter();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Row<Order>[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [doing, setDoing] = useState<string | null>(null);
  const search = async () => {
    const c = code.trim().replace(/[,()"*]/g, '');
    if (!c) return;
    setBusy(true);
    try {
      setFound((await rpc('depot.find', { code: c, ...keptInput(kept) } as never, 'all')) as unknown as Row<Order>[]);
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  // inside the order's own boutique: its stock comes back there
  const receive = async (o: Row<Order>) => {
    setDoing(`${o.seller.id}:${o.id}`);
    try {
      const r = await rpc('depot.receiveReturn', { id: o.id }, o.seller.id);
      toast(t('depot.receive.done', { ref: r.ref }), 'ok');
      setFound(null);
      setCode('');
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setDoing(null);
      qc.invalidateQueries();
    }
  };
  return (
    <Card title={t('depot.receive.title')} actions={<AllChip />}>
      <p className="muted">{t('boutiques.all.receiveHelp')}</p>
      <div className="row">
        <div className="grow">
          <input
            type="search"
            autoComplete="off"
            placeholder={t('depot.receive.ph')}
            aria-label={t('depot.receive.ph')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
        </div>
        <button type="button" className="btn primary" onClick={() => void search()} disabled={busy}>
          {t('depot.receive.search')}
        </button>
      </div>
      {found &&
        (found.length ? (
          <div className="tbl-wrap" style={{ marginTop: 10 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('boutiques.all.col')}</th>
                  <th>{t('depot.cols.order')}</th>
                  <th>{t('depot.cols.client')}</th>
                  <th className="wide">{t('depot.cols.products')}</th>
                  <th>{t('depot.cols.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {found.map((o) => (
                  <tr key={`${o.seller.id}:${o.id}`} className="clickable" onClick={() => openOrder(o.id, o.seller.id)}>
                    <td data-l={t('boutiques.all.col')}>
                      <BoutiqueTag id={o.seller.id} name={o.seller.name} />
                    </td>
                    <td data-l={t('depot.cols.order')}>
                      <b className="ltr">{o.ref}</b>
                      {trackOf(o) && <CopyCode code={trackOf(o)} small />}
                    </td>
                    <td data-l={t('depot.cols.client')}>
                      {o.customerName}
                      <small className="ltr">{o.phone}</small>
                    </td>
                    <td className="wide" data-l={t('depot.cols.products')}>
                      {itemsLine(o)} <span className="muted ltr">· {da(o.total)}</span>
                    </td>
                    <td data-l={t('depot.cols.status')}>{o.followStatus ? <StatusBadge kind="follow" status={o.followStatus} /> : <StatusBadge kind="conf" status={o.confStatus} />}</td>
                    <td data-l="" onClick={(e) => e.stopPropagation()}>
                      {o.followStatus === 'returned' ? (
                        <span className="badge t-ok">{t('depot.receive.already')}</span>
                      ) : (
                        <button type="button" className="btn small ok" disabled={!o.shippedAt || doing !== null} onClick={() => void receive(o)}>
                          {t('depot.receive.button')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            {t('depot.receive.none')}
          </p>
        ))}
    </Card>
  );
}

/**
 * « Dépôt » with « Toutes les boutiques »: what waits at each stage (added up, then boutique by boutique), the orders of
 * the stage from every boutique (each opened inside its boutique), and a return received wherever it belongs. Picking,
 * labels, bags and sending to the companies stay in each boutique's own Dépôt (« Ouvrir »).
 */
export function BoutiquesDepot({ sub }: PageProps) {
  const { t } = useTranslation();
  const stage = depotStage(sub);
  const phone = useIsPhone();
  const kept = useShopFilter();
  const q = useRpcFor('all', 'depot.counts', keptInput(kept) as never, { refetchInterval: 60_000 });
  const c = q.data as unknown as DepotAll | undefined;
  const show: AllKey[] = ['product', 'company', 'livreur', 'wilaya', 'dates'];
  return (
    <>
      <DepotStageBar stage={stage} counts={c} phone={phone} />
      <DepotByBoutique c={c} error={q.error} retry={() => void q.refetch()} stage={stage} />
      <p className="muted small bq-note">{t('boutiques.all.depotNote')}</p>
      {stage === 'preparer' && <AllOrderList key="preparer" id="depot-preparer" title={t('depot.lists.preparer')} base={{ conf: ['confirmed'], follow: ['to_prepare'] }} show={show} defaultSort="confirmed_at" defaultDir="asc" />}
      {stage === 'prepares' && <AllOrderList key="prepares" id="depot-prepares" title={t('depot.lists.prepares')} base={{ conf: ['confirmed'], follow: ['prepared'] }} show={show} defaultSort="updated_at" defaultDir="asc" />}
      {stage === 'dispatchees' && <AllOrderList key="dispatchees" id="depot-dispatchees" title={t('depot.lists.dispatchees')} base={{ conf: ['confirmed'], follow: ['shipped'] }} show={show} defaultSort="shipped_at" defaultDir="asc" />}
      {stage === 'retours' && (
        <>
          <AllReceive />
          <AllOrderList key="returning" id="depot-returning" title={t('depot.lists.returning')} base={{ follow: ['returning'] }} show={[...show, 'reason']} reasonOf="back" defaultSort="updated_at" defaultDir="asc" />
          <AllOrderList key="exchange" id="depot-exchange" title={t('depot.lists.exchange')} base={{ follow: ['in_exchange'] }} show={show} defaultSort="updated_at" defaultDir="asc" />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Caisse
type CaisseN = { main: number; today: number; bank: number | null; own: number; companies: number; livreurs: number; employees: number; outside: number; tickets: number };
type CaisseAll = CaisseN & { byBoutique: (CaisseN & { id: number; name: string })[] };
const sgn = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${da(Math.abs(v))}`;
/** Caisse's tabs that work on one boutique's own money (receive a payment, cancel one, its journal…). */
const CAISSE_ONE: Record<string, string> = { due: 'caisse.tabs.due', done: 'caisse.tabs.done', livreurs: 'caisse.tabs.livreurs', journal: 'caisse.ph.journal' };

/**
 * « Caisse » with « Toutes les boutiques »: the money of every boutique added up (the main caisses, the bank, the other
 * caisses, the money outside), then boutique by boutique. Each boutique's money stays its own: an expense, a transfer,
 * « Argent reçu » are made in its caisse (« Ouvrir »).
 */
export function BoutiquesCaisse({ sub }: PageProps) {
  const { t } = useTranslation();
  const kept = useShopFilter();
  const ob = useOpenBoutique();
  const one = sub ? CAISSE_ONE[sub] : undefined;
  const q = useRpcFor('all', 'caisse.overview', keptInput(kept) as never, { refetchInterval: 60_000, enabled: !one });
  const d = q.data as unknown as CaisseAll | undefined;
  const rows = d?.byBoutique ?? [];
  const left = useLeftOut(d ? rows : undefined);
  if (one) return <OneBoutique what={t(one)} hash={`#/caisse/${sub}`} />;
  const bank = rows.some((r) => r.bank !== null);
  const cols: { k: keyof CaisseN; label: string }[] = [
    { k: 'main', label: t('caisse.ph.main') },
    ...(bank ? [{ k: 'bank' as const, label: t('caisse.ph.bank') }] : []),
    { k: 'own', label: t('caisse.set.mine') },
    { k: 'companies', label: t('caisse.ph.companies') },
    { k: 'livreurs', label: t('caisse.ph.livreurs') },
    { k: 'employees', label: t('caisse.ph.employees') },
    { k: 'outside', label: t('caisse.ph.outside') },
  ];
  const cell = (r: CaisseN, k: keyof CaisseN) => {
    const v = r[k];
    if (v === null) return <span className="muted">—</span>;
    return (
      <>
        <span className="ltr">{da(v)}</span>
        {k === 'main' && r.today !== 0 && <small className={`ltr bq-today ${r.today > 0 ? 'up' : 'down'}`}>{t('caisse.ph.today', { v: sgn(r.today) })}</small>}
      </>
    );
  };
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>{t('caisse.title')}</h2>
          <AllChip />
        </div>
        <BoutiqueChips />
        {q.error ? (
          <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
        ) : !d ? (
          <Loading />
        ) : (
          <Kpis>
            <KpiBox icon="wallet" label={t('caisse.ph.main')} value={da(d.main)} sub={d.today !== 0 ? t('caisse.ph.today', { v: sgn(d.today) }) : t('boutiques.all.mainSub')} />
            {d.bank !== null && <KpiBox icon="building" label={t('caisse.ph.bank')} value={da(d.bank)} zero={!d.bank} />}
            <KpiBox icon="coins" label={t('caisse.set.mine')} value={da(d.own)} sub={t('boutiques.all.ownSub')} zero={!d.own} />
            <KpiBox icon="truck" label={t('caisse.ph.outside')} value={da(d.outside)} sub={t('caisse.dk.outsideSub')} tone={d.outside ? 'info' : undefined} zero={!d.outside} />
            {d.tickets !== 0 && <KpiBox icon="headset" label={t('caisse.tickets.title')} value={da(d.tickets)} />}
          </Kpis>
        )}
      </div>
      <Card title={t('boutiques.all.byBoutique')}>
        {!d ? (
          q.error ? null : <Loading />
        ) : !rows.length ? (
          <Empty>{t('boutiques.all.noCaisse')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl bq-by">
              <thead>
                <tr>
                  <th>{t('boutiques.all.col')}</th>
                  {cols.map((x) => (
                    <th key={x.k} className="num">
                      {x.label}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-l={t('boutiques.all.col')}>
                      <ByName id={r.id} name={r.name} />
                    </td>
                    {cols.map((x) => (
                      <td key={x.k} className="num" data-l={x.label}>
                        {cell(r, x.k)}
                      </td>
                    ))}
                    <td className="bq-go" data-l="">
                      <button type="button" className="btn small" disabled={ob.busy !== null} onClick={() => void ob.open(r.id, '#/caisse/overview')}>
                        {t('boutiques.all.open')}
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length > 1 && (
                  <tr className="bq-by-total">
                    <td data-l="">
                      <b>{t('boutiques.all.total')}</b>
                    </td>
                    {cols.map((x) => (
                      <td key={x.k} className="num" data-l={x.label}>
                        {cell(d, x.k)}
                      </td>
                    ))}
                    <td data-l="" />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t('boutiques.all.caisseNote')}</p>
        {left.length > 0 && <p className="muted small">{t('boutiques.all.leftOutCaisse', { names: left.join(', ') })}</p>}
      </Card>
    </>
  );
}
