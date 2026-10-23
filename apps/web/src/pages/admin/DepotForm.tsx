// A depot's form (name, place, default, active): Réglages › Dépôts and Produits & stock › Dépôts.
import { communesOf } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction } from '../../lib/query';
import { Field } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { ConfirmButton, WilayaOptions } from './bits';

export interface Wh {
  id: number;
  name: string;
  wilayaId: number;
  commune: string;
  address: string;
  isDefault: boolean;
  active: boolean;
}

/** Admin: create or change a depot (the default depot cannot be deleted). */
export function DepotForm({ w, onClose }: { w: Wh | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ name: w?.name ?? '', wilayaId: w?.wilayaId ?? 16, commune: w?.commune ?? '', address: w?.address ?? '', isDefault: w?.isDefault ?? false, active: w?.active ?? true });
  const save = useAction('admin.warehouses.save', { success: t('admin.settings.saved'), onDone: onClose });
  const del = useAction('admin.warehouses.delete', { success: t('admin.settings.depotDeleted'), onDone: onClose });
  const communes = communesOf(v.wilayaId);
  return (
    <Modal
      title={w ? t('admin.settings.depotEdit', { name: w.name }) : t('admin.settings.depotNew')}
      onClose={onClose}
      footer={
        <>
          {w && !w.isDefault && (
            <ConfirmButton className="btn ghost danger" question={t('admin.settings.depotDeleteConfirm')} onConfirm={() => del.mutate({ id: w.id })}>
              {t('admin.settings.depotDelete')}
            </ConfirmButton>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button className="btn primary" disabled={!v.name.trim() || save.isPending} onClick={() => save.mutate({ id: w?.id, ...v, name: v.name.trim() })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label={t('admin.settings.depotName')}>
          <input value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label={t('admin.settings.wilaya')}>
          <select value={v.wilayaId} onChange={(e) => setV({ ...v, wilayaId: Number(e.target.value), commune: '' })}>
            <WilayaOptions />
          </select>
        </Field>
        <Field label={t('admin.settings.commune')}>
          <input list="px-wh-communes" value={v.commune} maxLength={120} onChange={(e) => setV({ ...v, commune: e.target.value })} />
          <datalist id="px-wh-communes">
            {communes.map((c) => (
              <option key={c[1]} value={c[1]} />
            ))}
          </datalist>
        </Field>
        <Field label={t('admin.settings.address')}>
          <input value={v.address} maxLength={300} onChange={(e) => setV({ ...v, address: e.target.value })} />
        </Field>
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <label className="row nowrap" style={{ gap: 6 }}>
          <input type="checkbox" checked={v.isDefault} disabled={w?.isDefault} onChange={(e) => setV({ ...v, isDefault: e.target.checked, active: e.target.checked ? true : v.active })} />
          {t('admin.settings.makeDefault')}
        </label>
        <label className="row nowrap" style={{ gap: 6 }}>
          <input type="checkbox" checked={v.active} disabled={v.isDefault} onChange={(e) => setV({ ...v, active: e.target.checked })} />
          {t('admin.settings.depotActive')}
        </label>
      </div>
    </Modal>
  );
}
