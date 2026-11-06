// Publicité › Demander (the owner only): a conversation with Pilot AI about the shop's ads. Pilot AI reads the numbers
// with Meta's own tools (Meta's ads MCP server) and answers in the language of the question; under each answer, what
// it read. A change it proposes shows as a card — « Oui, faire » / « Non » — and nothing changes on Meta before the
// yes (then the owner's limits, Meta, the log of changes). Earlier conversations stay below, one line each.
// Everything is decided in core (ads.ask.*).
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../../lib/backend';
import { since } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { ErrorBox, Icon, Loading } from '../../../ui/kit';

type State = Out<'ads.ask.state'>;
type Ask = State['asks'][number];
const TRIES = ['a', 'b', 'c', 'd', 'e'] as const;

export function AskPilot() {
  const { t, i18n } = useTranslation();
  const q = useRpc('ads.ask.state', {}, { refetchInterval: 60_000 });
  const [thread, setThread] = useState<number | null | 'new'>(null);
  const [text, setText] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const lang = (['fr', 'en', 'ar'].includes(i18n.language) ? i18n.language : 'fr') as 'fr' | 'en' | 'ar';
  const s = q.data;
  const threads = useMemo(() => {
    const m = new Map<number, Ask[]>();
    for (const a of s?.asks ?? []) m.set(a.threadId, [...(m.get(a.threadId) ?? []), a]);
    return [...m.entries()].map(([id, asks]) => ({ id, asks })).sort((a, b) => b.asks[b.asks.length - 1].id - a.asks[a.asks.length - 1].id);
  }, [s]);
  // the open conversation: the one chosen, else the latest
  const current = thread === 'new' ? null : (threads.find((x) => x.id === thread) ?? (thread === null ? threads[0] : undefined) ?? null);
  const send = useAction('ads.ask.send', {
    onDone: (r) => {
      setThread(r.threadId);
      setText('');
    },
  });
  const forget = useAction('ads.ask.forget', { success: t('adsask.forgotten'), onDone: () => setThread('new') });
  // the newest message in sight: the conversation scrolls inside its own box (the page itself stays where it is)
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current?.id, current?.asks.length, send.isPending]);
  if (q.error && !s) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!s) return <Loading />;
  const ask = (question: string) => {
    const v = question.trim();
    if (v.length < 2 || send.isPending) return;
    setText(v);
    send.mutate({ question: v, threadId: current?.id ?? null, lang });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(text);
  };
  const blocked = !s.demo && (!s.connected || !s.ai);
  return (
    <div className="pa-ask">
      <div className="pa-ask-head">
        <span className="pa-ask-mark" aria-hidden="true">
          <Icon name="sparkles" />
        </span>
        <div>
          <h2>{t('adsask.title')}</h2>
          <p className="muted">{t('adsask.sub')}</p>
        </div>
        {current && (
          <button type="button" className="btn small pa-ask-new" onClick={() => setThread('new')}>
            <Icon name="plus" /> {t('adsask.new')}
          </button>
        )}
      </div>
      {s.demo && (
        <p className="pa-ask-demo">
          <Icon name="info" /> {t(s.ai ? 'adsask.demoAi' : 'adsask.demo')}
        </p>
      )}
      {!s.demo && !s.connected && <div className="warnbox">{t('adsask.notLinked')}</div>}
      {!s.demo && s.connected && !s.ai && <div className="warnbox">{t('adsask.noAi')}</div>}

      <section className="card pa-ask-chat" aria-live="polite">
        {!current && !send.isPending ? (
          <div className="pa-ask-start">
            <p className="muted">{t('adsask.start')}</p>
            <div className="pa-ask-tries">
              {TRIES.map((k) => (
                <button key={k} type="button" disabled={blocked} onClick={() => ask(t(`adsask.tries.${k}`))}>
                  {t(`adsask.tries.${k}`)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="pa-ask-list" ref={list}>
            {current?.asks.map((a) => (
              <Turn key={a.id} a={a} owner />
            ))}
            {send.isPending && (
              <li className="pa-ask-turn">
                <p className="pa-ask-q" dir="auto">
                  {text}
                </p>
                <div className="pa-ask-a pa-ask-wait">
                  <Icon name="sparkles" /> {t('adsask.thinking')}
                </div>
              </li>
            )}
          </ol>
        )}
        <form className="pa-ask-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="pa-ask-text">
            {t('adsask.ph')}
          </label>
          <textarea
            id="pa-ask-text"
            rows={2}
            maxLength={1000}
            dir="auto"
            value={send.isPending ? '' : text}
            placeholder={t('adsask.ph')}
            disabled={blocked || send.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(text);
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={blocked || send.isPending || text.trim().length < 2}>
            <Icon name="send" /> <span className="pa-ask-send">{t('adsask.send')}</span>
          </button>
        </form>
      </section>

      {threads.length > (current ? 1 : 0) && (
        <section className="card pa-ask-old">
          <h3 className="pa-h">{t('adsask.older')}</h3>
          <ul>
            {threads
              .filter((x) => x.id !== current?.id)
              .slice(0, 8)
              .map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => setThread(x.id)}>
                    <span dir="auto">{x.asks[0].question}</span>
                    <small className="muted">
                      {t('pilotads.ago', { d: since(x.asks[x.asks.length - 1].at) })}
                      {x.asks.some((a) => a.status === 'waiting_yes') && <b className="pa-ask-dot"> · {t('adsask.waitingShort')}</b>}
                    </small>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
      {current && (
        <button type="button" className="btn small pa-ask-forget" disabled={forget.isPending} onClick={() => forget.mutate({ threadId: current.id })}>
          <Icon name="trash" /> {t('adsask.forget')}
        </button>
      )}
    </div>
  );
}

function Turn({ a, owner }: { a: Ask; owner: boolean }) {
  const { t } = useTranslation();
  const decide = useAction('ads.ask.decide', { success: (r) => (r.status === 'applied' ? t('adsask.doneToast') : t('adsask.noToast')) });
  return (
    <li className="pa-ask-turn">
      <p className="pa-ask-q" dir="auto">
        {a.question}
      </p>
      <div className="pa-ask-a">
        <span className="pa-ask-who">
          <Icon name="sparkles" /> {t('adsask.ai')}
          <small className="muted"> · {t('pilotads.ago', { d: since(a.at) })}</small>
        </span>
        <p dir="auto">{a.answer}</p>
        {!!a.reads.length && (
          <span className="pa-ask-reads">
            <small className="muted">{t('adsask.read')}</small>
            {a.reads.slice(0, 6).map((r, k) => (
              <code key={k} className={r.ok ? '' : 'bad'} title={r.ok ? undefined : t('adsask.readFail')}>
                {r.tool}
              </code>
            ))}
          </span>
        )}
        {a.pending && (
          <div className={`pa-ask-change st-${a.status}`}>
            <span className="pa-ask-change-l">
              <Icon name={a.pending.op === 'pause' ? 'pause' : a.pending.op === 'budget' ? 'coins' : a.pending.op === 'resume' ? 'play' : 'zap'} /> {t('adsask.proposes')}
            </span>
            <b dir="auto">{a.pending.label}</b>
            {a.status === 'waiting_yes' ? (
              <>
                <small className="muted">{t('adsask.waiting')}</small>
                {owner && (
                  <span className="pa-ask-yes">
                    <button type="button" className="btn primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, yes: true })}>
                      <Icon name="check" /> {t('adsask.yes')}
                    </button>
                    <button type="button" className="btn" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, yes: false })}>
                      {t('adsask.no')}
                    </button>
                  </span>
                )}
              </>
            ) : (
              <small className={a.status === 'applied' ? 'ok' : a.status === 'failed' ? 'bad' : 'muted'}>
                {a.status === 'applied' ? t('adsask.applied', { name: a.decidedBy ?? '' }) : a.status === 'failed' ? t('adsask.failed', { msg: a.error ?? '' }) : t('adsask.refused')}
              </small>
            )}
            <details className="pa-ask-details">
              <summary>{t('adsask.details')}</summary>
              <code className="ltr">
                {a.pending.tool} {JSON.stringify(a.pending.input)}
              </code>
            </details>
          </div>
        )}
      </div>
    </li>
  );
}
