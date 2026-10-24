// « Gérer les caisses » (owner): the main caisse and the bank (always there), the caisses he creates himself (safe, depot
// cash box, BaridiMob…: create, rename, remove — money still inside moves first to the caisse he picks), and the employees'
// caisses (made automatically, one per office employee). Same dialog on computers and phones.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import './caisse.css';

const KINDS = ['cash', 'bank', 'mobile'] as const;
type Kind = (typeof KINDS)[number];
export const kindIcon = (k: string) => (k === 'bank' ? 'building' : k === 'mobile' ? 'phone' : 'wallet');

export function CaisseSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.settings', {});
  const [edit, setEdit] = useState<{ key: string; name: string; kind: Kind; balance: number; del?: boolean } | 'new' | null>(null);
  const restore = useAction('caisse.restoreBank', { success: t('caisse.set.bankRestored') });
  const d = q.data;
  return (
    <>
    <Modal wide title={t('caisse.set.title')} onClose={onClose}>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <div className="pxcs">
          <div className="pxcs-h">
            <b>{t('caisse.set.mine')}</b>
            <button type="button" className="btn primary" onClick={() => setEdit('new')}>
              + {t('caisse.set.new')}
            </button>
          </div>
          <ul className="pxcs-list">
            {d.fixed.map((c) => (
              <li key={c.key}>
                <span className="pxcs-ic">
                  <Icon name={c.key === 'bank' ? 'building' : 'wallet'} />
                </span>
                <span className="pxcs-rm">
                  <b>{c.key === 'main' ? t('caisse.ph.main') : t('caisse.ph.bank')}</b>
                  <small>{t('caisse.set.fixed')}</small>
                </span>
                <b className="ltr">{da(c.balance)}</b>
                <span className="pxcs-act" />
              </li>
            ))}
            {d.bank && (
              <li>
                <span className="pxcs-ic">
                  <Icon name="building" />
                </span>
                <span className="pxcs-rm">
                  <b>{t('caisse.ph.bank')}</b>
                  <small>{t('caisse.set.bankSub')}</small>
                </span>
                <b className="ltr">{da(d.bank.balance)}</b>
                <span className="pxcs-act">
                  <button type="button" className="btn small ghost danger" onClick={() => setEdit({ key: 'bank', name: t('caisse.ph.bank'), kind: 'bank', balance: d.bank!.balance, del: true })}>
                    {t('caisse.set.remove')}
                  </button>
                </span>
              </li>
            )}
            {d.caisses.map((c) => (
              <li key={c.key}>
                <span className="pxcs-ic">
                  <Icon name={kindIcon(c.kind)} />
                </span>
                <span className="pxcs-rm">
                  <b>{c.name}</b>
                  <small>{t(`caisse.set.kinds.${c.kind}`)}</small>
                </span>
                <b className="ltr">{da(c.balance)}</b>
                <span className="pxcs-act">
                  <button type="button" className="btn small" onClick={() => setEdit({ key: c.key, name: c.name, kind: c.kind, balance: c.balance })}>
                    <Icon name="pencil" /> {t('caisse.set.edit')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {!d.caisses.length && <p className="muted small">{t('caisse.set.none')}</p>}
          {!d.bank && (
            <p className="muted small">
              {t('caisse.set.bankGone')}{' '}
              <button type="button" className="pxcs-link" disabled={restore.isPending} onClick={() => restore.mutate({})}>
                {t('caisse.set.bankBack')}
              </button>
            </p>
          )}

          <div className="pxcs-h">
            <b>{t('caisse.ph.employees')}</b>
          </div>
          <p className="muted small">{t('caisse.set.empHelp')}</p>
          <ul className="pxcs-list">
            {d.employees.map((e) => (
              <li key={e.key}>
                <span className="pxcs-ic av">{e.name.slice(0, 1).toUpperCase()}</span>
                <span className="pxcs-rm">
                  <b>{e.name}</b>
                  <small>{e.role ? t(`roles.${e.role}`, { defaultValue: e.role }) : ''}</small>
                </span>
                <b className={`ltr${e.balance ? '' : ' muted'}`}>{da(e.balance)}</b>
                <span className="pxcs-act" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
      {edit === 'new' && <EditCaisse onClose={() => setEdit(null)} />}
      {edit && edit !== 'new' && <EditCaisse c={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

/** New caisse, or one to rename / remove. */
function EditCaisse({ c, onClose }: { c?: { key: string; name: string; kind: Kind; balance: number; del?: boolean }; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(c?.name ?? '');
  const [kind, setKind] = useState<Kind>(c?.kind ?? 'cash');
  const [del, setDel] = useState(!!c?.del);
  const [moveTo, setMoveTo] = useState('main');
  const list = (useRpc('caisse.list', {}).data ?? []).filter((x) => x.key !== c?.key);
  const create = useAction('caisse.create', { success: (r) => t('caisse.set.created', { name: r.name }), onDone: onClose });
  const rename = useAction('caisse.rename', { success: t('caisse.set.saved'), onDone: onClose });
  const remove = useAction('caisse.remove', { success: (r) => (r.moved ? t('caisse.set.removedMoved', { v: da(r.moved) }) : t('caisse.set.removed')), onDone: onClose });
  const ok = name.trim().length >= 2;
  if (c && del)
    return (
      <Modal
        title={t('caisse.set.removeTitle', { name: c.name })}
        onClose={() => (c.del ? onClose() : setDel(false))}
        footer={
          <>
            <button className="btn" onClick={() => (c.del ? onClose() : setDel(false))}>
              {t('common.cancel')}
            </button>
            <button className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate({ key: c.key, moveTo: c.balance ? ((list.some((x) => x.key === moveTo) ? moveTo : list[0]?.key ?? 'main') as 'main') : undefined })}>
              {t('caisse.set.removeBtn')}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {c.balance ? (
            <>
              <p>{t('caisse.set.removeLeft', { v: da(c.balance) })}</p>
              <label className="field">
                <span className="lab">{t('caisse.set.moveTo')}</span>
                <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                  {list.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.key === 'main' ? t('caisse.ph.main') : x.key === 'bank' ? t('caisse.ph.bank') : x.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p>{t('caisse.set.removeEmpty')}</p>
          )}
          <p className="muted small">{t('caisse.set.removeHelp')}</p>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={c ? t('caisse.set.editTitle', { name: c.name }) : t('caisse.set.new')}
      onClose={onClose}
      footer={
        <>
          {c && (
            <button className="btn ghost danger" style={{ marginInlineEnd: 'auto' }} onClick={() => setDel(true)}>
              {t('caisse.set.remove')}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!ok || create.isPending || rename.isPending}
            onClick={() => (c ? rename.mutate({ key: c.key, name: name.trim(), kind }) : create.mutate({ name: name.trim(), kind }))}
          >
            {c ? t('common.save') : t('caisse.set.create')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field">
          <span className="lab">{t('caisse.set.name')}</span>
          <input value={name} maxLength={60} autoFocus placeholder={t('caisse.set.namePh')} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="lab">{t('caisse.set.kind')}</span>
          <div className="pxo-seg pxcs-seg" role="radiogroup" aria-label={t('caisse.set.kind')}>
            {KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                <Icon name={kindIcon(k)} /> {t(`caisse.set.kinds.${k}`)}
              </button>
            ))}
          </div>
        </div>
        {!c && <p className="muted small">{t('caisse.set.newHelp')}</p>}
      </div>
    </Modal>
  );
}
