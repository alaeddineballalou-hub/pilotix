// Caisse › Paie (the owner): everyone paid here — the red alerts first (someone without a plan for one of his jobs, a
// payment someone says he did not get), what is ready to pay and the « Payer » that takes it from a caisse, the acomptes
// asked (pay or refuse), each person's plans (one per job), the pay days and acompte rules. The livreurs keep their old
// calculation below for now.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { payPeriodAt, type PayCalendar } from '@pilotix/shared';
import type { Out } from '../../lib/backend';
import { da, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Help, Icon, Loading } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { Paie as OldPaie } from '../admin/Paie';
import { Orders, PlansCard, ReadyLine, Summary } from './MaPaie';
import { caisseText, calendarText, PaymentRows, period, PayPayment, payDay, payWhat, shortDay } from './paieParts';
import './paie.css';

type Board = Out<'pay.board'>;
/** Where the plans are made: Management › Plans (a store), Facturation › Plans (an agency). */
const plansHref = (b: Board) => (b.cashless ? '#/equipe/paie' : '#/management/plans');
type Person = Board['people'][number];
type PayFor = { kind: 'pay'; person: Person } | { kind: 'acompte'; person: Person; request: NonNullable<Person['request']> };

export function PaieBoard() {
  const { t } = useTranslation();
  const q = useRpc('pay.board', {});
  const [payFor, setPayFor] = useState<PayFor | null>(null);
  const [plansFor, setPlansFor] = useState<Person | null>(null);
  const [refuse, setRefuse] = useState<Person | null>(null);
  const [settings, setSettings] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const b = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!b) return <Loading />;
  const ready = b.people.reduce((s, p) => s + Math.max(0, p.ready.total), 0);
  const asks = b.people.filter((p) => p.request);
  const waiting = b.people.reduce((s, p) => s + p.waiting.filter((w) => w.status === 'paid').length, 0);
  const running = b.people.reduce((s, p) => s + p.open.earned, 0);
  const byId = (id: number) => b.people.find((p) => p.id === id) ?? null;
  return (
    <div className="pp pb">
      <div className="pb-top">
        <h2>
          {t('paie.board.title')}
          <Help text={t('paie.board.help')} label={t('paie.board.title')} />
        </h2>
        <span className="pp-muted">{calendarText(b.calendar)}</span>
        <span className="pp-grow" />
        <button type="button" className="btn" onClick={() => setSettings(true)}>
          <Icon name="settings" /> {t('paie.board.settings')}
        </button>
      </div>

      {b.alerts.noPlan.length > 0 && (
        <section className="pb-alert" role="alert">
          <Icon name="alert" />
          <div className="pp-grow">
            <b>{t('paie.board.noPlan', { count: b.alerts.noPlan.length })}</b>
            <span>{t('paie.board.noPlanSub')}</span>
            <ul>
              {b.alerts.noPlan.map((x) => (
                <li key={x.id}>
                  <b>{x.name}</b> · {x.missing.map((k) => t(`paie.tasks.${k}`)).join(', ')}
                  <button type="button" className="btn small" onClick={() => byId(x.id) && setPlansFor(byId(x.id))}>
                    {t('paie.board.givePlan')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {b.alerts.notReceived.map((x) => (
        <section key={x.id} className="pb-alert" role="alert">
          <Icon name="alert" />
          <div className="pp-grow">
            <b>{t('paie.board.notReceived', { name: x.name, v: da(x.amount) })}</b>
            <span>{t('paie.board.notReceivedSub', { d: when(x.at) })}</span>
          </div>
          <button type="button" className="btn" onClick={() => setOpen(x.personId)}>
            {t('paie.board.see')}
          </button>
        </section>
      ))}

      <section className="pp-sum four" aria-label={t('paie.board.title')}>
        <div className="pp-cell lead">
          <span>{t('paie.board.kpi.ready')}</span>
          <b className="ltr">{da(ready)}</b>
          <small>{t('paie.board.kpi.readySub', { count: b.people.filter((p) => p.ready.total > 0).length })}</small>
        </div>
        <div className="pp-cell">
          <span>{t('paie.board.kpi.requests')}</span>
          <b className="ltr">{asks.length}</b>
          <small className="ltr">{da(asks.reduce((s, p) => s + (p.request?.amount ?? 0), 0))}</small>
        </div>
        <div className="pp-cell">
          <span>{t('paie.board.kpi.waiting')}</span>
          <b className="ltr">{waiting}</b>
          <small>{t('paie.board.kpi.waitingSub')}</small>
        </div>
        <div className="pp-cell">
          <span>{t('paie.board.kpi.open')}</span>
          <b className="ltr">{da(running)}</b>
          <small>{t('paie.board.kpi.openSub')}</small>
        </div>
      </section>

      {!b.people.length ? (
        <section className="pp-card">
          <p className="pp-empty">{t('paie.board.empty')}</p>
        </section>
      ) : (
        <section className="pp-card pb-list">
          <div className="pb-row pb-th" aria-hidden="true">
            <span>{t('paie.board.col.person')}</span>
            <span>{t('paie.board.col.plans')}</span>
            <span>{t('paie.board.col.ready')}</span>
            <span>{t('paie.board.col.request')}</span>
            <span>{t('paie.board.col.state')}</span>
          </div>
          {b.people.map((p) => (
            <div key={p.id} className="pb-row">
              <div className="pb-who">
                <button type="button" className="pp-link" onClick={() => setOpen(p.id)}>
                  {p.name}
                </button>
                <small>{p.plans.length ? t('paie.board.openLine', { v: da(p.open.earned), d: payDay(p.open.to) }) : t('paie.board.noCount')}</small>
              </div>
              <div className="pb-plans">
                {p.allowed.map((k) => {
                  const pl = p.plans.find((x) => x.task === k);
                  const need = p.required.includes(k);
                  if (!pl && !need) return null;
                  return (
                    <span key={k} className={`pp-pill ${pl ? '' : 'bad'}`} title={t(`paie.tasks.${k}`)}>
                      {pl ? <Icon name="receipt" /> : <Icon name="alert" />}
                      {pl ? pl.name : t('paie.board.missing', { task: t(`paie.tasks.${k}`) })}
                    </span>
                  );
                })}
                <button type="button" className="pp-link small" onClick={() => setPlansFor(p)}>
                  {t('paie.board.change')}
                </button>
              </div>
              <div className="pb-ready">
                {p.ready.total > 0 ? (
                  <>
                    <b className="ltr">{da(p.ready.total)}</b>
                    <small>
                      {period(p.ready.periods[0].from, p.ready.periods[p.ready.periods.length - 1].to)} · {t('paie.board.since', { d: shortDay(p.ready.periods[p.ready.periods.length - 1].to) })}
                    </small>
                    <button type="button" className="btn primary small" onClick={() => setPayFor({ kind: 'pay', person: p })}>
                      {t('paie.board.payBtn', { v: da(p.ready.total) })}
                    </button>
                  </>
                ) : (
                  <span className="pp-muted">{t('paie.board.nothingReady')}</span>
                )}
              </div>
              <div className={`pb-req${p.request ? '' : ' empty'}`}>
                {p.request ? (
                  <>
                    <span className="pb-ph">{t('paie.board.col.request')}</span>
                    <b className="ltr">{da(p.request.amount)}</b>
                    <small>
                      {when(p.request.askedAt)}
                      {p.request.note ? ` · « ${p.request.note} »` : ''}
                    </small>
                    <span className="pb-btns">
                      <button type="button" className="btn primary small" onClick={() => setPayFor({ kind: 'acompte', person: p, request: p.request! })}>
                        {t('paie.board.payShort')}
                      </button>
                      <button type="button" className="btn small" onClick={() => setRefuse(p)}>
                        {t('paie.board.refuse')}
                      </button>
                    </span>
                  </>
                ) : (
                  <span className="pp-muted">—</span>
                )}
              </div>
              <div className="pb-state">
                {p.waiting.length ? (
                  p.waiting.map((w) => (
                    <span key={w.id} className={`pp-pill ${w.status === 'not_received' ? 'bad' : 'warn'}`}>
                      <Icon name={w.status === 'not_received' ? 'alert' : 'hourglass'} />
                      {w.status === 'not_received' ? t('paie.board.notRec', { v: da(w.amount) }) : t('paie.board.waiting', { v: da(w.amount) })}
                    </span>
                  ))
                ) : p.lastPaid ? (
                  <span className="pp-pill ok">
                    <Icon name="check" />
                    {t('paie.board.allGood')}
                  </span>
                ) : (
                  <span className="pp-pill off">{t('paie.board.notYet')}</span>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {!b.cashless && (
        <details className="pp-card pb-livreurs">
          <summary>
            <b>{t('paie.board.livreurs')}</b> <span className="pp-muted">{t('paie.board.livreursHelp')}</span>
          </summary>
          <OldPaie only="livreurs" />
        </details>
      )}

      {payFor && <PaySheet b={b} f={payFor} onClose={() => setPayFor(null)} />}
      {plansFor && <PlansSheet b={b} p={plansFor} onClose={() => setPlansFor(null)} />}
      {refuse && refuse.request && <RefuseSheet p={refuse} onClose={() => setRefuse(null)} />}
      {settings && <SettingsSheet b={b} onClose={() => setSettings(false)} />}
      {open !== null && <PersonSheet id={open} name={byId(open)?.name ?? ''} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Pays what is ready (or the acompte asked) from a caisse the owner picks. */
function PaySheet({ b, f, onClose }: { b: Board; f: PayFor; onClose: () => void }) {
  const { t } = useTranslation();
  const p = f.person;
  const max = f.kind === 'pay' ? p.ready.total : f.request.amount;
  const [caisse, setCaisse] = useState(b.caisses.find((c) => c.balance >= max)?.key ?? b.caisses[0]?.key ?? 'main');
  const [v, setV] = useState(String(max));
  const amount = f.kind === 'pay' ? max : Math.round(Number(v) || 0);
  const box = b.caisses.find((c) => c.key === caisse);
  const pay = useAction('pay.pay', { success: t('paie.board.pay.done', { name: p.name }), onDone: onClose });
  // an agency keeps no caisse here: what it pays is only written down
  const short = !b.cashless && !!box && box.balance < amount;
  const last = f.kind === 'pay' ? p.ready.periods[p.ready.periods.length - 1] : null;
  return (
    <Sheet title={t('paie.board.pay.title', { name: p.name })} sub={f.kind === 'pay' && last ? t('paie.board.pay.what', { period: period(p.ready.periods[0].from, last.to) }) : f.kind === 'acompte' ? t('paie.board.pay.whatAcompte', { d: when(f.request.askedAt) }) : undefined} onClose={onClose}>
      <div className="pp-form">
        {f.kind === 'pay' ? (
          <ul className="pp-rows">
            {p.ready.periods.map((x) => (
              <li key={x.from}>
                <div className="pp-grow">
                  <b>{period(x.from, x.to)}</b>
                  <small>
                    {t('paie.earnedSub', { count: x.orders, upsells: x.upsells })}
                    {x.acomptes > 0 ? ` · ${t('paie.minusAcompte', { v: da(x.acomptes) })}` : ''}
                  </small>
                </div>
                <b className="ltr pp-amt">{da(x.net)}</b>
              </li>
            ))}
          </ul>
        ) : (
          <label className="pp-field">
            <span>{t('paie.board.pay.amount')}</span>
            <span className="pp-amount">
              <input type="number" inputMode="numeric" min={1} max={max} value={v} onChange={(e) => setV(e.target.value)} />
              <em>DA</em>
            </span>
          </label>
        )}
        {!b.cashless && <div className="pp-field">
          <span>{t('paie.board.pay.from')}</span>
          <div className="pp-choice" role="radiogroup">
            {b.caisses.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={caisse === c.key} className={caisse === c.key ? 'on' : ''} onClick={() => setCaisse(c.key)}>
                <b>{caisseText({ caisse: c.key, caisseName: c.name })}</b>
                <small className="ltr">{t('paie.board.pay.balance', { v: da(c.balance) })}</small>
              </button>
            ))}
          </div>
        </div>}
        {short && <p className="pp-err">{t('paie.board.pay.short')}</p>}
        <button type="button" className="btn primary big" disabled={pay.isPending || short || amount < 1 || amount > max} onClick={() => pay.mutate(f.kind === 'pay' ? { kind: 'pay', personId: p.id, caisse, amount } : { kind: 'acompte', requestId: f.request.id, caisse, amount })}>
          <Icon name="check" /> {t('paie.board.pay.confirm', { v: da(amount) })}
        </button>
        <p className="pp-muted small">{t(b.cashless ? 'paie.board.pay.afterAgency' : 'paie.board.pay.after', { name: p.name })}</p>
      </div>
    </Sheet>
  );
}

/** One plan per job for this person (the first plan of a job counts from the start of the pay period). */
function PlansSheet({ b, p, onClose }: { b: Board; p: Person; onClose: () => void }) {
  const { t } = useTranslation();
  const start = useMemo(() => Object.fromEntries(p.allowed.map((k) => [k, p.plans.find((x) => x.task === k)?.planId ?? null])) as Record<string, number | null>, [p]);
  const [pick, setPick] = useState<Record<string, number | null>>(start);
  const assign = useAction('pay.assign', { silent: false });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      for (const k of p.allowed) if (pick[k] !== start[k]) await assign.mutateAsync({ personId: p.id, task: k, planId: pick[k] });
      onClose();
    } catch {
      /* the error is shown by useAction */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('paie.board.plans.title', { name: p.name })} sub={t('paie.board.plans.help')} onClose={onClose}>
      <div className="pp-form">
        {p.allowed.map((k) => {
          const list = b.plans.filter((x) => x.task === k);
          return (
            <label key={k} className="pp-field">
              <span>
                {t(`paie.tasks.${k}`)} <em className={p.required.includes(k) ? 'pp-req' : 'pp-muted'}>{p.required.includes(k) ? t('paie.board.plans.required') : t('paie.board.plans.optional')}</em>
              </span>
              {list.length ? (
                <select value={pick[k] ?? ''} onChange={(e) => setPick((x) => ({ ...x, [k]: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">{t('paie.board.plans.none')}</option>
                  {list.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="pp-note warn">
                  {t('paie.board.plans.noPlans')} <a href={plansHref(b)}>{t('paie.board.plans.create')}</a>
                </span>
              )}
            </label>
          );
        })}
        <button type="button" className="btn primary big" disabled={busy || p.allowed.every((k) => pick[k] === start[k])} onClick={save}>
          {t('paie.board.plans.save')}
        </button>
        <p className="pp-muted small">
          {t('paie.board.plans.more')}{' '}
          <a href={plansHref(b)}>{b.cashless ? `${t('agency.nav.equipe')} › ${t('agency.teamTabs.paie')}` : `${t('nav.management')} › ${t('admin.subs.plans')}`}</a>
        </p>
      </div>
    </Sheet>
  );
}

function RefuseSheet({ p, onClose }: { p: Person; onClose: () => void }) {
  const { t } = useTranslation();
  const [r, setR] = useState('');
  const refuse = useAction('pay.refuse', { success: t('paie.board.refuseSheet.done'), onDone: onClose });
  return (
    <Sheet title={t('paie.board.refuseSheet.title', { name: p.name, v: da(p.request!.amount) })} onClose={onClose}>
      <div className="pp-form">
        <label className="pp-field">
          <span>{t('paie.board.refuseSheet.reason')}</span>
          <input maxLength={300} value={r} onChange={(e) => setR(e.target.value)} />
        </label>
        <button type="button" className="btn big danger" disabled={refuse.isPending} onClick={() => refuse.mutate({ requestId: p.request!.id, reason: r.trim() || undefined })}>
          {t('paie.board.refuseSheet.send')}
        </button>
      </div>
    </Sheet>
  );
}

/** The pay days (every week, 15 days, month, or chosen days) and the acompte rule. */
function SettingsSheet({ b, onClose }: { b: Board; onClose: () => void }) {
  const { t } = useTranslation();
  const [cal, setCal] = useState<PayCalendar>(b.calendar);
  const [max, setMax] = useState(String(b.acompte.max));
  const [fromDay, setFromDay] = useState(b.acompte.fromDay);
  const save = useAction('pay.settings', { success: t('paie.board.set.saved'), onDone: onClose });
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  const week = t('paie.weekdays', { returnObjects: true }) as string[];
  const next = cal.every === 'days' && !cal.days.length ? null : payPeriodAt(cal, Date.now()).to;
  const kinds: PayCalendar['every'][] = ['week', 'half', 'month', 'days'];
  const pickKind = (k: PayCalendar['every']) => setCal(k === 'week' ? { every: 'week', weekday: 6 } : k === 'half' ? { every: 'half' } : k === 'month' ? { every: 'month', day: 1 } : { every: 'days', days: [1, 15] });
  return (
    <Sheet title={t('paie.board.set.title')} onClose={onClose} tall>
      <div className="pp-form">
        <div className="pp-field">
          <span>{t('paie.board.set.every')}</span>
          <div className="pp-choice" role="radiogroup">
            {kinds.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={cal.every === k} className={cal.every === k ? 'on' : ''} onClick={() => pickKind(k)}>
                <b>{t(`paie.board.set.${k}`)}</b>
              </button>
            ))}
          </div>
        </div>
        {cal.every === 'week' && (
          <label className="pp-field">
            <span>{t('paie.board.set.weekday')}</span>
            <select value={cal.weekday} onChange={(e) => setCal({ every: 'week', weekday: Number(e.target.value) })}>
              {week.map((w, i) => (
                <option key={i} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        )}
        {cal.every === 'month' && (
          <label className="pp-field">
            <span>{t('paie.board.set.day')}</span>
            <select value={cal.day} onChange={(e) => setCal({ every: 'month', day: Number(e.target.value) })}>
              {days.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        )}
        {cal.every === 'days' && (
          <div className="pp-field">
            <span>{t('paie.board.set.daysPick')}</span>
            <div className="pp-days">
              {days.map((x) => {
                const on = cal.days.includes(x);
                return (
                  <button key={x} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => setCal({ every: 'days', days: on ? cal.days.filter((y) => y !== x) : [...cal.days, x].sort((a, c) => a - c) })}>
                    {x}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {next && (
          <p className="pp-note">
            <Icon name="calendar" /> {t('paie.board.set.next', { d: payDay(new Date(next).toISOString()) })}
          </p>
        )}
        <div className="pp-field">
          <span>{t('paie.board.set.acompte')}</span>
          <div className="pp-two">
            <label className="pp-field">
              <span className="pp-muted">{t('paie.board.set.max')}</span>
              <span className="pp-amount">
                <input type="number" inputMode="numeric" min={0} value={max} onChange={(e) => setMax(e.target.value)} />
                <em>DA</em>
              </span>
            </label>
            <label className="pp-field">
              <span className="pp-muted">{t('paie.board.set.fromDay')}</span>
              <select value={fromDay} onChange={(e) => setFromDay(Number(e.target.value))}>
                {days.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <button type="button" className="btn primary big" disabled={save.isPending || (cal.every === 'days' && !cal.days.length)} onClick={() => save.mutate({ calendar: cal, acompte: { max: Math.max(0, Math.round(Number(max) || 0)), fromDay } })}>
          {t('paie.board.set.save')}
        </button>
      </div>
    </Sheet>
  );
}

/** One person, as he sees his Ma caisse — plus cancelling a payment (an acompte, or his last pay). */
function PersonSheet({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('pay.person', { personId: id });
  const cancel = useAction('pay.cancel', { success: t('paie.board.person.cancelled') });
  const d = q.data;
  const lastPay = d?.payments.find((p) => p.kind === 'pay' && p.status !== 'cancelled');
  const onCancel = (p: PayPayment) => {
    if (p.kind === 'pay' && p.id !== lastPay?.id) return alertLast();
    if (window.confirm(t('paie.board.person.cancelAsk', { v: da(p.amount), what: payWhat(p) }))) cancel.mutate({ paymentId: p.id });
  };
  const alertLast = () => window.alert(t('paie.board.person.lastOnly'));
  return (
    <Sheet title={name} sub={t('paie.board.person.sub')} onClose={onClose} tall className="pp-sheet-wide">
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <div className="pp">
          {d.toConfirm.map((p) => (
            <div key={p.id} className="pp-note warn">
              <Icon name={p.status === 'not_received' ? 'alert' : 'hourglass'} /> {p.status === 'not_received' ? t('paie.board.notRec', { v: da(p.amount) }) : t('paie.board.waiting', { v: da(p.amount) })} · {payWhat(p)}
            </div>
          ))}
          {d.plans.length ? <Summary d={d} /> : null}
          <section className="pp-card">
            <div className="pp-head">
              <h2>{t('paie.payments.title')}</h2>
            </div>
            <ReadyLine d={d} />
            <PaymentRows items={d.payments} onCancel={onCancel} />
          </section>
          {d.plans.length ? <Orders d={d} /> : null}
          {d.plans.length ? <PlansCard d={d} /> : null}
        </div>
      )}
    </Sheet>
  );
}

