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
import { enablePush } from '../lib/push';
import { useRpc } from '../lib/query';
import { useSession } from '../lib/session';
import { audioReady, bellSound, BellSound, unlockAudio } from '../lib/sound';
import { store } from '../lib/store';
import { Icon } from '../ui/kit';
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
const KINDS = Object.keys(ICON) as BellSound[];
/** where each kind's « Ouvrir » goes (the demo's examples: pxBell) */
const SAMPLE_PAGE: Record<BellSound, string | null> = {
  order: '#/confirmation/nouvelles',
  callback: '#/confirmation/attente',
  delivered: '#/commandes/tout',
  returned: '#/commandes/tout',
  cancelled: '#/commandes/tout',
  taken: '#/confirmation/nouvelles',
  alert: '#/suivi/alertes',
  depot: '#/depot/preparer',
  message: '#/commandes/tout',
  info: '#/confirmation/nouvelles',
};
const LOUD = new Set<BellSound>(['order', 'callback', 'alert']);
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
  const { session } = useSession();
  const me = session!.profile.id;
  const here = session!.shop?.id;
  const q = useRpc('inbox.list', {}, { staleTime: 60_000, refetchInterval: 5 * 60_000 });
  const data = q.data;
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const [open, setOpen] = useState(false);
  const [pops, setPops] = useState<Line[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [mute, setMute] = useState(() => store.get('bell-sound') === 'off');
  const [sounds, setSounds] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const [ready, setReady] = useState(audioReady());
  const box = useRef<HTMLDivElement>(null);
  /** the list open on a computer: the pop-ups go beside it (« Écouter les sons ») */
  const [beside, setBeside] = useState<CSSProperties | undefined>();
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
        if (mine) fresh.current = true;
        void refetch.current();
      }),
    [me, here],
  );

  useEffect(() => {
    if (!data) return;
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
  }, [data]);

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
    enablePush(false)
      .then(setPush)
      .catch(() => setPush('unsupported'));
    return () => (document.body.classList.remove('px-bell-open'), document.removeEventListener('pointerdown', down), document.removeEventListener('keydown', k), window.removeEventListener('hashchange', away));
  }, [open]);

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!open || !r || window.innerWidth <= 900) return setBeside(undefined);
    const rtl = document.documentElement.dir === 'rtl';
    setBeside(rtl ? { top: r.bottom + 10, left: r.left + 404, right: 'auto' } : { top: r.bottom + 10, right: window.innerWidth - r.right + 404, left: 'auto' });
  }, [open]);

  const read = useCallback((ids: number[]) => {
    if (ids.length) void rpc('inbox.read', { ids }).then(() => refetch.current()).catch(() => {});
  }, []);
  const go = (x: Line) => {
    setOpen(false);
    setPops((p) => p.filter((y) => y.id !== x.id));
    if (!x.read) read([x.id]);
    if (x.orderId) openOrder(x.orderId);
    else if (x.url) location.hash = x.url;
  };
  const readAll = () => void rpc('inbox.readAll', {}).then(() => refetch.current()).catch(() => {});
  /** « Écouter les sons »: the sound of a kind and its pop-up, with an example (never sent to anyone) */
  const sample = (k: BellSound, url: string | null = null) => {
    unlockAudio();
    window.setTimeout(() => bellSound(k, LOUD.has(k)), 30);
    const x: Line = { id: -Date.now(), kind: k, title: t(`bell.sample.${k}.t`), body: t(`bell.sample.${k}.b`), url, orderId: null, important: LOUD.has(k), n: 1, at: new Date().toISOString(), read: true };
    setPops((p) => [x, ...p].slice(0, 3));
  };
  const sampleRef = useRef(sample);
  sampleRef.current = sample;
  // the browser demo only: a pop-up of each kind from the console (« pxBell('delivered') »), to see and hear it where it
  // shows (the top of the page), with « Ouvrir » to its page. Never on a real server.
  useEffect(() => {
    if (backend.kind !== 'demo') return;
    const w = window as unknown as { pxBell?: (k: BellSound) => void };
    w.pxBell = (k) => sampleRef.current(k, SAMPLE_PAGE[k]);
    return () => void delete w.pxBell;
  }, []);
  const toggleMute = () => {
    store.set('bell-sound', mute ? null : 'off');
    setMute(!mute);
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
        onClick={() => (unlockAudio(), setOpen((v) => !v))}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="px-bell-n" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="px-bell-panel" role="dialog" aria-label={t('bell.title')}>
          <div className="px-bell-head">
            <b>{t('bell.title')}</b>
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
                <small>{t('bell.emptyHint')}</small>
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
            <button type="button" className="px-bell-more" aria-expanded={sounds} onClick={() => (unlockAudio(), setSounds((v) => !v))}>
              <Icon name="play" />
              {t('bell.sounds')}
              <Icon name="chevron" className={`px-bell-ch${sounds ? ' up' : ''}`} />
            </button>
            {sounds && <p className="px-bell-hint soft">{t('bell.soundsHint')}</p>}
            {sounds && (
              <div className="px-bell-sounds">
                {KINDS.map((k) => (
                  <button key={k} type="button" className={`px-bell-snd k-${k}`} onClick={() => sample(k)}>
                    <span className="px-bell-ic">
                      <Icon name={ICON[k]} />
                    </span>
                    {t(`bell.kind.${k}`)}
                  </button>
                ))}
              </div>
            )}
            <div className="px-bell-row">
              <Icon name="smartphone" />
              <span className="px-bell-row-t">
                <b>{t('bell.phone')}</b>
                <small>
                  {push === 'on'
                    ? t('bell.phoneOn')
                    : push === 'denied'
                      ? t('bell.phoneDenied')
                      : push === 'unsupported'
                        ? t(backend.kind === 'demo' ? 'bell.phonePreview' : 'bell.phoneNo')
                        : t('bell.phoneAskHint')}
                </small>
              </span>
              {push === 'on' && (
                <span className="px-bell-ok">
                  <Icon name="check" />
                </span>
              )}
            </div>
            {push === 'off' && (
              <button type="button" className="btn primary px-bell-push" onClick={() => enablePush(true).then(setPush).catch(() => setPush('unsupported'))}>
                <Icon name="bell" />
                {t('bell.phoneAsk')}
              </button>
            )}
          </div>
        </div>
      )}

      {pops.length > 0 &&
        createPortal(
          <div className={`px-bell-pops${open ? ' beside' : ''}`} style={beside} role="status" aria-live="polite">
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
