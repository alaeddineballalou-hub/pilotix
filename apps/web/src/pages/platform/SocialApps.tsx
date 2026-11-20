// Pilot AI › Réglages & coûts › Comptes Meta et TikTok: Pilotix's own Meta app and TikTok app, which let every boutique
// link its accounts with one login (the shop app's Pilot AI › Comptes, modules/social.ts). Their ids, their secrets
// (written here only, never shown again), the addresses to give them, how to make them, and how many accounts are linked.
// One Facebook Login for Business configuration brings a boutique everything of Meta at once (Pages, Instagram, ad
// accounts, catalogues, pixels); WhatsApp has its own (Embedded Signup). There is no Instagram-only login any more.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { CopyCode } from '../../ui/CopyCode';
import { Card, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { TestLines } from '../comptes';
import { usePilotAction, usePilotCall, usePilotRpc } from './pilotDemo';

type Apps = POut<'p.social.apps'>;
const K = 'platform.pilot.social.';

export function SocialAppsCard({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.social.apps', {});
  if (!q.data)
    return (
      <Card title={t(K + 'title')}>
        <Loading />
      </Card>
    );
  return <SocialAppsForm key={JSON.stringify(q.data)} d={q.data} manager={manager} />;
}

function SocialAppsForm({ d, manager }: { d: Apps; manager: boolean }) {
  const { t } = useTranslation();
  const [metaId, setMetaId] = useState(d.meta.appId);
  const [config, setConfig] = useState(d.meta.configId);
  // « Connecter la publicité »: a second configuration, for the ad accounts, the catalogues, the pixels and the lead forms
  const [adsConfig, setAdsConfig] = useState(d.meta.adsConfigId ?? '');
  // the « WhatsApp Embedded Signup » configuration: one click connects a shop's WhatsApp number
  const [waConfig, setWaConfig] = useState(d.meta.waConfigId ?? '');
  // Meta gave the app the « human agent » permission: the team may answer for 7 days (never the AI)
  const [human, setHuman] = useState(d.meta.humanAgent === true);
  const [metaSecret, setMetaSecret] = useState<string | null>('');
  const [ttId, setTtId] = useState(d.tiktok.appId);
  const [ttSecret, setTtSecret] = useState<string | null>('');
  const save = usePilotAction('p.social.apps.save', { success: t('platform.saved'), onDone: () => (setMetaSecret(''), setTtSecret('')) });
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  const urls = d.urls ?? { metaRedirect: `${base}/api/oauth/meta/callback`, tiktokRedirect: `${base}/api/oauth/tiktok/callback`, metaWebhook: `${base}/api/hooks/meta-app`, metaDeletion: `${base}/api/hooks/meta-deletion` };
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 40);
  const chip = (ok: boolean) => <span className={`chip ${ok ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{ok ? t(K + 'ready') : t(K + 'todo')}</span>;
  const secretField = (label: string, has: boolean, v: string | null, set: (x: string | null) => void) => (
    <Field
      label={label}
      hint={
        has ? (
          <span>
            {t(K + 'secretSaved')}{' '}
            {manager && (
              <button type="button" className="linkbtn" onClick={() => set(v === null ? '' : null)}>
                {v === null ? t(K + 'secretKeep') : t(K + 'secretRemove')}
              </button>
            )}
          </span>
        ) : undefined
      }
    >
      <input type="password" className="ltr" autoComplete="new-password" disabled={!manager || v === null} value={v ?? ''} placeholder={has ? '••••••••' : ''} onChange={(e) => set(e.target.value)} />
    </Field>
  );
  const dirty = metaId !== d.meta.appId || config !== d.meta.configId || adsConfig !== (d.meta.adsConfigId ?? '') || waConfig !== (d.meta.waConfigId ?? '') || human !== (d.meta.humanAgent === true) || ttId !== d.tiktok.appId || metaSecret !== '' || ttSecret !== '';
  return (
    <Card title={t(K + 'title')} badge={<span className="chip">{t(K + 'counts', { meta: n(d.counts.meta), tiktok: n(d.counts.tiktok), shops: n(d.counts.shops) })}</span>}>
      <p className="small muted">{t(K + 'text')}</p>
      <div className="pl-sa">
        <section aria-labelledby="pl-sa-meta">
          <h3 id="pl-sa-meta">
            <span className="pl-sa-b meta" aria-hidden="true">
              FB
            </span>
            {t(K + 'meta')} {chip(d.ready.meta)}
          </h3>
          <div className="grid2">
            <Field label={t(K + 'appId')}>
              <input className="ltr" inputMode="numeric" disabled={!manager} value={metaId} onChange={(e) => setMetaId(digits(e.target.value))} />
            </Field>
            {secretField(t(K + 'appSecret'), d.meta.hasSecret, metaSecret, setMetaSecret)}
          </div>
          <Field label={t(K + 'configId')} hint={t(K + 'configHint')}>
            <input className="ltr" inputMode="numeric" disabled={!manager} value={config} onChange={(e) => setConfig(digits(e.target.value))} />
          </Field>
          <Field label={t(K + 'adsConfigId')} hint={t(K + 'adsConfigHint')}>
            <input className="ltr" inputMode="numeric" disabled={!manager} value={adsConfig} onChange={(e) => setAdsConfig(digits(e.target.value))} />
          </Field>
          <div className="pl-sa-ig" role="group" aria-labelledby="pl-sa-wa">
            <h4 id="pl-sa-wa">
              {t(K + 'waAlone')} {chip(!!d.meta.appId && !!(d.meta.waConfigId ?? ''))}
            </h4>
            <Field label={t(K + 'waConfigId')}>
              <input className="ltr" inputMode="numeric" disabled={!manager} value={waConfig} onChange={(e) => setWaConfig(digits(e.target.value))} />
            </Field>
            <p className="small muted">{t(K + 'waAloneText')}</p>
          </div>
          <div className="pl-sa-ig" role="group" aria-labelledby="pl-sa-human">
            <h4 id="pl-sa-human">
              {t(K + 'humanAgent')} {chip(human)}
            </h4>
            <label className="check">
              <input type="checkbox" disabled={!manager} checked={human} onChange={(e) => setHuman(e.target.checked)} /> {t(K + 'humanAgentOn')}
            </label>
            <p className="small muted">{t(K + 'humanAgentText')}</p>
          </div>
          <Field label={t(K + 'redirect')}>
            <CopyCode code={urls.metaRedirect} small />
          </Field>
          <div className="grid2">
            <Field label={t(K + 'webhook')}>
              <CopyCode code={urls.metaWebhook} small />
            </Field>
            <Field label={t(K + 'verify')}>
              <CopyCode code={d.verifyToken || t(K + 'verifyAfter')} small />
            </Field>
          </div>
          {/* Meta calls it when a person asks Facebook to delete their data: their linked accounts go, Meta gets a code */}
          <Field
            label={t(K + 'deletion')}
            hint={
              <bdi className="dl-path" dir="ltr">
                Facebook Login for Business › Settings › Data Deletion Request URL
              </bdi>
            }
          >
            <CopyCode code={urls.metaDeletion} small />
          </Field>
          <MetaAppTest />
        </section>
        <section aria-labelledby="pl-sa-tt">
          <h3 id="pl-sa-tt">
            <span className="pl-sa-b tt" aria-hidden="true">
              TT
            </span>
            {t(K + 'tiktok')} {chip(d.ready.tiktok)}
          </h3>
          <div className="grid2">
            <Field label={t(K + 'ttAppId')}>
              <input className="ltr" inputMode="numeric" disabled={!manager} value={ttId} onChange={(e) => setTtId(digits(e.target.value))} />
            </Field>
            {secretField(t(K + 'ttSecret'), d.tiktok.hasSecret, ttSecret, setTtSecret)}
          </div>
          <Field label={t(K + 'ttRedirect')}>
            <CopyCode code={urls.tiktokRedirect} small />
          </Field>
        </section>
      </div>
      <details className="pl-sa-how">
        <summary>{t(K + 'how')}</summary>
        <div className="pl-sa-steps">
          <div>
            <h4>{t(K + 'meta')}</h4>
            <ol>
              {(t(K + 'metaSteps', { returnObjects: true }) as string[]).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
          <div>
            <h4>{t(K + 'tiktok')}</h4>
            <ol>
              {(t(K + 'tiktokSteps', { returnObjects: true }) as string[]).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
        </div>
      </details>
      {manager && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn primary"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate({
                meta: {
                  appId: metaId,
                  configId: config,
                  adsConfigId: adsConfig,
                  waConfigId: waConfig,
                  humanAgent: human,
                  secret: metaSecret === null ? null : metaSecret.trim(),
                },
                tiktok: {
                  appId: ttId,
                  secret: ttSecret === null ? null : ttSecret.trim(),
                },
              })
            }
          >
            <Icon name="check" /> {t('common.save')}
          </button>
        </div>
      )}
    </Card>
  );
}

/**
 * « Tester l’app Meta »: Pilotix's own Meta app, line by line — what its webhook gets (the Pages' messages and comments,
 * the lead forms, edited messages and reactions, Instagram, the ads' problems), a webhook refused these 2 days, and that
 * its address answers from the Internet. The Pilotix team's part of the test (the boutiques' « Tester » no longer has it).
 */
function MetaAppTest() {
  const { t } = useTranslation();
  const call = usePilotCall();
  const [r, setR] = useState<POut<'p.social.appTest'> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setR(await call('p.social.appTest', {}));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pl-sa-test" role="group" aria-labelledby="pl-sa-test-h">
      <div className="pl-sa-test-h">
        <h4 id="pl-sa-test-h">{t(K + 'appTest')}</h4>
        <button type="button" className="btn small" disabled={busy} onClick={run}>
          <Icon name="pulse" /> {busy ? t(K + 'appTesting') : t(K + 'appTestBtn')}
        </button>
      </div>
      <p className="small muted">{t(K + 'appTestText')}</p>
      {(r || busy) && <TestLines r={r} pending={busy} provider="meta" />}
    </div>
  );
}
