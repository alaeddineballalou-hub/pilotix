// Pieces both sides of a partner use (a confirmation agency, a marketer): its prices (edited by the partner, read by
// the store), the tasks, the status of a link, a month's numbers and bill, the payment requests.
import { AgencyBillInfo, AgencyCounts, AgencyLinkInfo, AgencyPrices, AgencyTask, BillLine, confirmRate, deliveryRate, NO_AGENCY_PRICES, partnerBill, PartnerKind } from '@pilotix/shared';
import { ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, n } from '../../lib/format';
import { useAction } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';

export const TASKS: AgencyTask[] = ['confirmation', 'suivi'];

/** The kind of partner whose space is open (a store's own app: an agency, for the old texts). */
export function usePartnerKind(): PartnerKind {
  return useSession().session?.shop?.kind === 'marketer' ? 'marketer' : 'agency';
}

/**
 * The words of the partners' pages for one kind: a marketer's own text (agency.mk.*) when there is one, else the
 * agency's (agency.*). Without a kind: the partner whose space is open.
 */
export function useTp(kind?: PartnerKind) {
  const { t } = useTranslation();
  const own = usePartnerKind();
  const k = kind ?? own;
  return useCallback(
    (key: string, opts?: Record<string, unknown>) => (k === 'marketer' ? t(`agency.mk.${key}`, { ...opts, defaultValue: t(`agency.${key}`, opts) }) : t(`agency.${key}`, opts)),
    [k, t],
  );
}

/** « octobre 2026 » */
export function monthLabel(ym: string, lang: string): string {
  const [y, m] = ym.split('-').map(Number);
  const s = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 15));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export const addMonth = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** ‹ octobre 2026 › (never after the current month) */
export function MonthPicker({ value, max, onChange }: { value: string; max: string; onChange: (m: string) => void }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="agx-month" role="group" aria-label={t('agency.month')}>
      <button type="button" className="icon-btn" aria-label={t('agency.prevMonth')} onClick={() => onChange(addMonth(value, -1))}>
        <Icon name="chevl" />
      </button>
      <b>{monthLabel(value, i18n.language)}</b>
      <button type="button" className="icon-btn" aria-label={t('agency.nextMonth')} disabled={value >= max} onClick={() => onChange(addMonth(value, 1))}>
        <Icon name="chevr" />
      </button>
    </div>
  );
}

const TASK_ICON: Record<AgencyTask, string> = { confirmation: 'phone', suivi: 'route', marketing: 'megaphone' };

export function TaskChips({ tasks }: { tasks: AgencyTask[] }) {
  const { t } = useTranslation();
  return (
    <span className="agx-chips">
      {tasks.map((k) => (
        <span key={k} className={`chip agx-task agx-task-${k}`}>
          <Icon name={TASK_ICON[k]} />
          {t(`agency.task.${k}`)}
        </span>
      ))}
    </span>
  );
}

/** The tasks as two boxes to tick (at least one). */
export function TaskPicker({ value, onChange }: { value: AgencyTask[]; onChange: (v: AgencyTask[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="agx-pick" role="group" aria-label={t('agency.tasks')}>
      {TASKS.map((k) => {
        const on = value.includes(k);
        return (
          <label key={k} className={`agx-pick-it ${on ? 'on' : ''}`}>
            <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== k) : TASKS.filter((x) => x === k || value.includes(x)))} />
            <Icon name={k === 'confirmation' ? 'phone' : 'route'} />
            <span>
              <b>{t(`agency.task.${k}`)}</b>
              <small className="muted">{t(`agency.taskHelp.${k}`)}</small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Where a link stands, seen from one side. */
export function LinkStatus({ l, side }: { l: AgencyLinkInfo; side: 'agency' | 'store' }) {
  const tp = useTp(l.kind);
  if (l.status === 'pending') return <span className="chip agx-st agx-st-wait">{l.requestedBy === side ? tp('st.sent') : tp('st.received')}</span>;
  if (l.status === 'active') return l.agency.suspended ? <span className="chip agx-st agx-st-bad">{tp('st.suspended')}</span> : <span className="chip agx-st agx-st-ok">{tp('st.active')}</span>;
  return <span className="chip agx-st">{tp(`st.${l.status}`)}</span>;
}

// ---------------------------------------------------------------- prices
const MONEY_MAX = 10_000_000;
const int = (v: string, max = MONEY_MAX) => Math.max(0, Math.min(max, Math.round(Number(v.replace(/\s/g, '')) || 0)));

function Money({ label, help, value, onChange, unit }: { label: string; help?: string; value: number; onChange: (v: number) => void; unit?: string }) {
  const { t } = useTranslation();
  return (
    <label className="field agx-money">
      <span className="lab">{label}</span>
      <span className="agx-money-in">
        <input type="number" inputMode="numeric" min={0} step={10} dir="ltr" value={value || ''} placeholder="0" onChange={(e) => onChange(int(e.target.value))} />
        <span className="muted">{unit ?? t('agency.da')}</span>
      </span>
      {help && <span className="hint">{help}</span>}
    </label>
  );
}

/** The partner's prices, piece by piece (0: the piece is not used). */
export function PriceEditor({ value, onChange, kind }: { value: AgencyPrices; onChange: (p: AgencyPrices) => void; kind?: PartnerKind }) {
  const { t } = useTranslation();
  const own = usePartnerKind();
  const tp = useTp(kind);
  const set = (k: keyof AgencyPrices, v: number) => onChange({ ...value, [k]: v });
  if ((kind ?? own) === 'marketer')
    return (
      <div className="agx-pe">
        <div className="agx-pe-grid">
          <Money label={tp('p.perDelivered')} help={tp('ph.perDelivered')} value={value.perDelivered} onChange={(v) => set('perDelivered', v)} />
          <Money label={tp('p.perSuccess')} help={tp('ph.perSuccess')} value={value.perSuccess} onChange={(v) => set('perSuccess', v)} />
          <Money label={tp('p.profitRate')} help={tp('ph.profitRate')} unit="%" value={value.profitRate} onChange={(v) => set('profitRate', Math.min(100, v))} />
          <Money label={tp('p.monthly')} help={tp('ph.monthly')} value={value.monthly} onChange={(v) => set('monthly', v)} />
        </div>
      </div>
    );
  return (
    <div className="agx-pe">
      <div className="agx-pe-grid">
        <Money label={t('agency.p.perDelivered')} help={t('agency.ph.perDelivered')} value={value.perDelivered} onChange={(v) => set('perDelivered', v)} />
        <Money label={t('agency.p.perConfirmed')} help={t('agency.ph.perConfirmed')} value={value.perConfirmed} onChange={(v) => set('perConfirmed', v)} />
        <Money label={t('agency.p.perUpsell')} help={t('agency.ph.perUpsell')} value={value.perUpsell} onChange={(v) => set('perUpsell', v)} />
        <Money label={t('agency.p.monthly')} help={t('agency.ph.monthly')} value={value.monthly} onChange={(v) => set('monthly', v)} />
      </div>
      <fieldset className="agx-bonus">
        <legend>
          <Icon name="trophy" /> {t('agency.p.bonusRate')}
        </legend>
        <Money label={t('agency.p.rateMin')} unit="%" value={value.bonusRate.min} onChange={(v) => onChange({ ...value, bonusRate: { ...value.bonusRate, min: Math.min(100, v) } })} />
        <Money label={t('agency.p.rateAmount')} value={value.bonusRate.amount} onChange={(v) => onChange({ ...value, bonusRate: { ...value.bonusRate, amount: v } })} />
      </fieldset>
      <fieldset className="agx-bonus">
        <legend>
          <Icon name="medal" /> {t('agency.p.bonusVolume')}
        </legend>
        <Money label={t('agency.p.volAbove')} unit={t('agency.orders')} value={value.bonusVolume.above} onChange={(v) => onChange({ ...value, bonusVolume: { ...value.bonusVolume, above: v } })} />
        <Money label={t('agency.p.volAmount')} value={value.bonusVolume.amount} onChange={(v) => onChange({ ...value, bonusVolume: { ...value.bonusVolume, amount: v } })} />
      </fieldset>
    </div>
  );
}

/** The prices in words: only the pieces used. */
export function PriceList({ p, compact, kind }: { p: AgencyPrices | null | undefined; compact?: boolean; kind?: PartnerKind }) {
  const { t } = useTranslation();
  const tp = useTp(kind);
  const x = p ?? NO_AGENCY_PRICES;
  const rows: [string, ReactNode][] = [];
  if (x.perDelivered) rows.push([tp('p.perDelivered'), da(x.perDelivered)]);
  if (x.perConfirmed) rows.push([t('agency.p.perConfirmed'), da(x.perConfirmed)]);
  if (x.perUpsell) rows.push([t('agency.p.perUpsell'), da(x.perUpsell)]);
  if (x.perSuccess) rows.push([tp('p.perSuccess'), da(x.perSuccess)]);
  if (x.profitRate) rows.push([tp('p.profitRate'), `${n(x.profitRate)} %`]);
  if (x.monthly) rows.push([tp('p.monthly'), da(x.monthly)]);
  if (x.bonusRate.amount) rows.push([t('agency.p.bonusRateShort', { min: x.bonusRate.min }), t('agency.perDeliveredShort', { v: da(x.bonusRate.amount) })]);
  if (x.bonusVolume.amount) rows.push([t('agency.p.bonusVolumeShort', { above: n(x.bonusVolume.above) }), t('agency.perDeliveredShort', { v: da(x.bonusVolume.amount) })]);
  if (!rows.length) return <p className="muted small">{tp('noPrice')}</p>;
  return (
    <dl className={`agx-prices ${compact ? 'compact' : ''}`}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="ltr">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- a month's numbers and bill
/** 78,9 % (the language's way) */
const pc = (v: number, lang: string) => `${new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang, { maximumFractionDigits: 1 }).format(v)} %`;

export function CountsRow({ c, total, kind }: { c: AgencyCounts; total?: number; kind?: PartnerKind }) {
  const { t, i18n } = useTranslation();
  const own = usePartnerKind();
  const dr = deliveryRate(c);
  const cr = confirmRate(c);
  if ((kind ?? own) === 'marketer')
    return (
      <div className="agx-nums">
        <div>
          <small>{t('agency.c.adsets')}</small>
          <b className="ltr">{n(c.adsets)}</b>
        </div>
        <div>
          <small>{t('agency.c.spend')}</small>
          <b className="ltr">{da(c.spend)}</b>
        </div>
        <div>
          <small>{t('agency.c.delivered')}</small>
          <b className="ltr">{n(c.delivered)}</b>
          <span className="muted small ltr">{t('agency.c.ofOrders', { n: n(c.orders) })}</span>
        </div>
        <div>
          <small>{t('agency.c.net')}</small>
          <b className={`ltr ${c.net < 0 ? 'agx-bad' : ''}`}>{da(c.net)}</b>
        </div>
        <div>
          <small>{t('agency.c.successes')}</small>
          <b className="ltr">{n(c.successes)}</b>
        </div>
        {total !== undefined && (
          <div className="agx-nums-total">
            <small>{t('agency.c.amount')}</small>
            <b className="ltr">{da(total)}</b>
          </div>
        )}
      </div>
    );
  return (
    <div className="agx-nums">
      <div>
        <small>{t('agency.c.received')}</small>
        <b className="ltr">{n(c.received)}</b>
      </div>
      <div>
        <small>{t('agency.c.confirmed')}</small>
        <b className="ltr">{n(c.confirmed)}</b>
        {cr !== null && <span className="muted small ltr">{pc(cr, i18n.language)}</span>}
      </div>
      <div>
        <small>{t('agency.c.delivered')}</small>
        <b className="ltr">{n(c.delivered)}</b>
        {dr !== null && <span className={`small ltr ${dr >= 70 ? 'agx-good' : dr < 55 ? 'agx-bad' : 'agx-mid'}`}>{pc(dr, i18n.language)}</span>}
      </div>
      <div>
        <small>{t('agency.c.upsells')}</small>
        <b className="ltr">{n(c.upsells)}</b>
      </div>
      {total !== undefined && (
        <div className="agx-nums-total">
          <small>{t('agency.c.amount')}</small>
          <b className="ltr">{da(total)}</b>
        </div>
      )}
    </div>
  );
}

/** The same numbers on one line (a card in a list). */
export function CountsLine({ c, total, kind }: { c: AgencyCounts; total: number; kind?: PartnerKind }) {
  const { t, i18n } = useTranslation();
  const own = usePartnerKind();
  const dr = deliveryRate(c);
  if ((kind ?? own) === 'marketer')
    return (
      <p className="agx-mini">
        <span>
          <b className="ltr">{n(c.adsets)}</b> {t('agency.c.adsets').toLowerCase()}
        </span>
        <span>
          <b className="ltr">{da(c.spend)}</b> {t('agency.c.spendShort')}
        </span>
        <span>
          <b className="ltr">{n(c.delivered)}</b> {t('agency.c.delivered').toLowerCase()}
        </span>
        <span className="agx-mini-total">
          <b className="ltr">{da(total)}</b>
        </span>
      </p>
    );
  return (
    <p className="agx-mini">
      <span>
        <b className="ltr">{n(c.received)}</b> {t('agency.c.received').toLowerCase()}
      </span>
      <span>
        <b className="ltr">{n(c.confirmed)}</b> {t('agency.c.confirmed').toLowerCase()}
      </span>
      <span>
        <b className="ltr">{n(c.delivered)}</b> {t('agency.c.delivered').toLowerCase()}
        {dr !== null && <span className="ltr"> ({pc(dr, i18n.language)})</span>}
      </span>
      <span className="agx-mini-total">
        <b className="ltr">{da(total)}</b>
      </span>
    </p>
  );
}

/** The lines of a bill: what is counted × the price (a part of the profit: the % of the net profit). */
export function BillLines({ lines, total, kind }: { lines: BillLine[]; total: number; kind?: PartnerKind }) {
  const { t } = useTranslation();
  const tp = useTp(kind);
  if (!lines.length) return <p className="muted small">{t('agency.billEmpty')}</p>;
  return (
    <table className="agx-bill">
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <td>{tp(`line.${l.key}`)}</td>
            <td className="ltr num">{l.key === 'monthly' ? '' : l.key === 'profitRate' ? `${n(l.price)} % × ${da(l.qty)}` : `${n(l.qty)} × ${da(l.price)}`}</td>
            <td className="ltr num">{da(l.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={2}>{t('agency.total')}</td>
          <td className="ltr num">{da(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** What the bill of a month would be with these numbers (the same rule as the server). */
export const billOf = (p: AgencyPrices, c: AgencyCounts, kind: PartnerKind = 'agency') => partnerBill(kind, p, c, { monthly: true });

/** The payment requests: requested → paid (the store says so) → received (the agency confirms). */
export function BillsList({ bills, action }: { bills: AgencyBillInfo[]; action?: (b: AgencyBillInfo) => ReactNode }) {
  const { t, i18n } = useTranslation();
  if (!bills.length) return <p className="muted small">{t('agency.noBills')}</p>;
  return (
    <ul className="agx-bills">
      {bills.map((b) => (
        <li key={b.id}>
          <span className="agx-bills-m">
            <b>{monthLabel(b.month, i18n.language)}</b>
            <small className="muted">{t('agency.askedOn', { d: dateOnly(b.requestedAt) })}</small>
          </span>
          <b className="ltr">{da(b.amount)}</b>
          <span className={`chip agx-st ${b.status === 'requested' ? 'agx-st-wait' : 'agx-st-ok'}`}>{t(`agency.bill.${b.status}`)}</span>
          {action?.(b)}
        </li>
      ))}
    </ul>
  );
}

/** A short line under a title. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="agx-lead muted">{children}</p>;
}

/** « Arrêter le contrat » (both sides). */
export function EndModal({ name, proc, id, back, onClose, text }: { name: string; proc: 'agency.end' | 'partners.end'; id: number; back: string; onClose: () => void; text: string }) {
  const { t } = useTranslation();
  const end = useAction(proc, {
    success: t('agency.ended'),
    onDone: () => {
      onClose();
      location.hash = back;
    },
  });
  return (
    <Modal
      title={t('agency.endWith', { name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn danger" disabled={end.isPending} onClick={() => end.mutate({ id })}>
            {t('agency.end')}
          </button>
        </>
      }
    >
      <p>{text}</p>
    </Modal>
  );
}
