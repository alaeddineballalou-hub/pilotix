// Dépôt on phones, after « Préparation » (PhonePrep): one white card per parcel, the delivery partner's badge, and
// how long the parcel has waited — instead of the big tables of a computer.
// - En dispatch: scan first (a scanned parcel leaves with its partner), the labels to print, then the parcels by
//   delivery partner (each with its label, or « Envoyer à … » while the company has not given its number yet).
// - Dispatchées and En livraison: the parcels on the road, the oldest first, orange then red when late, with filters
//   for the late ones.
// - Retours / Échanges: find a return by its code, or tap « Reçu au dépôt » on its card (twice, to be sure): the
//   stock comes back.
// A tap on a card opens the order.
import type { FollowStatus, Order } from '@pilotix/shared';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, wilayaName } from '../../lib/format';
import { trackOf } from '../../lib/items';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { CopyCode } from '../../ui/CopyCode';
import { ErrorBox, Help, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Filters, SearchBox } from '../ai/agent';
import { CoBadge } from '../suivi/PhoneSuivi';
import { useDebounced } from './OrderList';
import { ScanCard } from './ScanCard';
import { LabelAction, LabelsBar, stateOf, useCouriers } from './Labels';
import { BagsCard } from './Bags';
import '../suivi/phone.css';
import './phone.css';
import './stages.css';

type Road = 'dispatchees' | 'enlivraison';
type Level = 'ok' | 'warn' | 'bad';

/** The parcels of a stage, the first 100 then 100 more at a time. */
function useStage(follow: FollowStatus[], confirmedOnly: boolean, sort: 'shipped_at' | 'updated_at', q: string) {
  const [limit, setLimit] = useState(100);
  const dq = useDebounced(q.trim());
  const list = useRpc('orders.list', { follow, conf: confirmedOnly ? ['confirmed'] : undefined, q: dq || undefined, sort, dir: 'asc', page: 1, pageSize: limit, tickets: 'include' });
  return { list, rows: list.data?.rows ?? [], total: list.data?.total ?? 0, more: () => setLimit((l) => l + 100) };
}
type Stage = ReturnType<typeof useStage>;

/** Handed over (Dispatchées): late after 24 h, very late after 48 h. On the road (En livraison): after 4 then 7 days. */
function levelOf(road: Road, iso: string | null): Level {
  if (!iso) return 'ok';
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (road === 'dispatchees') return h >= 48 ? 'bad' : h >= 24 ? 'warn' : 'ok';
  const d = h / 24;
  return d >= 7 ? 'bad' : d >= 4 ? 'warn' : 'ok';
}

/** "3 h", "2 j", "moins d’1 h", "aujourd’hui" in the colour of how late it is. */
function Age({ iso, road }: { iso: string | null; road: Road | 'exchange' }) {
  const { t } = useTranslation();
  if (!iso) return null;
  const h = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000);
  const level = road === 'exchange' ? 'ok' : levelOf(road, iso);
  const text =
    road === 'dispatchees' ? (h < 1 ? t('depot.lessThanHour') : h < 48 ? t('depot.hours', { n: Math.floor(h) }) : t('depot.days', { n: Math.floor(h / 24) })) : h < 24 ? t('depot.today') : t('depot.days', { n: Math.floor(h / 24) });
  return <span className={`pxs-days t-${level === 'ok' ? 'info' : level}`}>{text}</span>;
}

const itemsOf = (o: Order) => o.items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ''}${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + ');

/** One parcel: the partner, the reference and the wilaya, the customer, the products, the tracking (copied with a tap) and the amount.
 *  `waiting`: the company has not given its own number yet (the Pilotix one would be replaced), said instead of it. */
function Parcel({ o, badge, children, waiting }: { o: Order; badge?: ReactNode; children?: ReactNode; waiting?: boolean }) {
  const { t } = useTranslation();
  const open = () => openOrder(o.id);
  return (
    <div className="pxt-card" role="button" tabIndex={0} aria-label={`${o.ref} · ${o.customerName}`} onClick={open} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open()}>
      <div className="pxt-top">
        <CoBadge o={o} />
        <span className="pxt-id">
          <b>
            <span className="ltr">{o.ref}</span> · {wilayaName(o.wilayaId)}
            {o.savRef && <span className="pxd-sav">{t('depot.ph.savTag')}</span>}
          </b>
          <small>
            {o.customerName}
            {o.commune ? ` · ${o.commune}` : ''}
          </small>
        </span>
        {badge}
      </div>
      <p className="pxt-prod">{itemsOf(o)}</p>
      <div className="pxt-bot">
        {waiting ? (
          <span className="px-wait">
            <Icon name="clock" /> {t('depot.labels.waiting')}
          </span>
        ) : (
          <CopyCode code={trackOf(o) || o.ref} small />
        )}
        <b className="ltr">{da(o.total)}</b>
      </div>
      {children}
    </div>
  );
}

function Head({ title, count, help }: { title: string; count?: number; help?: string }) {
  return (
    <div className="pxt-head">
      <h2>{title}</h2>
      {count !== undefined && <b className="ltr">{count}</b>}
      {help && <Help text={help} label={title} />}
    </div>
  );
}

/** Loading, error, nothing, or the cards; and « Voir plus » when there are more. */
function Body({ s, empty, children }: { s: Stage; empty: string; children: ReactNode }) {
  const { t } = useTranslation();
  if (s.list.isLoading) return <Loading />;
  if (s.list.error) return <ErrorBox error={s.list.error} onRetry={() => s.list.refetch()} />;
  if (!s.rows.length) return <p className="pxd-empty muted">{empty}</p>;
  return (
    <>
      {children}
      {s.rows.length < s.total && (
        <button type="button" className="pxd-btn pxt-more" onClick={s.more}>
          {t('depot.stg.more', { n: s.total - s.rows.length })}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------- En dispatch
export function PhoneDispatch() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const s = useStage(['prepared'], true, 'updated_at', q);
  const couriers = useCouriers();
  const waits = (o: Order) => {
    if (!couriers) return false;
    const st = stateOf(o, couriers);
    return !st.ok && st.why === 'waiting';
  };
  // by delivery partner, the partner with the most parcels first
  const groups = useMemo(() => {
    const m = new Map<string, Order[]>();
    for (const o of s.rows) {
      const k = o.companyName || o.livreurName || '';
      m.set(k, [...(m.get(k) ?? []), o]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [s.rows]);
  return (
    <div className="pxt">
      <ScanCard mode="dispatch" />
      <LabelsBar phone />
      <Head title={t('depot.stg.waiting')} count={s.total} help={t('depot.stg.dispatchHelp')} />
      <SearchBox value={q} onChange={setQ} placeholder={t('depot.filters.searchPh')} />
      <Body s={s} empty={t(q.trim() ? 'depot.empty' : 'depot.stg.empty_prepares')}>
        {groups.map(([name, list]) => (
          <section key={name || '-'} className="pxt-group">
            <h3>
              <CoBadge o={list[0]} />
              <span>{name || t('depot.stg.noPartner')}</span>
              <b>{t('depot.stg.parcels', { count: list.length })}</b>
            </h3>
            <ul className="pxt-list">
              {list.map((o) => (
                <li key={o.id}>
                  <Parcel o={o} waiting={waits(o)}>
                    <LabelAction o={o} phone />
                  </Parcel>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Body>
    </div>
  );
}

// ---------------------------------------------------------------- Dispatchées, En livraison
export function PhoneRoad({ stage }: { stage: Road }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [f, setF] = useState<'all' | Level>('all');
  const s = useStage([stage === 'dispatchees' ? 'shipped' : 'out_for_delivery'], true, 'shipped_at', q);
  const lv = (o: Order) => levelOf(stage, o.shippedAt);
  const late = s.rows.filter((o) => lv(o) !== 'ok');
  const veryLate = s.rows.filter((o) => lv(o) === 'bad');
  const rows = f === 'all' ? s.rows : f === 'warn' ? late : veryLate;
  return (
    <div className="pxt">
      <Head title={t(`depot.stg.title_${stage}`)} count={s.total} help={t(`depot.help.${stage}`)} />
      {stage === 'dispatchees' && <BagsCard phone />}
      <SearchBox value={q} onChange={setQ} placeholder={t('depot.filters.searchPh')} />
      <Filters<'all' | Level>
        value={f}
        onChange={setF}
        label={t('depot.stg.filters')}
        items={[
          { value: 'all', label: t('depot.stg.all'), count: s.rows.length },
          { value: 'warn', label: t(`depot.stg.${stage}_warn`), count: late.length, alert: true },
          { value: 'bad', label: t(`depot.stg.${stage}_bad`), count: veryLate.length, alert: true },
        ]}
      />
      <Body s={s} empty={t(q.trim() ? 'depot.empty' : `depot.stg.empty_${stage}`)}>
        {rows.length ? (
          <ul className="pxt-list">
            {rows.map((o) => (
              <li key={o.id}>
                <Parcel o={o} badge={<Age iso={o.shippedAt} road={stage} />} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="pxd-empty muted">{t('depot.stg.noneLate')}</p>
        )}
      </Body>
    </div>
  );
}

// ---------------------------------------------------------------- Retours / Échanges
/** « Reçu au dépôt »: a first tap asks, a second one (within 4 s) receives — a card scrolled past is not received by mistake. */
function ReceiveTap({ o }: { o: Order }) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const recv = useAction('depot.receiveReturn', { success: (r) => t('depot.receive.done', { ref: r.ref }) });
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  if (o.followStatus === 'returned') return <span className="pxt-got">{t('depot.receive.already')}</span>;
  return (
    <button
      type="button"
      className={`pxt-recv ${armed ? 'armed' : ''}`}
      disabled={!o.shippedAt || recv.isPending}
      aria-live="polite"
      onClick={(e) => {
        e.stopPropagation();
        if (armed) recv.mutate({ id: o.id });
        else setArmed(true);
      }}
    >
      <Icon name="check" />
      {armed ? t('depot.stg.tapAgain') : t('depot.receive.button')}
    </button>
  );
}

/** Find a return by its reference, its tracking number or the customer's phone (a douchette types it and presses Enter). */
function FindReturn() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    const c = code.trim().replace(/[,()"*]/g, '');
    if (!c) return;
    setBusy(true);
    try {
      setFound(await rpc('depot.find', { code: c }));
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pxt-find">
      <b>{t('depot.receive.title')}</b>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input type="search" autoComplete="off" enterKeyHint="search" placeholder={t('depot.receive.ph')} aria-label={t('depot.receive.ph')} value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="submit" className="pxt-go" disabled={busy || !code.trim()} aria-label={t('depot.receive.search')}>
          <Icon name="search" />
        </button>
      </form>
      {found &&
        (found.length ? (
          <ul className="pxt-list">
            {found.map((o) => (
              <li key={o.id}>
                <Parcel o={o}>
                  <ReceiveTap o={o} />
                </Parcel>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{t('depot.receive.none')}</p>
        ))}
    </section>
  );
}

export function PhoneReturns() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'returning' | 'exchange'>('returning');
  const [q, setQ] = useState('');
  const ret = useStage(['returning'], false, 'updated_at', q);
  const exc = useStage(['in_exchange'], false, 'updated_at', q);
  const s = tab === 'returning' ? ret : exc;
  return (
    <div className="pxt">
      <FindReturn />
      <div className="pxd-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'returning'} className={tab === 'returning' ? 'on' : ''} onClick={() => setTab('returning')}>
          {t('depot.stg.returning')} <b className="ltr">{ret.list.data ? ret.total : '…'}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'exchange'} className={tab === 'exchange' ? 'on' : ''} onClick={() => setTab('exchange')}>
          {t('depot.stg.exchange')} <b className="ltr">{exc.list.data ? exc.total : '…'}</b>
        </button>
      </div>
      <p className="muted small pxd-help">{t(`depot.stg.${tab}Help`)}</p>
      <SearchBox value={q} onChange={setQ} placeholder={t('depot.filters.searchPh')} />
      <Body s={s} empty={t(q.trim() ? 'depot.empty' : `depot.stg.empty_${tab}`)}>
        <ul className="pxt-list">
          {s.rows.map((o) => (
            <li key={o.id}>
              {tab === 'returning' ? (
                <Parcel o={o}>
                  <ReceiveTap o={o} />
                </Parcel>
              ) : (
                <Parcel o={o} badge={<Age iso={o.shippedAt} road="exchange" />} />
              )}
            </li>
          ))}
        </ul>
      </Body>
    </div>
  );
}
