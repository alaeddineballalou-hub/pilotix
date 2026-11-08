// « Ma caisse » (each agent): my pay first — what the shop owes me, the pay ready, the open period and its orders, what
// is on the way — then a payment to confirm (« Reçu » / « Pas encore reçu »), my acomptes (ask, history), my plan in
// plain words, and the cash I hold (the page it was before: expenses, entries, versement to the main caisse).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { planPriceBrackets, type PayTask } from '@pilotix/shared';
import { inAgency, payOn } from '../../lib/features';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { MyCash } from './PhoneCaisse';
import { calendarText, ConfirmBox, PayMine, PaymentRows, period, PlanExplain, payDay, shortDay } from './paieParts';
import './paie.css';

type Tab = 'paie' | 'acomptes' | 'plan' | 'cash';
const TABS: Tab[] = ['paie', 'acomptes', 'plan', 'cash'];

/** Ma caisse: my pay when the shop has agent pay (a store with Caisse › Paie), else the cash I hold, as before. */
export function MaCaisse() {
  return payOn() ? <MaPaie /> : <MyCash />;
}

/** « Mes gains » (a confirmation agency's agent): the same page, without a cash tab (an agency keeps no caisse here). */
export function MesGains() {
  return <MaPaie gains />;
}

function MaPaie({ gains = false }: { gains?: boolean }) {
  const { t } = useTranslation();
  const tabs = gains ? TABS.filter((k) => k !== 'cash') : TABS;
  const q = useRpc('pay.mine', {});
  const [tab, setTab] = useState<Tab>('paie');
  const [ask, setAsk] = useState(false);
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const hasPlan = d.plans.length > 0;
  const canAsk = hasPlan && d.acompte.why === null && d.acompte.available > 0;
  return (
    <div className="pp">
      {d.toConfirm.map((p) => (
        <ConfirmBox key={p.id} p={p} />
      ))}
      <div className="pp-tabs" role="tablist" aria-label={t(gains ? 'nav.gains' : 'nav.macaisse')}>
        {tabs.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(`paie.tabs.${k}`)}
          </button>
        ))}
      </div>
      {tab === 'paie' &&
        (hasPlan ? (
          <>
            <Summary d={d} />
            <div className="pp-cols">
              <div className="pp-col">
                <Orders d={d} />
                <section className="pp-card">
                  <div className="pp-head">
                    <h2>{t('paie.payments.title')}</h2>
                  </div>
                  <ReadyLine d={d} />
                  <PaymentRows items={d.payments.slice(0, 6)} />
                </section>
              </div>
              <div className="pp-col pp-side">
                <PlansCard d={d} compact />
                <AcompteCard d={d} onAsk={() => setAsk(true)} />
              </div>
            </div>
          </>
        ) : (
          <NoPlan />
        ))}
      {tab === 'acomptes' && (
        <div className="pp-cols">
          <div className="pp-col">
            <AcompteCard d={d} onAsk={() => setAsk(true)} />
          </div>
          <div className="pp-col">
            <Requests d={d} />
            <section className="pp-card">
              <div className="pp-head">
                <h2>{t('paie.acompte.paid')}</h2>
              </div>
              <PaymentRows items={d.payments.filter((p) => p.kind === 'acompte')} />
            </section>
          </div>
        </div>
      )}
      {tab === 'plan' &&
        (hasPlan ? (
          <div className="pp-narrow">
            <PlansCard d={d} />
          </div>
        ) : (
          <NoPlan />
        ))}
      {tab === 'cash' && <MyCash />}
      {tab !== 'cash' && hasPlan && d.acompte.why !== 'off' && (
        <div className="pp-bar">
          <button type="button" className="btn primary big" disabled={!canAsk} onClick={() => setAsk(true)}>
            <Icon name="coins" /> {t('paie.acompte.ask')}
          </button>
        </div>
      )}
      {ask && <AskSheet d={d} onClose={() => setAsk(false)} />}
    </div>
  );
}

function NoPlan() {
  const { t } = useTranslation();
  return (
    <section className="pp-card pp-noplan">
      <Icon name="alert" />
      <div>
        <h2>{t('paie.plan.noneTitle')}</h2>
        <p>{t('paie.plan.none')}</p>
      </div>
    </section>
  );
}

/** What the shop owes me, the pay ready, what I earned in this period, what is on the way. */
export function Summary({ d }: { d: PayMine }) {
  const { t } = useTranslation();
  const r = d.ready;
  const last = r.periods[r.periods.length - 1];
  const openNet = d.open.net;
  return (
    <section className="pp-sum" aria-label={t(inAgency() ? 'paie.owedAgency' : 'paie.owed')}>
      <div className="pp-cell lead">
        <span>{t(inAgency() ? 'paie.owedAgency' : 'paie.owed')}</span>
        <b className="ltr">{da(d.owed)}</b>
        <small>{r.total > 0 ? t('paie.owedSub', { ready: da(r.total), open: da(Math.max(0, openNet)) }) : t('paie.owedSubOpen')}</small>
      </div>
      <div className="pp-cell">
        <span>{t('paie.ready')}</span>
        <b className="ltr">{da(Math.max(0, r.total))}</b>
        <small>{last ? `${t('paie.readySub', { period: period(r.periods[0].from, last.to) })} · ${t('paie.readySince', { d: shortDay(last.to) })}` : t('paie.readyNone')}</small>
      </div>
      <div className="pp-cell">
        <span>{t('paie.earned', { period: period(d.open.from, d.open.to) })}</span>
        <b className="ltr">{da(d.open.earned)}</b>
        <small>
          {t('paie.earnedSub', { count: d.open.orders, upsells: d.open.upsells })}
          {d.open.acomptes > 0 ? ` · ${t('paie.minusAcompte', { v: da(d.open.acomptes) })}` : ''} · {t('paie.payDay', { d: payDay(d.open.to) })}
        </small>
      </div>
      <div className="pp-cell">
        <span>{t('paie.coming')}</span>
        <b className="ltr muted">+{da(d.coming.amount)}</b>
        <small>{t('paie.comingSub', { count: d.coming.count })}</small>
      </div>
    </section>
  );
}

export function ReadyLine({ d }: { d: PayMine }) {
  const { t } = useTranslation();
  const r = d.ready;
  if (!r.periods.length || r.total <= 0) return null;
  const last = r.periods[r.periods.length - 1];
  return (
    <div className="pp-ready">
      <div className="pp-grow">
        <b>{t('paie.payments.pay', { period: period(r.periods[0].from, last.to) })}</b>
        <small>{t('paie.readyWait', { d: shortDay(last.to) })}</small>
      </div>
      <span className="pp-pill warn">
        <Icon name="clock" /> {t('paie.ready')}
      </span>
      <b className="ltr pp-amt">{da(r.total)}</b>
    </div>
  );
}

const TASK_ORDER: PayTask[] = ['confirmation', 'superviseur', 'suivi', 'depot'];

/** The orders of the open period, newest first, each with what it paid me. */
export function Orders({ d }: { d: PayMine }) {
  const { t } = useTranslation();
  const tasks = TASK_ORDER.filter((k) => d.rows.some((r) => r.task === k));
  const [only, setOnly] = useState<PayTask | null>(null);
  const [all, setAll] = useState(false);
  const rows = only ? d.rows.filter((r) => r.task === only) : d.rows;
  const shown = all ? rows : rows.slice(0, 8);
  const steps = useMemo(() => {
    const m = new Map<PayTask, string[]>();
    for (const p of d.plans) {
      if (p.config.method !== 'tier') continue;
      const b = planPriceBrackets(p.config);
      m.set(
        p.task,
        b.map((x, i) => (i === 0 ? t('paie.plan.upTo', { v: n(x.to ?? 0) }) : x.to === null ? t('paie.plan.from', { v: n(x.from - 1) }) : t('paie.plan.between', { a: n(x.from), b: n(x.to) }))),
      );
    }
    return m;
  }, [d.plans, t]);
  return (
    <section className="pp-card">
      <div className="pp-head">
        <div>
          <h2>{t('paie.orders.title', { period: period(d.open.from, d.open.to) })}</h2>
          <p className="pp-muted">{t('paie.orders.help')}</p>
        </div>
      </div>
      {tasks.length > 1 && (
        <div className="pp-chips">
          <button type="button" className={only === null ? 'on' : ''} aria-pressed={only === null} onClick={() => setOnly(null)}>
            {t('paie.orders.all')} <span className="ltr">{d.rows.length}</span>
          </button>
          {tasks.map((k) => (
            <button key={k} type="button" className={only === k ? 'on' : ''} aria-pressed={only === k} onClick={() => setOnly(k)}>
              {t(`paie.orders.task.${k}`)} <span className="ltr">{d.rows.filter((r) => r.task === k).length}</span>
            </button>
          ))}
        </div>
      )}
      {!rows.length ? (
        <p className="pp-empty">{t('paie.orders.empty')}</p>
      ) : (
        <ul className="pp-rows">
          {shown.map((r, i) => (
            <li key={`${r.task}-${r.orderId ?? 'm'}-${r.event}-${i}`}>
              <div className="pp-grow">
                <b>
                  {r.kind === 'salary' ? t('paie.orders.salary') : r.product || r.ref}
                  {r.kind === 'order' && <span className="pp-muted ltr pp-ref">{r.ref}</span>}
                </b>
                <small>
                  {r.kind === 'order' && (
                    <>
                      <span className="ltr">
                        {da(r.price)}
                        {r.qty > 1 ? ` ×${r.qty}` : ''}
                      </span>{' '}
                      · {t(`paie.orders.event.${r.event}`, { d: when(r.at) })}
                      {r.agent ? ` · ${t('paie.orders.team', { name: r.agent })}` : ''}
                      {r.upsell > 0 && <em className="pp-up"> · {t('paie.orders.upsell', { count: r.extra })}</em>}
                    </>
                  )}
                  {r.kind === 'salary' && r.plan}
                </small>
              </div>
              {r.step !== null && steps.get(r.task)?.[r.step] && <span className="pp-step">{steps.get(r.task)![r.step]}</span>}
              <span className="pp-amtc">
                <b className="ltr pp-amt">+{da(r.amount)}</b>
                {r.upsell > 0 && (
                  <small className="ltr">
                    {da(r.base)} + {da(r.upsell)}
                  </small>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 8 && (
        <div className="pp-foot">
          <button type="button" className="pp-link" onClick={() => setAll((x) => !x)}>
            {all ? t('paie.orders.less') : t('paie.orders.more', { count: rows.length })}
          </button>
          <span className="pp-muted">
            {t('paie.orders.total')} <b className="ltr">{da(d.open.earned)}</b>
          </span>
        </div>
      )}
    </section>
  );
}

/** My plans (one per job), in plain words, with the shop's pay days and acompte rule. */
export function PlansCard({ d, compact = false }: { d: PayMine; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="pp-card">
      <div className="pp-head">
        <h2>{t('paie.plan.title')}</h2>
      </div>
      {d.plans.map((p) => (
        <div key={p.task} className="pp-planbox">
          <div className="pp-planhead">
            <b>{t(`paie.tasks.${p.task}`)}</b>
            <span className="pp-pill">{p.name}</span>
          </div>
          <PlanExplain plan={p} compact={compact} />
          {!compact && <small className="pp-muted">{t('paie.plan.since', { d: shortDay(p.since) })}</small>}
        </div>
      ))}
      <p className="pp-rule ic">
        <Icon name="calendar" /> {calendarText(d.calendar)}
      </p>
      {!compact && <p className="pp-rule">{d.acompte.max > 0 ? t('paie.plan.acompteRule', { v: da(d.acompte.max), day: d.acompte.fromDay }) : t('paie.plan.acompteOff')}</p>}
    </section>
  );
}

/** How much I may ask, why not when I can't, my pending request. */
function AcompteCard({ d, onAsk }: { d: PayMine; onAsk: () => void }) {
  const { t } = useTranslation();
  const a = d.acompte;
  const cancel = useAction('pay.askCancel', { success: t('paie.acompte.cancelled') });
  return (
    <section className="pp-card">
      <div className="pp-head">
        <div>
          <h2>{t('paie.acompte.title')}</h2>
          {a.max > 0 && <p className="pp-muted">{t('paie.acompte.rule', { day: a.fromDay })}</p>}
        </div>
      </div>
      {a.why === 'off' ? (
        <p className="pp-muted">{t('paie.acompte.why.off')}</p>
      ) : a.pending ? (
        <>
          <p className="pp-note warn">
            <Icon name="hourglass" /> {t('paie.acompte.why.pending', { v: da(a.pending.amount), when: when(a.pending.askedAt) })}
          </p>
          <button type="button" className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate({})}>
            {t('paie.acompte.cancel')}
          </button>
        </>
      ) : (
        <>
          <p className="pp-can">
            {t('paie.acompte.can')} <b className="ltr">{da(a.available)}</b> <span className="pp-muted">{t('paie.acompte.canWhy', { d: shortDay(d.open.from) })}</span>
          </p>
          <div className="pp-bar-h" aria-hidden="true">
            <i style={{ width: `${Math.min(100, (a.taken / Math.max(1, a.max)) * 100)}%` }} />
          </div>
          <div className="pp-bar-l">
            <span>
              {t('paie.acompte.taken')} <b className="ltr">{da(a.taken)}</b>
            </span>
            <span className="ltr">{t('paie.acompte.max', { v: da(a.max) })}</span>
          </div>
          {a.why && <p className="pp-muted">{t(`paie.acompte.why.${a.why}`, { day: a.fromDay })}</p>}
          <button type="button" className="btn primary" disabled={!!a.why || a.available < 1} onClick={onAsk}>
            <Icon name="coins" /> {t('paie.acompte.ask')}
          </button>
        </>
      )}
    </section>
  );
}

function Requests({ d }: { d: PayMine }) {
  const { t } = useTranslation();
  return (
    <section className="pp-card">
      <div className="pp-head">
        <h2>{t('paie.acompte.history')}</h2>
      </div>
      {!d.requests.length ? (
        <p className="pp-empty">{t('paie.acompte.none')}</p>
      ) : (
        <ul className="pp-rows">
          {d.requests.map((r) => (
            <li key={r.id}>
              <div className="pp-grow">
                <b>{when(r.askedAt)}</b>
                <small>
                  {r.note ? `« ${r.note} »` : ''}
                  {r.status === 'refused' && r.reason ? ` ${t('paie.acompte.refusedWhy', { r: r.reason })}` : ''}
                </small>
              </div>
              <span className={`pp-pill ${r.status === 'paid' ? 'ok' : r.status === 'pending' ? 'warn' : r.status === 'refused' ? 'bad' : 'off'}`}>{t(`paie.acompte.st.${r.status}`)}</span>
              <b className="ltr pp-amt">{da(r.amount)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AskSheet({ d, onClose }: { d: PayMine; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState('');
  const [note, setNote] = useState('');
  const amount = Math.round(Number(v) || 0);
  const ask = useAction('pay.ask', { success: t('paie.acompte.sent'), onDone: onClose });
  const ok = amount >= 1 && amount <= d.acompte.available;
  return (
    <Sheet title={t('paie.acompte.sheetTitle')} sub={t('paie.acompte.upTo', { v: da(d.acompte.available) })} onClose={onClose}>
      <div className="pp-form">
        <label className="pp-field">
          <span>{t('paie.acompte.amount')}</span>
          <span className="pp-amount">
            <input type="number" inputMode="numeric" min={1} max={d.acompte.available} autoFocus value={v} placeholder={String(d.acompte.available)} onChange={(e) => setV(e.target.value)} />
            <em>DA</em>
          </span>
        </label>
        {amount > d.acompte.available && <p className="pp-err">{t('paie.acompte.tooMuch', { v: da(d.acompte.available) })}</p>}
        <label className="pp-field">
          <span>{t('paie.acompte.note')}</span>
          <input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="button" className="btn primary big" disabled={!ok || ask.isPending} onClick={() => ask.mutate({ amount, note: note.trim() || undefined })}>
          <Icon name="send" /> {t('paie.acompte.send')}
        </button>
      </div>
    </Sheet>
  );
}
