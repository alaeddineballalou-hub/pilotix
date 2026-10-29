// Réglages: Boutique · Dépôts · Commandes du site web (webhook) · Mise à jour automatique des colis (cron) · Meta Ads · Score client ·
// and for the store's owner only (a multi-shop server): delete the store and all its data.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, server, shopApi } from '../../lib/backend';
import { useSession } from '../../lib/session';
import { when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Field, Help, Icon, Loading, copyText } from '../../ui/kit';
import { CopyCode } from '../../ui/CopyCode';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { ConfirmButton, intOf, WilayaOptions } from './bits';
import { DepotForm, Wh } from './DepotForm';
import { publicBase, SAMPLE_ORDER } from './Canaux';
import { ScoreRulesCard } from './ScoreRules';

export function ReglagesPage() {
  const q = useRpc('admin.settings.get', {});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data!;
  return (
    <div className="settings-grid">
      <ShopCard s={s} />
      <StoreCodeCard />
      <DepotsCard />
      <WebCard webKey={s.webhook.key} />
      <CronCard cronKey={s.cron.key} last={s.lastSync} />
      <MetaCard meta={s.meta} />
      <ScoreRulesCard />
      <DeleteStoreCard />
    </div>
  );
}

/** The store's code (a multi-shop server): a partner (confirmation agency, marketer) types it to send the store a request. */
function StoreCodeCard() {
  const { t } = useTranslation();
  const { session } = useSession();
  const code = session?.shop?.code;
  if (!code || session?.shop?.demo) return null;
  return (
    <Card title={t('agency.store.codeTitle')} help={t('agency.store.codeHelp')} className="agx-codecard">
      <p className="agx-code-line">
        <CopyCode code={code} />
      </p>
      <p className="small muted">{t('agency.store.codeTextAll')}</p>
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <a className="btn small" href="#/agences">
          <Icon name="handshake" /> {t('nav.agences')}
        </a>
        <a className="btn small" href="#/marketers">
          <Icon name="trend" /> {t('nav.marketers')}
        </a>
      </span>
    </Card>
  );
}

/** Only the store's owner (the person who created it): the store and all its data are deleted for good. */
function DeleteStoreCard() {
  const { t } = useTranslation();
  const { session, logout, enter } = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shop = session?.shop;
  if (!shop || !shop.owner || shop.primary || shop.demo) return null;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await server.deleteStore(password, name);
      toast(t('admin.settings.deleted', { name: shop.name }), 'ok');
      // the person goes on in another store of theirs, else back to the login page
      if (r.next) enter(r.next);
      else logout();
      location.hash = '#/accueil';
    } catch (e: any) {
      setError(e?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('admin.settings.danger')} help={t('admin.settings.dangerHelp')}>
      <p className="small">{t('admin.settings.deleteText')}</p>
      <button type="button" className="btn danger" onClick={() => setOpen(true)}>
        {t('admin.settings.deleteStore')}
      </button>
      {open && (
        <Modal
          title={t('admin.settings.deleteTitle', { name: shop.name })}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {t('admin.cancel')}
              </button>
              <button type="button" className="btn danger" disabled={busy || !password || name.trim().toLowerCase() !== shop.name.trim().toLowerCase()} onClick={go}>
                {busy ? '…' : t('admin.settings.deleteForever')}
              </button>
            </>
          }
        >
          <p className="px-ban px-ban-bad">{t('admin.settings.deleteWarn')}</p>
          <Field label={t('admin.settings.deleteName', { name: shop.name })}>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t('admin.settings.deletePassword')}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          {error && <p className="form-err">{error}</p>}
        </Modal>
      )}
    </Card>
  );
}

type S = NonNullable<ReturnType<typeof useRpc<'admin.settings.get'>>['data']>;

function ShopCard({ s }: { s: S }) {
  const { t } = useTranslation();
  const companies = useRpc('admin.companies', {});
  const [v, setV] = useState({ name: s.shop.name, sav: s.shop.savPhone ?? '', from: s.shop.fromWilayaId, company: s.shop.defaultCompanyId, tpl: s.shop.whatsappTemplate, cancel: String(s.calls.cancelAfterNoAnswer) });
  const save = useAction('admin.shop.save', { success: t('admin.settings.saved') });
  return (
    <div className="card">
      <h2>{t('admin.settings.shop')}</h2>
      <label className="field">
        <span className="lab">
          {t('admin.settings.shopName')}
          <Help text={t('admin.settings.shopNameHelp')} />
        </span>
        <input value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </label>
      <label className="field">
        <span className="lab">
          {t('admin.settings.savPhone')}
          <Help text={t('admin.settings.savPhoneHelp')} />
        </span>
        <input type="tel" inputMode="tel" autoComplete="off" maxLength={40} placeholder="0550 12 34 56" value={v.sav} onChange={(e) => setV({ ...v, sav: e.target.value })} />
      </label>
      <Field label={t('admin.settings.fromWilaya')}>
        <select value={v.from} onChange={(e) => setV({ ...v, from: Number(e.target.value) })}>
          <WilayaOptions />
        </select>
      </Field>
      <label className="field">
        <span className="lab">
          {t('admin.settings.defaultCompany')}
          <Help text={t('admin.settings.defaultCompanyHelp')} />
        </span>
        <select value={v.company ?? ''} onChange={(e) => setV({ ...v, company: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('admin.settings.none')}</option>
          {companies.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lab">
          {t('admin.settings.autoCancel')}
          <Help text={t('admin.settings.autoCancelHelp')} />
        </span>
        <input type="number" min={0} max={30} step={1} value={v.cancel} onChange={(e) => setV({ ...v, cancel: e.target.value })} />
      </label>
      <label className="field">
        <span className="lab">
          {t('admin.settings.whatsapp')}
          <Help text={t('admin.settings.whatsappHelp')} />
        </span>
        <textarea rows={2} maxLength={500} value={v.tpl} onChange={(e) => setV({ ...v, tpl: e.target.value })} />
      </label>
      <div className="row end">
        <button
          className="btn primary"
          disabled={save.isPending || !v.name.trim()}
          onClick={() => save.mutate({ name: v.name.trim(), savPhone: v.sav.trim(), fromWilayaId: v.from, defaultCompanyId: v.company, whatsappTemplate: v.tpl.trim(), cancelAfterNoAnswer: Math.min(30, intOf(v.cancel)) })}
        >
          {t('admin.settings.save')}
        </button>
      </div>
    </div>
  );
}


function DepotsCard() {
  const { t } = useTranslation();
  const q = useRpc('admin.warehouses.list', {});
  const [edit, setEdit] = useState<Wh | 'new' | null>(null);
  return (
    <Card
      title={t('admin.settings.depots')}
      help={t('admin.settings.depotsHelp')}
      actions={
        <button className="btn" onClick={() => setEdit('new')}>
          {t('admin.settings.addDepot')}
        </button>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('admin.settings.colDepot')}</th>
                <th>{t('admin.settings.colCommune')}</th>
                <th>{t('admin.settings.colState')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((w) => (
                <tr key={w.id} className="clickable" tabIndex={0} onClick={() => setEdit(w)} onKeyDown={(e) => e.key === 'Enter' && setEdit(w)}>
                  <td data-l={t('admin.settings.colDepot')}>
                    <b>{w.name}</b>
                    {w.isDefault && <span className="chip">{t('admin.settings.isDefault')}</span>}
                  </td>
                  <td data-l={t('admin.settings.colCommune')}>{w.commune || '—'}</td>
                  <td data-l={t('admin.settings.colState')}>
                    <span className={`badge t-${w.active ? 'ok' : 'off'}`}>{w.active ? t('admin.settings.active') : t('admin.settings.inactive')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <DepotForm w={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function WebCard({ webKey }: { webKey: string }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [key, setKey] = useState(webKey);
  useEffect(() => setKey(webKey), [webKey]);
  const rotate = useAction('admin.webhook.rotate', { success: t('admin.settings.rotated'), onDone: (r) => setKey(r.key) });
  const sim = useAction('admin.webhook.simulate', { success: (r) => t('admin.settings.simulated', { ref: r.ref }) });
  const url = `${shopApi(publicBase())}/hooks/orders/site`;
  const copy = async (s: string) => {
    await copyText(s);
    toast(t('admin.settings.copied'), 'ok');
  };
  return (
    <div className="card">
      <h2>{t('admin.settings.web')}</h2>
      <button className="btn primary" disabled={sim.isPending} onClick={() => sim.mutate({})}>
        {t('admin.settings.simulate')}
      </button>
      <p className="muted small">{t('admin.settings.webHelp')}</p>
      <div className="field">
        <span className="lab">{t('admin.settings.address_')}</span>
        <div className="secret-box">
          <code className="ltr">{url}</code>
          <button className="btn small" onClick={() => copy(url)}>
            {t('admin.settings.copy')}
          </button>
        </div>
      </div>
      <div className="field">
        <span className="lab">{t('admin.settings.key')}</span>
        <div className="secret-box">
          {key ? <code className="ltr">{show ? key : `${key.slice(0, 4)}••••••••••••`}</code> : <span className="muted small">{t('admin.settings.noKey')}</span>}
          {key && (
            <>
              <button className="btn small" onClick={() => setShow(!show)}>
                {show ? t('admin.settings.hideKey') : t('admin.settings.showKey')}
              </button>
              <button className="btn small" onClick={() => copy(`${url}?key=${encodeURIComponent(key)}`)}>
                {t('admin.settings.copyFull')}
              </button>
            </>
          )}
          <ConfirmButton className="btn small danger" question={t('admin.settings.rotateConfirm')} onConfirm={() => rotate.mutate({})}>
            {t('admin.settings.rotate')}
          </ConfirmButton>
        </div>
      </div>
      <details>
        <summary>{t('admin.settings.sample')}</summary>
        <pre className="code ltr">{JSON.stringify(SAMPLE_ORDER, null, 2)}</pre>
        <p className="muted small">{t('admin.settings.sampleNote')}</p>
      </details>
    </div>
  );
}

function CronCard({ cronKey, last }: { cronKey: string; last: { at: string; checked: number; changed: number } | null }) {
  const { t } = useTranslation();
  const [key, setKey] = useState(cronKey);
  useEffect(() => setKey(cronKey), [cronKey]);
  const rotate = useAction('admin.cron.rotate', { success: t('admin.settings.rotated'), onDone: (r) => setKey(r.key) });
  const code = `# Pilotix : mise à jour des colis toutes les 30 min de 7 h à 22 h (heure d’Algérie)\nCRON_TZ=Africa/Algiers\n*/30 7-22 * * * curl -fsS -X POST "${shopApi(publicBase())}/hooks/cron?key=${key || 'CLE'}" >/dev/null`;
  return (
    <Card title={t('admin.settings.cron')} help={t('admin.settings.cronHelp')}>
      {last ? <div className="okbox">{t('admin.settings.lastSync', { when: when(last.at), checked: last.checked, changed: last.changed })}</div> : <p className="muted small">{t('admin.settings.noSync')}</p>}
      <details>
        <summary>{t('admin.settings.cronSetup')}</summary>
        <p className="muted small">{t('admin.settings.cronSetupHelp')}</p>
        <pre className="code ltr">{code}</pre>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={async () => {
              await copyText(code);
              toast(t('admin.settings.copied'), 'ok');
            }}
          >
            {t('admin.settings.cronCopy')}
          </button>
          <ConfirmButton className="btn small danger" question={t('admin.settings.rotateConfirm')} onConfirm={() => rotate.mutate({})}>
            {t('admin.settings.rotate')}
          </ConfirmButton>
        </div>
      </details>
    </Card>
  );
}

function MetaCard({ meta }: { meta: { adAccountId: string; connected: boolean } }) {
  const { t } = useTranslation();
  const [acc, setAcc] = useState(meta.adAccountId);
  const [token, setToken] = useState('');
  const save = useAction('admin.meta.save', {
    success: (r) => (r.test?.ok && r.test.name ? t('admin.settings.metaTestOk', { name: r.test.name }) : t('admin.settings.metaSaved')),
    onDone: (r) => {
      setToken('');
      if (r.test && !r.test.ok) toast(r.test.message ?? 'Meta', 'bad');
    },
  });
  const disc = useAction('admin.meta.disconnect', { success: t('admin.settings.metaDisconnected') });
  return (
    <Card title={t('admin.settings.meta')} help={t('admin.settings.metaHelp')}>
      {meta.connected ? <div className="okbox">{t('admin.settings.metaConnected')}</div> : <div className="warnbox">{t('admin.settings.metaNot')}</div>}
      <Field label={t('admin.settings.metaAccount')}>
        <input className="ltr" value={acc} inputMode="numeric" placeholder="act_1234567890" onChange={(e) => setAcc(e.target.value)} autoComplete="off" />
      </Field>
      <Field label={t('admin.settings.metaToken')}>
        {/* write-only: the stored token is never sent back to the app */}
        <input className="ltr" type="password" value={token} placeholder={meta.connected ? t('admin.settings.metaTokenKeep') : 'EAAG…'} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
      </Field>
      {backend.kind === 'demo' && <p className="muted small">{t('admin.settings.metaDemo')}</p>}
      <div className="row end" style={{ gap: 8 }}>
        {meta.connected && (
          <ConfirmButton className="btn ghost danger" question={t('admin.settings.metaDisconnectConfirm')} onConfirm={() => disc.mutate({})}>
            {t('admin.settings.metaDisconnect')}
          </ConfirmButton>
        )}
        <button className="btn primary" disabled={!acc.trim() || (!meta.connected && !token.trim()) || save.isPending} onClick={() => save.mutate({ adAccountId: acc.trim(), token: token.trim() || undefined })}>
          {t('admin.settings.metaSave')}
        </button>
      </div>
    </Card>
  );
}
