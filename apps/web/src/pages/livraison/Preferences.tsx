// Sociétés de livraison › Préférences: the seller's own choices. The simple view says what Pilotix does now, one short line each;
// « Mode avancé » opens them to change, each with one short line of help. Saved for the whole shop (admin only).
import { FAIL_REASONS, RETURN_REASONS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc, type Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { toast } from '../../ui/toast';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import './prefs.css';

type Prefs = Out<'prefs.get'>['prefs'];
type Who = keyof Prefs['changeCompany'];
const WHO: Who[] = ['confirmation', 'agency', 'depot', 'manager'];
const ADV_KEY = 'px-prefs-advanced';
/** what the livreur can say on a parcel he did not deliver (« failed:no_answer », « returning:refused »…) */
const LIVREUR_SAYS = [...FAIL_REASONS.map((r) => `failed:${r}`), ...RETURN_REASONS.map((r) => `returning:${r}`)];
type CoAlerts = Out<'delivery.alertStatuses'>;
/** One chip per name: a company can give the same status under its key and its words (« En livraison » twice) */
function chipsOf(c: CoAlerts[number]) {
  const by = new Map<string, { label: string; keys: string[]; parcels: number }>();
  for (const x of c.statuses) {
    const label = x.label || x.status;
    const k = label.toLowerCase();
    const g = by.get(k) ?? { label, keys: [], parcels: 0 };
    g.keys.push(x.status);
    g.parcels += x.parcels;
    by.set(k, g);
  }
  return [...by.values()];
}

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
  const save = useAction('prefs.set', { silent: true });
  // Alertes du Suivi: each delivery company's statuses that send a parcel to Suivi › Alertes (saved with the rest)
  const isAdmin = !!useSession().session?.isAdmin;
  const alerts = useRpc('delivery.alertStatuses', {}, { enabled: isAdmin });
  const [coDraft, setCoDraft] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const saved = q.data.prefs;
  const rec = q.data.recommended;
  const v = draft ?? saved;
  const coSaved = (c: CoAlerts[number]) => c.statuses.filter((x) => x.alert).map((x) => x.status);
  const coOn = (c: CoAlerts[number]) => coDraft[c.companyId] ?? coSaved(c);
  const coChanged = (alerts.data ?? []).filter((c) => coDraft[c.companyId] && JSON.stringify([...coDraft[c.companyId]].sort()) !== JSON.stringify([...coSaved(c)].sort()));
  const dirty = !same(v, saved) || coChanged.length > 0;
  const cancel = () => (setDraft(null), setCoDraft({}));
  const saveAll = async () => {
    setBusy(true);
    try {
      for (const c of coChanged) await rpc('delivery.saveAlertStatuses', { companyId: c.companyId, alert: coDraft[c.companyId] });
      if (!same(v, saved)) await save.mutateAsync(v);
      toast(t('livraison.prefs.saved'), 'ok');
      cancel();
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const flip = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const sayLabel = (k: string) => {
    const [st, r] = k.split(':');
    return t(`status.${st === 'failed' ? 'failReason' : 'returnReason'}.${r}`);
  };
  const alertSum = [
    ...(alerts.data ?? []).filter((c) => c.statuses.length).map((c) => `${c.name} : ${chipsOf(c).filter((x) => x.keys.some((k) => coOn(c).includes(k))).length}`),
    `${t('livraison.prefs.alerts.private')} : ${v.livreurAlerts.length}`,
  ].join(' · ');
  const clockSum = `${t('livraison.prefs.alerts.clockSum', { first: v.suiviClock.firstHours, solve: v.suiviClock.solveHours })} · ${t('suivi.tries.sum', { n: v.suiviTries.calls, gap: v.suiviTries.gapMinutes })} · ${t('suivi.stuckPref.sum', { n: v.suiviStuck.days })}`;
  const set = (p: Partial<Prefs>) => setDraft({ ...v, ...p });
  const backups = (companies.data ?? []).filter((c) => c.active && c.kind !== 'own');
  const backupName = backups.find((c) => c.id === v.privateBackup.companyId)?.name ?? '';
  const who = [...WHO.filter((k) => v.changeCompany[k]).map((k) => t(`livraison.prefs.who.${k}`)), t('livraison.prefs.who.admin')];
  const rulesWho = [...WHO.filter((k) => v.rulesBy[k]).map((k) => t(`livraison.prefs.who.${k}`)), t('livraison.prefs.who.admin')];
  const missingBackup = v.privateBackup.on && !v.privateBackup.companyId;
  const flipAdv = () => {
    keepAdv(!adv);
    setAdv(!adv);
  };

  const summary: { icon: string; label: string; value: string; changed: boolean }[] = [
    { icon: 'truck', label: t('livraison.prefs.manualDefault'), value: t(v.manualDefault ? 'livraison.prefs.sum.manualOn' : 'livraison.prefs.sum.manualOff'), changed: v.manualDefault !== rec.manualDefault },
    { icon: 'usercog', label: t('livraison.prefs.change'), value: who.join(', '), changed: JSON.stringify(v.changeCompany) !== JSON.stringify(rec.changeCompany) },
    { icon: 'lock', label: t('livraison.prefs.strictLock'), value: t(v.strictLock ? 'livraison.prefs.sum.strictOn' : 'livraison.prefs.sum.strictOff'), changed: v.strictLock !== rec.strictLock },
    { icon: 'sliders', label: t('livraison.prefs.rules'), value: rulesWho.join(', '), changed: JSON.stringify(v.rulesBy) !== JSON.stringify(rec.rulesBy) },
    {
      icon: 'clock',
      label: t('livraison.prefs.backup'),
      value: v.privateBackup.on ? t('livraison.prefs.sum.backupOn', { hours: v.privateBackup.hours, company: backupName || '…' }) : t('livraison.prefs.sum.backupOff'),
      changed: v.privateBackup.on !== rec.privateBackup.on,
    },
    { icon: 'route', label: t('livraison.prefs.alerts.title'), value: `${clockSum} · ${alertSum}`, changed: JSON.stringify([...v.livreurAlerts].sort()) !== JSON.stringify([...rec.livreurAlerts].sort()) || JSON.stringify(v.suiviClock) !== JSON.stringify(rec.suiviClock) || JSON.stringify(v.suiviTries) !== JSON.stringify(rec.suiviTries) || v.suiviStuck.days !== rec.suiviStuck.days },
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
            <div className="pf-row pf-col">
              <span className="pf-text">
                <b>{t('livraison.prefs.rules')}</b>
                <small>{t('livraison.prefs.rulesHint')}</small>
              </span>
              <div className="pf-chips" role="group" aria-label={t('livraison.prefs.rules')}>
                {WHO.map((k) => (
                  <label key={k} className={`pf-chip ${v.rulesBy[k] ? 'on' : ''}`}>
                    <input type="checkbox" checked={v.rulesBy[k]} onChange={(e) => set({ rulesBy: { ...v.rulesBy, [k]: e.target.checked } })} />
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

          <section className="pf-group" aria-labelledby="pf-al-h">
            <h3 id="pf-al-h">{t('livraison.prefs.alerts.title')}</h3>
            <p className="pf-lead">{t('livraison.prefs.alerts.hint')}</p>
            <div className="pf-row">
              <span className="pf-text">
                <b>{t('suivi.stuckPref.t')}</b>
                <small>{t('suivi.stuckPref.hint')}</small>
              </span>
              <label className="pf-num">
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  inputMode="numeric"
                  aria-label={t('suivi.stuckPref.t')}
                  value={v.suiviStuck.days}
                  onChange={(e) => set({ suiviStuck: { days: Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 1))) } })}
                />
                <span>{t('suivi.stuckPref.days')}</span>
              </label>
            </div>
            <div className="pf-row">
              <span className="pf-text">
                <b>{t('suivi.tries.calls')}</b>
                <small>{t('suivi.tries.callsHint')}</small>
              </span>
              <span className="pf-clk">
                <label className="pf-num">
                  <span>{t('suivi.tries.n')}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    inputMode="numeric"
                    aria-label={t('suivi.tries.n')}
                    value={v.suiviTries.calls}
                    onChange={(e) => set({ suiviTries: { ...v.suiviTries, calls: Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1))) } })}
                  />
                </label>
                <label className="pf-num">
                  <span>{t('suivi.tries.gap')}</span>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    step={15}
                    inputMode="numeric"
                    aria-label={t('suivi.tries.gap')}
                    value={v.suiviTries.gapMinutes}
                    onChange={(e) => set({ suiviTries: { ...v.suiviTries, gapMinutes: Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))) } })}
                  />
                  <span>{t('suivi.tries.min')}</span>
                </label>
              </span>
            </div>
            <div className="pf-row">
              <span className="pf-text">
                <b>{t('livraison.prefs.alerts.clock')}</b>
                <small>{t('livraison.prefs.alerts.clockHint')}</small>
              </span>
              <span className="pf-clk">
                <label className="pf-num">
                  <span>{t('livraison.prefs.alerts.first')}</span>
                  <input
                    type="number"
                    min={0.25}
                    max={48}
                    step={0.25}
                    inputMode="decimal"
                    aria-label={t('livraison.prefs.alerts.first')}
                    value={v.suiviClock.firstHours}
                    onChange={(e) => set({ suiviClock: { ...v.suiviClock, firstHours: Math.max(0.25, Math.min(48, Number(e.target.value) || 0.25)) } })}
                  />
                  <span>{t('livraison.prefs.hours')}</span>
                </label>
                <label className="pf-num">
                  <span>{t('livraison.prefs.alerts.solve')}</span>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    step={1}
                    inputMode="numeric"
                    aria-label={t('livraison.prefs.alerts.solve')}
                    value={v.suiviClock.solveHours}
                    onChange={(e) => set({ suiviClock: { ...v.suiviClock, solveHours: Math.max(1, Math.min(168, Math.round(Number(e.target.value) || 1))) } })}
                  />
                  <span>{t('livraison.prefs.hours')}</span>
                </label>
              </span>
            </div>
            {!isAdmin ? null : alerts.isLoading ? (
              <Loading />
            ) : alerts.error ? (
              <ErrorBox error={alerts.error} onRetry={() => alerts.refetch()} />
            ) : (
              (alerts.data ?? []).map((c) => (
                <div key={c.companyId} className="pf-row pf-col">
                  <span className="pf-text">
                    <b>
                      <Icon name="truck" /> {c.name}
                    </b>
                    <small>{c.statuses.length ? t('livraison.prefs.alerts.coHint', { count: chipsOf(c).filter((x) => x.keys.some((k) => coOn(c).includes(k))).length }) : t('livraison.prefs.alerts.none')}</small>
                  </span>
                  {c.statuses.length > 0 && (
                    <div className="pf-chips pf-chips-s" role="group" aria-label={c.name}>
                      {chipsOf(c).map((x) => {
                        const on = x.keys.some((k) => coOn(c).includes(k));
                        const next = on ? coOn(c).filter((k) => !x.keys.includes(k)) : [...coOn(c), ...x.keys];
                        return (
                          <label key={x.keys[0]} className={`pf-chip ${on ? 'on' : ''}`}>
                            <input type="checkbox" checked={on} onChange={() => setCoDraft({ ...coDraft, [c.companyId]: next })} />
                            <Icon name="checkcircle" />
                            {x.label}
                            {x.parcels > 0 && <small className="pf-n ltr">{x.parcels}</small>}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
            <div className="pf-row pf-col">
              <span className="pf-text">
                <b>
                  <Icon name="bike" /> {t('livraison.prefs.alerts.private')}
                </b>
                <small>{t('livraison.prefs.alerts.privHint', { count: v.livreurAlerts.length })}</small>
              </span>
              {(['failed', 'returning'] as const).map((st) => (
                <div key={st} className="pf-say">
                  <span className="pf-say-h">{t(`livraison.prefs.alerts.${st}`)}</span>
                  <div className="pf-chips pf-chips-s" role="group" aria-label={t(`livraison.prefs.alerts.${st}`)}>
                    {LIVREUR_SAYS.filter((k) => k.startsWith(`${st}:`)).map((k) => {
                      const on = v.livreurAlerts.includes(k);
                      return (
                        <label key={k} className={`pf-chip ${on ? 'on' : ''}`}>
                          <input type="checkbox" checked={on} onChange={() => set({ livreurAlerts: flip(v.livreurAlerts, k) })} />
                          <Icon name="checkcircle" />
                          {sayLabel(k)}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
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
              <button type="button" className="btn" onClick={cancel}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn primary" disabled={missingBackup || busy} onClick={saveAll}>
                {busy ? '…' : t('livraison.prefs.save')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
