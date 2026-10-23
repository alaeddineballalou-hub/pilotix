// Suivi on phones: each parcel as a card with its journey (Expédiée › En route › the alert › Livrée);
// a tap opens the parcel full screen: the alert and what to do, call / message, the open réclamation,
// the order, the journey with the notes — and at the bottom the actions and a note field that is always there.
import type { Order, OrderEvent } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, when, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { eventText } from '../orders/OrderCard';
import { ClaimRow, RemindApiModal, SendModal, useTarget } from './Claims';
import { daysSince, waLink } from './common';
import '../confirmation/phone.css';
import './phone.css';

export type PExtra = { companyKind: string | null; livreurPhone: string | null; alertReason: string | null; claim: { id: number; status: string; createdAt: string; sentAt: string | null } | null };

/** Where the parcel is: 0 shipped, 1 on the road, 2 stopped (alert, failed, return…), 3 delivered. */
function stageOf(o: Order): { at: number; stop: boolean } {
  switch (o.followStatus) {
    case 'delivered':
    case 'exchanged':
      return { at: 3, stop: false };
    case 'out_for_delivery':
    case 'in_exchange':
      return { at: 1, stop: false };
    case 'alert':
    case 'failed':
    case 'returning':
    case 'returned':
    case 'lost':
    case 'cancelled':
      return { at: 2, stop: true };
    default:
      return { at: 0, stop: false };
  }
}

/** The company's little badge: its first letters, in its colour. */
export function CoBadge({ o, x }: { o: Order; x?: PExtra }) {
  const k = x?.companyKind ?? '';
  const name = o.companyName || o.livreurName || '';
  const short = k === 'own' ? name.slice(0, 2) : name.replace(/express|livraison/gi, '').trim().slice(0, 3);
  return (
    <span className={`pxs-co k-${k || 'other'}`} title={name} aria-label={name}>
      {short.toUpperCase() || '—'}
    </span>
  );
}

function Journey({ o, label }: { o: Order; label: string | null }) {
  const { t } = useTranslation();
  const s = stageOf(o);
  const steps = [t('suivi.ph.shipped'), t('suivi.ph.onRoad'), s.stop ? label || t(`status.follow.${o.followStatus}`) : t('suivi.ph.attempt'), t('suivi.ph.delivered')];
  return (
    <div className="pxs-jr" aria-label={steps.slice(0, s.at + 1).join(' › ')}>
      <div className="pxs-jl">
        {steps.map((_, i) => (
          <span key={i} className="pxs-js">
            <b className={i < s.at || (i === s.at && !s.stop) ? 'on' : i === s.at && s.stop ? 'al' : ''} />
            {i < 3 && <i className={i < s.at ? 'on' : ''} />}
          </span>
        ))}
      </div>
      <div className="pxs-jt">
        {steps.map((x, i) => (
          <span key={i} className={i === s.at && s.stop ? 'al' : ''}>
            {x}
          </span>
        ))}
      </div>
    </div>
  );
}

const dayTone = (d: number | null) => (d === null ? '' : d >= 10 ? 'bad' : d >= 5 ? 'warn' : 'info');

export function ParcelCards({ rows, extra, reasonOf, empty, onOpen }: { rows: Order[]; extra: Record<number, PExtra>; reasonOf: (o: Order, x?: PExtra) => string | null; empty: string; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="pxp-empty muted">{empty}</p>;
  return (
    <ul className="pxp-list pxs-list">
      {rows.map((o) => {
        const x = extra[o.id];
        const d = daysSince(o.shippedAt);
        return (
          <li key={o.id}>
            <div className="pxs-card" role="button" tabIndex={0} onClick={() => onOpen(o.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(o.id)}>
              <div className="pxs-top">
                <b className="pxp-name">{o.customerName}</b>
                <CoBadge o={o} x={x} />
              </div>
              <Journey o={o} label={reasonOf(o, x)} />
              <div className="pxs-bot">
                <span>
                  <span className="ltr">{o.tracking || o.ref}</span> · {o.items.map((i) => i.name).join(' + ')} · <b className="ltr">{da(o.total)}</b>
                </span>
                {d !== null && <span className={`pxs-days t-${dayTone(d)}`}>{t('suivi.days', { n: d })}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** What to do for this alert, from the courier's words. */
function tipKey(reason: string | null): string {
  const r = (reason ?? '').toLowerCase();
  if (/bureau|stop ?desk|agence/.test(r)) return 'desk';
  if (/commune|desservi|zone/.test(r)) return 'zone';
  if (/num[eé]ro|faux|erron|wrong/.test(r)) return 'number';
  if (/refus|annul|ne veut/.test(r)) return 'refused';
  if (/adresse|introuvable|address/.test(r)) return 'address';
  if (/absent|injoign|r[ée]pond|ferm|[ée]teint/.test(r)) return 'absent';
  return 'other';
}

export interface ParcelAction {
  key: string;
  label: string;
  tone?: 'main' | 'ok' | 'bad';
  run: () => void;
}

export function ParcelPage({ o, x, reason, actions, onClaim, onClose }: { o: Order; x?: PExtra; reason: string | null; actions: ParcelAction[]; onClaim: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const names = new Map(Object.entries(meta.data?.names ?? {}));
  const ev = useRpc('orders.events', { id: o.id }, { staleTime: 15_000 });
  const claims = useRpc('suivi.claims', { target: 'all', status: 'open', orderId: o.id });
  const claim = ((claims.data?.rows ?? []) as ClaimRow[])[0] ?? null;
  const upd = useAction('suivi.claimUpdate', { success: t('suivi.rec.updated') });
  const push = useAction('suivi.claimPush', {
    onDone: (c) => toast(c.extId ? t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }) : c.extError ?? t('suivi.rec.apiFailed', { name: c.companyName ?? '' }), c.extId ? 'ok' : 'bad'),
  });
  const sync = useAction('suivi.claimSync', { silent: true });
  const [remindApi, setRemindApi] = useState(false);
  // a claim created at ZR: read back its state and answer when the parcel opens
  const claimExt = claim?.extId ? claim.id : null;
  useEffect(() => {
    if (claimExt) sync.mutate({ id: claimExt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimExt]);
  const { target, shop } = useTarget(o, x?.companyKind === 'own');
  const [send, setSend] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const d = daysSince(o.shippedAt);

  // the page behind does not scroll; Échap / the phone's back closes
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('dialog[open], .modal-wrap') && closeRef.current();
    const back = () => closeRef.current();
    history.pushState({ pxsParcel: 1 }, '');
    window.addEventListener('keydown', key);
    window.addEventListener('popstate', back);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', key);
      window.removeEventListener('popstate', back);
      if (history.state?.pxsParcel) history.back();
    };
  }, []);

  const addNote = async () => {
    const v = note.trim();
    if (!v) return;
    setBusy(true);
    try {
      await rpc('orders.note', { id: o.id, note: v, field: 'event' });
      setNote('');
      toast(t('suivi.ph.noteSaved'), 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const user = (v: string | null) => (v ? names.get(v) ?? v : '—');
  const company = (v: string | null) => (v ? names.get(`c${v}`) ?? v : '—');
  const list: OrderEvent[] = ev.data ? [...ev.data].reverse() : [];
  const tk = tipKey(reason);
  const waText = t('suivi.ph.waText', { nom: o.customerName, ref: o.ref });
  const claimDays = claim ? Math.floor((Date.now() - Date.parse(claim.createdAt)) / 86_400_000) : 0;

  const section = (title: ReactNode, body: ReactNode, cls = '') => (
    <section className={`pxs-sec ${cls}`}>
      <h4>{title}</h4>
      {body}
    </section>
  );

  return (
    <div className="pxp-order pxs-page" role="dialog" aria-modal="true" aria-label={`${o.ref} · ${o.customerName}`}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>
            <span className="ltr">{o.ref}</span> · {o.customerName}
          </b>
          <small>
            {o.companyName || o.livreurName || '—'} · <span className="ltr">{o.tracking || '—'}</span>
            {d !== null ? ` · ${t('suivi.ph.since', { n: d })}` : ''}
          </small>
        </div>
        <CoBadge o={o} x={x} />
      </header>

      <div className="pxp-ob pxs-ob">
        {/* the alert, where the parcel stopped, and what to do */}
        <section className={`pxs-sec pxs-alert${o.followStatus === 'alert' ? ' on' : ''}`}>
          {reason && (
            <span className="pxs-rs">
              <Icon name="alert" />
              {reason}
              {o.deliveryAttempts > 1 ? ` · ${t('suivi.ph.try', { n: o.deliveryAttempts })}` : ''}
            </span>
          )}
          <Journey o={o} label={reason} />
          {o.followStatus === 'alert' && (
            <p className="pxs-tip">
              <span aria-hidden="true">💡</span> <b>{t('suivi.ph.todo')}</b> {t(`suivi.ph.tip.${tk}`, { co: o.companyName || o.livreurName || '' })}
            </p>
          )}
        </section>

        <div className="pxs-cm">
          <a className="pxs-call" href={`tel:${o.phone}`} onClick={() => rpc('orders.logCall', { id: o.id }).catch(() => {})}>
            <Icon name="phone" /> {t('suivi.act.call')}
          </a>
          <a className="pxs-wa" href={waLink(o.phone, waText)} target="_blank" rel="noopener">
            <Icon name="whatsapp" /> {t('suivi.ph.message')}
          </a>
        </div>

        {/* the réclamation: the open one with Relancer / Réglée, or a way to make one */}
        {claim ? (
          <section className="pxs-rc">
            <div className="pxs-rch">
              <Icon name="copy" />
              <b>
                {t('suivi.ph.claim', { ref: claim.ref })} · {claim.companyName || claim.livreurName || '—'}
              </b>
              <span className={`badge ${claimDays >= 2 ? 't-warn' : 't-info'}`}>{t('suivi.ph.waiting', { n: claimDays })}</span>
            </div>
            <p className="xs muted">
              {claim.sentAt ? t('suivi.ph.sentOn', { d: when(claim.sentAt) }) : t('suivi.ph.notSent')}
              {claim.details ? ` · « ${claim.details} »` : ''}
            </p>
            {claim.extId ? (
              <p className="xs pxs-rc-api">
                {t('suivi.rec.apiNo', { name: claim.companyName ?? '', n: claim.extRef || '✓' })}
                {claim.extStatus && ` · ${claim.extStatus}`}
              </p>
            ) : (
              claim.viaApi &&
              claim.extError && (
                <p className="xs pxs-rc-api bad">
                  {t('suivi.rec.apiRefusedShort', { name: claim.companyName ?? '' })} · {claim.extError}
                </p>
              )
            )}
            {claim.extAnswer && (
              <div className="bjr-ans">
                <b>{t('suivi.rec.apiLastAnswer', { name: claim.companyName ?? '' })}</b>
                {claim.extAnswer}
              </div>
            )}
            <div className="pxs-rca">
              {claim.viaApi && !claim.extId && (claim.extError || !claim.sentAt) && (
                <button type="button" className="pxs-chip or" disabled={push.isPending} onClick={() => push.mutate({ id: claim.id })}>
                  <Icon name="send" /> {t(claim.extError ? 'suivi.rec.apiRetry' : 'suivi.rec.apiSend', { name: claim.companyName ?? '' })}
                </button>
              )}
              {claim.extId ? (
                <button type="button" className="pxs-chip" onClick={() => setRemindApi(true)}>
                  <Icon name="chat" /> {t('suivi.rec.apiRemind', { name: claim.companyName ?? '' })}
                </button>
              ) : (
                <button type="button" className="pxs-chip" disabled={!target} onClick={() => setSend(true)}>
                  <Icon name="refresh" /> {t('suivi.act.remind')}
                </button>
              )}
              <button type="button" className="pxs-chip ok" disabled={upd.isPending} onClick={() => upd.mutate({ id: claim.id, status: 'resolved' })}>
                <Icon name="check" /> {t('suivi.ph.resolved')}
              </button>
            </div>
          </section>
        ) : (
          <button type="button" className="pxs-rc pxs-rc0" onClick={onClaim}>
            <Icon name="copy" />
            <span>
              <b>{t('suivi.act.claim')}</b>
              <small>{t('suivi.ph.noClaim')}</small>
            </span>
            <span className="pxs-chip or">+ {t('suivi.ph.create')}</span>
          </button>
        )}

        {/* the order */}
        {section(
          <>
            <Icon name="receipt" /> {t('suivi.ph.order', { ref: o.ref })}
          </>,
          <>
            {o.items.map((i, k) => (
              <div key={k} className="pxs-line">
                <span className="pxs-th" aria-hidden="true">
                  <Icon name="package" />
                </span>
                <span className="pxs-ln">
                  <b>{i.name}</b>
                  <small>
                    {i.variantTitle ? `${i.variantTitle} · ` : ''}×{i.qty}
                  </small>
                </span>
                <b className="ltr">{da(i.qty * i.unitPrice)}</b>
              </div>
            ))}
            <div className="pxs-g2">
              <div>
                <small>{t('suivi.col.client')}</small>
                <b>{o.customerName}</b>
                <span className="ltr">{o.phone}</span>
              </div>
              <div>
                <small>{o.isStopdesk ? t('suivi.ph.desk') : t('suivi.ph.home')}</small>
                <b>
                  {wilayaName(o.wilayaId)}
                  {o.commune ? `, ${o.commune}` : ''}
                </b>
                <span>{o.address || '—'}</span>
              </div>
            </div>
            <div className="pxs-tot">
              <span>
                {da(o.subtotal)} + {t('suivi.ph.fee')} {da(o.deliveryFee)}
                {o.discount ? ` − ${da(o.discount)}` : ''}
              </span>
              <b className="ltr">{da(o.total)}</b>
            </div>
          </>,
        )}

        {/* the journey and the notes, newest first */}
        {section(
          <>
            <Icon name="history" /> {t('suivi.ph.journey')}
          </>,
          !ev.data ? (
            <p className="muted small">…</p>
          ) : (
            <ol className="pxs-tl">
              {list.map((e) => {
                const isNote = e.kind === 'note';
                const bad = e.kind === 'follow_status' && ['alert', 'failed', 'returning', 'returned', 'cancelled', 'lost'].includes(e.toValue ?? '');
                return (
                  <li key={e.id} className={isNote ? 'nt' : bad ? 'al' : ''}>
                    <b>{isNote ? t('suivi.ph.noteBy', { name: e.userName || '—' }) : eventText(t, e, user, company)}</b>
                    <small>
                      {when(e.at)}
                      {!isNote && e.userName ? ` · ${e.userName}` : ''}
                    </small>
                    {e.note && <q className={isNote ? 'n' : bad ? '' : 'm'}>{e.note}</q>}
                  </li>
                );
              })}
            </ol>
          ),
        )}
      </div>

      {/* always there: the actions, then the note field */}
      <div className="pxs-bar">
        {actions.length > 0 && (
          <div className="pxs-acts">
            {actions.map((a) => (
              <button key={a.key} type="button" className={`pxs-chip ${a.tone ?? ''}`} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        )}
        <form
          className="pxs-comp"
          onSubmit={(e) => {
            e.preventDefault();
            addNote();
          }}
        >
          <input value={note} maxLength={1000} placeholder={t('suivi.ph.notePh')} aria-label={t('suivi.ph.notePh')} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="pxs-send" disabled={busy || !note.trim()} aria-label={t('suivi.ph.addNote')}>
            <Icon name="send" />
          </button>
        </form>
      </div>
      {send && claim && target && <SendModal claim={claim} order={o} target={target} shop={shop} again onClose={() => setSend(false)} />}
      {remindApi && claim && <RemindApiModal c={claim} onClose={() => setRemindApi(false)} />}
    </div>
  );
}
