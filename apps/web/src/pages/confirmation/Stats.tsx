// "Statistiques" (foldable) — the KPI blocks of Nouvelles and En cours (managers). « Confirmées » is a page of statistics
// only (ConfirmedStatsPage): the key numbers, confirmation by agent, and what became of the confirmed orders.
import { Tone } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { da, dur, n } from '../../lib/format';
import { ErrorBox, Help, Icon, Kpi, Loading, Trend } from '../../ui/kit';
import { kfInput, Kf, loadKf, saveKf, Sub } from './shared';
import { useNow } from './Countdown';
import { DateRange, periodLabel } from './DateRange';
import './confirmation.css';

const tone3 = (p: number | null, ok: number, warn: number): Tone | undefined => (p === null ? undefined : p >= ok ? 'ok' : p >= warn ? 'warn' : 'bad');
const pctTxt = (p: number | null) => (p === null ? '—' : `${p} %`);

export function StatsSection({ sub }: { sub: Sub }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => store.get('px-kff') !== '0');
  const [kf, setKfState] = useState<Kf>(loadKf);
  const setKf = (k: Kf) => {
    setKfState(k);
    saveKf(k);
  };
  if (sub === 'terminees' || sub === 'livrees') return null;
  const fold = (o: boolean) => (setOpen(o), store.set('px-kff', o ? '1' : '0'));
  if (sub === 'nouvelles') return <NouvellesStats open={open} setOpen={fold} />;
  return (
    <section className={`px-kff px-kff-one ${open ? '' : 'folded'}`}>
      <button
        type="button"
        className="px-kff-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          store.set('px-kff', open ? '0' : '1');
        }}
      >
        <span className="px-kff-t">{t('confirmation.stats.title')}</span>
        <span className="px-kff-s">{open ? t('common.hide') : t('common.show')}</span>
        <i className="px-kff-ch" />
      </button>
      {open && (
        <div className="px-kff-body">
          {sub === 'attente' && <EnCoursCard kf={kf} setKf={setKf} />}
          {sub === 'confirmees' && <ConfirmedCard kf={kf} setKf={setKf} />}
        </div>
      )}
    </section>
  );
}

/** Period / date type / indicator selects (".bjkf"). */
function KfBar({ kf, setKf, noView }: { kf: Kf; setKf: (k: Kf) => void; noView?: boolean }) {
  const { t } = useTranslation();
  const set = (p: Partial<Kf>) => setKf({ ...kf, ...p });
  return (
    <div className="bjkf">
      <DateRange kf={kf} onChange={set} />
      <select aria-label={t('confirmation.stats.basis')} className="bjkf-sel bjkf-bas" value={kf.basis} onChange={(e) => set({ basis: e.target.value as Kf['basis'] })}>
        <option value="created">{t('confirmation.stats.created')}</option>
        <option value="updated">{t('confirmation.stats.updated')}</option>
      </select>
      {!noView && <select aria-label={t('confirmation.stats.view')} className="bjkf-sel bjkf-view" value={kf.view} onChange={(e) => set({ view: e.target.value as Kf['view'] })}>
        <option value="conf">{t('confirmation.stats.viewConf')}</option>
        <option value="deliv">{t('confirmation.stats.viewDeliv')}</option>
      </select>}
    </div>
  );
}

function Head({ title, help, children }: { title: string; help: string; children?: ReactNode }) {
  return (
    <div className="card-head">
      <h2>
        {title}
        <Help text={help} label={title} />
      </h2>
      {children}
    </div>
  );
}

const perLabel = (t: (k: string) => string, kf: Kf) => periodLabel(t, i18n.language || 'fr', kf);

// ---------------------------------------------------------------- Nouvelles: today only, live, no filters
/**
 * Nouvelles › Statistiques (the owner's design, 27 Nov 2026): today only, live, no filters — the one stats page without
 * them. The team's first calls today (volume, speed, result) with an arrow against yesterday at the same hour, what
 * waits right now, and one line per agent. The store's owner and administrators also get the load per agent and each
 * team side by side (an agency is one line: its agents stay private).
 */
const useNv = (open: boolean) => useRpc('confirmation.nouvelles', {}, { refetchInterval: 30_000, enabled: open });
type Nv = NonNullable<ReturnType<typeof useNv>['data']>;
type NvS = Nv['today'];
const pOf = (a: number, b: number) => (b > 0 ? Math.round((a * 100) / b) : null);
/** the change in points between two % (null when one is missing) */
const dPts = (a: number | null, b: number | null) => (a === null || b === null ? null : (a - b) / 100);

/** ▲ / ▼ in minutes against yesterday at the same hour (fewer minutes is better). */
function MinTrend({ v }: { v: number | null }) {
  const { t } = useTranslation();
  if (v === null || !isFinite(v)) return null;
  const r = Math.round(v);
  const good = r === 0 ? null : r < 0;
  return (
    <span className={`kpi-tr ${good === null ? '' : good ? 'good' : 'bad'}`} title={t('confirmation.nv.vsPrev')}>
      {r === 0 ? '=' : r > 0 ? '▲' : '▼'} {Math.abs(r)} min
    </span>
  );
}

function NouvellesStats({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const { t } = useTranslation();
  const q = useNv(open);
  const D = q.data;
  return (
    <section className={`card px-st px-nv ${open ? '' : 'folded'}`}>
      <button type="button" className="px-st-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="px-st-t">{t('confirmation.stats.title')}</span>
        {open && (
          <span className="bjfc-live">
            <i />
            {t('confirmation.nv.todayLive')}
          </span>
        )}
        <svg className="px-st-ch" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
        </svg>
      </button>
      {open && (q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !D ? <Loading /> : <NvBody D={D} />)}
    </section>
  );
}

function NvBody({ D }: { D: Nv }) {
  const { t } = useTranslation();
  const T = D.today;
  const P = D.prev;
  const fm = D.firstMinutes;
  const u5 = pOf(T.under5, T.called);
  const ot = pOf(T.onTime, T.called);
  const re = pOf(T.reached, T.called);
  const cv = pOf(T.converted, T.called);
  const vs = t('confirmation.nv.vsPrev');
  const recTrend = P.received > 0 ? (T.received - P.received) / P.received : null;
  const per = D.perAgent && D.perAgent.agents > 0 ? Math.round(D.perAgent.orders / D.perAgent.agents) : null;
  return (
    <div className="px-nv-body">
      <p className="px-nv-sec">{t(D.director ? 'confirmation.nv.secAll' : 'confirmation.nv.secTeam')}</p>
      <div className="px-nv-grp">
        <div className={`px-nv-g ${D.director ? 'g2' : 'g1'}`}>
          <span className="px-nv-gh">{t('confirmation.nv.gVolume')}</span>
          <div className="px-nv-gt">
            <Kpi icon="inbox" label={t('confirmation.nv.received')} value={n(T.received)} sub={t('confirmation.nv.receivedSub')} trend={<Trend v={recTrend} vs={vs} />} />
            {D.director && <Kpi icon="users" label={t('confirmation.nv.perAgent')} help={t('confirmation.nv.hPerAgent')} value={per === null ? '—' : n(per)} sub={t('confirmation.nv.perAgentSub', { n: D.perAgent?.agents ?? 0 })} />}
          </div>
        </div>
        <div className="px-nv-g g3">
          <span className="px-nv-gh">{t('confirmation.nv.gSpeed')}</span>
          <div className="px-nv-gt">
            <Kpi big tone={tone3(u5, 80, 60)} icon="sparkles" label={t('confirmation.nv.under5')} help={t('confirmation.kh.under5')} value={pctTxt(u5)} rate={u5 === null ? null : u5 / 100} sub={t('confirmation.nv.goal', { v: 80 })} trend={<Trend v={dPts(u5, pOf(P.under5, P.called))} pts vs={vs} />} />
            <Kpi tone={T.median === null ? undefined : T.median <= 5 ? 'ok' : T.median <= fm ? 'warn' : 'bad'} icon="timer" label={t('confirmation.nv.median')} help={t('confirmation.kh.median')} value={T.median === null ? '—' : dur(T.median * 60_000)} sub={t('confirmation.nv.medianSub')} trend={<MinTrend v={T.median === null || P.median === null ? null : T.median - P.median} />} />
            <Kpi tone={tone3(ot, 95, 85)} icon="check" label={t('confirmation.nv.onTime')} help={t('confirmation.kh.onTime', { first: fm })} value={pctTxt(ot)} sub={t('confirmation.nv.goal', { v: 95 })} trend={<Trend v={dPts(ot, pOf(P.onTime, P.called))} pts vs={vs} />} />
          </div>
        </div>
        <div className="px-nv-g g2">
          <span className="px-nv-gh">{t('confirmation.nv.gResult')}</span>
          <div className="px-nv-gt">
            <Kpi icon="phone" label={t('confirmation.nv.reached')} help={t('confirmation.nv.hReached')} value={pctTxt(re)} sub={t('confirmation.nv.reachedSub')} trend={<Trend v={dPts(re, pOf(P.reached, P.called))} pts vs={vs} />} />
            <Kpi icon="check" label={t('confirmation.nv.converted')} help={t('confirmation.nv.hConverted')} value={pctTxt(cv)} sub={t('confirmation.nv.convertedSub')} trend={<Trend v={dPts(cv, pOf(P.converted, P.called))} pts vs={vs} />} />
          </div>
        </div>
      </div>
      <p className="px-nv-sec">{t('confirmation.nv.now')}</p>
      <div className="px-nv-now">
        <Kpi icon="hourglass" label={t('confirmation.fc.waiting')} value={n(D.live.waiting)} sub={D.live.waiting ? t('confirmation.nv.waitingSub') : t('confirmation.fc.nobody')} />
        <Kpi tone={D.live.late ? 'bad' : undefined} icon="alert" label={t('confirmation.fc.lateNow')} help={t('confirmation.kh.late', { first: fm })} value={n(D.live.late)} sub={D.live.late ? t('confirmation.fc.lateSub') : t('confirmation.fc.noLate')} />
        <Kpi tone={D.live.noAgent ? 'warn' : undefined} icon="user" label={t('confirmation.nv.noAgent')} value={n(D.live.noAgent)} sub={D.live.noAgent ? t('confirmation.nv.noAgentSub') : t('confirmation.fc.allAssigned')} />
      </div>
      <NvAgents D={D} />
      {D.director && D.teams && D.teams.length > 0 && <NvTeams D={D} />}
    </div>
  );
}

/** Each agent today: the same numbers as the team; the team line adds up every call (never an average of agents). */
function NvAgents({ D }: { D: Nv }) {
  const { t } = useTranslation();
  const T = D.today;
  const teamRe = pOf(T.reached, T.called);
  const teamCv = pOf(T.converted, T.called);
  const cols = ['cCalled', 'cUnder5', 'cMedian', 'cOnTime', 'cReached', 'cConverted', 'cLate'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.nv.${k}`);
  const row = (a: Omit<NvS, 'received'> & { late: number }, few: boolean) => {
    const u5 = pOf(a.under5, a.called);
    const re = pOf(a.reached, a.called);
    const cv = pOf(a.converted, a.called);
    const half = (p: number | null, team: number | null) => !few && p !== null && team !== null && team > 0 && p < team / 2;
    return [
      <td key="c" className="num ltr" data-l={head('cCalled')}>{n(a.called)}</td>,
      <td key="u" className={`num ltr${!few && u5 !== null && u5 < 60 ? ' px-nv-bad' : ''}`} data-l={head('cUnder5')}>{pctTxt(u5)}</td>,
      <td key="m" className={`num ltr${!few && a.median !== null && a.median > 5 ? ' px-nv-bad' : ''}`} data-l={head('cMedian')}>{a.median === null ? '—' : dur(a.median * 60_000)}</td>,
      <td key="o" className="num ltr" data-l={head('cOnTime')}>{pctTxt(pOf(a.onTime, a.called))}</td>,
      <td key="r" className={`num ltr${half(re, teamRe) ? ' px-nv-bad' : ''}`} data-l={head('cReached')} title={half(re, teamRe) ? t('confirmation.nv.flag') : undefined}>
        {half(re, teamRe) && <Icon name="flag" />} {pctTxt(re)}
      </td>,
      <td key="v" className={`num ltr${half(cv, teamCv) ? ' px-nv-bad' : ''}`} data-l={head('cConverted')}>{pctTxt(cv)}</td>,
      <td key="l" className={`num ltr${a.late ? ' px-nv-bad' : ''}`} data-l={head('cLate')}>{n(a.late)}</td>,
    ];
  };
  return (
    <div className="px-nv-tw">
      <p className="px-nv-sec">{t('confirmation.nv.byAgent')}</p>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-nv-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.col.agent')}</th>
              {cols.map((k) => (
                <th key={k} className="num">{head(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {D.agents.length ? (
              D.agents.map((a) => {
                const few = a.called < 20;
                return (
                  <tr key={a.id} className={few ? 'px-nv-few' : undefined} title={few ? t('confirmation.nv.few') : undefined}>
                    <td data-l={t('confirmation.col.agent')}><b>{a.name}</b></td>
                    {row(a, few)}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="empty">{t('confirmation.nv.empty')}</td>
              </tr>
            )}
          </tbody>
          {D.agents.length > 1 && (
            <tfoot>
              <tr>
                <td data-l={t('confirmation.col.agent')}><b>{t('confirmation.nv.teamRow')}</b></td>
                {row({ ...T, late: D.agents.reduce((s, a) => s + a.late, 0) }, true)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="px-nv-note">{t('confirmation.nv.rules')}</p>
    </div>
  );
}

/** The store's owner: each team side by side, and each agency as one line (its agents stay private). */
function NvTeams({ D }: { D: Nv }) {
  const { t } = useTranslation();
  const rows = D.teams ?? [];
  const avg = D.perAgent && D.perAgent.agents > 0 ? D.perAgent.orders / D.perAgent.agents : null;
  const cols = ['cAgents', 'cNew', 'cPerAgent', 'cUnder5', 'cMedian', 'cConverted', 'cLate'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.nv.${k}`);
  return (
    <div className="px-nv-tw">
      <p className="px-nv-sec">{t('confirmation.nv.byTeam')}</p>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-nv-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.nv.cTeam')}</th>
              {cols.map((k) => (
                <th key={k} className="num">{head(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const per = r.agents ? Math.round(r.received / r.agents) : null;
              const u5 = pOf(r.under5, r.called);
              const load = per === null || avg === null ? '' : per > avg * 1.3 ? ' px-nv-bad' : per < avg * 0.7 ? ' px-nv-light' : '';
              return (
                <tr key={r.key}>
                  <td data-l={t('confirmation.nv.cTeam')}>
                    <b>{r.name}</b> {r.kind === 'agency' && <span className="badge t-warn">{t('confirmation.nv.agency')}</span>}
                  </td>
                  <td className="num" data-l={head('cAgents')}>
                    {r.agents === null ? (
                      <span className="muted"><Icon name="lock" /> {t('confirmation.nv.private')}</span>
                    ) : (
                      <span className="ltr">{n(r.agents)}</span>
                    )}
                  </td>
                  <td className="num ltr" data-l={head('cNew')}>{n(r.received)}</td>
                  <td className={`num ltr${load}`} data-l={head('cPerAgent')}>{per === null ? '—' : n(per)}</td>
                  <td className={`num ltr${u5 !== null && u5 < 60 ? ' px-nv-bad' : ''}`} data-l={head('cUnder5')}>{pctTxt(u5)}</td>
                  <td className={`num ltr${r.median !== null && r.median > 5 ? ' px-nv-bad' : ''}`} data-l={head('cMedian')}>{r.median === null ? '—' : dur(r.median * 60_000)}</td>
                  <td className="num ltr" data-l={head('cConverted')}>{pctTxt(pOf(r.converted, r.called))}</td>
                  <td className={`num ltr${r.late ? ' px-nv-bad' : ''}`} data-l={head('cLate')}>{n(r.late)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- En cours: one card, like Confirmées
/**
 * En cours › Statistiques. Same card and dropdowns as Confirmées (period, date type, indicator).
 * "À traiter maintenant" is live (every order of the tab, whatever the dates); "Performance" and the
 * agent table follow the dropdowns; "Performance de livraison" shows what became of the confirmed orders.
 */
function EnCoursCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.enCours', kfInput(kf), { refetchInterval: 30_000, enabled: kf.view === 'conf' });
  const now = useNow();
  const D = q.data;
  const L = (k: string) => t(`confirmation.ek.col.${k}`);
  const badge = (p: number | null, ok: number, warn: number) => <span className={`badge t-${tone3(p, ok, warn) ?? 'off'} ltr`}>{pctTxt(p)}</span>;
  let body: ReactNode = <Loading />;
  if (kf.view === 'deliv') body = <DelivBody kf={kf} on="confirmed" />;
  else if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D) {
    const lateAge = D.lateOldest ? Math.max(0, now - Date.parse(D.lateOldest.since)) : null;
    const nextIn = D.nextLater ? Math.max(0, Date.parse(D.nextLater.at) - now) : null;
    const early = Math.max(0, D.cancelled - D.complete);
    body = (
      <div>
        <div className="bjec-sec">{t('confirmation.ek.secLive')}</div>
        <div className="kpis">
          <Kpi tone={D.dueNow ? 'warn' : undefined} label={t('confirmation.ek.due')} help={t('confirmation.ek.dueHelp')} value={n(D.dueNow)} sub={t('confirmation.ek.dueSub', { n: D.count })} />
          <Kpi
            tone={D.late ? 'bad' : undefined}
            label={t('confirmation.ek.late')}
            help={t('confirmation.ek.lateHelp')}
            value={n(D.late)}
            sub={D.lateOldest && lateAge !== null ? t('confirmation.ek.lateSub', { d: dur(lateAge), ref: D.lateOldest.ref }) : t('confirmation.ek.lateNone')}
          />
          <Kpi
            label={t('confirmation.ek.later')}
            help={t('confirmation.ek.laterHelp')}
            value={n(D.later)}
            sub={D.nextLater && nextIn !== null ? t('confirmation.ek.laterSub', { d: dur(nextIn), ref: D.nextLater.ref }) : t('confirmation.ek.laterNone')}
          />
          <Kpi label={t('confirmation.ek.value')} help={t('confirmation.ek.valueHelp')} value={da(D.value)} sub={t('confirmation.ek.valueSub', { n: D.count })} />
        </div>
        <div className="bjec-sec">
          {t('confirmation.ek.secPerf')} · {perLabel(t, kf)}
        </div>
        <div className="kpis">
          <Kpi tone={tone3(D.confRate, 60, 40)} label={t('confirmation.ek.conf')} help={t('confirmation.ek.confHelp')} value={pctTxt(D.confRate)} sub={t('confirmation.ek.confSub', { c: D.confirmed, x: D.cancelled })} />
          <Kpi tone={tone3(D.recoveryRate, 60, 40)} label={t('confirmation.ek.rec')} help={t('confirmation.ek.recHelp')} value={pctTxt(D.recoveryRate)} sub={t('confirmation.ek.recSub', { r: D.recovered, l: D.lost })} />
          <Kpi
            tone={tone3(D.completeRate, 100, 80)}
            label={t('confirmation.ek.full')}
            help={t('confirmation.ek.fullHelp')}
            value={pctTxt(D.completeRate)}
            sub={D.cancelled ? t('confirmation.ek.fullSub', { c: D.complete, n: D.cancelled }) : t('confirmation.ek.fullNone')}
          />
          <Kpi tone={early ? 'bad' : D.cancelled ? 'ok' : undefined} label={t('confirmation.ek.early')} help={t('confirmation.ek.earlyHelp')} value={n(early)} sub={t('confirmation.ek.earlySub')} />
        </div>
        <h3>{t('confirmation.ek.byAgent')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{L('agent')}</th>
                <th className="num">{L('n')}</th>
                <th className="num">{L('due')}</th>
                <th className="num">{L('late')}</th>
                <th className="num">{L('conf')}</th>
                <th className="num">{L('rec')}</th>
                <th className="num">{L('full')}</th>
              </tr>
            </thead>
            <tbody>
              {D.byAgent.length ? (
                D.byAgent.map((a) => (
                  <tr key={a.agentId ?? 0}>
                    <td data-l={L('agent')}>
                      <b>{a.name ?? t('confirmation.noAgent')}</b>
                    </td>
                    <td className="num ltr" data-l={L('n')}>
                      {n(a.n)}
                    </td>
                    <td className="num ltr" data-l={L('due')}>
                      {a.due ? <b>{n(a.due)}</b> : '0'}
                    </td>
                    <td className="num" data-l={L('late')}>
                      <span className={`badge t-${a.late ? 'bad' : 'off'} ltr`}>{n(a.late)}</span>
                    </td>
                    <td className="num" data-l={L('conf')}>
                      {badge(a.confRate, 60, 40)}
                    </td>
                    <td className="num" data-l={L('rec')}>
                      {badge(a.recoveryRate, 60, 40)}
                    </td>
                    <td className="num" data-l={L('full')}>
                      {badge(a.completeRate, 100, 80)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {t('confirmation.ek.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small px-ek-legend">{t('confirmation.ek.legend')}</p>
      </div>
    );
  }
  return (
    <div className="card bjkfc bjek">
      <Head title={t('confirmation.ek.title')} help={t('confirmation.ek.help')}>
        <KfBar kf={kf} setKf={setKf} />
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Nouvelles
function FirstCallCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.firstCall', kfInput(kf), { refetchInterval: 30_000 });
  const now = useNow();
  const D = q.data;
  const BUCKETS = [
    ['< 5 min', '#1e8a4c'],
    ['5–15 min', '#62b37c'],
    ['15–30 min', '#e0a100'],
    ['30–60 min', '#e07b39'],
    ['> 1 h', '#c9534b'],
  ] as const;
  let body: ReactNode = <Loading />;
  if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D) {
    const fm = D.firstMinutes;
    const pOk = D.called ? Math.round((D.onTime * 100) / D.called) : null;
    const f5 = D.called ? Math.round((D.under5 * 100) / D.called) : null;
    const age = D.oldest ? Math.max(0, now - Date.parse(D.oldest.since)) : null;
    const med = D.medianMin;
    body = (
      <>
        <div>
          <div className="bjfc-row">
            <span className="bjfc-rl">{t('confirmation.fc.now')}</span>
            <div className="bjfc-k">
              <Kpi
                big={D.waiting > 0}
                tone={D.waiting ? undefined : 'ok'}
                label={t('confirmation.fc.waiting')}
                value={n(D.waiting)}
                sub={D.waiting ? (D.waitingNoAgent ? t('confirmation.fc.noAgent', { n: D.waitingNoAgent }) : t('confirmation.fc.allAssigned')) : t('confirmation.fc.nobody')}
              />
              <Kpi big={D.late > 0} tone={D.late ? 'bad' : 'ok'} label={t('confirmation.fc.lateNow')} value={n(D.late)} sub={D.late ? t('confirmation.fc.lateSub') : t('confirmation.fc.noLate')} />
              <Kpi
                tone={age === null ? 'ok' : age > fm * 60_000 ? 'bad' : age > fm * 30_000 ? 'warn' : 'ok'}
                label={t('confirmation.fc.oldest')}
                value={age === null ? '—' : dur(age)}
                sub={D.oldest ? `${D.oldest.ref} · ${D.oldest.name}` : ' '}
              />
            </div>
          </div>
          <div className="bjfc-row">
            <span className="bjfc-rl">{perLabel(t, kf)}</span>
            <div className="bjfc-k">
              <Kpi label={t('confirmation.fc.recvCalled')} value={`${n(D.received)} / ${n(D.called)}`} sub={t('confirmation.fc.recvCalledSub')} />
              <Kpi tone={tone3(pOk, 80, 70)} label={t('confirmation.fc.onTime')} value={pctTxt(pOk)} sub={D.called ? t('confirmation.fc.onTimeSub', { ok: D.onTime, n: D.called }) : t('confirmation.fc.noneCalled')} />
              <Kpi
                tone={med === null ? undefined : med <= fm ? 'ok' : med <= fm * 2 ? 'warn' : 'bad'}
                label={t('confirmation.fc.median')}
                value={med === null ? '—' : dur(med * 60_000)}
                sub={D.called ? t('confirmation.fc.medianSub') : ' '}
              />
              <Kpi tone={tone3(f5, 50, 25)} label={t('confirmation.fc.under5')} value={pctTxt(f5)} sub={D.called ? t('confirmation.fc.under5Sub') : ' '} />
            </div>
          </div>
        </div>
        {D.called > 0 && (
          <div>
            <h3 style={{ margin: '6px 0 8px' }}>{t('confirmation.fc.dist')}</h3>
            <div className="bjfc-dist">
              {BUCKETS.map(([l, c], i) =>
                D.buckets[i] ? (
                  <span key={l} style={{ background: c, flex: D.buckets[i] }} title={`${l} : ${D.buckets[i]}`}>
                    {(D.buckets[i] * 100) / D.called >= 8 ? `${Math.round((D.buckets[i] * 100) / D.called)} %` : ''}
                  </span>
                ) : null,
              )}
            </div>
            <div className="bjfc-lg">
              {BUCKETS.map(([l, c], i) => (
                <span key={l}>
                  <i style={{ background: c }} />
                  {l} · {D.buckets[i]}
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="card bjfc">
      <Head title={t('confirmation.fc.title')} help={t('confirmation.fc.help', { first: D?.firstMinutes ?? 15 })}>
        <div className="row">
          <span className="bjfc-live">
            <i />
            {t('confirmation.fc.live')}
          </span>
          <KfBar kf={kf} setKf={setKf} />
        </div>
      </Head>
      {body}
    </div>
  );
}

function DelivBody({ kf, on, bare }: { kf: Kf; on: 'created' | 'confirmed'; bare?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.delivery', { ...kfInput(kf), on }, { refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const D = q.data;
  if (!D) return <Loading />;
  return (
    <div>
      {!bare && (
        <div className="bjec-sec">
          {t('confirmation.dv.sec')} · {perLabel(t, kf)}
        </div>
      )}
      <div className="kpis">
        {!bare && <Kpi label={t('confirmation.dv.confirmed')} value={n(D.confirmed)} sub={`${t('confirmation.dv.confirmedSub')} · ${da(D.value)}`} />}
        <Kpi label={t('confirmation.dv.depot')} value={n(D.depot)} sub={t('confirmation.dv.depotSub')} />
        <Kpi tone={D.route ? 'warn' : undefined} label={t('confirmation.dv.route')} value={n(D.route)} sub={t('confirmation.dv.routeSub')} />
        {!bare && <Kpi tone="ok" label={t('confirmation.dv.delivered')} value={n(D.delivered)} sub={t('confirmation.dv.deliveredSub', { v: da(D.deliveredValue) })} />}
        <Kpi tone={D.back ? 'bad' : undefined} label={t('confirmation.dv.back')} value={n(D.back)} sub={t('confirmation.dv.backSub')} />
        {!bare && <Kpi tone={tone3(D.rate, 75, 60)} label={t('confirmation.dv.rate')} value={pctTxt(D.rate)} sub={t('confirmation.dv.rateSub')} />}
        <Kpi label={t('confirmation.dv.overall')} value={pctTxt(D.overall)} sub={D.cancelledAfter ? t('confirmation.dv.cancelledAfter', { n: D.cancelledAfter }) : t('confirmation.dv.allConfirmed')} />
      </div>
    </div>
  );
}

function PeriodCard({ kf, setKf }: { kf: Kf; setKf: (k: Kf) => void }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.period', kfInput(kf), { refetchInterval: 60_000, enabled: kf.view === 'conf' });
  const D = q.data;
  let body: ReactNode = <Loading />;
  if (kf.view === 'deliv') body = <DelivBody kf={kf} on="created" />;
  else if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D)
    body = (
      <div className="kpis">
        <Kpi label={t('confirmation.np.recv')} value={n(D.received)} sub={`${perLabel(t, kf)} · ${da(D.value)}`} />
        <Kpi tone={D.notCalled ? 'warn' : undefined} label={t('confirmation.np.notCalled')} value={n(D.notCalled)} sub={D.notCalledNoAgent ? t('confirmation.fc.noAgent', { n: D.notCalledNoAgent }) : t('confirmation.np.allAgent')} />
        <Kpi label={t('confirmation.np.called')} value={n(D.called)} sub={D.calledPct === null ? ' ' : t('confirmation.np.calledSub', { p: D.calledPct })} />
        <Kpi tone="ok" label={t('confirmation.np.confirmed')} value={n(D.confirmed)} sub={t('confirmation.np.confirmedSub')} />
        <Kpi tone={D.cancelled ? 'bad' : undefined} label={t('confirmation.np.cancelled')} value={n(D.cancelled)} sub={t('confirmation.np.cancelledSub')} />
        <Kpi tone={tone3(D.rate, 60, 40)} label={t('confirmation.np.rate')} value={pctTxt(D.rate)} sub={t('confirmation.np.rateSub')} />
      </div>
    );
  return (
    <div className="card bjkfc bjnew">
      <Head title={t('confirmation.np.title')} help={t('confirmation.np.help')}>
        <KfBar kf={kf} setKf={setKf} />
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Confirmées
function ConfirmedCard({ kf, setKf, bare }: { kf: Kf; setKf: (k: Kf) => void; bare?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('confirmation.confirmed', kfInput(kf), { refetchInterval: 60_000, enabled: kf.view === 'conf' });
  const D = q.data;
  let body: ReactNode = <Loading />;
  if (kf.view === 'deliv') body = <DelivBody kf={kf} on="confirmed" />;
  else if (q.error) body = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (D)
    body = (
      <div>
        {bare ? (
          // the page already shows confirmées, rate, basket and CA upsell on top
          <div className="kpis">
            <Kpi label={t('confirmation.cf.lead')} value={D.leadMedianMs === null ? '—' : dur(D.leadMedianMs)} sub={t('confirmation.cf.leadSub')} />
            <Kpi label={t('confirmation.cf.upOrders')} value={n(D.upsellOrders)} sub={t('confirmation.cf.upOrdersSub')} />
            <Kpi tone={D.upsellRate === null ? undefined : D.upsellRate >= 20 ? 'ok' : 'warn'} label={t('confirmation.cf.upRate')} value={pctTxt(D.upsellRate)} sub={t('confirmation.cf.upRateSub')} />
            <Kpi label={t('confirmation.cf.packs')} value={n(D.packs)} sub={t('confirmation.cf.packsSub')} />
          </div>
        ) : (
          <>
            <div className="bjec-sec">
              {t('confirmation.cf.sec')} · {perLabel(t, kf)}
            </div>
            <div className="kpis">
              <Kpi tone="ok" label={t('confirmation.cf.confirmed')} value={n(D.confirmed)} sub={t('confirmation.ec.value', { v: da(D.value) })} />
              <Kpi tone={tone3(D.rate, 60, 40)} label={t('confirmation.np.rate')} value={pctTxt(D.rate)} sub={t('confirmation.cf.rateSub', { n: D.cancelled })} />
              <Kpi label={t('confirmation.cf.basket')} value={D.basket === null ? '—' : da(D.basket)} sub={D.itemsPerOrder === null ? ' ' : t('confirmation.cf.basketSub', { n: String(Math.round(D.itemsPerOrder * 10) / 10).replace('.', ',') })} />
              <Kpi label={t('confirmation.cf.lead')} value={D.leadMedianMs === null ? '—' : dur(D.leadMedianMs)} sub={t('confirmation.cf.leadSub')} />
            </div>
            <div className="bjec-sec">{t('confirmation.cf.upsell')}</div>
            <div className="kpis">
              <Kpi label={t('confirmation.cf.upOrders')} value={n(D.upsellOrders)} sub={t('confirmation.cf.upOrdersSub')} />
              <Kpi tone={D.upsellRate === null ? undefined : D.upsellRate >= 20 ? 'ok' : 'warn'} label={t('confirmation.cf.upRate')} value={pctTxt(D.upsellRate)} sub={t('confirmation.cf.upRateSub')} />
              <Kpi tone="ok" label={t('confirmation.cf.upValue')} value={da(D.upsellValue)} sub={t('confirmation.cf.upValueSub')} />
              <Kpi label={t('confirmation.cf.packs')} value={n(D.packs)} sub={t('confirmation.cf.packsSub')} />
            </div>
          </>
        )}
        <h3>{t('confirmation.byAgent')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('confirmation.col.agent')}</th>
                <th className="num">{t('confirmation.cf.confirmed')}</th>
                <th className="num">{t('confirmation.cf.colValue')}</th>
                <th className="num">{t('confirmation.cf.basket')}</th>
                <th className="num">{t('confirmation.cf.colUp')}</th>
                <th className="num">{t('confirmation.cf.colUpRate')}</th>
                <th className="num">{t('confirmation.cf.upValue')}</th>
              </tr>
            </thead>
            <tbody>
              {D.byAgent.length ? (
                D.byAgent.map((a) => {
                  const r = a.n ? Math.round((a.up * 100) / a.n) : 0;
                  return (
                    <tr key={a.agentId ?? 0}>
                      <td data-l={t('confirmation.col.agent')}>
                        <b>{a.name ?? t('confirmation.noAgent')}</b>
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.confirmed')}>
                        {n(a.n)}
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.colValue')}>
                        {da(a.value)}
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.basket')}>
                        {a.n ? da(Math.round(a.value / a.n)) : '—'}
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.colUp')}>
                        {n(a.up)}
                      </td>
                      <td className="num" data-l={t('confirmation.cf.colUpRate')}>
                        <span className={`badge t-${r >= 20 ? 'ok' : r > 0 ? 'warn' : 'off'} ltr`}>{r} %</span>
                      </td>
                      <td className="num ltr" data-l={t('confirmation.cf.upValue')}>
                        <b>{da(a.upValue)}</b>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {t('confirmation.cf.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  return (
    <div className="card bjkfc bjcf">
      <Head title={bare ? t('confirmation.cs.detail') : t('confirmation.cf.title')} help={t('confirmation.cf.help')}>
        {!bare && <KfBar kf={kf} setKf={setKf} />}
      </Head>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Confirmation › Statistiques: one page
/** Everything about the leads of the period (confirmation.overview): the key numbers, where the leads go, why we lose
 * them, when they come in and how fast they are called, each agent, each product, what became of the confirmed ones.
 * Qualité des leads is judged with Pilot Checks « Qualité des leads » (Q2), the shop's own limits. */
type Ov = NonNullable<ReturnType<typeof useOverview>['data']>;
type Verdict = 'bon' | 'moyen' | 'mauvais' | 'stop' | 'none';
/** Judged at once with the Pilot Checks limits (good, alert, stop), however few the real leads: no « Trop tôt » on this
 * page (the owner's ask, 22 Nov 2026; the ads keep their wait). No real lead yet: no judgement. */
const verdictOf = (p: number | null, L: Ov['limits']): Verdict =>
  p === null ? 'none' : p >= L.good ? 'bon' : p >= L.alert ? 'moyen' : p >= L.stop ? 'mauvais' : 'stop';
const V_CLASS: Record<Verdict, string> = { bon: 'ok', moyen: 'warn', mauvais: 'bad', stop: 'bad px-ov-stop', none: 'off' };
const V_TONE: Record<Verdict, Tone | undefined> = { bon: 'ok', moyen: 'warn', mauvais: 'bad', stop: 'bad', none: undefined };
const pp = (p: number | null) => (p === null ? '—' : `${p} %`);
const mn = (m: number | null) => (m === null ? '—' : dur(m * 60_000));
/** A duration with its words (« 1 h 05 », « 1 سا 05 »), written in the page's direction: in Arabic it never reads « 100 ». */
function Dur({ m }: { m: number | null }) {
  const { i18n } = useTranslation();
  return <span dir={i18n.dir()}>{mn(m)}</span>;
}
const pcOf = (a: number, b: number) => (b > 0 ? Math.round((a * 100) / b) : null);
const useOverview = (kf: Kf) => useRpc('confirmation.overview', kfInput(kf), { refetchInterval: 60_000 });

function VerdictPill({ v }: { v: Verdict }) {
  const { t } = useTranslation();
  return v === 'none' ? null : <span className={`badge t-${V_CLASS[v]} px-ov-v`}>{t(`confirmation.ov.v.${v}`)}</span>;
}
function Bar({ v, max, cls = '' }: { v: number; max: number; cls?: string }) {
  return (
    <span className="px-ov-track" aria-hidden="true">
      <i className={cls} style={{ width: `${max > 0 ? Math.round((v / max) * 1000) / 10 : 0}%` }} />
    </span>
  );
}
const callHref = (O: Ov) => `#/confirmation/${O.pending.noAnswer + O.pending.later > 0 ? 'attente' : 'nouvelles'}`;

function OvFunnel({ O, kf }: { O: Ov; kf: Kf }) {
  const { t } = useTranslation();
  const dq = useRpc('confirmation.delivery', { ...kfInput(kf), on: 'confirmed' }, { refetchInterval: 60_000 });
  const D = dq.data;
  const toCall = O.pending.noAnswer + O.pending.later;
  // only what was really taken out: « Retirés : 3 doublons », red only when there were attacks
  const removed = [
    O.attacks.n ? t('confirmation.ov.rmA', { count: O.attacks.n }) : '',
    O.duplicates.n ? t('confirmation.ov.rmD', { count: O.duplicates.n }) : '',
  ].filter(Boolean);
  const steps:{ label: string; v: number; note: string | null; bad?: boolean; hi?: boolean; wait?: boolean }[] = [
    { label: t('confirmation.ov.received'), v: O.received, note: O.pending.fresh ? t('confirmation.ov.nNotCalled', { count: O.pending.fresh }) : null },
    { label: t('confirmation.ov.fCalled'), v: O.received - O.pending.fresh, note: toCall ? t('confirmation.ov.nToCall', { count: toCall }) : null },
    { label: t('confirmation.ov.fFinished'), v: O.finished, note: removed.length ? t('confirmation.ov.nRemoved', { list: removed.join(' · ') }) : null, bad: O.attacks.n > 0 },
    { label: t('confirmation.ov.fReal'), v: O.real, note: O.refused.n ? t('confirmation.ov.nRefused', { count: O.refused.n }) : null },
    { label: t('confirmation.ov.confirmed'), v: O.confirmed.n, hi: true, note: D ? t('confirmation.ov.nDepot', { d: n(D.depot), r: n(D.route) }) : null },
    { label: t('confirmation.ov.fDelivered'), v: D?.delivered ?? 0, note: D && !D.delivered ? t('confirmation.ov.nNoDelivery') : null, wait: true },
  ];
  return (
    <div className="card px-ov-card px-ov-funnel">
      <div className="card-head">
        <h2>{t('confirmation.ov.funnel', { n: n(O.received) })}</h2>
      </div>
      <div className="px-ov-steps">
        {steps.map((s) => (
          <div className="px-ov-step" key={s.label}>
            <span className="px-ov-step-l">{s.label}</span>
            <Bar v={s.v} max={O.received} cls={s.hi ? 'hi' : ''} />
            <b className="ltr">{n(s.v)}</b>
            {s.note && (
              <span className={`px-ov-step-n${s.bad ? ' bad' : ''}`}>
                <Icon name={s.wait ? 'hourglass' : 'trenddown'} /> {s.note}
              </span>
            )}
          </div>
        ))}
      </div>
      {O.pending.n > 0 && (
        <div className="px-ov-wait">
          <div className="grow">
            <b>{t('confirmation.ov.waiting', { n: n(O.pending.n), v: da(O.pending.value) })}</b>
            <small>{t('confirmation.ov.waitingSub', { a: n(O.pending.noAnswer + O.pending.later), f: n(O.pending.fresh) })}</small>
          </div>
          <a className="btn primary" href={callHref(O)}>
            <Icon name="phone" /> {t('confirmation.ov.callBtn')}
          </a>
        </div>
      )}
    </div>
  );
}

function OvLosses({ O }: { O: Ov }) {
  const { t } = useTranslation();
  const A = O.attacks;
  const max = Math.max(1, ...O.refused.reasons.map((r) => r.n), A.fake, A.wrong, A.noAnswer, O.duplicates.n);
  const row = (label: string, k: number, money: string, cls: string, sub?: string) => (
    <div className="px-ov-loss" key={label}>
      <span className="px-ov-loss-l">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <b className="ltr">{n(k)}</b>
      <span className="px-ov-loss-m ltr">{money}</span>
      <Bar v={k} max={max} cls={cls} />
    </div>
  );
  const lost = O.refused.n + A.n + O.duplicates.n;
  return (
    <div className="card px-ov-card px-ov-losses">
      <div className="card-head">
        <h2>{t('confirmation.ov.lost')}</h2>
        <span className="muted">{t('confirmation.ov.lostMeta', { n: n(lost) })}</span>
      </div>
      <p className="px-ov-g">{t('confirmation.ov.gClient')}</p>
      {O.refused.reasons.length ? (
        O.refused.reasons.map((r) => row(r.code === 'none' ? t('confirmation.ov.reasonNone') : t(`status.cancelReason.${r.code}`, { defaultValue: r.code }), r.n, da(r.value), ''))
      ) : (
        <p className="px-ov-none">—</p>
      )}
      <p className="px-ov-g">{t('confirmation.ov.gAttacks')}</p>
      {row(t('confirmation.ov.aFake'), A.fake, da(A.fakeValue), 'bad')}
      {row(t('confirmation.ov.aWrong'), A.wrong, da(A.wrongValue), 'bad')}
      {row(
        t('confirmation.ov.aNoAnswer'),
        A.noAnswer,
        A.noAnswer ? da(A.noAnswerValue) : '—',
        'bad',
        O.cancelAfter > 0 ? t('confirmation.ov.aNoAnswerSub', { n: O.cancelAfter, w: n(O.night.noAnswerAll) }) : t('confirmation.ov.aNoAnswerOff', { w: n(O.night.noAnswerAll) }),
      )}
      <p className="px-ov-g">{t('confirmation.ov.gOther')}</p>
      {row(t('confirmation.ov.dup'), O.duplicates.n, da(O.duplicates.value), 'off')}
      <div className="px-ov-total">
        <span className="grow">
          <b>{t('confirmation.ov.totalLost')}</b>
          <small>{t('confirmation.ov.totalLostSub', { n: n(O.refused.n), v: da(O.refused.value) })}</small>
        </span>
        <b className="ltr">{n(lost)}</b>
      </div>
      {O.carts.n > 0 && (
        <p className="px-ov-note">
          <Icon name="cart" /> {t(O.carts.confirmed ? 'confirmation.ov.carts' : 'confirmation.ov.carts0', { n: n(O.carts.n), c: n(O.carts.confirmed), v: da(O.carts.value), x: n(O.carts.n - O.carts.confirmed) })}
        </p>
      )}
    </div>
  );
}

function OvHours({ O }: { O: Ov }) {
  const { t, i18n } = useTranslation();
  const top = Math.max(4, Math.ceil(Math.max(...O.hours) / 4) * 4);
  const work = (h: number) => O.slots.some((s) => h >= s.from && h < s.to);
  return (
    <div className="card px-ov-card px-ov-hours">
      <div className="card-head">
        <h2>{t('confirmation.ov.hours')}</h2>
        <span className="muted">{t('confirmation.ov.hoursMeta', { n: n(O.received) })}</span>
      </div>
      <div className="px-ov-legend">
        <span>
          <i className="w" /> {t('confirmation.ov.work')}
        </span>
        <span>
          <i className="off" /> {t('confirmation.ov.off')}
        </span>
      </div>
      <div className="px-ov-chart ltr">
        <div className="px-ov-y">
          {[top, top / 2, 0].map((v) => (
            <span key={v}>{v}</span>
          ))}
        </div>
        <div className="px-ov-plot">
          {O.hours.map((c, h) => (
            <div key={h} className={`px-ov-hr${work(h) ? ' w' : ''}`} title={t('confirmation.ov.hourTip', { h, n: c })}>
              {c > 0 && <i className={work(h) ? '' : 'off'} style={{ height: `${Math.max(4, (c / top) * 100)}%` }} />}
            </div>
          ))}
        </div>
        <div className="px-ov-x">
          {O.hours.map((_, h) => (
            <span key={h} dir={i18n.dir()}>
              {h % 3 === 0 ? t('confirmation.ov.h', { h }) : ''}
            </span>
          ))}
        </div>
      </div>
      {O.night.n > 0 && (
        <p className="px-ov-note">
          <Icon name="moon" /> {t('confirmation.ov.nightNote', { n: n(O.night.n), p: pp(pcOf(O.night.n, O.received)), a: n(O.night.noAnswer), b: n(O.night.noAnswerAll) })}
        </p>
      )}
    </div>
  );
}

function OvSpeed({ O }: { O: Ov }) {
  const { t } = useTranslation();
  const S = O.speed;
  const slow = S.givenMedianMin !== null && S.dayMedianMin !== null && S.dayMedianMin > S.firstMinutes && S.givenMedianMin * 2 >= S.dayMedianMin;
  return (
    <div className="card px-ov-card px-ov-speed">
      <div className="card-head">
        <h2>{t('confirmation.ov.speed')}</h2>
      </div>
      <div className="px-ov-boxes">
        <div className="px-ov-box">
          <span className="px-ov-box-l">
            <Icon name="sun" /> {t('confirmation.ov.day')}
          </span>
          <b>
            <Dur m={S.dayMedianMin} />
          </b>
          <small>{S.givenMedianMin === null ? t('confirmation.ov.daySubPlain') : t('confirmation.ov.daySub', { g: mn(S.givenMedianMin) })}</small>
        </div>
        <div className="px-ov-box">
          <span className="px-ov-box-l">
            <Icon name="moon" /> {t('confirmation.ov.night')}
          </span>
          <b>
            <Dur m={S.nightMedianMin} />
          </b>
          {S.nightAfterOpenMedianMin !== null && <small>{t('confirmation.ov.nightSub', { o: mn(S.nightAfterOpenMedianMin) })}</small>}
        </div>
      </div>
      <div className="px-ov-ontime">
        <span>
          <b>{t('confirmation.ov.onTime')}</b> <small>{t('confirmation.ov.onTimeSub', { m: S.firstMinutes })}</small>
        </span>
        <b>{t('confirmation.ov.onTimeOf', { a: n(S.onTime), b: n(S.dayCalled) })}</b>
        <Bar v={S.onTime} max={S.dayCalled} cls="ok" />
      </div>
      {slow && (
        <p className="px-ov-note">
          <Icon name="alert" /> {t('confirmation.ov.givenNote')}
        </p>
      )}
    </div>
  );
}

function OvAgents({ O }: { O: Ov }) {
  const { t } = useTranslation();
  const L = O.limits;
  const parts = (a: Ov['byAgent'][number]) =>
    [a.fake ? t('confirmation.ov.pFake', { n: a.fake }) : '', a.wrong ? t('confirmation.ov.pWrong', { n: a.wrong }) : '', a.noAnswer ? t('confirmation.ov.pNoAnswer', { n: a.noAnswer }) : '', a.duplicates ? t('confirmation.ov.pDup', { n: a.duplicates }) : '']
      .filter(Boolean)
      .join(' · ');
  const lqCell = (p: number | null) => {
    const v = verdictOf(p, L);
    return (
      <span className="px-ov-lq">
        <b className="ltr">{pp(p)}</b> <VerdictPill v={v} />
      </span>
    );
  };
  // the agent the old formula hurts most (attacks counted against him)
  const hurt = O.byAgent
    .filter((a) => a.attacks > 0 && a.leadsQuality !== null && a.oldRate !== null && a.leadsQuality - a.oldRate >= 10)
    .sort((a, b) => b.leadsQuality! - b.oldRate! - (a.leadsQuality! - a.oldRate!))[0];
  const cols = ['cTreated', 'confirmed', 'cRefused', 'cAttacks', 'cToCall', 'lq', 'cOld', 'cUp', 'upRate', 'cDelivered'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.ov.${k}`);
  return (
    <div className="card px-ov-card">
      <div className="card-head">
        <h2>{t('confirmation.ov.byAgent')}</h2>
        <span className="muted">{t('confirmation.ov.byAgentMeta')}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.col.agent')}</th>
              {cols.map((k) => (
                <th key={k} className="num">
                  {head(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {O.byAgent.length ? (
              O.byAgent.map((a) => (
                <tr key={a.agentId ?? 0}>
                  <td data-l={t('confirmation.col.agent')}>
                    <b>{a.name ?? t('confirmation.noAgent')}</b>
                  </td>
                  <td className="num ltr" data-l={head('cTreated')}>{n(a.treated)}</td>
                  <td className="num ltr" data-l={head('confirmed')}>{n(a.confirmed)}</td>
                  <td className="num ltr" data-l={head('cRefused')}>{n(a.refused)}</td>
                  <td className="num" data-l={head('cAttacks')}>
                    <span className="ltr">{n(a.attacks)}</span>
                    {parts(a) && <small className="px-ov-sub">{parts(a)}</small>}
                  </td>
                  <td className="num" data-l={head('cToCall')}>
                    <span className="ltr">{n(a.toCall)}</span>
                    {a.toCallNight > 0 && <small className="px-ov-sub">{t('confirmation.ov.nightOf', { n: a.toCallNight })}</small>}
                  </td>
                  <td className="num" data-l={head('lq')}>{lqCell(a.leadsQuality)}</td>
                  <td className="num ltr muted" data-l={head('cOld')}>{pp(a.oldRate)}</td>
                  <td className="num ltr" data-l={head('cUp')}>{n(a.upsell)}</td>
                  <td className="num ltr" data-l={head('upRate')}>{pp(a.upsellRate)}</td>
                  <td className="num ltr" data-l={head('cDelivered')}>{a.delivered + a.returned ? `${n(a.delivered)} · ${pp(a.deliveryRate)}` : '—'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="empty">
                  {t('confirmation.ov.findEmpty')}
                </td>
              </tr>
            )}
          </tbody>
          {O.byAgent.length > 1 && (
            <tfoot>
              <tr>
                <td data-l={t('confirmation.col.agent')}>
                  <b>{t('confirmation.ov.team')}</b>
                </td>
                <td className="num ltr" data-l={head('cTreated')}>{n(O.byAgent.reduce((s, a) => s + a.treated, 0))}</td>
                <td className="num ltr" data-l={head('confirmed')}>{n(O.confirmed.n)}</td>
                <td className="num ltr" data-l={head('cRefused')}>{n(O.refused.n)}</td>
                <td className="num ltr" data-l={head('cAttacks')}>{n(O.attacks.n)}</td>
                <td className="num ltr" data-l={head('cToCall')}>{n(O.night.noAnswerAll)}</td>
                <td className="num" data-l={head('lq')}>{lqCell(O.leadsQuality)}</td>
                <td className="num ltr muted" data-l={head('cOld')}>{pp(O.oldRate)}</td>
                <td className="num ltr" data-l={head('cUp')}>{n(O.upsell.orders)}</td>
                <td className="num ltr" data-l={head('upRate')}>{pp(O.upsell.rate)}</td>
                <td className="num ltr" data-l={head('cDelivered')}>—</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {hurt && (
        <p className="px-ov-note">
          <Icon name="flag" /> {t('confirmation.ov.agentNote', { count: hurt.attacks, name: hurt.name ?? t('confirmation.noAgent'), a: n(hurt.attacks), old: pp(hurt.oldRate), lq: pp(hurt.leadsQuality) })}
        </p>
      )}
    </div>
  );
}

function OvProducts({ O }: { O: Ov }) {
  const { t } = useTranslation();
  const L = O.limits;
  const top = O.byProduct.slice(0, 10);
  const cols = ['cLeads', 'confirmed', 'cRefused', 'cAttacks', 'cPending', 'lq'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.ov.${k}`);
  return (
    <div className="card px-ov-card">
      <div className="card-head">
        <h2>{t('confirmation.ov.byProduct')}</h2>
      </div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.ov.cProduct')}</th>
              {cols.map((k) => (
                <th key={k} className="num">
                  {head(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.length ? (
              top.map((p) => {
                const v = verdictOf(p.leadsQuality, L);
                return (
                  <tr key={p.productId}>
                    <td data-l={t('confirmation.ov.cProduct')}>
                      <b>{p.name}</b>
                    </td>
                    <td className="num ltr" data-l={head('cLeads')}>{n(p.n)}</td>
                    <td className="num ltr" data-l={head('confirmed')}>{n(p.confirmed)}</td>
                    <td className="num ltr" data-l={head('cRefused')}>{n(p.refused)}</td>
                    <td className="num" data-l={head('cAttacks')}>
                      <span className="ltr">{n(p.attacks)}</span>
                      {p.attacks > 0 && <small className="px-ov-sub ltr">{da(p.attackValue)}</small>}
                    </td>
                    <td className="num" data-l={head('cPending')}>
                      <span className="ltr">{n(p.pending)}</span>
                      {p.duplicates > 0 && <small className="px-ov-sub">{t('confirmation.ov.pDup', { n: p.duplicates })}</small>}
                    </td>
                    <td className="num" data-l={head('lq')}>
                      <span className="px-ov-lq">
                        <b className="ltr">{pp(p.leadsQuality)}</b> <VerdictPill v={v} />
                      </span>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="empty">
                  {t('confirmation.ov.findEmpty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {O.byProduct.length > top.length && <p className="px-ov-note">{t('confirmation.ov.more', { n: O.byProduct.length - top.length })}</p>}
    </div>
  );
}

function OvWords() {
  const { t } = useTranslation();
  const W: [string, string][] = [
    ['wReal', 'wRealD'],
    ['wAttack', 'wAttackD'],
    ['lq', 'wLqD'],
    ['wUp', 'wUpD'],
    ['wWait', 'wWaitD'],
  ];
  return (
    <div className="card px-ov-card">
      <div className="card-head">
        <h2>{t('confirmation.ov.words')}</h2>
      </div>
      <dl className="px-ov-words">
        {W.map(([w, d]) => (
          <div key={w}>
            <dt>{t(`confirmation.ov.${w}`)}</dt>
            <dd>{t(`confirmation.ov.${d}`)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Confirmation › Statistiques (managers): the page the « Statistiques » switch of Confirmées opens. */
export function ConfirmedStatsPage() {
  const { t } = useTranslation();
  const [kf0, setKfState] = useState<Kf>(loadKf);
  const kf: Kf = { ...kf0, view: 'conf' };
  const setKf = (k: Kf) => {
    setKfState(k);
    saveKf(k);
  };
  const q = useOverview(kf);
  const O = q.data;
  // the same numbers as « Après la confirmation » (Livrées sur confirmées), asked once for both
  const dq = useRpc('confirmation.delivery', { ...kfInput(kf), on: 'confirmed' }, { refetchInterval: 60_000 });
  const D = dq.data;
  const lqV = O ? verdictOf(O.leadsQuality, O.limits) : 'none';
  return (
    <div className="px-cs px-ov">
      <div className="card bjkfc px-cs-top">
        <Head title={t('confirmation.ov.title')} help={t('confirmation.ov.help')}>
          <KfBar kf={kf} setKf={setKf} noView />
          {O && O.pending.n > 0 && (
            <a className="btn primary px-ov-call" href={callHref(O)}>
              <Icon name="phone" /> {t('confirmation.ov.call', { count: O.pending.n })}
            </a>
          )}
        </Head>
        {q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !O ? (
          <Loading />
        ) : (
          <>
            <p className="px-ov-find">
              {O.received === 0
                ? t('confirmation.ov.findEmpty')
                : O.leadsQuality === null
                  ? t('confirmation.ov.findNoReal')
                  : t('confirmation.ov.findLq', { p: pp(O.leadsQuality) })}{' '}
              {O.attacks.n > 0 && t('confirmation.ov.findAttacks', { a: n(O.attacks.n), f: n(O.finished - O.duplicates.n) })}
            </p>
            <div className="kpis px-ov-kpis">
              <Kpi label={t('confirmation.ov.received')} value={n(O.received)} sub={t('confirmation.ov.receivedSub', { f: n(O.finished), p: n(O.pending.n) })} />
              <Kpi label={t('confirmation.ov.confirmed')} value={n(O.confirmed.n)} sub={t('confirmation.ov.confirmedSub', { v: da(O.confirmed.value), b: da(O.confirmed.basket) })} />
              <Kpi label={t('confirmation.ov.confRate')} help={t('confirmation.ov.confRateHelp')} value={pp(O.oldRate)} sub={t('confirmation.ov.confRateSub', { c: n(O.confirmed.n), f: n(O.finished) })} />
              <Kpi
                tone={V_TONE[lqV]}
                label={t('confirmation.ov.lq')}
                help={t('confirmation.ov.lqHelp')}
                value={pp(O.leadsQuality)}
                trend={<VerdictPill v={lqV} />}
                sub={t('confirmation.ov.lqSub', { c: n(O.confirmed.n), r: n(O.real) })}
              />
              <Kpi
                label={t('confirmation.ov.finalRate')}
                help={t('confirmation.ov.finalRateHelp')}
                value={D ? pctTxt(D.overall) : '…'}
                sub={D ? t('confirmation.ov.finalRateSub', { d: n(D.delivered), c: n(D.confirmed) }) : ' '}
              />
              <Kpi label={t('confirmation.ov.upRate')} help={t('confirmation.ov.upHelp')} value={pp(O.upsell.rate)} sub={t('confirmation.ov.upRateSub')} />
              <Kpi label={t('confirmation.ov.upOrders')} value={n(O.upsell.orders)} sub={t('confirmation.ov.upOrdersSub', { c: n(O.confirmed.n), v: da(O.upsell.value) })} />
              <Kpi
                label={t('confirmation.ov.first')}
                value={<Dur m={O.speed.dayMedianMin} />}
                sub={O.speed.nightMedianMin === null ? t('confirmation.ov.firstSubDay') : t('confirmation.ov.firstSub', { n: mn(O.speed.nightMedianMin) })}
              />
            </div>
          </>
        )}
      </div>
      {O && (
        <>
          <div className="px-ov-row">
            <OvFunnel O={O} kf={kf} />
            <OvLosses O={O} />
          </div>
          <div className="px-ov-row">
            <OvHours O={O} />
            <OvSpeed O={O} />
          </div>
          <OvAgents O={O} />
          <OvProducts O={O} />
          <div className="card bjkfc">
            <Head title={t('confirmation.cs.after')} help={t('confirmation.cs.afterHelp')} />
            <DelivBody kf={kf} on="confirmed" bare />
          </div>
          <OvWords />
        </>
      )}
    </div>
  );
}
