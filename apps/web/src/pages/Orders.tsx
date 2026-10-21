import { Language, Order, OrderStatus, WILAYAS } from '@pilotix/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBox, Icon, Loading, StatusPill } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDZD } from '../lib/i18n';
import { NewOrderDrawer } from './NewOrder';
import { OrderDrawer } from './OrderDrawer';

const GROUPS: { key: string; statuses: OrderStatus[] }[] = [
  { key: 'all', statuses: [] },
  { key: 'new', statuses: ['new'] },
  { key: 'callback', statuses: ['callback', 'no_answer', 'postponed'] },
  { key: 'confirmed', statuses: ['confirmed'] },
  { key: 'shipped', statuses: ['assigned', 'shipped', 'returning'] },
  { key: 'delivered', statuses: ['delivered'] },
  { key: 'returned', statuses: ['returned'] },
  { key: 'cancelled', statuses: ['cancelled', 'duplicate'] },
];
const PAGE = 100;

/** "0661234567" → "213661234567" for WhatsApp links. */
const intl = (phone: string) => '213' + phone.replace(/^0/, '');

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function Orders() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Language;
  const { can } = useAuth();
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const [wilaya, setWilaya] = useState<number | ''>('');
  const [due, setDue] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search, 300);
  const statuses = GROUPS.find((g) => g.key === group)!.statuses;

  const query = useInfiniteQuery({
    queryKey: ['orders', { statuses, q, wilaya, due }],
    queryFn: ({ pageParam }) =>
      api.orders({ status: statuses, q: q || undefined, wilaya: wilaya || undefined, callbackDue: due || undefined, page: pageParam, pageSize: PAGE, sort: due ? 'callback_asc' : 'created_desc' }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => (window.innerWidth <= 760 ? 92 : 64), overscan: 12 });
  const items = v.getVirtualItems();

  // Load the next page when the user scrolls near the end.
  useEffect(() => {
    const last = items[items.length - 1];
    if (last && last.index >= rows.length - 20 && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
  }, [items, rows.length, query]);

  return (
    <>
      <div className="row">
        <input className="grow" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('orders.search')} style={{ flexBasis: 260 }} />
        <select value={wilaya} onChange={(e) => setWilaya(e.target.value ? Number(e.target.value) : '')} style={{ width: 'auto', minWidth: 160 }} aria-label={t('orders.wilaya')}>
          <option value="">{t('orders.wilaya')}</option>
          {WILAYAS.map((w, i) => (
            <option key={i} value={i + 1}>
              {String(i + 1).padStart(2, '0')} · {w}
            </option>
          ))}
        </select>
        <button className={`tab ${due ? 'on' : ''}`} onClick={() => setDue(!due)}>
          {t('orders.callbacksDue')}
        </button>
        {can('manager', 'confirmation', 'agent') && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon.plus /> {t('orders.new')}
          </button>
        )}
      </div>
      <div className="tabs" role="tablist">
        {GROUPS.map((g) => (
          <button key={g.key} role="tab" aria-selected={group === g.key} className={`tab ${group === g.key ? 'on' : ''}`} onClick={() => setGroup(g.key)}>
            {g.key === 'all' ? t('orders.all') : t(`status.${g.statuses[0]}`)}
          </button>
        ))}
      </div>
      <span className="muted small">{t('orders.count', { count: total })}</span>

      {query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <ErrorBox onRetry={() => query.refetch()} />
      ) : !rows.length ? (
        <div className="empty">{t('orders.empty')}</div>
      ) : (
        <div className="vlist" ref={scrollRef}>
          <div className="vhead">
            <span>{t('orders.reference')}</span>
            <span>{t('orders.customer')}</span>
            <span>{t('orders.wilaya')}</span>
            <span>{t('orders.statusCol')}</span>
            <span>{t('orders.total')}</span>
            <span>{t('orders.date')}</span>
            <span />
          </div>
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {items.map((it) => {
              const o: Order = rows[it.index];
              return (
                <div key={o.id} className="vrow" style={{ transform: `translateY(${it.start}px)`, height: it.size }} onClick={() => setOpenId(o.id)}>
                  <span className="c-ref ltr small">{o.reference}</span>
                  <span>
                    <b>
                      {o.customerName} {o.possibleDuplicate && <span className="flag">{t('orders.duplicate')}</span>}
                    </b>
                    <span className="sub">
                      <span className="ltr">{o.phone}</span>
                      {o.attempts > 0 && ` · ${t('orders.attempts', { count: o.attempts })}`}
                    </span>
                  </span>
                  <span className="c-wil small">{WILAYAS[o.wilaya - 1]}</span>
                  <span className="c-status">
                    <StatusPill status={o.status} />
                  </span>
                  <b className="c-total num ltr">{formatDZD(o.total, lang)}</b>
                  <span className="c-date small muted ltr">{formatDate(o.createdAt, lang)}</span>
                  <span className="acts" onClick={(e) => e.stopPropagation()}>
                    <a className="icon-btn orange" href={`tel:${o.phone}`} aria-label={t('orders.call')}>
                      <Icon.phone />
                    </a>
                    <a className="icon-btn orange" href={`https://wa.me/${intl(o.phone)}`} target="_blank" rel="noreferrer" aria-label="WhatsApp">
                      <Icon.message />
                    </a>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {openId !== null && <OrderDrawer id={openId} initial={rows.find((r) => r.id === openId)} onClose={() => setOpenId(null)} />}
      {creating && <NewOrderDrawer onClose={() => setCreating(false)} onCreated={(o) => { setCreating(false); setOpenId(o.id); }} />}
    </>
  );
}
