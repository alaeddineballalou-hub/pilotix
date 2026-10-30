// Dialogs of « Sociétés de livraison »: company form (keys, custom API), tariffs grid, stop desks, status mapping, send preview, test.
import { COURIER_KINDS, CourierKind, FOLLOW_STATUSES, WILAYAS } from '@pilotix/shared';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { da, dateTime, wilaya } from '../../lib/format';
import { Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Seg } from '../../ui/Sheet';
import './zr.css';
import { CourierLogo } from './CourierLogo';
import { cardTitle } from './carriers';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';

export type Company = Out<'delivery.companies'>[number];
type Kinds = Out<'delivery.kinds'>;

// ---------------------------------------------------------------- company form
export interface CompanyDraft {
  id?: number;
  name: string;
  kind: CourierKind;
  active: boolean;
  phone: string;
  settings: Record<string, any>;
}

export function CompanyForm({ initial, kinds, onClose, keysSet = [] }: { initial: CompanyDraft; kinds: Kinds; onClose: () => void; keysSet?: string[] }) {
  const { t } = useTranslation();
  const [d, setD] = useState<CompanyDraft>(initial);
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const info = kinds.kinds.find((k) => k.kind === d.kind)!;
  // made from a company's card (« API Livraison »): its logo, its own help, its API address set by Pilotix
  const card = d.settings.card ? kinds.cards.find((c) => c.id === d.settings.card && c.kind === d.kind) ?? null : null;
  const preset = new Set(Object.keys(card?.settings ?? {}));
  const set = (k: string, v: unknown) => setD((x) => ({ ...x, settings: { ...x.settings, [k]: v } }));
  const save = useAction('delivery.saveCompany', { success: t('livraison.saved'), onDone: onClose, silent: true });
  const isNew = !d.id;

  useEffect(() => {
    // defaults of a kind's settings
    for (const f of info.fields) if (f.type !== 'secret' && d.settings[f.key] === undefined && f.default !== undefined) set(f.key, f.default);
    if (d.kind === 'custom' && !d.settings.create) set('create', { method: 'POST', path: '', format: 'json', body: kinds.defaultTemplate, tracking_path: 'tracking' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.kind]);

  const submit = () => {
    setErr('');
    if (!d.name.trim()) return setErr(t('livraison.form.needName'));
    save.mutate(
      { id: d.id, name: d.name.trim(), kind: d.kind, active: d.active, phone: d.phone || null, settings: d.settings, secret },
      { onError: (e) => setErr(e.message) },
    );
  };

  const sub = (k: string, f: string) => (d.settings[k] ?? {})[f] ?? '';
  const setSub = (k: string, f: string, v: string) => set(k, { ...(d.settings[k] ?? {}), [f]: v });

  return (
    <Modal
      title={isNew ? (card ? t('livraison.form.connectTitle', { name: cardTitle(t, card) }) : t('livraison.form.newTitle', { kind: info.label })) : t('livraison.form.editTitle', { name: initial.name })}
      onClose={onClose}
      wide={d.kind === 'custom'}
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
      {card ? (
        <div className="px-coform-head">
          <CourierLogo card={card} />
          <p className="muted small">{card.help ?? info.help}</p>
        </div>
      ) : (
        <p className="muted small">{info.help}</p>
      )}
      <div className="grid2">
        <Field label={t('livraison.form.name')}>
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder={card?.title ?? info.label} />
        </Field>
        {!card && (
          <Field label={t('livraison.form.kind')}>
            <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as CourierKind })}>
              {COURIER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`livraison.kinds.${k}`, { defaultValue: kinds.kinds.find((x) => x.kind === k)?.label ?? k })}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('livraison.form.phone')}>
          <input value={d.phone} inputMode="tel" onChange={(e) => setD({ ...d, phone: e.target.value })} />
        </Field>
        <label className="row" style={{ alignSelf: 'end', gap: 8 }}>
          <input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> {t('livraison.form.active')}
        </label>
      </div>
      {info.fields.length > 0 && <h3>{t('livraison.form.keys')}</h3>}
      <div className="grid2">
        {info.fields
          .filter((f) => !preset.has(f.key))
          .map((f) =>
          f.type === 'secret' ? (
            <Field key={f.key} label={f.label} hint={keysSet.includes(f.key) ? t('livraison.form.keySaved') : t('livraison.form.keyMissing')}>
              <input type="password" autoComplete="new-password" value={secret[f.key] ?? ''} placeholder={keysSet.includes(f.key) ? '••••••••' : ''} onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })} />
            </Field>
          ) : f.type === 'check' ? (
            <label key={f.key} className="row" style={{ gap: 8, gridColumn: '1 / -1' }}>
              <input type="checkbox" checked={!!d.settings[f.key]} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}
            </label>
          ) : (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input value={d.settings[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} spellCheck={false} />
            </Field>
          ),
        )}
      </div>
      {d.kind === 'custom' && (
        <div className="custom-api">
          <h3>{t('livraison.custom.s1')}</h3>
          <Field label={t('livraison.custom.base')}>
            <input value={d.settings.base_url ?? ''} placeholder="https://api.societe.dz" onChange={(e) => set('base_url', e.target.value)} spellCheck={false} />
          </Field>
          <div className="grid3">
            <Field label={t('livraison.custom.authName')}>
              <input value={sub('auth', 'name')} placeholder="Authorization" onChange={(e) => setSub('auth', 'name', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.authPrefix')}>
              <input value={sub('auth', 'prefix')} placeholder="Bearer " onChange={(e) => setSub('auth', 'prefix', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.authName2')}>
              <input value={sub('auth', 'name2')} placeholder="X-Tenant" onChange={(e) => setSub('auth', 'name2', e.target.value)} />
            </Field>
          </div>
          <Field label={t('livraison.custom.testPath')}>
            <input value={d.settings.test_path ?? ''} placeholder="/api/v1/me" onChange={(e) => set('test_path', e.target.value)} />
          </Field>
          <h3>{t('livraison.custom.s2')}</h3>
          <div className="grid3">
            <Field label={t('livraison.custom.method')}>
              <select value={sub('create', 'method') || 'POST'} onChange={(e) => setSub('create', 'method', e.target.value)}>
                {['POST', 'PUT', 'GET'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={t('livraison.custom.path')}>
              <input value={sub('create', 'path')} placeholder="/api/v1/orders" onChange={(e) => setSub('create', 'path', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.format')}>
              <select value={sub('create', 'format') || 'json'} onChange={(e) => setSub('create', 'format', e.target.value)}>
                <option value="json">JSON</option>
                <option value="form">{t('livraison.custom.fmtForm')}</option>
                <option value="query">{t('livraison.custom.fmtQuery')}</option>
              </select>
            </Field>
          </div>
          <Field label={t('livraison.custom.body')} hint={t('livraison.custom.bodyHint')}>
            <textarea rows={12} className="mono" spellCheck={false} value={sub('create', 'body')} onChange={(e) => setSub('create', 'body', e.target.value)} />
          </Field>
          <details>
            <summary>{t('livraison.custom.placeholders')}</summary>
            <div className="ph-list">
              {kinds.placeholders.map(([k, label]) => (
                <div key={k}>
                  <code>{`{{${k}}}`}</code> <span className="muted">{label}</span>
                </div>
              ))}
            </div>
          </details>
          <div className="grid3">
            <Field label={t('livraison.custom.trackingPath')}>
              <input value={sub('create', 'tracking_path')} placeholder="data.tracking" onChange={(e) => setSub('create', 'tracking_path', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.idPath')}>
              <input value={sub('create', 'id_path')} placeholder="data.id" onChange={(e) => setSub('create', 'id_path', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.labelPath')}>
              <input value={sub('create', 'label_path')} placeholder="data.label" onChange={(e) => setSub('create', 'label_path', e.target.value)} />
            </Field>
          </div>
          <h3>{t('livraison.custom.s3')}</h3>
          <div className="grid3">
            <Field label={t('livraison.custom.method')}>
              <select value={sub('track', 'method') || 'GET'} onChange={(e) => setSub('track', 'method', e.target.value)}>
                {['GET', 'POST'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={t('livraison.custom.trackPath')}>
              <input value={sub('track', 'path')} placeholder="/api/v1/tracking/{{tracking}}" onChange={(e) => setSub('track', 'path', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.trackBody')}>
              <input value={sub('track', 'body')} placeholder={'{"tracking":"{{tracking}}"}'} onChange={(e) => setSub('track', 'body', e.target.value)} />
            </Field>
          </div>
          <div className="grid2">
            <Field label={t('livraison.custom.statusPath')}>
              <input value={sub('track', 'status_path')} placeholder="data.0.status" onChange={(e) => setSub('track', 'status_path', e.target.value)} />
            </Field>
            <Field label={t('livraison.custom.datePath')}>
              <input value={sub('track', 'date_path')} placeholder="data.0.date" onChange={(e) => setSub('track', 'date_path', e.target.value)} />
            </Field>
          </div>
          <h3>{t('livraison.custom.s4')}</h3>
          <div className="grid2">
            <Field label={t('livraison.custom.method')}>
              <select value={sub('cancel', 'method')} onChange={(e) => setSub('cancel', 'method', e.target.value)}>
                <option value="">{t('livraison.custom.noCancel')}</option>
                {['DELETE', 'POST', 'GET'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={t('livraison.custom.path')}>
              <input value={sub('cancel', 'path')} placeholder="/api/v1/orders/{{tracking}}" onChange={(e) => setSub('cancel', 'path', e.target.value)} />
            </Field>
          </div>
          <p className="muted small">{t('livraison.custom.statusesAfter')}</p>
        </div>
      )}
      {err && (
        <p className="form-err" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- tariffs
/**
 * « Tarifs »: a company with prices by API shows them as they are (they cannot be typed: Pilotix takes them again every
 * night, at connection and with « Mettre à jour maintenant »); any other company's prices are typed here. Its swap fees
 * above: ZR's from its API, else typed (50 / 100 DA at first).
 */
export function FeesModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.fees', { companyId: company.id });
  const info = useRpc('delivery.feesInfo', { companyId: company.id });
  const locked = !!info.data?.api;
  const [rows, setRows] = useState<Record<number, { home: string; desk: string; returnFee: string }>>({});
  const [filter, setFilter] = useState('');
  const save = useAction('delivery.saveFees', { success: t('livraison.fees.saved'), onDone: onClose });
  const imp = useAction('delivery.importFees', { success: (r) => t('livraison.fees.refreshed', { count: r.changed }) });
  useEffect(() => {
    if (q.data) setRows(Object.fromEntries(q.data.map((r) => [r.wilayaId, { home: r.home?.toString() ?? '', desk: r.desk?.toString() ?? '', returnFee: r.returnFee?.toString() ?? '' }])));
  }, [q.data]);
  const val = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.round(Number(s) || 0)));
  const fillAll = (k: 'home' | 'desk' | 'returnFee', v: string) => setRows((x) => Object.fromEntries(Object.entries(x).map(([w, r]) => [w, { ...r, [k]: r[k] || v }])));
  const list = WILAYAS.map((_, i) => i + 1).filter((w) => !filter || wilaya(w).toLowerCase().includes(filter.toLowerCase()));
  const byW = new Map((q.data ?? []).map((r) => [r.wilayaId, r]));
  const s = info.data;
  // the swap fees typed here (not ZR's: those come from its API)
  const [swapEdit, setSwapEdit] = useState<{ same: string; other: string } | null>(null);
  const swapSave = useAction('delivery.saveSwapFees', { success: t('livraison.fees.swapSaved'), onDone: () => setSwapEdit(null) });
  const swapNow = { same: String(s?.swap.same ?? ''), other: String(s?.swap.other ?? '') };
  const swapV = swapEdit ?? swapNow;
  const swapChanged = !!s && !s.swap.fromApi && (swapV.same !== swapNow.same || swapV.other !== swapNow.other) && swapV.same !== '' && swapV.other !== '';
  const saveSwap = () => swapSave.mutateAsync({ companyId: company.id, same: Number(swapV.same), other: Number(swapV.other) });
  // its « Surpoids » (not ZR's: ZR weighs each parcel and gives its weight fee by its API)
  const [wEdit, setWEdit] = useState<WeightValue | null>(null);
  const wSave = useAction('delivery.saveWeightRule', {
    success: (r) => (r.moved ? t('livraison.fees.weightSavedMoved', { count: r.moved }) : t('livraison.fees.weightSaved')),
    onDone: () => setWEdit(null),
  });
  const wNow = weightValue(s?.weight ?? null);
  const wV = wEdit ?? wNow;
  const wChanged = !!s?.weight && !s.weight.locked && weightKey(wV) !== weightKey(wNow) && (wV.on !== 'yes' || (wV.free !== '' && wV.per !== ''));
  const saveWeight = () =>
    wSave.mutateAsync({ companyId: company.id, freeKg: wV.on === 'yes' ? Number(wV.free) : Number(wNow.free) || 5, perKg: wV.on === 'yes' ? Number(wV.per) : 0, onReturn: wV.ret });
  return (
    <Modal
      title={t('livraison.fees.title', { name: company.name })}
      onClose={onClose}
      wide
      footer={
        locked ? (
          <>
            <span className="grow" />
            <button className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          </>
        ) : (
          <>
            <span className="grow" />
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              className="btn primary"
              disabled={save.isPending || swapSave.isPending || wSave.isPending || info.isLoading}
              onClick={async () => {
                if (swapChanged) await saveSwap().catch(() => null);
                if (wChanged) await saveWeight().catch(() => null);
                save.mutate({ companyId: company.id, rows: Object.entries(rows).map(([w, r]) => ({ wilayaId: Number(w), home: val(r.home), desk: val(r.desk), returnFee: val(r.returnFee) })) });
              }}
            >
              {t('common.save')}
            </button>
          </>
        )
      }
    >
      {locked && s ? (
        <div className="px-fees-api">
          <span className="px-fees-lock" aria-hidden="true">
            <Icon name="lock" />
          </span>
          <div>
            <b>{t('livraison.fees.apiTitle', { name: company.name })}</b>
            <p>{t('livraison.fees.apiHelp', { name: company.name })}</p>
            <p className={`px-fees-sync${s.error ? ' bad' : ''}`}>
              {s.error
                ? t('livraison.fees.error', { error: s.error })
                : s.syncedAt
                  ? `${t('livraison.fees.syncedAt', { when: dateTime(s.syncedAt) })} · ${s.changed ? t('livraison.fees.changed', { count: s.changed }) : t('livraison.fees.unchanged')}`
                  : t('livraison.fees.never')}
            </p>
          </div>
          <button className="btn small" disabled={imp.isPending} onClick={() => imp.mutate({ companyId: company.id })}>
            {imp.isPending ? t('common.loading') : t('livraison.fees.refresh')}
          </button>
        </div>
      ) : (
        <p className="muted small">{t('livraison.fees.help')}</p>
      )}
      {s && s.swap.same !== null && (
        <SwapFees
          company={company}
          swap={s.swap}
          value={swapV}
          onChange={setSwapEdit}
          action={
            // prices locked (no « Enregistrer » below): the swap fees have their own, once changed
            locked && swapChanged ? (
              <button className="btn small primary" disabled={swapSave.isPending} onClick={() => saveSwap().catch(() => null)}>
                {t('common.save')}
              </button>
            ) : null
          }
        />
      )}
      {s?.weight && (
        <WeightFees
          company={company}
          weight={s.weight}
          value={wV}
          onChange={setWEdit}
          action={
            // prices locked (no « Enregistrer » below): the « Surpoids » has its own, once changed
            locked && wChanged ? (
              <button className="btn small primary" disabled={wSave.isPending} onClick={() => saveWeight().catch(() => null)}>
                {t('common.save')}
              </button>
            ) : null
          }
        />
      )}
      <div className="row">
        <input type="search" aria-label={t('livraison.fees.search')} placeholder={t('livraison.fees.search')} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
        {!locked && <span className="muted small">{t('livraison.fees.fillHint')}</span>}
      </div>
      {q.isLoading || info.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : locked ? (
        <div className="tbl-wrap" style={{ maxHeight: '50vh', overflow: 'auto' }}>
          <table className="tbl px-fees-ro">
            <thead>
              <tr>
                <th>{t('livraison.fees.wilaya')}</th>
                {(['home', 'desk', 'returnFee'] as const).map((k) => (
                  <th key={k} className="num">
                    {t(`livraison.fees.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w}>
                  <td data-l={t('livraison.fees.wilaya')}>{wilaya(w)}</td>
                  {(['home', 'desk', 'returnFee'] as const).map((k) => (
                    <td key={k} className="num" data-l={t(`livraison.fees.${k}`)}>
                      <span className="ltr">{da(byW.get(w)?.[k] ?? null)}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: '55vh', overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('livraison.fees.wilaya')}</th>
                {(['home', 'desk', 'returnFee'] as const).map((k) => (
                  <th key={k} className="num">
                    {t(`livraison.fees.${k}`)}
                    <br />
                    <input aria-label={t('livraison.fees.fillEmpty')} className="ltr" inputMode="numeric" placeholder={t('livraison.fees.fillEmpty')} style={{ width: 96, height: 28, fontSize: 12 }} onKeyDown={(e) => e.key === 'Enter' && fillAll(k, (e.target as HTMLInputElement).value)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w}>
                  <td data-l={t('livraison.fees.wilaya')}>{wilaya(w)}</td>
                  {(['home', 'desk', 'returnFee'] as const).map((k) => (
                    <td key={k} className="num" data-l={t(`livraison.fees.${k}`)}>
                      <input
                        className="ltr"
                        inputMode="numeric"
                        style={{ width: 96, textAlign: 'end' }}
                        aria-label={`${wilaya(w)} ${t(`livraison.fees.${k}`)}`}
                        value={rows[w]?.[k] ?? ''}
                        onChange={(e) => setRows({ ...rows, [w]: { ...(rows[w] ?? { home: '', desk: '', returnFee: '' }), [k]: e.target.value.replace(/[^\d]/g, '') } })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/**
 * A company's swap fees (a parcel given to another customer): same wilaya, other wilaya — ZR's from its API (shown), else
 * typed here (saved with « Tarifs », or by `action` when the prices themselves are locked).
 */
function SwapFees({ company, swap, value, onChange, action }: { company: Company; swap: Out<'delivery.feesInfo'>['swap']; value: { same: string; other: string }; onChange: (v: { same: string; other: string }) => void; action?: ReactNode }) {
  const { t } = useTranslation();
  const field = (label: string, k: 'same' | 'other') => (
    <label className="px-swapfee">
      <span>{label}</span>
      <span className="px-swapfee-in">
        <input className="ltr" inputMode="numeric" value={value[k]} aria-label={`${t('livraison.fees.swapTitle')} · ${label}`} onChange={(e) => onChange({ ...value, [k]: e.target.value.replace(/[^\d]/g, '') })} />
        <small>DA</small>
      </span>
    </label>
  );
  return (
    <section className="px-swapfees">
      <div className="px-swapfees-head">
        <b>{t('livraison.fees.swapTitle')}</b>
        <small>{t('livraison.fees.swapHelp')}</small>
      </div>
      {swap.fromApi ? (
        <div className="px-swapfees-row">
          <span className="px-swapfee">
            <span>{t('livraison.fees.swapSame')}</span>
            <b className="ltr">{da(swap.same)}</b>
          </span>
          <span className="px-swapfee">
            <span>{t('livraison.fees.swapOther')}</span>
            <b className="ltr">{da(swap.other)}</b>
          </span>
          <small className="px-swapfees-api">
            <Icon name="lock" /> {t('livraison.fees.swapApi', { name: company.name })}
          </small>
        </div>
      ) : (
        <div className="px-swapfees-row">
          {field(t('livraison.fees.swapSame'), 'same')}
          {field(t('livraison.fees.swapOther'), 'other')}
          {action}
        </div>
      )}
    </section>
  );
}

type WeightInfo = NonNullable<Out<'delivery.feesInfo'>['weight']>;
/** « Surpoids » being typed: does the company take one (not decided yet: neither), free kilos, DA a kilo above, on the return. */
type WeightValue = { on: 'yes' | 'no' | 'unset'; free: string; per: string; ret: boolean };
const weightValue = (w: WeightInfo | null): WeightValue =>
  !w || !w.set
    ? { on: 'unset', free: '5', per: '50', ret: true }
    : w.perKg > 0
      ? { on: 'yes', free: String(w.freeKg), per: String(w.perKg), ret: w.onReturn }
      : { on: 'no', free: String(w.freeKg || 5), per: '50', ret: w.onReturn };
const weightKey = (v: WeightValue) => (v.on === 'yes' ? `yes:${v.free}:${v.per}:${v.ret}` : v.on);

/**
 * A company's « Surpoids »: what it takes above some kilos — counted in whole kilos like ZR (5 kg free → 6 kg: one kilo
 * above) — on the delivery and, ticked, on the return too. ZR's is its own (it weighs each parcel, its API gives the fee).
 */
function WeightFees({ company, weight, value, onChange, action }: { company: Company; weight: WeightInfo; value: WeightValue; onChange: (v: WeightValue) => void; action?: ReactNode }) {
  const { t } = useTranslation();
  const free = Number(value.free) || 0;
  const per = Number(value.per) || 0;
  const field = (label: string, k: 'free' | 'per', unit: string) => (
    <label className="px-swapfee">
      <span>{label}</span>
      <span className="px-swapfee-in">
        <input className="ltr" inputMode="numeric" value={value[k]} aria-label={`${t('livraison.fees.weightTitle')} · ${label}`} onChange={(e) => onChange({ ...value, [k]: e.target.value.replace(/[^\d]/g, '').slice(0, 6) })} />
        <small>{unit}</small>
      </span>
    </label>
  );
  return (
    <section className="px-swapfees px-weightfees">
      <div className="px-swapfees-head">
        <b>{t('livraison.fees.weightTitle')}</b>
        <small>{t('livraison.fees.weightHelp')}</small>
      </div>
      {weight.locked ? (
        <div className="px-swapfees-row">
          <span className="px-swapfee">
            <span>{t('livraison.fees.weightFree')}</span>
            <b className="ltr">{t('livraison.fees.weightKg', { kg: weight.freeKg })}</b>
          </span>
          <span className="px-swapfee">
            <span>{t('livraison.fees.weightPer')}</span>
            <b className="ltr">{da(weight.perKg)}</b>
          </span>
          <span className="px-swapfee">
            <span>{t('livraison.fees.weightReturn')}</span>
            <b>{weight.onReturn ? t('livraison.fees.weightYes') : t('livraison.fees.weightNo')}</b>
          </span>
          <small className="px-swapfees-api">
            <Icon name="lock" /> {t('livraison.fees.weightApi', { name: company.name })}
          </small>
        </div>
      ) : (
        <div className="px-weightfees-body">
          <div className="px-weightfees-ask">
            <span>{t('livraison.fees.weightAsk')}</span>
            <Seg<WeightValue['on']>
              label={t('livraison.fees.weightAsk')}
              value={value.on}
              onChange={(on) => onChange({ ...value, on })}
              items={[
                { k: 'no', label: t('livraison.fees.weightNo') },
                { k: 'yes', label: t('livraison.fees.weightYes') },
              ]}
            />
            {value.on === 'unset' && <small className="px-weightfees-unset">{t('livraison.fees.weightUnset')}</small>}
          </div>
          {value.on === 'yes' && (
            <div className="px-swapfees-row">
              {field(t('livraison.fees.weightFree'), 'free', 'kg')}
              {field(t('livraison.fees.weightPer'), 'per', 'DA')}
              <label className="px-weightfees-ret">
                <input type="checkbox" checked={value.ret} onChange={(e) => onChange({ ...value, ret: e.target.checked })} />
                <span>{t('livraison.fees.weightReturn')}</span>
              </label>
            </div>
          )}
          {value.on === 'yes' && per > 0 && (
            <small className="px-weightfees-ex">
              {t(value.ret ? 'livraison.fees.weightExampleRet' : 'livraison.fees.weightExample', { kg: free + 2, fee: da(2 * per) })}
            </small>
          )}
          {action && <div className="px-weightfees-act">{action}</div>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- alerts
/**
 * « Alertes » of one company: which of its statuses send an order to Suivi › Alertes — one or many (the same choice as
 * Préférences › Alertes du Suivi). A status written the same way under a few codes is one choice.
 */
export function AlertsModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.alertStatuses', {});
  const save = useAction('delivery.saveAlertStatuses', { success: t('livraison.alertsCo.saved'), onDone: onClose });
  const mine = q.data?.find((c) => c.companyId === company.id);
  const chips = useMemo(() => {
    const by = new Map<string, { key: string; label: string; codes: string[]; parcels: number; on: boolean }>();
    for (const x of mine?.statuses ?? []) {
      const label = x.label || x.status;
      const key = label.toLowerCase();
      const g = by.get(key) ?? { key, label, codes: [], parcels: 0, on: false };
      g.codes.push(x.status);
      g.parcels += x.parcels;
      g.on = g.on || x.alert;
      by.set(key, g);
    }
    return [...by.values()];
  }, [mine]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(chips.filter((c) => c.on).map((c) => c.key));
  const flip = (k: string) => {
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };
  const codes = chips.filter((c) => chosen.has(c.key)).flatMap((c) => c.codes);
  return (
    <Modal
      title={t('livraison.alertsCo.title', { name: company.name })}
      onClose={onClose}
      wide
      footer={
        <>
          <small className="muted">{t('livraison.alertsCo.also')}</small>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending || !mine || picked === null} onClick={() => save.mutate({ companyId: company.id, alert: codes })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('livraison.alertsCo.help', { name: company.name })}</p>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !chips.length ? (
        <Empty>{t('livraison.alertsCo.empty', { name: company.name })}</Empty>
      ) : (
        <>
          <ul className="px-alerts">
            {chips.map((c) => {
              const on = chosen.has(c.key);
              return (
                <li key={c.key}>
                  <label className={`px-alert${on ? ' on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => flip(c.key)} />
                    <span>
                      <b>{c.label}</b>
                      <small>{t('livraison.alertsCo.parcels', { count: c.parcels })}</small>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className={`small px-alerts-sum${chosen.size ? '' : ' none'}`}>{chosen.size ? t('livraison.alertsCo.on', { count: chosen.size }) : t('livraison.alertsCo.none', { name: company.name })}</p>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- stop desks
export function StopdesksModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const [w, setW] = useState<number | ''>('');
  const q = useRpc('delivery.stopdesks', { companyId: company.id, wilayaId: w || undefined });
  const imp = useAction('delivery.importStopdesks', { success: (r) => t('livraison.desks.imported', { count: r.imported }) });
  const add = useAction('delivery.saveStopdesk', { success: t('livraison.saved') });
  const del = useAction('delivery.removeStopdesk', { success: t('livraison.desks.removed') });
  const [nd, setNd] = useState({ wilayaId: 16, commune: '', name: '', address: '', extId: '' });
  const api = company.kind === 'zr' || company.kind === 'yalidine' || company.kind === 'noest';
  return (
    <Modal title={t('livraison.desks.title', { name: company.name })} onClose={onClose} wide>
      <div className="row">
        <select value={w} onChange={(e) => setW(e.target.value ? Number(e.target.value) : '')} style={{ maxWidth: 240 }} aria-label={t('livraison.fees.wilaya')}>
          <option value="">{t('livraison.desks.allWilayas')}</option>
          {WILAYAS.map((_, i) => (
            <option key={i} value={i + 1}>
              {wilaya(i + 1)}
            </option>
          ))}
        </select>
        <span className="grow" />
        {api && (
          <button className="btn" disabled={imp.isPending} onClick={() => imp.mutate({ companyId: company.id })}>
            {imp.isPending ? t('common.loading') : t('livraison.desks.import')}
          </button>
        )}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data?.length ? (
        <Empty>{t('livraison.desks.empty')}</Empty>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: '45vh', overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('livraison.fees.wilaya')}</th>
                <th>{t('livraison.desks.commune')}</th>
                <th>{t('livraison.desks.name')}</th>
                <th>{t('livraison.desks.code')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((d) => (
                <tr key={d.id}>
                  <td data-l={t('livraison.fees.wilaya')}>{wilaya(d.wilayaId)}</td>
                  <td data-l={t('livraison.desks.commune')}>{d.commune}</td>
                  <td data-l={t('livraison.desks.name')}>
                    <b>{d.name}</b>
                    {d.address && <small>{d.address}</small>}
                  </td>
                  <td data-l={t('livraison.desks.code')}>
                    <span className="ltr muted">{d.extId ?? '—'}</span>
                  </td>
                  <td>
                    <button className="btn small ghost" onClick={() => del.mutate({ id: d.id })}>
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>{t('livraison.desks.add')}</h3>
      <div className="grid3">
        <Field label={t('livraison.fees.wilaya')}>
          <select value={nd.wilayaId} onChange={(e) => setNd({ ...nd, wilayaId: Number(e.target.value) })}>
            {WILAYAS.map((_, i) => (
              <option key={i} value={i + 1}>
                {wilaya(i + 1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('livraison.desks.commune')}>
          <input value={nd.commune} onChange={(e) => setNd({ ...nd, commune: e.target.value })} />
        </Field>
        <Field label={t('livraison.desks.name')}>
          <input value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} />
        </Field>
        <Field label={t('livraison.desks.address')}>
          <input value={nd.address} onChange={(e) => setNd({ ...nd, address: e.target.value })} />
        </Field>
        <Field label={t('livraison.desks.code')} hint={t('livraison.desks.codeHint')}>
          <input value={nd.extId} onChange={(e) => setNd({ ...nd, extId: e.target.value })} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <button
            className="btn primary"
            disabled={!nd.name.trim() || add.isPending}
            onClick={() => add.mutate({ companyId: company.id, ...nd, extId: nd.extId || null }, { onSuccess: () => setNd({ ...nd, name: '', commune: '', address: '', extId: '' }) })}
          >
            {t('common.add')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- status mapping
export function StatusesModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.statuses', { companyId: company.id });
  const [map, setMap] = useState<Record<string, string | undefined>>({});
  const save = useAction('delivery.saveStatuses', { success: t('livraison.statuses.saved'), onDone: onClose });
  useEffect(() => {
    if (q.data) setMap(Object.fromEntries(q.data.filter((r) => r.own !== undefined).map((r) => [r.status, r.own])));
  }, [q.data]);
  const AUTO = '__auto';
  return (
    <Modal
      title={t('livraison.statuses.title', { name: company.name })}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ companyId: company.id, map: Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined)) as Record<string, string> })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('livraison.statuses.help')}</p>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data?.length ? (
        <Empty>{t('livraison.statuses.empty')}</Empty>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: '55vh', overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('livraison.statuses.theirs', { name: company.name })}</th>
                <th className="num">{t('livraison.statuses.parcels')}</th>
                <th>{t('livraison.statuses.ours')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.status}>
                  <td data-l={t('livraison.statuses.theirs', { name: company.name })}>
                    {r.label && r.label !== r.status ? (
                      <>
                        <b>{r.label}</b> <small className="muted ltr">{r.status}</small>
                      </>
                    ) : (
                      r.status
                    )}
                  </td>
                  <td className="num" data-l={t('livraison.statuses.parcels')}>
                    {r.parcels || '—'}
                  </td>
                  <td data-l={t('livraison.statuses.ours')}>
                    <select
                      value={map[r.status] === undefined ? AUTO : map[r.status]}
                      onChange={(e) => setMap({ ...map, [r.status]: e.target.value === AUTO ? undefined : e.target.value })}
                      aria-label={r.status}
                    >
                      <option value={AUTO}>{t('livraison.statuses.auto', { status: r.auto ? t(`status.follow.${r.auto}`) : t('livraison.statuses.nothing') })}</option>
                      <option value="">{t('livraison.statuses.nothing')}</option>
                      {FOLLOW_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`status.follow.${s}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- send preview
export function PreviewModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const [ref, setRef] = useState('');
  const [orderId, setOrderId] = useState<number | undefined>();
  const q = useRpc('delivery.preview', { companyId: company.id, orderId });
  const find = async () => {
    const r = await rpc('orders.list', { q: ref.trim(), pageSize: 1, tickets: 'include' });
    if (r.rows[0]) setOrderId(r.rows[0].id);
    else toast(t('livraison.preview.notFound'), 'bad');
  };
  const body = useMemo(() => (q.data ? JSON.stringify(q.data.request ? q.data.request : { ...q.data.parcel, items: q.data.items }, null, 2) : ''), [q.data]);
  return (
    <Modal title={t('livraison.preview.title', { name: company.name })} onClose={onClose} wide>
      <p className="muted small">{t('livraison.preview.help')}</p>
      <div className="row">
        <input placeholder={t('livraison.preview.ref')} value={ref} onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && find()} style={{ maxWidth: 260 }} />
        <button className="btn small" onClick={find}>
          {t('livraison.preview.show')}
        </button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : q.data ? (
        <>
          <p>
            {t('livraison.preview.order')} <b className="ltr">{q.data.ref}</b>
            {q.data.request && (
              <>
                {' '}
                · <b className="ltr">{q.data.request.method}</b> <span className="ltr">{q.data.request.url}</span>
              </>
            )}
          </p>
          {q.data.error && <p className="form-err">{q.data.error}</p>}
          <pre className="mono ltr" style={{ maxHeight: '50vh', overflow: 'auto', background: 'var(--raise)', padding: 12, borderRadius: 10, fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
            {body}
          </pre>
        </>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------- ZR from Pilotix: instant statuses, service prices
const HOURS = new Set(['officeHoldingFreeHours']);

/** What Pilotix does with ZR (so its website is not needed), instant status updates, and ZR's service prices. */
export function ZrModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.zr', { companyId: company.id });
  const on = useAction('delivery.webhookOn', { success: t('livraison.zr.hookOnDone', { name: company.name }) });
  const off = useAction('delivery.webhookOff', { success: t('livraison.zr.hookOffDone') });
  const d = q.data;
  const name = company.name;
  return (
    <Modal
      sheet
      title={t('livraison.zr.title', { name })}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <ul className="lvz-does">
        {(['send', 'labels', 'bags', 'changes', 'claims', 'exchanges', 'journey', 'pay'] as const).map((k) => (
          <li key={k}>
            <Icon name="check" /> {t(`livraison.zr.does.${k}`, { name })}
          </li>
        ))}
      </ul>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : d ? (
        <>
          <section className="lvz-sec">
            <h3>{t('livraison.zr.hookTitle')}</h3>
            <p className="muted small">{t('livraison.zr.hookHelp', { name })}</p>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={`badge ${d.webhook.on ? 't-ok' : 't-off'}`}>{d.webhook.on ? t('livraison.zr.hookOn') : t('livraison.zr.hookOff')}</span>
              {d.webhook.on ? (
                <button className="btn small" disabled={off.isPending} onClick={() => off.mutate({ companyId: company.id })}>
                  {t('livraison.zr.turnOff')}
                </button>
              ) : (
                <button className="btn small primary" disabled={on.isPending} onClick={() => on.mutate({ companyId: company.id })}>
                  {t('livraison.zr.turnOn')}
                </button>
              )}
            </div>
            {(d.webhook.url || d.hookUrl) && (
              <p className="muted small ltr" style={{ overflowWrap: 'anywhere' }}>
                {d.webhook.url ?? d.hookUrl}
              </p>
            )}
            {d.webhook.error && <p className="badbox">{d.webhook.error}</p>}
          </section>
          <section className="lvz-sec">
            <h3>{t('livraison.zr.pricesTitle', { name })}</h3>
            {d.servicesError && <p className="badbox">{d.servicesError}</p>}
            {d.services && (
              <table className="tbl lvz-prices">
                <tbody>
                  {d.services.map((s) => (
                    <tr key={s.key}>
                      <td>{t(`livraison.zr.svc.${s.key}`, { defaultValue: s.label })}</td>
                      <td className="num ltr">{HOURS.has(s.key) ? t('livraison.zr.hours', { n: s.price }) : da(s.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------- any other company: live updates and what Pilotix does
const LIVE_DOES = ['send', 'track', 'change', 'cancel', 'exchange', 'askReturn', 'retry', 'note', 'label', 'fees', 'desks'] as const;

/** What Pilotix does with this company (so its website is not needed), and its instant status updates when it has them. */
export function LiveModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const { t } = useTranslation();
  const kinds = useRpc('delivery.kinds', {});
  const q = useRpc('delivery.live', { companyId: company.id });
  const off = useAction('delivery.webhookOff', { success: t('livraison.zr.hookOffDone') });
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const k = kinds.data?.kinds.find((x) => x.kind === company.kind);
  const name = company.name;
  const has = (d: (typeof LIVE_DOES)[number]) =>
    !!k &&
    (d === 'send' || d === 'track'
      ? k.api
      : d === 'change'
        ? !!k.change
        : d === 'cancel'
          ? k.cancel
          : d === 'exchange'
            ? !!k.exchange
            : d === 'askReturn'
              ? !!k.askReturn
              : d === 'retry'
                ? !!k.retry
                : d === 'note'
                  ? !!k.note
                  : d === 'label'
                    ? k.label_
                    : d === 'fees'
                      ? k.fees
                      : k.desks);
  const turnOn = async () => {
    setBusy(true);
    try {
      const r = await rpc('delivery.webhookOn', { companyId: company.id });
      if (r.manual) setUrl(r.url);
      else toast(t('livraison.zr.hookOnDone', { name }), 'ok');
      q.refetch();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const d = q.data;
  return (
    <Modal
      sheet
      title={t('livraison.live.title', { name })}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <ul className="lvz-does">
        {LIVE_DOES.filter(has).map((x) => (
          <li key={x}>
            <Icon name="check" /> {t(`livraison.live.does.${x}`, { name })}
          </li>
        ))}
      </ul>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : d ? (
        <section className="lvz-sec">
          <h3>{t('livraison.zr.hookTitle')}</h3>
          {!d.mode ? (
            <p className="muted small">{t('livraison.live.poll', { name, n: d.pollMinutes })}</p>
          ) : (
            <>
              <p className="muted small">{d.mode === 'manual' ? t('livraison.live.manualHelp', { name }) : t('livraison.zr.hookHelp', { name })}</p>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className={`badge ${d.on ? 't-ok' : 't-off'}`}>{d.on ? t('livraison.zr.hookOn') : t('livraison.zr.hookOff')}</span>
                {d.on && (
                  <button className="btn small" disabled={off.isPending} onClick={() => off.mutate({ companyId: company.id }, { onSuccess: () => (setUrl(null), q.refetch()) })}>
                    {t('livraison.zr.turnOff')}
                  </button>
                )}
                <button className="btn small primary" disabled={busy} onClick={turnOn}>
                  {d.on && d.mode === 'manual' ? t('livraison.live.newUrl') : t('livraison.zr.turnOn')}
                </button>
              </div>
              {url && (
                <div className="lvz-url">
                  <p className="small">{t('livraison.live.paste', { name })}</p>
                  <p className="ltr small lvz-url-v" style={{ overflowWrap: 'anywhere' }}>
                    <code>{url}</code>
                  </p>
                  <button className="btn small" onClick={() => navigator.clipboard?.writeText(url).then(() => toast(t('livraison.live.copied'), 'ok'))}>
                    {t('livraison.live.copy')}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      ) : null}
    </Modal>
  );
}
