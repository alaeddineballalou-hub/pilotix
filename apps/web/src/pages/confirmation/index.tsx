// Confirmation: Nouvelles › En cours › Confirmées (+ Terminées). Same screens as the original app.
import { SALES_CHANNELS, SalesChannel, WILAYAS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { downloadCsv } from '../../lib/files';
import { da, dateTime, n, when, wilaya, wilayaName } from '../../lib/format';
import { openOrderForm } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { ErrorBox, Field, Help, Icon, Loading, Pager, SortTh, StageBar, StatusBadge, StatusSelect } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { Countdown, useNow } from './Countdown';
import { Detail } from './Detail';
import { Focus } from './Focus';
import { BULK_CHOICES, choiceLabel, currentLabel, ROW_CHOICES, StatusChoice, Sub, SUB_STATUSES, SUB_TONE, SUBS, telHref, toneOf, waHref } from './shared';
import { StatsSection } from './Stats';
import { useStatusChange } from './StatusDialog';

type Row = NonNullable<ReturnType<typeof useList>['data']>['rows'][number];
type SortKey = 'created_at' | 'confirmed_at' | 'next_call_at' | 'total' | 'customer_name';
type ColKey = 'source' | 'tracking' | 'creator' | 'channel' | 'product' | 'sku' | 'name' | 'phone' | 'wilaya' | 'commune' | 'agent' | 'total' | 'time' | 'created' | 'stock' | 'desk' | 'passed' | 'confirmed' | 'follow' | 'next' | 'status';
interface Filters {
  wilayaId?: number;
  agentId?: number | 'none';
  channel?: SalesChannel;
  status?: string;
  from?: string;
  to?: string;
}

const DEFAULT_SORT: Record<Sub, { sort: SortKey; dir: 'asc' | 'desc' }> = {
  nouvelles: { sort: 'created_at', dir: 'desc' },
  attente: { sort: 'next_call_at', dir: 'asc' },
  confirmees: { sort: 'confirmed_at', dir: 'desc' },
  terminees: { sort: 'created_at', dir: 'desc' },
};
const columnsOf = (sub: Sub): { k: ColKey; sort?: SortKey }[] => [
  { k: 'source' },
  { k: 'tracking' },
  { k: 'creator' },
  { k: 'channel' },
  { k: 'product' },
  { k: 'sku' },
  { k: 'name', sort: 'customer_name' },
  { k: 'phone' },
  { k: 'wilaya' },
  { k: 'commune' },
  { k: 'agent' },
  { k: 'total', sort: 'total' },
  { k: 'time', sort: 'created_at' },
  { k: 'created', sort: 'created_at' },
  { k: 'stock' },
  { k: 'desk' },
  { k: 'passed' },
  ...(sub === 'confirmees' ? [{ k: 'confirmed' as const, sort: 'confirmed_at' as const }, { k: 'follow' as const }] : [{ k: 'next' as const, sort: 'next_call_at' as const }]),
  { k: 'status' },
];

function useList(sub: Sub, input: { q: string; f: Filters; sort: SortKey; dir: 'asc' | 'desc'; page: number; size: number }) {
  return useRpc(
    'confirmation.list',
    { sub, q: input.q || undefined, ...input.f, status: (input.f.status as any) || undefined, sort: input.sort, dir: input.dir, page: input.page, pageSize: input.size },
    { refetchInterval: 60_000 },
  );
}

export function Confirmation({ sub: rawSub, rest }: PageProps) {
  const { t } = useTranslation();
  const sub: Sub = SUBS.includes(rawSub as Sub) ? (rawSub as Sub) : 'nouvelles';
  const { has } = useSession();
  const counts = useRpc('confirmation.counts', {}, { refetchInterval: 60_000 });
  const manager = has('agent_manager', 'vendeur');
  const c = counts.data;
  const items = [
    { key: 'nouvelles', label: t('confirmation.sub.nouvelles'), href: '#/confirmation/nouvelles', count: c?.nouvelles },
    { key: 'attente', label: t('confirmation.sub.attente'), href: '#/confirmation/attente', count: c?.attente },
    { key: 'confirmees', label: t('confirmation.sub.confirmees'), href: '#/confirmation/confirmees', count: c?.confirmees },
    ...(sub === 'terminees' ? [{ key: 'terminees', label: t('confirmation.sub.terminees'), href: '#/confirmation/terminees', count: c?.terminees }] : []),
  ];
  const focusId = rest?.[0] ? Number(rest[0]) : null;
  return (
    <>
      <StageBar items={items} current={sub} />
      {manager && <StatsSection sub={sub} />}
      <Queue key={sub} sub={sub} focusId={focusId} />
    </>
  );
}

function Queue({ sub, focusId }: { sub: Sub; focusId: number | null }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const manager = has('agent_manager', 'vendeur');
  const meta = useRpc('confirmation.meta', {}, { staleTime: 5 * 60_000 });
  const COLS = useMemo(() => columnsOf(sub), [sub]);
  const colsKey = `conf-cols-${sub}`;
  const [visible, setVisible] = useState<Set<ColKey>>(() => new Set(store.json<ColKey[] | null>(colsKey, null) ?? COLS.map((c) => c.k)));
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [f, setF] = useState<Filters>({});
  const [panel, setPanel] = useState<'f' | 'c' | null>(null);
  const [{ sort, dir }, setSort] = useState(DEFAULT_SORT[sub]);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(() => Number(store.get('conf-size')) || 50);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState<number | null | 'ask'>(focusId ?? null);
  const [blockAsk, setBlockAsk] = useState<Row[] | null>(null);
  const [delAsk, setDelAsk] = useState<Row[] | null>(null);
  const { session } = useSession();
  const { change, dialog } = useStatusChange();
  useEffect(() => {
    const id = setTimeout(() => (setQd(q.trim()), setPage(1)), 350);
    return () => clearTimeout(id);
  }, [q]);
  const list = useList(sub, { q: qd, f, sort, dir, page, size });
  const rows = list.data?.rows ?? [];
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.id));
    setSel((s) => new Set([...s].filter((x) => ids.has(x))));
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = COLS.filter((c) => visible.has(c.k));
  const selected = rows.filter((r) => sel.has(r.id));
  const nFilters = Object.values(f).filter((v) => v !== undefined && v !== '').length;
  const shop = meta.data?.shopName ?? 'Pilotix';
  const tpl = meta.data?.whatsappTemplate ?? 'Bonjour {nom}, ici {boutique} à propos de votre commande {ref}.';
  const wa = (r: Row) => waHref(r.phone, tpl, { nom: r.customerName, boutique: shop, ref: r.ref });
  const setFilter = (p: Partial<Filters>) => {
    setF((cur) => ({ ...cur, ...p }));
    setPage(1);
  };
  const saveCols = (s: Set<ColKey>) => {
    setVisible(s);
    store.set(colsKey, JSON.stringify([...s]));
  };
  const onSort = (k: SortKey) => {
    setSort((cur) => (cur.sort === k ? { sort: k, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { sort: k, dir: k === 'total' ? 'desc' : 'asc' }));
    setPage(1);
  };
  const assign = async (rs: Row[], agentId: number | null) => {
    try {
      await rpc('orders.assignAgent', { ids: rs.map((r) => r.id), agentId });
      const name = meta.data?.agents.find((a) => a.id === agentId)?.name;
      toast(agentId ? t('confirmation.assigned', { n: rs.length, name }) : t('confirmation.unassigned', { n: rs.length }), 'ok');
      setSel(new Set());
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  const doExport = async () => {
    try {
      const all = await rpc('confirmation.list', { sub, q: qd || undefined, ...f, status: (f.status as any) || undefined, sort, dir, page: 1, pageSize: 3000 });
      const H = ['ref', 'created', 'client', 'phone', 'phone2', 'wilaya', 'commune', 'address', 'desk', 'products', 'pieces', 'productsDa', 'feeDa', 'discount', 'totalDa', 'conf', 'follow', 'company', 'tracking', 'agent', 'deliveryNote'];
      downloadCsv(`confirmation-${sub}-${new Date().toISOString().slice(0, 10)}`, [
        H.map((h) => t(`confirmation.csv.${h}`)),
        ...all.rows.map((o) => [
          o.ref,
          dateTime(o.createdAt),
          o.customerName,
          o.phone,
          o.phone2 ?? '',
          wilayaName(o.wilayaId),
          o.commune,
          o.address,
          o.isStopdesk ? t('common.yes') : t('common.no'),
          o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + '),
          o.items.reduce((s, i) => s + i.qty, 0),
          o.subtotal,
          o.deliveryFee,
          o.discount,
          o.total,
          t(`status.conf.${o.confStatus}`),
          o.followStatus ? t(`status.follow.${o.followStatus}`) : '',
          o.companyName ?? '',
          o.tracking ?? '',
          o.agentName ?? '',
          o.deliveryNote ?? '',
        ]),
      ]);
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };

  const title = t(`confirmation.title.${sub}`);
  const colLabel = (k: ColKey) => t(`confirmation.col.${k}`);

  const cell = (r: Row, k: ColKey): ReactNode => {
    switch (k) {
      case 'source':
        return <span className="chip">{(r.utm && (r.utm.utm_source || r.utm.source)) || r.source || t('confirmation.direct')}</span>;
      case 'tracking':
        return r.tracking ? <span className="ltr">{r.tracking}</span> : '—';
      case 'creator':
        return r.creatorName ?? <span className="muted">{t('confirmation.site')}</span>;
      case 'channel':
        return t(`status.channel.${r.channel}`, { defaultValue: r.channel });
      case 'product':
        return (
          <div className="px-clamp">
            <div className="qprod">{r.items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ''}${i.name}${i.variantTitle ? ` · ${i.variantTitle}` : ''}`).join(' + ') || '—'}</div>
          </div>
        );
      case 'sku':
        return r.skus.join(', ') || '—';
      case 'name':
        return (
          <>
            <b>{r.customerName}</b>
            {r.possibleDuplicate && <span className="flag dup">{t('confirmation.dup')}</span>}
            {r.blacklisted && <span className="flag">{t('confirmation.blacklist')}</span>}
          </>
        );
      case 'phone':
        return <span className="qph ltr">{r.phone}</span>;
      case 'wilaya':
        return wilayaName(r.wilayaId);
      case 'commune':
        return r.commune || '—';
      case 'agent':
        return r.agentId ? (
          <span className="row nowrap">
            <span className="badge t-info">{r.agentName ?? '—'}</span>
            {manager && (
              <button type="button" className="icon-btn qic qrm" aria-label={t('confirmation.removeAgentOf', { ref: r.ref })} title={t('confirmation.removeAgent')} onClick={(e) => (e.stopPropagation(), assign([r], null))}>
                −
              </button>
            )}
          </span>
        ) : (
          <span className="muted">—</span>
        );
      case 'total':
        return <span className="ltr">{da(r.total)}</span>;
      case 'time':
        return <Spent iso={r.createdAt} />;
      case 'created':
        return when(r.createdAt);
      case 'stock':
        return r.stock === null ? <span className="muted">—</span> : <span className={`badge t-${r.stock === 'ok' ? 'ok' : 'bad'}`}>{t(`confirmation.stock.${r.stock}`)}</span>;
      case 'desk':
        return r.isStopdesk ? <span className="badge t-info">{t('confirmation.desk')}</span> : <span className="muted">{t('confirmation.home')}</span>;
      case 'passed':
        return r.passed.length ? (
          <span className="px-passed">
            {r.passed.map((s, k) => (
              <StatusBadge key={k} kind="conf" status={s} />
            ))}
          </span>
        ) : (
          <span className="muted">—</span>
        );
      case 'confirmed':
        return when(r.confirmedAt);
      case 'follow':
        return (
          <>
            <StatusBadge kind="follow" status={r.followStatus} />
            {r.companyName && (
              <small>
                {r.companyName}
                {r.tracking ? ` · ${r.tracking}` : ''}
              </small>
            )}
          </>
        );
      case 'next':
        return r.nextCallAt ? (
          <>
            {when(r.nextCallAt)}
            {Date.parse(r.nextCallAt) <= Date.now() && <small>{t('confirmation.callNow')}</small>}
          </>
        ) : (
          '—'
        );
      case 'status': {
        const cur: StatusChoice = r.confStatus === 'no_answer' ? (`try${Math.min(3, Math.max(1, r.attempts))}` as StatusChoice) : r.confStatus;
        const opts = [{ value: cur, label: currentLabel(t, r.confStatus, r.attempts) }, ...ROW_CHOICES.filter((x) => x !== cur).map((x) => ({ value: x, label: choiceLabel(t, x, true) }))];
        return (
          <StatusSelect
            value={cur}
            tone={toneOf(cur)}
            label={t('confirmation.statusOf', { ref: r.ref })}
            options={opts}
            disabled={!has('confirmation')}
            onChange={(v) => {
              if (v !== cur) change([r], v);
            }}
          />
        );
      }
    }
  };

  const toggleOpen = (id: number) => setOpen((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s).add(id)));
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const canNext = (sub === 'nouvelles' || sub === 'attente') && has('confirmation');

  return (
    <>
      {focus !== null && <Focus initialId={focus === 'ask' ? null : focus} onClose={() => setFocus(null)} />}
      <div className="card qcard">
        <div className="card-head">
          <h2>
            {title} <span className={`badge t-${SUB_TONE[sub]} ltr`}>{n(list.data?.total ?? 0)}</span>
            <Help text={t(`confirmation.help.${sub}`)} label={title} />
          </h2>
          <div className="row">
            {canNext && focus === null && (
              <button type="button" className="btn" onClick={() => setFocus('ask')}>
                {t('confirmation.next')}
              </button>
            )}
            {has('confirmation') && (
              <button type="button" className="btn primary" onClick={() => openOrderForm({ onSaved: () => qc.invalidateQueries() })}>
                + {t('confirmation.newOrder')}
              </button>
            )}
          </div>
        </div>
        <Toolbar
          rows={selected}
          manager={manager}
          agents={meta.data?.agents ?? []}
          waHref={wa}
          onClear={() => setSel(new Set())}
          onAssign={assign}
          onStatus={async (c) => {
            if (await change(selected, c)) setSel(new Set());
          }}
          onBlock={() => setBlockAsk(selected)}
          onDelete={session?.isAdmin ? () => setDelAsk(selected) : undefined}
          onDuplicate={async () => {
            try {
              const r = await rpc('orders.duplicate', { ids: [selected[0].id] });
              toast(t('confirmation.duplicated', { ref: selected[0].ref }), 'ok');
              qc.invalidateQueries();
              if (r.ids[0]) openOrderForm({ orderId: r.ids[0], onSaved: () => qc.invalidateQueries() });
            } catch (e: any) {
              toast(e.message, 'bad');
            }
          }}
        />
        <div className="px-qtools">
          <label className="px-qsearch">
            <Icon name="search" />
            <input type="search" placeholder={t('confirmation.searchPh')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="px-qbtns">
            <button type="button" className={`px-qb px-qb-l ${panel === 'f' || nFilters ? 'on' : ''}`} aria-expanded={panel === 'f'} onClick={() => setPanel(panel === 'f' ? null : 'f')}>
              <Icon name="filter" />
              {t('common.filters')}
              {nFilters ? <b className="px-qb-n">{nFilters}</b> : null}
            </button>
            <span className="px-qpop-wrap">
              <button type="button" className={`px-qb ${panel === 'c' ? 'on' : ''}`} aria-expanded={panel === 'c'} title={`${t('common.columns')} (${visible.size}/${COLS.length})`} aria-label={t('common.columns')} onClick={() => setPanel(panel === 'c' ? null : 'c')}>
                <Icon name="columns" />
              </button>
              {panel === 'c' && (
                <div className="px-qpop" role="dialog" aria-label={t('common.columns')}>
                  {COLS.map((c) => (
                    <label key={c.k} className="px-qpop-it">
                      <span>{colLabel(c.k)}</span>
                      <input
                        type="checkbox"
                        checked={visible.has(c.k)}
                        onChange={(e) => {
                          const s2 = new Set(visible);
                          if (e.target.checked) s2.add(c.k);
                          else s2.delete(c.k);
                          saveCols(s2);
                        }}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => {
                      setVisible(new Set(COLS.map((c) => c.k)));
                      store.set(colsKey, null);
                    }}
                  >
                    {t('common.showAll')}
                  </button>
                </div>
              )}
            </span>
            <button type="button" className="px-qb" title={t('common.export')} aria-label={t('common.export')} onClick={doExport}>
              <Icon name="download" />
            </button>
            <button type="button" className={`px-qb ${list.isFetching ? 'spin' : ''}`} title={t('confirmation.refresh')} aria-label={t('confirmation.refresh')} onClick={() => list.refetch()}>
              <Icon name="refresh" />
            </button>
            <span className="px-qrange ltr">
              {list.data?.total ? `${(page - 1) * size + 1}–${Math.min(page * size, list.data.total)} / ${list.data.total}` : '0'}
            </span>
            <button type="button" className="px-qb" disabled={page <= 1} aria-label={t('common.prev')} title={t('common.prev')} onClick={() => setPage(page - 1)}>
              <Icon name="chevl" />
            </button>
            <button type="button" className="px-qb" disabled={page >= Math.max(1, Math.ceil((list.data?.total ?? 0) / size))} aria-label={t('common.next')} title={t('common.next')} onClick={() => setPage(page + 1)}>
              <Icon name="chevr" />
            </button>
          </div>
        </div>
        {panel === 'f' && (
          <div className="filters qpanel">
            <Field label={t('confirmation.f.wilaya')}>
              <select value={f.wilayaId ?? ''} onChange={(e) => setFilter({ wilayaId: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">{t('confirmation.f.allF')}</option>
                {WILAYAS.map((_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {wilaya(i + 1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('confirmation.col.agent')}>
              <select value={f.agentId ?? ''} onChange={(e) => setFilter({ agentId: e.target.value === 'none' ? 'none' : e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">{t('common.all')}</option>
                <option value="none">{t('confirmation.noAgent')}</option>
                {meta.data?.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('confirmation.col.channel')}>
              <select value={f.channel ?? ''} onChange={(e) => setFilter({ channel: (e.target.value || undefined) as SalesChannel | undefined })}>
                <option value="">{t('common.all')}</option>
                {SALES_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {t(`status.channel.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
            {sub !== 'nouvelles' && (
              <Field label={t('confirmation.col.status')}>
                <select value={f.status ?? ''} onChange={(e) => setFilter({ status: e.target.value || undefined })}>
                  <option value="">{t(`confirmation.f.allSt.${sub}`)}</option>
                  {SUB_STATUSES[sub].map((s) => (
                    <option key={s} value={s}>
                      {t(`status.conf.${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t('common.from')}>
              <input type="date" value={f.from ?? ''} onChange={(e) => setFilter({ from: e.target.value || undefined })} />
            </Field>
            <Field label={t('common.to')}>
              <input type="date" value={f.to ?? ''} onChange={(e) => setFilter({ to: e.target.value || undefined })} />
            </Field>
            {nFilters > 0 && (
              <button type="button" className="btn ghost" onClick={() => (setF({}), setPage(1))}>
                {t('confirmation.f.clear')}
              </button>
            )}
          </div>
        )}
        {list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data ? (
          <Loading />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl qtbl">
                <thead>
                  <tr>
                    <th className="ck">
                      <span className="sr-only">{t('confirmation.detail')}</span>
                    </th>
                    <th className="ck">
                      <input type="checkbox" aria-label={t('confirmation.selectAll')} checked={allOn} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                    </th>
                    <th>{t('confirmation.col.order')}</th>
                    {cols.map((c) =>
                      c.sort ? (
                        <SortTh key={c.k} k={c.sort} sort={sort} dir={dir} onSort={onSort} num={c.k === 'total'}>
                          {colLabel(c.k)}
                        </SortTh>
                      ) : (
                        <th key={c.k} className={c.k === 'total' ? 'num' : undefined}>
                          {colLabel(c.k)}
                        </th>
                      ),
                    )}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {!rows.length && (
                    <tr>
                      <td colSpan={cols.length + 4} className="empty">
                        {t(`confirmation.empty.${sub}`)}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => {
                    const op = open.has(r.id);
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={`clickable ${sel.has(r.id) ? 'qsel' : ''}`}
                          data-oid={r.id}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('a,button,input,select,label')) return;
                            toggleOpen(r.id);
                          }}
                        >
                          <td className="ck qexp">
                            <button type="button" className="icon-btn qic" aria-expanded={op} aria-label={t(op ? 'confirmation.hideDetail' : 'confirmation.showDetail', { ref: r.ref })} onClick={() => toggleOpen(r.id)}>
                              <Icon name="chevron" />
                            </button>
                          </td>
                          <td className="ck">
                            <input
                              type="checkbox"
                              aria-label={t('confirmation.select', { ref: r.ref })}
                              checked={sel.has(r.id)}
                              onChange={(e) => setSel((s) => (e.target.checked ? new Set(s).add(r.id) : (s.delete(r.id), new Set(s))))}
                            />
                          </td>
                          <td data-l={t('confirmation.col.order')}>
                            <b className="ltr">{r.ref}</b>
                            <small>{when(r.createdAt)}</small>
                            {r.deadline && <Countdown d={r.deadline} />}
                          </td>
                          {cols.map((c) => (
                            <td key={c.k} data-l={colLabel(c.k)} className={c.k === 'total' ? 'num' : c.k === 'product' || c.k === 'status' ? 'wide px-cw' : undefined}>
                              {cell(r, c.k)}
                            </td>
                          ))}
                          <td className="qact" data-l="">
                            <div className="qrowacts">
                              <a className="qo" href={telHref(r.phone)} aria-label={t('confirmation.callNum', { p: r.phone })} title={t('confirmation.call')} onClick={() => rpc('orders.logCall', { id: r.id }).catch(() => {})}>
                                <Icon name="phone" />
                              </a>
                              <a className="qo" href={wa(r)} target="_blank" rel="noopener" aria-label={t('confirmation.msgNum', { p: r.phone })} title={t('confirmation.message')}>
                                <Icon name="message" />
                              </a>
                              <button type="button" className="qo qo-edit" aria-label={t('confirmation.editRef', { ref: r.ref })} title={t('confirmation.edit')} onClick={() => openOrderForm({ orderId: r.id, onSaved: () => qc.invalidateQueries() })}>
                                <Icon name="pencil" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {op && (
                          <tr className="qdetail">
                            <td colSpan={cols.length + 4} className="wide">
                              <Detail order={r} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              page={page}
              pageSize={size}
              total={list.data.total}
              onPage={setPage}
              onSize={(s) => {
                setSize(s);
                store.set('conf-size', String(s));
                setPage(1);
              }}
            />
          </>
        )}
      </div>
      {dialog}
      {delAsk && (
        <Modal
          title={t('confirmation.del.title', { count: delAsk.length })}
          className="conf-modal"
          onClose={() => setDelAsk(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDelAsk(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  try {
                    const r = await rpc('orders.delete', { ids: delAsk.map((x) => x.id) });
                    toast(t('confirmation.del.done', { count: r.deleted }), 'ok');
                    setSel(new Set());
                    qc.invalidateQueries();
                  } catch (e: any) {
                    toast(e.message, 'bad');
                  }
                  setDelAsk(null);
                }}
              >
                {t('confirmation.del.ok')}
              </button>
            </>
          }
        >
          <p>{t('confirmation.del.text', { refs: delAsk.map((r) => r.ref).join(', ') })}</p>
        </Modal>
      )}
      {blockAsk && (
        <Modal
          title={t('confirmation.block.title', { n: new Set(blockAsk.map((r) => r.phone)).size })}
          className="conf-modal"
          onClose={() => setBlockAsk(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setBlockAsk(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  try {
                    const r = await rpc('confirmation.block', { ids: blockAsk.map((x) => x.id) });
                    toast(t('confirmation.block.done', { n: r.customers }), 'ok');
                    setSel(new Set());
                    qc.invalidateQueries();
                  } catch (e: any) {
                    toast(e.message, 'bad');
                  }
                  setBlockAsk(null);
                }}
              >
                {t('confirmation.block.ok')}
              </button>
            </>
          }
        >
          <p>{t('confirmation.block.text')}</p>
        </Modal>
      )}
    </>
  );
}

/** "Temps passé" badge (warn after 24 h), refreshed every minute. */
function Spent({ iso }: { iso: string }) {
  const now = useNow();
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  const h = Math.floor(m / 60);
  const txt = m < 60 ? `${m} min` : h < 24 ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(h / 24)} j${h % 24 ? ` ${h % 24} h` : ''}`;
  return <span className={`badge t-${m > 24 * 60 ? 'warn' : 'off'} ltr`}>{txt}</span>;
}

/** The ".qacts" toolbar above the list. */
function Toolbar(p: {
  rows: Row[];
  manager: boolean;
  agents: { id: number; name: string }[];
  waHref: (r: Row) => string;
  onClear: () => void;
  onAssign: (rows: Row[], id: number | null) => void;
  onStatus: (c: StatusChoice) => void;
  onBlock: () => void;
  onDelete?: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useTranslation();
  const nSel = p.rows.length;
  const one = nSel === 1 ? p.rows[0] : null;
  const none = nSel === 0;
  const tip = t('confirmation.tb.tipNone');
  const tipOne = t('confirmation.tb.tipOne');
  return (
    <div className="qacts" role="toolbar" aria-label={t('confirmation.tb.label')}>
      <span className="muted small qa-info">
        {nSel ? t('confirmation.tb.selected', { count: nSel }) : t('confirmation.tb.none')}
        {nSel > 0 && (
          <button type="button" className="linkish" onClick={p.onClear}>
            {t('common.unselect')}
          </button>
        )}
      </span>
      <button type="button" className="btn small qa-btn" disabled={!one} title={one ? undefined : tipOne} onClick={p.onDuplicate}>
        <span className="qa-ic">
          <Icon name="copy" />
        </span>
        {t('confirmation.tb.duplicate')}
      </button>
      {one ? (
        <a className="btn small qa-btn" href={p.waHref(one)} target="_blank" rel="noopener">
          <span className="qa-ic">
            <Icon name="message" />
          </span>
          {t('confirmation.tb.send')}
        </a>
      ) : (
        <button type="button" className="btn small qa-btn" disabled title={tipOne}>
          <span className="qa-ic">
            <Icon name="message" />
          </span>
          {t('confirmation.tb.send')}
        </button>
      )}
      {p.manager && (
        <label className={`btn small qa-btn qa-wrap ${none ? 'is-dis' : ''}`}>
          <span className="qa-ic">
            <Icon name="userplus" />
          </span>
          <select
            className="qa-sel"
            aria-label={t('confirmation.tb.assign')}
            disabled={none}
            title={none ? tip : undefined}
            value=""
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v) p.onAssign(p.rows, v);
            }}
          >
            <option value="">{t('confirmation.tb.assign')}</option>
            {p.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {p.manager && (
        <button type="button" className="btn small qa-btn qa-danger" disabled={none || !p.rows.some((r) => r.agentId)} title={none ? tip : undefined} onClick={() => p.onAssign(p.rows, null)}>
          <span className="qa-ic">
            <Icon name="userminus" />
          </span>
          {t('confirmation.tb.removeAgent')}
        </button>
      )}
      <label className={`btn small qa-btn qa-wrap ${none ? 'is-dis' : ''}`}>
        <span className="qa-ic">
          <Icon name="checkcircle" />
        </span>
        <select
          className="qa-sel"
          aria-label={t('confirmation.tb.status')}
          disabled={none}
          title={none ? tip : undefined}
          value=""
          onChange={(e) => {
            if (e.target.value) p.onStatus(e.target.value as StatusChoice);
          }}
        >
          <option value="">{t('confirmation.tb.status')}</option>
          {BULK_CHOICES.map((c) => (
            <option key={c} value={c}>
              {choiceLabel(t, c)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn small qa-btn" disabled={none} title={none ? tip : undefined} onClick={p.onBlock}>
        <span className="qa-ic">
          <Icon name="ban" />
        </span>
        {t('confirmation.tb.block')}
      </button>
      {p.onDelete && (
        <button type="button" className="btn small qa-btn qa-del" disabled={none} title={none ? tip : undefined} onClick={p.onDelete}>
          <span className="qa-ic">
            <Icon name="trash" />
          </span>
          {t('confirmation.tb.delete')}
        </button>
      )}
    </div>
  );
}

