// Pilot AI › Test & lessons › the lesson test. After « Push en test », Pilot AI writes ten cases on the version's new sales
// lessons with the shop's catalogue, and Dellal answers each on the version in test (on the server, a few minutes). Pilot
// AI's mark is only a hint: the coach decides each case, « Réussi » or « Pas encore ». « Pas encore »: the coach writes
// how Dellal should handle that case, Pilot AI makes a lesson of it and « Refaire » plays that one case again with it,
// until the coach marks it passed (the lesson is kept then: it waits for « Push en test »). All ten passed: « D'autres
// cas », ten completely different ones. Then « Push en test », the real test chat, and « Push sur le serveur ».
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateTime, n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Card, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { mark } from './PilotExam';
import { usePilotAction, usePilotCall } from './pilotDemo';
import { waitingParts } from './pilotWaiting';

type State = POut<'p.pilot.state'>;
type Test = POut<'p.pilot.cases.get'>;
type Item = Test['items'][number];
type CaseDef = Test['cases'][number];
const K = 'platform.pilot.cases.';
const SHOP_KEY = 'px.pilot.lab.shop';

export function CasesCard({ d, manager, pushed }: { d: State; manager: boolean; pushed: number | null }) {
  const { t, i18n } = useTranslation();
  const call = usePilotCall();
  const qc = useQueryClient();
  const trial = d.release.trial;
  const lessons = d.caseTest.lessons;
  const fresh = lessons.filter((l) => l.fresh);
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
  // which lessons: the new ones of the version in test, or one picked
  const [pick, setPick] = useState<string>('fresh');
  const [test, setTest] = useState<Test | null>(null);
  const [mine, setMine] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const last = d.caseTest.last;
  const wantId = mine ?? last?.id ?? null;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p', 'p.pilot.state'] });
  const working = test?.status === 'writing' || test?.status === 'running';

  // follow it while Pilot AI writes and plays the cases (every 2,5 s)
  useEffect(() => {
    let on = true;
    let timer = 0;
    let ran = false;
    setTest((x) => (x && x.id === wantId ? x : null));
    if (!wantId) return;
    const tick = async () => {
      try {
        const v = await call('p.pilot.cases.get', { id: wantId });
        if (!on) return;
        setTest(v);
        if (v.status === 'writing' || v.status === 'running') {
          ran = true;
          timer = window.setTimeout(tick, 2500);
        } else if (ran) refresh();
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

  const start = async (more?: number) => {
    if (busy || (!more && !shopId)) return;
    setBusy(true);
    try {
      if (shopId)
        try {
          localStorage.setItem(SHOP_KEY, String(shopId));
        } catch {
          /* private mode */
        }
      const r = more ? await call('p.pilot.cases.more', { id: more }) : await call('p.pilot.cases.start', { shopId: shopId!, ...(pick === 'fresh' ? {} : { lessonIds: [Number(pick)] }) });
      setMine(r.id);
      setTest(await call('p.pilot.cases.get', { id: r.id }));
      refresh();
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  // « Push en test » (the lab's push card, the exam's or this card's foot) just made a version with new lessons: its ten
  // cases start at once
  const [go, setGo] = useState<number | null>(null);
  useEffect(() => {
    if (pushed) setGo(pushed);
  }, [pushed]);
  const auto = useRef<number | null>(null);
  useEffect(() => {
    if (!go || auto.current === go || !trial || trial.version !== go || !manager) return;
    auto.current = go;
    if (!fresh.length || (last && last.version === go)) return;
    setPick('fresh');
    void start();
  }, [go, trial?.version, fresh.length, last?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // no new lesson in the version in test: the first of its lessons
  useEffect(() => {
    if (pick === 'fresh' && !fresh.length && lessons[0]) setPick(String(lessons[0].id));
  }, [fresh.length, lessons[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTrial = !!test && !!trial && test.version === trial.version;
  const next: CaseDef | null = test && working ? test.cases[test.done] ?? null : null;
  const left = test ? test.total - test.passed : 0;
  return (
    <Card title={t(K + 'title')} help={t(K + 'help')} className="pl-lab-card pl-exam pl-cases">
      {!trial ? (
        <p className="small muted pl-exam-none">{t(K + 'noTrial')}</p>
      ) : !shops.length ? (
        <p className="muted">{t('platform.pilot.lab.try.noShop')}</p>
      ) : (
        <>
          <div className="pl-lab-ctl">
            <label className="pl-lab-field">
              <span>{t('platform.pilot.lab.try.shop')}</span>
              <select value={shopId ?? ''} disabled={busy || working} onChange={(e) => setShopId(Number(e.target.value))}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="pl-lab-field pl-cases-pick">
              <span>{t(K + 'lessons')}</span>
              <select value={pick} disabled={busy || working} onChange={(e) => setPick(e.target.value)}>
                {fresh.length > 0 && <option value="fresh">{t(K + 'fresh', { count: fresh.length, v: trial.version })}</option>}
                {lessons.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {(l.fresh ? '• ' : '') + (i18n.language !== 'en' && l.meaning ? l.meaning : l.text).slice(0, 90)}
                  </option>
                ))}
              </select>
            </label>
            {manager && (
              <button type="button" className="btn primary pl-exam-go" disabled={busy || working || !shopId || (pick === 'fresh' && !fresh.length) || !lessons.length} onClick={() => void start()}>
                <Icon name="sparkles" /> {t(K + 'start', { v: trial.version })}
              </button>
            )}
          </div>
          <p className="small muted pl-exam-lead">{t(K + 'lead')}</p>
          {!lessons.length && <p className="small muted">{t(K + 'noLessons', { v: trial.version })}</p>}
        </>
      )}

      {test && test.status === 'writing' && (
        <p className="pl-cases-writing small" role="status">
          <i className="pl-exam-dot" aria-hidden="true" /> {t(K + 'writing', { count: test.lessons.length })}
        </p>
      )}
      {test && test.status === 'running' && (
        <div className="pl-exam-run" role="status">
          <div className="pl-exam-bar" aria-hidden="true">
            <i style={{ width: `${Math.round((test.done / test.total) * 100)}%` }} />
          </div>
          <p className="small">
            <b>{t(K + 'progress', { done: n(test.done), total: n(test.total) })}</b>
            {next ? <> · {next.title}</> : null}
          </p>
        </div>
      )}
      {test && test.status === 'failed' && (
        <p className="warnbox" role="alert">
          {t(K + 'failedAt', { reason: test.error === 'stopped' ? t('platform.pilot.exam.stopped') : test.error === 'no_cases' ? t(K + 'noCases') : test.error ?? '' })}
        </p>
      )}

      {test && (test.status === 'running' || test.status === 'done') && (
        <>
          <div className="pl-cases-head">
            <p className="pl-exam-tally small">
              <span className="ok">
                <Icon name="check" /> {t(K + 'passedN', { count: test.passed })}
              </span>
              {test.missed > 0 && (
                <span className="bad">
                  <Icon name="alert" /> {t(K + 'missedN', { count: test.missed })}
                </span>
              )}
              {test.status === 'done' && test.items.length - test.passed - test.missed > 0 && <span className="muted">{t(K + 'openN', { count: test.items.length - test.passed - test.missed })}</span>}
            </p>
            <p className="small muted">
              {t(K + 'meta', { round: test.round, v: test.version })} · <bdi>{test.shopName ?? ''}</bdi> · <bdi>{dateTime(test.finishedAt ?? test.at)}</bdi>
            </p>
            <ul className="pl-cases-lessons">
              {test.lessons.map((l, k) => (
                <li key={l.id}>
                  <span className="pl-cases-n">{k + 1}</span>
                  <span dir="auto">{i18n.language !== 'en' && l.meaning ? l.meaning : l.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <ol className="pl-exam-qs">
            {test.cases.map((c, k) => {
              const it = test.items.find((x) => x.id === c.id) ?? null;
              return it ? <Case key={c.id} c={c} it={it} n={k + 1} test={test} onTest={setTest} lessonCount={test.lessons.length} /> : <Pending key={c.id} c={c} n={k + 1} now={k === test.done} />;
            })}
          </ol>
        </>
      )}

      {test && test.status === 'done' && (
        <Footer d={d} test={test} manager={manager} onTrial={onTrial} left={left} busy={busy} onMore={() => void start(test.id)} onStaged={(v) => setGo(v)} />
      )}
    </Card>
  );
}

function Pending({ c, n: num, now }: { c: CaseDef; n: number; now: boolean }) {
  const { t } = useTranslation();
  return (
    <li className={`pl-exam-q wait${now ? ' now' : ''}`}>
      <div className="pl-exam-row">
        <span className="pl-exam-mark wait" aria-hidden="true">
          {now ? <i className="pl-exam-dot" /> : '·'}
        </span>
        <span className="pl-exam-qt">
          <span className="pl-exam-stage">{t(K + 'caseN', { n: num })}</span>
          <b>{c.title}</b>
          <small className="muted">{t('platform.pilot.exam.' + (now ? 'asking' : 'toCome'))}</small>
        </span>
      </div>
    </li>
  );
}

/** one case: Pilot AI's mark (a hint), the coach's decision, and when not passed: the coach's words → « Refaire » */
function Case({ c, it, n: num, test, onTest, lessonCount }: { c: CaseDef; it: Item; n: number; test: Test; onTest: (v: Test) => void; lessonCount: number }) {
  const { t, i18n } = useTranslation();
  const call = usePilotCall();
  const [note, setNote] = useState(it.note ?? '');
  const [busy, setBusy] = useState<'pass' | 'fail' | 'redo' | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => setNote(it.note ?? ''), [it.note]);
  const s = typeof it.score === 'number' ? it.score : null;
  const decide = async (pass: boolean) => {
    setBusy(pass ? 'pass' : 'fail');
    try {
      onTest(await call('p.pilot.cases.verdict', { id: test.id, caseId: c.id, pass }));
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const redo = async () => {
    setBusy('redo');
    setReply(null);
    try {
      const r = await call('p.pilot.cases.redo', { id: test.id, caseId: c.id, note: note.trim(), lang: (['fr', 'en', 'ar'].includes(i18n.language) ? i18n.language : 'fr') as 'fr' | 'en' | 'ar' });
      onTest(r.test);
      if (r.problems.length || (r.reply && !r.test.items.find((x) => x.id === c.id)?.draft)) setReply(r.reply ?? t(K + 'noLesson'));
    } catch (e: any) {
      toast(e?.message || t(K + 'failed'), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const tone = it.verdict === 'pass' ? 'pass' : it.verdict === 'fail' ? 'miss' : 'open';
  const fix = it.verdict === 'fail';
  return (
    <li className={`pl-exam-q pl-case ${tone}`}>
      <details>
        <summary>
          <span className={`pl-exam-mark ${s === null ? 'wait' : it.hint ? 'ok' : 'bad'}`} title={t(K + 'hintTitle')}>
            {s === null ? '—' : <bdi className="ltr">{mark(s, i18n.language).replace(/[.,]0$/, '')}</bdi>}
          </span>
          <span className="pl-exam-qt">
            <span className="pl-exam-stage">
              {t(K + 'caseN', { n: num })}
              {lessonCount > 1 ? ` · ${t(K + 'lessonN', { n: c.lesson })}` : ''}
              {it.tries > 1 ? ` · ${t(K + 'tryN', { n: it.tries })}` : ''}
            </span>
            <b>{c.title}</b>
            <small className="muted" dir="auto">
              « {c.turns[0]} »
            </small>
          </span>
          <Icon name="chevron" />
        </summary>
        <div className="pl-exam-body">
          <p className="small pl-cases-aim">
            <b>{t(K + 'aim')}</b> {c.aim}
          </p>
          <ul className="pl-exam-chat">
            {it.transcript.map((m, i) => (
              <li key={i} className={`pl-exam-l ${m.role}`} dir="auto">
                <b>{m.role === 'customer' ? t('platform.pilot.exam.who.customer') : m.role === 'agent' ? t('platform.pilot.exam.who.dellal') : m.role === 'tool' ? t('platform.pilot.exam.who.tool') : t('platform.pilot.exam.who.team')}</b> {m.body}
              </li>
            ))}
          </ul>
          {(it.good?.length ?? 0) > 0 && (
            <ul className="pl-exam-pts good">
              {it.good!.map((x, i) => (
                <li key={i} dir="auto">
                  <Icon name="check" /> {x}
                </li>
              ))}
            </ul>
          )}
          {(it.faults?.length ?? 0) > 0 && (
            <ul className="pl-exam-pts bad">
              {it.faults!.map((x, i) => (
                <li key={i} dir="auto">
                  <Icon name="alert" /> {x}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
      <div className="pl-case-do">
        {it.error ? <small className="muted">{t('platform.pilot.exam.notMarked')}</small> : <small className="muted">{it.hint ? t(K + 'hintOk') : t(K + 'hintBad')}</small>}
        <span className="pl-case-btns" role="group" aria-label={t(K + 'decide')}>
          <button type="button" className={`btn small pl-case-yes${it.verdict === 'pass' ? ' on' : ''}`} aria-pressed={it.verdict === 'pass'} disabled={!!busy} onClick={() => void decide(true)}>
            <Icon name="check" /> {t(K + 'pass')}
          </button>
          <button type="button" className={`btn small pl-case-no${it.verdict === 'fail' ? ' on' : ''}`} aria-pressed={it.verdict === 'fail'} disabled={!!busy} onClick={() => void decide(false)}>
            <Icon name="alert" /> {t(K + 'notYet')}
          </button>
        </span>
      </div>
      {it.draft && (
        <div className="pl-exam-lesson pl-case-draft">
          <span className="small muted">{t(it.kept ? K + 'draftKept' : K + 'draftTried')}</span>
          <p lang="en" dir="ltr">
            {it.draft.text}
          </p>
          {it.draft.meaning && i18n.language !== 'en' && (
            <p className="pl-next-mean" dir="auto">
              {it.draft.meaning}
            </p>
          )}
          {it.verdict === 'pass' && it.keptError && <small className="muted">{t(K + (it.keptError === 'duplicate' ? 'keptTwin' : 'keptNo'))}</small>}
        </div>
      )}
      {fix && (
        <div className="pl-case-fix">
          <label className="small" htmlFor={`fix-${test.id}-${c.id}`}>
            <b>{t(K + 'fixLabel')}</b>
          </label>
          <textarea
            id={`fix-${test.id}-${c.id}`}
            dir="auto"
            rows={3}
            maxLength={1500}
            value={note}
            placeholder={it.meaning ?? t(K + 'fixPlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="pl-rel-do">
            <button type="button" className="btn primary small" disabled={!!busy || note.trim().length < 3} onClick={() => void redo()}>
              <Icon name="refresh" /> {busy === 'redo' ? t(K + 'redoing') : t(K + 'redo')}
            </button>
            {!note.trim() && it.meaning && (
              <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => setNote(it.meaning ?? '')}>
                {t(K + 'useIdea')}
              </button>
            )}
          </div>
          {reply && (
            <p className="small pl-case-reply" dir="auto">
              <Icon name="sparkles" /> {reply}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** under the cases: what is left to decide; all passed: « D'autres cas », and the lessons kept go to « Push en test » */
function Footer({
  d,
  test,
  manager,
  onTrial,
  left,
  busy,
  onMore,
  onStaged,
}: {
  d: State;
  test: Test;
  manager: boolean;
  onTrial: boolean;
  left: number;
  busy: boolean;
  onMore: () => void;
  onStaged: (v: number) => void;
}) {
  const { t } = useTranslation();
  const R = 'platform.pilot.release.';
  const waiting = waitingParts(t, d.release.pending, false);
  const stage = usePilotAction('p.pilot.stage', { success: (x) => t(R + 'stagedToast', { v: x.version }), onDone: (x) => onStaged(x.version) });
  const all = left === 0 && test.items.length === test.total;
  return (
    <div className={`pl-exam-push${all ? ' on' : ''}`}>
      <span className="pl-exam-push-ic" aria-hidden="true">
        <Icon name={all ? 'checkcircle' : 'beaker'} />
      </span>
      <div className="pl-exam-push-body">
        <p className="pl-rel-h">
          <b>{all ? t(K + 'allPassed', { count: test.total }) : t(K + 'leftN', { count: left })}</b>
        </p>
        {!all && <p className="small">{t(K + 'leftHow')}</p>}
        {all && onTrial && <p className="small">{t(K + 'moreHow')}</p>}
        {waiting.length > 0 && <p className="small">{t('platform.pilot.exam.toTestWaiting', { what: waiting.join(t(R + 'and')) })}</p>}
        {!onTrial && <p className="small muted">{t(K + 'otherVersion', { v: test.version })}</p>}
        {manager ? (
          <div className="pl-rel-do">
            {all && onTrial && (
              <button type="button" className="btn primary" disabled={busy} onClick={onMore}>
                <Icon name="sparkles" /> {t(K + 'more')}
              </button>
            )}
            {waiting.length > 0 && (
              <button type="button" className={`btn${all ? '' : ' primary'}`} disabled={stage.isPending} onClick={() => stage.mutate({ darija: false })}>
                <Icon name="beaker" /> {t(R + 'stage')}
              </button>
            )}
          </div>
        ) : (
          <p className="small muted">{t('platform.pilot.exam.toTestManagers')}</p>
        )}
      </div>
    </div>
  );
}
