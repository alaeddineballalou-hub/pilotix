// "Statistiques" (foldable) — the KPI blocks of Nouvelles and En cours (managers). « Confirmées » is a page of statistics
// only (ConfirmedStatsPage): the key numbers, confirmation by agent, and what became of the confirmed orders.
import { Tone } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { da, dec1, dur, n } from '../../lib/format';
import { ErrorBox, Help, Icon, Kpi, Loading } from '../../ui/kit';
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
  if (sub === 'attente') return <EnCoursStats open={open} setOpen={fold} />;
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
 * Nouvelles › Statistiques, drawn as the owner's sketches (27 Nov 2026, « Agent manager view » and « Teams director
 * view » PDFs): today only, live, no filters. White tiles — the main number in navy — each with its change since
 * yesterday at the same hour, what waits right now, then one line per agent; the store's owner and administrators get one
 * line per team instead (an agency is one line: its agents stay private), and a team opens its manager view.
 */
const useNv = (open: boolean, team: string | null) => useRpc('confirmation.nouvelles', team ? { team } : {}, { refetchInterval: 30_000, enabled: open });
type Nv = NonNullable<ReturnType<typeof useNv>['data']>;
type NvRow = Omit<Nv['today'], 'received'> & { late: number };
const pOf = (a: number, b: number) => (b > 0 ? Math.round((a * 100) / b) : null);
const dOf = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const minTxt = (m: number | null) => (m === null ? '—' : dur(m * 60_000));

/** The line under a tile's number: its change since yesterday at the same hour — a count (gray), points or minutes
 *  (green: better, red: worse). */
function Arrow({ v, unit, goodDown }: { v: number | null; unit: 'n' | 'pts' | 'min' | 'dec'; goodDown?: boolean }) {
  const { t } = useTranslation();
  if (v === null || !isFinite(v)) return null;
  const r = unit === 'dec' ? Math.round(v * 10) / 10 : Math.round(v);
  if (r === 0) return <div className="d eq">= {t('confirmation.nv.same')}</div>;
  const better = unit === 'n' ? null : goodDown ? r < 0 : r > 0;
  const size = unit === 'pts' ? t('confirmation.nv.pts', { count: Math.abs(r) }) : unit === 'min' ? `${Math.abs(r)} min` : unit === 'dec' ? dec1(Math.abs(r)) : n(Math.abs(r));
  return (
    <div className={`d ${better === null ? 'eq' : better ? 'up' : 'dn'}`}>
      {r > 0 ? '↑' : '↓'} <span className="ltr">{size}</span>
    </div>
  );
}

function Tile({ label, help, value, gl, d, main, warn }: { label: string; help?: string; value: string; gl?: string; d?: ReactNode; main?: boolean; warn?: boolean }) {
  return (
    <div className={`px-sx-tile${main ? ' main' : ''}${warn ? ' warn' : ''}`}>
      <div className="lb">
        {label}
        {help && <Help text={help} label={label} />}
      </div>
      <div className="v ltr">{value}</div>
      {gl && <div className="gl">{gl}</div>}
      {d}
    </div>
  );
}

/** A group of tiles (Volume, Vitesse, Résultat): as wide as its tiles (`min` px at least each: else the next group goes
 *  under, so a label and its « ? » never break). */
function Group({ title, size, min = 140, children }: { title: string; size: number; min?: number; children: ReactNode }) {
  return (
    <div style={{ flex: `${size} 1 ${size * min + (size - 1) * 8}px` }}>
      <div className="px-sx-gh">{title}</div>
      <div className="px-sx-gt">{children}</div>
    </div>
  );
}

function NouvellesStats({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const { t } = useTranslation();
  const [team, setTeam] = useState<string | null>(null);
  const q = useNv(open, team);
  const D = q.data;
  return (
    <section className={`card px-st px-nv ${open ? '' : 'folded'}`}>
      <button type="button" className="px-st-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="px-st-t">{t('confirmation.stats.title')}</span>
        <svg className="px-st-ch" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
        </svg>
      </button>
      {open && (q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !D ? <Loading /> : <NvBody D={D} onTeam={setTeam} />)}
    </section>
  );
}

function NvBody({ D, onTeam }: { D: Nv; onTeam: (k: string | null) => void }) {
  const { t } = useTranslation();
  const T = D.today;
  const P = D.prev;
  const dir = D.director;
  const u5 = pOf(T.under5, T.called);
  const ot = pOf(T.onTime, T.called);
  const re = pOf(T.reached, T.called);
  const cv = pOf(T.converted, T.called);
  const load = (x: { orders: number; agents: number } | null) => (x && x.agents > 0 ? Math.round(x.orders / x.agents) : null);
  const per = load(D.perAgent);
  return (
    <div className="px-sx">
      <div className="px-sx-sec first">
        {D.team && (
          <button type="button" className="px-sx-back" onClick={() => onTeam(null)}>
            ‹ {t('confirmation.nv.allTeams')}
          </button>
        )}
        <span>{D.team ? t('confirmation.nv.secOne', { team: D.team.name }) : t(dir ? 'confirmation.nv.secAll' : 'confirmation.nv.secTeam')}</span>
      </div>
      <div className="px-sx-grp">
        <Group title={t('confirmation.nv.gVolume')} size={dir ? 2 : 1} min={168}>
          <Tile label={t('confirmation.nv.received')} help={t('confirmation.nv.hReceived')} value={n(T.received)} gl={t(dir ? 'confirmation.nv.today' : 'confirmation.nv.cameIn')} d={<Arrow v={T.received - P.received} unit="n" />} />
          {dir && <Tile label={t('confirmation.nv.perAgent')} help={t('confirmation.nv.hPerAgent')} value={per === null ? '—' : n(per)} gl={t('confirmation.nv.agents', { count: D.perAgent?.agents ?? 0 })} d={<Arrow v={dOf(per, load(D.perAgentPrev))} unit="n" />} />}
        </Group>
        <Group title={t('confirmation.nv.gSpeed')} size={3}>
          <Tile main label={t('confirmation.nv.under5')} help={t('confirmation.nv.hUnder5')} value={pctTxt(u5)} gl={t('confirmation.nv.goal', { v: 80 })} d={<Arrow v={dOf(u5, pOf(P.under5, P.called))} unit="pts" />} />
          <Tile label={t(dir ? 'confirmation.nv.medianShort' : 'confirmation.nv.median')} help={t('confirmation.nv.hMedian')} value={minTxt(T.median)} gl={t('confirmation.nv.halfFaster')} d={<Arrow v={dOf(T.median, P.median)} unit="min" goodDown />} />
          <Tile label={t('confirmation.nv.onTime')} help={t('confirmation.nv.hOnTime')} value={pctTxt(ot)} gl={t('confirmation.nv.goal', { v: 95 })} d={<Arrow v={dOf(ot, pOf(P.onTime, P.called))} unit="pts" />} />
        </Group>
        <Group title={t('confirmation.nv.gResult')} size={2}>
          <Tile label={t('confirmation.nv.reached')} help={t('confirmation.nv.hReached')} value={pctTxt(re)} gl={t('confirmation.nv.at1st')} d={<Arrow v={dOf(re, pOf(P.reached, P.called))} unit="pts" />} />
          <Tile label={t('confirmation.nv.converted')} help={t('confirmation.nv.hConverted')} value={pctTxt(cv)} gl={t('confirmation.nv.at1st')} d={<Arrow v={dOf(cv, pOf(P.converted, P.called))} unit="pts" />} />
        </Group>
      </div>
      <div className="px-sx-sec">{t(dir ? 'confirmation.nv.nowAll' : 'confirmation.nv.now')}</div>
      <div className="px-sx-t3">
        <Tile label={t('confirmation.nv.waiting')} help={t('confirmation.nv.hWaiting')} value={n(D.live.waiting)} />
        <Tile warn={D.live.late > 0} label={t('confirmation.nv.late')} help={t('confirmation.nv.hLate')} value={n(D.live.late)} />
        <Tile warn={D.live.noAgent > 0} label={t('confirmation.nv.noAgent')} help={t('confirmation.nv.hNoAgent')} value={n(D.live.noAgent)} />
      </div>
      {dir ? <NvTeams D={D} onTeam={onTeam} /> : <NvAgents D={D} />}
    </div>
  );
}

/** Each agent today: the team's numbers for each one; « Équipe » adds up every call (never an average of agents). */
function NvAgents({ D }: { D: Nv }) {
  const { t } = useTranslation();
  const A = D.agentsTotal;
  const teamRe = pOf(A.reached, A.called);
  const teamCv = pOf(A.converted, A.called);
  const cols = ['cCalled', 'cUnder5', 'cMedian', 'cOnTime', 'cReached', 'cConverted', 'cLate'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.nv.${k}`);
  // red: under the red line (a line with few calls is not judged; the total line never)
  const cells = (a: NvRow, judge: boolean, lateRed: boolean) => {
    const u5 = pOf(a.under5, a.called);
    const re = pOf(a.reached, a.called);
    const cv = pOf(a.converted, a.called);
    const half = (p: number | null, team: number | null) => judge && p !== null && team !== null && team > 0 && p < team / 2;
    const bad = (b: boolean) => (b ? ' bad' : '');
    return [
      <td key="c" className="num ltr" data-l={head('cCalled')}>{n(a.called)}</td>,
      <td key="u" className={`num ltr${bad(judge && u5 !== null && u5 < 60)}`} data-l={head('cUnder5')}>{pctTxt(u5)}</td>,
      <td key="m" className={`num ltr${bad(judge && a.median !== null && a.median > 5)}`} data-l={head('cMedian')}>{minTxt(a.median)}</td>,
      <td key="o" className="num ltr" data-l={head('cOnTime')}>{pctTxt(pOf(a.onTime, a.called))}</td>,
      <td key="r" className={`num ltr${bad(half(re, teamRe))}`} data-l={head('cReached')} title={half(re, teamRe) ? t('confirmation.nv.flag') : undefined}>
        {half(re, teamRe) ? '⚑ ' : ''}
        {pctTxt(re)}
      </td>,
      <td key="v" className={`num ltr${bad(half(cv, teamCv))}`} data-l={head('cConverted')}>{pctTxt(cv)}</td>,
      <td key="l" className={`num ltr${bad(lateRed && a.late > 0)}`} data-l={head('cLate')}>{n(a.late)}</td>,
    ];
  };
  return (
    <>
      <div className="px-sx-sec">{t('confirmation.nv.byAgent')}</div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-sx-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.nv.cAgent')}</th>
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
                  <tr key={a.id} className={few ? 'few' : undefined} title={few ? t('confirmation.nv.few') : undefined}>
                    <td data-l={t('confirmation.nv.cAgent')}>{a.name}</td>
                    {cells(a, !few, true)}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="empty">{t('confirmation.nv.empty')}</td>
              </tr>
            )}
            {D.agents.length > 1 && (
              <tr className="tot">
                <td data-l={t('confirmation.nv.cAgent')}>{t('confirmation.nv.teamRow')}</td>
                {cells({ ...A, late: D.agents.reduce((s, a) => s + a.late, 0) }, false, false)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The store's owner: each team side by side (an agency is one line, its agents stay private); a team opens its manager
 *  view; « Toutes les équipes » adds the lines up. */
function NvTeams({ D, onTeam }: { D: Nv; onTeam: (k: string | null) => void }) {
  const { t } = useTranslation();
  const rows = D.teams ?? [];
  const avg = D.perAgent && D.perAgent.agents > 0 ? D.perAgent.orders / D.perAgent.agents : null;
  const cols = ['cAgents', 'cNew', 'cPerAgent', 'cUnder5', 'cMedian', 'cConverted', 'cLate', 'cUnassigned'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.nv.${k}`);
  type Row = NonNullable<Nv['allTeams']>;
  const cells = (r: Row, judge: boolean, per: number | null) => {
    const u5 = pOf(r.under5, r.called);
    const bad = (b: boolean) => (judge && b ? ' bad' : '');
    const lo = judge && per !== null && avg !== null ? (per > avg * 1.3 ? ' bad' : per < avg * 0.7 ? ' lt' : '') : '';
    return [
      <td key="a" className="num" data-l={head('cAgents')}>
        {r.agents === null ? <span className="muted">{t('confirmation.nv.private')}</span> : <span className="ltr">{n(r.agents)}</span>}
      </td>,
      <td key="n" className="num ltr" data-l={head('cNew')}>{n(r.received)}</td>,
      <td key="p" className={`num ltr${lo}`} data-l={head('cPerAgent')}>{per === null ? '—' : n(per)}</td>,
      <td key="u" className={`num ltr${bad(u5 !== null && u5 < 60)}`} data-l={head('cUnder5')}>{pctTxt(u5)}</td>,
      <td key="m" className={`num ltr${bad(r.median !== null && r.median > 5)}`} data-l={head('cMedian')}>{minTxt(r.median)}</td>,
      <td key="c" className="num ltr" data-l={head('cConverted')}>{pctTxt(pOf(r.converted, r.called))}</td>,
      <td key="l" className={`num ltr${bad(r.late > 0)}`} data-l={head('cLate')}>{n(r.late)}</td>,
      <td key="x" className={`num ltr${bad((r.unassigned ?? 0) > 0)}`} data-l={head('cUnassigned')}>{r.unassigned === null ? '—' : n(r.unassigned)}</td>,
    ];
  };
  return (
    <>
      <div className="px-sx-sec">{t('confirmation.nv.byTeam')}</div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-sx-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.nv.cTeam')}</th>
              {cols.map((k) => (
                <th key={k} className="num">{head(k)}</th>
              ))}
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = r.kind === 'team';
              return (
                <tr key={r.key} className={open ? 'go' : undefined} onClick={open ? () => onTeam(r.key) : undefined}>
                  <td data-l={t('confirmation.nv.cTeam')}>
                    {r.kind === 'none' ? t('confirmation.cfs.noTeam') : r.name} {r.kind === 'agency' && <span className="badge t-warn">{t('confirmation.nv.agency')}</span>}
                  </td>
                  {cells(r, r.kind !== 'none', r.agents ? Math.round(r.received / r.agents) : null)}
                  <td className="go" aria-hidden="true">{open ? '›' : ''}</td>
                </tr>
              );
            })}
            {D.allTeams && (
              <tr className="tot">
                <td data-l={t('confirmation.nv.cTeam')}>{t('confirmation.nv.allTeams')}</td>
                {cells(D.allTeams, false, avg === null ? null : Math.round(avg))}
                <td aria-hidden="true" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- En cours: today only, live, no filters
/**
 * En cours › Statistiques, drawn as the owner's sketches (27 Nov 2026, « Agent manager view — En cours » and « Teams
 * director view — En cours » PDFs): today only, live, no filters. The job of En cours is to reach the client, not to
 * convince him: the call backs made today and how many on time, the share of today's closed orders where the client was
 * reached (the main number) and the calls it took, how those orders ended, what is in progress right now, then one line
 * per agent — or, for the store's owner and administrators, one line per team (a team opens its manager view).
 */
const useEc = (open: boolean, team: string | null) => useRpc('confirmation.enCours', team ? { team } : {}, { refetchInterval: 30_000, enabled: open });
type Ec = NonNullable<ReturnType<typeof useEc>['data']>;
type EcS = Ec['today'];
const ecReached = (s: EcS) => s.confirmed + s.saidNo;
const ecTries = (s: EcS) => (ecReached(s) > 0 ? s.tries / ecReached(s) : null);

function EnCoursStats({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const { t } = useTranslation();
  const [team, setTeam] = useState<string | null>(null);
  const q = useEc(open, team);
  const D = q.data;
  return (
    <section className={`card px-st px-nv ${open ? '' : 'folded'}`}>
      <button type="button" className="px-st-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="px-st-t">{t('confirmation.stats.title')}</span>
        <svg className="px-st-ch" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
        </svg>
      </button>
      {open && (q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !D ? <Loading /> : <EcBody D={D} onTeam={setTeam} />)}
    </section>
  );
}

function EcBody({ D, onTeam }: { D: Ec; onTeam: (k: string | null) => void }) {
  const { t } = useTranslation();
  const T = D.today;
  const P = D.prev;
  const dir = D.director;
  const ot = pOf(T.onTime, T.calls);
  const re = pOf(ecReached(T), ecReached(T) + T.never);
  const tr = ecTries(T);
  const trP = ecTries(P);
  const closed = ecReached(T) + T.never;
  const per = D.perAgent && D.perAgent.agents > 0 ? Math.round(D.perAgent.orders / D.perAgent.agents) : null;
  return (
    <div className="px-sx">
      <div className="px-sx-sec first">
        {D.team && (
          <button type="button" className="px-sx-back" onClick={() => onTeam(null)}>
            ‹ {t('confirmation.nv.allTeams')}
          </button>
        )}
        <span>{D.team ? t('confirmation.nv.secOne', { team: D.team.name }) : t(dir ? 'confirmation.nv.secAll' : 'confirmation.nv.secTeam')}</span>
      </div>
      <div className="px-sx-grp">
        <Group title={t('confirmation.nv.gVolume')} size={1}>
          <Tile label={t('confirmation.ecs.calls')} help={t('confirmation.ecs.hCalls')} value={n(T.calls)} gl={t('confirmation.ecs.callsSub')} d={<Arrow v={T.calls - P.calls} unit="n" />} />
        </Group>
        <Group title={t('confirmation.nv.gSpeed')} size={1}>
          <Tile label={t('confirmation.ecs.onTime')} help={t('confirmation.ecs.hOnTime')} value={pctTxt(ot)} gl={t('confirmation.nv.goal', { v: 90 })} d={<Arrow v={dOf(ot, pOf(P.onTime, P.calls))} unit="pts" />} />
        </Group>
        <Group title={t('confirmation.nv.gResult')} size={2}>
          <Tile main label={t('confirmation.ecs.reached')} help={t('confirmation.ecs.hReached')} value={pctTxt(re)} gl={t('confirmation.ecs.reachedSub')} d={<Arrow v={dOf(re, pOf(ecReached(P), ecReached(P) + P.never))} unit="pts" />} />
          <Tile label={t('confirmation.ecs.tries')} help={t('confirmation.ecs.hTries')} value={tr === null ? '—' : dec1(tr)} gl={t('confirmation.ecs.triesSub')} d={<Arrow v={tr === null || trP === null ? null : tr - trP} unit="dec" goodDown />} />
        </Group>
      </div>
      <div className="px-sx-sec">{t(dir ? 'confirmation.ecs.endedAll' : 'confirmation.ecs.ended', { count: closed })}</div>
      <EcBar s={T} />
      <div className="px-sx-sec">{t(dir ? 'confirmation.nv.nowAll' : 'confirmation.nv.now')}</div>
      <div className={dir ? 'px-sx-t4' : 'px-sx-t3'}>
        <Tile label={t('confirmation.ecs.inProgress')} help={t('confirmation.ecs.hInProgress')} value={n(D.live.inProgress)} gl={t('confirmation.ecs.worth', { v: da(D.live.value) })} />
        {dir && <Tile label={t('confirmation.nv.perAgent')} help={t('confirmation.ecs.hPerAgent')} value={per === null ? '—' : n(per)} gl={t('confirmation.nv.agents', { count: D.perAgent?.agents ?? 0 })} />}
        <Tile warn={D.live.late > 0} label={t('confirmation.ecs.late')} help={t('confirmation.ecs.hLate')} value={n(D.live.late)} />
        <Tile label={t('confirmation.ecs.dueHour')} help={t('confirmation.ecs.hDueHour')} value={n(D.live.dueHour)} />
      </div>
      {dir ? <EcTeams D={D} onTeam={onTeam} /> : <EcAgents D={D} />}
    </div>
  );
}

/** How today's closed orders ended: confirmed and « the client said no » (both reached), never reached. */
function EcBar({ s }: { s: EcS }) {
  const { t } = useTranslation();
  const all = ecReached(s) + s.never;
  if (!all) return <p className="px-sx-empty">{t('confirmation.ecs.noClosed')}</p>;
  const w = (x: number) => `${(x * 100) / all}%`;
  const parts = [
    ['confirmed', s.confirmed, 'c'],
    ['saidNo', s.saidNo, 'x'],
    ['never', s.never, 'n'],
  ] as const;
  return (
    <div className="px-sx-bar">
      <div className="px-sx-brk">
        <div style={{ width: w(ecReached(s)) }}>{t('confirmation.ecs.barReached', { p: pctTxt(pOf(ecReached(s), all)) })}</div>
        {s.never > 0 && <div style={{ width: w(s.never) }}>{t('confirmation.ecs.barNot', { p: pctTxt(pOf(s.never, all)) })}</div>}
      </div>
      <div className="px-sx-track">
        {parts.map(([k, v, c]) => (v > 0 ? <div key={k} className={c} style={{ width: w(v) }} /> : null))}
      </div>
      <div className="px-sx-lgd">
        {parts.map(([k, v, c]) => (
          <span key={k}>
            <i className={c} />
            {t(`confirmation.ecs.${k}`)} <span className="ltr">{pctTxt(pOf(v, all))}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Each agent today; « Équipe » adds up the lines (never an average of agents). */
function EcAgents({ D }: { D: Ec }) {
  const { t } = useTranslation();
  const cols = ['cCalls', 'cOnTime', 'cLate', 'cReached', 'cTries'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.ecs.${k}`);
  const cells = (a: EcS & { late: number }, judge: boolean, lateRed: boolean) => {
    const ot = pOf(a.onTime, a.calls);
    const re = pOf(ecReached(a), ecReached(a) + a.never);
    const tr = ecTries(a);
    const bad = (b: boolean) => (b ? ' bad' : '');
    return [
      <td key="c" className="num ltr" data-l={head('cCalls')}>{n(a.calls)}</td>,
      <td key="o" className={`num ltr${bad(judge && ot !== null && ot < 75)}`} data-l={head('cOnTime')}>{pctTxt(ot)}</td>,
      <td key="l" className={`num ltr${bad(lateRed && a.late > 0)}`} data-l={head('cLate')}>{n(a.late)}</td>,
      <td key="r" className={`num ltr${bad(judge && re !== null && re < 65)}`} data-l={head('cReached')}>{pctTxt(re)}</td>,
      <td key="t" className="num ltr" data-l={head('cTries')}>{tr === null ? '—' : dec1(tr)}</td>,
    ];
  };
  return (
    <>
      <div className="px-sx-sec">{t('confirmation.nv.byAgent')}</div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-sx-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.nv.cAgent')}</th>
              {cols.map((k) => (
                <th key={k} className="num">{head(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {D.agents.length ? (
              D.agents.map((a) => {
                const few = a.calls < 20;
                return (
                  <tr key={a.id} className={few ? 'few' : undefined} title={few ? t('confirmation.nv.few') : undefined}>
                    <td data-l={t('confirmation.nv.cAgent')}>{a.name}</td>
                    {cells(a, !few, true)}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="empty">{t('confirmation.ecs.empty')}</td>
              </tr>
            )}
            {D.agents.length > 1 && (
              <tr className="tot">
                <td data-l={t('confirmation.nv.cAgent')}>{t('confirmation.nv.teamRow')}</td>
                {cells({ ...D.agentsTotal, late: D.agents.reduce((s, a) => s + a.late, 0) }, false, false)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The store's owner: each team side by side (an agency is one line, its agents private); a team opens its manager
 *  view; « Toutes les équipes » adds the lines up. */
function EcTeams({ D, onTeam }: { D: Ec; onTeam: (k: string | null) => void }) {
  const { t } = useTranslation();
  const rows = D.teams ?? [];
  const avg = D.perAgent && D.perAgent.agents > 0 ? D.perAgent.orders / D.perAgent.agents : null;
  const cols = ['cAgents', 'cInProgress', 'cPerAgent', 'cOnTime', 'cLate', 'cReached', 'cTriesShort'] as const;
  const head = (k: (typeof cols)[number]) => t(k === 'cAgents' || k === 'cPerAgent' ? `confirmation.nv.${k}` : `confirmation.ecs.${k}`);
  type Row = NonNullable<Ec['allTeams']>;
  const cells = (r: Row, judge: boolean, per: number | null) => {
    const ot = pOf(r.onTime, r.calls);
    const re = pOf(ecReached(r), ecReached(r) + r.never);
    const tr = ecTries(r);
    const bad = (b: boolean) => (judge && b ? ' bad' : '');
    const lo = judge && per !== null && avg !== null ? (per > avg * 1.3 ? ' bad' : per < avg * 0.7 ? ' lt' : '') : '';
    return [
      <td key="a" className="num" data-l={head('cAgents')}>
        {r.agents === null ? <span className="muted">{t('confirmation.nv.private')}</span> : <span className="ltr">{n(r.agents)}</span>}
      </td>,
      <td key="i" className="num ltr" data-l={head('cInProgress')}>{n(r.inProgress)}</td>,
      <td key="p" className={`num ltr${lo}`} data-l={head('cPerAgent')}>{per === null ? '—' : n(per)}</td>,
      <td key="o" className={`num ltr${bad(ot !== null && ot < 75)}`} data-l={head('cOnTime')}>{pctTxt(ot)}</td>,
      <td key="l" className={`num ltr${bad(r.late > 0)}`} data-l={head('cLate')}>{n(r.late)}</td>,
      <td key="r" className={`num ltr${bad(re !== null && re < 65)}`} data-l={head('cReached')}>{pctTxt(re)}</td>,
      <td key="t" className="num ltr" data-l={head('cTriesShort')}>{tr === null ? '—' : dec1(tr)}</td>,
    ];
  };
  return (
    <>
      <div className="px-sx-sec">{t('confirmation.nv.byTeam')}</div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-sx-tbl">
          <thead>
            <tr>
              <th>{t('confirmation.nv.cTeam')}</th>
              {cols.map((k) => (
                <th key={k} className="num">{head(k)}</th>
              ))}
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const go = r.kind === 'team';
              return (
                <tr key={r.key} className={go ? 'go' : undefined} onClick={go ? () => onTeam(r.key) : undefined}>
                  <td data-l={t('confirmation.nv.cTeam')}>
                    {r.kind === 'none' ? t('confirmation.cfs.noTeam') : r.name} {r.kind === 'agency' && <span className="badge t-warn">{t('confirmation.nv.agency')}</span>}
                  </td>
                  {cells(r, r.kind !== 'none', r.agents ? Math.round(r.inProgress / r.agents) : null)}
                  <td className="go" aria-hidden="true">{go ? '›' : ''}</td>
                </tr>
              );
            })}
            {D.allTeams && (
              <tr className="tot">
                <td data-l={t('confirmation.nv.cTeam')}>{t('confirmation.nv.allTeams')}</td>
                {cells(D.allTeams, false, avg === null ? null : Math.round(avg))}
                <td aria-hidden="true" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
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
// ---------------------------------------------------------------- Confirmées › Statistiques (the owner's sketch)
/**
 * Confirmées › Statistiques, as the owner's sketch (27 Nov 2026, « Agent manager view — Confirmées » PDF): are the leads
 * good, does the team confirm them, and do the confirmed orders end up delivered? The filters (the dates — by creation
 * or by the day the confirmation status changed —, an agent, a product; for the store's owner a team or an agency), six
 * cards (the main one in navy: taux conf.), why real clients said no, then one table with the same filters: per agent
 * (per team for the owner) or per product. Every number is a « taux »: pending orders counted.
 */
interface CfF {
  per: Kf['per'];
  basis: Kf['basis'];
  from: string;
  to: string;
  agent: number | null;
  product: number | null;
  team: string | null;
  by: 'people' | 'product';
}
// the dates, the date type and the table's choice are kept on this device; the agent, product and team filters are not
const loadCf = (): CfF => {
  const k = loadKf();
  const kept = store.json<Partial<CfF>>('conf-cf', {});
  return { per: kept.per ?? '30', basis: kept.basis ?? 'updated', from: kept.from ?? k.from, to: kept.to ?? k.to, by: kept.by ?? 'people', agent: null, product: null, team: null };
};
const saveCf = (f: CfF) => store.set('conf-cf', JSON.stringify({ per: f.per, basis: f.basis, from: f.from, to: f.to, by: f.by }));
const useCf = (f: CfF) =>
  useRpc(
    'confirmation.confirmees',
    { per: f.per, basis: f.basis, ...(f.per === 'custom' ? { from: f.from, to: f.to } : {}), ...(f.agent ? { agent: f.agent } : {}), ...(f.product ? { product: f.product } : {}), ...(f.team ? { team: f.team } : {}), by: f.by },
    { refetchInterval: 60_000 },
  );
type Cf = NonNullable<ReturnType<typeof useCf>['data']>;
type CfS = Cf['sum'];
const cfQual = (s: CfS) => pOf(s.qualified, s.leads);
const cfConf = (s: CfS) => pOf(s.confirmed, s.qualified);
const cfUp = (s: CfS) => pOf(s.upsell, s.confirmed);
const cfLivr = (s: CfS) => pOf(s.delivered, s.shipped);
const cfFinal = (s: CfS) => pOf(s.delivered, s.qualified);

export function ConfirmedStatsPage() {
  const { t } = useTranslation();
  const [f, setF0] = useState<CfF>(loadCf);
  const setF = (p: Partial<CfF>) =>
    setF0((x) => {
      const nx = { ...x, ...p };
      saveCf(nx);
      return nx;
    });
  const q = useCf(f);
  const D = q.data;
  return (
    <section className="card px-st px-cf">
      <div className="px-sx">
        <CfFilters f={f} setF={setF} D={D} />
        {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !D ? <Loading /> : <CfBody D={D} f={f} setF={setF} />}
      </div>
    </section>
  );
}

/** The filter pills: dates (a period or custom days), date de création / changement de statut, team, agent, product. */
function CfFilters({ f, setF, D }: { f: CfF; setF: (p: Partial<CfF>) => void; D: Cf | undefined }) {
  const { t } = useTranslation();
  const kf: Kf = { per: f.per, basis: f.basis, from: f.from, to: f.to, view: 'conf' };
  return (
    <div className="px-sx-fb">
      <DateRange custom kf={kf} onChange={(p) => setF({ per: p.per, from: p.from, to: p.to })} />
      <div className="px-sx-seg" role="radiogroup" aria-label={t('confirmation.stats.basis')}>
        {(['created', 'updated'] as const).map((b) => (
          <button key={b} type="button" role="radio" aria-checked={f.basis === b} className={f.basis === b ? 'on' : ''} onClick={() => setF({ basis: b })}>
            {t(b === 'created' ? 'confirmation.cfs.created' : 'confirmation.cfs.updated')}
          </button>
        ))}
      </div>
      {D?.teams && (
        <select aria-label={t('confirmation.cfs.team')} className="px-sx-pill" value={f.team ?? ''} onChange={(e) => setF({ team: e.target.value || null, agent: null })}>
          <option value="">{t('confirmation.cfs.teamAll')}</option>
          {D.teams.map((x) => (
            <option key={x.key} value={x.key}>
              {x.kind === 'agency' ? `${x.name} · ${t('confirmation.nv.agency')}` : x.name}
            </option>
          ))}
        </select>
      )}
      {D && (D.agents.length > 0 || f.agent) && (
        <select aria-label={t('confirmation.cfs.agent')} className="px-sx-pill ag" value={f.agent ?? ''} onChange={(e) => setF({ agent: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('confirmation.cfs.agentAll')}</option>
          {D.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      {D && (
        <select aria-label={t('confirmation.cfs.product')} className="px-sx-pill" value={f.product ?? ''} onChange={(e) => setF({ product: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('confirmation.cfs.productAll')}</option>
          {D.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function CfBody({ D, f, setF }: { D: Cf; f: CfF; setF: (p: Partial<CfF>) => void }) {
  const { t } = useTranslation();
  const S = D.sum;
  const per = D.perAgent && D.perAgent.agents > 0 ? Math.round(D.perAgent.leads / D.perAgent.agents) : null;
  return (
    <>
      <div className={`px-sx-t6${D.perAgent ? ' t7' : ''}`}>
        <Tile label={t('confirmation.cfs.leads')} help={t('confirmation.cfs.hLeads')} value={n(S.leads)} gl={t('confirmation.cfs.leadsSub')} />
        {D.perAgent && <Tile label={t('confirmation.cfs.perAgent')} help={t('confirmation.cfs.hPerAgent')} value={per === null ? '—' : n(per)} gl={t('confirmation.nv.agents', { count: D.perAgent.agents })} />}
        <Tile label={t('confirmation.cfs.qualified')} help={t('confirmation.cfs.hQualified')} value={n(S.qualified)} gl={t('confirmation.cfs.qualifiedSub')} />
        <Tile label={t('confirmation.cfs.confirmed')} help={t('confirmation.cfs.hConfirmed')} value={n(S.confirmed)} gl={t('confirmation.cfs.confirmedSub')} />
        <Tile label={t('confirmation.cfs.quality')} help={t('confirmation.cfs.hQuality')} value={pctTxt(cfQual(S))} gl={t('confirmation.cfs.qualitySub')} />
        <Tile main label={t('confirmation.cfs.taux')} help={t('confirmation.cfs.hTaux')} value={pctTxt(cfConf(S))} gl={t('confirmation.cfs.tauxSub')} />
        <Tile label={t('confirmation.cfs.upsell')} help={t('confirmation.cfs.hUpsell')} value={pctTxt(cfUp(S))} gl={t('confirmation.cfs.upsellSub')} />
      </div>
      <div className="px-sx-sec">
        {t('confirmation.cfs.why')}
        <Help text={t('confirmation.cfs.hWhy')} label={t('confirmation.cfs.why')} />
      </div>
      <CfReasons D={D} />
      <CfTable D={D} f={f} setF={setF} />
    </>
  );
}

/** Why real clients said no: the reasons the agents wrote (fakes, competitors, wrong numbers, no answers left out). */
function CfReasons({ D }: { D: Cf }) {
  const { t } = useTranslation();
  const all = D.reasons.reduce((s, r) => s + r.n, 0);
  if (!all) return <p className="px-sx-empty">{t('confirmation.cfs.noReason')}</p>;
  return (
    <div className="px-sx-rs">
      {D.reasons.map((r) => {
        const p = pOf(r.n, all) ?? 0;
        return (
          <div key={r.code} className="px-sx-rs-row">
            <span>{t(`confirmation.cfs.r.${r.code}`)}</span>
            <div className="bk">
              <div style={{ width: `${p}%` }} />
            </div>
            <span className="pc ltr">{p} %</span>
          </div>
        );
      })}
    </div>
  );
}

/** One table, the same filters: per agent (per team for the owner) or per product; delivery only here. */
function CfTable({ D, f, setF }: { D: Cf; f: CfF; setF: (p: Partial<CfF>) => void }) {
  const { t } = useTranslation();
  const S = D.sum;
  const prodOnly = !!f.agent || D.team?.key.startsWith('a');
  const people = D.by === 'people';
  const dir = D.director && people;
  const cols = [...(dir ? (['cAgents'] as const) : []), 'cLeads', ...(dir ? (['cPerAgent'] as const) : []), 'cQualified', 'cConfirmed', 'cQuality', 'cTaux', 'cUpsell', 'cLivr', 'cFinal'] as const;
  const head = (k: (typeof cols)[number]) => t(`confirmation.cfs.${k}`);
  const first = people ? t(D.director ? 'confirmation.nv.cTeam' : 'confirmation.nv.cAgent') : t('confirmation.cfs.cProduct');
  // red: under the team (the total line): lead quality 5 pts, upsell half, taux livr. 10 pts — a line with few leads is not judged
  const tq = cfQual(S);
  const tu = cfUp(S);
  const tl = cfLivr(S);
  const cells = (r: CfS & { agents?: number | null }, judge: boolean, per: number | null = r.agents ? Math.round(r.leads / r.agents) : null) => {
    const q = cfQual(r);
    const u = cfUp(r);
    const l = cfLivr(r);
    const bad = (b: boolean) => (judge && b ? ' bad' : '');
    return [
      ...(dir
        ? [
            <td key="a" className="num" data-l={head('cAgents')}>
              {r.agents === null || r.agents === undefined ? <span className="muted">{r.agents === null ? t('confirmation.nv.private') : '—'}</span> : <span className="ltr">{n(r.agents)}</span>}
            </td>,
          ]
        : []),
      <td key="n" className="num ltr" data-l={head('cLeads')}>{n(r.leads)}</td>,
      ...(dir ? [<td key="p" className="num ltr" data-l={head('cPerAgent')}>{per === null ? '—' : n(per)}</td>] : []),
      <td key="q" className="num ltr" data-l={head('cQualified')}>{n(r.qualified)}</td>,
      <td key="c" className="num ltr" data-l={head('cConfirmed')}>{n(r.confirmed)}</td>,
      <td key="lq" className={`num ltr${bad(q !== null && tq !== null && q <= tq - 5)}`} data-l={head('cQuality')}>{pctTxt(q)}</td>,
      <td key="t" className="num ltr" data-l={head('cTaux')}>{pctTxt(cfConf(r))}</td>,
      <td key="u" className={`num ltr${bad(u !== null && tu !== null && tu > 0 && u < tu / 2)}`} data-l={head('cUpsell')}>{pctTxt(u)}</td>,
      <td key="l" className={`num ltr${bad(l !== null && tl !== null && l <= tl - 10)}`} data-l={head('cLivr')}>{pctTxt(l)}</td>,
      <td key="f" className="num ltr" data-l={head('cFinal')}>{pctTxt(cfFinal(r))}</td>,
    ];
  };
  const name = (r: Cf['table'][number]) => (r.kind === 'none' ? t(D.director && people ? 'confirmation.cfs.noTeam' : 'confirmation.cfs.noAgent') : r.name);
  const total = D.team ? D.team.name : t(D.director ? 'confirmation.nv.allTeams' : 'confirmation.nv.teamRow');
  return (
    <>
      <div className="px-sx-sec row">
        <span>{t('confirmation.cfs.tableSec')}</span>
        {!prodOnly && (
          <span className="px-sx-seg" role="radiogroup" aria-label={t('confirmation.cfs.tableSec')}>
            {(['people', 'product'] as const).map((b) => (
              <button key={b} type="button" role="radio" aria-checked={D.by === b} className={D.by === b ? 'on' : ''} onClick={() => setF({ by: b })}>
                {t(b === 'product' ? 'confirmation.cfs.byProduct' : D.director ? 'confirmation.cfs.byTeam' : 'confirmation.cfs.byAgent')}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="tbl-wrap">
        <table className="tbl px-ov-tbl px-sx-tbl">
          <thead>
            <tr>
              <th>{first}</th>
              {cols.map((k) => (
                <th key={k} className="num">
                  {head(k)}
                  {(k === 'cLivr' || k === 'cFinal') && <Help text={t(k === 'cLivr' ? 'confirmation.cfs.hLivr' : 'confirmation.cfs.hFinal')} label={head(k)} />}
                </th>
              ))}
              {dir && <th aria-hidden="true" />}
            </tr>
          </thead>
          <tbody>
            {D.table.length ? (
              D.table.map((r) => {
                const few = r.leads < 20;
                const go = dir && r.kind === 'team';
                return (
                  <tr
                    key={r.key}
                    className={[few ? 'few' : '', go ? 'go' : ''].filter(Boolean).join(' ') || undefined}
                    title={few ? t('confirmation.cfs.few') : undefined}
                    onClick={go ? () => setF({ team: r.key, agent: null }) : undefined}
                  >
                    <td data-l={first}>
                      {name(r)} {r.kind === 'agency' && <span className="badge t-warn">{t('confirmation.nv.agency')}</span>}
                    </td>
                    {cells(r, !few && r.kind !== 'none')}
                    {dir && <td className="go" aria-hidden="true">{go ? '›' : ''}</td>}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={cols.length + 1} className="empty">{t('confirmation.cfs.empty')}</td>
              </tr>
            )}
            {D.table.length > 1 && (
              <tr className="tot">
                <td data-l={first}>{total}</td>
                {cells({ ...S, agents: D.perAgent?.agents }, false, D.perAgent && D.perAgent.agents > 0 ? Math.round(D.perAgent.leads / D.perAgent.agents) : null)}
                {dir && <td aria-hidden="true" />}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

