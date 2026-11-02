// Pilot AI › Test & lessons (control room). Two chats side by side (one at a time on a phone):
//  - Test Dellal: write like a customer of the shop you pick; Dellal answers with that shop's products and prices and the
//    lesson book you pick (in service, in test, the next one, none). Your own test chat in that shop: never sent, never
//    counted, paid by Pilotix (never billed to the shop).
//  - Teach a lesson: say in your own words what Dellal should do; Pilot AI writes it as a short lesson and checks the rules,
//    you read it and add it. It waits in the next book, which is tested on a share of new chats like any book.
// Under them, the next book: the lessons waiting for it, and « Publish ».
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, dateOnly, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Card, Icon, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Bubbles, Composer, Msg, Typing } from '../messages/chat';
import { PilotDemo, usePilotAction, usePilotCall } from './pilotDemo';

type State = POut<'p.pilot.state'>;
type Book = 'live' | 'test' | 'next' | 'none';
type Lesson = NonNullable<POut<'p.pilot.teach'>['lesson']>;
type Line = { id: number; from: 'coach' | 'pilot'; text: string; lesson?: Lesson | null; added?: number; at: string };

/** light per-viewer memory (the shop picked, the lessons chat of this tab); never needed, never shared */
const keep = {
  get(k: string, session = false): string | null {
    try {
      return (session ? sessionStorage : localStorage).getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string, session = false) {
    try {
      (session ? sessionStorage : localStorage).setItem(k, v);
    } catch {
      /* private mode: forgotten, that is all */
    }
  },
};
const SHOP_KEY = 'px.pilot.lab.shop';
const CHAT_KEY = 'px.pilot.lab.teach';
const still = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** the meaning only repeats the lesson (the page is in English) */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function LabTab({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  // a phone shows one chat at a time; a computer both
  const [pane, setPane] = useState<'try' | 'teach'>('try');
  const [book, setBook] = useState<Book>('live');
  const tryBox = useRef<HTMLDivElement>(null);
  // « Try it »: the lesson just added is in the next book; the test chat switches to it
  const tryNext = () => {
    setBook('next');
    setPane('try');
    requestAnimationFrame(() => tryBox.current?.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' }));
  };
  return (
    <>
      <div className="pl-lab-switch">
        <Tabs
          value={pane}
          onChange={setPane}
          items={[
            { value: 'try', label: t('platform.pilot.lab.try.title') },
            { value: 'teach', label: t('platform.pilot.lab.teach.title') },
          ]}
        />
      </div>
      <div className="pl-lab" data-pane={pane}>
        <div ref={tryBox} className="pl-lab-pane pl-lab-try">
          <TryCard d={d} book={book} onBook={setBook} />
        </div>
        <div className="pl-lab-pane pl-lab-teach">
          <TeachCard d={d} onTry={tryNext} />
        </div>
      </div>
      <NextCard d={d} manager={manager} />
    </>
  );
}

// ---------------------------------------------------------------- Test Dellal
function TryCard({ d, book, onBook }: { d: State; book: Book; onBook: (b: Book) => void }) {
  const { t } = useTranslation();
  const call = usePilotCall();
  const shops = d.shops;
  const [shopId, setShopId] = useState<number | null>(() => {
    const s = Number(keep.get(SHOP_KEY));
    return shops.some((x) => x.id === s) ? s : shops[0]?.id ?? null;
  });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const quick = t('messages.tester.quick', { returnObjects: true }) as string[];

  const champion = d.books.books.find((b) => b.status === 'champion') ?? null;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const options: { value: Book; label: string }[] = [
    { value: 'live', label: champion ? t('platform.pilot.lab.try.live', { v: champion.version }) : t('platform.pilot.lab.try.liveNone') },
    ...(testing ? [{ value: 'test' as const, label: t('platform.pilot.lab.try.test', { v: testing.version }) }] : []),
    ...(d.next.changed ? [{ value: 'next' as const, label: t('platform.pilot.lab.try.next', { v: d.next.version }) }] : []),
    ...(champion ? [{ value: 'none' as const, label: t('platform.pilot.lab.try.none') }] : []),
  ];
  const have = options.map((o) => o.value).join();
  // a choice that is gone (the test ended, the next book was published): back to the book in service
  useEffect(() => {
    if (!have.split(',').includes(book)) onBook('live');
  }, [have, book]); // eslint-disable-line react-hooks/exhaustive-deps

  // the chat of this shop (a call with no message only reads it)
  useEffect(() => {
    if (!shopId) return;
    let live = true;
    setLoading(true);
    setErr(null);
    call('p.pilot.try', { shopId, book: 'live' })
      .then((r) => live && setMsgs(r.messages as Msg[]))
      .catch((e: Error) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [shopId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (text = body) => {
    const v = text.trim();
    if (!v || busy || !shopId) return;
    setBusy(true);
    setPending(v);
    setBody('');
    setErr(null);
    try {
      const r = await call('p.pilot.try', { shopId, book, body: v });
      setMsgs(r.messages as Msg[]);
    } catch (e: any) {
      setBody(v); // the message comes back to the box, to send again
      setErr(e?.message || t('platform.pilot.lab.try.failed'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };
  const reset = async () => {
    if (!shopId || busy) return;
    setBusy(true);
    try {
      const r = await call('p.pilot.try', { shopId, book, reset: true });
      setMsgs(r.messages as Msg[]);
      setErr(null);
    } catch (e: any) {
      toast(e?.message || t('platform.pilot.lab.try.failed'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  /** under each answer: the book it used and the model (Haiku for simple messages, Sonnet for the hard moments) */
  const foot = (m: Msg) => {
    if (m.role !== 'agent' || !m.meta?.pilot) return null;
    const p = m.meta.pilot as { version: number; lab?: Book };
    const k = 'platform.pilot.lab.try.used.';
    const used = p.lab === 'none' ? t(k + 'none') : p.lab === 'test' ? t(k + 'test', { v: p.version }) : p.lab === 'next' ? t(k + 'next', { v: p.version }) : p.version ? t(k + 'live', { v: p.version }) : t(k + 'base');
    const model = /sonnet/i.test(String(m.meta.model)) ? 'Sonnet' : /haiku/i.test(String(m.meta.model)) ? 'Haiku' : null;
    return (
      <small className="pl-used">
        {used}
        {model && <> · {model}</>}
      </small>
    );
  };

  return (
    <Card title={t('platform.pilot.lab.try.title')} help={t('platform.pilot.lab.try.help')} className="pl-lab-card">
      {!shops.length ? (
        <p className="muted">{t('platform.pilot.lab.try.noShop')}</p>
      ) : (
        <>
          <div className="pl-lab-ctl">
            <label className="pl-lab-field">
              <span>{t('platform.pilot.lab.try.shop')}</span>
              <select
                value={shopId ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setShopId(v);
                  keep.set(SHOP_KEY, String(v));
                }}
              >
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="pl-lab-field pl-lab-book" role="group" aria-label={t('platform.pilot.lab.try.book')}>
              <span>{t('platform.pilot.lab.try.book')}</span>
              <Tabs value={book} onChange={onBook} items={options} />
            </div>
          </div>
          <div className="ai-phone pl-lab-chat">
            <div className="ai-phone-h">
              <span className="ai-face on" aria-hidden="true">
                <Icon name="chat" />
                <i />
              </span>
              <b>Dellal</b>
              <span className="ai-tag">{t('platform.pilot.lab.try.tag')}</span>
              <button type="button" className="btn small ghost" title={t('platform.pilot.lab.try.reset')} aria-label={t('platform.pilot.lab.try.reset')} disabled={busy || !msgs.length} onClick={reset}>
                <Icon name="refresh" />
                <span className="ai-hide-s">{t('platform.pilot.lab.try.reset')}</span>
              </button>
            </div>
            {loading ? (
              <div className="ai-msgs">
                <span className="ai-note-m">{t('platform.pilot.lab.try.loading')}</span>
              </div>
            ) : (
              <Bubbles messages={msgs} name="Dellal" pending={pending} foot={foot} empty={t('platform.pilot.lab.try.empty')} />
            )}
            {err && (
              <p className="pl-lab-err" role="alert">
                <Icon name="alert" /> {err}
              </p>
            )}
            <Composer value={body} onChange={setBody} onSend={() => send()} placeholder={t('platform.pilot.lab.try.write')} busy={busy || loading}>
              <div className="ai-quick">
                {quick.map((x) => (
                  <button key={x} type="button" dir="auto" disabled={busy || loading} onClick={() => send(x)}>
                    {x}
                  </button>
                ))}
              </div>
            </Composer>
          </div>
          <p className="small muted pl-lab-note">{t('platform.pilot.lab.try.note')}</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Teach a lesson
function TeachCard({ d, onTry }: { d: State; onTry: () => void }) {
  const { t, i18n } = useTranslation();
  const call = usePilotCall();
  const demo = useContext(PilotDemo);
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>(() => {
    try {
      const v = JSON.parse(keep.get(CHAT_KEY, true) || '[]');
      return Array.isArray(v) ? (v as Line[]).slice(-40) : [];
    } catch {
      return [];
    }
  });
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const examples = t('platform.pilot.lab.teach.examples', { returnObjects: true }) as string[];
  const lang = (['fr', 'en', 'ar'].includes(i18n.language) ? i18n.language : 'fr') as 'fr' | 'en' | 'ar';
  useEffect(() => keep.set(CHAT_KEY, JSON.stringify(lines.slice(-40)), true), [lines]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines.length, busy]);

  const send = async (text = body) => {
    const v = text.trim();
    if (!v || busy) return;
    const mine: Line = { id: Date.now(), from: 'coach', text: v, at: new Date().toISOString() };
    const next = [...lines, mine];
    setLines(next);
    setBody('');
    setBusy(true);
    setErr(null);
    try {
      // Pilot AI reads the whole chat: its own earlier lessons travel with its answers
      const r = await call('p.pilot.teach', {
        lang,
        messages: next.slice(-24).map((l) => ({ from: l.from, text: (l.from === 'pilot' && l.lesson ? `${l.text}\n[lesson ${l.lesson.topic}] ${l.lesson.text}` : l.text).slice(0, 2000) })),
      });
      setLines((cur) => [...cur, { id: Date.now() + 1, from: 'pilot', text: r.reply, lesson: r.lesson, at: new Date().toISOString() }]);
    } catch (e: any) {
      setLines((cur) => cur.filter((l) => l.id !== mine.id));
      setBody(v);
      setErr(e?.message || t('platform.pilot.lab.teach.failed'));
    } finally {
      setBusy(false);
    }
  };
  const add = async (line: Line) => {
    const l = line.lesson;
    if (!l || adding !== null) return;
    setAdding(line.id);
    try {
      const r = await call('p.pilot.addLesson', { topic: l.topic, text: l.text, ...(l.meaning ? { meaning: l.meaning } : {}) });
      setLines((cur) => cur.map((x) => (x.id === line.id ? { ...x, added: Number(r.id) } : x)));
      if (!demo) await qc.invalidateQueries({ queryKey: ['p', 'p.pilot.state'] });
      toast(t('platform.pilot.lab.teach.addedToast'), 'ok');
    } catch (e: any) {
      toast(e?.message || t('platform.pilot.lab.teach.failed'), 'bad');
    } finally {
      setAdding(null);
    }
  };

  return (
    <Card title={t('platform.pilot.lab.teach.title')} help={t('platform.pilot.lab.teach.help')} className="pl-lab-card">
      <div className="ai-phone pl-lab-chat">
        <div className="ai-phone-h">
          <span className="ai-face on" aria-hidden="true">
            <Icon name="sparkles" />
            <i />
          </span>
          <b>Pilot AI</b>
          <span className="ai-tag">{t('platform.pilot.lab.teach.coach')}</span>
          <button type="button" className="btn small ghost" title={t('platform.pilot.lab.teach.clear')} aria-label={t('platform.pilot.lab.teach.clear')} disabled={busy || !lines.length} onClick={() => (setLines([]), setErr(null))}>
            <Icon name="refresh" />
            <span className="ai-hide-s">{t('platform.pilot.lab.teach.clear')}</span>
          </button>
        </div>
        <div className="ai-msgs" ref={box} aria-live="polite">
          <div className="ai-msg in bot first">
            <span className="ai-who">
              <Icon name="sparkles" />
              Pilot AI
            </span>
            <div className="ai-bub">
              <span className="ai-txt">{t('platform.pilot.lab.teach.hello')}</span>
            </div>
          </div>
          {lines.map((l) =>
            l.from === 'coach' ? (
              <div key={l.id} className="ai-msg out team first">
                <div className="ai-bub">
                  <span className="ai-txt" dir="auto">
                    {l.text}
                  </span>
                  <time dateTime={l.at}>{clock(l.at)}</time>
                </div>
              </div>
            ) : (
              <div key={l.id} className={`ai-msg in bot first ${l.lesson ? 'pl-prop-msg' : ''}`}>
                <span className="ai-who">
                  <Icon name="sparkles" />
                  Pilot AI
                </span>
                <div className="ai-bub">
                  {l.text && (
                    <span className="ai-txt" dir="auto">
                      {l.text}
                    </span>
                  )}
                  {l.lesson && <Proposal line={l} version={d.next.version} adding={adding === l.id} onAdd={() => add(l)} onTry={onTry} />}
                  <time dateTime={l.at}>{clock(l.at)}</time>
                </div>
              </div>
            ),
          )}
          {busy && <Typing name="Pilot AI" />}
        </div>
        {err && (
          <p className="pl-lab-err" role="alert">
            <Icon name="alert" /> {err}
          </p>
        )}
        <Composer value={body} onChange={setBody} onSend={() => send()} placeholder={t('platform.pilot.lab.teach.write')} busy={busy}>
          {!lines.length && (
            <div className="ai-quick">
              {examples.map((x) => (
                <button key={x} type="button" dir="auto" disabled={busy} onClick={() => send(x)}>
                  {x}
                </button>
              ))}
            </div>
          )}
        </Composer>
      </div>
    </Card>
  );
}

/** The lesson Pilot AI proposes, inside its message: the topic, the lesson as the book will say it, what it means, the check. */
function Proposal({ line, version, adding, onAdd, onTry }: { line: Line; version: number; adding: boolean; onAdd: () => void; onTry: () => void }) {
  const { t } = useTranslation();
  const l = line.lesson!;
  const k = 'platform.pilot.lab.teach.';
  const clean = l.ok && !l.twin;
  return (
    <div className="pl-prop">
      <div className="pl-prop-h">
        <span className="chip">{t(`platform.pilot.topic.${l.topic}`, { defaultValue: l.topic })}</span>
        {clean && (
          <span className="pl-prop-ok">
            <Icon name="checkcircle" /> {t(k + 'ok')}
          </span>
        )}
      </div>
      <p className="pl-prop-text" lang="en" dir="ltr">
        {l.text}
      </p>
      {l.meaning && !same(l.meaning, l.text) && (
        <p className="pl-prop-mean" dir="auto">
          {l.meaning}
        </p>
      )}
      {!l.ok && (
        <p className="pl-prop-no">
          <b>{t(k + 'bad')}</b> {l.problems.map((p) => t(`platform.pilot.lab.lint.${p}`, { defaultValue: p })).join(' · ')}
        </p>
      )}
      {l.twin && (
        <p className="pl-prop-no">
          <b>{t(k + 'twin')}</b>{' '}
          <span lang="en" dir="ltr">
            « {l.twin.text} »
          </span>
        </p>
      )}
      <div className="pl-prop-do">
        {line.added ? (
          <>
            <span className="pl-prop-ok">
              <Icon name="checkcircle" /> {t(k + 'added', { v: version })}
            </span>
            <button type="button" className="linkbtn" onClick={onTry}>
              {t(k + 'tryIt')}
            </button>
          </>
        ) : (
          clean && (
            <button type="button" className="btn primary small" disabled={adding} onClick={onAdd}>
              {t(k + 'add')}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the next book
function NextCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const remove = usePilotAction('p.pilot.lesson', { success: t('platform.saved') });
  const publish = usePilotAction('p.pilot.publish', { success: t('platform.pilot.published') });
  const nb = d.next;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const k = 'platform.pilot.lab.next.';
  return (
    <Card title={t(k + 'title', { v: nb.version })} badge={nb.fresh.length ? <span className="chip">{n(nb.fresh.length)}</span> : undefined} help={t(k + 'help')}>
      {!nb.fresh.length ? (
        <p className="pl-next-empty">{t(k + 'empty')}</p>
      ) : (
        <ul className="pl-next">
          {nb.fresh.map((l) => (
            <li key={l.id}>
              <div className="pl-next-txt">
                <span className="chip">{t(`platform.pilot.topic.${l.topic}`, { defaultValue: l.topic })}</span>
                <p lang="en" dir="ltr">
                  {l.text}
                </p>
                {l.meaning && !same(l.meaning, l.text) && (
                  <p className="pl-next-mean" dir="auto">
                    {l.meaning}
                  </p>
                )}
                <small>
                  {t(l.source === 'coach' ? k + 'wrote' : k + 'found', { by: l.by ?? '—', date: dateOnly(l.at) })}
                  {!l.fits && (
                    <>
                      {' '}
                      · <span className="pl-next-room">{t(k + 'noRoom')}</span>
                    </>
                  )}
                </small>
              </div>
              <button type="button" className="btn small ghost" disabled={remove.isPending} onClick={() => remove.mutate({ id: l.id, action: 'reject' })}>
                {t(k + 'remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pl-next-foot">
        {testing ? (
          <p className="small muted">{t(k + 'testRunning', { v: testing.version })}</p>
        ) : manager ? (
          <>
            <button type="button" className="btn primary" disabled={!nb.changed || publish.isPending} onClick={() => publish.mutate({})}>
              {t(k + 'publish', { v: nb.version })}
            </button>
            <span className="small muted">{t(k + 'publishNote', { share: Math.round(d.config.share * 100) })}</span>
          </>
        ) : (
          <p className="small muted">{t(k + 'managers')}</p>
        )}
      </div>
    </Card>
  );
}
