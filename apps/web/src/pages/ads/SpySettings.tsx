// AI Spy › Réglages (#/marketing/spy/reglages): where the ads come from (the free Pilotix Chrome extension, or a paid
// key used by the server: ScrapeCreators, SearchAPI.io), the daily scan, the shop's own pages, how many ads per keyword,
// whether Claude reads the ads (the Message AI agent's key), and how to install the extension. Only admins save.
import type { SpySource } from '@pilotix/core';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { dateOnly, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { detectExtension, type ExtStatus } from '../../lib/spyExtension';
import { copyText, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SaveBar } from '../ai/agent';
import './spy.css';

type Paid = Exclude<SpySource, 'extension'>;
const SOURCES: SpySource[] = ['extension', 'scrapecreators', 'searchapi'];
const PAID: Paid[] = ['scrapecreators', 'searchapi'];
const REPO = 'https://github.com/alaeddineballalou-hub/pilotix/tree/main/apps/extension';

export function SpySettingsView() {
  const { t } = useTranslation();
  const q = useRpc('spy.settings.get', {}, { refetchOnWindowFocus: false });
  return (
    <div className="spy view">
      <section className="card spy-set-head">
        <a className="btn small" href="#/marketing/spy">
          <Icon name="chevl" className="spy-flip" /> {t('spy.set.back')}
        </a>
        <div className="spy-set-title">
          <h2>
            <Icon name="settings" /> {t('spy.set.title')}
          </h2>
          <p className="note">{t('spy.set.help')}</p>
        </div>
      </section>
      {q.isLoading ? <Loading /> : q.error || !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Form key={JSON.stringify([q.data.settings, q.data.keys])} data={q.data} />}
      <ExtensionCard />
    </div>
  );
}

type Keys = Record<Paid, string>;
const NO_KEYS: Keys = { scrapecreators: '', searchapi: '' };

function Form({ data }: { data: Out<'spy.settings.get'> }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const init = { ...data.settings, maxPerKeyword: String(data.settings.maxPerKeyword) };
  const [f, setF] = useState(init);
  const [keys, setKeys] = useState<Keys>(NO_KEYS);
  const save = useAction('spy.settings.save', { success: t('spy.set.saved'), onDone: () => setKeys(NO_KEYS) });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(init) !== JSON.stringify(f) || !!keys.scrapecreators.trim() || !!keys.searchapi.trim();
  const values = () => ({
    source: f.source,
    dailyScan: f.dailyScan,
    scanHour: f.scanHour,
    ownPages: f.ownPages.slice(0, 2000),
    maxPerKeyword: Math.max(5, Math.min(100, Math.round(Number(f.maxPerKeyword) || 30))),
  });
  // '' keeps the stored key, null removes it
  const submit = () => save.mutate({ ...values(), keys: { scrapecreators: keys.scrapecreators.trim(), searchapi: keys.searchapi.trim() } });
  const removeKey = (s: Paid) => window.confirm(t('spy.set.removeAsk')) && save.mutate({ ...values(), keys: s === 'scrapecreators' ? { scrapecreators: null } : { searchapi: null } });
  const paid = f.source !== 'extension';
  const missingKey = paid && !data.keys[f.source as Paid] && !keys[f.source as Paid].trim();
  const ownId = useId();
  return (
    <form
      className="spy-set"
      onSubmit={(e) => {
        e.preventDefault();
        if (admin && dirty) submit();
      }}
    >
      {!admin && <div className="warnbox">{t('spy.set.adminOnly')}</div>}

      <section className="card" aria-labelledby="spy-src-h">
        <h2 id="spy-src-h">
          <Icon name="search" /> {t('spy.set.source')}
        </h2>
        <p className="note">{t('spy.set.sourceHelp')}</p>
        <div className="spy-sources" role="radiogroup" aria-labelledby="spy-src-h">
          {SOURCES.map((s) => (
            <div key={s} className={`spy-scard ${f.source === s ? 'on' : ''}`}>
              <label className="spy-scard-h">
                <input type="radio" name="spy-source" value={s} checked={f.source === s} disabled={!admin} onChange={() => set('source', s)} />
                <span>
                  <b>{t(`spy.set.src.${s}.name`)}</b>
                  <span className={`badge ${s === 'extension' ? 't-ok' : 't-mid'}`}>{t(`spy.set.src.${s}.price`)}</span>
                </span>
              </label>
              <p className="note">{t(`spy.set.src.${s}.desc`)}</p>
              {s !== 'extension' && (
                <KeyField source={s} stored={data.keys[s]} value={keys[s]} admin={admin} onChange={(v) => setKeys((k) => ({ ...k, [s]: v }))} onRemove={() => removeKey(s)} />
              )}
            </div>
          ))}
        </div>
        {missingKey && <div className="warnbox">{t('spy.set.missingKey', { name: t(`spy.set.src.${f.source}.name`) })}</div>}
      </section>

      <div className="spy-setgrid">
        <section className="card" aria-labelledby="spy-scan-h">
          <h2 id="spy-scan-h">
            <Icon name="clock" /> {t('spy.set.scan')}
          </h2>
          <label className="spy-switch">
            <input type="checkbox" checked={f.dailyScan} disabled={!admin} onChange={(e) => set('dailyScan', e.target.checked)} />
            <span>
              <b>{t('spy.set.daily')}</b>
              <small>{t('spy.set.dailyHelp')}</small>
            </span>
          </label>
          <Field label={t('spy.set.hour')} hint={t('spy.set.hourHint')}>
            <select value={f.scanHour} disabled={!admin || !f.dailyScan} onChange={(e) => set('scanHour', Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {t('spy.set.hourOpt', { h: String(h).padStart(2, '0') })}
                </option>
              ))}
            </select>
          </Field>
          {!paid && <p className="note">{t('spy.set.scanExt')}</p>}
          <p className="note">{data.lastScan ? t('spy.set.lastScan', { day: dateOnly(`${data.lastScan}T12:00:00Z`) }) : t('spy.set.noScan')}</p>
        </section>

        <section className="card" aria-labelledby="spy-own-h">
          <h2 id="spy-own-h">
            <Icon name="flag" /> {t('spy.set.own')}
          </h2>
          <div className="field">
            <label className="lab" htmlFor={ownId}>
              {t('spy.set.ownPages')}
            </label>
            <textarea id={ownId} rows={4} dir="auto" maxLength={2000} disabled={!admin} value={f.ownPages} placeholder={t('spy.set.ownPh')} onChange={(e) => set('ownPages', e.target.value)} />
            <span className="hint">{t('spy.set.ownHint')}</span>
          </div>
          <Field label={t('spy.set.max')} hint={t('spy.set.maxHint')}>
            <input type="number" inputMode="numeric" min={5} max={100} step={5} disabled={!admin} value={f.maxPerKeyword} onChange={(e) => set('maxPerKeyword', e.target.value)} />
          </Field>
        </section>
      </div>

      <section className="card" aria-labelledby="spy-ai-h">
        <h2 id="spy-ai-h">
          <Icon name="sparkles" /> {t('spy.set.ai')}
          <span className={`badge ${data.ai ? 't-ok' : 't-off'}`}>{data.ai ? t('spy.set.aiOn') : t('spy.set.aiOff')}</span>
        </h2>
        <p className="note">{t('spy.set.aiHelp')}</p>
        <a className="btn small spy-self" href="#/messages/reglages">
          <Icon name="chat" /> {t('spy.set.aiLink')}
        </a>
      </section>

      {admin && (
        <div className="spy-savebar">
          <SaveBar dirty={dirty} busy={save.isPending} onSave={submit} label={t('common.save')} />
        </div>
      )}
    </form>
  );
}

function KeyField({ source, stored, value, admin, onChange, onRemove }: { source: Paid; stored: boolean; value: string; admin: boolean; onChange: (v: string) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const test = useAction('spy.settings.test');
  const [res, setRes] = useState<Out<'spy.settings.test'> | null>(null);
  const run = () => test.mutate({ source, key: value.trim() || undefined }, { onSuccess: setRes });
  return (
    <div className="spy-key">
      <div className="field">
        <label className="lab" htmlFor={id}>
          {t('spy.set.key')}
        </label>
        <div className="spy-keyrow">
          <input
            id={id}
            className="ltr"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={!admin}
            value={value}
            placeholder={stored ? '••••••••' : t(`spy.set.src.${source}.ph`)}
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="btn small" disabled={!admin || test.isPending || (!stored && !value.trim())} onClick={run}>
            {test.isPending ? t('spy.set.testing') : t('spy.set.test')}
          </button>
        </div>
        <span className="hint">{stored ? t('spy.set.keyStored') : t('spy.set.keyNone')}</span>
      </div>
      {stored && admin && (
        <button type="button" className="spy-link danger" onClick={onRemove}>
          {t('spy.set.removeKey')}
        </button>
      )}
      {res && <TestResult r={res} />}
    </div>
  );
}

function TestResult({ r }: { r: Out<'spy.settings.test'> }) {
  const { t } = useTranslation();
  if (r.message)
    return (
      <div className="spy-test" role="status">
        {r.message}
      </div>
    );
  return (
    <div className={`spy-test ${r.ok ? 'ok' : 'bad'}`} role="status">
      <b>{r.ok ? t('spy.set.testOk', { n: n(r.count) }) : t('spy.set.testNone')}</b>
      {r.sample.length > 0 && (
        <ul>
          {r.sample.map((s, i) => (
            <li key={i}>
              <b dir="auto">{s.page}</b> · <span dir="auto">{s.text || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Is the extension on this page, and how to install it (shown in the settings and when a search needs it). */
export function ExtensionCard({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const [st, setSt] = useState<ExtStatus | null>(null);
  const check = () => {
    setSt(null);
    void detectExtension(1200).then(setSt);
  };
  useEffect(check, []);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <section className="card spy-ext" aria-labelledby="spy-ext-h">
      <div className="card-head">
        <h2 id="spy-ext-h">
          <Icon name="puzzle" /> {t('spy.ext.title')}
        </h2>
        <div className="row">
          <span className={`badge ${!st ? 't-off' : st.installed ? 't-ok' : 't-bad'}`} role="status">
            {!st ? t('spy.ext.checking') : st.installed ? t('spy.ext.on', { v: st.version ?? '1' }) : t('spy.ext.off')}
          </span>
          {onClose && (
            <button type="button" className="btn small ghost" onClick={onClose} aria-label={t('spy.close')}>
              <Icon name="x" />
            </button>
          )}
        </div>
      </div>
      <p className="note">{t('spy.ext.help')}</p>
      <ol className="spy-steps">
        <li>
          {t('spy.ext.s1')}{' '}
          <a href={REPO} target="_blank" rel="noopener noreferrer" className="ltr">
            github.com/…/pilotix/apps/extension
          </a>
        </li>
        <li>
          {t('spy.ext.s2a')} <code className="ltr">chrome://extensions</code> {t('spy.ext.s2b')}
        </li>
        <li>
          {t('spy.ext.s3')}{' '}
          <span className="spy-origin">
            <code className="ltr">{origin}</code>
            <button type="button" className="spy-iconbtn" aria-label={t('spy.ext.copyOrigin')} onClick={async () => ((await copyText(origin)) ? toast(t('spy.copied'), 'ok') : toast(t('spy.copyFail'), 'bad'))}>
              <Icon name="copy" />
            </button>
          </span>
        </li>
      </ol>
      <div className="row">
        <button type="button" className="btn small" onClick={check}>
          <Icon name="refresh" /> {t('spy.ext.recheck')}
        </button>
        {onClose && (
          <a className="btn small ghost" href="#/marketing/spy/reglages">
            <Icon name="settings" /> {t('spy.settings')}
          </a>
        )}
      </div>
    </section>
  );
}
