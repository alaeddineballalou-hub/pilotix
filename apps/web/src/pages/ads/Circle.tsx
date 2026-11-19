// Marketing › Stratégies › « Life ad circle »: the strategy's card. Closed, it shows the name and why the circle is
// used. Open, it shows the circle of five steps; touching a step opens beside it that step's rules, in plain words with
// the shop's numbers, then the step's own settings (core: strat.circle / strat.circleSet; the rules and the settings
// are @pilotix/shared adcircle.ts).
//
// One place for each number: a number that judges an ad is set in Pilot Checks (Pilot Automations) and only shown
// here, underlined; the circle's own settings (the days of the week, what a test is made of) are changed here.
import { CIRCLE_FIELDS, CircleChecks, CircleField, CircleStep, CircleValue, CircleValues, circleRules, circleTestAds, circleTestAdsBad } from '@pilotix/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec2 } from '../../lib/format';
import i18n from '../../lib/i18n';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';

const K = 'strat.circle.';
const DAYS = [0, 1, 2, 3, 4, 5, 6];
type T = (key: string, vars?: Record<string, unknown>) => string;

// A value put into a rule's sentence is wrapped in two marks, so the sentence can show it in bold wherever the
// language places it: the circle's own settings, and the numbers that come from Pilot Checks (underlined).
const OWN = '';
const FROM = '';
const END = '';
const MARKED = /([][^]*)/;
const own = (s: string) => OWN + s + END;
const from = (s: string) => FROM + s + END;

/** A rule's sentence, its values in bold; the ones set in Pilot Checks are underlined and say so. */
function Marked({ text, tip }: { text: string; tip: string }) {
  return (
    <>
      {text.split(MARKED).map((part, i) =>
        part.startsWith(OWN) ? (
          <b key={i}>{part.slice(1, -1)}</b>
        ) : part.startsWith(FROM) ? (
          <b key={i} className="lc-pc" title={tip}>
            {part.slice(1, -1)}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The values a rule's sentence can name, as words (« 3 vidéos », « 20 % », « mardi »). */
function ruleVars(t: T, v: CircleValues, c: CircleChecks): Record<string, string> {
  const count = (unit: string, x: CircleValue | undefined) => (typeof x === 'number' ? t(K + `n.${unit}`, { count: x, v: dec2(x) }) : '—');
  const one = (unit: string, x: number | null) => (x === null ? '—' : t(K + `n.${unit}`, { v: dec2(x) }));
  const day = (x: CircleValue | undefined) => (typeof x === 'number' ? t(K + `dayIn.${x}`) : '—');
  const s = c.set;
  return {
    testDay: own(day(v.testDay)),
    judgeDay: own(day(v.judgeDay)),
    againVideoDay: own(day(v.againVideoDay)),
    testVideos: own(count('videos', v.testVideos)),
    testImages: own(count('images', v.testImages)),
    testBuys: own(typeof v.testBuys === 'number' ? dec2(v.testBuys) : '—'),
    testDays: own(count('days', v.testDays)),
    testPerWeek: own(count('products', v.testPerWeek)),
    testAds: from(count('ads', s.testAds)),
    judgeDays: from(count('days', s.judgeDays)),
    proofPct: from(one('pct', s.proofPct)),
    winOrders: from(count('confirmed', s.winOrders)),
    pendingHours: from(count('hours', s.pendingHours)),
    groupBand: from(one('pct', s.groupBand)),
    ownOrders: from(count('confirmed', s.ownOrders)),
    budgetBase: from(one('perDay', s.budgetBase)),
    budgetStep: from(one('pct', s.budgetStep)),
    budgetCuts: from(count('times', s.budgetCuts)),
    freezeDays: from(count('days', s.freezeDays)),
    brakeDays: from(count('days', s.brakeDays)),
    awarenessBudget: from(one('perDay', s.awarenessBudget)),
    good: from(dec2(c.good)),
    bad: from(dec2(c.bad)),
    stop: from(dec2(c.stop)),
    brakeAt: from(dec2(c.brakeAt)),
    stockStop: from(count('days', c.stockStop)),
    freezeEdits: from(count('edits', c.freezeEdits)),
    ideasMin: from(count('ideas', c.ideasMin)),
    budgetWait: from(count('confirmed', c.budgetWait)),
  };
}

/** One number field: it saves when the person leaves it or presses Enter, and says so when the value is refused. */
function NumberField({ f, value, busy, refused, onSave }: { f: CircleField; value: CircleValue; busy: boolean; refused: number; onSave: (v: number | null) => void }) {
  const { t } = useTranslation();
  const shown = typeof value === 'number' ? String(value) : '';
  const [text, setText] = useState(shown);
  // a refused value goes back to the one that is kept
  useEffect(() => setText(shown), [shown, refused]);
  const commit = () => {
    const raw = text.trim().replace(',', '.');
    if (raw === shown) return;
    if (raw === '') return f.optional ? onSave(null) : setText(shown);
    const n = Number(raw);
    // said here, in the reader's language (the server would refuse it too)
    if (!Number.isFinite(n) || (f.kind === 'int' && !Number.isInteger(n)) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
      toast(t(K + 'badNumber', { min: f.min, max: f.max }), 'bad');
      return setText(shown);
    }
    onSave(n);
  };
  return (
    <input
      id={`lc-${f.key}`}
      className="lc-in"
      inputMode={f.kind === 'int' ? 'numeric' : 'decimal'}
      value={text}
      disabled={busy}
      placeholder={f.optional ? t(K + 'choose') : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function AdCircle() {
  const { t } = useTranslation();
  const { session } = useSession();
  // Pilot Checks is the administrators' page: they get the way to it, the others are told who sets its numbers
  const admin = !!session?.isAdmin;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<CircleStep>('test');
  const q = useRpc('strat.circle', {}, { enabled: open });
  const save = useAction('strat.circleSet', { success: t(K + 'saved') });
  const [refused, setRefused] = useState(0);
  const title = useId();

  const steps = q.data?.steps ?? [];
  const values: CircleValues = q.data?.values ?? {};
  const checks = q.data?.checks;
  const lang = i18n.language;
  const vars = useMemo(() => (checks ? ruleVars(t as T, values, checks) : {}), [values, checks, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields = CIRCLE_FIELDS.filter((f) => f.step === step);
  const maxAds = checks?.set.testAds ?? null;
  const ads = (n: number) => t(K + 'n.ads', { count: n, v: dec2(n) });
  const set = (f: CircleField, value: CircleValue) => {
    // a test holds one ad at least, and never more than Pilot Checks allows (said in the reader's language)
    if (f.key === 'testVideos' || f.key === 'testImages') {
      const why = circleTestAdsBad({ ...values, [f.key]: value }, maxAds, values);
      if (why) {
        toast(why === 'none' ? t(K + 'noAds') : t(K + 'tooManyAds', { max: ads(maxAds ?? 0) }), 'bad');
        return setRefused((n) => n + 1);
      }
    }
    save.mutate({ key: f.key, value }, { onError: () => setRefused((n) => n + 1) });
  };

  return (
    <section className={`card lc${open ? ' open' : ''}`}>
      <div className="lc-head">
        <div className="lc-title">
          <h2>{t(K + 'name')}</h2>
          <span className="lc-tag">{t(K + 'tag')}</span>
        </div>
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? 'x' : 'chevron'} /> {t(K + (open ? 'close' : 'open'))}
        </button>
      </div>
      <h3 className="lc-whyh">{t(K + 'whyTitle')}</h3>
      <ul className="lc-why">
        <li>{t(K + 'why1')}</li>
        <li>{t(K + 'why2')}</li>
        <li>{t(K + 'why3')}</li>
      </ul>

      {open &&
        (q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data || !checks ? (
          <Loading />
        ) : (
          <div className="lc-body">
            <div className="lc-left">
              <p className="muted small">{t(K + 'tap')}</p>
              <div className="lc-ring" role="group" aria-label={t(K + 'ringLabel')}>
                <div className="lc-mid">
                  <b>{t(K + 'mid1')}</b>
                  <small>{t(K + 'mid2')}</small>
                </div>
                {steps.map((s, i) => {
                  const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps.length;
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`lc-stop${s === step ? ' on' : ''}`}
                      aria-pressed={s === step}
                      style={{ left: `${50 + 38 * Math.cos(a)}%`, top: `${50 + 38 * Math.sin(a)}%` }}
                      onClick={() => setStep(s)}
                    >
                      <span className="lc-n">{i + 1}</span>
                      <span className="lc-l">{t(K + `step.${s}`)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="lc-panel" role="region" aria-labelledby={title}>
              <h3 id={title} className="lc-step">
                <span className="lc-n">{steps.indexOf(step) + 1}</span>
                {t(K + `step.${step}`)}
              </h3>
              <p className="lc-help">{t(K + `help.${step}`)}</p>

              <h4 className="lc-sub">{t(K + 'rulesTitle')}</h4>
              <ul className="lc-rules">
                {circleRules(step, values, checks).map((r) => (
                  <li key={r}>
                    <Marked text={t(K + `r.${r}`, vars)} tip={t(K + 'fromTip')} />
                  </li>
                ))}
              </ul>
              <div className="lc-from">
                <p>{t(K + (admin ? 'from' : 'fromOther'))}</p>
                {admin && (
                  <a className="btn small" href="#/notify/checks">
                    <Icon name="shield" /> {t(K + 'fromLink')}
                  </a>
                )}
              </div>

              <h4 className="lc-sub">{t(K + 'settingsTitle')}</h4>
              {fields.length === 0 && <p className="lc-none">{t(K + 'noSettings')}</p>}
              {step === 'test' && maxAds !== null && circleTestAds(values) > maxAds && (
                <p className="warnbox lc-warn">
                  <Icon name="alert" />
                  <span>{t(K + 'warnAds', { have: ads(circleTestAds(values)), max: ads(maxAds) })}</span>
                </p>
              )}
              <ul className="lc-rows">
                {fields.map((f) => (
                  <li key={f.key} className="lc-row">
                    <label htmlFor={`lc-${f.key}`}>
                      <b>{t(K + `f.${f.key}`)}</b>
                      <small>{t(K + `h.${f.key}`)}</small>
                    </label>
                    {f.kind === 'bool' ? (
                      <input id={`lc-${f.key}`} type="checkbox" className="lc-tick" checked={values[f.key] === true} disabled={save.isPending} onChange={(e) => set(f, e.target.checked)} />
                    ) : f.kind === 'day' ? (
                      <select
                        id={`lc-${f.key}`}
                        className="lc-in"
                        value={typeof values[f.key] === 'number' ? String(values[f.key]) : ''}
                        disabled={save.isPending}
                        onChange={(e) => set(f, e.target.value === '' ? null : Number(e.target.value))}
                      >
                        {f.optional && <option value="">{t(K + 'choose')}</option>}
                        {DAYS.map((d) => (
                          <option key={d} value={d}>
                            {t(K + `day.${d}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <NumberField f={f} value={values[f.key] ?? null} busy={save.isPending} refused={refused} onSave={(v) => set(f, v)} />
                    )}
                  </li>
                ))}
              </ul>
              <p className="lc-note">{t(K + 'note')}</p>
            </div>
          </div>
        ))}
    </section>
  );
}
