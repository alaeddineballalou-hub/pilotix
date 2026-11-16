// Marketing › Stratégies › « Life ad circle »: the strategy's card. Closed, it shows the name and why the circle is
// used. Open, it shows the circle of five steps; touching a step opens that step's settings beside it (core:
// strat.circle / strat.circleSet, the list of settings is @pilotix/shared adcircle.ts).
import { CIRCLE_FIELDS, CircleField, CircleStep, CircleValue } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { CircleNextPick } from './CircleNext';

const K = 'strat.circle.';
const DAYS = [0, 1, 2, 3, 4, 5, 6];

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
    if (!Number.isFinite(n)) return setText(shown);
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
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<CircleStep>('test');
  const q = useRpc('strat.circle', {}, { enabled: open });
  const save = useAction('strat.circleSet', { success: t(K + 'saved') });
  const [refused, setRefused] = useState(0);

  const steps = q.data?.steps ?? [];
  const values = q.data?.values ?? {};
  const fields = CIRCLE_FIELDS.filter((f) => f.step === step);
  const set = (f: CircleField, value: CircleValue) => save.mutate({ key: f.key, value }, { onError: () => setRefused((n) => n + 1) });

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
        ) : !q.data ? (
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

            <div className="lc-panel">
              <p className="lc-over">{t(K + 'opened', { n: steps.indexOf(step) + 1 })}</p>
              <h3>{t(K + 'settingsOf', { step: t(K + `step.${step}`) })}</h3>
              <p className="lc-help">{t(K + `help.${step}`)}</p>
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
              {step === 'again' && <CircleNextPick products={q.data.products} next={q.data.next} perWeek={typeof values.testPerWeek === 'number' ? values.testPerWeek : null} />}
              <p className="lc-note">{t(K + 'note')}</p>
            </div>
          </div>
        ))}
    </section>
  );
}
