// A confirmation agency's work on its sellers' orders, with the seller picker at the top of the page:
// - one seller: the store's own Confirmation and Suivi screens, as the agency's agents see them there;
// - « Tous les vendeurs »: every seller's orders in one list (each with its seller), opened one at a time inside its
//   store; « Commande suivante » takes the customer who waits the most, whatever the seller.
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { da, n, when, wilayaName } from '../../lib/format';
import { namesOf, trackOf } from '../../lib/items';
import { openOrder } from '../../lib/modals';
import { useRpc, useRpcFor } from '../../lib/query';
import { SellerScope, setSeller, useSeller } from '../../lib/seller';
import { useSellers } from '../../lib/sellers';
import { AgentView, useSession } from '../../lib/session';
import { useIsPhone } from '../../lib/useMedia';
import { Empty, ErrorBox, Icon, Loading, Pager, StageBar, StatusBadge } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { Confirmation } from '../confirmation';
import { Countdown } from '../confirmation/Countdown';
import { Detail } from '../confirmation/Detail';
import { Focus } from '../confirmation/Focus';
import { AgentTag, PhoneOrder, PickBar, PickToggle } from '../confirmation/PhoneList';
import { currentLabel, SUB_TONE, telHref } from '../confirmation/shared';
import type { PageProps } from '../registry';
import { Sav } from '../sav';
import { Suivi, TreatModal } from '../suivi';
import { ScoreChip } from '../../ui/clientScore';

/** « Confirmation » of an agency: one seller's screen, or every seller's orders together. */
export function AgencyConfirmation(props: PageProps) {
  const seller = useSeller();
  return (
    <SellerScope seller={seller}>
      <AgentView>
        <NotGiven task="confirmation">{seller === 'all' ? <AllConfirmation {...props} /> : <Confirmation key={seller} {...props} />}</NotGiven>
      </AgentView>
    </SellerScope>
  );
}

/** « Suivi » of an agency: one seller's screen, or every seller's parcels together. */
export function AgencySuivi(props: PageProps) {
  const seller = useSeller();
  const work = useSellers();
  return (
    <SellerScope seller={seller}>
      <AgentView tasks={[...work.tasks]}>
        <NotGiven task="suivi">
          {seller !== 'all' ? <Suivi key={seller} {...props} /> : props.sub === 'swap' || props.sub === 'reclamation' ? <PickSeller what={props.sub} /> : <AllSuivi {...props} />}
        </NotGiven>
      </AgentView>
    </SellerScope>
  );
}

export function AgencySav(props: PageProps) {
  const { t } = useTranslation();
  const seller = useSeller();
  const work = useSellers();
  if (!work.loaded) return <Loading />;
  if (seller === 'all' || !work.tasks.has('sav')) {
    const eligible = work.list.filter((item) => item.tasks.includes('sav'));
    return <Empty>{t('agency.alerts.pickSav')}
      {eligible.map((item) => <button key={item.id} type="button" className="btn" onClick={() => setSeller(item.id)}>{item.name}</button>)}
    </Empty>;
  }
  return <SellerScope seller={seller}><AgentView tasks={['sav']}><Sav key={seller} {...props} sub={props.sub === 'stats' ? 'tickets' : props.sub} /></AgentView></SellerScope>;
}

/** Réclamations and Swap are done in one seller's store at a time: choose it at the top. */
function PickSeller({ what }: { what: string }) {
  const { t } = useTranslation();
  const w = useSellers();
  const c = useRpc('suivi.counts', {}, { refetchInterval: 60_000 }).data as Record<string, number> | undefined;
  const links = what === 'reclamation' ? stepLinks('traites') : ['annules', 'swap'];
  return (
    <>
      <StageBar
        flow={false}
        items={links.map((k) => ({ key: k, label: t(k === 'traites' ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${k}`), href: `#/suivi/${k}`, count: k === 'reclamation' || k === 'swap' ? undefined : c?.[k] }))}
        current={what}
      />
      <Empty>
      <p>{t('agency.work.pickSeller', { what: t(`suivi.tabs.${what}`) })}</p>
      {w.list.length === 1 && (
        <button type="button" className="btn primary" onClick={() => setSeller(w.list[0].id)}>
          <Icon name="store" /> {w.list[0].name}
        </button>
      )}
      </Empty>
    </>
  );
}

/** The seller chosen does not give this work to the agency (or no seller yet): say so, and offer all the sellers. */
function NotGiven({ task, children }: { task: 'confirmation' | 'suivi'; children: ReactNode }) {
  const { t } = useTranslation();
  const w = useSellers();
  if (!w.loaded) return <Loading />;
  if (!w.list.length) return <Empty>{t('agency.home.noWhere')}</Empty>;
  if (w.tasks.has(task) || (task === 'suivi' && w.tasks.has('confirmation'))) return <>{children}</>;
  return (
    <Empty>
      <p>{w.one ? t(`agency.work.notGiven.${task}`, { seller: w.one.name }) : t(`agency.work.noneGives.${task}`)}</p>
      {w.one && (
        <button type="button" className="btn primary" onClick={() => setSeller('all')}>
          <Icon name="store" /> {t('agency.pick.all')}
        </button>
      )}
    </Empty>
  );
}

// ---------------------------------------------------------------- what a seller's « Toutes les boutiques » changes
/**
 * A seller's « Toutes les boutiques » (pages/boutiques/all.tsx) uses these lists too: its words, its filters, each
 * row's boutique. Missing: an agency's « Tous les vendeurs ».
 */
export interface AllScope {
  /** the column of the shop, and the chip saying « all of them » */
  label: string;
  chip: ReactNode;
  /** a row's shop */
  tag: (s: { id: number; name: string }) => ReactNode;
  /** the filters above the list, and what they add to its request */
  bar?: ReactNode;
  input?: Record<string, unknown>;
  /** what the counts are asked (the boutiques kept) */
  counts?: Record<string, unknown>;
  /** a shop's name (« Commande suivante ») */
  nameOf?: (id: number) => string;
  /** Suivi: the tabs of the bar (default: the step of the agency's menu) */
  tabs?: string[];
}

// ---------------------------------------------------------------- Confirmation, every seller
type Sub = 'nouvelles' | 'attente' | 'confirmees';
const SUBS: Sub[] = ['nouvelles', 'attente', 'confirmees'];
type ConfRow = Out<'confirmation.list'>['rows'][number] & { seller?: { id: number; name: string } };
/** an order of « Tous les vendeurs »: the same number can belong to two stores */
const keyOf = (r: { id: number; seller?: { id: number } }) => `${r.seller?.id ?? 0}:${r.id}`;

export function AllConfirmation({ sub: raw, scope }: PageProps & { scope?: AllScope }) {
  const { t } = useTranslation();
  const sub: Sub = SUBS.includes(raw as Sub) ? (raw as Sub) : 'nouvelles';
  const c = useRpc('confirmation.counts', (scope?.counts ?? {}) as never, { refetchInterval: 60_000 }).data;
  return (
    <>
      <StageBar items={SUBS.map((k) => ({ key: k, label: t(`confirmation.sub.${k}`), href: `#/confirmation/${k}`, count: c?.[k] }))} current={sub} />
      <AllQueue key={sub} sub={sub} scope={scope} />
    </>
  );
}

function AllQueue({ sub, scope }: { sub: Sub; scope?: AllScope }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { has, session } = useSession();
  const phone = useIsPhone();
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  // « Attribuer » (an agency's chief and its chefs d'équipe): ticked orders of every seller, to one of its agents
  const gives = !scope && !!session?.profile.agencyLead;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [giving, setGiving] = useState(false);
  // phones: « Sélectionner » is on (a tap ticks an order instead of opening it)
  const [picking, setPicking] = useState(false);
  const people = useRpcFor(null, 'agency.givePeople', {}, { enabled: gives, staleTime: 60_000 });
  useEffect(() => {
    const id = setTimeout(() => (setQd(q.trim()), setPage(1)), 350);
    return () => clearTimeout(id);
  }, [q]);
  const extra = JSON.stringify(scope?.input ?? {});
  useEffect(() => setPage(1), [extra]);
  const list = useRpc('confirmation.list', { sub, q: qd || undefined, page, pageSize: size, ...(scope?.input ?? {}) }, { refetchInterval: 60_000 });
  const rows = (list.data?.rows ?? []) as ConfRow[];
  const canNext = sub !== 'confirmees' && has('confirmation');
  // ticks of orders that left the list go
  useEffect(() => {
    const here = new Set(rows.map(keyOf));
    setSel((s) => ([...s].every((k) => here.has(k)) ? s : new Set([...s].filter((k) => here.has(k)))));
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = rows.filter((r) => sel.has(keyOf(r)));
  const allOn = rows.length > 0 && rows.every((r) => sel.has(keyOf(r)));
  /** each seller's ticked orders, inside that seller's store, to the person's account there (null: back to nobody) */
  const give = async (to: GivePerson | null) => {
    if (giving) return;
    setGiving(true);
    const bySeller = new Map<number, ConfRow[]>();
    for (const r of chosen) if (r.seller) bySeller.set(r.seller.id, [...(bySeller.get(r.seller.id) ?? []), r]);
    let done = 0;
    const away: string[] = [];
    try {
      for (const [seller, rs] of bySeller) {
        const agentId = to ? to.at[seller] : null;
        if (to && !agentId) {
          away.push(rs[0].seller!.name);
          continue;
        }
        try {
          await rpc('orders.assignAgent', { ids: rs.map((r) => r.id), agentId: agentId ?? null }, seller);
          done += rs.length;
        } catch (e: any) {
          toast(`${rs[0].seller!.name} : ${e?.message ?? t('common.error')}`, 'bad', 6000);
        }
      }
      if (done) toast(to ? t('confirmation.assigned', { n: done, name: to.name }) : t('confirmation.unassigned', { n: done }), 'ok');
      if (to && away.length) toast(t('agency.work.giveNotThere', { name: to.name, sellers: away.join(', ') }), 'bad', 6000);
      setSel(new Set());
      qc.invalidateQueries();
    } finally {
      setGiving(false);
    }
  };
  // « Commande suivante » of the top header: one order after the other, every seller
  useEffect(() => {
    if (!canNext) return;
    const on = () => setFocus(true);
    window.addEventListener('px:next-order', on);
    return () => window.removeEventListener('px:next-order', on);
  }, [canNext]);
  /** the order after this one in the list, opened in its place */
  const goNext = (from: string) => {
    const i = rows.findIndex((r) => keyOf(r) === from);
    const nx = rows.slice(i + 1)[0] ?? rows.find((r) => keyOf(r) !== from);
    setOpen(nx ? keyOf(nx) : null);
    qc.invalidateQueries();
  };
  if (focus) return <FocusAll onClose={() => setFocus(false)} scope={scope} />;
  const cur = rows.find((r) => keyOf(r) === open);
  const total = list.data?.total ?? 0;
  return (
    <div className="card qcard agx-all">
      <div className="card-head px-qhead">
        <h2>
          {t(`confirmation.title.${sub}`)} <span className={`badge t-${SUB_TONE[sub]} ltr`}>{n(total)}</span>
        </h2>
        <div className="row">
          {scope?.chip ?? (
            <span className="chip agx-all-chip">
              <Icon name="store" /> {t('agency.pick.allShort')}
            </span>
          )}
          {canNext && (
            <button type="button" className="btn primary px-qnext" onClick={() => setFocus(true)}>
              {t('confirmation.next').replace(/\s*[→←]\s*$/, '')}
              <Icon name="chevr" className="px-qnext-ar" />
            </button>
          )}
        </div>
      </div>
      {scope?.bar}
      {gives && !phone && <GiveBar n={chosen.length} people={people.data ?? []} anyAgent={chosen.some((r) => r.agentId)} busy={giving} onClear={() => setSel(new Set())} onGive={give} />}
      <div className="px-qtools">
        <label className="px-qsearch">
          <Icon name="search" />
          <input type="search" placeholder={t('confirmation.searchPh')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="px-qbtns">
          <button type="button" className={`px-qb ${list.isFetching ? 'spin' : ''}`} title={t('confirmation.refresh')} aria-label={t('confirmation.refresh')} onClick={() => list.refetch()}>
            <Icon name="refresh" />
          </button>
          <span className="px-qrange ltr">{total ? `${(page - 1) * size + 1}–${Math.min(page * size, total)} / ${total}` : '0'}</span>
        </div>
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Loading />
      ) : phone ? (
        <>
          {gives && (picking || rows.length > 0) && (
            <div className="pxp-sum">
              <PickToggle
                on={picking}
                allOn={allOn}
                onToggle={() => {
                  setPicking((v) => !v);
                  setSel(new Set());
                }}
                onAll={() => setSel(allOn ? new Set() : new Set(rows.map(keyOf)))}
              />
            </div>
          )}
          <ul className={`agx-pcards${picking ? ' is-pick' : ''}`}>
            {!rows.length && <li className="empty-box">{t(`confirmation.empty.${sub}`)}</li>}
            {rows.map((r) => {
              const k = keyOf(r);
              const on = sel.has(k);
              return (
              <li key={k}>
                <button
                  type="button"
                  className={`agx-pcard${picking ? ' is-pick' : ''}${on ? ' is-on' : ''}`}
                  role={picking ? 'checkbox' : undefined}
                  aria-checked={picking ? on : undefined}
                  onClick={() => (picking ? setSel((s) => (s.has(k) ? (s.delete(k), new Set(s)) : new Set(s).add(k))) : setOpen(k))}
                >
                  {picking && <span className="pxp-tick" aria-hidden="true" />}
                  <span className="agx-pcard-top">
                    {scope && r.seller ? scope.tag(r.seller) : <span className="chip agx-seller-chip">{r.seller?.name}</span>}
                    {r.deadline ? <Countdown d={r.deadline} short /> : <small className="muted">{when(r.createdAt)}</small>}
                  </span>
                  <b>{r.customerName}</b>
                  {r.clientScore && <ScoreChip s={r.clientScore} short />}
                  <span className="muted small">
                    {namesOf(r.items)} · <span className="ltr">{da(r.total)}</span>
                  </span>
                  <span className="agx-pcard-bot">
                    <span className="badge">{currentLabel(t, r.confStatus, r.attempts)}</span>
                    {gives && <AgentTag name={r.agentName} />}
                    <span className="muted small">{wilayaName(r.wilayaId)}</span>
                  </span>
                </button>
              </li>
              );
            })}
          </ul>
          {picking && (
            <PickBar
              n={chosen.length}
              options={(people.data ?? []).map((x) => ({ value: x.key, label: x.name }))}
              anyAgent={chosen.some((r) => r.agentId)}
              onGive={async (v) => {
                if (v === null) return give(null);
                const to = (people.data ?? []).find((x) => x.key === v);
                if (to) await give(to);
              }}
            />
          )}
          {cur && cur.seller && (
            <SellerScope seller={cur.seller.id}>
              <PhoneOrder order={cur} onClose={() => setOpen(null)} onDone={() => goNext(keyOf(cur))} />
            </SellerScope>
          )}
        </>
      ) : (
        <div className="tbl-wrap">
          <table className={`tbl qtbl agx-all-tbl${gives ? ' agx-gives' : ''}`}>
            <thead>
              <tr>
                <th className="ck">
                  <span className="sr-only">{t('confirmation.detail')}</span>
                </th>
                {gives && (
                  <th className="ck">
                    <input type="checkbox" aria-label={t('confirmation.selectAll')} checked={allOn} onChange={(e) => setSel(e.target.checked ? new Set(rows.map(keyOf)) : new Set())} />
                  </th>
                )}
                <th>{scope?.label ?? t('agency.seller')}</th>
                <th>{t('confirmation.col.order')}</th>
                <th>{t('confirmation.col.name')}</th>
                <th className="wide">{t('confirmation.col.product')}</th>
                <th>{t('confirmation.col.wilaya')}</th>
                <th className="num">{t('confirmation.col.total')}</th>
                {sub !== 'confirmees' && <th>{t('confirmation.col.chrono')}</th>}
                <th>{t('confirmation.col.status')}</th>
                <th>{t('agency.work.agent')}</th>
              </tr>
            </thead>
            <tbody>
              {!rows.length && (
                <tr>
                  <td colSpan={gives ? 11 : 10} className="empty">
                    {t(`confirmation.empty.${sub}`)}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const k = keyOf(r);
                const op = open === k;
                return (
                  <Fragment key={k}>
                    <tr className={`clickable ${op || sel.has(k) ? 'qsel' : ''}`} onClick={(e) => !(e.target as HTMLElement).closest('a,button,input,label') && setOpen(op ? null : k)}>
                      <td className="ck qexp">
                        <button type="button" className="icon-btn qic" aria-expanded={op} aria-label={t(op ? 'confirmation.hideDetail' : 'confirmation.showDetail', { ref: r.ref })} onClick={() => setOpen(op ? null : k)}>
                          <Icon name="chevron" />
                        </button>
                      </td>
                      {gives && (
                        <td className="ck">
                          <input type="checkbox" aria-label={t('confirmation.select', { ref: r.ref })} checked={sel.has(k)} onChange={(e) => setSel((s) => (e.target.checked ? new Set(s).add(k) : (s.delete(k), new Set(s))))} />
                        </td>
                      )}
                      <td data-l={scope?.label ?? t('agency.seller')}>{scope && r.seller ? scope.tag(r.seller) : <span className="chip agx-seller-chip">{r.seller?.name}</span>}</td>
                      <td data-l={t('confirmation.col.order')}>
                        <b className="ltr">{r.ref}</b>
                        <small>{when(r.createdAt)}</small>
                      </td>
                      <td data-l={t('confirmation.col.name')}>
                        <b>{r.customerName}</b>
                        {r.clientScore && <ScoreChip s={r.clientScore} short />}
                        <a className="ltr agx-tel" href={telHref(r.phone)} onClick={() => r.seller && rpc('orders.logCall', { id: r.id }, r.seller.id).catch(() => {})}>
                          {r.phone}
                        </a>
                      </td>
                      <td className="wide px-cw" data-l={t('confirmation.col.product')}>
                        <div className="px-clamp">{namesOf(r.items)}</div>
                      </td>
                      <td data-l={t('confirmation.col.wilaya')}>{wilayaName(r.wilayaId)}</td>
                      <td className="num" data-l={t('confirmation.col.total')}>
                        <span className="ltr">{da(r.total)}</span>
                      </td>
                      {sub !== 'confirmees' && <td data-l={t('confirmation.col.chrono')}>{r.deadline ? <Countdown d={r.deadline} short /> : <span className="muted">—</span>}</td>}
                      <td data-l={t('confirmation.col.status')}>
                        <span className={`badge t-${r.confStatus === 'no_answer' ? 'mid' : r.confStatus === 'confirmed' ? 'ok' : 'info'}`}>{currentLabel(t, r.confStatus, r.attempts)}</span>
                      </td>
                      <td data-l={t('agency.work.agent')}>{r.agentName ?? <span className="muted">—</span>}</td>
                    </tr>
                    {op && r.seller && (
                      <tr className="qdetail">
                        <td colSpan={gives ? 11 : 10} className="wide">
                          {/* the order works inside its store */}
                          <SellerScope seller={r.seller.id}>
                            <Detail order={r} onDone={() => goNext(k)} />
                          </SellerScope>
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
      {list.data && <Pager page={page} pageSize={size} total={total} onPage={setPage} onSize={(s) => (setSize(s), setPage(1))} />}
    </div>
  );
}

type GivePerson = Out<'agency.givePeople'>[number];

/**
 * « Attribuer » over every seller (an agency's chief and its chefs d'équipe): the ticked orders to one of the agency's
 * agents — each inside its seller's store, to the person's account there — or back to nobody. The store's own bar, in
 * short (Confirmation: Toolbar).
 */
function GiveBar(p: { n: number; people: GivePerson[]; anyAgent: boolean; busy: boolean; onClear: () => void; onGive: (to: GivePerson | null) => void }) {
  const { t } = useTranslation();
  const none = p.n === 0;
  const tip = t('confirmation.tb.tipNone');
  return (
    <div className="qacts" role="toolbar" aria-label={t('confirmation.tb.label')}>
      <span className={`qa-info ${p.n ? 'on' : ''}`}>
        {p.n ? t('confirmation.tb.selected', { count: p.n }) : t('confirmation.tb.none')}
        {p.n > 0 && (
          <button type="button" className="linkish" onClick={p.onClear}>
            {t('common.unselect')}
          </button>
        )}
      </span>
      <span className="qa-grp">
        <label className={`btn small qa-btn qa-wrap ${none ? 'is-dis' : ''}`} title={none ? tip : t('confirmation.tb.assign')}>
          <span className="qa-ic">
            <Icon name="userplus" />
          </span>
          <select
            className="qa-sel"
            aria-label={t('confirmation.tb.assign')}
            disabled={none || p.busy}
            value=""
            onChange={(e) => {
              const to = p.people.find((x) => x.key === e.target.value);
              if (to) p.onGive(to);
            }}
          >
            <option value="">{t('confirmation.tb.assign')}</option>
            {p.people.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn small qa-btn qa-danger" aria-label={t('confirmation.tb.removeAgent')} disabled={none || !p.anyAgent || p.busy} title={none ? tip : t('confirmation.tb.removeAgent')} onClick={() => p.onGive(null)}>
          <span className="qa-ic">
            <Icon name="userminus" />
          </span>
          <span className="qa-tx">{t('confirmation.tb.removeAgent')}</span>
        </button>
      </span>
    </div>
  );
}

/** « Commande suivante » over every seller: one order after the other, each inside its store. */
function FocusAll({ onClose, scope }: { onClose: () => void; scope?: AllScope }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState<{ seller: number; id: number } | null>(null);
  const [done, setDone] = useState(false);
  const skip = useRef<{ s: number; id: number }[]>([]);
  const sellers = useRpc('agency.sellers', {}, { staleTime: 60_000, enabled: !scope });
  const next = async () => {
    try {
      if (cur) await rpc('confirmation.release', { id: cur.id }, cur.seller).catch(() => {});
      const r = (await rpc('orders.next', { skip: [], skipAll: skip.current.slice(-400), ...(scope?.input ?? {}) } as never, 'all')) as unknown as { id: number | null; seller: number | null };
      if (r.id && r.seller) {
        skip.current.push({ s: r.seller, id: r.id });
        setCur({ seller: r.seller, id: r.id });
        setDone(false);
      } else {
        setCur(null);
        setDone(true);
      }
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    }
  };
  // the first order at once
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void next();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (cur && scope?.nameOf?.(cur.seller)) || ((sellers.data ?? []).find((s) => s.id === cur?.seller)?.name ?? '');
  if (!cur)
    return (
      <div className="card">
        <div className="card-head">
          <h2>{t('confirmation.focus.title')}</h2>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <div className="empty-box">{done ? t('confirmation.focus.none') : t('common.loading')}</div>
      </div>
    );
  return (
    <SellerScope key={`${cur.seller}:${cur.id}`} seller={cur.seller}>
      <Focus initialId={cur.id} onClose={onClose} onNext={next} seller={name} allSellers />
    </SellerScope>
  );
}

// ---------------------------------------------------------------- Suivi, every seller
type Tab = 'enlivraison' | 'alertes' | 'alertes_new' | 'alertes_encours' | 'traites' | 'livres' | 'annules';
const TABS: Tab[] = ['enlivraison', 'alertes', 'alertes_new', 'alertes_encours', 'traites', 'livres', 'annules'];
/** the tabs of the step chosen in the agency's menu: En livraison · Alertes (new, in progress, handled) · Livré · Annulé */
const stepTabs = (tab: Tab): Tab[] => (['alertes', 'alertes_new', 'alertes_encours', 'traites'].includes(tab) ? ['alertes_new', 'alertes_encours', 'traites'] : [tab]);
/** the step's links: Alertes also has « Réclamation » (with one seller chosen) */
const stepLinks = (tab: Tab): string[] => (stepTabs(tab).includes('traites') ? [...stepTabs(tab), 'reclamation'] : stepTabs(tab));
const alertTab = (tab: Tab) => tab === 'alertes' || tab === 'alertes_new' || tab === 'alertes_encours';
type SuiviRow = Out<'suivi.list'>['rows'][number] & { seller?: { id: number; name: string }; extra?: { alertReason: string | null } | null };

export function AllSuivi({ sub, scope }: PageProps & { scope?: AllScope }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const work = useSellers(!scope);
  const canFollow = has('suivi');
  const asked: Tab = TABS.includes(sub as Tab) ? (sub as Tab) : 'enlivraison';
  // a confirmation agent (no suivi): En livraison, Livré, Annulé — no alerts
  const tab: Tab = !canFollow && !['enlivraison', 'livres', 'annules'].includes(asked) ? 'enlivraison' : asked;
  const [page, setPage] = useState(1);
  const extra = JSON.stringify(scope?.input ?? {});
  useEffect(() => setPage(1), [tab, extra]);
  const c = useRpc('suivi.counts', (scope?.counts ?? {}) as never, { refetchInterval: 60_000 }).data;
  const q = useRpc('suivi.list', { tab, page, pageSize: 100, ...(scope?.input ?? {}) }, { refetchInterval: 60_000 });
  const [treat, setTreat] = useState<SuiviRow | null>(null);
  const [cancel, setCancel] = useState<SuiviRow | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const rows = (q.data?.rows ?? []) as SuiviRow[];
  const reason = (o: SuiviRow) => (o.followStatus === 'alert' ? o.extra?.alertReason || o.extStatus : o.extStatus);
  return (
    <>
      <StageBar flow={false} items={(scope?.tabs ?? stepLinks(tab)).map((k) => ({ key: k, label: t(k === 'traites' && !scope ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${k}`), href: `#/suivi/${k}`, count: k === 'reclamation' || k === 'swap' ? undefined : c?.[k as Tab] }))} current={tab} />
      <div className="card agx-all">
        <div className="card-head">
          <h2>
            {t(tab === 'traites' ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${tab}`)} <span className="badge ltr">{n(q.data?.total ?? 0)}</span>
          </h2>
          {scope?.chip ?? (
            <span className="chip agx-all-chip">
              <Icon name="store" /> {t('agency.pick.allShort')}
            </span>
          )}
        </div>
        <p className="muted small">{t(tab === 'enlivraison' && !scope ? 'suivi.help.enlivraisonAgency' : `suivi.help.${tab}`)}</p>
        {scope?.bar}
        {q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <Loading />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl agx-all-tbl">
              <thead>
                <tr>
                  <th>{scope?.label ?? t('agency.seller')}</th>
                  <th>{t('confirmation.col.order')}</th>
                  <th>{t('confirmation.col.name')}</th>
                  <th className="wide">{t('confirmation.col.product')}</th>
                  <th>{t('confirmation.col.wilaya')}</th>
                  <th>{t('confirmation.col.follow')}</th>
                  <th className="wide">{t('agency.work.reason')}</th>
                  {alertTab(tab) && canFollow && <th />}
                </tr>
              </thead>
              <tbody>
                {!rows.length && (
                  <tr>
                    <td colSpan={8} className="empty">
                      {t('agency.work.noParcel')}
                    </td>
                  </tr>
                )}
                {rows.map((o) => (
                  <tr key={keyOf(o)} className="clickable" onClick={(e) => !(e.target as HTMLElement).closest('a,button') && o.seller && openOrder(o.id, o.seller.id)}>
                    <td data-l={scope?.label ?? t('agency.seller')}>{scope && o.seller ? scope.tag(o.seller) : <span className="chip agx-seller-chip">{o.seller?.name}</span>}</td>
                    <td data-l={t('confirmation.col.order')}>
                      <b className="ltr">{o.ref}</b>
                      <small>{when(o.updatedAt)}</small>
                    </td>
                    <td data-l={t('confirmation.col.name')}>
                      <b>{o.customerName}</b>
                      {o.clientScore && <ScoreChip s={o.clientScore} short />}
                      <a className="ltr agx-tel" href={telHref(o.phone)} onClick={() => o.seller && rpc('orders.logCall', { id: o.id }, o.seller.id).catch(() => {})}>
                        {o.phone}
                      </a>
                    </td>
                    <td className="wide px-cw" data-l={t('confirmation.col.product')}>
                      <div className="px-clamp">{namesOf(o.items)}</div>
                    </td>
                    <td data-l={t('confirmation.col.wilaya')}>{wilayaName(o.wilayaId)}</td>
                    <td data-l={t('confirmation.col.follow')}>
                      <StatusBadge kind="follow" status={o.followStatus} />
                      {o.companyName && (
                        <small>
                          {o.companyName}
                          {trackOf(o) ? ` · ${trackOf(o)}` : ''}
                        </small>
                      )}
                    </td>
                    <td className="wide px-cw" data-l={t('agency.work.reason')}>
                      <div className="px-clamp">{reason(o) || <span className="muted">—</span>}</div>
                    </td>
                    {alertTab(tab) && canFollow && (
                      <td className="agx-row-act">
                        {(scope ? canFollow : work.list.find((s) => s.id === o.seller?.id)?.tasks.includes('suivi')) && <>
                        <button type="button" className="btn small primary" onClick={() => setTreat(o)}>
                          {t('suivi.act.treat')}
                        </button>
                        <button type="button" className="btn small ghost danger" onClick={() => setCancel(o)}>
                          {t('suivi.act.cancel')}
                        </button>
                        </>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {q.data && <Pager page={page} pageSize={100} total={q.data.total} onPage={setPage} />}
      {treat && treat.seller && (
        <SellerScope seller={treat.seller.id}>
          <TreatModal o={treat} reason={reason(treat)} onClose={() => setTreat(null)} />
        </SellerScope>
      )}
      {cancel && cancel.seller && (
        <Modal
          title={t('agency.work.cancelTitle', { ref: cancel.ref })}
          onClose={() => setCancel(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCancel(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await rpc('suivi.act', { id: cancel.id, action: 'cancel' }, cancel.seller!.id);
                    toast(t('suivi.msg.cancelled', { ref: cancel.ref }), 'ok');
                    setCancel(null);
                    qc.invalidateQueries();
                  } catch (e: any) {
                    toast(e?.message ?? t('common.error'), 'bad');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('suivi.act.cancel')}
              </button>
            </>
          }
        >
          <p>{t('agency.work.cancelText', { name: cancel.customerName, seller: cancel.seller.name })}</p>
        </Modal>
      )}
    </>
  );
}
