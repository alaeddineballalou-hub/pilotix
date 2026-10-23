// « Ma tournée » on phones (T1 + A + B): the money of the day on one line; the next stop in big (call, WhatsApp, Maps,
// then Livrée / Pas livrée within thumb reach); the other stops as numbered rows (a tap makes one the current stop);
// what to pick up at the depot; the office chat behind a bubble that counts the unread messages.
// « Pas livrée » opens a sheet: I come back (failed) or back to the depot (return), the reason in one tap, a note.
import { FAIL_REASONS, Order, phoneIntl, RETURN_REASONS } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, wilayaName } from '../../lib/format';
import { useFullScreen } from '../../lib/fullScreen';
import { useAction, useRpc } from '../../lib/query';
import { Icon, TicketTag } from '../../ui/kit';
import { Chat } from './Chat';
import '../confirmation/phone.css';
import '../sav/phone.css';
import './phone.css';

type Data = Out<'delivery.tournee'>;
const SEEN = 'px-chat-seen';
const seenAt = () => {
  try {
    return localStorage.getItem(SEEN) ?? '';
  } catch {
    return '';
  }
};

const mapsLink = (o: Order) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([o.address, o.commune, wilayaName(o.wilayaId), 'Algérie'].filter(Boolean).join(', '))}`;

export function PhoneTournee({ d, livreurId, self, onPrint }: { d: Data; livreurId?: number; self: boolean; onPrint: () => void }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState<number | null>(null);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [chat, setChat] = useState(false);
  const [seen, setSeen] = useState(seenAt);
  const msgs = useRpc('cash.chat', { livreurId, limit: 100 }, { refetchInterval: 20_000 });
  const unread = (msgs.data ?? []).filter((m) => !m.mine && m.at > seen).length;
  const list = d.toDeliver;
  const next = list.find((o) => o.id === cur) ?? list.find((o) => o.followStatus === 'out_for_delivery') ?? list[0] ?? null;
  const rest = list.filter((o) => o !== next);
  const openChat = () => {
    const now = new Date().toISOString();
    try {
      localStorage.setItem(SEEN, now);
    } catch {
      /* private mode */
    }
    setSeen(now);
    setChat(true);
  };

  return (
    <div className="pxt">
      <div className="pxt-money">
        <div>
          <small>{t('tournee.ph.toDeliver')}</small>
          <b>{list.length}</b>
        </div>
        <div>
          <small>{t('tournee.ph.toCollect')}</small>
          <b className="ltr">{da(d.toDeliverAmount)}</b>
        </div>
        <div>
          <small>{t('tournee.ph.done')}</small>
          <b className="ok">{d.deliveredToday}</b>
        </div>
      </div>

      {next ? (
        <Stop o={next} n={list.indexOf(next) + 1} shop={d.shop} />
      ) : (
        <div className="pxt-free">
          <Icon name="checkcircle" />
          <b>{t('tournee.ph.allDone')}</b>
          <small>{t('tournee.kpi.cashed', { amount: da(d.deliveredTodayAmount) })}</small>
        </div>
      )}

      {rest.length > 0 && (
        <>
          <div className="pxv-lbl">{t('tournee.ph.then', { n: rest.length })}</div>
          <ul className="pxt-rows">
            {rest.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => (setCur(o.id), window.scrollTo({ top: 0, behavior: 'smooth' }))}>
                  <span className="pxt-n">{list.indexOf(o) + 1}</span>
                  <span className="pxt-rm">
                    <b>{o.customerName}</b>
                    <small>
                      {o.commune}
                      {o.address ? ` · ${o.address}` : ''}
                    </small>
                  </span>
                  <b className="ltr">{da(o.total)}</b>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {d.pickup.length > 0 && (
        <section className="pxt-pick">
          <button type="button" className="pxt-pickh" aria-expanded={pickupOpen} onClick={() => setPickupOpen((v) => !v)}>
            <Icon name="package" />
            <b>{t('tournee.ph.pickup', { n: d.pickup.length })}</b>
            <Icon name={pickupOpen ? 'chevron' : 'chevr'} />
          </button>
          {pickupOpen && (
            <ul className="pxt-rows">
              {d.pickup.map((o) => (
                <li key={o.id}>
                  <span className="pxt-row">
                    <span className="pxt-rm">
                      <b>
                        <span className="ltr">{o.ref}</span> · {o.customerName}
                      </b>
                      <small>{o.items.map((i) => `${i.qty} × ${i.name}`).join(' + ')}</small>
                    </span>
                    <b className="ltr">{da(o.total)}</b>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <button type="button" className="pxt-print" onClick={onPrint}>
        <Icon name="printer" /> {self ? t('tournee.print') : t('tournee.printOf', { name: d.livreur.name })}
      </button>

      <button type="button" className="pxt-fab" aria-label={self ? t('tournee.chat.title') : t('tournee.chat.titleOffice', { name: d.livreur.name })} onClick={openChat}>
        <Icon name="message" />
        {unread > 0 && <sup>{unread}</sup>}
      </button>
      {chat && <ChatPage title={self ? t('tournee.ph.office') : d.livreur.name} livreurId={livreurId} orders={[...d.toDeliver, ...d.pickup]} self={self} onClose={() => setChat(false)} />}
    </div>
  );
}

/** The current stop: everything within thumb reach. */
function Stop({ o, n, shop }: { o: Order; n: number; shop: Data['shop'] }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState(false);
  const set = useAction('orders.setFollow', { success: (r) => (r.changed.length ? t('tournee.saved') : t('tournee.noChange')) });
  const call = useAction('orders.logCall', { silent: true });
  const wa = `https://wa.me/${phoneIntl(o.phone)}?text=${encodeURIComponent((shop.whatsappTemplate || '').replace(/\{nom\}/g, o.customerName).replace(/\{boutique\}/g, shop.name).replace(/\{ref\}/g, o.ref))}`;
  const items = o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + ');
  return (
    <section className="pxt-stop">
      <div className="pxt-sh">
        <span className="pxt-n or">{n}</span>
        <span className="pxt-lbl">{t('tournee.ph.next')}</span>
        <TicketTag savRef={o.savRef} />
        <b className="ltr">{da(o.total)}</b>
      </div>
      <div className="pxt-who">
        <b>{o.customerName}</b>
        <span>
          {o.commune}
          {o.address ? ` · ${o.address}` : ''}
          {o.isStopdesk ? ` · ${t('tournee.stopdesk')}` : ''}
        </span>
        <small>
          {items} · <span className="ltr">{o.ref}</span>
        </small>
      </div>
      {o.deliveryNote && (
        <p className="pxt-note">
          <Icon name="info" /> {o.deliveryNote}
        </p>
      )}
      <div className="pxt-c3">
        <a className="c" href={`tel:${o.phone}`} onClick={() => call.mutate({ id: o.id })}>
          <Icon name="phone" /> {t('tournee.ph.call')}
        </a>
        <a className="w" href={wa} target="_blank" rel="noopener noreferrer">
          <Icon name="whatsapp" /> WhatsApp
        </a>
        <a href={mapsLink(o)} target="_blank" rel="noopener noreferrer">
          <Icon name="navigation" /> Maps
        </a>
      </div>
      {o.phone2 && (
        <a className="pxt-ph2" href={`tel:${o.phone2}`}>
          <Icon name="phone" /> {t('tournee.ph.phone2')} <span className="ltr">{o.phone2}</span>
        </a>
      )}
      <div className="pxt-go">
        <button
          type="button"
          className="ok"
          disabled={set.isPending}
          onClick={() => set.mutate({ ids: [o.id], status: 'delivered', reason: null, note: null, clientId: `tr-${o.id}-delivered-${Date.now()}` })}
        >
          <Icon name="check" /> {t('tournee.delivered')}
        </button>
        <button type="button" className="no" onClick={() => setAsk(true)}>
          {t('tournee.ph.notDelivered')}
        </button>
      </div>
      {ask && <NotDelivered o={o} onClose={() => setAsk(false)} />}
    </section>
  );
}

/** « Pas livrée »: I come back (failed) or back to the depot (return); the reason in one tap; a note. */
function NotDelivered({ o, onClose }: { o: Order; onClose: () => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'failed' | 'returning'>('failed');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const set = useAction('orders.setFollow', { success: t('tournee.saved'), onDone: onClose });
  const reasons = kind === 'failed' ? FAIL_REASONS : RETURN_REASONS;
  const label = (r: string) => t(`status.${kind === 'failed' ? 'failReason' : 'returnReason'}.${r}`);
  return (
    <div className="pxv-sheet" role="dialog" aria-modal="true" aria-label={t('tournee.ph.notDelivered')}>
      <button type="button" className="pxv-dim" aria-label={t('common.close')} onClick={onClose} />
      <div className="pxv-sh">
        <span className="pxv-grab" aria-hidden="true" />
        <div className="pxv-shh">
          <b>
            {t('tournee.ph.notDelivered')} · {o.customerName}
          </b>
          <button type="button" className="pxp-back" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="pxv-own">
          {(['failed', 'returning'] as const).map((k) => (
            <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => (setKind(k), setReason(''))}>
              {t(`tournee.ph.kind.${k}`)}
            </button>
          ))}
        </div>
        <div className="pxv-chips">
          {reasons.map((r) => (
            <button key={r} type="button" className={`pxv-chip${reason === r ? ' on' : ''}`} aria-pressed={reason === r} onClick={() => setReason(r)}>
              {label(r)}
            </button>
          ))}
        </div>
        <textarea className="pxv-ta" rows={2} value={note} maxLength={500} placeholder={t('tournee.notePh')} onChange={(e) => setNote(e.target.value)} />
        <button
          type="button"
          className={`pxv-btn big ${kind === 'failed' ? 'warn' : 'bad'}`}
          disabled={!reason || set.isPending}
          onClick={() => set.mutate({ ids: [o.id], status: kind, reason: label(reason), note: note.trim() || null, clientId: `tr-${o.id}-${kind}-${Date.now()}` })}
        >
          {kind === 'failed' ? t('tournee.ph.confirmFail') : t('tournee.ph.confirmReturn')}
        </button>
        <p className="pxv-help" style={{ textAlign: 'center' }}>
          {t('tournee.ph.officeKnows')}
        </p>
      </div>
    </div>
  );
}

function ChatPage({ title, livreurId, orders, self, onClose }: { title: string; livreurId?: number; orders: Order[]; self: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  useFullScreen(onClose);
  return (
    <div className="pxp-order pxt-chat" role="dialog" aria-modal="true" aria-label={title}>
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>{title}</b>
          <small>{t('tournee.chat.watch')}</small>
        </div>
      </header>
      <div className="pxt-chatb">
        <Chat livreurId={livreurId} orders={orders} self={self} />
      </div>
    </div>
  );
}
