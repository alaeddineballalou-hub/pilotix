// Pilot AI › Test & lessons (control room). Two chats side by side (one at a time on a phone):
//  - Test Dellal: write like a customer of the shop you pick; Dellal answers with that shop's products and prices and the
//    lesson book you pick (in service, in test, the next one, none). Your own test chat in that shop: never sent, never
//    counted, paid by Pilotix (never billed to the shop).
//  - Lessons, two kinds in two tabs:
//    · Sales (how Dellal sells, written here only): say it in your own words; Pilot AI writes it as a short lesson and checks
//      the rules, you read it and add it. It waits in the next book, tested on a share of new chats like any book.
//    · Darija (how Dellal speaks): the shops' lessons (their team's corrections, what Dellal learned from their customers),
//      used at once in their own shop, wait here: accept (as is or modified), every shop uses it; refuse, the others never
//      see it. Pilotix's own: « Darija lesson » under an answer of the test chat, or words typed here: every shop at once.
// Under them, the next book: the sales lessons waiting for it, and « Publish ».
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, dateOnly, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Card, Icon, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Bubbles, Composer, Msg, Typing } from '../messages/chat';
import { LahjaWord, LahjaWords } from '../messages/lahja';
import { CaseModal } from './pilotCase';
import { DarijaBookCard } from './DarijaBook';
import { PilotDemo, usePilotAction, usePilotCall, usePilotRpc } from './pilotDemo';

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
            { value: 'teach', label: t('platform.pilot.lab.lessons.title'), ...(d.lahjaWaiting ? { count: d.lahjaWaiting } : {}) },
          ]}
        />
      </div>
      <div className="pl-lab" data-pane={pane}>
        <div ref={tryBox} className="pl-lab-pane pl-lab-try">
          <TryCard d={d} book={book} onBook={setBook} />
        </div>
        <div className="pl-lab-pane pl-lab-teach">
          <LessonsCard d={d} onTry={tryNext} manager={manager} />
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
      <>
        <small className="pl-used">
          {used}
          {model && <> · {model}</>}
        </small>
        <CoachFix m={m} />
      </>
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

// ---------------------------------------------------------------- Lessons: Sales | Darija
function LessonsCard({ d, onTry, manager }: { d: State; onTry: () => void; manager: boolean }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'sales' | 'darija'>('sales');
  const k = 'platform.pilot.lab.lessons.';
  return (
    <Card title={t(k + 'title')} help={t(k + 'help')} className="pl-lab-card">
      <div className="pl-lab-kind">
        <Tabs
          value={kind}
          onChange={setKind}
          items={[
            { value: 'sales', label: t(k + 'sales') },
            { value: 'darija', label: t(k + 'darija'), ...(d.lahjaWaiting ? { count: d.lahjaWaiting } : {}) },
          ]}
        />
      </div>
      {kind === 'sales' ? <TeachChat d={d} onTry={onTry} /> : <DarijaPane manager={manager} />}
    </Card>
  );
}

// ---------------------------------------------------------------- Sales: teach a lesson in your own words
function TeachChat({ d, onTry }: { d: State; onTry: () => void }) {
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
    <>
      <p className="small muted pl-lab-kind-note">{t('platform.pilot.lab.teach.help')}</p>
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
    </>
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

// ---------------------------------------------------------------- Darija: the review queue, the lessons for every shop
type LahjaItem = POut<'p.lahja.state'>['waiting'][number];
const blank = (): LahjaWord => ({ use: '', not: '' });
/** the rows a person edits, cleaned for the server (an empty « write » with a word to drop = never write it) */
const tidy = (rows: LahjaWord[]): LahjaWord[] =>
  rows.map((r) => ({ use: r.use.trim(), ...(r.not?.trim() ? { not: r.not.trim() } : {}) })).filter((r) => r.use || r.not);

function DarijaPane({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.lahja.state', {});
  const k = 'platform.pilot.lab.darija.';
  const d = q.data;
  // tick boxes: several lessons accepted or refused at once; one that fails stays ticked, with the reason in its row
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [errs, setErrs] = useState<Map<number, string>>(() => new Map());
  const [chat, setChat] = useState<[number, number] | null>(null);
  const doing = useRef<'approve' | 'refuse'>('approve');
  const many = usePilotAction('p.lahja.decideMany', {
    onDone: (r) => {
      if (r.done.length) toast(t(k + (doing.current === 'approve' ? 'acceptedMany' : 'refusedMany'), { count: r.done.length, n: n(r.done.length) }), 'ok');
      if (r.failed.length) toast(t(k + 'failedMany', { count: r.failed.length, n: n(r.failed.length) }), 'bad');
      setErrs(new Map(r.failed.map((f) => [f.id, f.error])));
      setSel(new Set(r.failed.map((f) => f.id)));
    },
  });
  const waiting = d?.waiting ?? [];
  const picked = waiting.filter((l) => sel.has(l.id)).map((l) => l.id);
  const all = waiting.length > 0 && picked.length === waiting.length;
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = picked.length > 0 && !all;
  }, [picked.length, all]);
  const pick = (id: number, on: boolean) =>
    setSel((x) => {
      const y = new Set(x);
      if (on) y.add(id);
      else y.delete(id);
      return y;
    });
  const decide = (action: 'approve' | 'refuse') => {
    doing.current = action;
    many.mutate({ ids: picked, action });
  };
  return (
    <div className="pl-dj">
      <DarijaBookCard manager={manager} />
      <p className="small muted pl-lab-kind-note">{t(k + 'help')}</p>
      {q.isLoading ? (
        <p className="muted">{t('platform.pilot.lab.try.loading')}</p>
      ) : q.error || !d ? (
        <p className="pl-lab-err" role="alert">
          <Icon name="alert" /> {q.error?.message}
        </p>
      ) : (
        <>
          <section>
            <h3>
              {t(k + 'waiting')} {d.waiting.length > 0 && <span className="chip pp-chip-warn">{n(d.waiting.length)}</span>}
            </h3>
            {!d.waiting.length ? (
              <p className="pl-next-empty">{t(k + 'waitingEmpty')}</p>
            ) : (
              <>
                {d.waiting.length > 1 && (
                  <label className="pl-dj-all">
                    <input ref={allBox} type="checkbox" checked={all} onChange={(e) => setSel(e.target.checked ? new Set(waiting.map((l) => l.id)) : new Set())} />
                    <span>{t(k + 'pickAll', { n: n(d.waiting.length) })}</span>
                  </label>
                )}
                <ul className="pl-dj-list">
                  {d.waiting.map((l) => (
                    <WaitingRow key={l.id} l={l} picked={d.waiting.length > 1 ? sel.has(l.id) : null} onPick={(on) => pick(l.id, on)} err={errs.get(l.id) ?? null} onChat={(conv) => l.shopId && setChat([l.shopId, conv])} />
                  ))}
                </ul>
                {picked.length > 0 && (
                  <div className="pl-dj-bar" role="group" aria-label={t(k + 'picked', { count: picked.length, n: n(picked.length) })}>
                    <span className="pl-dj-bar-l">
                      <b>{t(k + 'picked', { count: picked.length, n: n(picked.length) })}</b>
                      <button type="button" className="linkbtn" disabled={many.isPending} onClick={() => setSel(new Set())}>
                        {t(k + 'unpick')}
                      </button>
                    </span>
                    <button type="button" className="btn primary small" disabled={many.isPending} onClick={() => decide('approve')}>
                      {t(k + 'accept')}
                    </button>
                    <button type="button" className="btn ghost small" disabled={many.isPending} onClick={() => decide('refuse')}>
                      {t(k + 'refuse')}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
          <AddWords />
          <section>
            <h3>
              {t(k + 'approved')} <span className="chip">{n(d.approved.length)}</span>
            </h3>
            {!d.approved.length ? (
              <p className="pl-next-empty">{t(k + 'approvedEmpty')}</p>
            ) : (
              <ul className="pl-dj-list pl-dj-done">
                {d.approved.map((l) => (
                  <ApprovedRow key={l.id} l={l} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {chat && <CaseModal shopId={chat[0]} convId={chat[1]} onClose={() => setChat(null)} />}
    </div>
  );
}

/** Where a lesson comes from: a shop's team, Dellal (from a shop's customers), Pilotix; each part keeps its own direction */
function From({ l }: { l: LahjaItem }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const customers = Number(l.evidence?.customers) || 0;
  const parts = [
    ...(l.source === 'coach' ? ['Pilotix', l.by ?? '—'] : l.source === 'dellal' ? [l.shop ?? '—', t(k + 'fromDellal')] : [l.shop ?? '—', l.by ?? '—']),
    dateOnly(l.decidedAt ?? l.at),
    ...(customers > 0 ? [t(k + 'customers', { count: customers, n: n(customers) })] : []),
  ];
  return (
    <small className="pl-dj-from">
      {parts.map((x, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <bdi>{x}</bdi>
        </Fragment>
      ))}
    </small>
  );
}

function WaitingRow({ l, picked, onPick, err, onChat }: { l: LahjaItem; picked: boolean | null; onPick: (on: boolean) => void; err: string | null; onChat: (conv: number) => void }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const decide = usePilotAction('p.lahja.decide', { success: (r) => t(r.words ? k + 'acceptedToast' : k + 'refusedToast') });
  const [edit, setEdit] = useState<LahjaWord[] | null>(null);
  const busy = decide.isPending;
  return (
    <li className={picked ? 'pl-dj-on' : undefined}>
      <div className="pl-dj-head">
        {picked !== null && <input type="checkbox" className="pl-dj-check" checked={picked} aria-label={t(k + 'pickOne')} onChange={(e) => onPick(e.target.checked)} />}
        <span className={`chip pl-dj-src pl-dj-${l.source}`}>{t(`${k}src.${l.source}`)}</span>
        {l.via === 'cm' && <span className="chip pl-dj-via">{t(k + 'viaCm')}</span>}
        <From l={l} />
      </div>
      {(l.before || l.after) && (
        <dl className="pl-dj-pair">
          <dt>{t(k + (l.via === 'cm' ? 'beforeCm' : 'before'))}</dt>
          <dd dir="auto">{l.before}</dd>
          <dt>{t(k + 'after')}</dt>
          <dd dir="auto">{l.after}</dd>
        </dl>
      )}
      {edit ? (
        <WordsEditor rows={edit} onRows={setEdit} />
      ) : (
        <LahjaWords words={l.words} />
      )}
      {l.note && <p className="pl-dj-note" dir="auto">{l.note}</p>}
      {l.source === 'dellal' && <Proof l={l} onChat={onChat} />}
      {err && (
        <p className="pl-dj-err" role="alert">
          <Icon name="alert" /> {err}
        </p>
      )}
      <div className="pl-dj-do">
        {edit ? (
          <>
            <button type="button" className="btn primary small" disabled={busy || !tidy(edit).length} onClick={() => decide.mutate({ id: l.id, action: 'approve', words: tidy(edit) })}>
              {t(k + 'saveAccept')}
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setEdit(null)}>
              {t(k + 'cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary small" disabled={busy} onClick={() => decide.mutate({ id: l.id, action: 'approve' })}>
              {t(k + 'accept')}
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => setEdit(l.words.map((w) => ({ use: w.use, not: w.not ?? '' })))}>
              <Icon name="pencil" /> {t(k + 'modify')}
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => decide.mutate({ id: l.id, action: 'refuse' })}>
              {t(k + 'refuse')}
            </button>
          </>
        )}
      </div>
      {l.source === 'dellal' && !edit && <p className="small muted pl-dj-note">{t(k + 'refusedNote')}</p>}
    </li>
  );
}

/** A line of a chat with each place the word is written marked (struck when it is the word to drop). */
function Marked({ line, word, gone = false }: { line: string; word: string; gone?: boolean }) {
  const esc = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (!esc) return <>{line}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(new RegExp(`(^|[^\\p{L}\\p{N}])(${esc})(?![\\p{L}\\p{N}])`, 'giu'))) {
    const at = (m.index ?? 0) + m[1].length;
    out.push(line.slice(last, at), <mark key={at} className={gone ? 'pl-dj-gone' : 'pl-dj-hit'}>{m[2]}</mark>);
    last = at + m[2].length;
  }
  out.push(line.slice(last));
  return <>{out}</>;
}

/** What proves a word Dellal learned: lines of its customers that have it, lines of Dellal that have the word to drop. */
function Proof({ l, onChat }: { l: LahjaItem; onChat: (conv: number) => void }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const w = l.words[0];
  const { c, d } = l.samples;
  if (!w || (!c.length && !d.length)) return null;
  const side = (title: string, lines: typeof c, word: string, gone: boolean, who: 'c' | 'd') => (
    <div className={`pl-dj-side pl-dj-${who}`}>
      <p className="pl-dj-side-h">{title}</p>
      <ul>
        {lines.map((x, i) => (
          <li key={i}>
            <q dir="auto">
              <Marked line={x.line} word={word} gone={gone} />
            </q>
            <button type="button" className="linkbtn" onClick={() => onChat(x.conv)}>
              {t(k + 'seeChat')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="pl-dj-proof">
      {c.length > 0 && side(t(k + 'proofCustomers', { shop: l.shop ?? '—' }), c, w.use, false, 'c')}
      {d.length > 0 && w.not && side(t(k + 'proofDellal'), d, w.not, true, 'd')}
      <p className="pl-dj-anon">{t('platform.pilot.anonymous')}</p>
    </div>
  );
}

function ApprovedRow({ l }: { l: LahjaItem }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const decide = usePilotAction('p.lahja.decide', { success: t(k + 'removedToast') });
  return (
    <li>
      <div>
        <LahjaWords words={l.words} />
        <From l={l} />
      </div>
      <button type="button" className="btn ghost small" disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, action: 'remove' })}>
        {t(k + 'remove')}
      </button>
    </li>
  );
}

/** Word rows: « don't write » and « write » (one of the two may stay empty) */
function WordsEditor({ rows, onRows }: { rows: LahjaWord[]; onRows: (r: LahjaWord[]) => void }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const put = (i: number, f: keyof LahjaWord, v: string) => onRows(rows.map((r, j) => (j === i ? { ...r, [f]: v } : r)));
  return (
    <div className="pl-dj-edit">
      {rows.map((r, i) => (
        <div key={i} className="pl-dj-row">
          <input dir="auto" maxLength={60} value={r.not ?? ''} placeholder={t(k + 'not')} aria-label={t(k + 'not')} onChange={(e) => put(i, 'not', e.target.value)} />
          <span className="lj-arrow" aria-hidden="true">
            →
          </span>
          <input dir="auto" maxLength={60} value={r.use} placeholder={t(k + 'use')} aria-label={t(k + 'use')} onChange={(e) => put(i, 'use', e.target.value)} />
          <button type="button" className="btn ghost small" aria-label={t(k + 'removeRow')} title={t(k + 'removeRow')} disabled={rows.length < 2} onClick={() => onRows(rows.filter((_, j) => j !== i))}>
            <Icon name="xcircle" />
          </button>
        </div>
      ))}
      {rows.length < 6 && (
        <button type="button" className="linkbtn" onClick={() => onRows([...rows, blank()])}>
          {t(k + 'addRow')}
        </button>
      )}
    </div>
  );
}

/** Pilotix's own words, for every shop at once */
function AddWords() {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const [rows, setRows] = useState<LahjaWord[]>([blank()]);
  const add = usePilotAction('p.lahja.add', { success: t(k + 'addedToast'), onDone: () => setRows([blank()]) });
  return (
    <section className="pl-dj-add">
      <h3>{t(k + 'addTitle')}</h3>
      <WordsEditor rows={rows} onRows={setRows} />
      <div className="pl-dj-do">
        <button type="button" className="btn small" disabled={add.isPending || !tidy(rows).length} onClick={() => add.mutate({ words: tidy(rows) })}>
          {t(k + 'add')}
        </button>
        <span className="small muted">{t(k + 'addHint')}</span>
      </div>
    </section>
  );
}

/** Under an answer of the control room's test chat: write it the right way, the changed words are every shop's at once. */
function CoachFix({ m }: { m: Msg }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.lab.darija.';
  const call = usePilotCall();
  const qc = useQueryClient();
  const demo = useContext(PilotDemo);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(m.body);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<LahjaWord[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // the editor opens at the bottom of the chat: bring its buttons into view
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' });
  }, [open]);
  if (done)
    return (
      <div className="lj-done">
        <Icon name="checkcircle" />
        <span>
          <LahjaWords words={done} /> <small>{t(k + 'fixDone')}</small>
        </span>
      </div>
    );
  if (!open)
    return (
      <button type="button" className="lj-open" onClick={() => (setText(m.body), setOpen(true))}>
        <Icon name="languages" /> {t(k + 'fix')}
      </button>
    );
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('p.lahja.add', { before: m.body, after: text.trim() });
      setDone((r.words ?? []) as LahjaWord[]);
      setOpen(false);
      if (!demo) await qc.invalidateQueries({ queryKey: ['p', 'p.lahja.state'] });
      toast(t(k + 'addedToast'), 'ok');
    } catch (e: any) {
      toast(e?.message || t('platform.pilot.lab.try.failed'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={box} className="lj-edit">
      <p>{t(k + 'fixHelp')}</p>
      <textarea dir="auto" rows={3} maxLength={2000} value={text} aria-label={t(k + 'fix')} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <div className="lj-edit-do">
        <button type="button" className="btn primary small" disabled={busy || !text.trim() || text.trim() === m.body.trim()} onClick={save}>
          {t(k + 'fixSave')}
        </button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => setOpen(false)}>
          {t(k + 'cancel')}
        </button>
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
