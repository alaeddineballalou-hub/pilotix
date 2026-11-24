import { phoneWa } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import whatsappLogo from '../../assets/brand/whatsapp-logo.svg';
import './attempt-message.css';

export type MessageChannel = 'whatsapp' | 'sms';
export type OpenedMessage = { channel: MessageChannel; text: string; reorderToken?: string };
export const finalAttempt = (attempts: number, limit: number) => limit > 0 && attempts + 1 >= limit;

export function AttemptMessage({ phone, orderId, message, onMessage, onOpen, cancelling }: {
  phone?: string;
  orderId?: number;
  message: string;
  onMessage: (value: string) => void;
  onOpen: (value: OpenedMessage | null) => void;
  cancelling?: boolean;
}) {
  const { t } = useTranslation();
  const [draft] = useState(() => globalThis.crypto.randomUUID());
  const link = useRpc('orders.reorderLink', { id: orderId ?? 0, draft }, { enabled: !!cancelling && !!orderId && !!phone, staleTime: Infinity });
  const defaultText = cancelling ? t('confirmation.cancelReorderText') : '';
  const text = message.trim() || defaultText;
  const payload = cancelling && link.data ? `${text}\n${new URL(link.data.path, window.location.origin).href}` : text;
  const body = encodeURIComponent(payload);
  const canOpen = !!body && (!cancelling || !!link.data);
  const open = (channel: MessageChannel) => onOpen({ channel, text: payload, reorderToken: cancelling ? link.data?.token : undefined });
  return <>
    <label className="qd6-lab">
      {t(cancelling ? 'confirmation.cancellationMessageRequired' : 'confirmation.attemptMessageRequired')}
      <textarea className="qd6-in" maxLength={cancelling ? 700 : 1000} value={message || defaultText} onChange={(event) => {
        onMessage(event.target.value);
        onOpen(null);
      }} />
    </label>
    {phone ? <>
      {cancelling && <small>{t('confirmation.cancelReorderLink')}</small>}
      {cancelling && link.error && <button type="button" className="btn small" onClick={() => void link.refetch()}>{t('common.retry')}</button>}
      <div className="attempt-message-channels">
        {canOpen ? <a className="btn" href={`sms:${phone}?body=${body}`} aria-label="SMS"
          onClick={() => open('sms')}><Icon name="message" /></a> : <button type="button" className="btn" disabled aria-label="SMS"><Icon name="message" /></button>}
        {canOpen ? <a className="btn" href={`https://wa.me/${phoneWa(phone)}?text=${body}`} target="_blank" rel="noopener noreferrer"
          aria-label="WhatsApp" onClick={() => open('whatsapp')}><img src={whatsappLogo} alt="" /></a>
          : <button type="button" className="btn" disabled aria-label="WhatsApp"><img src={whatsappLogo} alt="" /></button>}
      </div>
    </> : <p className="muted">{t('confirmation.attemptMessageOneOrder')}</p>}
  </>;
}

export function AttemptMessageLock({ busy, error, onFinish, ...props }: Omit<Parameters<typeof AttemptMessage>[0], 'onOpen'> & {
  busy: boolean;
  error?: string;
  onFinish: (message: OpenedMessage) => void;
}) {
  const { t } = useTranslation();
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
  return <dialog ref={dialog} className="attempt-message-lock" aria-label={t(props.cancelling ? 'confirmation.cancellationMessageRequired' : 'confirmation.attemptMessageRequired')}
    onCancel={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (event.key === 'Escape') event.stopPropagation();
    }}>
    <form className="attempt-message-card" onSubmit={(event) => { event.preventDefault(); if (!busy && returned) onFinish(returned); }}>
      <AttemptMessage {...props} onOpen={(entry) => {
        opened.current = entry;
        left.current = false;
        setReturned(null);
      }} />
      {error && <p role="alert" className="form-err">{error}</p>}
      {returned && <button type="submit" className="btn primary" disabled={busy}>{t('confirmation.attemptFinish')}</button>}
    </form>
  </dialog>;
}
