// Control room › Doctor: the health of the Pilotix server — machine, database, background jobs, errors in the code,
// shops that went silent, settings. Looks again every minute. In the preview (no server) it shows an example.
import type { DoctorItem, DoctorTurnstile, ServerDoctorReport } from '@pilotix/shared';
import { doctorScore, doctorSort } from '@pilotix/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dur, n, shortWhen } from '../../lib/format';
import { serverDoctor, turnstileSync } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { copilotMood, CopilotIcon } from '../doctor/CopilotIcon';
import { DoctorHero, DoctorList } from '../doctor/parts';

export function DoctorPage({ demo, owner }: { demo?: boolean; owner?: boolean }) {
  const { t } = useTranslation();
  const q = useQuery<ServerDoctorReport, Error>({ queryKey: ['p', 'doctor', !!demo], queryFn: () => (demo ? Promise.resolve(demoReport()) : serverDoctor()), refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  const g = r.gauges;
  const f = r.facts;
  return (
    <div className="dr pp-stack">
      {demo && <p className="dr-demo">{t('doctor.demoNote')}</p>}
      <DoctorHero title={t('doctor.serverTitle')} icon={<CopilotIcon mood={q.isFetching ? null : copilotMood(r.items)} label={t('doctor.serverTitle')} />} sub={t('doctor.serverSub')} badge={t('doctor.onlyYou')} score={r.score} items={r.items} checkedAt={r.checkedAt} onRefresh={() => q.refetch()} busy={q.isFetching} />
      <div className="dr-gauges">
        <Gauge label={t('doctor.gauge.cpu')} icon="sliders" v={g.cpu} warn={0.75} bad={0.95} sub={t('doctor.gauge.cores', { count: f.cores })} />
        <Gauge label={t('doctor.gauge.memory')} icon="layers" v={g.memory} warn={0.8} bad={0.92} sub={t('doctor.u.mb', { n: n(f.memoryTotalMb) })} />
        <Gauge label={t('doctor.gauge.disk')} icon="package" v={g.disk} warn={0.8} bad={0.9} sub={f.diskTotalMb ? t('doctor.u.mb', { n: n(f.diskTotalMb) }) : '—'} />
        <Gauge label={t('doctor.gauge.db')} icon="list" v={g.dbConnections} warn={0.7} bad={0.9} sub={f.dbSizeMb !== null ? t('doctor.gauge.dbSize', { size: n(f.dbSizeMb) }) : '—'} />
      </div>
      <div className="dr-facts">
        <span>
          {t('doctor.f.version')} <b className="ltr">{f.version}</b>
        </span>
        <span>
          Node <b className="ltr">{f.node}</b>
        </span>
        <span>
          {t('doctor.f.appUp')} <b>{dur(f.appUptimeS * 1000)}</b>
        </span>
        <span>
          {t('doctor.f.serverUp')} <b>{dur(f.serverUptimeS * 1000)}</b>
        </span>
        <span>
          {t('doctor.f.db')} <b className="ltr">{f.dbPingMs ?? '—'} ms</b>
        </span>
        <span>
          {t('doctor.f.shops')} <b>{f.shops}</b>
        </span>
      </div>
      <DoctorList items={r.items} />
      {r.turnstile && <Cloudflare ts={r.turnstile} demo={!!demo} owner={!!owner} />}
      <div className="dr-two">
        <Card title={t('doctor.jobs.title')}>
          <table className="dr-jobs">
            <thead>
              <tr>
                <th>{t('doctor.jobs.name')}</th>
                <th>{t('doctor.jobs.state')}</th>
                <th>{t('doctor.jobs.last')}</th>
              </tr>
            </thead>
            <tbody>
              {r.jobs.map((j) => (
                <tr key={j.name}>
                  <td>
                    <b>{t(`doctor.job.${j.name}`, { defaultValue: j.name })}</b>
                    <br />
                    <small className="muted">{t('doctor.jobs.every', { time: dur(j.every) })}</small>
                  </td>
                  <td>
                    <span className={`dr-dot dr-${j.state}`} />
                    {t(`doctor.jobs.st.${j.state}`)}
                    {j.state === 'failing' && j.lastError && (
                      <>
                        <br />
                        <small className="muted">{j.lastError}</small>
                      </>
                    )}
                  </td>
                  <td className="muted small">{j.lastOkAt ? shortWhen(j.lastOkAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={t('doctor.errs.title')} badge={r.errors.length ? <span className="pp-count bad">{r.errors.length}</span> : undefined}>
          {r.errors.length ? (
            <ul className="dr-errs">
              {r.errors.map((e, i) => (
                <li key={i}>
                  <span className={`dr-x ${e.level === 'warn' ? 'dr-warn' : ''}`}>× {e.count}</span>
                  <div>
                    <div className="dr-src">
                      {e.source}
                      {e.shop ? ` · ${e.shop}` : ''} · {t(`doctor.errs.${e.level}`)}
                    </div>
                    <code>{e.message}</code>
                  </div>
                  <small className="muted">{shortWhen(e.at)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              <Icon name="checkcircle" /> {t('doctor.errs.none')}
            </p>
          )}
          <p className="muted small">{t('doctor.errs.memory')}</p>
        </Card>
      </div>
    </div>
  );
}

/**
 * Cloudflare Turnstile kept by Pilotix for every shop: how many domains of the free plan are used (upgrade before it is
 * full), the widgets and their domains, the last sync; the owner connects the Cloudflare account here (once).
 */
function Cloudflare({ ts, demo, owner }: { ts: DoctorTurnstile; demo: boolean; owner: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const used = ts.maxDomains ? ts.domains / ts.maxDomains : 0;
  const tone = ts.waiting.length || used >= 0.95 ? 'dr-bad' : used >= 0.8 ? 'dr-warn' : '';
  const sync = async () => {
    if (demo) return toast(t('doctor.cf.demo'), 'ok');
    setBusy(true);
    try {
      await turnstileSync();
      toast(t('doctor.cf.syncedOk'), 'ok');
      await qc.invalidateQueries({ queryKey: ['p', 'doctor'] });
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('doctor.cf.title')} help={t('doctor.cf.help')} badge={ts.configured ? <span className={`pp-count ${tone ? 'bad' : ''}`}>{`${ts.domains} / ${ts.maxDomains}`}</span> : undefined}>
      <div className="dr-cf">
        {ts.configured ? (
          <>
            <div className="dr-cf-top">
              <section className="dr-gauge">
                <div className="dr-gauge-h">
                  <span>{t('doctor.cf.domains')}</span>
                  <Icon name="shield" />
                </div>
                <b className="dr-gauge-v ltr">
                  {ts.domains} <small>/ {ts.maxDomains}</small>
                </b>
                <div className={`dr-bar ${tone}`}>
                  <i style={{ width: `${Math.min(100, Math.round(used * 100))}%` }} />
                </div>
                <small>{t('doctor.cf.left', { count: Math.max(0, ts.maxDomains - ts.domains) })}</small>
              </section>
              <section className="dr-gauge">
                <div className="dr-gauge-h">
                  <span>{t('doctor.cf.widgets')}</span>
                  <Icon name="layers" />
                </div>
                <b className="dr-gauge-v ltr">
                  {ts.widgets.length} <small>/ {ts.maxWidgets}</small>
                </b>
                <div className={`dr-bar ${ts.widgets.length >= ts.maxWidgets ? 'dr-warn' : ''}`}>
                  <i style={{ width: `${Math.round((ts.widgets.length / ts.maxWidgets) * 100)}%` }} />
                </div>
                <small>{t('doctor.cf.perWidget', { count: ts.perWidget })}</small>
              </section>
            </div>
            {(used >= 0.8 || ts.waiting.length > 0) && <p className={`dr-cf-up ${tone}`}>{ts.waiting.length ? t('doctor.cf.full', { count: ts.waiting.length }) : t('doctor.cf.soon', { pct: Math.round(used * 100) })}</p>}
            {ts.lastError && !ts.waiting.length && <p className="dr-cf-up dr-warn">{ts.lastError}</p>}
            <ul className="dr-cf-w">
              {ts.widgets.map((w) => (
                <li key={w.sitekey}>
                  <b>{w.name}</b> <small className="muted ltr">{`${w.domains.length} / ${ts.perWidget}`}</small>
                  <div className="dr-cf-d">
                    {w.domains.map((d) => (
                      <span key={d} className="ltr">
                        {d}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="dr-cf-a">
              <small className="muted">
                <Icon name="lock" /> {t('doctor.cf.lockedShort')} · {t('doctor.cf.account')} <span className="ltr">{ts.accountId}</span> · {t('doctor.cf.synced')} {ts.lastSyncAt ? shortWhen(ts.lastSyncAt) : '—'}
              </small>
              <button type="button" className="btn small" disabled={busy} onClick={sync}>
                <Icon name="refresh" /> {t('doctor.cf.sync')}
              </button>
            </div>
          </>
        ) : (
          <div className="dr-cf-a">
            <p className="muted" style={{ margin: 0, flex: '1 1 260px' }}>
              {owner ? t('doctor.cf.off') : t('doctor.cf.offOthers')}
            </p>
            {owner && (
              <a className="btn small primary" href="#/platform/settings">
                <Icon name="settings" /> {t('doctor.cf.goSettings')}
              </a>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Gauge({ label, icon, v, warn, bad, sub }: { label: string; icon: string; v: number | null; warn: number; bad: number; sub: string }) {
  const tone = v === null ? '' : v >= bad ? 'dr-bad' : v >= warn ? 'dr-warn' : '';
  return (
    <section className="dr-gauge">
      <div className="dr-gauge-h">
        <span>{label}</span>
        <Icon name={icon} />
      </div>
      <b className="dr-gauge-v ltr">{v === null ? '—' : `${Math.round(v * 100)} %`}</b>
      <div className={`dr-bar ${tone}`}>
        <i style={{ width: `${Math.round((v ?? 0) * 100)}%` }} />
      </div>
      <small>{sub}</small>
    </section>
  );
}

/** What the page looks like on a real server (the preview has none). */
function demoReport(): ServerDoctorReport {
  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const items: DoctorItem[] = [
    { id: 'cpu', level: 'ok', area: 'server', params: { pct: 23.5, cores: 4 } },
    { id: 'memory', level: 'warn', area: 'server', params: { pct: 84.2, total: 7936 } },
    { id: 'disk', level: 'bad', area: 'server', params: { pct: 91.4, free: 6420 } },
    { id: 'restarted', level: 'ok', area: 'server', params: { minutes: 4210 } },
    { id: 'dbPing', level: 'ok', area: 'database', params: { ms: 3 } },
    { id: 'dbConnections', level: 'ok', area: 'database', params: { used: 18, max: 100, waiting: 0 } },
    { id: 'dbSlow', level: 'ok', area: 'database', params: { count: 0 } },
    { id: 'redis', level: 'ok', area: 'jobs', params: { ms: 2 } },
    { id: 'jobs', level: 'bad', area: 'jobs', params: { count: 1 }, list: [{ label: 'courier-sync', n: 124, unit: 'min' }] },
    {
      id: 'errors',
      level: 'bad',
      area: 'code',
      params: { hour: 6, day: 41, repeat: 1 },
      list: [
        { label: '[boutique-amine] ZR: 401 Unauthorized (token expired)', n: 28, unit: 'n' },
        { label: 'TypeError: Cannot read properties of undefined (reading "wilaya")', n: 9, unit: 'n' },
      ],
    },
    { id: 'courierSync', level: 'bad', area: 'code', params: { count: 1 }, list: [{ label: 'boutique-amine · ZR: 401 Unauthorized (token expired)', n: 28, unit: 'n' }] },
    { id: 'silentShops', level: 'warn', area: 'shops', params: { count: 1 }, list: [{ label: 'Maison Sara', n: 52, unit: 'hours' }] },
    { id: 'config', level: 'warn', area: 'config', params: { count: 1 }, list: [{ label: 'SMTP_HOST (e-mails)', n: 0, unit: 'text' }] },
    { id: 'turnstile', level: 'ok', area: 'config', params: { domains: 23, max: 200, pct: 11.5, widgets: 3, maxWidgets: 20, waiting: 0 } },
  ];
  const sorted = doctorSort(items);
  const job = (name: string, every: number, state: ServerDoctorReport['jobs'][number]['state'], okMin: number | null, err?: string) => ({
    name,
    every,
    state,
    lastOkAt: okMin === null ? null : ago(okMin),
    lastErrorAt: err ? ago(3) : null,
    lastError: err ?? null,
    runs: 120,
    fails: err ? 4 : 0,
  });
  return {
    checkedAt: new Date(now).toISOString(),
    score: doctorScore(sorted),
    items: sorted,
    gauges: { cpu: 0.235, memory: 0.842, disk: 0.914, dbConnections: 0.18 },
    facts: { serverUptimeS: 19 * 86400, appUptimeS: 4210 * 60, node: 'v22.11.0', version: '3.0.0', cores: 4, memoryTotalMb: 7936, diskTotalMb: 74_500, dbSizeMb: 1840, dbPingMs: 3, shops: 7 },
    jobs: [
      job('courier-sync', 30 * 60_000, 'failing', 124, 'Connection timeout (api.zrexpress.app)'),
      job('sheets-sync', 2 * 60_000, 'ok', 1),
      job('notify-run', 60_000, 'ok', 0),
      job('landing-run', 60_000, 'ok', 0),
      job('cm-sweep', 3 * 60_000, 'ok', 2),
      job('dellal-followups', 15 * 60_000, 'ok', 9),
      job('spy-scan', 60 * 60_000, 'ok', 31),
      job('meta-sync', 86_400_000, 'ok', 600),
      job('demo-reset', 86_400_000, 'ok', 1100),
      job('turnstile-sync', 30 * 60_000, 'ok', 12),
    ],
    turnstile: {
      configured: true,
      accountId: '023e…c353',
      widgets: [
        { sitekey: '0x4AAAAAAA1', name: 'Pilotix 1', domains: ['pilotix.online', 'maison-sara.com', 'boutique-amine.dz', 'bebe-confort.shop', 'www.toutpourbebe.com', 'kids-dz.com', 'ma-boutique.store', 'luna-baby.com', 'oran-shop.com', 'mode-alger.com'] },
        { sitekey: '0x4AAAAAAA2', name: 'Pilotix 2', domains: ['setif-store.com', 'deco-maison.dz', 'beauty-dz.com', 'sport-alger.shop', 'cuisine-pro.dz', 'kabylie-shop.com', 'vape-dz.store', 'tech-oran.com', 'bijoux-dz.com', 'jouets-annaba.com'] },
        { sitekey: '0x4AAAAAAA3', name: 'Pilotix 3', domains: ['parfum-blida.com', 'chaussures-dz.shop', 'sacs-constantine.com'] },
      ],
      domains: 23,
      maxDomains: 200,
      maxWidgets: 20,
      perWidget: 10,
      waiting: [],
      lastSyncAt: ago(12),
      lastError: null,
    },
    errors: [
      { at: ago(3), level: 'error', source: 'Courier sync', shop: 'boutique-amine', message: 'ZR: 401 Unauthorized (token expired)', count: 28 },
      { at: ago(17), level: 'error', source: 'API', shop: null, message: 'TypeError: Cannot read properties of undefined (reading "wilaya")\n    at orderForm (orders.js:412:18)', count: 9 },
      { at: ago(48), level: 'warn', source: 'Sheets sync', shop: 'maison-sara', message: 'Commandes site: 3 ligne(s) refusée(s)', count: 4 },
    ],
  };
}
