// Pilot AI › Test & lessons › the 10-question exam: ten simulated customers of the shop chosen talk to Dellal on the
// version chosen (in service, in test…), and Pilot AI marks each chat out of 10. The page starts it, follows it question
// by question (it runs on the server: a few minutes), then shows the mark, each question's chat, what was good and wrong,
// and the lesson that would fix the main fault (one click: it waits for the next « Push en test »). The mark of each
// version also shows on the push card. Pilotix's own lessons: added in one click, from the lessons' Sales tab.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Card, Icon, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { usePilotAction, usePilotCall } from './pilotDemo';

type State = POut<'p.pilot.state'>;
type Exam = POut<'p.pilot.exam.get'>;
type Item = Exam['items'][number];
type Book = 'live' | 'trial' | 'test' | 'none';
const K = 'platform.pilot.exam.';
const SHOP_KEY = 'px.pilot.lab.shop';

/** 9,2 (the page's language decides the comma) */
export const mark = (v: number, lang: string) => (lang === 'en' ? v.toFixed(1) : v.toFixed(1).replace('.', ','));
/** good ≥ 9, to work on ≥ 7, a real problem below */
export const tone = (v: number) => (v >= 9 ? 'ok' : v >= 7 ? 'warn' : 'bad');

export function ExamCard({ d, book: picked }: { d: State; book: Book }) {
  const { t, i18n } = useTranslation();
  const call = usePilotCall();
  const qc = useQueryClient();
  const shops = d.shops;
  const [shopId, setShopId] = useState<number | null>(() => {
    let s = 0;
    try {
      s = Number(localStorage.getItem(SHOP_KEY));
    } catch {
      /* private mode */
    }
    return shops.some((x) => x.id === s) ? s : shops[0]?.id ?? null;
  });
  const champion = d.books.books.find((b) => b.status === 'champion') ?? null;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const trial = d.release.trial;
  const options: { value: Book; label: string }[] = [
    { value: 'live', label: champion ? t('platform.pilot.lab.try.live', { v: champion.version }) : t('platform.pilot.lab.try.liveNone') },
    ...(trial ? [{ value: 'trial' as const, label: t('platform.pilot.lab.try.trial', { v: trial.version }) }] : []),
    ...(testing ? [{ value: 'test' as const, label: t('platform.pilot.lab.try.test', { v: testing.version }) }] : []),
  ];
  const [book, setBook] = useState<Book>(options.some((o) => o.value === picked) ? picked : 'live');
  useEffect(() => {
    if (options.some((o) => o.value === picked)) setBook(picked);
  }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps

  // the exam shown: the one running, else the last one this page started or opened
  const [exam, setExam] = useState<Exam | null>(null);
  const [busy, setBusy] = useState(false);
  const runningId = d.exams.running?.id ?? null;
  const want = useRef<number | null>(runningId ?? d.exams.trial?.id ?? d.exams.live?.id ?? null);
  useEffect(() => {
    if (runningId) want.current = runningId;
  }, [runningId]);
  // follow it while it runs (every 2,5 s); the push card gets its mark when it ends
  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      const id = want.current;
      if (!id) return;
      try {
        const v = await call('p.pilot.exam.get', { id });
        if (!live) return;
        setExam(v);
        if (v.status === 'running') timer = window.setTimeout(tick, 2500);
        else void qc.invalidateQueries({ queryKey: ['p.pilot.state'] });
      } catch {
        /* gone: nothing to show */
      }
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [runningId, exam?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!shopId || busy) return;
    setBusy(true);
    try {
      const r = await call('p.pilot.exam.start', { shopId, book });
      want.current = r.id;
      setExam(await call('p.pilot.exam.get', { id: r.id }));
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const running = exam?.status === 'running';
  const now = exam && running ? exam.items : null;
  const nextQ = running ? EXAM_IDS[exam!.done] : null;
  return (
    <Card title={t(K + 'title')} help={t(K + 'help')} className="pl-lab-card pl-exam">
      {!shops.length ? (
        <p className="muted">{t('platform.pilot.lab.try.noShop')}</p>
      ) : (
        <>
          <div className="pl-lab-ctl">
            <label className="pl-lab-field">
              <span>{t('platform.pilot.lab.try.shop')}</span>
              <select value={shopId ?? ''} disabled={busy || running} onChange={(e) => setShopId(Number(e.target.value))}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="pl-lab-field" role="group" aria-label={t('platform.pilot.lab.try.book')}>
              <span>{t('platform.pilot.lab.try.book')}</span>
              <Tabs value={book} onChange={setBook} items={options} />
            </div>
            <button type="button" className="btn primary pl-exam-go" disabled={busy || running || !shopId} onClick={() => void start()}>
              <Icon name="checkcircle" /> {t(K + 'start')}
            </button>
          </div>
          <p className="small muted pl-exam-lead">{t(K + 'lead')}</p>

          {exam && running && (
            <div className="pl-exam-run" role="status">
              <div className="pl-exam-bar" aria-hidden="true">
                <i style={{ width: `${Math.round((exam.done / exam.total) * 100)}%` }} />
              </div>
              <p className="small">
                <b>{t(K + 'progress', { done: n(exam.done), total: n(exam.total) })}</b>
                {nextQ ? <> · {t(K + `q.${nextQ}`)}</> : null}
              </p>
              {now && now.length > 0 && <Questions items={now} />}
            </div>
          )}

          {exam && !running && exam.status === 'failed' && (
            <p className="warnbox" role="alert">
              {t(K + 'failedAt', { reason: exam.error === 'no_product' ? t(K + 'noProduct') : exam.error === 'stopped' ? t(K + 'stopped') : exam.error ?? '' })}
            </p>
          )}

          {exam && exam.status === 'done' && exam.score !== null && (
            <div className="pl-exam-res">
              <div className={`pl-exam-score ${tone(exam.score)}`}>
                <b className="ltr">{mark(exam.score, i18n.language)}</b>
                <span>/10</span>
              </div>
              <div className="pl-exam-sum">
                <p className="pl-rel-h">
                  <b>{t(K + (exam.score >= 9.5 ? 'verdictTop' : exam.score >= 9 ? 'verdictGood' : exam.score >= 7 ? 'verdictWork' : 'verdictBad'))}</b>
                </p>
                <p className="small muted">
                  <bdi>{exam.shopName ?? ''}</bdi> · {t(K + `book.${exam.book}`, { v: exam.version })} · <bdi>{dateTime(exam.finishedAt ?? exam.at)}</bdi>
                </p>
              </div>
            </div>
          )}
          {exam && exam.status === 'done' && <Questions items={exam.items} />}
        </>
      )}
    </Card>
  );
}

/** the ten situations, in the exam's order (the server's list) */
const EXAM_IDS = ['price', 'centimes', 'fee', 'photo_ask', 'photo_client', 'trust', 'expensive', 'family', 'order', 'unknown'];

function Questions({ items }: { items: Item[] }) {
  return (
    <ol className="pl-exam-qs">
      {items.map((q) => (
        <Question key={q.id} q={q} />
      ))}
    </ol>
  );
}

function Question({ q }: { q: Item }) {
  const { t, i18n } = useTranslation();
  const [added, setAdded] = useState(false);
  const add = usePilotAction('p.pilot.addLesson', {
    success: () => t(K + 'lessonAdded'),
    onDone: () => setAdded(true),
  });
  const s = typeof q.score === 'number' ? q.score : null;
  const fault = q.faults?.[0] ?? null;
  return (
    <li className="pl-exam-q">
      <details>
        <summary>
          <span className={`pl-exam-mark ${s === null ? 'bad' : tone(s)}`}>{s === null ? '—' : <bdi className="ltr">{mark(s, i18n.language).replace(/[.,]0$/, '')}</bdi>}</span>
          <span className="pl-exam-qt">
            <b>{t(K + `q.${q.id}`, { defaultValue: q.title })}</b>
            <small className="muted">{q.error ? t(K + 'notMarked') : s !== null && s >= 10 ? t(K + 'perfect') : fault ?? q.good?.[0] ?? ''}</small>
          </span>
          <Icon name="chevron" />
        </summary>
        <div className="pl-exam-body">
          <ul className="pl-exam-chat">
            {q.transcript.map((m, i) => (
              <li key={i} className={`pl-exam-l ${m.role}`} dir="auto">
                <b>{m.role === 'customer' ? t(K + 'who.customer') : m.role === 'agent' ? 'Dellal' : m.role === 'tool' ? t(K + 'who.tool') : t(K + 'who.team')}</b> {m.body}
              </li>
            ))}
          </ul>
          {(q.good?.length ?? 0) > 0 && (
            <ul className="pl-exam-pts good">
              {q.good!.map((x, i) => (
                <li key={i} dir="auto">
                  <Icon name="check" /> {x}
                </li>
              ))}
            </ul>
          )}
          {(q.faults?.length ?? 0) > 0 && (
            <ul className="pl-exam-pts bad">
              {q.faults!.map((x, i) => (
                <li key={i} dir="auto">
                  <Icon name="alert" /> {x}
                </li>
              ))}
            </ul>
          )}
          {q.lesson && (
            <div className="pl-exam-lesson">
              <span className="small muted">{t(K + 'lessonTitle')}</span>
              <p lang="en" dir="ltr">
                {q.lesson}
              </p>
              {q.meaning && i18n.language !== 'en' && (
                <p className="pl-next-mean" dir="auto">
                  {q.meaning}
                </p>
              )}
              {q.lessonOk ? (
                <button type="button" className="btn small" disabled={added || add.isPending} onClick={() => add.mutate({ topic: q.topic ?? 'other', text: q.lesson!, ...(q.meaning ? { meaning: q.meaning } : {}) })}>
                  <Icon name={added ? 'check' : 'plus'} /> {t(K + (added ? 'lessonDone' : 'lessonAdd'))}
                </button>
              ) : (
                <small className="muted">{t(K + 'lessonIdea')}</small>
              )}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

/** « Examen de la v4 : 9,2/10 » on the push card (or: no exam yet for it, with the way to the lab) */
export function ExamLine({ score, at, v, tryHref, onExam }: { score: number | null; at?: string | null; v: number; tryHref?: string; onExam?: () => void }) {
  const { t, i18n } = useTranslation();
  const go =
    tryHref ? (
      <a href={tryHref}>{t(K + 'pass')}</a>
    ) : onExam ? (
      <button type="button" className="linkish" onClick={onExam}>
        {t(K + 'pass')}
      </button>
    ) : null;
  return score === null ? (
    <p className="small muted pl-exam-line">
      <Icon name="checkcircle" /> {t(K + 'noneFor', { v })} {go}
    </p>
  ) : (
    <p className={`small pl-exam-line ${tone(score)}`}>
      <Icon name="checkcircle" /> {t(K + 'lineFor', { v, score: mark(score, i18n.language) })}
      {at ? <span className="muted"> · <bdi>{dateTime(at)}</bdi></span> : null} {go}
    </p>
  );
}

/** Leçons › Vente: the lessons Pilotix wrote (no mistakes, a chat in order, the photos), added in one click. */
export function PilotixLessons({ d, onAdded }: { d: State; onAdded?: () => void }) {
  const { t, i18n } = useTranslation();
  const [show, setShow] = useState(false);
  const add = usePilotAction('p.pilot.addPilotixLessons', {
    success: (r) => t('platform.pilot.lab.pilotix.addedToast', { count: r.added }),
    onDone: () => onAdded?.(),
  });
  const left = d.pilotix ?? [];
  if (!left.length) return null;
  const k = 'platform.pilot.lab.pilotix.';
  return (
    <div className="pl-pilotix">
      <p className="pl-rel-h">
        <Icon name="sparkles" /> <b>{t(k + 'title', { count: left.length })}</b>
      </p>
      <p className="small muted">{t(k + 'lead')}</p>
      {show && (
        <ol className="pl-pilotix-list">
          {left.map((l) => (
            <li key={l.text}>
              <span className="ai-tag">{t(`platform.pilot.topic.${l.topic}`, { defaultValue: l.topic })}</span>{' '}
              {i18n.language === 'en' ? (
                <span lang="en" dir="ltr">
                  {l.text}
                </span>
              ) : (
                <span dir="auto">{l.meaning}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="pl-rel-do">
        <button type="button" className="btn primary small" disabled={add.isPending} onClick={() => add.mutate({})}>
          <Icon name="plus" /> {t(k + 'add', { count: left.length })}
        </button>
        <button type="button" className="btn ghost small" onClick={() => setShow((x) => !x)} aria-expanded={show}>
          {t(k + (show ? 'hide' : 'show'))}
        </button>
      </div>
    </div>
  );
}
