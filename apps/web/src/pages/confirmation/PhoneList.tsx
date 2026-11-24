// Phones: the queue as compact cards (name, chrono, product, status, call button — in Confirmées ✏️ and ✕ instead);
// a tap opens the whole order full screen, where every part of it can be changed (Detail in phone mode).
import { CANCEL_REASONS, type Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
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
import { SellerScope, useScope } from '../../lib/seller';
import { toast } from '../../ui/toast';
import { Modal } from '../../ui/modal';
import { toastUndo } from '../../lib/undo';
import { rightOn } from '../../lib/rights';
import { CONF_TONE } from '@pilotix/shared';
import './phone.css';
import { ScoreChip } from '../../ui/clientScore';
import { OriginChip } from '../orders/OrderPath';

/** a queue row: the order with its call countdown */
type PRow = Order & { deadline?: Deadline | null; rotateAt?: number | null; seller?: { id: number; name: string } };

const variantsLine = (o: Order) =>
  o.items
    .map((i) => i.variantTitle)
    .filter(Boolean)
    .join(' + ');

/** "Appeler": asks first, a normal phone call or WhatsApp (like the message button on computers); the call is counted. */
function CallButton({ o, big }: { o: Order; big?: boolean }) {
  const { t } = useTranslation();
  const seller = useScope();
  return (
    <AskCall phone={o.phone} className={`pxp-call${big ? ' big' : ''}`} label={`${t('confirmation.call')} ${o.customerName} ${o.phone}`} onCall={() => rpc('orders.logCall', { id: o.id }, seller).catch(() => {})}>
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

/** Not sent to the delivery company yet: the order can still be cancelled from Confirmation (the server checks it too). */
export const notShipped = (o: Order) => !o.followStatus || o.followStatus === 'to_prepare' || o.followStatus === 'prepared';

/**
 * Confirmées (the call is done, the owner's choice of 24 Nov 2026): ✏️ opens the order to change it, ✕ cancels it after
 * asking why. ✕ only with « Annuler une commande » (Utilisateurs › Rôles) and before the parcel leaves.
 */
function EditCancel({ o, onEdit, onCancel }: { o: Order; onEdit: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    // a tap on these buttons never opens the card behind them
    <span className="pxp-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="pxp-act" aria-label={`${t('confirmation.ph.edit')} ${o.ref}`} title={t('confirmation.ph.edit')} onClick={onEdit}>
        <Icon name="pencil" />
      </button>
      {rightOn('act:orders.cancel') && notShipped(o) && (
        <button type="button" className="pxp-act bad" aria-label={`${t('confirmation.ph.cancelOrder')} ${o.ref}`} title={t('confirmation.ph.cancelOrder')} onClick={onCancel}>
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

/**
 * ✕ on a phone card or a table row (Confirmées): the « why? » question for that order, in that order's shop when the list
 * shows several shops (an agency). Rendered outside the card or the row, so nothing in it opens them.
 */
export function CancelAskFor({ o, onClose }: { o: PRow; onClose: () => void }) {
  const ask = <CancelAsk o={o} onClose={onClose} />;
  return o.seller ? <SellerScope seller={o.seller.id} ambient={false}>{ask}</SellerScope> : ask;
}

/** « Pourquoi annuler PX… ? »: the reason first (the same list as in the opened order), a detail if needed, then cancel. */
function CancelAsk({ o, onClose }: { o: PRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const seller = useScope();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (busy) return;
    if (!reason) return setErr(t('confirmation.ask.needReason'));
    setBusy(true);
    setErr('');
    try {
      const r = await rpc('orders.setConf', { ids: [o.id], status: 'cancelled', reason: t(`status.cancelReason.${reason}`), note: note.trim() || null }, seller);
      const refresh = () => void qc.invalidateQueries();
      const said = `${o.ref} → ${t('status.conf.cancelled')}`;
      // « ↶ Annuler » goes to the store's own orders only (an order of another seller: no undo here)
      if (o.seller) toast(said, 'bad');
      else toastUndo(said, r.changed, refresh, 'bad');
      refresh();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      sheet
      title={t('confirmation.ph.cancelTitle', { ref: o.ref })}
      className="conf-modal pxp-cxm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('confirmation.ask.back')}
          </button>
          <button type="button" className="btn danger" disabled={busy || !reason} onClick={() => void submit()}>
            {t('confirmation.d6.ask.cancelled')}
          </button>
        </>
      }
    >
      <form
        className="pxp-cx"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span className="qd6-lab">{t('confirmation.d6.reasonReq')}</span>
        <div className="qd6-reasons" role="group" aria-label={t('confirmation.d6.reasonReq')}>
          {CANCEL_REASONS.map((r) => (
            <button key={r} type="button" className={reason === r ? 'on' : ''} aria-pressed={reason === r} onClick={() => (setReason(r), setErr(''))}>
              {t(`status.cancelReason.${r}`)}
            </button>
          ))}
        </div>
        <input className="qd6-in" value={note} maxLength={300} placeholder={t('confirmation.d6.detail')} aria-label={t('common.note')} onChange={(e) => setNote(e.target.value)} />
        {err && <p className="form-err">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * The queue on phones. `pick`: « Sélectionner » is on (managers, the owner, an agency's chiefs): a tap ticks the order
 * instead of opening it. `showAgent`: each card says who has the order (or « Libre »). `edit` (Confirmées): ✏️ and ✕ in
 * place of the call button.
 */
export function PhoneCards({ rows, empty, onOpen, pick, showAgent, rowKey, edit }: { rows: PRow[]; empty: string; onOpen: (id: string) => void; pick?: { picked: Set<string>; toggle: (id: string) => void }; showAgent?: boolean; rowKey: (row: PRow) => string; edit?: boolean }) {
  const { t } = useTranslation();
  // the order whose ✕ was pressed: its question opens over the list (outside the card, so nothing in it opens the card)
  const [cancelling, setCancelling] = useState<PRow | null>(null);
  if (!rows.length) return <p className="pxp-empty muted">{empty}</p>;
  return (
    <>
      {cancelling && <CancelAskFor o={cancelling} onClose={() => setCancelling(null)} />}
      <ul className="pxp-list">
        {rows.map((o) => {
          const vt = variantsLine(o);
          const key = rowKey(o);
          const on = !!pick?.picked.has(key);
          const tap = () => (pick ? pick.toggle(key) : onOpen(key));
          return (
            <li key={key}>
              <div
                className={`pxp-card${pick ? ' is-pick' : ''}${on ? ' is-on' : ''}`}
                role={pick ? 'checkbox' : 'button'}
                aria-checked={pick ? on : undefined}
                tabIndex={0}
                onClick={tap}
                onKeyDown={(e) => (e.key === 'Enter' || (pick && e.key === ' ')) && (e.preventDefault(), tap())}
              >
                {pick && <span className="pxp-tick" aria-hidden="true" />}
                <div className="pxp-main">
                  <div className="pxp-top">
                    <b className="pxp-name">{o.customerName}</b>
                    <HeldChip o={o} />
                    {o.clientScore && <ScoreChip s={o.clientScore} short />}
                    {o.deadline && <Countdown d={o.deadline} short />}
                  </div>
                  <div className="pxp-meta">
                    <span className="ltr">{o.ref}</span> · {o.seller && <>{o.seller.name} · </>}{wilayaName(o.wilayaId)} · <b className="ltr">{da(o.total)}</b>
                  </div>
                  <div className="pxp-prod">
                    {namesOf(o.items)}
                    {vt ? ` · ${vt}` : ''}
                  </div>
                  {/* where it came from and who made it (the same chip as every list) */}
                  <OriginChip o={o} />
                  <div className="pxp-st">
                    <span className={`badge t-${o.confStatus === 'no_answer' ? 'mid' : CONF_TONE[o.confStatus] ?? 'off'}`}>{currentLabel(t, o.confStatus, o.attempts)}</span>
                    {/* a confirmed order: where its parcel is (À préparer, Préparée), as in the list's « Livraison » column */}
                    {o.confStatus === 'confirmed' && o.followStatus && <StatusBadge kind="follow" status={o.followStatus} />}
                    {o.attempts > 0 && <small>{t('confirmation.focus.calls', { n: o.attempts })}</small>}
                    <RotateChip at={o.rotateAt} />
                    {showAgent && <AgentTag name={o.agentName} />}
                  </div>
                </div>
                {/* ticking: no call (or ✕) by mistake */}
                {!pick && (() => {
                  const act = edit ? <EditCancel o={o} onEdit={() => onOpen(key)} onCancel={() => setCancelling(o)} /> : <CallButton o={o} />;
                  return o.seller ? <SellerScope seller={o.seller.id} ambient={false}>{act}</SellerScope> : act;
                })()}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Who has the order, on a phone card (managers, the owner, an agency's chiefs): his name, or « Libre ». */
export function AgentTag({ name }: { name?: string | null }) {
  const { t } = useTranslation();
  return (
    <span className={`pxp-ag${name ? '' : ' free'}`}>
      <Icon name="user" />
      <span>{name || t('confirmation.ph.free')}</span>
    </span>
  );
}

/** « Sélectionner » above the phone list; while ticking: « Tout » (or « Aucune ») and « Annuler ». */
export function PickToggle(p: { on: boolean; allOn: boolean; onToggle: () => void; onAll: () => void }) {
  const { t } = useTranslation();
  if (!p.on)
    return (
      <button type="button" className="pxp-selbtn" onClick={p.onToggle}>
        <Icon name="userplus" /> {t('confirmation.ph.select')}
      </button>
    );
  return (
    <span className="pxp-selon">
      <button type="button" className="pxp-selbtn ghost" onClick={p.onAll}>
        {t(p.allOn ? 'confirmation.ph.none' : 'confirmation.ph.all')}
      </button>
      <button type="button" className="pxp-selbtn" onClick={p.onToggle}>
        {t('common.cancel')}
      </button>
    </span>
  );
}

/**
 * « Assigner » on phones, several orders at once: the ticked orders to one agent (the phone's own list of names), or
 * back to nobody. Fixed at the bottom of the screen while ticking.
 */
export function PickBar(p: { n: number; options: { value: string; label: string }[]; anyAgent: boolean; onGive: (value: string | null) => Promise<unknown> | void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async (v: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await p.onGive(v);
    } finally {
      setBusy(false);
    }
  };
  const none = p.n === 0;
  return (
    <div className="pxp-pickbar" role="toolbar" aria-label={t('confirmation.tb.label')}>
      <span className="pxp-pb-n">{none ? t('confirmation.ph.pickHint') : t('confirmation.tb.selected', { count: p.n })}</span>
      <label className={`pxp-pb-give${none || busy ? ' is-dis' : ''}`}>
        <Icon name="userplus" />
        <span>{t('confirmation.ph.give')}</span>
        <select value="" disabled={none || busy} aria-label={t('confirmation.tb.assign')} onChange={(e) => e.target.value && void run(e.target.value)}>
          <option value="">{t('confirmation.tb.assign')}</option>
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="pxp-pb-rm" disabled={none || !p.anyAgent || busy} aria-label={t('confirmation.tb.removeAgent')} title={t('confirmation.tb.removeAgent')} onClick={() => void run(null)}>
        <Icon name="userminus" />
      </button>
    </div>
  );
}

/** The opened order, full screen: header with the customer and the call buttons, then everything editable (Detail, phone mode). */
export function PhoneOrder({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (id: number) => void }) {
  const { t } = useTranslation();
  // the page behind does not scroll while the order is open; Échap / the phone's back closes it
  // once per opening (the next order replaces this one in place, without touching the history)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const entry = useId();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.pxk-sheet') && closeRef.current();
    const back = (e: PopStateEvent) => e.state?.pxpOrder !== entry && closeRef.current();
    if (history.state?.pxpOrder !== entry) history.pushState({ ...history.state, pxpOrder: entry }, '');
    window.addEventListener('keydown', key);
    window.addEventListener('popstate', back);
    return () => {
      mounted.current = false;
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', key);
      window.removeEventListener('popstate', back);
      // React can run setup again immediately. Keep the card's history entry in that case.
      queueMicrotask(() => {
        if (!mounted.current && history.state?.pxpOrder === entry) history.back();
      });
    };
  }, [entry]);
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
        <Detail order={order} onDone={onDone} onMessageDone={onClose} phone />
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
