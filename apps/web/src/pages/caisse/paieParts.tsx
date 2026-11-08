// Agent pay, the pieces the agent's Ma caisse and the owner's Caisse › Paie share: a plan explained in plain words, the
// shop's pay days, a payment's state, a payment waiting for « Reçu » / « Pas encore reçu ».
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { planPriceBrackets, type ManagementPlanConfig, type PayCalendar, type PayTask } from '@pilotix/shared';
import type { Out } from '../../lib/backend';
import { da, dayRange, n, when } from '../../lib/format';
import i18n from '../../lib/i18n';
import { useAction } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';

export type PayMine = Out<'pay.mine'>;
export type PayPayment = PayMine['payments'][number];
export type PayPlan = PayMine['plans'][number];

const loc = () => (i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR');
/** « lun. 16 nov. » (a pay day: the cut day at 00:00 in Algiers) */
export const payDay = (iso: string) => new Intl.DateTimeFormat(loc(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Algiers', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(iso));
/** « 1er nov. » — the day a ready pay became ready */
export const shortDay = (iso: string) => new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short', timeZone: 'Africa/Algiers', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(iso));
/** the period « 1 – 15 nov. » (its end excluded) */
export const period = (from: string, to: string) => dayRange(from, to);

/** The shop's pay days in one sentence. */
export function calendarText(cal: PayCalendar): string {
  const t = i18n.t.bind(i18n);
  if (cal.every === 'week') return t('paie.plan.calendar.week', { day: (t('paie.weekdays', { returnObjects: true }) as string[])[cal.weekday] });
  if (cal.every === 'half') return t('paie.plan.calendar.half');
  if (cal.every === 'month') return t('paie.plan.calendar.month', { day: cal.day });
  return t('paie.plan.calendar.days', { days: cal.days.join(', ') });
}

/** One plan, explained: what pays, how much (its price steps), the upsell, a salary. */
export function PlanExplain({ plan, compact = false }: { plan: { task: PayTask; name: string; config: ManagementPlanConfig; since?: string }; compact?: boolean }) {
  const { t } = useTranslation();
  const p = plan.config;
  const per = plan.task === 'confirmation' && p.trigger === 'confirmed' ? 'confirmationConfirmed' : plan.task;
  const brackets = p.method === 'tier' ? planPriceBrackets(p) : [];
  const label = (b: { from: number; to: number | null }, i: number) => (i === 0 ? t('paie.plan.upTo', { v: da(b.to ?? 0) }) : b.to === null ? t('paie.plan.from', { v: da(b.from - 1) }) : t('paie.plan.between', { a: n(b.from), b: da(b.to) }));
  const upsell = (plan.task === 'confirmation' || plan.task === 'superviseur') && p.upsell.enabled ? t(`paie.plan.upsell.${p.upsell.method}`, { v: da(p.upsell.rate), p: n(p.upsell.rate) }) : null;
  return (
    <div className={`pp-plan${compact ? ' compact' : ''}`}>
      <p className="pp-muted">{t(`paie.plan.per.${per}`)}</p>
      {p.method === 'tier' ? (
        <ul className="pp-steps">
          {brackets.map((b, i) => (
            <li key={i}>
              <span>{label(b, i)}</span>
              <b className="ltr">{da(b.amount)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pp-rule">
          <b>{p.method === 'fixed' ? t('paie.plan.fixed', { v: da(p.rate) }) : p.method === 'percent' ? t('paie.plan.percent', { p: n(p.rate) }) : t('paie.plan.none')}</b>
        </p>
      )}
      {p.monthly > 0 && <p className="pp-rule">{t('paie.plan.monthly', { v: da(p.monthly) })}</p>}
      {upsell && (
        <p className="pp-rule">
          <b>{t('paie.plan.upsellLabel')}</b> {upsell}
        </p>
      )}
    </div>
  );
}

/** A payment's state as a pill: icon + words (never the colour alone). */
export function PayState({ status }: { status: PayPayment['status'] }) {
  const { t } = useTranslation();
  const tone = status === 'received' ? 'ok' : status === 'paid' ? 'warn' : status === 'not_received' ? 'bad' : 'off';
  const icon = status === 'received' ? 'check' : status === 'paid' ? 'hourglass' : status === 'not_received' ? 'alert' : 'x';
  return (
    <span className={`pp-pill ${tone}`}>
      <Icon name={icon as never} />
      {t(`paie.payments.st.${status}`)}
    </span>
  );
}

/** A caisse's name in the reader's language (the main caisse and the bank are words of the app, the others the owner's). */
export const caisseText = (p: { caisse: string; caisseName: string | null }) => (p.caisse === 'main' ? i18n.t('caisse.ph.main') : p.caisse === 'bank' ? i18n.t('caisse.ph.bank') : (p.caisseName ?? p.caisse));

/** What a payment was for: « Paie 16 – 31 oct. » or « Acompte ». */
export function payWhat(p: { kind: 'pay' | 'acompte'; from: string | null; to: string | null }) {
  return p.kind === 'pay' && p.from && p.to ? i18n.t('paie.payments.pay', { period: period(p.from, p.to) }) : i18n.t('paie.payments.acompte');
}

/** A payment marked paid: the agent says « Reçu » or « Pas encore reçu » (his boss is told at once). */
export function ConfirmBox({ p, compact = false }: { p: PayPayment; compact?: boolean }) {
  const { t } = useTranslation();
  const [no, setNo] = useState(false);
  const [note, setNote] = useState('');
  const who = p.paidBy ?? t('paie.confirm.boss');
  const answer = useAction('pay.answer', { success: (_r) => t('paie.confirm.doneYes'), onDone: () => setNo(false) });
  const notGot = useAction('pay.answer', { success: t('paie.confirm.doneNo', { who }), onDone: () => setNo(false) });
  const v = da(p.amount);
  if (p.status === 'not_received')
    return (
      <section className={`pp-confirm bad${compact ? ' compact' : ''}`} aria-label={t('paie.confirm.aria')}>
        <span className="pp-confirm-ic">
          <Icon name="alert" />
        </span>
        <div className="pp-confirm-tx">
          <b>{t('paie.confirm.notTitle', { v, what: payWhat(p) })}</b>
          <span>{t('paie.confirm.notSub', { who })}</span>
        </div>
        <div className="pp-confirm-bt">
          <button type="button" className="btn primary" disabled={answer.isPending} onClick={() => answer.mutate({ paymentId: p.id, received: true })}>
            <Icon name="check" /> {t('paie.confirm.gotNow')}
          </button>
        </div>
      </section>
    );
  return (
    <section className={`pp-confirm${compact ? ' compact' : ''}`} aria-label={t('paie.confirm.aria')}>
      <span className="pp-confirm-ic">
        <Icon name="hourglass" />
      </span>
      <div className="pp-confirm-tx">
        <b>{p.kind === 'pay' ? t('paie.confirm.titlePay', { who, v, period: p.from && p.to ? period(p.from, p.to) : '' }) : t('paie.confirm.titleAcompte', { who, v })}</b>
        <span>{t('paie.confirm.sub', { when: when(p.paidAt), caisse: caisseText(p) })}</span>
        {!compact && <small>{t('paie.confirm.noteNo', { who })}</small>}
      </div>
      <div className="pp-confirm-bt">
        <button type="button" className="btn primary" disabled={answer.isPending} onClick={() => answer.mutate({ paymentId: p.id, received: true })}>
          <Icon name="check" /> {t('paie.confirm.yes')}
        </button>
        <button type="button" className="btn" onClick={() => setNo(true)}>
          {t('paie.confirm.no')}
        </button>
      </div>
      {no && (
        <Sheet title={t('paie.confirm.sheetTitle', { v })} onClose={() => setNo(false)}>
          <div className="pp-form">
            <label className="pp-field">
              <span>{t('paie.confirm.sheetNote', { who })}</span>
              <textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button type="button" className="btn primary big" disabled={notGot.isPending} onClick={() => notGot.mutate({ paymentId: p.id, received: false, note: note.trim() || undefined })}>
              <Icon name="send" /> {t('paie.confirm.sheetSend', { who })}
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}

/** A list of payments (newest first): what, when, from which caisse, its state, the amount. */
export function PaymentRows({ items, onCancel }: { items: PayPayment[]; onCancel?: (p: PayPayment) => void }) {
  const { t } = useTranslation();
  if (!items.length) return <p className="pp-empty">{t('paie.payments.none')}</p>;
  return (
    <ul className="pp-rows">
      {items.map((p) => (
        <li key={p.id} className={p.status === 'cancelled' ? 'off' : ''}>
          <div className="pp-grow">
            <b>{payWhat(p)}</b>
            <small>
              {t('paie.payments.paidOn', { d: when(p.paidAt), caisse: caisseText(p) })}
              {p.paidBy ? ` · ${p.paidBy}` : ''}
              {p.note ? ` · « ${p.note} »` : ''}
            </small>
          </div>
          <PayState status={p.status} />
          <b className="ltr pp-amt">{da(p.amount)}</b>
          {onCancel && p.status !== 'cancelled' && (
            <button type="button" className="btn small" onClick={() => onCancel(p)}>
              {t('paie.board.person.cancel')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
