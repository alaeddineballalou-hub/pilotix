import { phoneWa, withReactivationLink } from '@pilotix/shared';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { EXT_ZIP, extSend, extVersion, photoFiles, sendMode, sharePhotoFiles, waApps, waChat, waPhotos } from '../../lib/waShare';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import whatsappLogo from '../../assets/brand/whatsapp-logo.svg';
import './attempt-message.css';

export type MessageChannel = 'whatsapp' | 'sms';
/** how the cancel message's photo reaches the chat: pc the extension, app the Pilotix app, share a phone's share menu,
 *  card only in the link's preview (no way on this device, or no photo) */
type PhotoWay = 'pc' | 'app' | 'share' | 'card';
/** the WhatsApp the agent uses in the Pilotix app (« Envoyer des photos » keeps the same choice) */
const WA_APP_KEY = 'waApp';
export type OpenedMessage = { channel: MessageChannel; text: string; reorderToken?: string };
export const finalAttempt = (attempts: number, limit: number) => limit > 0 && attempts + 1 >= limit;
/** This call is the try of the shop's first message (Management › Statuts › « Messages client », 3 at the start). An order
 *  already past it (from before the rule) is not asked again. */
export const messageAttempt = (attempts: number, at: number) => attempts + 1 === at;

/** What the agent's last tap did: « ok » copied and the app opened, « again » copied the slow way (tap once more to open
 *  the app), « fail » nothing copied (the app stayed closed). */
type Copied = { state: 'ok' | 'again' | 'fail'; channel: MessageChannel; text: string };

/** Copies the message inside the tap itself, before WhatsApp or the SMS app takes the screen: a page sent to the
 *  background may no longer write to the clipboard. The old way (select, then « copy ») answers at once. The text is
 *  selected inside the open window: a modal window makes the rest of the page unusable, its text too. */
function copyNow(text: string, host: Element): boolean {
  const span = document.createElement('span');
  span.textContent = text;
  span.style.cssText = 'position:fixed;top:0;left:0;white-space:pre-wrap;opacity:0;pointer-events:none;user-select:text;-webkit-user-select:text';
  host.append(span);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(span);
  selection?.removeAllRanges();
  selection?.addRange(range);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  selection?.removeAllRanges();
  span.remove();
  return ok;
}

export function AttemptMessage({ phone, orderId, message, onMessage, onOpen, cancelling, back }: {
  phone?: string;
  orderId?: number;
  message: string;
  onMessage: (value: string) => void;
  onOpen: (value: OpenedMessage | null) => void;
  cancelling?: boolean;
  /** The agent came back to Pilotix after the app opened (AttemptMessageLock): « Terminer » shows. */
  back?: boolean;
}) {
  const { t } = useTranslation();
  const [draft] = useState(() => globalThis.crypto.randomUUID());
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 60_000 });
  // the shop's text with this order's values (« Messages client »); before a cancel, with a new one-time link: the short
  // one on the shop's own domain (babyjoydz.net/r/…), else on the site's address (the preview: this page's)
  const tpl = useRpc('orders.customerMessage', { id: orderId ?? 0, kind: cancelling ? 'cancel' : 'attempt', draft }, { enabled: !!orderId && !!phone, staleTime: Infinity });
  const url = !cancelling ? '' : tpl.data?.url || (tpl.data?.path ? new URL(tpl.data.path, window.location.origin).href : '');
  const defaultText = tpl.data ? (cancelling ? (url ? withReactivationLink(tpl.data.text, url) : '') : tpl.data.text) : '';
  const text = message.trim() || defaultText;
  // the agent may change the words: the link always goes (on a line of its own at the end when he took it out)
  const payload = cancelling && url ? withReactivationLink(text, url) : text;
  const body = encodeURIComponent(payload);
  const canOpen = !!body && (!cancelling || !!url);
  const waHref = phone ? `https://wa.me/${phoneWa(phone)}?text=${body}` : '';

  // the cancel message's photo: the product's main photo, into the chat with the message where this device can (the way
  // « Envoyer des photos » sends: the extension on a computer, the Pilotix app, a phone's share menu), else only in the
  // link's preview (the preview has its small picture: shown, nothing more)
  const photo = cancelling ? (tpl.data?.photo ?? null) : null;
  const realPhoto = photo && /^https:\/\//.test(photo) ? photo : null;
  const mode = useMemo(sendMode, []);
  const ext = useMemo(extVersion, []);
  // the photo's way failed once (WhatsApp Web closed, no WhatsApp…): the next tap sends the message with its link
  const [fallback, setFallback] = useState(false);
  const way: PhotoWay = !realPhoto || fallback ? 'card' : mode === 'pc' ? (ext ? 'pc' : 'card') : mode === 'app' ? 'app' : mode === 'share' ? 'share' : 'card';
  const [app, setApp] = useState<string | null>(null);
  useEffect(() => {
    if (way !== 'app') return;
    let live = true;
    void waApps().then((a) => {
      if (!live) return;
      const kept = store.get(WA_APP_KEY);
      setApp(kept && a.includes(kept) ? kept : (a[0] ?? null));
    });
    return () => {
      live = false;
    };
  }, [way]);
  // a phone's browser: the photo fetched while the agent sends the message, for the share menu after
  const files = useRef<Promise<File[] | null> | null>(null);
  useEffect(() => {
    if (way === 'share' && realPhoto && !files.current) files.current = photoFiles([realPhoto], 'photo').catch(() => null);
  }, [way, realPhoto]);
  const [shared, setShared] = useState<'todo' | 'busy' | 'done'>('todo');
  // the app: the message opened the chat; when the agent comes back to Pilotix, the photo goes into it by itself (once)
  const [armed, setArmed] = useState(false);
  const photoGone = useRef(false);
  useEffect(() => {
    if (!armed || !realPhoto || !phone) return;
    let away = document.visibilityState === 'hidden';
    let timer = 0;
    const seen = () => {
      if (document.visibilityState === 'hidden') {
        away = true;
        return;
      }
      if (!away || photoGone.current) return;
      away = false;
      timer = window.setTimeout(() => {
        photoGone.current = true;
        void waPhotos(phoneWa(phone), [realPhoto], app).catch(() => toast(t('confirmation.cancelPhoto.failed'), 'bad', 6000));
      }, 700);
    };
    document.addEventListener('visibilitychange', seen);
    return () => {
      document.removeEventListener('visibilitychange', seen);
      window.clearTimeout(timer);
    };
  }, [armed, realPhoto, phone, app, t]);
  /** the photo could not go: the next tap on WhatsApp sends the message with its link (its preview shows the photo) */
  const linkOnly = () => {
    setFallback(true);
    toast(t('confirmation.cancelPhoto.again'), 'bad', 8000);
  };
  const sendWithPhoto = (): (() => void) | undefined => {
    if (!phone || !realPhoto) return undefined;
    if (way === 'pc') return () => void extSend(phoneWa(phone), payload, [realPhoto]).then((r) => !r.ok && linkOnly());
    if (way === 'app') return () => void waChat(phoneWa(phone), payload, app).then(() => setArmed(true), linkOnly);
    return undefined;
  };
  const sharePhoto = async () => {
    if (!realPhoto) return;
    setShared('busy');
    try {
      const f = await (files.current ??= photoFiles([realPhoto], 'photo').catch(() => null));
      if (!f?.length) {
        files.current = null;
        throw new Error('photo');
      }
      setShared((await sharePhotoFiles(f)) === 'cancelled' ? 'todo' : 'done');
    } catch {
      setShared('todo');
      toast(t('confirmation.cancelPhoto.failed'), 'bad', 6000);
    }
  };

  const open = (channel: MessageChannel) => onOpen({ channel, text: payload, reorderToken: cancelling ? tpl.data?.token ?? undefined : undefined });
  const [copied, setCopied] = useState<Copied | null>(null);
  // « Terminer » comes only once the message is copied: each tap copies it first, then opens the app (its link fills it
  // in too); nothing copied = the app stays closed and the tap must be done again. `send`: the photo's way instead of
  // the link (the extension, the Pilotix app)
  const tap = (channel: MessageChannel, send?: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
    const slow = copied?.state === 'again' && copied.text === payload; // copied the slow way on the tap before
    if (!copyNow(payload, event.currentTarget.closest('dialog') ?? document.body) && !slow) {
      event.preventDefault();
      setCopied({ state: 'fail', channel, text: payload });
      void copyText(payload).then((ok) => setCopied((now) => (now?.text === payload ? { state: ok ? 'again' : 'fail', channel, text: payload } : now)));
      return;
    }
    setCopied({ state: 'ok', channel, text: payload });
    open(channel);
    if (send) {
      event.preventDefault();
      send();
    }
  };
  const status = copied?.text === payload ? (copied.state === 'ok' && back ? 'back' : copied.state) : null;
  const photoNote = way === 'pc' || way === 'app' ? 'goes' : way === 'share' ? 'share' : realPhoto && mode === 'pc' && !ext ? 'ext' : 'card';
  return <>
    <label className="qd6-lab">
      {t(cancelling ? 'confirmation.cancellationMessageRequired' : 'confirmation.attemptMessageRequired', { n: meta.data?.messageAtTry ?? 3 })}
      <textarea className="qd6-in" dir="auto" rows={6} maxLength={cancelling ? 900 : 1000} value={message || defaultText} onChange={(event) => {
        onMessage(event.target.value);
        setCopied(null);
        onOpen(null);
      }} />
    </label>
    {phone ? <>
      {cancelling && <small>{t('confirmation.cancelReorderLink')}</small>}
      {photo && <div className="attempt-message-photo">
        <img src={photo} alt="" />
        <small>
          {t(`confirmation.cancelPhoto.${photoNote}`)}
          {photoNote === 'ext' && <> <a href={EXT_ZIP} download>{t('confirmation.cancelPhoto.install')}</a></>}
        </small>
      </div>}
      {tpl.error && <button type="button" className="btn small" onClick={() => void tpl.refetch()}>{t('common.retry')}</button>}
      <div className="attempt-message-channels">
        {canOpen ? <a className="btn" href={`sms:${phone}?body=${body}`} aria-label="SMS"
          onClick={tap('sms')}><Icon name="message" /></a> : <button type="button" className="btn" disabled aria-label="SMS"><Icon name="message" /></button>}
        {canOpen ? <a className="btn" href={waHref} target="_blank" rel="noopener noreferrer"
          aria-label="WhatsApp" onClick={tap('whatsapp', sendWithPhoto())}><img src={whatsappLogo} alt="" /></a>
          : <button type="button" className="btn" disabled aria-label="WhatsApp"><img src={whatsappLogo} alt="" /></button>}
      </div>
      {way === 'share' && back && copied?.channel === 'whatsapp' && <button type="button" className={`btn${shared === 'done' ? '' : ' primary'} attempt-message-share`}
        disabled={shared === 'busy'} onClick={() => void sharePhoto()}>
        <Icon name="image" /> {t(shared === 'done' ? 'confirmation.cancelPhoto.shared' : 'confirmation.cancelPhoto.send')}
      </button>}
      {status && copied && <p role="status" className={`attempt-message-copy ${status}`}>
        {t(`confirmation.attemptCopy.${status}`, { app: copied.channel === 'sms' ? 'SMS' : 'WhatsApp' })}
      </p>}
    </> : <p className="muted">{t('confirmation.attemptMessageOneOrder')}</p>}
  </>;
}

export function AttemptMessageLock({ busy, error, onFinish, ...props }: Omit<Parameters<typeof AttemptMessage>[0], 'onOpen'> & {
  busy: boolean;
  error?: string;
  onFinish: (message: OpenedMessage) => void;
}) {
  const { t } = useTranslation();
  const meta = useRpc('orders.uiMeta', {}, { staleTime: 60_000 });
  const dialog = useRef<HTMLDialogElement>(null);
  const opened = useRef<OpenedMessage | null>(null);
  const left = useRef(false);
  const [returned, setReturned] = useState<OpenedMessage | null>(null);
  useEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    const leave = () => { if (opened.current) left.current = true; };
    const arrive = () => {
      if (left.current && document.visibilityState === 'visible' && document.hasFocus()) setReturned(opened.current);
    };
    const visibility = () => document.visibilityState === 'hidden' ? leave() : arrive();
    window.addEventListener('blur', leave);
    window.addEventListener('focus', arrive);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      panel?.close();
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', arrive);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return <dialog ref={dialog} className="attempt-message-lock" aria-label={t(props.cancelling ? 'confirmation.cancellationMessageRequired' : 'confirmation.attemptMessageRequired', { n: meta.data?.messageAtTry ?? 3 })}
    onCancel={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (event.key === 'Escape') event.stopPropagation();
    }}>
    <form className="attempt-message-card" onSubmit={(event) => { event.preventDefault(); if (!busy && returned) onFinish(returned); }}>
      <AttemptMessage {...props} back={!!returned} onOpen={(entry) => {
        opened.current = entry;
        left.current = false;
        setReturned(null);
      }} />
      {error && <p role="alert" className="form-err">{error}</p>}
      {returned && <button type="submit" className="btn primary" disabled={busy}>{t('confirmation.attemptFinish')}</button>}
    </form>
  </dialog>;
}
