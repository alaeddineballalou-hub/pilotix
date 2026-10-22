import type { OrderEvent } from '@pilotix/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { telHref, waHref } from './shared';
import { Icon } from '../../ui/kit';
import { eventText } from '../orders/OrderCard';

/** The order's history in a small floating tab: what happened, when, and who did it (newest first). */
export function HistoryTab({ orderId, refLabel, anchor, onClose }: { orderId: number; refLabel: string; anchor: HTMLElement; onClose: () => void }) {
  const { t } = useTranslation();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const names = new Map(Object.entries(meta.data?.names ?? {}));
  const ev = useRpc('orders.events', { id: orderId }, { placeholderData: undefined, staleTime: 15_000 });
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = box.current?.offsetWidth ?? 340;
      const h = box.current?.offsetHeight ?? 200;
      const left = Math.min(Math.max(8, a.right - w), window.innerWidth - w - 8);
      const below = a.bottom + 6;
      const top = below + h > window.innerHeight - 8 && a.top - h - 6 > 8 ? a.top - h - 6 : Math.min(below, window.innerHeight - h - 8);
      setPos({ top: Math.max(8, top), left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => (window.removeEventListener('resize', place), window.removeEventListener('scroll', place, true));
  }, [anchor, ev.data]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [anchor, onClose]);
  const name = (v: string | null) => (v ? names.get(v) ?? v : '—');
  const company = (v: string | null) => (v ? names.get(`c${v}`) ?? v : '—');
  const list: OrderEvent[] = ev.data ? [...ev.data].reverse() : [];
  return createPortal(
    <div ref={box} className="px-hist" role="dialog" aria-label={t('confirmation.hist.title', { ref: refLabel })} style={{ top: pos.top, left: pos.left }}>
      <div className="px-hist-h">
        <Icon name="history" />
        <b>{t('confirmation.hist.title', { ref: refLabel })}</b>
        <button type="button" className="px-hist-x" aria-label={t('common.close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {!ev.data ? (
        <div className="px-hist-empty">…</div>
      ) : list.length === 0 ? (
        <div className="px-hist-empty">{t('confirmation.hist.none')}</div>
      ) : (
        <ol className="px-hist-list">
          {list.map((e) => (
            <li key={e.id} className={`k-${e.kind}`}>
              <span className="px-hist-dot" />
              <div>
                <div className="px-hist-what">{eventText(t, e, name, company)}</div>
                <div className="px-hist-meta">
                  <span className="ltr">{when(e.at)}</span>
                  {e.userName && <span> · {e.userName}</span>}
                </div>
                {e.note && <div className="px-hist-note">{e.note}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>,
    document.body,
  );
}

/** A button that opens the history tab of one order. */
export function HistoryButton({ orderId, refLabel, className, children, title }: { orderId: number; refLabel: string; className: string; children: React.ReactNode; title: string }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" ref={setEl} className={`${className} ${open ? 'on' : ''}`} aria-expanded={open} aria-label={title} title={title} onClick={(e) => (e.stopPropagation(), setOpen((v) => !v))}>
        {children}
      </button>
      {open && el && <HistoryTab orderId={orderId} refLabel={refLabel} anchor={el} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The phone number with two small icons beside it: call (logged on the order) and WhatsApp. */
export function PhoneCell({ order }: { order: { id: number; ref: string; phone: string; customerName: string } }) {
  const { t } = useTranslation();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 5 * 60_000 });
  const tpl = meta.data?.whatsappTemplate ?? 'Bonjour {nom}, ici {boutique} à propos de votre commande {ref}.';
  const wa = waHref(order.phone, tpl, { nom: order.customerName, boutique: meta.data?.shopName ?? 'Pilotix', ref: order.ref });
  return (
    <span className="px-ph" onClick={(e) => e.stopPropagation()}>
      <span className="qph ltr">{order.phone}</span>
      <a className="px-ph-i" href={telHref(order.phone)} aria-label={t('confirmation.callNum', { p: order.phone })} title={t('confirmation.call')} onClick={() => rpc('orders.logCall', { id: order.id }).catch(() => {})}>
        <Icon name="phone" />
      </a>
      <a className="px-ph-i wa" href={wa} target="_blank" rel="noopener" aria-label={t('confirmation.msgNum', { p: order.phone })} title={t('confirmation.message')}>
        <Icon name="message" />
      </a>
    </span>
  );
}
