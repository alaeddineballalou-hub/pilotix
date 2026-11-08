// Pilot AI › Test & lessons › the exam: ten simulated customers of the shop chosen talk to Dellal on the version chosen
// (in service, in test…), and Pilot AI marks each chat out of 10. The ten come from 100 situations organised the way
// Dellal sells: one per stage (the greeting, the product, the price… the hard cases), the ones missed last time first.
// The page starts it, follows it question by question (it runs on the server: a few minutes), then shows the mark and
// each question in green (passed from 8: no lesson needed) or red, with the lesson that fixes its main fault (one click).
// Below the questions: « Push en test » for the lessons added, then the exam again on that version. The mark of each
// version also shows on the push card. Pilotix's own lessons: added in one click, from the lessons' Sales tab.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Icon, Tabs } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { usePilotAction, usePilotCall } from './pilotDemo';
import { FoldCard } from './PilotFold';
import { waitingParts } from './pilotWaiting';

type State = POut<'p.pilot.state'>;
type Exam = POut<'p.pilot.exam.get'>;
type Item = Exam['items'][number];
type Plan = Exam['plan'][number];
type Book = 'live' | 'trial' | 'test' | 'none';
const K = 'platform.pilot.exam.';
const SHOP_KEY = 'px.pilot.lab.shop';
/** a question is passed from this mark (the server's rule) */
const PASS = 8;

/** 9,2 (the page's language decides the comma) */
export const mark = (v: number, lang: string) => (lang === 'en' ? v.toFixed(1) : v.toFixed(1).replace('.', ','));
/** good ≥ 9, to work on ≥ 7, a real problem below */
export const tone = (v: number) => (v >= 9 ? 'ok' : v >= 7 ? 'warn' : 'bad');
/** a question's mark: 9, 7,5 */
const short = (v: number, lang: string) => mark(v, lang).replace(/[.,]0$/, '');

/** the situation's title in the page's language */
function useTitle() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return (x: { title: string; en?: string | null; ar?: string | null }) => (lang === 'en' ? x.en : lang === 'ar' ? x.ar : x.title) || x.title;
}

export function ExamCard({
  d,
  book: picked,
  onBook,
  manager,
  onStaged,
  open,
  onOpen,
}: {
  d: State;
  book: Book;
  onBook: (b: Book) => void;
  manager: boolean;
  onStaged?: (v: number) => void;
  /** folded when the page opens; open from its title row (or « Passer l'examen ») */
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const call = usePilotCall();
  const qc = useQueryClient();
  const title = useTitle();
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
  const valid = (b: string): b is Book => options.some((o) => o.value === b);
  const chosen: Book = valid(picked) ? picked : 'live';

  // the exam shown: the one running, else the one started here on this version, else this version's last mark
  const [exam, setExam] = useState<Exam | null>(null);
  const [mine, setMine] = useState<{ id: number; book: Book } | null>(null);
  const [busy, setBusy] = useState(false);
  const runningId = d.exams.running?.id ?? null;
  const last = chosen === 'trial' ? d.exams.trial : chosen === 'live' ? d.exams.live : null;
  const wantId = runningId ?? (mine && mine.book === chosen ? mine.id : null) ?? last?.id ?? null;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p', 'p.pilot.state'] });
  // follow it while it runs (every 2,5 s); the push card gets its mark when it ends
  useEffect(() => {
    let on = true;
    let timer = 0;
    let ran = false;
    setExam((e) => (e && e.id === wantId ? e : null));
    if (!wantId) return;
    const tick = async () => {
      try {
        const v = await call('p.pilot.exam.get', { id: wantId });
        if (!on) return;
        setExam(v);
        if (v.status === 'running') {
          ran = true;
          timer = window.setTimeout(tick, 2500);
        } else if (ran || v.id === runningId) refresh();
      } catch {
        /* gone: nothing to show */
      }
    };
    void tick();
    return () => {
      on = false;
      window.clearTimeout(timer);
    };
  }, [wantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (b: Book = chosen) => {
    if (!shopId || busy) return;
    setBusy(true);
    try {
      try {
        localStorage.setItem(SHOP_KEY, String(shopId));
      } catch {
        /* private mode */
      }
      if (b !== chosen) onBook(b);
      const r = await call('p.pilot.exam.start', { shopId, book: b });
      setMine({ id: r.id, book: b });
      setExam(await call('p.pilot.exam.get', { id: r.id }));
      refresh();
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const running = exam?.status === 'running';
  // one exam at a time: while it runs, the tabs stay on its version
  const runBook: string | null = running ? exam!.book : null;
  const book: Book = runBook && valid(runBook) ? runBook : chosen;
  const pick = (b: Book) => {
    if (!running) onBook(b);
  };
  const next: Plan | null = running ? exam!.plan[exam!.done] ?? null : null;
  const missed = exam ? exam.items.length - exam.passed : 0;
  // folded: the exam that runs, else the marks of the version in test and of the one in service
  const going = running ? exam : d.exams.running;
  const lang = i18n.language;
  const sum = going
    ? t(K + 'foldRunning', { done: n(going.done), total: n(going.total) })
    : [
        d.exams.trial ? t(K + 'foldTrial', { v: d.exams.trial.version, score: mark(d.exams.trial.score, lang) }) : '',
        d.exams.live ? (d.exams.live.version ? t(K + 'foldLive', { v: d.exams.live.version, score: mark(d.exams.live.score, lang) }) : t(K + 'foldBase', { score: mark(d.exams.live.score, lang) })) : '',
      ]
        .filter(Boolean)
        .join(' · ') || t(K + 'foldNone');
  return (
    <FoldCard title={t(K + 'title')} help={t(K + 'help')} className="pl-lab-card pl-exam" open={open} onOpen={onOpen} sum={sum}>
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
              <Tabs value={book} onChange={pick} items={options} />
            </div>
            <button type="button" className="btn primary pl-exam-go" disabled={busy || running || !shopId} onClick={() => void start()}>
              <Icon name="checkcircle" /> {t(K + 'start')}
            </button>
          </div>
          <p className="small muted pl-exam-lead">{t(K + 'lead')}</p>
          {!wantId && !exam && <p className="small muted pl-exam-none">{t(K + 'noneYet')}</p>}

          {exam && running && (
            <div className="pl-exam-run" role="status">
              <div className="pl-exam-bar" aria-hidden="true">
                <i style={{ width: `${Math.round((exam.done / exam.total) * 100)}%` }} />
              </div>
              <p className="small">
                <b>{t(K + 'progress', { done: n(exam.done), total: n(exam.total) })}</b>
                {next ? (
                  <>
                    {' · '}
                    {t(K + 'now', { stage: t(K + `stage.${next.stage}`), title: title(next) })}
                  </>
                ) : null}
              </p>
              <Questions items={exam.items} plan={exam.plan} />
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
                <p className="pl-exam-tally small">
                  <span className="ok">
                    <Icon name="check" /> {t(K + 'passedN', { count: exam.passed })}
                  </span>
                  {missed > 0 && (
                    <span className="bad">
                      <Icon name="alert" /> {t(K + 'missedN', { count: missed })}
                    </span>
                  )}
                </p>
                <p className="small muted">
                  <bdi>{exam.shopName ?? ''}</bdi> · {t(K + (exam.book === 'live' && !exam.version ? 'book.base' : `book.${exam.book}`), { v: exam.version })} · <bdi>{dateTime(exam.finishedAt ?? exam.at)}</bdi>
                </p>
              </div>
            </div>
          )}
          {exam && exam.status === 'done' && (
            <>
              <Questions items={exam.items} plan={exam.plan} />
              <ToTest d={d} exam={exam} manager={manager} busy={busy || !shopId} onAgain={() => void start('trial')} onStaged={onStaged} />
            </>
          )}
        </>
      )}
    </FoldCard>
  );
}

/** the ten, in the order of a sale: the ones marked, then (while it runs) the ones still to come */
function Questions({ items, plan }: { items: Item[]; plan: Plan[] }) {
  const { t } = useTranslation();
  const title = useTitle();
  // the questions are marked in the plan's order
  const left = plan.slice(items.length);
  return (
    <ol className="pl-exam-qs">
      {items.map((q, i) => (
        <Question key={q.id} q={q} n={i + 1} />
      ))}
      {left.map((x, i) => (
        <li key={x.id} className={`pl-exam-q wait${i === 0 ? ' now' : ''}`}>
          <div className="pl-exam-row">
            <span className="pl-exam-mark wait" aria-hidden="true">
              {i === 0 ? <i className="pl-exam-dot" /> : '·'}
            </span>
            <span className="pl-exam-qt">
              <span className="pl-exam-stage">{t(K + 'stageN', { n: items.length + i + 1, stage: t(K + `stage.${x.stage}`) })}</span>
              <b>{title(x)}</b>
              <small className="muted">{t(K + (i === 0 ? 'asking' : 'toCome'))}</small>
              {x.why === 'again' && <Again before={x.before} pass={null} />}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** « Reposée · 5/10 la dernière fois »: a question missed last time, asked again (fixed now, or missed again) */
function Again({ before, pass }: { before: number | null; pass: boolean | null }) {
  const { t, i18n } = useTranslation();
  const k = pass === null ? 'retry' : pass ? 'fixed' : 'stillMissed';
  return (
    <span className={`pl-exam-again${pass === null ? '' : pass ? ' ok' : ' bad'}`}>
      <Icon name="refresh" /> {before === null ? t(K + `${k}None`) : t(K + k, { v: short(before, i18n.language) })}
    </span>
  );
}

function Question({ q, n: num }: { q: Item; n: number }) {
  const { t, i18n } = useTranslation();
  const title = useTitle();
  const [added, setAdded] = useState(false);
  const add = usePilotAction('p.pilot.addLesson', {
    success: () => t(K + 'lessonAdded'),
    onDone: () => setAdded(true),
  });
  const s = typeof q.score === 'number' ? q.score : null;
  const pass = q.pass ?? (s !== null && s >= PASS);
  const fault = q.faults?.[0] ?? null;
  return (
    <li className={`pl-exam-q ${pass ? 'pass' : 'miss'}`}>
      <details>
        <summary>
          <span className={`pl-exam-mark ${pass ? 'ok' : 'bad'}`}>{s === null ? '—' : <bdi className="ltr">{short(s, i18n.language)}</bdi>}</span>
          <span className="pl-exam-qt">
            <span className="pl-exam-stage">{t(K + 'stageN', { n: num, stage: t(K + `stage.${q.stage}`) })}</span>
            <b>{title(q)}</b>
            <small className={pass ? 'pl-exam-okline' : 'muted'}>{q.error ? t(K + 'notMarked') : pass ? t(K + 'passNoLesson') : fault ?? ''}</small>
            {q.why === 'again' && <Again before={q.before ?? null} pass={q.error ? false : pass} />}
          </span>
          <Icon name="chevron" />
        </summary>
        <div className="pl-exam-body">
          <ul className="pl-exam-chat">
            {q.transcript.map((m, i) => (
              <li key={i} className={`pl-exam-l ${m.role}`} dir="auto">
                <b>{m.role === 'customer' ? t(K + 'who.customer') : m.role === 'agent' ? t(K + 'who.dellal') : m.role === 'tool' ? t(K + 'who.tool') : t(K + 'who.team')}</b> {m.body}
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
        </div>
      </details>
      {/* red: the lesson that fixes it, always in sight (green: none needed) */}
      {!pass && q.lesson && (
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
            <button type="button" className={`btn small${added ? '' : ' primary'}`} disabled={added || add.isPending} onClick={() => add.mutate({ topic: q.topic ?? 'other', text: q.lesson!, ...(q.meaning ? { meaning: q.meaning } : {}) })}>
              <Icon name={added ? 'check' : 'plus'} /> {t(K + (added ? 'lessonDone' : 'lessonAdd'))}
            </button>
          ) : (
            <small className="muted">{t(K + 'lessonIdea')}</small>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Below the questions: the lessons added wait for « Push en test » (one click here, like the push card's), then the exam
 * again on that version — the missed questions are asked first, so the marks show whether the lessons fixed them.
 */
function ToTest({ d, exam, manager, busy, onAgain, onStaged }: { d: State; exam: Exam; manager: boolean; busy: boolean; onAgain: () => void; onStaged?: (v: number) => void }) {
  const { t } = useTranslation();
  const R = 'platform.pilot.release.';
  const p = d.release.pending;
  const tr = d.release.trial;
  const waiting = waitingParts(t, p, false);
  const stage = usePilotAction('p.pilot.stage', { success: (x) => t(R + 'stagedToast', { v: x.version }), onDone: (x) => onStaged?.(x.version) });
  const missed = exam.items.length - exam.passed;
  const onTrial = !!tr && exam.book === 'trial' && exam.version === tr.version;
  let text: string;
  let action: 'stage' | 'again' | null = null;
  if (waiting.length) {
    text = t(K + 'toTestWaiting', { what: waiting.join(t(R + 'and')) });
    action = 'stage';
  } else if (tr && !onTrial) {
    text = t(K + 'toTestReady', { v: tr.version });
    action = 'again';
  } else if (missed > 0) text = t(K + 'toTestAdd');
  else if (onTrial) text = t(K + 'toTestAllGreen', { v: tr!.version });
  else return null;
  return (
    <div className={`pl-exam-push${action ? ' on' : ''}`}>
      <span className="pl-exam-push-ic" aria-hidden="true">
        <Icon name="beaker" />
      </span>
      <div className="pl-exam-push-body">
        <p className="pl-rel-h">
          <b>{t(K + 'toTestTitle')}</b>
        </p>
        <p className="small">{text}</p>
        {action === 'stage' && <p className="small muted">{t(K + 'toTestThen')}</p>}
        {action && !manager && <p className="small muted">{t(K + 'toTestManagers')}</p>}
        {action && manager && (
          <div className="pl-rel-do">
            {action === 'stage' ? (
              <button type="button" className="btn primary" disabled={stage.isPending} onClick={() => stage.mutate({ darija: false })}>
                <Icon name="beaker" /> {t(R + 'stage')}
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={busy} onClick={onAgain}>
                <Icon name="checkcircle" /> {t(K + 'againOn', { v: tr!.version })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// « Passer l'examen » on the Dellal tab: the lab opens on the exam, on the version in test
let examJump: Book | null = null;
export const takeExamJump = (): Book | null => {
  const v = examJump;
  examJump = null;
  return v;
};

/** « Examen de la v4 : 9,2/10 » on the push card (or: no exam yet for it, with the way to the lab) */
export function ExamLine({ score, at, v, tryHref, onExam }: { score: number | null; at?: string | null; v: number; tryHref?: string; onExam?: () => void }) {
  const { t, i18n } = useTranslation();
  const go =
    tryHref ? (
      <a href={tryHref} onClick={() => (examJump = 'trial')}>
        {t(K + 'pass')}
      </a>
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
