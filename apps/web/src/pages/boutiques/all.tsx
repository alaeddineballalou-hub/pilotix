// « Toutes les boutiques » (layout/AllBoutiques.tsx): the screens that show every boutique of the person together.
// - Accueil and Dashboard: what is waiting now and the period, added up, then boutique by boutique;
// - Commandes: one list of every boutique's orders (each with its boutique), opened inside its boutique;
// - Confirmation and Suivi: the lists of a partner's « Tous les vendeurs » (agency/work.tsx), with the boutiques' filters.
// The « Boutique » filter keeps some of them; Agent, Équipe, Produit, Société and Livreur list each boutique's own.
import { CONF_DONE_BAD, CONF_TODO, FOLLOW_STATUSES, FollowStatus, Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dayRange, n, pct } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpcFor } from '../../lib/query';
import { SellerScope } from '../../lib/seller';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorBox, Kpis, Loading, Tabs, Trend } from '../../ui/kit';
import { allCount, AllF, AllFields, AllKey, allScope, BoutiqueChips, BoutiqueTag, StackLogo, useAllFilters, useAllMode, useAllOptions, useShopFilter } from '../../layout/AllBoutiques';
import { BoutiqueLogo } from '../../layout/Boutiques';
import { AllConfirmation, AllScope, AllSuivi } from '../agency/work';
import { PeriodChips } from '../dashboard/board/parts';
import { useBoardPeriod } from '../dashboard/board/Board';
import { delivTone, KpiBox, prevRangeOf } from '../dashboard/util';
import { useDebounced } from '../depot/OrderList';
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
            <KpiBox icon="package" label={t('home.toPrepare')} value={n(N.toPrepare)} sub={t('home.prepared', { n: N.prepared })} />
            <KpiBox icon="truck" label={t('home.onRoad')} value={n(N.onRoad)} sub={t('home.failed', { n: N.failed })} tone={N.failed ? 'warn' : undefined} href={has('suivi') ? '#/suivi' : undefined} />
            {N.moneyDue !== null && N.moneyDue !== undefined && <KpiBox icon="wallet" label={t('home.moneyDue')} value={da(N.moneyDue)} sub={t('home.moneyDueSub', { n: N.moneyDueCount ?? 0 })} tone={N.moneyDue ? 'info' : undefined} />}
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
function AllOrderList({ id, title, base, show, reasonOf, defaultSort = 'created_at', tabs }: { id: string; title: string; base?: Partial<ListFilter>; show: AllKey[]; reasonOf?: 'conf' | 'back'; defaultSort?: OrderSort; tabs?: boolean }) {
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
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
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

/** Réclamation, Swap and Bloqués work one boutique at a time. */
function OneBoutique({ what }: { what: string }) {
  const { t } = useTranslation();
  const { switchStore } = useSession();
  const all = useAllMode();
  return (
    <Empty>
      <p>{t('boutiques.all.oneAtATime', { what: t(`suivi.tabs.${what}`) })}</p>
      <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        {all.boutiques.map((b) => (
          <button key={b.id} type="button" className="btn" onClick={() => void switchStore(b.id).then(() => (location.hash = `#/suivi/${what}`))}>
            <BoutiqueLogo name={b.name} logo={b.logo} size={22} /> {b.name}
          </button>
        ))}
      </div>
    </Empty>
  );
}

export function BoutiquesSuivi(props: PageProps) {
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
  if (props.sub === 'reclamation' || props.sub === 'swap' || props.sub === 'bloques') return <OneBoutique what={props.sub} />;
  return (
    <SellerScope seller="all" ambient={false}>
      <AllSuivi {...props} scope={scope} />
    </SellerScope>
  );
}
