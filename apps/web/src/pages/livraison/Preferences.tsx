// Sociétés de livraison › Préférences: the seller's own choices. The simple view says what Pilotix does now, one short line each;
// « Mode avancé » opens them to change, each with one short line of help. Saved for the whole shop (admin only).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import './prefs.css';

type Prefs = Out<'prefs.get'>['prefs'];
type Who = keyof Prefs['changeCompany'];
const WHO: Who[] = ['confirmation', 'agency', 'depot', 'manager'];
const ADV_KEY = 'px-prefs-advanced';

const same = (a: Prefs, b: Prefs) => JSON.stringify(a) === JSON.stringify(b);
function readAdv(): boolean {
  try {
    return localStorage.getItem(ADV_KEY) === '1';
  } catch {
    return false;
  }
}
function keepAdv(on: boolean) {
  try {
    localStorage.setItem(ADV_KEY, on ? '1' : '0');
  } catch {
    /* private window: the switch simply starts closed next time */
  }
}

export function Preferences() {
  const { t } = useTranslation();
  const q = useRpc('prefs.get', {});
  const companies = useRpc('admin.companies', {});
  const [adv, setAdv] = useState(readAdv);
  const [draft, setDraft] = useState<Prefs | null>(null);
  const save = useAction('prefs.set', { success: t('livraison.prefs.saved'), onDone: () => setDraft(null) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const saved = q.data.prefs;
  const rec = q.data.recommended;
  const v = draft ?? saved;
  const dirty = !same(v, saved);
  const set = (p: Partial<Prefs>) => setDraft({ ...v, ...p });
  const backups = (companies.data ?? []).filter((c) => c.active && c.kind !== 'own');
  const backupName = backups.find((c) => c.id === v.privateBackup.companyId)?.name ?? '';
  const who = [...WHO.filter((k) => v.changeCompany[k]).map((k) => t(`livraison.prefs.who.${k}`)), t('livraison.prefs.who.admin')];
  const missingBackup = v.privateBackup.on && !v.privateBackup.companyId;
  const flipAdv = () => {
    keepAdv(!adv);
    setAdv(!adv);
  };

  const summary: { icon: string; label: string; value: string; changed: boolean }[] = [
    { icon: 'truck', label: t('livraison.prefs.manualDefault'), value: t(v.manualDefault ? 'livraison.prefs.sum.manualOn' : 'livraison.prefs.sum.manualOff'), changed: v.manualDefault !== rec.manualDefault },
    { icon: 'usercog', label: t('livraison.prefs.change'), value: who.join(', '), changed: JSON.stringify(v.changeCompany) !== JSON.stringify(rec.changeCompany) },
    { icon: 'lock', label: t('livraison.prefs.strictLock'), value: t(v.strictLock ? 'livraison.prefs.sum.strictOn' : 'livraison.prefs.sum.strictOff'), changed: v.strictLock !== rec.strictLock },
    {
      icon: 'clock',
      label: t('livraison.prefs.backup'),
      value: v.privateBackup.on ? t('livraison.prefs.sum.backupOn', { hours: v.privateBackup.hours, company: backupName || '…' }) : t('livraison.prefs.sum.backupOff'),
      changed: v.privateBackup.on !== rec.privateBackup.on,
    },
    { icon: 'alert', label: t('livraison.prefs.noStock'), value: t('livraison.prefs.sum.noStock', { count: v.noStockDays }), changed: v.noStockDays !== rec.noStockDays },
  ];

  return (
    <div className="card pf">
      <div className="pf-head">
        <div className="pf-title">
          <h2>{t('livraison.prefs.title')}</h2>
          <p className="muted">{t('livraison.prefs.help')}</p>
        </div>
        <label className="pf-adv">
          <span>{t('livraison.prefs.advanced')}</span>
          <input type="checkbox" role="switch" className="pf-sw" checked={adv} onChange={flipAdv} />
        </label>
      </div>

      {!adv ? (
        <>
          <span className={`pf-badge ${same(saved, rec) ? 'ok' : ''}`}>{t(same(saved, rec) ? 'livraison.prefs.isRecommended' : 'livraison.prefs.isCustom')}</span>
          <ul className="pf-sum">
            {summary.map((s) => (
              <li key={s.icon}>
                <span className="pf-ico">
                  <Icon name={s.icon} />
                </span>
                <span className="pf-sum-t">
                  <b>{s.label}</b>
                  <span>{s.value}</span>
                </span>
                {s.changed && <span className="pf-dot" title={t('livraison.prefs.changedHint')} />}
              </li>
            ))}
          </ul>
          <p className="pf-open">
            <Icon name="info" /> {t('livraison.prefs.openHint')}
          </p>
        </>
      ) : (
        <>
          <section className="pf-group">
            <h3>{t('livraison.prefs.gCompany')}</h3>
            <label className="pf-row">
              <span className="pf-text">
                <b>{t('livraison.prefs.manualDefault')}</b>
                <small>{t('livraison.prefs.manualDefaultHint')}</small>
              </span>
              <input type="checkbox" role="switch" className="pf-sw" checked={v.manualDefault} onChange={(e) => set({ manualDefault: e.target.checked })} />
            </label>
            <div className="pf-row pf-col">
              <span className="pf-text">
                <b>{t('livraison.prefs.change')}</b>
                <small>{t('livraison.prefs.changeHint')}</small>
              </span>
              <div className="pf-chips" role="group" aria-label={t('livraison.prefs.change')}>
                {WHO.map((k) => (
                  <label key={k} className={`pf-chip ${v.changeCompany[k] ? 'on' : ''}`}>
                    <input type="checkbox" checked={v.changeCompany[k]} onChange={(e) => set({ changeCompany: { ...v.changeCompany, [k]: e.target.checked } })} />
                    <Icon name="checkcircle" />
                    {t(`livraison.prefs.who.${k}`)}
                  </label>
                ))}
                <span className="pf-chip on fixed" title={t('livraison.prefs.adminAlways')}>
                  <Icon name="lock" />
                  {t('livraison.prefs.who.admin')}
                </span>
              </div>
            </div>
            <label className="pf-row">
              <span className="pf-text">
                <b>{t('livraison.prefs.strictLock')}</b>
                <small>{t('livraison.prefs.strictLockHint')}</small>
              </span>
              <input type="checkbox" role="switch" className="pf-sw" checked={v.strictLock} onChange={(e) => set({ strictLock: e.target.checked })} />
            </label>
          </section>

          <section className="pf-group">
            <h3>{t('livraison.prefs.gPrivate')}</h3>
            <label className="pf-row">
              <span className="pf-text">
                <b>{t('livraison.prefs.backup')}</b>
                <small>{t('livraison.prefs.backupHint')}</small>
              </span>
              <input type="checkbox" role="switch" className="pf-sw" checked={v.privateBackup.on} onChange={(e) => set({ privateBackup: { ...v.privateBackup, on: e.target.checked } })} />
            </label>
            {v.privateBackup.on && (
              <div className="pf-inline">
                <label>
                  <span>{t('livraison.prefs.after')}</span>
                  <input
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    inputMode="numeric"
                    value={v.privateBackup.hours}
                    onChange={(e) => set({ privateBackup: { ...v.privateBackup, hours: Math.max(1, Math.min(240, Math.round(Number(e.target.value) || 1))) } })}
                  />
                  <span>{t('livraison.prefs.hours')}</span>
                </label>
                <Icon name="arrow" />
                <select
                  aria-label={t('livraison.prefs.backupCompany')}
                  className={missingBackup ? 'bad' : ''}
                  value={v.privateBackup.companyId ?? ''}
                  onChange={(e) => set({ privateBackup: { ...v.privateBackup, companyId: e.target.value ? Number(e.target.value) : null } })}
                >
                  <option value="">{t('livraison.prefs.pickCompany')}</option>
                  {backups.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {missingBackup && <small className="pf-err">{t('livraison.prefs.pickCompanyFirst')}</small>}
              </div>
            )}
          </section>

          <section className="pf-group">
            <h3>{t('livraison.prefs.gStock')}</h3>
            <div className="pf-row">
              <span className="pf-text">
                <b>{t('livraison.prefs.noStock')}</b>
                <small>{t('livraison.prefs.noStockHint')}</small>
              </span>
              <label className="pf-num">
                <span>{t('livraison.prefs.after')}</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  inputMode="numeric"
                  aria-label={t('livraison.prefs.noStock')}
                  value={v.noStockDays}
                  onChange={(e) => set({ noStockDays: Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 1))) })}
                />
                <span>{t('livraison.prefs.days')}</span>
              </label>
            </div>
          </section>

          {!same(v, rec) && (
            <button type="button" className="btn ghost pf-reset" onClick={() => setDraft({ ...rec })}>
              <Icon name="history" />
              {t('livraison.prefs.reset')}
            </button>
          )}

          {dirty && (
            <div className="pf-foot" role="region" aria-label={t('livraison.prefs.unsaved')}>
              <span className="pf-state">{t('livraison.prefs.unsaved')}</span>
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn primary" disabled={missingBackup || save.isPending} onClick={() => save.mutate(v)}>
                {save.isPending ? '…' : t('livraison.prefs.save')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
