// Control room › Doctor: the health of the Pilotix server — machine, database, background jobs, errors in the code,
// shops that went silent, settings. Looks again every minute. In the preview (no server) it shows an example.
import type { DoctorItem, ServerDoctorReport } from '@pilotix/shared';
import { doctorScore, doctorSort } from '@pilotix/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { dur, n, shortWhen } from '../../lib/format';
import { serverDoctor } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { DoctorHero, DoctorList } from '../doctor/parts';

export function DoctorPage({ demo }: { demo?: boolean }) {
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
      <DoctorHero title={t('doctor.serverTitle')} sub={t('doctor.serverSub')} badge={t('doctor.onlyYou')} score={r.score} items={r.items} checkedAt={r.checkedAt} onRefresh={() => q.refetch()} busy={q.isFetching} />
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
    ],
    errors: [
      { at: ago(3), level: 'error', source: 'Courier sync', shop: 'boutique-amine', message: 'ZR: 401 Unauthorized (token expired)', count: 28 },
      { at: ago(17), level: 'error', source: 'API', shop: null, message: 'TypeError: Cannot read properties of undefined (reading "wilaya")\n    at orderForm (orders.js:412:18)', count: 9 },
      { at: ago(48), level: 'warn', source: 'Sheets sync', shop: 'maison-sara', message: 'Commandes site: 3 ligne(s) refusée(s)', count: 4 },
    ],
  };
}
