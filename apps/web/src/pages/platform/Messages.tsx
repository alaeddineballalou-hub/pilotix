// Messages from stores (« Contacter Pilotix »): the conversations, unread first; one conversation, the answer (the
// store's author gets it by e-mail too), closed or opened again. The store chooses what it tells; nothing else is seen.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, when } from '../../lib/format';
import { usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Empty } from './bits';

export function Messages({ id }: { id: number | null }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const list = usePRpc('p.support.list', { status }, { refetchInterval: 30_000 });
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.messages')}</h1>
          <p className="muted">{t('platform.msg.sub')}</p>
        </div>
      </div>
      <div className="pp-msg">
        <Card
          title={t('platform.msg.list')}
          actions={
            <div className="tabs">
              {(['open', 'closed', 'all'] as const).map((s) => (
                <button key={s} type="button" className={`tab ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
                  {t(`platform.msg.f_${s}`)}
                </button>
              ))}
            </div>
          }
        >
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} onRetry={() => list.refetch()} />
          ) : list.data!.length ? (
            <ul className="pp-threads">
              {list.data!.map((th) => (
                <li key={th.id} className={`${th.unreadStaff ? 'unread' : ''} ${th.id === id ? 'on' : ''}`}>
                  <a href={`#/platform/messages/${th.id}`}>
                    <span className="pp-two">
                      <b>{th.subject}</b>
                      <small className="muted">
                        {th.shopName} · {th.authorName}
                      </small>
                      {th.last && <small className="pp-last">{th.last.fromStaff ? `↩ ${th.last.text}` : th.last.text}</small>}
                    </span>
                    <small className="muted">{when(th.updatedAt)}</small>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('platform.msg.none')}</Empty>
          )}
        </Card>
        {id ? <Thread id={id} /> : <Card title={t('platform.msg.pick')}>{<Empty>{t('platform.msg.pickText')}</Empty>}</Card>}
      </div>
    </div>
  );
}

function Thread({ id }: { id: number }) {
  const { t } = useTranslation();
  const q = usePRpc('p.support.get', { id });
  const [body, setBody] = useState('');
  const reply = usePAction('p.support.reply', { success: t('platform.msg.sent'), onDone: () => setBody('') });
  const close = usePAction('p.support.setStatus', {});
  const end = useRef<HTMLDivElement>(null);
  // a block, not an arrow that returns: new browsers' scrollIntoView returns a Promise, and React would call it on unmount
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [q.data?.messages.length]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const { thread, messages } = q.data!;
  return (
    <Card
      title={thread.subject}
      actions={
        <>
          <a className="btn small" href={`#/platform/shops/${thread.shopId}`}>
            <Icon name="store" /> {thread.shopName}
          </a>
          <button type="button" className="btn small" disabled={close.isPending} onClick={() => close.mutate({ id, status: thread.status === 'open' ? 'closed' : 'open' })}>
            {thread.status === 'open' ? t('platform.msg.close') : t('platform.msg.reopen')}
          </button>
        </>
      }
    >
      <p className="small muted ltr">
        {thread.authorName} · {thread.authorEmail}
      </p>
      <div className="pp-chat">
        {messages.map((m) => (
          <div key={m.id} className={`pp-bubble ${m.fromStaff ? 'me' : ''}`}>
            <p>{m.body}</p>
            <small className="muted">
              {m.author} · {dateTime(m.createdAt)}
            </small>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="pp-reply">
        <textarea rows={3} maxLength={5000} value={body} placeholder={t('platform.msg.replyHint')} onChange={(e) => setBody(e.target.value)} />
        <button type="button" className="btn primary" disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate({ id, body: body.trim() })}>
          <Icon name="send" /> {t('platform.msg.send')}
        </button>
      </div>
    </Card>
  );
}
