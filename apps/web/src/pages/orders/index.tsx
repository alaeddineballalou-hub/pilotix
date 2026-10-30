// Commandes (all orders, Livré, Annulé) and the hidden Livrées / Retournées pages — as in the original app.
import { canSetFollow, CONF_DONE_BAD, CONF_STATUSES, CONF_TODO, FOLLOW_ON_ROAD, FOLLOW_STATUSES, FollowStatus, Order, SALES_CHANNELS, WILAYAS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, n, pct, syncProblems } from '../../lib/format';
import { openOrderForm } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { Card, ErrorBox, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { API_KINDS, callOptional } from './OrderCard';
import { ExtraColumn, OrderColumn, OrderSort, OrderTable } from './OrderTable';
import { ConfFilter, exportOrdersCsv, FollowFilter, ListFilter, printSlips, toListInput } from './shared';
import './orders.css';
import { useCounts } from './counts';
import { useIsPhone } from '../../lib/useMedia';
import { useViewMode, ViewSwitch } from '../../ui/ViewSwitch';
import { PhoneAnnule, PhoneLivre } from './PhoneDone';

export { OrderTable } from './OrderTable';
export type { OrderColumn, ExtraColumn, OrderTableProps } from './OrderTable';

/** The "Commandes" card with its 5 KPI tabs (Confirmation, Dépôt, Suivi, Livré, Annulé). */
function HeaderKpis({ on }: { on?: 'livrees' | 'annulees' }) {
  const { t } = useTranslation();
  const c = useCounts();
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
        {k('depot', '#/depot', t('orders.kpi.depot'), c?.depot, t('orders.kpi.depotS'))}
        {k('suivi', '#/suivi', t('orders.kpi.suivi'), c?.suivi, t('orders.kpi.suiviS'))}
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

// ---------------------------------------------------------------- the generic filtered list
type FilterKey = 'search' | 'conf' | 'follow' | 'company' | 'wilaya' | 'channel' | 'agent' | 'dates';
interface Filters {
  conf: ConfFilter;
  follow: FollowFilter;
  company: string;
  wilaya: string;
  channel: string;
  agent: string;
  from: string;
  to: string;
  q: string;
}
const NO_FILTERS: Filters = { conf: '', follow: '', company: '', wilaya: '', channel: '', agent: '', from: '', to: '', q: '' };

interface ListProps {
  id: string;
  title: ReactNode;
  headActions?: ReactNode;
  /** fixed part of the query (e.g. only delivered orders) */
  base?: Partial<ListFilter>;
  show?: FilterKey[];
  /** search text coming from the big search above */
  q?: string;
  tabs?: { value: string; label: string; count?: number; filter: Partial<ListFilter> }[];
  columns?: OrderColumn[];
  extra?: (rows: Order[]) => ExtraColumn[];
  defaultSort?: OrderSort;
  pageSize?: number;
}

const ALL_FILTERS: FilterKey[] = ['search', 'conf', 'follow', 'company', 'wilaya', 'channel', 'agent', 'dates'];

export function OrderList(p: ListProps) {
  const { t } = useTranslation();
  const { has, session } = useSession();
  const qc = useQueryClient();
  const show = p.show ?? ALL_FILTERS;
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

  const look = useRpc('orders.lookups', {}, { staleTime: 5 * 60_000 });
  const agents = useRpc('users.list', { role: 'confirmation' }, { staleTime: 5 * 60_000 });
  const companies = look.data?.companies ?? [];
  const tabFilter = p.tabs?.find((x) => x.value === tab)?.filter ?? {};
  const q = (p.q ?? '').trim() || f.q.trim();
  const input: ListFilter = { ...toListInput({ ...f, q }), ...p.base, ...tabFilter, sort, dir, page, pageSize: size } as ListFilter;
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
              toast(t('orders.bulk.changed', { count: r.changed.length }), 'ok');
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
          )
        }
      >
        {t('orders.bulk.print')}
      </button>
      <button className="btn small" onClick={() => exportOrdersCsv(t, sel)}>
        {t('orders.bulk.export')}
      </button>
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
    ...CONF_STATUSES.filter((s) => s !== 'busy').map((s): [string, string] => [s, s === 'no_answer' ? t('orders.f.attempt') : t(`status.conf.${s}`)]),
  ];
  const followOpts: [string, string][] = [['prep', t('orders.f.prep')], ['active', t('orders.f.active')], ['back', t('orders.f.back')], ...FOLLOW_STATUSES.map((s): [string, string] => [s, t(`status.follow.${s}`)])];

  return (
    <Card title={p.title} actions={p.headActions}>
      {p.tabs && <Tabs value={tab} onChange={setTab} items={p.tabs.map((x) => ({ value: x.value, label: x.label, count: x.count }))} />}
      <div className={`filters${open ? ' open' : ''}`}>
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
        {show.includes('agent') && sel('agent', t('orders.f.agent'), (agents.data ?? []).map((u): [string, string] => [String(u.id), u.name]), t('orders.f.allM'))}
        {show.includes('dates') && (
          <>
            <label className="field more-f">
              <span className="lab">{t('orders.f.from')}</span>
              <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label className="field more-f">
              <span className="lab">{t('orders.f.to')}</span>
              <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
            </label>
          </>
        )}
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
          extra={extra}
          sort={sort}
          dir={dir}
          onSort={(k, d) => {
            setSort(k);
            setDir(d);
            setPage(1);
          }}
          selectable
          bulk={bulk}
          resetKey={resetKey}
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
  const fees = T ? T.fees + T.overweight + T.returnFees + T.returnOverweight : 0;
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
            <Kpi label={t('orders.bilan.ret')} value={da(T.returnFees + T.returnOverweight)} sub={t('orders.bilan.retS', { n: n(T.returns) })} tone={T.returns ? 'bad' : undefined} />
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
export function Commandes({ sub }: PageProps) {
  // Livré and Annulé: the stats you tap and the cards (phones; computers too, laid out wide), or the big table
  const phone = useIsPhone();
  const [mode, setMode] = useViewMode('orders-done');
  const done = sub === 'livrees' || sub === 'annulees';
  if (done && (phone || mode === 'cards')) return sub === 'livrees' ? <PhoneLivre onTable={() => setMode('table')} /> : <PhoneAnnule onTable={() => setMode('table')} />;
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
  const { has } = useSession();
  const [q, setQ] = useState('');
  const c = useCounts();
  const deliveredExtra = useDeliveredExtra();
  const [syncing, setSyncing] = useState(false);
  const qc = useQueryClient();

  const syncBtn = has('suivi', 'depot') && (
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
  const newBtn = has('confirmation', 'suivi', 'depot') && (
    <button className="btn primary" onClick={() => openOrderForm()}>
      {t('orders.plusNew')}
    </button>
  );

  if (sub === 'livrees')
    return (
      <>
        <HeaderKpis on="livrees" />
        {has('suivi', 'depot') && <DeliveredReport />}
        <OrderList
          id="livrees"
          title={t('orders.delivered')}
          base={{ follow: ['delivered'], dateField: 'delivered_at' }}
          show={['search', 'conf', 'company', 'wilaya', 'channel', 'agent', 'dates']}
          extra={deliveredExtra}
          defaultSort="delivered_at"
        />
      </>
    );

  if (sub === 'annulees')
    return (
      <>
        <HeaderKpis on="annulees" />
        <OrderList id="annulees-conf" title={t('orders.cancelledConf')} base={{ conf: CONF_DONE_BAD }} show={['search', 'follow', 'company', 'wilaya', 'channel', 'agent', 'dates']} />
        <OrderList id="annulees-ret" title={t('orders.cancelledReturns')} base={{ follow: ['returning', 'returned'] }} show={['search', 'conf', 'company', 'wilaya', 'channel', 'agent', 'dates']} defaultSort="updated_at" />
      </>
    );

  // all orders
  const F = c?.raw.follow ?? {};
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
  return (
    <>
      <DoneKpis />
      <OrderList id="p-livrees" title={t('orders.delivered')} base={{ follow: ['delivered'], dateField: 'delivered_at' }} show={['search', 'company', 'wilaya', 'channel', 'agent', 'dates']} extra={extra} defaultSort="delivered_at" />
    </>
  );
}

export function Retournees(_: PageProps) {
  const { t } = useTranslation();
  return (
    <>
      <DoneKpis />
      <OrderList id="p-retournees" title={t('orders.returned')} base={{ follow: ['returning', 'returned'] }} show={['search', 'follow', 'company', 'wilaya', 'channel', 'agent', 'dates']} defaultSort="updated_at" />
    </>
  );
}

export { API_KINDS };
