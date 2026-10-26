// Pilotix staff: who may enter the control room, and what they may do (owner / manager / support).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { ErrorBox, Field, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';

type Row = POut<'p.staff.list'>[number];
const ROLES = ['owner', 'manager', 'support'] as const;

export function StaffPage({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.staff.list', {});
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.staff')}</h1>
          <p className="muted">{t('platform.staffSub')}</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>
          + {t('platform.staff.new')}
        </button>
      </div>
      <div className="pp-roles">
        {ROLES.map((r) => (
          <div key={r} className="card pp-role">
            <b>{t(`platform.roles.${r}`)}</b>
            <span className="small muted">{t(`platform.roleText.${r}`)}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table className="tbl pp-tbl">
            <thead>
              <tr>
                <th>{t('platform.staff.name')}</th>
                <th>{t('login.email')}</th>
                <th>{t('platform.staff.role')}</th>
                <th>{t('platform.staff.lastLogin')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((s) => (
                <tr key={s.id} className={s.active ? '' : 'pp-void'}>
                  <td data-l={t('platform.staff.name')}>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      <b>{s.name}</b>
                      {s.id === staff.id && <small className="muted"> · {t('platform.staff.you')}</small>}
                    </span>
                  </td>
                  <td data-l={t('login.email')} className="ltr">
                    {s.email}
                  </td>
                  <td data-l={t('platform.staff.role')}>
                    {t(`platform.roles.${s.role}`)}
                    {!s.active && <small className="muted"> · {t('platform.staff.inactive')}</small>}
                  </td>
                  <td data-l={t('platform.staff.lastLogin')}>
                    <small>{s.lastLoginAt ? when(s.lastLoginAt) : '—'}</small>
                  </td>
                  <td data-l="">
                    <button type="button" className="btn small" onClick={() => setEdit(s)}>
                      {t('platform.plan.edit')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <StaffForm row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function StaffForm({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: row?.name ?? '', email: row?.email ?? '', role: (row?.role ?? 'support') as (typeof ROLES)[number], active: row?.active ?? true, password: '' });
  const save = usePAction('p.staff.save', { success: t('platform.saved'), onDone: onClose });
  return (
    <Modal
      title={row ? row.name : t('platform.staff.new')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={save.isPending || f.name.trim().length < 2 || !f.email.includes('@') || (!row && f.password.length < 10) || (f.password.length > 0 && f.password.length < 10)}
            onClick={() => save.mutate({ ...(row ? { id: row.id } : {}), name: f.name.trim(), email: f.email.trim(), role: f.role, active: f.active, password: f.password || undefined })}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="grid2 pp-form">
        <Field label={t('platform.staff.name')}>
          <input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('login.email')}>
          <input type="email" dir="ltr" value={f.email} maxLength={200} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label={t('platform.staff.role')} hint={t(`platform.roleText.${f.role}`)}>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as (typeof ROLES)[number] })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`platform.roles.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={row ? t('platform.staff.newPassword') : t('login.password')} hint={t('platform.passwordHint')}>
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> {t('platform.staff.activeLabel')}
      </label>
    </Modal>
  );
}
