// Landing pages › Réglages: the Meta pixel (browser + Conversions API, and when a real order counts as a Purchase),
// abandoned orders (after how long they go to Commandes), the automations, and the log of what was sent to Meta.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, serverUrl, type Out } from '../../lib/backend';
import { OwnDomain } from './Domain';
import { PixelsCard } from './Pixels';
import { WHATSAPP_DEFAULT, WHATSAPP_VARS } from '@pilotix/shared';

import { da, dateTime } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { copyText, Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SaveBar } from '../ai/agent';

/** the message as a customer would send it (an example order) */
const WA_EX: Record<string, string> = { nom: 'أمينة بوضياف', produit: 'عربة أطفال قابلة للطي', quantite: '1', total: '10450.00 دج', telephone: '0661234567', wilaya: 'الجزائر', commune: 'باب الزوار' };
const waExample = (m: string) => m.replace(/\{(\w+)\}/g, (x, k) => WA_EX[k] ?? x);

type PurchaseAt = 'order' | 'confirmed' | 'delivered';

export function Settings() {
  const { t } = useTranslation();
  const { session } = useSession();
  // a shop of a multi-shop server, its administrator: its own domain name for its pages
  const ownDomain = backend.kind === 'remote' && !!session?.isAdmin && !!session.shop && !session.shop.demo;
  const q = useRpc('landing.settings.get', {}, { refetchOnWindowFocus: false });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <PixelsCard />
      <Form key={JSON.stringify(q.data.settings)} data={q.data} />
      {ownDomain && <OwnDomain />}
      <Events />
      <p className="pd-note">{t('landing.set.footer')}</p>
    </>
  );
}

function Form({ data }: { data: Out<'landing.settings.get'> }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const [f, setF] = useState({ ...data.settings, abandonAfterMin: String(data.settings.abandonAfterMin) });
  const [token, setToken] = useState('');
  const [tsSecret, setTsSecret] = useState('');
  const save = useAction('landing.settings.save', {
    success: t('landing.set.saved'),
    onDone: () => {
      setToken('');
      setTsSecret('');
    },
  });
  const unignore = useAction('landing.ignore', { success: t('landing.set.restored') });
  const dirty = JSON.stringify({ ...data.settings, abandonAfterMin: String(data.settings.abandonAfterMin) }) !== JSON.stringify(f) || !!token || !!tsSecret;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const values = () => ({
    pixelId: f.pixelId.trim(),
    testEventCode: f.testEventCode.trim(),
    purchaseAt: f.purchaseAt,
    abandonAfterMin: Math.max(5, Math.min(1440, Math.round(Number(f.abandonAfterMin) || 20))),
    autoCreate: f.autoCreate,
    storeSlug: f.storeSlug.trim().replace(/^-+|-+$/g, ''),
    turnstileSiteKey: f.turnstileSiteKey.trim(),
    whatsapp: { on: f.whatsapp.on, number: f.whatsapp.number.trim(), label: f.whatsapp.label.trim(), message: f.whatsapp.message.trim() },
  });
  const submit = () => save.mutate({ ...values(), capiToken: token.trim() ? token.trim() : '', turnstileSecret: tsSecret.trim() ? tsSecret.trim() : '' });
  /** Cloudflare's secret key removed: the check is off until a new one is saved */
  const removeTs = () => window.confirm(t('landing.set.tsRemoveAsk')) && save.mutate({ ...values(), turnstileSiteKey: '', capiToken: '', turnstileSecret: null });
  /** a wrong token: removed, the Meta Ads token is used again (if any) */
  const removeToken = () => window.confirm(t('landing.set.removeTokenAsk')) && save.mutate({ ...values(), capiToken: null });
  const capiOk = data.capi.own || data.capi.ads;
  return (
    <form
      className="lp-set"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <section className="card">
        <h2>
          <Icon name="megaphone" /> {t('landing.set.meta')}
        </h2>
        <p className="pd-note">{t('landing.set.metaHelp')}</p>
        <Field label={t('landing.set.testCode')} hint={t('landing.set.testCodeHint')}>
          <input className="ltr" value={f.testEventCode} placeholder="TEST12345" onChange={(e) => set('testEventCode', e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
        </Field>
        <Field
          label={t('landing.set.token')}
          hint={
            <>
              <span className={`chip ${capiOk ? 'lp-on' : 'lp-warn'}`}>{data.capi.own ? t('landing.set.tokenOwn') : data.capi.ads ? t('landing.set.tokenAds') : t('landing.set.tokenNone')}</span>{' '}
              {admin ? t('landing.set.tokenHint') : t('landing.set.tokenAdmin')}
            </>
          }
        >
          <div className="lp-copy">
            <input className="ltr" type="password" autoComplete="off" disabled={!admin} value={token} placeholder={data.capi.own ? '••••••••' : 'EAAB…'} onChange={(e) => setToken(e.target.value)} />
            {admin && data.capi.own && (
              <button type="button" className="btn small ghost danger" onClick={removeToken}>
                {t('landing.set.removeToken')}
              </button>
            )}
          </div>
        </Field>
        <h3>{t('landing.set.purchaseAt')}</h3>
        <div className="lp-levels" role="radiogroup">
          {(['order', 'confirmed', 'delivered'] as PurchaseAt[]).map((k) => (
            <label key={k} className={`lp-level ${f.purchaseAt === k ? 'on' : ''}`}>
              <input type="radio" name="pa" checked={f.purchaseAt === k} onChange={() => set('purchaseAt', k)} />
              <b>
                {t(`landing.set.pa.${k}`)}
                {k === 'confirmed' && <span className="chip lp-on">{t('landing.set.recommended')}</span>}
              </b>
              <small>{t(`landing.set.paHelp.${k}`)}</small>
            </label>
          ))}
        </div>
        <div className="lp-never">
          <Icon name="ban" /> {t('landing.set.never')}
        </div>
        <h3>{t('landing.set.urlParams')}</h3>
        <p className="pd-note">{t('landing.set.urlParamsHelp')}</p>
        <div className="lp-copy">
          <code className="ltr">{data.urlParams}</code>
          <button type="button" className="btn small" onClick={async () => (await copyText(data.urlParams)) && toast(t('landing.copied'), 'ok')}>
            <Icon name="copy" /> {t('landing.set.copy')}
          </button>
        </div>
        <h3>{t('landing.set.ttParams')}</h3>
        <p className="pd-note">{t('landing.set.ttParamsHelp')}</p>
        <div className="lp-copy">
          <code className="ltr">{data.tiktokUrlParams}</code>
          <button type="button" className="btn small" onClick={async () => (await copyText(data.tiktokUrlParams)) && toast(t('landing.copied'), 'ok')}>
            <Icon name="copy" /> {t('landing.set.copy')}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>
          <Icon name="whatsapp" /> {t('landing.wa.title')}
        </h2>
        <p className="pd-note">{t('landing.wa.help')}</p>
        <label className="lp-switch">
          <input type="checkbox" checked={f.whatsapp.on} onChange={(e) => set('whatsapp', { ...f.whatsapp, on: e.target.checked })} />
          <span>
            <b>{t('landing.wa.on')}</b>
            <small>{t('landing.wa.onHelp')}</small>
          </span>
        </label>
        {f.whatsapp.on && (
          <>
            <div className="grid2">
              <Field label={t('landing.wa.number')} hint={t('landing.wa.numberHint')}>
                <input className="ltr" type="tel" inputMode="tel" value={f.whatsapp.number} placeholder="0661 23 45 67" onChange={(e) => set('whatsapp', { ...f.whatsapp, number: e.target.value })} />
              </Field>
              <Field label={t('landing.wa.label')}>
                <input dir="auto" value={f.whatsapp.label} maxLength={60} placeholder={WHATSAPP_DEFAULT.label} onChange={(e) => set('whatsapp', { ...f.whatsapp, label: e.target.value })} />
              </Field>
            </div>
            <Field label={t('landing.wa.message')} hint={t('landing.wa.messageHint')}>
              <textarea dir="auto" rows={4} maxLength={800} value={f.whatsapp.message} placeholder={WHATSAPP_DEFAULT.message} onChange={(e) => set('whatsapp', { ...f.whatsapp, message: e.target.value })} />
            </Field>
            <div className="lp-wa-vars">
              {WHATSAPP_VARS.map((k) => (
                <button key={k} type="button" className="chip" onClick={() => set('whatsapp', { ...f.whatsapp, message: `${f.whatsapp.message}${f.whatsapp.message && !/\s$/.test(f.whatsapp.message) ? ' ' : ''}{${k}}` })} title={t(`landing.wa.var.${k}`)}>
                  {`{${k}}`} · {t(`landing.wa.var.${k}`)}
                </button>
              ))}
            </div>
            <p className="lp-wa-ex" dir="rtl">
              <b>{t('landing.wa.example')}</b> {waExample(f.whatsapp.message || WHATSAPP_DEFAULT.message)}
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>
          <Icon name="shield" /> {t('landing.set.ts')}
        </h2>
        {data.turnstileAuto ? (
          <p className="lp-ts-auto">
            <span className="chip lp-on">✓ {t('landing.set.tsAuto')}</span> {t('landing.set.tsAutoHelp')}
          </p>
        ) : (
          <p className="pd-note">{t('landing.set.tsHelp')}</p>
        )}
        <div className="grid2">
          <Field label={t('landing.set.tsSite')} hint={t('landing.set.tsSiteHint')}>
            <input className="ltr" value={f.turnstileSiteKey} placeholder="0x4AAAAAAA…" onChange={(e) => set('turnstileSiteKey', e.target.value.replace(/[^0-9A-Za-z_-]/g, ''))} />
          </Field>
          <Field
            label={t('landing.set.tsSecret')}
            hint={
              <>
                <span className={`chip ${data.turnstile && f.turnstileSiteKey ? 'lp-on' : 'lp-warn'}`}>{data.turnstile && f.turnstileSiteKey ? t('landing.set.tsOn') : t('landing.set.tsOff')}</span>{' '}
                {admin ? t('landing.set.tsSecretHint') : t('landing.set.tokenAdmin')}
              </>
            }
          >
            <div className="lp-copy">
              <input className="ltr" type="password" autoComplete="off" disabled={!admin} value={tsSecret} placeholder={data.turnstile ? '••••••••' : '0x4AAAAAAA…'} onChange={(e) => setTsSecret(e.target.value)} />
              {admin && data.turnstile && (
                <button type="button" className="btn small ghost danger" onClick={removeTs}>
                  {t('landing.set.removeToken')}
                </button>
              )}
            </div>
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>
          <Icon name="cart" /> {t('landing.set.abandoned')}
        </h2>
        <p className="pd-note">{t('landing.set.abandonedHelp')}</p>
        <Field label={t('landing.set.after')} hint={t('landing.set.afterHint')}>
          <div className="lp-min">
            <input type="number" min={5} max={1440} step={5} value={f.abandonAfterMin} onChange={(e) => set('abandonAfterMin', e.target.value)} />
            <span>{t('landing.set.minutes')}</span>
          </div>
        </Field>
      </section>

      <section className="card">
        <h2>
          <Icon name="globe" /> {t('landing.set.link')}
        </h2>
        <p className="pd-note">{t('landing.set.linkHelp')}</p>
        <Field label={t('landing.set.storeSlug')} hint={data.storeFixed ? t('landing.set.storeFixed') : t('landing.set.storeSlugHint', { name: data.store })}>
          <div className="lp-slug">
            <span className="ltr">{`${serverUrl() || location.host}/`.replace(/^https?:\/\//, '')}</span>
            {data.storeFixed ? (
              // a shop of Pilotix's platform: the name Pilotix gave it (its order links use it too)
              <input className="ltr" value={data.store} readOnly />
            ) : (
              <input className="ltr" value={f.storeSlug} maxLength={40} placeholder={data.store} onChange={(e) => set('storeSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
            )}
            <span className="ltr">/…</span>
          </div>
        </Field>
      </section>

      <section className="card">
        <h2>
          <Icon name="sparkles" /> {t('landing.set.auto')}
        </h2>
        <label className="lp-switch">
          <input type="checkbox" checked={f.autoCreate} onChange={(e) => set('autoCreate', e.target.checked)} />
          <span>
            <b>{t('landing.set.autoCreate')}</b>
            <small>{t('landing.set.autoCreateHelp')}</small>
          </span>
        </label>
        <h3>{t('landing.set.ignored')}</h3>
        {data.ignored.length ? (
          <div className="lp-ign">
            {data.ignored.map((p) => (
              <span key={p.id} className="chip">
                {p.name}
                <button type="button" className="lp-link" disabled={unignore.isPending} onClick={() => unignore.mutate({ productId: p.id, on: false })}>
                  {t('landing.set.restore')}
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="pd-note">{t('landing.set.ignoredNone')}</p>
        )}
      </section>
      <div className="lp-ed-foot">
        <SaveBar dirty={dirty} busy={save.isPending} onSave={submit} label={t('common.save')} />
      </div>
    </form>
  );
}

/** What was sent to Meta, and what was not (with the reason): fake orders never appear as « Purchase envoyé ». */
function Events() {
  const { t } = useTranslation();
  const q = useRpc('landing.events', { limit: 60 });
  const retry = useAction('landing.retryEvents', { success: (r) => t('landing.ev.retried', { count: r.requeued }) });
  const c = q.data?.counts ?? {};
  return (
    <section className="card pd-card">
      <div className="pd-tools">
        <h2 className="lp-h2">
          <Icon name="send" /> {t('landing.ev.title')}
        </h2>
        <div className="lp-evk">
          {(['sent', 'simulated', 'queued', 'skipped', 'failed'] as const).map((k) =>
            c[k] ? (
              <span key={k} className={`lp-ev st-${k}`}>
                {t(`landing.ev.st.${k}`)} <b className="ltr">{c[k]}</b>
              </span>
            ) : null,
          )}
          {!!c.failed && (
            <button type="button" className="btn small" disabled={retry.isPending} onClick={() => retry.mutate({})}>
              <Icon name="refresh" /> {t('landing.ev.retry')}
            </button>
          )}
        </div>
      </div>
      <p className="pd-note">{t('landing.ev.help')}</p>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.rows.length ? (
        <Empty>{t('landing.ev.empty')}</Empty>
      ) : (
        <div className="pd-list">
          {q.data.rows.map((e) => (
            <div key={e.id} className="pd-row lp-evr">
              <span className={`lp-ev st-${e.status}`}>{t(`landing.ev.st.${e.status}`)}</span>
              <span className="pd-name">
                <b>{e.name === 'Purchase' ? t('landing.ev.purchase') : e.name === 'Confirmed' ? t('landing.ev.confirmed') : t('landing.ev.checkout')}</b>
                <small>
                  {e.ref && <span className="ltr">{e.ref}</span>}
                  {e.customer && <span dir="auto">{e.customer}</span>}
                  {e.value !== null && <span className="ltr">{da(e.value)}</span>}
                  <span className="ltr muted">pixel {e.pixelId}</span>
                </small>
                {e.error && <small className="lp-everr">{e.error}</small>}
              </span>
              <span className="muted small">{dateTime(e.sentAt ?? e.at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
