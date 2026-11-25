// Confirmation › « Bloquer jusqu'à l'appel » (owner's ask, 22 Nov 2026; design 3 « Fiche complète » of the 5 choices):
// a new order given to a plain agent covers Pilotix on his PHONE with its order card. It rings loud (and vibrates)
// until he taps « Appeler »; the result bar (Changer le statut, Confirmer) opens only then, and the card lets him go
// once a result is saved — then his next new order comes, one at a time. The server says which order
// (confirmation.blocking): never at night, never in the middle of another order. The managers switch it on or off
// (BlockSwitch, at the top of Confirmation). Pilotix cannot hear the call: the tap on « Appeler » is what is counted.
// His computer is never blocked for an order (owner's choice, 22 Nov 2026): a line at the top says which order waits for
// his call. But in his work time (his shift) neither his computer nor his phone works until his phone is ready to ring
// (owner's ask, same day): on the phone, « Activez les notifications », the test ring of the shift, « Je l'ai entendu »
// (PhoneSetup); on the computer, « Connectez votre téléphone » until then (PcGate). The server says what is missing
// (confirmation.blocking › gate).
import type { Order } from '@pilotix/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { appPush, enablePush, myEndpoint, onPushConf, openAppSettings, phoneDevice, pushHere, pushTurnOn } from '../../lib/push';
import { useRpc } from '../../lib/query';
import { audioReady, ring, unlockAudio } from '../../lib/sound';
import { useIsPhone } from '../../lib/useMedia';
import { ScoreChip } from '../../ui/clientScore';
import { Icon } from '../../ui/kit';
import { TrustFlags } from '../orders/TrustFlags';
import { cdText, useNow } from './Countdown';
import { Detail } from './Detail';
import { AskCall, AskMsg } from './History';
import './phone.css';
import './newOrderBlock.css';

type PushState = Awaited<ReturnType<typeof enablePush>>;

/** Mounted on every page for a store's plain confirmation agents (layout/Shell.tsx). */
export function NewOrderGate() {
  const phone = phoneDevice();
  // while his phone is not ready, look more often: the computer opens as soon as the phone is done
  const q = useRpc('confirmation.blocking', {}, { refetchInterval: (x) => (x.state.data?.gate ? 4_000 : 15_000), refetchOnWindowFocus: true, retry: false });
  const b = q.data;
  // the phone's worker (sw.js) or the Pilotix app got a ring while Pilotix is on its screen: look now, not in 15 s
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  useEffect(() => onPushConf(() => void refetch.current()), []);
  const [push, recheck] = usePushHere(phone && !!b?.on && !!b?.work);
  // outside his work time (his shift, else the calling hours): nothing
  if (!b?.on || !b.work) return null;
  const done = () => void q.refetch();
  if (phone) {
    // first this phone must be able to ring, then the test ring of his shift; only then the orders
    if (push && push !== 'on') return <PhoneSetup step="notif" push={push} gate={b.gate} shift={b.shift} onPush={recheck} onDone={done} />;
    if (b.gate) return <PhoneSetup step={b.gate === 'heard' ? 'heard' : 'test'} push={push} gate={b.gate} shift={b.shift} onPush={recheck} onDone={done} />;
    return b.order ? <BlockingOrder key={b.order.id} order={b.order} called={b.called} queue={b.queue} onDone={done} /> : null;
  }
  // a computer: nothing works until his phone is ready; then a line only for the order his phone rings for
  if (b.gate) return <PcGate gate={b.gate} shift={b.shift} />;
  return b.order ? <WaitLine order={b.order} called={b.called} queue={b.queue} /> : null;
}

/** Can this phone ring: checked when it is needed, and again each time Pilotix comes back on the screen (after the settings). */
function usePushHere(active: boolean) {
  const [state, setState] = useState<PushState | null>(null);
  const check = useCallback((s?: PushState) => {
    if (s) return setState(s);
    pushHere()
      .then(setState)
      .catch(() => setState('unsupported'));
  }, []);
  useEffect(() => {
    if (!active) return;
    check();
    const fn = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  }, [active, check]);
  return [active ? state : null, check] as const;
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

/** A computer while his phone rings: which order waits for his call; he can still open it here. Never blocks, never rings. */
function WaitLine({ order: o, called, queue }: { order: Order; called: boolean; queue: number }) {
  const { t } = useTranslation();
  const now = useNow();
  const since = cdText(Math.max(0, now - Date.parse(o.createdAt)));
  return (
    <div className={`nob-line${called ? ' ok' : ''}`} role="status">
      <span className="nob-line-ic" aria-hidden="true">
        <Icon name={called ? 'check' : 'smartphone'} />
      </span>
      <span className="nob-line-t">
        <b>
          <span className="ltr">{o.ref}</span> · {o.customerName}
        </b>
        <span>{called ? t('confirmation.nob.line.called') : t('confirmation.nob.line.ringing', { d: since })}</span>
      </span>
      {queue > 0 && <b className="nob-q">{t('confirmation.nob.next', { n: queue })}</b>}
      <button type="button" className="nob-line-open" onClick={() => openOrder(o.id)}>
        {t('confirmation.nob.line.open')}
      </button>
    </div>
  );
}

type Gate = 'none' | 'test' | 'heard' | 'silent';
type Shift = { from: number; to: number } | null;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** « Votre service : 09:00 – 15:00 » (the managers typed it), else the shop's calling hours. */
function ShiftLine({ shift }: { shift: Shift }) {
  const { t } = useTranslation();
  return (
    <small className="nob-shift">
      <Icon name="timer" /> {shift ? t('confirmation.nob.shift', { from: hhmm(shift.from), to: hhmm(shift.to) }) : t('confirmation.nob.shiftCalls')}
    </small>
  );
}

/**
 * The phone in his work time, before any order: 1. notifications on (the permission), 2. the test ring of this shift
 * (the server rings this phone, its worker answers: confirmation.phoneTest › push.ack), 3. the volume up, « Je l'ai
 * entendu ». Until the end, nothing else opens — on the phone, and on his computer (PcGate).
 */
function PhoneSetup({ step, push, gate, shift, onPush, onDone }: { step: 'notif' | 'test' | 'heard'; push: PushState | null; gate: Gate | null; shift: Shift; onPush: (s?: PushState) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const k = 'confirmation.nob.setup';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // the test ring: sent at, then « not arrived » after 45 s without an answer from the phone
  const [sentAt, setSentAt] = useState(0);
  const [late, setLate] = useState(false);
  const [deaf, setDeaf] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLockPage();
  useEffect(() => {
    box.current?.focus();
  }, [step]);
  // waiting for the phone to answer: look every 2 s
  useEffect(() => {
    if (!sentAt || step !== 'test') return;
    const id = window.setInterval(onDone, 2_000);
    const tm = window.setTimeout(() => setLate(true), 45_000);
    return () => (window.clearInterval(id), window.clearTimeout(tm));
  }, [sentAt, step, onDone]);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    fn()
      .catch((e: Error) => setErr(e.message || t(`${k}.failed`)))
      .finally(() => setBusy(false));
  };
  const turnOn = () =>
    act(() =>
      pushTurnOn()
        .then((s) => onPush(s))
        .catch(() => onPush('unsupported')),
    );
  const ringIt = () =>
    act(async () => {
      setLate(false);
      setDeaf(false);
      // the server must know this phone (its notifications on): told again first
      await pushHere();
      const endpoint = await myEndpoint();
      if (!endpoint) throw new Error(t(`${k}.noEndpoint`));
      await rpc('confirmation.phoneTest', { endpoint });
      setSentAt(Date.now());
      onDone();
    });
  const heard = () =>
    act(async () => {
      const endpoint = await myEndpoint();
      if (!endpoint) throw new Error(t(`${k}.noEndpoint`));
      await rpc('confirmation.phoneHeard', { endpoint });
      onDone();
    });
  const n = step === 'notif' ? 1 : step === 'test' ? 2 : 3;
  const dots = (
    <ol className="nob-nt-prog" aria-label={t(`${k}.progress`, { n })}>
      {[1, 2, 3].map((i) => (
        <li key={i} className={i < n ? 'done' : i === n ? 'on' : ''}>
          <span>{i < n ? <Icon name="check" /> : i}</span>
          {t(`${k}.s${i}`)}
        </li>
      ))}
    </ol>
  );
  return (
    <div ref={box} tabIndex={-1} className="nob ph nob-nt" role="alertdialog" aria-modal="true" aria-labelledby="nob-nt-t">
      <div className="nob-nt-box">
        {dots}
        <span className={`nob-nt-ic${step === 'heard' ? ' vol' : ''}`} aria-hidden="true">
          <Icon name={step === 'heard' ? 'megaphone' : 'bell'} />
        </span>
        {step === 'notif' && (
          <>
            <h2 id="nob-nt-t">{t(`${k}.notif.title`)}</h2>
            <p>{t(`${k}.notif.why`)}</p>
            {push === 'off' && (
              <button type="button" className="nob-nt-on" disabled={busy} onClick={turnOn}>
                <Icon name="bell" /> {t(`${k}.notif.on`)}
              </button>
            )}
            {push === 'denied' && (
              <>
                <p className="nob-nt-how">{t(`${k}.notif.denied`)}</p>
                <ol className="nob-nt-steps">
                  <li>{t(`${k}.notif.step1`)}</li>
                  <li>{t(`${k}.notif.step2`)}</li>
                  <li>{t(`${k}.notif.step3`)}</li>
                </ol>
                {appPush() && (
                  <button type="button" className="nob-nt-on" onClick={() => void openAppSettings().catch(() => {})}>
                    <Icon name="settings" /> {t(`${k}.notif.settings`)}
                  </button>
                )}
                <button type="button" className={appPush() ? 'nob-nt-no' : 'nob-nt-on'} onClick={() => onPush()}>
                  <Icon name="check" /> {t(`${k}.notif.again`)}
                </button>
              </>
            )}
            {push === 'unsupported' && <p className="nob-nt-how">{t(`${k}.notif.unsupported`)}</p>}
          </>
        )}
        {step === 'test' && (
          <>
            <h2 id="nob-nt-t">{t(gate === 'silent' ? `${k}.test.silentTitle` : `${k}.test.title`)}</h2>
            <p>{t(gate === 'silent' ? `${k}.test.silent` : `${k}.test.why`)}</p>
            {sentAt && !late ? (
              <p className="nob-nt-wait" role="status">
                <span className="nob-nt-spin" aria-hidden="true" /> {t(`${k}.test.waiting`)}
              </p>
            ) : (
              <button type="button" className="nob-nt-on" disabled={busy} onClick={ringIt}>
                <Icon name="bell" /> {t(late ? `${k}.test.again` : `${k}.test.ring`)}
              </button>
            )}
            {late && (
              <ul className="nob-nt-steps tips">
                <li>{t(`${k}.test.tip1`)}</li>
                <li>{t(`${k}.test.tip2`)}</li>
                <li>{t(`${k}.test.tip3`)}</li>
              </ul>
            )}
          </>
        )}
        {step === 'heard' && (
          <>
            <h2 id="nob-nt-t">{t(`${k}.heard.title`)}</h2>
            <p>{t(`${k}.heard.why`)}</p>
            {!deaf ? (
              <div className="nob-nt-two">
                <button type="button" className="nob-nt-on" disabled={busy} onClick={heard}>
                  <Icon name="check" /> {t(`${k}.heard.yes`)}
                </button>
                <button type="button" className="nob-nt-no" disabled={busy} onClick={() => setDeaf(true)}>
                  {t(`${k}.heard.no`)}
                </button>
              </div>
            ) : (
              <>
                <ul className="nob-nt-steps tips">
                  <li>{t(`${k}.heard.tip1`)}</li>
                  <li>{t(`${k}.heard.tip2`)}</li>
                  <li>{t(`${k}.heard.tip3`)}</li>
                </ul>
                <button type="button" className="nob-nt-on" disabled={busy} onClick={ringIt}>
                  <Icon name="bell" /> {t(`${k}.test.again`)}
                </button>
              </>
            )}
          </>
        )}
        {err && (
          <p className="nob-nt-err" role="alert">
            {err}
          </p>
        )}
        <ShiftLine shift={shift} />
        <small className="nob-nt-pc">
          <Icon name="lock" /> {t(`${k}.pc`)}
        </small>
      </div>
    </div>
  );
}

/** His computer in his work time while his phone is not ready: nothing opens; it opens by itself once the phone is done. */
function PcGate({ gate, shift }: { gate: Gate; shift: Shift }) {
  const { t } = useTranslation();
  const k = 'confirmation.nob.pcgate';
  const box = useRef<HTMLDivElement>(null);
  useLockPage();
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="nob">
      <div ref={box} tabIndex={-1} className="nob-pg" role="alertdialog" aria-modal="true" aria-labelledby="nob-pg-t">
        <span className="nob-nt-ic" aria-hidden="true">
          <Icon name="smartphone" />
        </span>
        <h2 id="nob-pg-t">{t(`${k}.title`)}</h2>
        <p className={`nob-pg-why ${gate}`}>{t(`${k}.why.${gate}`)}</p>
        <ol className="nob-nt-steps">
          <li>{t(`${k}.step1`)}</li>
          <li>{t(`${k}.step2`)}</li>
          <li>{t(`${k}.step3`)}</li>
        </ol>
        <p className="nob-pg-auto">
          <span className="nob-nt-spin" aria-hidden="true" /> {t(`${k}.auto`)}
        </p>
        <ShiftLine shift={shift} />
      </div>
    </div>
  );
}
