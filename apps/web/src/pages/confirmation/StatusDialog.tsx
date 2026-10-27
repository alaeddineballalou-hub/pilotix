// Changing the confirmation status of one or more orders, with the small questions of the original:
// callback / postponed → date (+2 h / tomorrow 10:00) + note; cancelled / fake / wrong number → reason + note.
// Confirmed / confirmed without stock → the order form opens instead (check the order, then confirm).
import { CANCEL_REASONS, CONF_NEEDS_REASON, ConfStatus, FAKE_REASONS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { fromLocalInput } from '../../lib/format';
import { openOrderForm } from '../../lib/modals';
import { Field } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { choiceLabel, defaultNext, StatusChoice } from './shared';
import './confirmation.css';

interface Target {
  id: number;
  ref: string;
}
interface Ask {
  rows: Target[];
  choice: StatusChoice;
  resolve: (ok: boolean) => void;
}

/** Returns `change(rows, choice)` (resolves true when saved) and the dialog element to render. */
export function useStatusChange() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ask, setAsk] = useState<Ask | null>(null);

  const apply = async (rows: Target[], choice: StatusChoice, extra: { nextCallAt?: string; note?: string | null; reason?: string | null } = {}) => {
    const ids = rows.map((r) => r.id);
    try {
      if (choice.startsWith('try')) await rpc('confirmation.setTry', { ids, n: Number(choice.slice(3)), note: extra.note ?? null });
      else await rpc('orders.setConf', { ids, status: choice as ConfStatus, nextCallAt: extra.nextCallAt ?? null, note: extra.note ?? null, reason: extra.reason ?? null });
      const label = choiceLabel(t, choice);
      toast(rows.length === 1 ? `${rows[0].ref} → ${label}` : t('confirmation.bulkDone', { n: rows.length, label }), ['cancelled', 'fake', 'wrong_number'].includes(choice) ? 'bad' : 'ok');
      qc.invalidateQueries();
      return true;
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
      return false;
    }
  };

  const change = (rows: Target[], choice: StatusChoice, opts: { onSaved?: () => void } = {}): Promise<boolean> => {
    if (!rows.length) return Promise.resolve(false);
    if (choice === 'confirmed' || choice === 'no_stock') {
      toast(t('confirmation.checkThenConfirm', { ref: rows[0].ref }));
      openOrderForm({
        orderId: rows[0].id,
        onSaved: () => {
          qc.invalidateQueries();
          opts.onSaved?.();
        },
      });
      return Promise.resolve(false);
    }
    if (choice === 'callback' || choice === 'postponed' || CONF_NEEDS_REASON.includes(choice as ConfStatus)) return new Promise((resolve) => setAsk({ rows, choice, resolve }));
    return apply(rows, choice);
  };

  const dialog = ask ? (
    <AskDialog
      ask={ask}
      onClose={() => {
        ask.resolve(false);
        setAsk(null);
      }}
      onSubmit={async (extra) => {
        const ok = await apply(ask.rows, ask.choice, extra);
        if (ok) {
          ask.resolve(true);
          setAsk(null);
        }
      }}
    />
  ) : null;
  return { change, dialog };
}

function AskDialog({ ask, onClose, onSubmit }: { ask: Ask; onClose: () => void; onSubmit: (x: { nextCallAt?: string; note?: string | null; reason?: string | null }) => Promise<void> }) {
  const { t } = useTranslation();
  const isDate = ask.choice === 'callback' || ask.choice === 'postponed';
  const [when, setWhen] = useState(isDate ? defaultNext(ask.choice as 'callback' | 'postponed') : '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const label = choiceLabel(t, ask.choice);
  /** a fake order: its own reasons (« concurrent » blocks the landing page's device for good) */
  const fake = ask.choice === 'fake';
  const reasons: readonly string[] = fake ? FAKE_REASONS : CANCEL_REASONS;
  const title = ask.rows.length === 1 ? `${label} — ${ask.rows[0].ref}` : t('confirmation.askTitleMany', { label, n: ask.rows.length });
  const submit = async () => {
    if (isDate && !when) return setErr(t('confirmation.ask.needDate'));
    if (!isDate && !reason) return setErr(t('confirmation.ask.needReason'));
    setBusy(true);
    const reasonText = reason ? t(`status.${fake ? 'fakeReason' : 'cancelReason'}.${reason}`) : null;
    await onSubmit(isDate ? { nextCallAt: fromLocalInput(when), note: note.trim() || null } : { reason: reasonText, note: note.trim() || null });
    setBusy(false);
  };
  return (
    <Modal
      title={title}
      className="conf-modal"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {isDate ? t('common.cancel') : t('confirmation.ask.back')}
          </button>
          <button type="button" className={`btn ${isDate ? 'primary' : 'danger'}`} disabled={busy} onClick={submit}>
            {isDate ? t('common.save') : label}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {isDate ? (
          <Field label={ask.choice === 'callback' ? t('confirmation.ask.callWhen') : t('confirmation.ask.postponeWhen')}>
            <input type="datetime-local" required value={when} onChange={(e) => (setWhen(e.target.value), setErr(''))} />
          </Field>
        ) : (
          <Field label={t('confirmation.ask.reason')}>
            <select required value={reason} onChange={(e) => (setReason(e.target.value), setErr(''))}>
              <option value="">{t('confirmation.ask.choose')}</option>
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {t(`status.${fake ? 'fakeReason' : 'cancelReason'}.${r}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('common.note')}>
          <input value={note} placeholder={isDate ? t('confirmation.ask.notePh') : t('confirmation.ask.detailPh')} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err && <p className="form-err">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
