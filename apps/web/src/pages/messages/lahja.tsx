// Darija (lahja) lessons in a shop. « Leçon de darija » under one of Dellal's messages, or under one of the CM AI agent's
// replies to a comment: write how it should have said it (what was sent never changes); the words you change become a
// lesson that Dellal and the CM AI agent use at once in this shop, and that Pilotix checks for every shop. Messages › Réglages lists them, with what Dellal learned from the shop's
// customers and Pilotix's lessons for every shop. The words are drawn the same way in the control room.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { Msg } from './chat';

export type LahjaWord = { use: string; not?: string };

/** « wakha » → « saha », never « habibi », + « khouya »: what a lesson changes, as Dellal will apply it */
export function LahjaWords({ words, className = '' }: { words: LahjaWord[]; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`lj-words ${className}`}>
      {words.map((w, i) => (
        <span key={i} className="lj-w" dir="auto">
          {w.not && <s>{w.not}</s>}
          {w.not && w.use && (
            <span className="lj-arrow" aria-label={t('messages.lahja.instead')}>
              →
            </span>
          )}
          {w.use ? <b>{w.use}</b> : <em>{t('messages.lahja.never')}</em>}
        </span>
      ))}
    </span>
  );
}

type Saved = { words: LahjaWord[]; review: string };

/**
 * The editor under one of the agents' messages (Dellal's message, or the CM AI agent's reply to a comment): write it the
 * right way; the changed words become a lesson. What was sent never changes.
 */
function FixBox({ sent, help, busy, done, onSave }: { sent: string; help: string; busy: boolean; done: Saved | null; onSave: (after: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(sent);
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight + 3)}px`;
  }, [text, open]);
  // the editor opens at the bottom of the chat: bring its buttons into view
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [open]);
  if (done)
    return (
      <div className="lj-done">
        <Icon name="checkcircle" />
        <span>
          <LahjaWords words={done.words} /> <small>{t(done.review === 'waiting' ? 'messages.lahja.doneWaiting' : 'messages.lahja.doneLocal')}</small>
        </span>
      </div>
    );
  if (!open)
    return (
      <button type="button" className="lj-open" onClick={() => (setText(sent), setOpen(true))}>
        <Icon name="languages" /> {t('messages.lahja.fix')}
      </button>
    );
  return (
    <div ref={box} className="lj-edit">
      <p>{help}</p>
      <textarea
        ref={area}
        dir="auto"
        rows={3}
        maxLength={2000}
        value={text}
        aria-label={t('messages.lahja.fix')}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
      <div className="lj-edit-do">
        <button type="button" className="btn primary small" disabled={busy || !text.trim() || text.trim() === sent.trim()} onClick={() => onSave(text.trim())}>
          {t('messages.lahja.save')}
        </button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => setOpen(false)}>
          {t('messages.lahja.cancel')}
        </button>
      </div>
    </div>
  );
}

const savedToast = (t: (k: string) => string, r: Saved) => toast(t(r.review === 'waiting' ? 'messages.lahja.addedPilotix' : 'messages.lahja.added'), 'ok');

/** Under one of Dellal's messages: write it the right way, the changed words become a lesson. */
export function LahjaFix({ m, name = 'Dellal' }: { m: Msg; name?: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Saved | null>(null);
  const add = useAction('dellal.lahja.add', { onDone: (r) => (setDone(r), savedToast(t, r)) });
  // the product photos Dellal sent are not words to fix
  if (m.role !== 'agent' || m.meta?.demo || Array.isArray(m.meta?.photos)) return null;
  return <FixBox sent={m.body} help={t('messages.lahja.fixHelp', { name })} busy={add.isPending} done={done} onSave={(after) => add.mutate({ messageId: m.id, after })} />;
}

/** Under one of the CM AI agent's replies to a comment (public or private): the same lesson, the reply never changes. */
export function CmLahjaFix({ id, which, sent }: { id: number; which: 'public' | 'private'; sent: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Saved | null>(null);
  const add = useAction('cm.lahja.add', { onDone: (r) => (setDone(r), savedToast(t, r)) });
  return <FixBox sent={sent} help={t('cm.lahja.fixHelp')} busy={add.isPending} done={done} onSave={(after) => add.mutate({ id, which, after })} />;
}

/** CM AI agent › Tester: the same lesson from what the agent would answer to a test comment. */
export function CmTestLahjaFix({ testId, which, sent }: { testId: number; which: 'public' | 'private'; sent: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Saved | null>(null);
  const add = useAction('cm.lahja.test', { onDone: (r) => (setDone(r), savedToast(t, r)) });
  return <FixBox sent={sent} help={t('cm.lahja.fixHelp')} busy={add.isPending} done={done} onSave={(after) => add.mutate({ testId, which, after })} />;
}

/** Messages › Réglages: this shop's Darija lessons, what Dellal learned from its customers, Pilotix's for every shop. */
export function LahjaCard({ name }: { name: string }) {
  const { t } = useTranslation();
  const q = useRpc('dellal.lahja.list', {});
  const remove = useAction('dellal.lahja.remove', { success: t('messages.lahja.removed') });
  const [all, setAll] = useState(false);
  const k = 'messages.lahja.';
  const d = q.data;
  return (
    <Card title={t(k + 'title')} help={t(k + 'help', { name })}>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="lj-card">
          <section>
            <h3>{t(k + 'own')}</h3>
            {!d.own.length ? (
              <p className="lj-empty">{t(k + 'empty', { name })}</p>
            ) : (
              <ul className="lj-list">
                {d.own.map((l) => (
                  <li key={l.id}>
                    <div>
                      <LahjaWords words={l.words} />
                      <small>
                        <bdi>{l.by ?? '—'}</bdi> · <bdi>{dateOnly(l.at)}</bdi>
                        {l.via === 'cm' && <> · {t(k + 'fromComment')}</>} · <span className={`lj-st lj-st-${l.review}`}>{t(`${k}review.${l.review}`, { defaultValue: l.review })}</span>
                      </small>
                    </div>
                    <button type="button" className="btn ghost small" disabled={remove.isPending} onClick={() => remove.mutate({ id: l.id })}>
                      {t(k + 'remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {d.platform && (
            <section>
              <h3>{t(k + 'learned', { name })}</h3>
              {!d.learned.length ? (
                <p className="lj-empty">{t(k + 'learnedEmpty', { name })}</p>
              ) : (
                <>
                  <p className="muted small">{t(k + 'learnedNote', { name })}</p>
                  <ul className="lj-list">
                    {d.learned.map((l) => (
                      <li key={l.id}>
                        <div>
                          <LahjaWords words={l.words} />
                          <small>
                            {l.customers ? t(k + 'customers', { count: l.customers, n: n(l.customers) }) : ''}
                            {l.note ? `${l.customers ? ' · ' : ''}${l.note}` : ''}
                          </small>
                        </div>
                        <button type="button" className="btn ghost small" disabled={remove.isPending} onClick={() => remove.mutate({ id: l.id, learned: true })}>
                          {t(k + 'remove')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          {d.platform && (
            <section>
              <h3>
                {t(k + 'all')} <span className="chip">{n(d.all.length)}</span>
              </h3>
              {!d.all.length ? (
                <p className="lj-empty">{t(k + 'allEmpty')}</p>
              ) : (
                <>
                  <p className="lj-all">
                    {(all ? d.all : d.all.slice(0, 12)).map((l) => (
                      <LahjaWords key={l.id} words={l.words} className={l.mine ? 'lj-mine' : ''} />
                    ))}
                  </p>
                  {d.all.length > 12 && (
                    <button type="button" className="linkbtn" onClick={() => setAll((v) => !v)}>
                      {all ? t(k + 'less') : t(k + 'more', { n: n(d.all.length) })}
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </Card>
  );
}
