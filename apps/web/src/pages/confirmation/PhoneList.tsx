// Phones: the queue as compact cards (name, chrono, product, status, call button);
// a tap opens the whole order full screen, where every part of it can be changed (Detail in phone mode).
import type { Order } from '@pilotix/shared';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, when, wilayaName } from '../../lib/format';
import { namesOf } from '../../lib/items';
import { Icon } from '../../ui/kit';
import { Countdown, Deadline } from './Countdown';
import { Detail } from './Detail';
import { currentLabel, telHref } from './shared';
import { CONF_TONE } from '@pilotix/shared';
import './phone.css';

/** a queue row: the order with its call countdown */
type PRow = Order & { deadline?: Deadline | null };

const variantsLine = (o: Order) =>
  o.items
    .map((i) => i.variantTitle)
    .filter(Boolean)
    .join(' + ');

/** "Appeler": opens the phone's dialer and counts the call. */
function CallLink({ o, big }: { o: Order; big?: boolean }) {
  const { t } = useTranslation();
  return (
    <a
      className={`pxp-call${big ? ' big' : ''}`}
      href={telHref(o.phone)}
      aria-label={`${t('confirmation.call')} ${o.customerName} ${o.phone}`}
      onClick={(e) => {
        e.stopPropagation();
        rpc('orders.logCall', { id: o.id }).catch(() => {});
      }}
    >
      <Icon name="phone" />
    </a>
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
                  {o.attempts > 0 && <small>{t('confirmation.focus.calls', { n: o.attempts })}</small>}
                </div>
              </div>
              <CallLink o={o} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The opened order, full screen: header with the customer and the call buttons, then everything editable (Detail, phone mode). */
export function PhoneOrder({ order, wa, onClose, onDone }: { order: Order; wa: string; onClose: () => void; onDone: (id: number) => void }) {
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
        <CallLink o={order} big />
        <a className="pxp-wa" href={wa} target="_blank" rel="noopener" aria-label="WhatsApp">
          <Icon name="whatsapp" />
        </a>
      </header>
      <div className="pxp-ob" ref={body}>
        <Detail order={order} onDone={onDone} phone />
      </div>
    </div>
  );
}
