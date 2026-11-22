// Confirmation › « Bloquer jusqu'à l'appel » (owner's ask, 22 Nov 2026; design 3 « Fiche complète » of the 5 choices):
// a new order given to a plain agent covers every page of Pilotix with its order card. It rings loud (and vibrates a
// phone) until he taps « Appeler »; the result bar (Changer le statut, Confirmer) opens only then, and the card lets him
// go once a result is saved — then his next new order comes, one at a time. The server says which order
// (confirmation.blocking): never at night, never in the middle of another order. The managers switch it on or off
// (BlockSwitch, at the top of Confirmation). Pilotix cannot hear the call: the tap on « Appeler » is what is counted.
import type { Order } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { enablePush } from '../../lib/push';
import { useRpc } from '../../lib/query';
import { audioReady, ring, unlockAudio } from '../../lib/sound';
import { useIsPhone } from '../../lib/useMedia';
import { ScoreChip } from '../../ui/clientScore';
import { Icon } from '../../ui/kit';
import { TrustFlags } from '../orders/TrustFlags';
import { cdText, useNow } from './Countdown';
import { Detail } from './Detail';
import { AskCall, AskMsg } from './History';
import '../../layout/autoPushAsk.css';
import './phone.css';
import './newOrderBlock.css';

/** Mounted on every page for a store's plain confirmation agents (layout/Shell.tsx). */
export function NewOrderGate() {
  const q = useRpc('confirmation.blocking', {}, { refetchInterval: 15_000, refetchOnWindowFocus: true, retry: false });
  const b = q.data;
  if (b?.order) return <BlockingOrder key={b.order.id} order={b.order} called={b.called} queue={b.queue} onDone={() => void q.refetch()} />;
  if (b?.on) return <RingAsk />;
  return null;
}

/** The ring and the vibration, again and again; the tab's title blinks (Pilotix in another tab or behind a window). */
function useRinging(on: boolean, title: string) {
  useEffect(() => {
    if (!on) return;
    const beat = () => {
      ring();
      try {
        navigator.vibrate?.([450, 150, 450]);
      } catch {
        /* no vibration */
      }
    };
    beat();
    const id = window.setInterval(beat, 2600);
    const before = document.title;
    let flip = false;
    const tid = window.setInterval(() => {
      flip = !flip;
      document.title = flip ? title : before;
    }, 1000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(tid);
      if (document.title === title) document.title = before;
    };
  }, [on, title]);
}

/** Nothing behind it can be reached: the menu, the top bar and the page are put to sleep, the page does not scroll. */
function useLockPage() {
  useEffect(() => {
    const parts = [document.getElementById('side'), document.querySelector('header.topbar'), document.getElementById('page')].filter((e): e is HTMLElement => !!e);
    parts.forEach((e) => e.setAttribute('inert', ''));
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      parts.forEach((e) => e.removeAttribute('inert'));
      document.body.style.overflow = prev;
    };
  }, []);
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase() || '?';

function BlockingOrder({ order: o, called, queue, onDone }: { order: Order; called: boolean; queue: number; onDone: () => void }) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const now = useNow();
  // « Appeler » tapped here (the server knows it too: the next answer says so)
  const [tapped, setTapped] = useState(false);
  const isCalled = called || tapped;
  const [heard, setHeard] = useState(audioReady);
  const box = useRef<HTMLDivElement>(null);
  useLockPage();
  useRinging(!isCalled, t('confirmation.nob.tabTitle'));
  // the browser plays sound only after a touch on the page: say so until it can
  useEffect(() => {
    if (heard || isCalled) return;
    const id = window.setInterval(() => setHeard(audioReady()), 1000);
    return () => window.clearInterval(id);
  }, [heard, isCalled]);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const others = useRpc('orders.list', { q: o.phone, pageSize: 10 }, { enabled: !!o.phone });
  const prev = (others.data?.rows ?? []).filter((x) => x.id !== o.id);
  const returns = prev.filter((x) => x.followStatus === 'returning' || x.followStatus === 'returned').length;
  const logCall = () => {
    setTapped(true);
    rpc('orders.logCall', { id: o.id })
      .then(onDone)
      .catch(() => {});
  };
  const since = cdText(Math.max(0, now - Date.parse(o.createdAt)));
  const place = [wilayaName(o.wilayaId), o.commune].filter(Boolean).join(' · ');
  const callBtn = (cls: string, big?: boolean) => (
    <AskCall phone={o.phone} className={cls} label={`${t('confirmation.call')} ${o.customerName} ${o.phone}`} onCall={logCall}>
      <Icon name="phone" />
      {big && <span>{isCalled ? t('confirmation.nob.recall') : t('confirmation.call')}</span>}
    </AskCall>
  );
  const msgBtn = (cls: string, big?: boolean) => (
    <AskMsg order={o} className={cls} label={t('confirmation.msgNum', { p: o.phone })}>
      <Icon name="whatsapp" />
      {big && <span>WhatsApp</span>}
    </AskMsg>
  );
  const status = (
    <p className={`nob-state${isCalled ? ' ok' : ''}`} role="status">
      <Icon name={isCalled ? 'check' : 'lock'} />
      <span>{isCalled ? t('confirmation.nob.calledLine') : t('confirmation.nob.locked')}</span>
      {queue > 0 && <b className="nob-q">{t('confirmation.nob.next', { n: queue })}</b>}
    </p>
  );
  const soundHint = !heard && !isCalled && (
    <button
      type="button"
      className="nob-sound"
      onClick={() => {
        unlockAudio();
        window.setTimeout(() => {
          setHeard(audioReady());
          ring();
        }, 50);
      }}
    >
      <Icon name="megaphone" /> {t('confirmation.nob.sound')}
    </button>
  );
  // until « Appeler »: the result bar stays shut, this strip stands in its place
  const gate = !isCalled && (
    <div className="nob-gate">
      <Icon name="lock" />
      <span>{t('confirmation.nob.gate')}</span>
      {callBtn('nob-gcall', true)}
    </div>
  );

  if (phone)
    return (
      <div ref={box} tabIndex={-1} className={`nob ph${isCalled ? ' called' : ' locked'}`} role="alertdialog" aria-modal="true" aria-labelledby="nob-t">
        <header className="pxp-oh nob-ph-h">
          <div className="pxp-ot">
            <b id="nob-t">
              <span className="ltr">{o.ref}</span> · {o.customerName}
            </b>
            <small>
              {t('confirmation.nob.title')} · {t('confirmation.nob.since', { d: since })}
            </small>
          </div>
          {callBtn(`pxp-call big${isCalled ? '' : ' nob-ringing'}`)}
          {msgBtn('pxp-wa')}
        </header>
        {status}
        {soundHint}
        <div className="pxp-ob nob-ph-b">
          <Detail order={o} onDone={onDone} phone />
        </div>
        {gate}
      </div>
    );

  return (
    <div className={`nob${isCalled ? ' called' : ' locked'}`}>
      <div ref={box} tabIndex={-1} className="nob-card" role="alertdialog" aria-modal="true" aria-labelledby="nob-t">
        <header className="nob-head">
          <h2 id="nob-t">{t('confirmation.nob.title')}</h2>
          <span className="nob-ref ltr">{o.ref}</span>
          <span className="nob-since">
            <Icon name="timer" /> {t('confirmation.nob.since', { d: since })}
          </span>
          <span className="nob-sp" />
          {status}
        </header>
        {soundHint}
        <div className="nob-body">
          <aside className="nob-side" aria-label={t('confirmation.ph.client')}>
            <div className="nob-who">
              <span className="nob-av" aria-hidden="true">
                {initials(o.customerName)}
              </span>
              <div>
                <b>{o.customerName}</b>
                <span className="nob-tel ltr">{o.phone}</span>
                {o.phone2 && <small className="ltr">{o.phone2}</small>}
              </div>
            </div>
            {place && (
              <p className="nob-place">
                <Icon name="navigation" /> {place}
              </p>
            )}
            <div className="nob-flags">
              {o.clientScore && <ScoreChip s={o.clientScore} />}
              <TrustFlags o={o} />
            </div>
            <div className="nob-acts">
              {callBtn(`nob-call${isCalled ? ' done' : ' nob-ringing'}`, true)}
              {msgBtn('nob-msg', true)}
            </div>
            {prev.length > 0 && (
              <div className={`nob-hist ${returns ? 'bad' : ''}`}>
                <b>
                  {t('confirmation.focus.others', { n: prev.length })}
                  {returns ? ` · ${t('confirmation.focus.returns', { n: returns })}` : ''}
                </b>
                <ul>
                  {prev.slice(0, 5).map((x) => (
                    <li key={x.id}>
                      <button type="button" className="linkish ltr" onClick={() => openOrder(x.id)}>
                        {x.ref}
                      </button>
                      <span>{x.followStatus ? t(`status.follow.${x.followStatus}`) : t(`status.conf.${x.confStatus}`)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
          <div className="nob-main">
            <Detail order={o} onDone={onDone} />
            {gate}
          </div>
        </div>
      </div>
    </div>
  );
}

const LATER = 'px-nob-push-later';
type PushState = Awaited<ReturnType<typeof enablePush>>;

/** Blocking is on: this device is asked once to ring for new orders even when Pilotix is closed (« Plus tard »: one day). */
function RingAsk() {
  const { t } = useTranslation();
  const [later, setLater] = useState(() => {
    try {
      return Number(localStorage.getItem(LATER) ?? 0) > Date.now();
    } catch {
      return false;
    }
  });
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    if (later) return;
    enablePush(false)
      .then(setState)
      .catch(() => setState('unsupported'));
  }, [later]);
  if (later || (state !== 'off' && state !== 'denied')) return null;
  const hide = () => {
    try {
      localStorage.setItem(LATER, String(Date.now() + 24 * 3_600_000));
    } catch {
      // private mode: hidden until the page is opened again
    }
    setLater(true);
  };
  return (
    <div className="pxap-ask" role="status">
      <Icon name="bell" />
      <span>{t(state === 'denied' ? 'confirmation.nob.push.denied' : 'confirmation.nob.push.ask')}</span>
      {state === 'off' && (
        <button type="button" className="pxap-on" onClick={() => enablePush(true).then(setState).catch(() => setState('unsupported'))}>
          {t('confirmation.nob.push.on')}
        </button>
      )}
      <button type="button" className="pxap-later" onClick={hide}>
        {t('confirmation.nob.push.later')}
      </button>
    </div>
  );
}
