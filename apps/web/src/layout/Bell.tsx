// The bell at the top of every page (owner's ask, 22 Nov 2026): the person's lines (core modules/inbox.ts), the count of
// the ones not read, the list on a tap. A new line shows as a pop-up with its own sound — the cash for a delivery, a
// fault for a return or a cancel, a phone ring for a callback… The sound stays on in the shop's call hours (« pendant le
// travail »): it is turned off only outside them. Tapping a line opens its order (or its page) and marks it read.
import { algiersHour } from '@pilotix/shared';
import { CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc } from '../lib/backend';
import { clock, dayLabel, sameDay } from '../lib/format';
import { openOrder } from '../lib/modals';
import { disableDevicePush, enablePush, enablePushSubscription, testDevicePush } from '../lib/push';
import { useRpcFor } from '../lib/query';
import { setSeller, useScope } from '../lib/seller';
import { useSession } from '../lib/session';
import { audioReady, bellSound, BellSound, unlockAudio } from '../lib/sound';
import { store } from '../lib/store';
import { Icon } from '../ui/kit';
import { toast } from '../ui/toast';
import { isNativePilotix, SHOW_NOTIFICATION_DEVICES } from './NotificationDevices';
import './bell.css';

type Line = Out<'inbox.list'>['items'][number];
type PushState = Awaited<ReturnType<typeof enablePush>>;

const ICON: Record<BellSound, string> = {
  order: 'cart',
  callback: 'phone',
  delivered: 'coins',
  returned: 'undo',
  cancelled: 'xcircle',
  taken: 'swap',
  alert: 'alert',
  depot: 'package',
  message: 'message',
  info: 'bell',
};
/** a pop-up that is not important goes after this */
const POP_MS = 7000;
const key = (x: Line) => `${x.id}@${x.at}`;
/** The phone's notification starts with an emoji (💰, 📞…); on screen the kind's own icon says it: not twice. */
const plain = (s: string) => s.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');

/** In the shop's call hours now (Algiers time). */
const inWork = (slots: { from: number; to: number }[], now: number) => {
  const h = algiersHour(now);
  return slots.some((s) => h >= s.from && h < s.to);
};
const hoursText = (slots: { from: number; to: number }[]) => {
  if (!slots.length) return '';
  const hh = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const from = Math.min(...slots.map((s) => s.from));
  const to = Math.max(...slots.map((s) => s.to));
  return `${hh(from)} – ${hh(to)}`;
};

export function Bell() {
  const { t } = useTranslation();
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const { session } = useSession();
  const me = session!.profile.id;
  const here = session!.shop?.id;
  const agency = session!.shop?.kind === 'agency';
  const demo = backend.kind === 'demo' || !!session?.shop?.demo;
  const scope = useScope();
  const q = useRpcFor(agency ? null : scope, 'inbox.list', {}, { staleTime: 60_000, refetchInterval: 5 * 60_000 });
  const data = q.data;
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const [open, setOpen] = useState(false);
  const [pops, setPops] = useState<Line[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [mute, setMute] = useState(() => store.get('bell-sound') === 'off');
  const [push, setPush] = useState<PushState | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [testStatus, setTestStatus] = useState('');
  const [ready, setReady] = useState(audioReady());
  const box = useRef<HTMLDivElement>(null);
  /** the list open on a computer: the pop-ups go beside it (« Écouter les sons ») */
  const [beside, setBeside] = useState<CSSProperties | undefined>();
  const [panelPosition, setPanelPosition] = useState<CSSProperties>();
  /** the lines already shown (the first list, the pop-ups): never popped again */
  const seen = useRef<Set<string> | null>(null);
  /** a new line was announced: the next list pops what is new in it */
  const fresh = useRef(false);
  const work = !!data && inWork(data.slots, now);
  const soundOn = work || !mute;
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  useEffect(() => {
    const id = window.setInterval(() => (setNow(Date.now()), setReady(audioReady())), 20_000);
    const touch = () => window.setTimeout(() => setReady(audioReady()), 50);
    window.addEventListener('pointerdown', touch);
    return () => (window.clearInterval(id), window.removeEventListener('pointerdown', touch));
  }, []);

  // a line for me: the list again (and a pop-up with its sound when it is new, not a quiet change)
  useEffect(
    () =>
      backend.onEvent((e) => {
        if (e.type !== 'inbox' || (e.shop !== undefined && here !== undefined && e.shop !== here)) return;
        const d = e.data as { to?: number[]; quiet?: number[] } | undefined;
        const mine = !!d?.to?.includes(me);
        if (!mine && !d?.quiet?.includes(me)) return;
        if (mine && !agency) fresh.current = true;
        void refetch.current();
      }),
    [agency, me, here],
  );

  useEffect(() => {
    if (agency || !data) return;
    if (!seen.current) {
      // what is already there when the page opens: in the list, never as a pop-up
      seen.current = new Set(data.items.map(key));
      return;
    }
    const s = seen.current;
    const pop = fresh.current;
    fresh.current = false;
    const news = data.items.filter((x) => !s.has(key(x)));
    news.forEach((x) => s.add(key(x)));
    if (!pop) return;
    const show = news.filter((x) => !x.read);
    if (!show.length) return;
    setPops((p) => [...show, ...p.filter((x) => !show.some((y) => y.id === x.id))].slice(0, 3));
    const top = show.find((x) => x.important) ?? show[0];
    if (soundRef.current) bellSound(top.kind, top.important, true);
  }, [agency, data]);

  // a pop-up that is not important goes by itself
  useEffect(() => {
    const quiet = pops.filter((x) => !x.important);
    if (!quiet.length) return;
    const id = window.setTimeout(() => setPops((p) => p.filter((x) => x.important || x.id !== quiet[quiet.length - 1].id)), POP_MS);
    return () => window.clearTimeout(id);
  }, [pops]);

  // a tap on a phone notification while Pilotix is open: its order (public/sw.js)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string; order?: number | null } | null;
      if (d?.type !== 'px-open') return;
      if (d.order) openOrder(Number(d.order));
      else if (typeof d.url === 'string' && d.url.startsWith('#/')) location.hash = d.url;
    };
    navigator.serviceWorker.addEventListener('message', on);
    return () => navigator.serviceWorker.removeEventListener('message', on);
  }, []);

  // the panel: closes on a tap outside, Escape, another page; asks this phone's state
  useEffect(() => {
    // (over the page's floating buttons: « Commande suivante » on a phone)
    document.body.classList.toggle('px-bell-open', open);
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const away = () => setOpen(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', k);
    window.addEventListener('hashchange', away);
    setTestStatus('');
    if (!demo) enablePush(false).then(setPush).catch(() => setPush('unsupported'));
    return () => (document.body.classList.remove('px-bell-open'), document.removeEventListener('pointerdown', down), document.removeEventListener('keydown', k), window.removeEventListener('hashchange', away));
  }, [open, demo]);

  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const anchor = box.current;
    const position = () => {
      const r = anchor.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      const rtl = document.documentElement.dir === 'rtl';
      const bar = anchor.closest('.topbar')?.getBoundingClientRect();
      const mobile = viewport <= 560;
      const width = Math.min(mobile ? viewport - 16 : 392, viewport - 16);
      const min = mobile || rtl ? 8 : Math.min((bar?.left ?? 0) + 8, viewport - width - 8);
      const max = mobile || !rtl ? viewport - width - 8 : Math.max(8, (bar?.right ?? viewport) - width - 8);
      const left = Math.max(min, Math.min(max, rtl ? r.left : r.right - width));
      const top = r.bottom + 10;
      setPanelPosition({ position: 'fixed', insetInline: 'auto', top, left, width, maxHeight: `calc(100dvh - ${top + 8}px)` });
      const start = left - 392;
      const end = left + width + 12;
      if (!mobile && end + 380 <= (bar?.right ?? viewport) - 8) setBeside({ top, bottom: 'auto', insetInline: 'auto', left: end });
      else if (!mobile && start >= (bar?.left ?? 0) + 8) setBeside({ top, bottom: 'auto', insetInline: 'auto', left: start });
      else setBeside({ top: 'auto', bottom: 14, insetInlineEnd: 8 });
    };
    position();
    window.addEventListener('resize', position);
    const resize = new ResizeObserver(position);
    resize.observe(anchor.closest('.topbar') ?? anchor);
    return () => { window.removeEventListener('resize', position); resize.disconnect(); };
  }, [open]);

  const read = useCallback((ids: number[]) => {
    if (ids.length) void rpc('inbox.read', { ids }, agency ? null : undefined).then(() => refetch.current()).catch(() => {});
  }, [agency]);
  const go = (x: Line) => {
    setOpen(false);
    setPops((p) => p.filter((y) => y.id !== x.id));
    if (!x.read) read([x.id]);
    if (x.orderId) openOrder(x.orderId);
    else if (x.url) {
      if (agency && (x.url.startsWith('#/confirmation/') || x.url.startsWith('#/suivi/'))) setSeller('all');
      location.hash = x.url;
    }
  };
  const readAll = () => void rpc('inbox.readAll', {}, agency ? null : undefined).then(() => refetch.current()).catch(() => {});
  const toggleMute = () => {
    store.set('bell-sound', mute ? null : 'off');
    setMute(!mute);
  };
  const sendTest = async () => {
    setDeviceBusy(true);
    setTestStatus('');
    try {
      if (demo) {
        const sent = await testDevicePush({ title: t('devices.testTitle'), body: t('devices.testBody') });
        setTestStatus(t(sent ? 'agency.alerts.testSent' : 'agency.alerts.deviceFailed'));
        return;
      }
      const connection = await enablePushSubscription(push !== 'on');
      setPush(connection.state);
      const sent = connection.state === 'on' && await testDevicePush({ endpoint: connection.endpoint });
      setTestStatus(t(sent ? 'agency.alerts.testSent' : 'agency.alerts.deviceFailed'));
    } catch {
      setTestStatus(t('agency.alerts.deviceFailed'));
    } finally {
      setDeviceBusy(false);
    }
  };
  const ago = (at: string) => {
    const d = now - Date.parse(at);
    if (d < 60_000) return t('bell.now');
    if (d < 3_600_000) return t('bell.min', { n: Math.floor(d / 60_000) });
    return clock(at);
  };

  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;
  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <div className="px-bell" ref={box}>
      <button
        type="button"
        className={`icon-btn px-bell-btn${unread ? ' on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `${t('bell.open')} · ${t('bell.unread', { count: unread })}` : t('bell.open')}
        title={t('bell.open')}
        onClick={() => { if (!agency) unlockAudio(); setOpen((v) => !v); }}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="px-bell-n" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="px-bell-panel" style={panelPosition} role="dialog" aria-label={t('bell.title')}>
          <div className="px-bell-head">
            <img className="px-bell-brand" src={`${import.meta.env.BASE_URL}pilotix-icon.png`} alt="Pilotix" width="28" height="28" />
            <b>{t('bell.title')}</b>
            {agency && session!.isAdmin && <a className="px-bell-all" href="#/reglages/notifications" onClick={() => setOpen(false)} aria-label={t('agency.alerts.manage')} title={t('agency.alerts.manage')}><Icon name="settings" /></a>}
            {unread > 0 && <span className="px-bell-chip">{t('bell.unread', { count: unread })}</span>}
            {unread > 0 && (
              <button type="button" className="px-bell-all" title={t('bell.readAllLong')} onClick={readAll}>
                <Icon name="check" />
                {t('bell.readAll')}
              </button>
            )}
          </div>

          <div className="px-bell-list">
            {!items.length && (
              <div className="px-bell-empty">
                <span className="px-bell-empty-ic">
                  <Icon name="bell" />
                </span>
                <b>{t('bell.empty')}</b>
                <small>{t(agency ? 'agency.alerts.historyHint' : 'bell.emptyHint')}</small>
              </div>
            )}
            {items.map((x, i) => (
              <div key={x.id}>
                {(i === 0 || !sameDay(items[i - 1].at, x.at)) && <div className="px-bell-day">{dayLabel(x.at)}</div>}
                <button type="button" className={`px-bell-line k-${x.kind}${x.read ? '' : ' new'}`} onClick={() => go(x)}>
                  <span className="px-bell-ic">
                    <Icon name={ICON[x.kind] ?? 'bell'} />
                  </span>
                  <span className="px-bell-txt">
                    <b>{plain(x.title)}</b>
                    {x.body && <small>{x.body}</small>}
                  </span>
                  <span className="px-bell-when">
                    {ago(x.at)}
                    {!x.read && <i className="px-bell-dot" aria-hidden="true" />}
                  </span>
                </button>
              </div>
            ))}
          </div>

          <div className="px-bell-foot">
            {!agency && (
              <>
                <div className="px-bell-row">
                  <Icon name={soundOn ? 'volume' : 'volumeoff'} />
                  <span className="px-bell-row-t">
                    <b>{t('bell.sound')}</b>
                    <small>{work ? t('bell.soundWork', { hours: hoursText(data?.slots ?? []) }) : soundOn ? t('bell.soundOn') : t('bell.soundOff')}</small>
                  </span>
                  {work ? (
                    <span className="px-bell-lock" title={t('bell.soundWork', { hours: hoursText(data?.slots ?? []) })}>
                      <Icon name="lock" />
                    </span>
                  ) : (
                    <button type="button" role="switch" aria-checked={!mute} aria-label={t('bell.soundToggle')} className={`px-bell-switch${mute ? '' : ' on'}`} onClick={toggleMute}>
                      <i />
                    </button>
                  )}
                </div>
                {!ready && soundOn && <p className="px-bell-hint">{t('bell.soundTap')}</p>}
              </>
            )}
            <div className="px-bell-row">
              <Icon name="bell" />
              <span className="px-bell-row-t">
                <b>{t('devices.current')}</b>
                <small>
                  {demo ? t('devices.demoTest') : push === 'on'
                    ? t('bell.phoneOn')
                    : push === 'denied'
                      ? t('bell.phoneDenied')
                      : push === 'unsupported'
                        ? t(ios ? 'agency.alerts.installPush' : 'bell.phoneNo')
                        : t('bell.phoneAskHint')}
                </small>
              </span>
              {push === 'on' && (
                <span className="px-bell-ok">
                  <Icon name="check" />
                </span>
              )}
            </div>
            <button type="button" className="btn primary px-bell-push" disabled={deviceBusy} onClick={() => void sendTest()}>
              <Icon name="bell" /> {t('devices.sendTest')}
            </button>
            {testStatus && <small role="status">{testStatus}</small>}
            {backend.kind !== 'demo' && !session?.shop?.demo && !isNativePilotix() && (
              <button type="button" className="btn small" onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event(SHOW_NOTIFICATION_DEVICES));
              }}>{t('devices.title')}</button>
            )}
            {agency && push === 'on' && (
                <button type="button" className="btn small" disabled={deviceBusy} onClick={() => {
                  setDeviceBusy(true);
                  void disableDevicePush().then(() => setPush('off')).catch(() => toast(t('agency.alerts.deviceFailed'), 'bad')).finally(() => setDeviceBusy(false));
                }}>{t('agency.alerts.disableDevice')}</button>
            )}
          </div>
        </div>
      )}

      {!agency && pops.length > 0 &&
        createPortal(
          <div className={`px-bell-pops${open ? ' beside' : ''}`} style={open ? beside : undefined} role="status" aria-live="polite">
            {pops.map((x) => (
              <div key={key(x)} className={`px-bell-pop k-${x.kind}${x.important ? ' imp' : ''}`}>
                <span className="px-bell-ic">
                  <Icon name={ICON[x.kind] ?? 'bell'} />
                </span>
                <span className="px-bell-txt">
                  <small className="px-bell-kind">{t(`bell.kind.${x.kind}`)}</small>
                  <b>{plain(x.title)}</b>
                  {x.body && <small>{x.body}</small>}
                </span>
                <button type="button" className="px-bell-x" aria-label={t('bell.close')} onClick={() => setPops((p) => p.filter((y) => y.id !== x.id))}>
                  <Icon name="x" />
                </button>
                {(x.orderId || x.url) && (
                  <span className="px-bell-pop-act">
                    <button type="button" className="btn primary" onClick={() => go(x)}>
                      {t('bell.openIt')}
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
