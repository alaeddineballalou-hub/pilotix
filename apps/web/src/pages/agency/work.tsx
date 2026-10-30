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
import { useRpc } from '../../lib/query';
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
import { PhoneOrder } from '../confirmation/PhoneList';
import { currentLabel, SUB_TONE, telHref } from '../confirmation/shared';
import type { PageProps } from '../registry';
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
  return (
    <SellerScope seller={seller}>
      <AgentView>
        <NotGiven task="suivi">{seller === 'all' ? <AllSuivi {...props} /> : <Suivi key={seller} {...props} />}</NotGiven>
      </AgentView>
    </SellerScope>
  );
}

/** The seller chosen does not give this work to the agency (or no seller yet): say so, and offer all the sellers. */
function NotGiven({ task, children }: { task: 'confirmation' | 'suivi'; children: ReactNode }) {
  const { t } = useTranslation();
  const w = useSellers();
  if (!w.loaded) return <Loading />;
  if (!w.list.length) return <Empty>{t('agency.home.noWhere')}</Empty>;
  if (w.tasks.has(task)) return <>{children}</>;
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

// ---------------------------------------------------------------- Confirmation, every seller
type Sub = 'nouvelles' | 'attente' | 'confirmees';
const SUBS: Sub[] = ['nouvelles', 'attente', 'confirmees'];
type ConfRow = Out<'confirmation.list'>['rows'][number] & { seller?: { id: number; name: string } };
/** an order of « Tous les vendeurs »: the same number can belong to two stores */
const keyOf = (r: { id: number; seller?: { id: number } }) => `${r.seller?.id ?? 0}:${r.id}`;

function AllConfirmation({ sub: raw }: PageProps) {
  const { t } = useTranslation();
  const sub: Sub = SUBS.includes(raw as Sub) ? (raw as Sub) : 'nouvelles';
  const c = useRpc('confirmation.counts', {}, { refetchInterval: 60_000 }).data;
  return (
    <>
      <StageBar items={SUBS.map((k) => ({ key: k, label: t(`confirmation.sub.${k}`), href: `#/confirmation/${k}`, count: c?.[k] }))} current={sub} />
      <AllQueue key={sub} sub={sub} />
    </>
  );
}

function AllQueue({ sub }: { sub: Sub }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { has } = useSession();
  const phone = useIsPhone();
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => (setQd(q.trim()), setPage(1)), 350);
    return () => clearTimeout(id);
  }, [q]);
  const list = useRpc('confirmation.list', { sub, q: qd || undefined, page, pageSize: size }, { refetchInterval: 60_000 });
  const rows = (list.data?.rows ?? []) as ConfRow[];
  const canNext = sub !== 'confirmees' && has('confirmation');
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
  if (focus) return <FocusAll onClose={() => setFocus(false)} />;
  const cur = rows.find((r) => keyOf(r) === open);
  const total = list.data?.total ?? 0;
  return (
    <div className="card qcard agx-all">
      <div className="card-head px-qhead">
        <h2>
          {t(`confirmation.title.${sub}`)} <span className={`badge t-${SUB_TONE[sub]} ltr`}>{n(total)}</span>
        </h2>
        <div className="row">
          <span className="chip agx-all-chip">
            <Icon name="store" /> {t('agency.pick.allShort')}
          </span>
          {canNext && (
            <button type="button" className="btn primary px-qnext" onClick={() => setFocus(true)}>
              {t('confirmation.next').replace(/\s*[→←]\s*$/, '')}
              <Icon name="chevr" className="px-qnext-ar" />
            </button>
          )}
        </div>
      </div>
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
          <ul className="agx-pcards">
            {!rows.length && <li className="empty-box">{t(`confirmation.empty.${sub}`)}</li>}
            {rows.map((r) => (
              <li key={keyOf(r)}>
                <button type="button" className="agx-pcard" onClick={() => setOpen(keyOf(r))}>
                  <span className="agx-pcard-top">
                    <span className="chip agx-seller-chip">{r.seller?.name}</span>
                    {r.deadline ? <Countdown d={r.deadline} short /> : <small className="muted">{when(r.createdAt)}</small>}
                  </span>
                  <b>{r.customerName}</b>
                  {r.clientScore && <ScoreChip s={r.clientScore} short />}
                  <span className="muted small">
                    {namesOf(r.items)} · <span className="ltr">{da(r.total)}</span>
                  </span>
                  <span className="agx-pcard-bot">
                    <span className="badge">{currentLabel(t, r.confStatus, r.attempts)}</span>
                    <span className="muted small">{wilayaName(r.wilayaId)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {cur && cur.seller && (
            <SellerScope seller={cur.seller.id}>
              <PhoneOrder order={cur} onClose={() => setOpen(null)} onDone={() => goNext(keyOf(cur))} />
            </SellerScope>
          )}
        </>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl qtbl agx-all-tbl">
            <thead>
              <tr>
                <th className="ck">
                  <span className="sr-only">{t('confirmation.detail')}</span>
                </th>
                <th>{t('agency.seller')}</th>
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
                  <td colSpan={10} className="empty">
                    {t(`confirmation.empty.${sub}`)}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const k = keyOf(r);
                const op = open === k;
                return (
                  <Fragment key={k}>
                    <tr className={`clickable ${op ? 'qsel' : ''}`} onClick={(e) => !(e.target as HTMLElement).closest('a,button') && setOpen(op ? null : k)}>
                      <td className="ck qexp">
                        <button type="button" className="icon-btn qic" aria-expanded={op} aria-label={t(op ? 'confirmation.hideDetail' : 'confirmation.showDetail', { ref: r.ref })} onClick={() => setOpen(op ? null : k)}>
                          <Icon name="chevron" />
                        </button>
                      </td>
                      <td data-l={t('agency.seller')}>
                        <span className="chip agx-seller-chip">{r.seller?.name}</span>
                      </td>
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
                        <td colSpan={10} className="wide">
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

/** « Commande suivante » over every seller: one order after the other, each inside its store. */
function FocusAll({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState<{ seller: number; id: number } | null>(null);
  const [done, setDone] = useState(false);
  const skip = useRef<{ s: number; id: number }[]>([]);
  const sellers = useRpc('agency.sellers', {}, { staleTime: 60_000 });
  const next = async () => {
    try {
      if (cur) await rpc('confirmation.release', { id: cur.id }, cur.seller).catch(() => {});
      const r = (await rpc('orders.next', { skip: [], skipAll: skip.current.slice(-400) } as never, 'all')) as unknown as { id: number | null; seller: number | null };
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
  const name = (sellers.data ?? []).find((s) => s.id === cur?.seller)?.name ?? '';
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
type Tab = 'alertes' | 'traites' | 'livres' | 'annules';
const TABS: Tab[] = ['alertes', 'traites', 'livres', 'annules'];
type SuiviRow = Out<'suivi.list'>['rows'][number] & { seller?: { id: number; name: string }; extra?: { alertReason: string | null } | null };

function AllSuivi({ sub }: PageProps) {
  const { t } = useTranslation();
  const tab: Tab = TABS.includes(sub as Tab) ? (sub as Tab) : 'alertes';
  const c = useRpc('suivi.counts', {}, { refetchInterval: 60_000 }).data;
  const q = useRpc('suivi.list', { tab }, { refetchInterval: 60_000 });
  const [treat, setTreat] = useState<SuiviRow | null>(null);
  const [cancel, setCancel] = useState<SuiviRow | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const rows = (q.data?.rows ?? []) as SuiviRow[];
  const reason = (o: SuiviRow) => (o.followStatus === 'alert' ? o.extra?.alertReason || o.extStatus : o.extStatus);
  return (
    <>
      <StageBar flow={false} items={TABS.map((k) => ({ key: k, label: t(`suivi.tabs.${k}`), href: `#/suivi/${k}`, count: c?.[k] }))} current={tab} />
      <div className="card agx-all">
        <div className="card-head">
          <h2>
            {t(`suivi.tabs.${tab}`)} <span className="badge ltr">{n(q.data?.total ?? 0)}</span>
          </h2>
          <span className="chip agx-all-chip">
            <Icon name="store" /> {t('agency.pick.allShort')}
          </span>
        </div>
        <p className="muted small">{t(`suivi.help.${tab}`)}</p>
        {q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <Loading />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl agx-all-tbl">
              <thead>
                <tr>
                  <th>{t('agency.seller')}</th>
                  <th>{t('confirmation.col.order')}</th>
                  <th>{t('confirmation.col.name')}</th>
                  <th className="wide">{t('confirmation.col.product')}</th>
                  <th>{t('confirmation.col.wilaya')}</th>
                  <th>{t('confirmation.col.follow')}</th>
                  <th className="wide">{t('agency.work.reason')}</th>
                  {tab === 'alertes' && <th />}
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
                    <td data-l={t('agency.seller')}>
                      <span className="chip agx-seller-chip">{o.seller?.name}</span>
                    </td>
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
                    {tab === 'alertes' && (
                      <td className="agx-row-act">
                        <button type="button" className="btn small primary" onClick={() => setTreat(o)}>
                          {t('suivi.act.treat')}
                        </button>
                        <button type="button" className="btn small ghost danger" onClick={() => setCancel(o)}>
                          {t('suivi.act.cancel')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
