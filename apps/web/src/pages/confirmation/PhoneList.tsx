// Phones: the queue as compact cards (name, chrono, product, status, call button);
// a tap opens the whole order full screen, where every part of it can be changed (Detail in phone mode).
import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HeldChip } from './hold';
import { da, when, wilayaName } from '../../lib/format';
import { namesOf } from '../../lib/items';
import { Icon, StatusBadge } from '../../ui/kit';
import { Countdown, Deadline, RotateChip } from './Countdown';
import { Detail } from './Detail';
import { currentLabel, useCanGive } from './shared';
import { AskCall, AskMsg } from './History';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { toast } from '../../ui/toast';
import { CONF_TONE } from '@pilotix/shared';
import './phone.css';
import { ScoreChip } from '../../ui/clientScore';

/** a queue row: the order with its call countdown */
type PRow = Order & { deadline?: Deadline | null; rotateAt?: number | null };

const variantsLine = (o: Order) =>
  o.items
    .map((i) => i.variantTitle)
    .filter(Boolean)
    .join(' + ');

/** "Appeler": asks first, a normal phone call or WhatsApp (like the message button on computers); the call is counted. */
function CallButton({ o, big }: { o: Order; big?: boolean }) {
  const { t } = useTranslation();
  return (
    <AskCall phone={o.phone} className={`pxp-call${big ? ' big' : ''}`} label={`${t('confirmation.call')} ${o.customerName} ${o.phone}`} onCall={() => rpc('orders.logCall', { id: o.id }).catch(() => {})}>
      <Icon name="phone" />
    </AskCall>
  );
}

/** "Message": asks SMS or WhatsApp, with the shop's ready message (the same menu as on computers). */
function MsgButton({ o }: { o: Order }) {
  const { t } = useTranslation();
  return (
    <AskMsg order={o} className="pxp-wa" label={t('confirmation.msgNum', { p: o.phone })}>
      <Icon name="message" />
    </AskMsg>
  );
}

export function PhoneCards({ rows, empty, onOpen }: { rows: PRow[]; empty: string; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="pxp-empty muted">{empty}</p>;
  return (
    <ul className="pxp-list">
      {rows.map((o) => {
        const vt = variantsLine(o);
        return (
          <li key={o.id}>
            <div className="pxp-card" role="button" tabIndex={0} onClick={() => onOpen(o.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(o.id)}>
              <div className="pxp-main">
                <div className="pxp-top">
                  <b className="pxp-name">{o.customerName}</b>
                  <HeldChip o={o} />
                  {o.clientScore && <ScoreChip s={o.clientScore} short />}
                  {o.deadline && <Countdown d={o.deadline} short />}
                </div>
                <div className="pxp-meta">
                  <span className="ltr">{o.ref}</span> · {wilayaName(o.wilayaId)} · <b className="ltr">{da(o.total)}</b>
                </div>
                <div className="pxp-prod">
                  {namesOf(o.items)}
                  {vt ? ` · ${vt}` : ''}
                </div>
                <div className="pxp-st">
                  <span className={`badge t-${o.confStatus === 'no_answer' ? 'mid' : CONF_TONE[o.confStatus] ?? 'off'}`}>{currentLabel(t, o.confStatus, o.attempts)}</span>
                  {/* a confirmed order: where its parcel is (À préparer, Préparée), as in the list's « Livraison » column */}
                  {o.confStatus === 'confirmed' && o.followStatus && <StatusBadge kind="follow" status={o.followStatus} />}
                  {o.attempts > 0 && <small>{t('confirmation.focus.calls', { n: o.attempts })}</small>}
                  <RotateChip at={o.rotateAt} />
                </div>
              </div>
              <CallButton o={o} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The opened order, full screen: header with the customer and the call buttons, then everything editable (Detail, phone mode). */
export function PhoneOrder({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (id: number) => void }) {
  const { t } = useTranslation();
  // the page behind does not scroll while the order is open; Échap / the phone's back closes it
  // once per opening (the next order replaces this one in place, without touching the history)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.pxk-sheet') && closeRef.current();
    const back = (e: PopStateEvent) => !e.state?.pxpOrder && closeRef.current();
    history.pushState({ pxpOrder: 1 }, '');
    window.addEventListener('keydown', key);
    window.addEventListener('popstate', back);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', key);
      window.removeEventListener('popstate', back);
      if (history.state?.pxpOrder) history.back();
    };
  }, []);
  // a new order: back to the top of the page
  const body = useRef<HTMLDivElement>(null);
  // a block, not an arrow that returns: new browsers' scrollTo returns a Promise, and React would call it as the clean-up
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [order.id]);
  return (
    <div className="pxp-order" role="dialog" aria-modal="true" aria-label={`${order.ref} · ${order.customerName}`}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>
            <span className="ltr">{order.ref}</span> · {order.customerName}
          </b>
          <small>
            {t(`status.channel.${order.channel}`)} · {when(order.createdAt)}
            {order.attempts ? ` · ${t('confirmation.focus.calls', { n: order.attempts })}` : ''}
          </small>
        </div>
        <CallButton o={order} big />
        <MsgButton o={order} />
      </header>
      <div className="pxp-ob" ref={body}>
        <GiveLine order={order} />
        <Detail order={order} onDone={onDone} phone />
      </div>
    </div>
  );
}

/**
 * « Attribuer » on phones (the list has no ticks there): the order's agent, changed here one order at a time — for the
 * store's managers and owner, and a confirmation agency's chief and chefs d'équipe (its own agents only: the server's
 * list). Nothing for an agent.
 */
function GiveLine({ order }: { order: Order }) {
  const gives = useCanGive();
  return gives ? <GivePick order={order} /> : null;
}

function GivePick({ order }: { order: Order }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const meta = useRpc('confirmation.meta', {}, { staleTime: 5 * 60_000 });
  const [busy, setBusy] = useState(false);
  const agents = meta.data?.agents ?? [];
  const cur = order.agentId ?? null;
  const give = async (to: number | null) => {
    if (to === cur || busy) return;
    setBusy(true);
    try {
      await rpc('orders.assignAgent', { ids: [order.id], agentId: to });
      const name = agents.find((a) => a.id === to)?.name;
      toast(to ? t('confirmation.assigned', { n: 1, name }) : t('confirmation.unassigned', { n: 1 }), 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="pxp-give">
      <Icon name="userplus" />
      <span>{t('confirmation.ph.agent')}</span>
      <select value={cur ?? ''} disabled={busy || !meta.data} aria-label={t('confirmation.tb.assign')} onChange={(e) => void give(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{t('confirmation.ph.nobody')}</option>
        {cur !== null && !agents.some((a) => a.id === cur) && <option value={cur}>{order.agentName ?? '—'}</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}
