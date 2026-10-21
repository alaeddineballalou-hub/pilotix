// Messages between a livreur and the office (admin, managers, Suivi). Used in « Ma tournée » and by the office.
import type { Order } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';

export function Chat({ livreurId, orders = [], self }: { livreurId?: number; orders?: Order[]; self: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('cash.chat', { livreurId, limit: 100 }, { refetchInterval: 20_000 });
  const [body, setBody] = useState('');
  const [orderId, setOrderId] = useState<number | ''>('');
  const send = useAction('cash.chatSend', { onDone: () => (setBody(''), setOrderId('')) });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [q.data?.length]);
  const quick = self ? (t('tournee.chat.quick', { returnObjects: true }) as string[]) : (t('tournee.chat.quickOffice', { returnObjects: true }) as string[]);
  const submit = (text = body) => {
    if (!text.trim()) return;
    send.mutate({ livreurId, body: text.trim(), orderId: orderId || null });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', marginTop: 6 }}>
      <div className="bjr-watch">
        <span className="bjr-ic" aria-hidden="true">
          <Icon name="lock" />
        </span>
        {t('tournee.chat.watch')}
      </div>
      <div className="bjr-msgs" ref={box} aria-live="polite">
        {q.isLoading ? (
          <span className="muted">{t('common.loading')}</span>
        ) : !q.data?.length ? (
          <span className="muted small">{t('tournee.chat.empty')}</span>
        ) : (
          q.data.map((m) => (
            <div key={m.id} className={`bjr-m ${m.mine ? 'mine' : m.fromLivreur ? 'liv' : ''}`}>
              <span className="bjr-who">
                {m.mine ? t('tournee.chat.me') : m.userName}
                {!m.mine && !m.fromLivreur && <span className="bjr-role">{t('tournee.chat.office')}</span>}
                <span>{when(m.at)}</span>
              </span>
              <span className="bjr-b">
                {m.orderRef && <b className="ltr">{m.orderRef} · </b>}
                {m.body}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="bjr-cmp">
        <div className="bjr-qr">
          {quick.map((x) => (
            <button key={x} type="button" disabled={send.isPending} onClick={() => submit(x)}>
              {x}
            </button>
          ))}
        </div>
        {orders.length > 0 && (
          <select aria-label={t('tournee.chat.link')} value={orderId} onChange={(e) => setOrderId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('tournee.chat.link')}</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.ref} · {o.customerName} · {t(`status.follow.${o.followStatus}`)}
              </option>
            ))}
          </select>
        )}
        <div className="bjr-cmp-r">
          <textarea
            rows={1}
            aria-label={t('tournee.chat.message')}
            placeholder={self ? t('tournee.chat.placeholder') : t('tournee.chat.placeholderOffice')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" className="btn primary bjr-sendb" title={t('tournee.chat.send')} aria-label={t('tournee.chat.send')} disabled={!body.trim() || send.isPending} onClick={() => submit()}>
            <span className="bjr-ic" aria-hidden="true">
              <Icon name="navigation" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
