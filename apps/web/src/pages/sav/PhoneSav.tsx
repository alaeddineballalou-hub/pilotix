// SAV on phones, built around the call. The customer calls → « Nouvel appel »: find the order by the number,
// what the problem is, then it ends one of two ways:
//   « Réglé au téléphone » — solved by talking, the ticket is born finished, with the customer's satisfaction;
//   « Échange → dépôt »   — the exchange order goes to the depot (À préparer → partner → dispatch) and the ticket
//                            follows it; once delivered, the customer is called back for the satisfaction.
// SAV is after delivery (cash on delivery): an order not delivered yet goes to Suivi › Réclamation.
// Pas content / Moyen always come with the reason.
import { EXCHANGE_KINDS } from '@pilotix/shared';
import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import type { Out } from '../../lib/backend';
import { da, dur, when, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading, StatusBadge } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { waLink } from '../suivi/common';
import { NEW_TYPES, takePendingOrder } from './NewTicket';
import { useStaff } from './staff';
import '../confirmation/phone.css';
import '../suivi/phone.css';
import './phone.css';

type Stage = 'todo' | 'depot' | 'livraison' | 'satisfaction' | 'termines';
type Owner = 'me' | 'none' | 'all';
const STAGES: Stage[] = ['todo', 'depot', 'livraison', 'satisfaction', 'termines'];
const VIEW: Record<Stage, 'attente' | 'depot' | 'livraison' | 'satisfaction' | 'termines'> = { todo: 'attente', depot: 'depot', livraison: 'livraison', satisfaction: 'satisfaction', termines: 'termines' };
const TYPE_ICON: Record<string, string> = { defect: 'wrench', missing: 'boxminus', wrong: 'shirt', late: 'timer', notdelivered: 'truck', refund: 'coins', exchange: 'swap', help: 'help', other: 'chat' };
export const FACES = ['', 'frown', 'meh', 'smile', 'laugh'];
const DELIVERED = ['delivered', 'exchanged'];
const ON_ROAD = ['shipped', 'out_for_delivery', 'alert', 'failed', 'in_exchange'];
const LATE_MS = 48 * 3_600_000;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** Full-screen pages: the page behind does not scroll; Échap / the phone's back closes. One history entry is shared
 *  by the SAV pages, so going from the call to its ticket does not pop the new page. */
let openPages = 0;
function useFullScreen(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    openPages++;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-wrap, .pxv-sheet') && ref.current();
    const back = () => ref.current();
    if (!history.state?.pxv) history.pushState({ pxv: 1 }, '');
    window.addEventListener('keydown', esc);
    window.addEventListener('popstate', back);
    return () => {
      openPages--;
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', esc);
      window.removeEventListener('popstate', back);
      setTimeout(() => {
        if (!openPages && history.state?.pxv) history.back();
      }, 0);
    };
  }, []);
}

// ---------------------------------------------------------------- the satisfaction faces
export function Faces({ value, onChange, small }: { value: number | null; onChange: (v: number) => void; small?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`pxv-faces${small ? ' sm' : ''}`} role="radiogroup" aria-label={t('sav.ph.satQ')}>
      {[1, 2, 3, 4].map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={`pxv-face f${v}${value === v ? ' on' : ''}`} onClick={() => onChange(v)}>
          <Icon name={FACES[v]} />
          <span>{t(`sav.sat.${v}`)}</span>
        </button>
      ))}
    </div>
  );
}

/** The face the customer gave, as a small badge. */
export function SatBadge({ v }: { v: number | null }) {
  const { t } = useTranslation();
  if (!v) return null;
  return (
    <span className={`pxv-sat f${v}`}>
      <Icon name={FACES[v]} /> {t(`sav.sat.${v}`)}
    </span>
  );
}

/** A bottom sheet over the page. */
function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="pxv-sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <button type="button" className="pxv-dim" aria-label={t('common.close')} onClick={onClose} />
      <div className="pxv-sh">
        <span className="pxv-grab" aria-hidden="true" />
        <div className="pxv-shh">
          <b>{title}</b>
          <button type="button" className="pxp-back" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Satisfaction + "why" when not satisfied. Returns null when what was entered cannot be saved yet. */
function SatFields({ sat, setSat, why, setWhy }: { sat: number | null; setSat: (v: number) => void; why: string; setWhy: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="pxv-lbl">{t('sav.ph.satQ')}</div>
      <Faces value={sat} onChange={setSat} />
      {sat !== null && sat <= 2 && (
        <label className="pxv-why">
          <span>
            {t('sav.ph.why')} <em>*</em>
          </span>
          <textarea rows={2} value={why} autoFocus maxLength={1000} placeholder={t('sav.ph.whyPh')} onChange={(e) => setWhy(e.target.value)} />
        </label>
      )}
    </>
  );
}
const satReady = (sat: number | null, why: string) => sat !== null && (sat >= 3 || why.trim().length > 0);

// ---------------------------------------------------------------- the list
export function PhoneSav({ sub }: { sub?: string }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>(() => (STAGES as string[]).includes(store.get('px-savp-stage') ?? '') ? (store.get('px-savp-stage') as Stage) : 'todo');
  const [owner, setOwner] = useState<Owner>(() => (['me', 'none', 'all'].includes(store.get('px-savp-owner') ?? '') ? (store.get('px-savp-owner') as Owner) : 'all'));
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [calling, setCalling] = useState(sub === 'nouveau');
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (sub === 'nouveau') setCalling(true);
  }, [sub]);
  const kp = useRpc('sav.kpis', {}, { refetchInterval: 60_000 });
  const list = useRpc('sav.list', { view: VIEW[stage], q: deb || undefined, owner, pageSize: 200 });
  const k = kp.data;
  const count: Record<Stage, number | undefined> = { todo: k?.attente, depot: k?.depot, livraison: k?.livraison, satisfaction: k?.satisfaction, termines: k?.termines };
  const pick = (s: Stage) => (setStage(s), store.set('px-savp-stage', s));
  const pickOwner = (o: Owner) => (setOwner(o), store.set('px-savp-owner', o));
  const active = stage === 'todo' || stage === 'depot' || stage === 'livraison';
  const rows = list.data?.rows ?? [];
  const c = list.data?.counts;
  const closeCall = () => {
    setCalling(false);
    if (sub === 'nouveau') location.hash = '#/sav/tickets';
  };

  return (
    <div className="pxv">
      <div className="pxv-road" role="tablist">
        {STAGES.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={stage === s} className={`${stage === s ? 'on' : ''}${s === 'todo' && k?.attenteLate ? ' al' : ''}`} onClick={() => pick(s)}>
            {t(`sav.ph.stage.${s}`)}
            {count[s] !== undefined && <b className="ltr">{count[s]}</b>}
          </button>
        ))}
        <a className="pxv-stlink" href="#/sav/stats">
          <Icon name="chart" /> {t('sav.views.stats')}
        </a>
      </div>
      <input className="pxv-search" type="search" value={q} placeholder={t('sav.ph.searchPh')} aria-label={t('sav.search')} enterKeyHint="search" onChange={(e) => setQ(e.target.value)} />
      {active && (
        <div className="pxv-own" role="tablist">
          {(['me', 'none', 'all'] as const).map((o) => (
            <button key={o} type="button" role="tab" aria-selected={owner === o} className={owner === o ? 'on' : ''} onClick={() => pickOwner(o)}>
              {t(`sav.ph.owner.${o}`)} <b className="ltr">{c ? (o === 'me' ? c.mine : o === 'none' ? c.nobody : c.view) : ''}</b>
            </button>
          ))}
        </div>
      )}
      {stage === 'satisfaction' && <p className="pxv-help">{t('sav.ph.satHelp')}</p>}

      {list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Loading />
      ) : !rows.length ? (
        <div className="pxv-empty">
          <Icon name={stage === 'satisfaction' ? 'smile' : 'checkcircle'} />
          <p>{t(`sav.ph.empty.${stage}`)}</p>
        </div>
      ) : stage === 'satisfaction' ? (
        <ul className="pxv-list">
          {rows.map((x) => (
            <SatCard key={x.id} x={x} onOpen={() => setOpen(x.id)} />
          ))}
        </ul>
      ) : (
        <ul className="pxv-inbox">
          {[...rows]
            .sort((a, b) => (active ? Number(Date.now() - Date.parse(b.createdAt) > LATE_MS) - Number(Date.now() - Date.parse(a.createdAt) > LATE_MS) : 0))
            .map((x) => (
              <TicketRow key={x.id} x={x} stage={stage} onOpen={() => setOpen(x.id)} />
            ))}
        </ul>
      )}

      <button type="button" className="pxp-next pxv-call" onClick={() => setCalling(true)}>
        <Icon name="phone" /> {t('sav.ph.newCall')}
      </button>
      {calling && (
        <CallFlow
          onClose={closeCall}
          onOpen={(id) => {
            closeCall();
            setOpen(id);
          }}
        />
      )}
      {open && <TicketPage id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </div>
  );
}

type Ticket = Out<'sav.list'>['rows'][number];

function TicketRow({ x, stage, onOpen }: { x: Ticket; stage: Stage; onOpen: () => void }) {
  const { t } = useTranslation();
  const activeT = x.status === 'open' || x.status === 'progress';
  const age = (x.resolvedAt ? Date.parse(x.resolvedAt) : Date.now()) - Date.parse(x.createdAt);
  const late = activeT && age > LATE_MS;
  return (
    <li>
      <button type="button" className={`pxv-row${late ? ' late' : ''}`} onClick={onOpen}>
        <span className={`pxv-ti t-${x.type}`} aria-hidden="true">
          <Icon name={TYPE_ICON[x.type] ?? 'help'} />
        </span>
        <span className="pxv-rm">
          <span className="pxv-r1">
            <b>{x.customerName || x.phone || '—'}</b>
            {activeT && !x.assignedTo && <i className="pxv-dot" title={t('sav.ph.nobody')} />}
            {stage === 'termines' ? <SatBadge v={x.satisfaction} /> : <span className={`pxv-age${late ? ' l' : ''}`}>{dur(age)}</span>}
          </span>
          <span className="pxv-r2">
            {t(`sav.type.${x.type}`)}
            {x.wish && stage === 'todo' ? <em> · {t(`sav.wish.${x.wish}`)}</em> : null}
          </span>
          {stage === 'depot' || stage === 'livraison' ? (
            <span className="pxv-r3">
              <span className="ltr">{x.exchangeRef}</span> · {x.exchangeFollow ? t(`status.follow.${x.exchangeFollow}`) : ''}
            </span>
          ) : stage === 'termines' ? (
            <span className="pxv-r3">
              {x.status === 'closed' ? t('sav.ph.end.closed') : x.resolution === 'phone' ? t('sav.ph.end.phone') : t('sav.ph.end.exchange', { ref: x.exchangeRef ?? '' })} · {when(x.resolvedAt ?? x.updatedAt)}
            </span>
          ) : (
            x.details && <span className="pxv-r3">{x.details}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Satisfaction call after a delivered exchange: call, then one tap (with the reason when not satisfied). */
function SatCard({ x, onOpen }: { x: Ticket; onOpen: () => void }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState<number | null>(null);
  const rate = useAction('sav.rate', { success: t('sav.ph.satSaved') });
  const noAns = useAction('sav.rate', { success: t('sav.ph.noAnswerSaved') });
  const choose = (v: number) => (v >= 3 ? rate.mutate({ id: x.id, satisfaction: v }) : setAsk(v));
  return (
    <li className="pxv-sc">
      <div className="pxv-sch">
        <button type="button" className="pxv-scn" onClick={onOpen}>
          <b>{x.customerName || '—'}</b>
          <small>
            <span className="ltr">{x.exchangeRef}</span> · {x.exchangeKind ? t(`sav.kind.${x.exchangeKind}`) : t(`sav.type.${x.type}`)} · {t('sav.ph.deliveredOn', { d: when(x.resolvedAt) })}
            {x.satTries ? ` · ${t('sav.ph.tries', { count: x.satTries })}` : ''}
          </small>
        </button>
        {x.phone && (
          <>
            <a className="pxp-call big" href={`tel:${x.phone}`} aria-label={t('sav.ph.call')}>
              <Icon name="phone" />
            </a>
            <a className="pxp-wa" href={waLink(x.phone, t('sav.ph.waSat', { nom: x.customerName ?? '' }))} target="_blank" rel="noopener" aria-label="WhatsApp">
              <Icon name="whatsapp" />
            </a>
          </>
        )}
      </div>
      <Faces value={null} onChange={choose} small />
      <div className="pxv-sca">
        <button type="button" className="pxs-chip" disabled={noAns.isPending} onClick={() => noAns.mutate({ id: x.id, noAnswer: true })}>
          <Icon name="phoneoff" /> {t('sav.ph.noAnswer')}
        </button>
      </div>
      {ask !== null && <WhySheet x={x} sat={ask} onClose={() => setAsk(null)} />}
    </li>
  );
}

/** Not satisfied: why (required); save, or reopen the ticket to do something more. */
function WhySheet({ x, sat: sat0, onClose }: { x: Ticket; sat: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [sat, setSat] = useState<number | null>(sat0);
  const [why, setWhy] = useState('');
  const rate = useAction('sav.rate', { onDone: onClose });
  const ok = satReady(sat, why);
  const send = (reopen: boolean) => {
    rate.mutate({ id: x.id, satisfaction: sat ?? 1, satisfactionNote: why.trim(), reopen }, { onSuccess: () => toast(reopen ? t('sav.ph.reopened', { ref: x.ref }) : t('sav.ph.satSaved'), 'ok') });
  };
  return (
    <Sheet title={x.customerName || x.ref} onClose={onClose}>
      <SatFields sat={sat} setSat={setSat} why={why} setWhy={setWhy} />
      <div className="pxv-shb">
        <button type="button" className="pxv-btn" disabled={!ok || rate.isPending} onClick={() => send(true)}>
          <Icon name="undo" /> {t('sav.ph.reopen')}
        </button>
        <button type="button" className="pxv-btn nv" disabled={!ok || rate.isPending} onClick={() => send(false)}>
          {t('common.save')}
        </button>
      </div>
      {!ok && sat !== null && sat <= 2 && <p className="pxv-req">{t('sav.ph.whyReq')}</p>}
    </Sheet>
  );
}

// ---------------------------------------------------------------- « Nouvel appel »
function CallFlow({ onClose, onOpen }: { onClose: () => void; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const { me } = useSession();
  useFullScreen(onClose);
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const [without, setWithout] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<string>('defect');
  const [details, setDetails] = useState('');
  const [settle, setSettle] = useState(false);
  const [exFor, setExFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  // "Ticket SAV" on an order card starts here with that order
  const [preId] = useState(() => takePendingOrder()?.id ?? null);
  const pre = useRpc('orders.get', { id: preId ?? 0 }, { enabled: !!preId });
  useEffect(() => {
    if (pre.data && !order) setOrder(pre.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pre.data]);
  const found = useRpc('sav.findOrder', { q: deb, deliveredFirst: true }, { enabled: deb.length >= 2 && !order && !without });
  const digits = deb.replace(/\D/g, '');
  const openT = useRpc('sav.list', { view: 'todo', q: digits.length >= 6 ? digits : order?.phone ?? '' }, { enabled: digits.length >= 6 || !!order?.phone });
  const already = (openT.data?.rows ?? []).filter((x) => !order || x.orderId === order.id || x.phone === order.phone);
  const step = order || without ? 2 : 1;

  const delivered = (found.data ?? []).filter((o) => DELIVERED.includes(o.followStatus ?? ''));
  // on the road: no SAV before delivery, it is a réclamation in Suivi; not shipped yet: only counted
  const notYet = (found.data ?? []).filter((o) => ON_ROAD.includes(o.followStatus ?? ''));
  const notShipped = (found.data ?? []).length - delivered.length - notYet.length;
  const toClaim = (o: Order) => {
    try {
      sessionStorage.setItem('px-rec-q', o.ref);
      sessionStorage.setItem('px-rec-tab', 'search');
    } catch {
      /* private mode */
    }
    onClose();
    setTimeout(() => (location.hash = '#/suivi/reclamation'), 0);
  };
  const ready = details.trim().length > 0 && (order || name.trim() || phone.trim());
  const base = () => ({
    orderId: order?.id ?? null,
    customerName: order ? null : name.trim() || null,
    phone: order ? null : phone.trim() || null,
    type: type as (typeof NEW_TYPES)[number],
    details: details.trim(),
    assignedTo: me || null,
  });
  const create = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const r = await rpc('sav.create', { ...base(), ...extra } as any);
      qc.invalidateQueries();
      return r;
    } catch (e: any) {
      toast(e.message, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const later = async () => {
    const r = await create();
    if (r) (toast(t('sav.ph.savedLater', { ref: r.ref }), 'ok'), onClose());
  };
  const exchange = async () => {
    const r = await create({ wish: 'exchange' });
    if (r) setExFor(r.id);
  };

  if (exFor) return <ExchangeLoader id={exFor} onBack={() => onOpen(exFor)} onDone={() => onOpen(exFor)} />;

  return (
    <div className="pxp-order pxv-page" role="dialog" aria-modal="true" aria-label={t('sav.ph.newCall')}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={step === 2 && !preId ? t('common.back') : t('common.close')} onClick={() => (step === 2 && !preId ? (setOrder(null), setWithout(false)) : onClose())}>
          <Icon name={step === 2 && !preId ? 'chevl' : 'x'} />
        </button>
        <div className="pxp-ot">
          {step === 1 ? (
            <b>{t('sav.ph.newCall')}</b>
          ) : order ? (
            <>
              <b>
                {order.customerName} · <span className="ltr">{order.ref}</span>
              </b>
              <small>
                {order.items.map((i) => i.name).join(' + ')} · {order.deliveredAt ? t('sav.ph.deliveredAgo', { d: dur(Date.now() - Date.parse(order.deliveredAt)) }) : t(`status.follow.${order.followStatus}`)}
              </small>
            </>
          ) : (
            <b>{t('sav.ph.noOrderTitle')}</b>
          )}
        </div>
        <span className="pxv-stepn ltr">{step} / 2</span>
      </header>

      <div className="pxp-ob pxv-ob">
        {step === 1 ? (
          <>
            <div className="pxv-find">
              <Icon name="phone" />
              <input type="search" inputMode="tel" autoFocus value={q} placeholder={t('sav.ph.findPh')} aria-label={t('sav.ph.findPh')} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
            </div>
            {deb.length < 2 ? (
              <p className="pxv-help">{t('sav.ph.findHelp')}</p>
            ) : found.isFetching && !found.data ? (
              <Loading />
            ) : !delivered.length && !notYet.length ? (
              <p className="pxv-help">
                {t('sav.form.noOrder')}
                {notShipped > 0 ? ` ${t('sav.ph.notShipped', { count: notShipped })}` : ''}
              </p>
            ) : (
              <>
                {delivered.length > 0 && <div className="pxv-lbl">{t('sav.ph.delivered', { count: delivered.length })}</div>}
                {delivered.map((o) => (
                  <button key={o.id} type="button" className="pxv-ord" onClick={() => setOrder(o)}>
                    <span className="pxs-th" aria-hidden="true">
                      <Icon name="package" />
                    </span>
                    <span className="pxv-on">
                      <b>
                        <span className="ltr">{o.ref}</span> · {o.customerName}
                      </b>
                      <small>
                        {o.items.map((i) => `${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + ')} · {wilayaName(o.wilayaId)} · <span className="ltr">{da(o.total)}</span>
                      </small>
                    </span>
                    <StatusBadge kind="follow" status={o.followStatus} />
                  </button>
                ))}
                {notYet.length > 0 && <div className="pxv-lbl">{t('sav.ph.notYet')}</div>}
                {notYet.map((o) => (
                  <button key={o.id} type="button" className="pxv-ord dim" onClick={() => toClaim(o)}>
                    <span className="pxs-th" aria-hidden="true">
                      <Icon name="truck" />
                    </span>
                    <span className="pxv-on">
                      <b>
                        <span className="ltr">{o.ref}</span> · {o.customerName}
                      </b>
                      <small>
                        {t(`status.follow.${o.followStatus}`)} · {o.companyName || o.livreurName || ''} · {t('sav.ph.notPaid')}
                      </small>
                    </span>
                    <span className="pxv-go">
                      {t('sav.ph.toClaim')} <Icon name="chevr" />
                    </span>
                  </button>
                ))}
                {notShipped > 0 && <p className="pxv-help">{t('sav.ph.notShipped', { count: notShipped })}</p>}
              </>
            )}
            {already.length > 0 && (
              <button type="button" className="pxv-warn" onClick={() => onOpen(already[0].id)}>
                <Icon name="alert" />
                <span>{t('sav.ph.already', { ref: already[0].ref, type: t(`sav.type.${already[0].type}`) })}</span>
                <b>{t('sav.ph.openIt')}</b>
              </button>
            )}
            <button type="button" className="pxv-link" onClick={() => (setWithout(true), setPhone(digits.length >= 6 ? q.trim() : ''))}>
              {t('sav.ph.withoutOrder')}
            </button>
          </>
        ) : (
          <>
            {without && !order && (
              <section className="pxs-sec">
                <h4>{t('sav.t.client')}</h4>
                <div className="pxv-g2">
                  <input value={name} placeholder={t('sav.form.name')} aria-label={t('sav.form.name')} onChange={(e) => setName(e.target.value)} />
                  <input type="tel" className="ltr" value={phone} placeholder={t('sav.form.phone')} aria-label={t('sav.form.phone')} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </section>
            )}
            {already.length > 0 && (
              <button type="button" className="pxv-warn" onClick={() => onOpen(already[0].id)}>
                <Icon name="alert" />
                <span>{t('sav.ph.already', { ref: already[0].ref, type: t(`sav.type.${already[0].type}`) })}</span>
                <b>{t('sav.ph.openIt')}</b>
              </button>
            )}
            <section className="pxs-sec">
              <h4>{t('sav.form.problem')}</h4>
              <div className="pxv-tiles">
                {NEW_TYPES.filter((x) => x !== 'refund' && x !== 'exchange').map((x) => (
                  <button key={x} type="button" className={`pxv-tile${type === x ? ' on' : ''}`} aria-pressed={type === x} onClick={() => setType(x)}>
                    <Icon name={TYPE_ICON[x]} />
                    <span>{t(`sav.ph.type.${x}`)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="pxs-sec">
              <h4>{t('sav.ph.says')}</h4>
              <textarea className="pxv-ta" rows={3} value={details} maxLength={2000} placeholder={t('sav.form.detailsPh')} onChange={(e) => setDetails(e.target.value)} />
            </section>
          </>
        )}
      </div>

      {step === 2 && (
        <div className="pxs-bar pxv-bar">
          <div className="pxv-ends">
            <button type="button" className="pxv-end ok" disabled={!ready || busy} onClick={() => setSettle(true)}>
              <Icon name="check" />
              <span>
                {t('sav.ph.settled')}
                <small>{t('sav.ph.settledSub')}</small>
              </span>
            </button>
            <button type="button" className="pxv-end or" disabled={!ready || busy || !order} onClick={exchange}>
              <Icon name="swap" />
              <span>
                {t('sav.ph.exchange')}
                <small>{t('sav.ph.exchangeSub')}</small>
              </span>
            </button>
          </div>
          <button type="button" className="pxv-btn" disabled={!ready || busy} onClick={later}>
            <Icon name="clock" /> {t('sav.ph.later')}
          </button>
          {!ready && <p className="pxv-req">{t('sav.ph.needSays')}</p>}
        </div>
      )}
      {settle && (
        <SettleSheet
          onClose={() => setSettle(false)}
          onSave={async (s) => {
            const r = await create({ settle: s });
            if (r) (toast(t('sav.ph.settledDone', { ref: r.ref }), 'ok'), onClose());
          }}
        />
      )}
    </div>
  );
}

type SettleIn = { reason: 'explain' | 'gesture' | 'changed' | 'other'; note: string; satisfaction: number; satisfactionNote: string };
/** « Réglé au téléphone »: what solved it, a word, and the customer's satisfaction. */
function SettleSheet({ onClose, onSave }: { onClose: () => void; onSave: (s: SettleIn) => Promise<void> | void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<SettleIn['reason']>('explain');
  const [note, setNote] = useState('');
  const [sat, setSat] = useState<number | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = satReady(sat, why);
  return (
    <Sheet title={t('sav.ph.settledTitle')} onClose={onClose}>
      <div className="pxv-lbl">{t('sav.ph.whatSolved')}</div>
      <div className="pxv-chips">
        {(['explain', 'gesture', 'changed', 'other'] as const).map((r) => (
          <button key={r} type="button" className={`pxv-chip${reason === r ? ' on' : ''}`} aria-pressed={reason === r} onClick={() => setReason(r)}>
            {t(`sav.ph.reason.${r}`)}
          </button>
        ))}
      </div>
      <textarea className="pxv-ta" rows={2} value={note} maxLength={1000} placeholder={t('sav.ph.solvedPh')} onChange={(e) => setNote(e.target.value)} />
      <SatFields sat={sat} setSat={setSat} why={why} setWhy={setWhy} />
      <button
        type="button"
        className="pxv-btn gr big"
        disabled={!ok || busy}
        onClick={async () => {
          setBusy(true);
          await onSave({ reason, note: note.trim(), satisfaction: sat ?? 3, satisfactionNote: why.trim() });
          setBusy(false);
        }}
      >
        <Icon name="check" /> {t('sav.ph.finish')}
      </button>
      {!ok && <p className="pxv-req">{sat === null ? t('sav.ph.satReq') : t('sav.ph.whyReq')}</p>}
    </Sheet>
  );
}

// ---------------------------------------------------------------- the opened ticket
function TicketPage({ id, onClose, onOpen }: { id: number; onClose: () => void; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const { me } = useSession();
  useFullScreen(onClose);
  const q = useRpc('sav.get', { id });
  const staff = useStaff();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [settle, setSettle] = useState(false);
  const [exch, setExch] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [sat, setSat] = useState<number | null>(null);
  const [why, setWhy] = useState('');
  const upd = useAction('sav.update');
  const rate = useAction('sav.rate');
  const set = useAction('sav.settle', { success: t('sav.ph.settledDone', { ref: q.data?.ticket.ref ?? '' }) });
  void onOpen;

  if (q.error)
    return (
      <div className="pxp-order pxv-page" role="dialog" aria-modal="true">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  if (!q.data)
    return (
      <div className="pxp-order pxv-page" role="dialog" aria-modal="true">
        <Loading />
      </div>
    );
  const { ticket: x, order, exchange } = q.data;
  if (exch && order) return <ExchangeForm data={q.data} onBack={() => setExch(false)} onDone={() => setExch(false)} />;

  const activeT = x.status === 'open' || x.status === 'progress';
  const exLive = !!exchange && exchange.followStatus !== 'cancelled';
  const age = (x.resolvedAt ? Date.parse(x.resolvedAt) : Date.now()) - Date.parse(x.createdAt);
  const late = activeT && age > LATE_MS;
  const askSat = x.status === 'resolved' && !x.satisfaction && x.resolution !== 'phone';
  // where the ticket is: the call · the depot · on the road · delivered
  const at = !exLive ? (x.status === 'resolved' ? 3 : 0) : ['to_prepare', 'prepared', 'returning'].includes(exchange?.followStatus ?? '') ? 1 : DELIVERED.includes(exchange?.followStatus ?? '') ? 3 : 2;
  const steps = [t('sav.ph.road.call'), t('sav.ph.road.depot'), t('sav.ph.road.road'), t('sav.ph.road.done')];

  const addNote = async () => {
    const v = note.trim();
    if (!v) return;
    setBusy(true);
    try {
      await rpc('sav.update', { id: x.id, note: v });
      setNote('');
      toast(t('sav.ph.noteSaved'), 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const people = [...staff].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0));

  return (
    <div className="pxp-order pxv-page" role="dialog" aria-modal="true" aria-label={`${x.ref} · ${x.customerName ?? ''}`}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>
            <span className="ltr">{x.ref}</span>
            {x.orderRef ? (
              <>
                {' '}
                · <span className="ltr">{x.orderRef}</span>
              </>
            ) : null}
          </b>
          <small>
            {t(`sav.type.${x.type}`)} · {when(x.createdAt)}
            {x.createdByName ? ` · ${x.createdByName}` : ''}
          </small>
        </div>
        {activeT ? <span className={`pxv-age${late ? ' l' : ''}`}>{dur(age)}</span> : <StatusBadge kind="sav" status={x.status} />}
      </header>

      <div className="pxp-ob pxs-ob pxv-ob">
        {/* where it stands */}
        <section className="pxs-sec">
          {x.resolution === 'phone' ? (
            <div className="pxv-done ok">
              <Icon name="checkcircle" />
              <span>
                <b>{t('sav.ph.end.phone')}</b>
                <small>
                  {x.settleReason ? t(`sav.ph.reason.${x.settleReason}`) : ''} · {when(x.resolvedAt)}
                </small>
              </span>
            </div>
          ) : x.status === 'closed' ? (
            <div className="pxv-done bad">
              <Icon name="xcircle" />
              <span>
                <b>{t('sav.ph.end.closed')}</b>
                <small>{when(x.resolvedAt ?? x.updatedAt)}</small>
              </span>
            </div>
          ) : (
            <div className="pxv-road2" aria-label={steps.slice(0, at + 1).join(' › ')}>
              <div className="pxv-rl">
                {steps.map((_, i) => (
                  <span key={i} className="pxv-rs">
                    <b className={i < at || (i === at && at === 3) ? 'on' : i === at ? 'cur' : ''}>{i < at || (i === at && at === 3) ? <Icon name="check" /> : i + 1}</b>
                    {i < 3 && <i className={i < at ? 'on' : ''} />}
                  </span>
                ))}
              </div>
              <div className="pxv-rt">
                {steps.map((s, i) => (
                  <span key={i} className={i === at ? 'on' : ''}>
                    {s}
                  </span>
                ))}
              </div>
              {exLive && activeT && <p className="pxv-help">{t('sav.ph.followsAlone', { ref: exchange?.ref ?? '' })}</p>}
            </div>
          )}
        </section>

        {/* the satisfaction: asked after the exchange, or what the customer said */}
        {askSat && (
          <section className="pxs-sec pxv-ask">
            <h4>
              <Icon name="smile" /> {t('sav.ph.satCall')}
            </h4>
            <SatFields sat={sat} setSat={setSat} why={why} setWhy={setWhy} />
            <div className="pxv-shb">
              <button type="button" className="pxv-btn" disabled={rate.isPending} onClick={() => rate.mutate({ id: x.id, noAnswer: true }, { onSuccess: () => toast(t('sav.ph.noAnswerSaved'), 'ok') })}>
                <Icon name="phoneoff" /> {t('sav.ph.noAnswer')}
              </button>
              {sat !== null && sat <= 2 && (
                <button type="button" className="pxv-btn" disabled={!satReady(sat, why) || rate.isPending} onClick={() => rate.mutate({ id: x.id, satisfaction: sat, satisfactionNote: why.trim(), reopen: true }, { onSuccess: () => toast(t('sav.ph.reopened', { ref: x.ref }), 'ok') })}>
                  <Icon name="undo" /> {t('sav.ph.reopen')}
                </button>
              )}
              <button type="button" className="pxv-btn nv" disabled={!satReady(sat, why) || rate.isPending} onClick={() => rate.mutate({ id: x.id, satisfaction: sat ?? 3, satisfactionNote: why.trim() }, { onSuccess: () => toast(t('sav.ph.satSaved'), 'ok') })}>
                {t('common.save')}
              </button>
            </div>
          </section>
        )}
        {x.satisfaction && (
          <section className={`pxs-sec pxv-satr f${x.satisfaction}`}>
            <h4>{t('sav.ph.satTitle')}</h4>
            <SatBadge v={x.satisfaction} />
            {x.satisfactionNote && <q>{x.satisfactionNote}</q>}
          </section>
        )}

        {/* the problem */}
        <section className="pxs-sec">
          <h4>
            <Icon name={TYPE_ICON[x.type] ?? 'help'} /> {t(`sav.type.${x.type}`)}
          </h4>
          <blockquote className="pxv-quote">{x.details || '—'}</blockquote>
        </section>

        {/* the customer: call / message */}
        <section className="pxs-sec pxv-cli">
          <span>
            <b>{x.customerName || '—'}</b>
            <small>
              <span className="ltr">{x.phone ?? ''}</span>
              {order ? ` · ${wilayaName(order.wilayaId)}${order.commune ? `, ${order.commune}` : ''}` : ''}
            </small>
          </span>
          {x.phone && (
            <>
              <a className="pxp-call big" href={`tel:${x.phone}`} aria-label={t('sav.ph.call')}>
                <Icon name="phone" />
              </a>
              <a className="pxp-wa" href={waLink(x.phone, t('sav.ph.waText', { nom: x.customerName ?? '', ref: x.ref }))} target="_blank" rel="noopener" aria-label="WhatsApp">
                <Icon name="whatsapp" />
              </a>
            </>
          )}
        </section>

        {/* the exchange parcel */}
        {exchange && (
          <button type="button" className="pxs-sec pxv-ex" onClick={() => openOrder(exchange.id)}>
            <span className="pxs-th" aria-hidden="true">
              <Icon name="swap" />
            </span>
            <span className="pxv-on">
              <b>
                {t('sav.ph.exchangeOf')} <span className="ltr">{exchange.ref}</span>
              </b>
              <small>
                {x.exchangeKind ? t(`sav.kind.${x.exchangeKind}`) : ''} · {t('sav.t.toCash', { v: da(exchange.total) })}
              </small>
            </span>
            <StatusBadge kind="follow" status={exchange.followStatus} />
          </button>
        )}

        {/* who takes care of it */}
        {activeT && (
          <section className="pxs-sec">
            <h4>{t('sav.t.owner')}</h4>
            <div className="pxv-chips">
              {people.slice(0, 8).map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`pxv-chip${x.assignedTo === u.id ? ' on' : ''}`}
                  aria-pressed={x.assignedTo === u.id}
                  disabled={upd.isPending}
                  onClick={() => upd.mutate({ id: x.id, assignedTo: x.assignedTo === u.id ? null : u.id })}
                >
                  {u.id === me ? t('sav.ph.owner.me') : u.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* the order */}
        {order && (
          <section className="pxs-sec">
            <h4>
              <Icon name="receipt" /> {t('sav.ph.orderOf', { ref: order.ref })}
              {order.deliveredAt ? ` · ${t('sav.ph.deliveredOn', { d: when(order.deliveredAt) })}` : ''}
            </h4>
            {order.items.map((i, k) => (
              <div key={k} className="pxs-line">
                <span className="pxs-th" aria-hidden="true">
                  <Icon name="package" />
                </span>
                <span className="pxs-ln">
                  <b>{i.name}</b>
                  <small>
                    {i.variantTitle ? `${i.variantTitle} · ` : ''}
                    {i.qty} × {da(i.unitPrice)}
                  </small>
                </span>
              </div>
            ))}
          </section>
        )}

        {/* the history, newest first */}
        <section className="pxs-sec">
          <h4>
            <Icon name="history" /> {t('sav.t.history')}
          </h4>
          <ol className="pxs-tl">
            {[...x.notes].reverse().map((n, i) => (
              <li key={i} className={n.status === 'closed' ? 'al' : n.status ? '' : 'nt'}>
                <b>{n.text}</b>
                <small>
                  {when(n.at)} · {n.userName ?? '—'}
                </small>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {/* always there: the endings while it is open, then the note field */}
      <div className="pxs-bar">
        {activeT && !exLive && (
          <div className="pxs-acts">
            <button type="button" className="pxs-chip ok" onClick={() => setSettle(true)}>
              <Icon name="check" /> {t('sav.ph.settled')}
            </button>
            {order && (
              <button type="button" className="pxs-chip main" onClick={() => setExch(true)}>
                <Icon name="swap" /> {t('sav.ph.exchange')}
              </button>
            )}
            <button type="button" className="pxs-chip bad" onClick={() => setCancel(true)}>
              <Icon name="x" /> {t('sav.ph.cancel')}
            </button>
          </div>
        )}
        <form
          className="pxs-comp"
          onSubmit={(e) => {
            e.preventDefault();
            addNote();
          }}
        >
          <input value={note} maxLength={1000} placeholder={t('sav.ph.notePh')} aria-label={t('sav.ph.notePh')} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="pxs-send" disabled={busy || !note.trim()} aria-label={t('sav.ph.addNote')}>
            <Icon name="send" />
          </button>
        </form>
      </div>
      {settle && <SettleSheet onClose={() => setSettle(false)} onSave={(s) => set.mutateAsync({ id: x.id, ...s }).then(() => setSettle(false), () => {})} />}
      {cancel && <CancelSheet id={x.id} onClose={() => setCancel(false)} />}
    </div>
  );
}

function CancelSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [why, setWhy] = useState('');
  const upd = useAction('sav.update', { success: t('sav.ph.cancelled'), onDone: onClose });
  return (
    <Sheet title={t('sav.ph.cancelTitle')} onClose={onClose}>
      <p className="pxv-help">{t('sav.ph.cancelHelp')}</p>
      <textarea className="pxv-ta" rows={2} value={why} autoFocus maxLength={1000} placeholder={t('sav.ph.cancelPh')} onChange={(e) => setWhy(e.target.value)} />
      <button type="button" className="pxv-btn bad big" disabled={!why.trim() || upd.isPending} onClick={() => upd.mutate({ id, status: 'closed', note: why.trim() })}>
        {t('sav.ph.cancel')}
      </button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- the exchange
function ExchangeLoader({ id, onBack, onDone }: { id: number; onBack: () => void; onDone: () => void }) {
  const q = useRpc('sav.get', { id });
  if (!q.data)
    return (
      <div className="pxp-order pxv-page" role="dialog" aria-modal="true">
        {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />}
      </div>
    );
  return <ExchangeForm data={q.data} onBack={onBack} onDone={onDone} />;
}

type SavGet = Out<'sav.get'>;
type Kind = (typeof EXCHANGE_KINDS)[number];
const KIND_ICON: Record<Kind, string> = { same: 'refresh', variant: 'shirt', other_product: 'package', parts: 'settings' };

/** Exchange on the phone: what we send, the products, the delivery paid → the order goes to the depot. */
function ExchangeForm({ data, onBack, onDone }: { data: SavGet; onBack: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { ticket: x, order, parts, suggestedFee } = data;
  const items = (order?.items ?? []).filter((i) => i.id).map((i) => ({ ...i, id: i.id as number }));
  const cat = useRpc('sav.catalog', {}).data ?? [];
  const [kind, setKind] = useState<Kind>('same');
  const [lines, setLines] = useState<Record<number, { on: boolean; qty: number; variantId: number | null }>>(() => Object.fromEntries(items.map((i) => [i.id, { on: items.length === 1, qty: i.qty, variantId: null }])));
  const [partSel, setPartSel] = useState<Record<string, number>>({});
  const [freePart, setFreePart] = useState('');
  const [fee, setFee] = useState(suggestedFee);
  const [otherFee, setOtherFee] = useState(false);
  const [note, setNote] = useState('');
  const ex = useAction('sav.exchange', {
    onDone: (r) => {
      toast(t('sav.ex.done', { ref: r.order.ref }), 'ok');
      onDone();
    },
  });
  const byVariant = useMemo(() => new Map(cat.map((v) => [v.variantId, v])), [cat]);
  const allParts = [...new Set(items.flatMap((i) => (parts[i.productId] ?? []).map((p) => p.name)))];
  const setLine = (iid: number, patch: Partial<{ on: boolean; qty: number; variantId: number | null }>) => setLines((s) => ({ ...s, [iid]: { ...s[iid], ...patch } }));
  const diff = items.reduce((sum, i) => {
    const l = lines[i.id];
    if (!l?.on || kind === 'same' || kind === 'parts' || !l.variantId) return sum;
    return sum + Math.max(0, (byVariant.get(l.variantId)?.price ?? 0) - i.unitPrice) * l.qty;
  }, 0);
  const chosen = items.filter((i) => lines[i.id]?.on);
  const needsPick = (kind === 'variant' || kind === 'other_product') && chosen.some((i) => !lines[i.id].variantId);
  const ps = Object.entries(partSel).map(([name, qty]) => ({ name, qty }));
  if (freePart.trim()) ps.push({ name: freePart.trim(), qty: 1 });
  const can = chosen.length > 0 && !needsPick && (kind !== 'parts' || ps.length > 0);
  const submit = () =>
    ex.mutate({
      id: x.id,
      kind,
      lines: chosen.map((i) => ({ itemId: i.id, qty: lines[i.id].qty, variantId: kind === 'variant' || kind === 'other_product' ? lines[i.id].variantId : null })),
      parts: kind === 'parts' ? ps : [],
      deliveryFee: fee,
      note: note.trim() || null,
    });
  const fees = [...new Set([0, suggestedFee])];

  return (
    <div className="pxp-order pxv-page" role="dialog" aria-modal="true" aria-label={t('sav.ex.title', { ref: x.ref })}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onBack}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>
            {t('sav.ph.exchange')} · {x.customerName}
          </b>
          <small>
            <span className="ltr">{order?.ref}</span> · {t('sav.ph.toDepot')}
          </small>
        </div>
      </header>
      <div className="pxp-ob pxv-ob">
        <section className="pxs-sec">
          <h4>{t('sav.ph.weSend')}</h4>
          <div className="pxv-kinds">
            {EXCHANGE_KINDS.map((k) => (
              <button key={k} type="button" className={`pxv-kind${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                <Icon name={KIND_ICON[k]} />
                <span>{t(`sav.kind.${k}`)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="pxs-sec">
          <h4>{t('sav.ex.lines')}</h4>
          <div className="pxv-lines">
            {items.map((i) => {
              const l = lines[i.id];
              const sib = cat.filter((v) => v.productId === i.productId && v.variantId !== i.variantId);
              const others = cat.filter((v) => v.productId !== i.productId);
              return (
                <div key={i.id} className={`pxv-ln${l.on ? ' on' : ''}`}>
                  <div className="pxv-lt">
                    <button type="button" className={`pxv-ck${l.on ? ' on' : ''}`} role="checkbox" aria-checked={l.on} aria-label={i.name} onClick={() => setLine(i.id, { on: !l.on })}>
                      {l.on && <Icon name="check" />}
                    </button>
                    <span className="pxs-th" aria-hidden="true">
                      <Icon name="package" />
                    </span>
                    <span className="pxv-on" onClick={() => setLine(i.id, { on: !l.on })}>
                      <b>{i.name}</b>
                      <small>
                        {i.variantTitle ? `${i.variantTitle} · ` : ''}
                        {da(i.unitPrice)}
                      </small>
                    </span>
                    {l.on && i.qty > 1 && (
                      <span className="pxd-step pxv-step">
                        <button type="button" disabled={l.qty <= 1} onClick={() => setLine(i.id, { qty: l.qty - 1 })}>
                          −
                        </button>
                        <b className="ltr">{l.qty}</b>
                        <button type="button" disabled={l.qty >= i.qty} onClick={() => setLine(i.id, { qty: l.qty + 1 })}>
                          +
                        </button>
                      </span>
                    )}
                  </div>
                  {l.on && kind === 'variant' &&
                    (sib.length ? (
                      <select value={l.variantId ?? ''} aria-label={t('sav.ex.newVariant')} onChange={(e) => setLine(i.id, { variantId: Number(e.target.value) || null })}>
                        <option value="">{t('sav.ex.newVariant')}…</option>
                        {sib.map((v) => (
                          <option key={v.variantId} value={v.variantId}>
                            {v.title || v.name} · {da(v.price)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="pxv-help">{t('sav.ex.noVariant')}</p>
                    ))}
                  {l.on && kind === 'other_product' && (
                    <select value={l.variantId ?? ''} aria-label={t('sav.ex.newProduct')} onChange={(e) => setLine(i.id, { variantId: Number(e.target.value) || null })}>
                      <option value="">{t('sav.ex.newProduct')}…</option>
                      {others.map((v) => (
                        <option key={v.variantId} value={v.variantId}>
                          {v.name}
                          {v.title ? ` ${v.title}` : ''} · {da(v.price)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {kind === 'parts' && (
          <section className="pxs-sec">
            <h4>{t('sav.ex.parts')}</h4>
            <div className="pxv-chips">
              {allParts.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pxv-chip${p in partSel ? ' on' : ''}`}
                  aria-pressed={p in partSel}
                  onClick={() =>
                    setPartSel((s) => {
                      const n = { ...s };
                      if (p in n) delete n[p];
                      else n[p] = 1;
                      return n;
                    })
                  }
                >
                  {p}
                </button>
              ))}
            </div>
            <input className="pxv-in" value={freePart} placeholder={t('sav.ex.partName')} onChange={(e) => setFreePart(e.target.value)} />
          </section>
        )}

        <section className="pxs-sec">
          <h4>{t('sav.ex.fee')}</h4>
          <div className="pxv-chips">
            {fees.map((f) => (
              <button key={f} type="button" className={`pxv-chip${!otherFee && fee === f ? ' on' : ''}`} onClick={() => (setOtherFee(false), setFee(f))}>
                {f === 0 ? t('sav.ph.free') : f === suggestedFee ? `${da(f)} · ${t('sav.ph.tariff')}` : da(f)}
              </button>
            ))}
            <button type="button" className={`pxv-chip${otherFee ? ' on' : ''}`} onClick={() => setOtherFee(true)}>
              {t('sav.ph.otherFee')}
            </button>
          </div>
          {otherFee && <input className="pxv-in ltr" type="number" inputMode="numeric" min={0} step={50} value={fee} autoFocus onChange={(e) => setFee(Math.max(0, Number(e.target.value) || 0))} />}
        </section>

        <section className="pxs-sec">
          <h4>{t('sav.ex.note')}</h4>
          <p className="pxv-help">{kind === 'parts' ? t('sav.ph.partsStay') : t('sav.ph.takeBack')}</p>
          <input className="pxv-in" value={note} maxLength={1000} placeholder={t('sav.ex.notePh')} onChange={(e) => setNote(e.target.value)} />
        </section>
      </div>
      <div className="pxs-bar">
        <div className="pxv-tot">
          <span>
            {t('sav.ex.diff', { v: da(diff) })} · {t('sav.ex.feeL', { v: da(fee) })}
          </span>
          <b className="ltr">{da(diff + fee)}</b>
        </div>
        <button type="button" className="pxv-btn or big" disabled={!can || ex.isPending} onClick={submit}>
          <Icon name="truck" /> {t('sav.ph.sendDepot')}
        </button>
      </div>
    </div>
  );
}
