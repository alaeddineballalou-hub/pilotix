import { phoneWa } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';

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
      <div className="row">
        {canOpen && <a className="btn small" href={`https://wa.me/${phoneWa(phone)}?text=${body}`} target="_blank" rel="noopener noreferrer"
          onClick={() => open('whatsapp')}>WhatsApp</a>}
        {canOpen && <a className="btn small" href={`sms:${phone}?body=${body}`}
          onClick={() => open('sms')}>SMS</a>}
      </div>
    </> : <p className="muted">{t('confirmation.attemptMessageOneOrder')}</p>}
  </>;
}
