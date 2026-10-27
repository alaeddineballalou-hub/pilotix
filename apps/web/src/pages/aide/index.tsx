// « Contacter Pilotix » (#/aide): the store's administrators write to Pilotix and read its answers. The store chooses
// what it tells: Pilotix sees nothing else of it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, when } from '../../lib/format';
import { server } from '../../lib/backend';
import { Card, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import '../platform/platform.css';

interface Thread {
  id: number;
  subject: string;
  status: 'open' | 'closed';
  unreadShop: boolean;
  updatedAt: string;
  messages: number;
  last: { fromStaff: boolean; text: string } | null;
}
interface Message {
  id: number;
  fromStaff: boolean;
  author: string;
  body: string;
  createdAt: string;
}

export function Support({ id }: { id: number | null }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ['support'], queryFn: () => server.support<Thread[]>(''), refetchInterval: 60_000 });
  const [writing, setWriting] = useState(false);
  return (
    <div className="px-aide">
      <div className="pp-head">
        <div>
          <h1>{t('shop.aide.title')}</h1>
          <p className="muted">{t('shop.aide.sub')}</p>
        </div>
        <button type="button" className="btn primary" onClick={() => (setWriting(true), (location.hash = '#/aide'))}>
          <Icon name="send" /> {t('shop.aide.new')}
        </button>
      </div>
      <div className="pp-msg">
        <Card title={t('shop.aide.list')}>
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error as Error} onRetry={() => list.refetch()} />
          ) : list.data!.length ? (
            <ul className="pp-threads">
              {list.data!.map((th) => (
                <li key={th.id} className={`${th.unreadShop ? 'unread' : ''} ${th.id === id ? 'on' : ''}`}>
                  <a href={`#/aide/${th.id}`} onClick={() => setWriting(false)}>
                    <span className="pp-two">
                      <b>{th.subject}</b>
                      {th.last && <small className="pp-last">{th.last.fromStaff ? `Pilotix : ${th.last.text}` : th.last.text}</small>}
                    </span>
                    <span className="pp-mini-r">
                      {th.status === 'closed' && <span className="chip">{t('shop.aide.closed')}</span>}
                      <small className="muted">{when(th.updatedAt)}</small>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('shop.aide.none')}</p>
          )}
        </Card>
        {writing || !id ? <NewMessage onSent={(nid) => (setWriting(false), (location.hash = `#/aide/${nid}`))} /> : <Conversation id={id} />}
      </div>
    </div>
  );
}

function NewMessage({ onSent }: { onSent: (id: number) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => server.support<{ id: number }>('', { subject: subject.trim(), body: body.trim() }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['support'] });
      toast(t('shop.aide.sent'), 'ok');
      onSent(r.id);
    },
    onError: (e: Error) => toast(e.message, 'bad'),
  });
  return (
    <Card title={t('shop.aide.new')}>
      <p className="small muted">{t('shop.aide.privacy')}</p>
      <Field label={t('shop.aide.subject')}>
        <input maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('shop.aide.subjectPh')} />
      </Field>
      <Field label={t('shop.aide.message')}>
        <textarea rows={6} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('shop.aide.messagePh')} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn primary" disabled={subject.trim().length < 2 || body.trim().length < 2 || send.isPending} onClick={() => send.mutate()}>
          <Icon name="send" /> {t('shop.aide.send')}
        </button>
      </div>
    </Card>
  );
}

function Conversation({ id }: { id: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['support', id], queryFn: () => server.support<{ thread: Thread; messages: Message[] }>(`/${id}`), refetchInterval: 30_000 });
  const [body, setBody] = useState('');
  const end = useRef<HTMLDivElement>(null);
  // a block, not an arrow that returns: new browsers' scrollIntoView returns a Promise, and React would call it on unmount
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [q.data?.messages.length]);
  // reading the answers marks them read: the menu's dot goes away
  useEffect(() => {
    if (q.data) qc.invalidateQueries({ queryKey: ['support'], exact: true });
  }, [q.data, qc]);
  const reply = useMutation({
    mutationFn: () => server.support<{ ok: true }>(`/${id}`, { body: body.trim() }),
    onSuccess: () => {
      setBody('');
      qc.invalidateQueries({ queryKey: ['support'] });
    },
    onError: (e: Error) => toast(e.message, 'bad'),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error as Error} onRetry={() => q.refetch()} />;
  const { thread, messages } = q.data!;
  return (
    <Card title={thread.subject}>
      <div className="pp-chat">
        {messages.map((m) => (
          <div key={m.id} className={`pp-bubble ${m.fromStaff ? '' : 'me'}`}>
            <p>{m.body}</p>
            <small className="muted">
              {m.fromStaff ? `Pilotix · ${m.author}` : m.author} · {dateTime(m.createdAt)}
            </small>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="pp-reply">
        <textarea rows={3} maxLength={5000} value={body} placeholder={t('shop.aide.replyPh')} onChange={(e) => setBody(e.target.value)} />
        <button type="button" className="btn primary" disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate()}>
          <Icon name="send" /> {t('shop.aide.send')}
        </button>
      </div>
    </Card>
  );
}
