// The dialogs of a stock line (Stock and Alertes tabs): an entry, a count, a loss, the alert level, a transfer.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n } from '../../lib/format';
import { useAction } from '../../lib/query';
import { Field, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { bidi, nameOf, Stepper, StockRowT } from './stockui';

export function MoveDialog({ kind, row, onClose }: { kind: 'entry' | 'count' | 'loss'; row: StockRowT; onClose: () => void }) {
  const { t } = useTranslation();
  const [qty, setQty] = useState<number | ''>(kind === 'count' ? row.qty : '');
  const [note, setNote] = useState('');
  const move = useAction('catalog.move', { success: t('produits.stock.updated'), onDone: onClose });
  const submit = () => {
    if (qty === '' || qty < (kind === 'count' ? 0 : 1)) return toast(t('produits.stock.invalidQty'), 'bad');
    if (kind === 'count' && qty === row.qty) return onClose();
    move.mutate({ variantId: row.variantId, warehouseId: row.warehouseId, kind, qty, note: note.trim() || null });
  };
  const after = qty === '' ? null : kind === 'entry' ? row.qty + qty : kind === 'loss' ? row.qty - qty : qty;
  return (
    <Modal
      title={t(`produits.stock.${kind}Title`, { name: bidi(nameOf(row)) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={move.isPending || qty === ''} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        className="pd-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={kind === 'count' ? t('produits.stock.countedQty') : t('produits.stock.qty')}>
          <Stepper value={qty} onChange={setQty} min={kind === 'count' ? 0 : 1} label={kind === 'count' ? t('produits.stock.countedQty') : t('produits.stock.qty')} size="lg" onEnter={submit} />
        </Field>
        <p className="pd-after">
          {t('produits.stock.now', { n: bidi(row.qty), depot: bidi(row.warehouseName) })}
          {after !== null && after !== row.qty && (
            <>
              {' '}
              <Icon name="arrow" className="pd-arrow" /> <b className="ltr">{n(after)}</b>
            </>
          )}
        </p>
        <Field label={t('produits.stock.note')}>
          <input value={note} placeholder={kind === 'entry' ? t('produits.stock.entryNotePh') : t('produits.stock.reasonPh')} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {kind === 'entry' && <p className="pd-note">{t('produits.stock.entryHint')}</p>}
      </form>
    </Modal>
  );
}

export function AlertDialog({ row, onClose }: { row: StockRowT; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState<number | ''>(row.alertQty || 0);
  const save = useAction('catalog.setAlert', { success: t('produits.stock.alertSaved'), onDone: onClose });
  const submit = () => save.mutate({ variantId: row.variantId, warehouseId: row.warehouseId, alertQty: v === '' ? 0 : v });
  return (
    <Modal
      title={t('produits.stock.alertModal', { name: bidi(nameOf(row)) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        className="pd-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('produits.stock.alertLabel')} hint={t('produits.stock.alertHint')}>
          <Stepper value={v} onChange={setV} min={0} label={t('produits.stock.alertLabel')} size="lg" onEnter={submit} />
        </Field>
        <p className="pd-after">{t('produits.stock.availNow', { n: bidi(row.available), depot: bidi(row.warehouseName) })}</p>
      </form>
    </Modal>
  );
}

export function TransferDialog({ row, warehouses, onClose }: { row: StockRowT; warehouses: { id: number; name: string }[]; onClose: () => void }) {
  const { t } = useTranslation();
  const others = warehouses.filter((w) => w.id !== row.warehouseId);
  const [to, setTo] = useState(String(others[0]?.id ?? ''));
  const [qty, setQty] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const tr = useAction('catalog.transfer', { success: t('produits.stock.transferDone'), onDone: onClose });
  const submit = () => {
    if (qty === '' || qty < 1) return toast(t('produits.stock.invalidQty'), 'bad');
    tr.mutate({ variantId: row.variantId, from: row.warehouseId, to: Number(to), qty, note: note.trim() || null });
  };
  return (
    <Modal
      title={t('produits.stock.transferTitle', { name: bidi(nameOf(row)) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={tr.isPending || !to || qty === ''} onClick={submit}>
            {t('produits.stock.transfer')}
          </button>
        </>
      }
    >
      <form
        className="pd-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="pd-route">
          <span>
            <small>{t('produits.stock.from')}</small>
            <b>{row.warehouseName}</b>
            <small>{t('produits.stock.inDepot', { n: row.qty })}</small>
          </span>
          <Icon name="arrow" className="pd-arrow" />
          <label>
            <small>{t('produits.stock.toDepot')}</small>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {others.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Field label={t('produits.stock.qty')}>
          <Stepper value={qty} onChange={setQty} min={1} max={Math.max(1, row.qty)} label={t('produits.stock.qty')} size="lg" onEnter={submit} />
        </Field>
        <Field label={t('produits.stock.note')}>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
