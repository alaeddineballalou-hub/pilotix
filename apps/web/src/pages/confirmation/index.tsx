// Confirmation: Nouvelles › En cours › Confirmées (+ Terminées). Same screens as the original app.
import { CLIENT_LEVELS, SALES_CHANNELS, SalesChannel, WILAYAS, type ClientLevel } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { downloadCsv } from '../../lib/files';
import { da, dateTime, n, when, wilaya, wilayaName } from '../../lib/format';
import { openOrderForm } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { ErrorBox, Field, Help, Icon, Loading, Pager, RemovableChip, SortTh, StageBar, StatusBadge, StatusSelect } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { colDrag, ColumnMenu, DensitySwitch, useDensity, useResizable, useTableColumns } from '../../ui/ColumnMenu';
import { HistoryButton, PhoneCell } from './History';
import { namesOf, variantsOf, trackOf } from '../../lib/items';
import type { PageProps } from '../registry';
import { Countdown, useNow } from './Countdown';
import { Detail } from './Detail';
import { Focus } from './Focus';
import { useIsPhone } from '../../lib/useMedia';
import { PhoneCards, PhoneOrder } from './PhoneList';
import { BULK_CHOICES, choiceLabel, currentLabel, ROW_CHOICES, StatusChoice, Sub, SUB_STATUSES, SUB_TONE, SUBS, telHref, toneOf, waHref } from './shared';
import { ConfirmedStatsPage, StatsSection } from './Stats';
import { useStatusChange } from './StatusDialog';
import { CopyCode } from '../../ui/CopyCode';
import { ScoreChip } from '../../ui/clientScore';

type Row = NonNullable<ReturnType<typeof useList>['data']>['rows'][number];
type SortKey = 'created_at' | 'confirmed_at' | 'next_call_at' | 'total' | 'customer_name' | 'deadline' | 'score';
type ColKey = 'order' | 'source' | 'tracking' | 'creator' | 'channel' | 'product' | 'variant' | 'sku' | 'chrono' | 'name' | 'phone' | 'wilaya' | 'commune' | 'agent' | 'fagent' | 'total' | 'time' | 'created' | 'stock' | 'desk' | 'passed' | 'confirmed' | 'follow' | 'next' | 'status';
interface Filters {
  wilayaId?: number;
  agentId?: number | 'none';
  teamId?: string;
  productId?: number;
  variantId?: number;
  channel?: SalesChannel;
  status?: string;
  /** the customer's score level */
  level?: ClientLevel;
  from?: string;
  to?: string;
}

const DEFAULT_SORT: Record<Sub, { sort: SortKey; dir: 'asc' | 'desc' }> = {
  nouvelles: { sort: 'deadline', dir: 'asc' },
  attente: { sort: 'deadline', dir: 'asc' },
  confirmees: { sort: 'confirmed_at', dir: 'desc' },
  livrees: { sort: 'confirmed_at', dir: 'desc' },
  terminees: { sort: 'created_at', dir: 'desc' },
};
const columnsOf = (sub: Sub): { k: ColKey; sort?: SortKey }[] => [
  { k: 'order' },
  { k: 'source' },
  { k: 'tracking' },
  { k: 'creator' },
  { k: 'channel' },
  { k: 'product' },
  { k: 'variant' },
  { k: 'sku' },
  ...(sub === 'nouvelles' || sub === 'attente' ? [{ k: 'chrono' as const, sort: 'deadline' as const }] : []),
  { k: 'name', sort: 'customer_name' },
  { k: 'phone' },
  { k: 'wilaya' },
  { k: 'commune' },
  { k: 'agent' },
  { k: 'fagent' },
  { k: 'total', sort: 'total' },
  { k: 'time', sort: 'created_at' },
  { k: 'created', sort: 'created_at' },
  { k: 'stock' },
  { k: 'desk' },
  { k: 'passed' },
  ...(sub === 'confirmees' || sub === 'livrees' ? [{ k: 'confirmed' as const, sort: 'confirmed_at' as const }, { k: 'follow' as const }] : [{ k: 'next' as const, sort: 'next_call_at' as const }]),
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
  // phones: the queue comes first; the big statistics stay on tablets and computers
  const phone = useIsPhone();
  return (
    <>
      <StageBar items={items} current={sub} />
      {sub === 'confirmees' && manager ? (
        // managers: « Confirmées » shows statistics only (computers and phones)
        <ConfirmedStatsPage />
      ) : (
        <>
          {manager && !phone && <StatsSection sub={sub} />}
          <Queue key={sub} sub={sub} focusId={focusId} />
        </>
      )}
    </>
  );
}

function Queue({ sub, focusId }: { sub: Sub; focusId: number | null }) {
  const phone = useIsPhone();
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const manager = has('agent_manager', 'vendeur');
  const meta = useRpc('confirmation.meta', {}, { staleTime: 5 * 60_000 });
  const catalog = useRpc('confirmation.catalog', {}, { staleTime: 5 * 60_000 });
  const COLS = useMemo(() => columnsOf(sub), [sub]);
  const colsKey = `conf-cols3-${sub}`;
  // columns saved with the account; a chosen preset is used by every list until the columns are changed by hand
  const tc = useTableColumns<ColKey>(
    `conf-${sub}`,
    COLS.map((c) => c.k),
    {
      legacy: () => {
        let cols = store.json<ColKey[] | null>(colsKey, null);
        // the Chrono column came later: show it in older column choices (unless it was hidden since)
        if (cols && COLS.some((c) => c.k === 'chrono') && !cols.includes('chrono') && !store.get(`${colsKey}-chrono`)) cols = [...cols, 'chrono'];
        return { cols, order: store.json<ColKey[] | null>(`conf-order-${sub}`, null) };
      },
    },
  );
  const visible = tc.visible;
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

  const { order, setOrder } = tc;
  const cols = order.map((k) => COLS.find((c) => c.k === k)!).filter((c) => c && visible.has(c.k));
  const drag = colDrag(order, setOrder);
  // column widths: each user's own
  const wkeys = ['_exp', '_ck', ...cols.map((c) => c.k), '_act'];
  const [dens, setDens] = useDensity();
  const rs = useResizable(tc.widths, tc.setWidths, t('common.resizeCol'), wkeys, dens);
  const selected = rows.filter((r) => sel.has(r.id));
  const nFilters = Object.values(f).filter((v) => v !== undefined && v !== '').length;
  const shop = meta.data?.shopName ?? 'Pilotix';
  const tpl = meta.data?.whatsappTemplate ?? 'Bonjour {nom}, ici {boutique} à propos de votre commande {ref}.';
  const wa = (r: Row) => waHref(r.phone, tpl, { nom: r.customerName, boutique: shop, ref: r.ref });
  const setFilter = (p: Partial<Filters>) => {
    setF((cur) => ({ ...cur, ...p }));
    setPage(1);
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
          trackOf(o),
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
      case 'order':
        return (
          <>
            <b className="ltr">{r.ref}</b>
            <small>{when(r.createdAt)}</small>
          </>
        );
      case 'source':
        return <span className="chip">{(r.utm && (r.utm.utm_source || r.utm.source)) || r.source || t('confirmation.direct')}</span>;
      case 'tracking':
        return <CopyCode code={trackOf(r)} />;
      case 'creator':
        return r.creatorName ?? <span className="muted">{t('confirmation.site')}</span>;
      case 'channel':
        return t(`status.channel.${r.channel}`, { defaultValue: r.channel });
      case 'product':
        return (
          <div className="px-clamp">
            <div className="qprod">{namesOf(r.items)}</div>
          </div>
        );
      case 'variant':
        return <div className="px-clamp">{variantsOf(r.items)}</div>;
      case 'sku':
        return r.skus.join(', ') || '—';
      case 'name':
        return (
          <>
            <b>{r.customerName}</b>
            {r.clientScore && <ScoreChip s={r.clientScore} short />}
            {r.possibleDuplicate && <span className="flag dup">{t('confirmation.dup')}</span>}
            {r.blacklisted && <span className="flag">{t('confirmation.blacklist')}</span>}
          </>
        );
      case 'phone':
        return <PhoneCell order={r} />;
      case 'wilaya':
        return wilayaName(r.wilayaId);
      case 'commune':
        return r.commune || '—';
      case 'agent':
        return r.agentId ? <RemovableChip name={r.agentName ?? '—'} removeLabel={t('confirmation.removeAgent')} onRemove={manager ? () => assign([r], null) : undefined} /> : <span className="muted">—</span>;
      case 'fagent':
        return <RemovableChip name={r.followAgentName} />;
      case 'total':
        return <span className="ltr">{da(r.total)}</span>;
      case 'chrono':
        return r.deadline ? <Countdown d={r.deadline} short /> : <span className="muted">—</span>;
      case 'time':
        return <Spent iso={r.createdAt} />;
      case 'created':
        return when(r.createdAt);
      case 'stock':
        return r.stock === null ? <span className="muted">—</span> : <span className={`badge t-${r.stock === 'ok' ? 'ok' : 'bad'}`}>{t(`confirmation.stock.${r.stock}`)}</span>;
      case 'desk':
        return r.isStopdesk ? <span className="badge t-info">{t('confirmation.desk')}</span> : <span className="muted">{t('confirmation.home')}</span>;
      case 'passed':
        return (
          <HistoryButton orderId={r.id} refLabel={r.ref} className="px-histcell" title={t('confirmation.hist.open', { ref: r.ref })}>
            <Icon name="history" />
            {r.passed.length ? (
              <span className="px-passed">
                {r.passed.map((s, k) => (
                  <StatusBadge key={k} kind="conf" status={s} />
                ))}
              </span>
            ) : (
              <span className="muted">{t('confirmation.hist.see')}</span>
            )}
          </HistoryButton>
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
                {trackOf(r) && (
                  <>
                    {' · '}
                    <CopyCode code={trackOf(r)} />
                  </>
                )}
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

  /** Opens one order in the table and brings it under the header; the others close. */
  const openOnly = (id: number | null) => {
    setOpen(id === null ? new Set() : new Set([id]));
    if (id === null) return;
    setTimeout(() => {
      const tr = document.querySelector(`tr[data-oid="${id}"]`);
      if (tr) window.scrollTo({ top: tr.getBoundingClientRect().top + window.scrollY - 76, behavior: 'smooth' });
    }, 60);
  };
  /** The order after this one in the table (or the first one), opened in place. */
  const goNext = (fromId?: number) => {
    const i = fromId === undefined ? -1 : rows.findIndex((r) => r.id === fromId);
    const rest = rows.filter((r) => r.id !== fromId);
    const nx = (i >= 0 ? rows.slice(i + 1).find((r) => r.id !== fromId) : undefined) ?? (fromId === undefined ? rows[0] : rest[0]);
    if (!nx) {
      openOnly(null);
      toast(t('confirmation.noNext'), 'ok');
      return;
    }
    openOnly(nx.id);
  };
  const toggleOpen = (id: number) => setOpen((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s).add(id)));
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const canNext = (sub === 'nouvelles' || sub === 'attente') && has('confirmation');
  // "Commande suivante" lives in the top header (Shell): it asks this list to open the next order
  useEffect(() => {
    if (!canNext) return;
    const on = () => goNext([...open].pop());
    window.addEventListener('px:next-order', on);
    return () => window.removeEventListener('px:next-order', on);
  });

  return (
    <>
      {focus !== null && <Focus initialId={focus === 'ask' ? null : focus} onClose={() => setFocus(null)} />}
      <div className={`card qcard px-d-${dens}`}>
        <div className="card-head px-qhead">
          <h2>
            {title} <span className={`badge t-${SUB_TONE[sub]} ltr`}>{n(list.data?.total ?? 0)}</span>
            <Help text={t(`confirmation.help.${sub}`)} label={title} />
          </h2>
          <div className="row">
            {has('confirmation') && !session?.profile.agencyId && (
              <button type="button" className={`btn ${canNext ? 'px-qnew' : 'primary'}`} onClick={() => openOrderForm({ onSaved: () => qc.invalidateQueries() })}>
                + {t('confirmation.newOrder')}
              </button>
            )}
            {/* the same "Commande suivante" as in the top header */}
            {canNext && (
              <button type="button" className="btn primary px-qnext" onClick={() => goNext([...open].pop())}>
                {t('confirmation.next').replace(/\s*[→←]\s*$/, '')}
                <Icon name="chevr" className="px-qnext-ar" />
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
          // a confirmation agency's agent does not make orders in the store
          onDuplicate={session?.profile.agencyId ? undefined : async () => {
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
              <span className="px-qb-tx">{t('common.filters')}</span>
              {nFilters ? <b className="px-qb-n">{nFilters}</b> : null}
            </button>
            {/* the best customers first (a customer known good, then a new one, then the ones to watch); again: back to the clock */}
            <button
              type="button"
              className={`px-qb px-qb-l ${sort === 'score' ? 'on' : ''}`}
              aria-pressed={sort === 'score'}
              title={t('confirmation.bestFirstHelp')}
              onClick={() => {
                setSort(sort === 'score' ? DEFAULT_SORT[sub] : { sort: 'score', dir: 'desc' });
                setPage(1);
              }}
            >
              <Icon name="medal" />
              <span className="px-qb-tx">{t('confirmation.bestFirst')}</span>
            </button>
            <DensitySwitch value={dens} onChange={setDens} />
            <ColumnMenu
              order={order}
              onOrder={setOrder}
              cols={COLS.map((c) => ({ k: c.k, label: colLabel(c.k) }))}
              visible={visible}
              onChange={tc.setVisible}
              onReset={tc.reset}
              presetId={tc.presetId}
              onPreset={tc.applyPreset}
              locked={tc.locked}
              widthsSet={Object.keys(tc.widths).length > 0}
              onResetWidths={tc.resetWidths}
              open={panel === 'c'}
              onToggle={() => setPanel(panel === 'c' ? null : 'c')}
            />
            <button type="button" className="px-qb px-qb-dl" title={t('common.export')} aria-label={t('common.export')} onClick={doExport}>
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
            {(meta.data?.teams.length ?? 0) > 0 && (
              <Field label={t('confirmation.f.team')}>
                <select value={f.teamId ?? ''} onChange={(e) => setFilter({ teamId: e.target.value || undefined })}>
                  <option value="">{t('confirmation.f.allT')}</option>
                  {meta.data?.teams.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t('confirmation.f.product')}>
              <select value={f.productId ?? ''} onChange={(e) => setFilter({ productId: e.target.value ? Number(e.target.value) : undefined, variantId: undefined })}>
                <option value="">{t('confirmation.f.allP')}</option>
                {catalog.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('confirmation.f.variant')}>
              <select value={f.variantId ?? ''} disabled={!f.productId} title={f.productId ? undefined : t('confirmation.f.pickP')} onChange={(e) => setFilter({ variantId: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">{f.productId ? t('confirmation.f.allV') : t('confirmation.f.pickP')}</option>
                {catalog.data
                  ?.find((p) => p.id === f.productId)
                  ?.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title || v.sku}
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
            <Field label={t('clients.score.filterShort')}>
              <select value={f.level ?? ''} onChange={(e) => setFilter({ level: (e.target.value || undefined) as ClientLevel | undefined })}>
                <option value="">{t('common.all')}</option>
                {CLIENT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {t(`clients.score.level.${l}`)}
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
            {phone ? (
              <>
                {(() => {
                  const now = Date.now();
                  const late = rows.filter((r) => r.deadline && r.deadline.t < now).length;
                  return (
                    <div className="pxp-sum">
                      {late > 0 && <span className="badge t-bad">{t('confirmation.ph.late', { n: late })}</span>}
                      <span className="badge t-warn">{t('confirmation.ph.queue', { n: list.data.total })}</span>
                    </div>
                  );
                })()}
                <PhoneCards rows={rows} empty={t('confirmation.ph.empty')} onOpen={(id) => setOpen(new Set([id]))} />
                {canNext && rows.length > 0 && (
                  <button type="button" className="pxp-next" onClick={() => goNext([...open].pop())}>
                    {t('confirmation.ph.next')}
                    <Icon name="chevr" />
                  </button>
                )}
                {(() => {
                  const cur = rows.find((r) => open.has(r.id));
                  return cur ? <PhoneOrder order={cur} onClose={() => setOpen(new Set())} onDone={goNext} /> : null;
                })()}
              </>
            ) : (
            <div className="tbl-wrap" ref={rs.wrapRef}>
              <table className={`tbl qtbl${rs.fixed ? ' px-fixed' : ''}`} style={rs.tableStyle()}>
                {rs.cols()}
                <thead>
                  <tr>
                    <th className="ck" data-col="_exp">
                      <span className="sr-only">{t('confirmation.detail')}</span>
                    </th>
                    <th className="ck" data-col="_ck">
                      <input type="checkbox" aria-label={t('confirmation.selectAll')} checked={allOn} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                    </th>
                    {cols.map((c) =>
                      c.sort ? (
                        <SortTh key={c.k} k={c.sort} sort={sort} dir={dir} onSort={onSort} num={c.k === 'total'} extra={{ ...drag(c.k), title: t('common.dragCol'), className: 'px-drag' }} after={rs.handle(c.k)}>
                          {colLabel(c.k)}
                        </SortTh>
                      ) : (
                        <th key={c.k} {...drag(c.k)} title={t('common.dragCol')} className={`px-drag ${c.k === 'total' ? 'num' : ''}`}>
                          {colLabel(c.k)}
                          {rs.handle(c.k)}
                        </th>
                      ),
                    )}
                    <th data-col="_act" />
                  </tr>
                </thead>
                <tbody>
                  {!rows.length && (
                    <tr>
                      <td colSpan={cols.length + 3} className="empty">
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
                          {cols.map((c) => (
                            <td key={c.k} data-l={colLabel(c.k)} className={`px-c-${c.k} ${c.k === 'total' ? 'num' : c.k === 'product' ? 'wide px-cw' : ''}`}>
                              {cell(r, c.k)}
                            </td>
                          ))}
                          <td className="qact" data-l="">
                            <div className="qrowacts">
                              <HistoryButton orderId={r.id} refLabel={r.ref} className="qo qo-hist" title={t('confirmation.hist.open', { ref: r.ref })}>
                                <Icon name="history" />
                              </HistoryButton>
                              <button type="button" className="qo qo-edit" aria-label={t('confirmation.editRef', { ref: r.ref })} title={t('confirmation.edit')} onClick={() => openOrderForm({ orderId: r.id, onSaved: () => qc.invalidateQueries() })}>
                                <Icon name="pencil" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {op && (
                          <tr className="qdetail">
                            <td colSpan={cols.length + 3} className="wide">
                              <Detail order={r} onDone={goNext} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
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
  onDuplicate?: () => void;
}) {
  const { t } = useTranslation();
  const nSel = p.rows.length;
  const one = nSel === 1 ? p.rows[0] : null;
  const none = nSel === 0;
  const tip = t('confirmation.tb.tipNone');
  const tipOne = t('confirmation.tb.tipOne');
  // the bar measures itself: when the labels don't fit on one line, the small buttons become icons
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const check = () => {
      el.classList.remove('qa-compact', 'qa-two');
      const over = () => el.scrollWidth > el.clientWidth + 1;
      if (over()) el.classList.add('qa-compact');
      if (over()) el.classList.add('qa-two');
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nSel, p.manager, !!p.onDelete]);
  return (
    <div ref={barRef} className="qacts" role="toolbar" aria-label={t('confirmation.tb.label')}>
      <span className={`qa-info ${nSel ? 'on' : ''}`}>
        {nSel ? t('confirmation.tb.selected', { count: nSel }) : t('confirmation.tb.none')}
        {nSel > 0 && (
          <button type="button" className="linkish" onClick={p.onClear}>
            {t('common.unselect')}
          </button>
        )}
      </span>
      <span className="qa-grp">
        {p.manager && (
          <label className={`btn small qa-btn qa-wrap ${none ? 'is-dis' : ''}`} title={none ? tip : t('confirmation.tb.assign')}>
            <span className="qa-ic">
              <Icon name="userplus" />
            </span>
            <select
              className="qa-sel"
              aria-label={t('confirmation.tb.assign')}
              disabled={none}
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
          <button type="button" className="btn small qa-btn qa-danger" aria-label={t('confirmation.tb.removeAgent')} disabled={none || !p.rows.some((r) => r.agentId)} title={none ? tip : t('confirmation.tb.removeAgent')} onClick={() => p.onAssign(p.rows, null)}>
            <span className="qa-ic">
              <Icon name="userminus" />
            </span>
            <span className="qa-tx">{t('confirmation.tb.removeAgent')}</span>
          </button>
        )}
        <label className={`btn small qa-btn qa-wrap ${none ? 'is-dis' : ''}`} title={none ? tip : t('confirmation.tb.status')}>
          <span className="qa-ic">
            <Icon name="checkcircle" />
          </span>
          <select
            className="qa-sel"
            aria-label={t('confirmation.tb.status')}
            disabled={none}
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
      </span>
      <span className="qa-grp">
        {p.onDuplicate && <button type="button" className="btn small qa-btn" aria-label={t('confirmation.tb.duplicate')} disabled={!one} title={one ? t('confirmation.tb.duplicate') : tipOne} onClick={p.onDuplicate}>
          <span className="qa-ic">
            <Icon name="copy" />
          </span>
          <span className="qa-tx">{t('confirmation.tb.duplicate')}</span>
        </button>}
        {one ? (
          <a className="btn small qa-btn" aria-label={t('confirmation.tb.send')} title={t('confirmation.tb.send')} href={p.waHref(one)} target="_blank" rel="noopener">
            <span className="qa-ic">
              <Icon name="message" />
            </span>
            <span className="qa-tx">{t('confirmation.tb.send')}</span>
          </a>
        ) : (
          <button type="button" className="btn small qa-btn" aria-label={t('confirmation.tb.send')} disabled title={tipOne}>
            <span className="qa-ic">
              <Icon name="message" />
            </span>
            <span className="qa-tx">{t('confirmation.tb.send')}</span>
          </button>
        )}
        <button type="button" className="btn small qa-btn" aria-label={t('confirmation.tb.block')} disabled={none} title={none ? tip : t('confirmation.tb.block')} onClick={p.onBlock}>
          <span className="qa-ic">
            <Icon name="ban" />
          </span>
          <span className="qa-tx">{t('confirmation.tb.block')}</span>
        </button>
      </span>
      {p.onDelete && (
        <span className="qa-grp qa-end">
          <button type="button" className="btn small qa-btn qa-del" aria-label={t('confirmation.tb.delete')} disabled={none} title={none ? tip : t('confirmation.tb.delete')} onClick={p.onDelete}>
            <span className="qa-ic">
              <Icon name="trash" />
            </span>
            <span className="qa-tx">{t('confirmation.tb.delete')}</span>
          </button>
        </span>
      )}
    </div>
  );
}

