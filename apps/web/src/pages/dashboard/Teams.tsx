// Dashboard · Confirmation: teams view (filters, presence, comparison, team cards with chart and ranking, delays, team editor).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { dur, n, pct } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Kpis, Loading } from '../../ui/kit';
import { Presence } from './Presence';
import { AnyPeriod, Badge, confTone, delivTone, inputsOf, KpiBox, rangeLabel, rangeOf, timeTone, useStored } from './util';

type Data = Out<'stats.teams'>;
type Team = Data['teams'][number];
type Agent = Team['agents'][number];
type Meta = Out<'stats.dashMeta'>;

const PERIODS: AnyPeriod[] = ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth', 'custom'];
const SORTS = ['confRate', 'deliveryRate', 'finalRate', 'confirmed', 'orders', 'calls', 'firstRate', 'triesRate'] as const;
type Sort = (typeof SORTS)[number];

export function TeamsArea({ meta }: { meta: Meta }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useStored<AnyPeriod>('dash.teams.period', '7d');
  const [dateType, setDateType] = useStored<'created' | 'status'>('dash.teams.dtype', 'created');
  const [rateType, setRateType] = useStored<'taux' | 'perf'>('dash.teams.rate', 'taux');
  const [teamId, setTeamId] = useState('');
  const [agentId, setAgentId] = useState(0);
  const [custom, setCustom] = useState(() => inputsOf(rangeOf('7d')));
  const range = rangeOf(period, custom);
  const dates = period === 'custom' ? custom : inputsOf(range);
  const q = useRpc('stats.teams', { ...range, dateType, rateType, teamId: teamId || undefined, agentId: agentId || undefined });
  const d = q.data;
  const reset = () => {
    setPeriod('7d');
    setDateType('created');
    setRateType('taux');
    setTeamId('');
    setAgentId(0);
  };
  const setDate = (k: 'from' | 'to', v: string) => {
    if (!v) return;
    setCustom({ ...dates, [k]: v });
    setPeriod('custom');
  };
  const agentOpts = d ? (teamId ? d.agentOptions.filter((a) => d.teamOptions.find((x) => x.id === teamId)?.agentIds.includes(a.id)) : d.agentOptions) : [];
  const hourly = Date.parse(range.to) - Date.parse(range.from) <= 25 * 3_600_000;

  return (
    <div className="bjt">
      <section className="card">
        <div className="card-head">
          <h2>{meta.seesAll ? t('dashboard.teams.title') : t('dashboard.teams.mine')}</h2>
          <div className="row">
            <button type="button" className="btn small" onClick={reset}>
              {t('dashboard.teams.reset')}
            </button>
          </div>
        </div>
        <div className={`bjt-filters ${meta.seesAll ? 'adm' : ''}`}>
          <label className="field">
            <span className="lab">{t('dashboard.period')}</span>
            <select aria-label={t('dashboard.period')} value={period} onChange={(e) => setPeriod(e.target.value as AnyPeriod)}>
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`dashboard.periods.${p === 'custom' ? 'customDates' : p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('dashboard.teams.filterBy')}</span>
            <select aria-label={t('dashboard.teams.dateType')} value={dateType} onChange={(e) => setDateType(e.target.value as 'created' | 'status')}>
              <option value="created">{t('dashboard.teams.byCreated')}</option>
              <option value="status">{t('dashboard.teams.byStatus')}</option>
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('dashboard.teams.rate')}</span>
            <select aria-label={t('dashboard.teams.rateType')} value={rateType} onChange={(e) => setRateType(e.target.value as 'taux' | 'perf')}>
              <option value="taux">{t('dashboard.teams.rateBusiness')}</option>
              <option value="perf">{t('dashboard.teams.ratePerf')}</option>
            </select>
          </label>
          {meta.seesAll && (
            <label className="field">
              <span className="lab">{t('dashboard.teams.team')}</span>
              <select aria-label={t('dashboard.teams.team')} value={teamId} onChange={(e) => (setTeamId(e.target.value), setAgentId(0))}>
                <option value="">{t('dashboard.teams.allTeams')}</option>
                {d?.teamOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span className="lab">{t('dashboard.teams.agent')}</span>
            <select aria-label={t('dashboard.teams.agent')} value={agentId} onChange={(e) => setAgentId(Number(e.target.value))}>
              <option value={0}>{t('dashboard.teams.allAgents')}</option>
              {agentOpts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field bjt-d">
            <span className="lab">{t('dashboard.from')}</span>
            <input type="date" aria-label={t('dashboard.from')} value={dates.from} max={dates.to} onChange={(e) => setDate('from', e.target.value)} />
          </label>
          <label className="field bjt-d">
            <span className="lab">{t('dashboard.to')}</span>
            <input type="date" aria-label={t('dashboard.to')} value={dates.to} min={dates.from} onChange={(e) => setDate('to', e.target.value)} />
          </label>
        </div>
        <p className="muted small bjt-per">
          <Icon name="calendar" /> {rangeLabel(range)} · {hourly ? t('dashboard.teams.hourly') : t('dashboard.teams.daily')} · {dateType === 'created' ? t('dashboard.teams.perCreated') : t('dashboard.teams.perStatus')}
        </p>
        <details className="bjt-help">
          <summary>{t('dashboard.teams.howTitle')}</summary>
          <p className="muted small">{t('dashboard.teams.how')}</p>
        </details>
      </section>
      <div className="bjt-body">
        <Presence showTeam={meta.seesAll} />
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : (
          d && (
            <>
              {meta.seesAll && d.comparison.length > 1 && <Comparison d={d} />}
              {!d.teams.length && <p className="empty-box">{t('dashboard.teams.empty')}</p>}
              {d.teams.map((tm) => (
                <TeamCard key={tm.id} team={tm} hourly={d.hourly} rateType={rateType} />
              ))}
              <Delays d={d} />
              {meta.canEditTeams && <TeamEditor meta={meta} />}
            </>
          )
        )}
      </div>
    </div>
  );
}

function Comparison({ d }: { d: Data }) {
  const { t } = useTranslation();
  const best = Math.max(...d.comparison.filter((c) => c.id !== 'none').map((c) => c.rate ?? -1));
  const cols = ['team', 'agents', 'orders', 'confirmed', 'perf', 'rate', 'confirmationsInPeriod', 'calls', 'inProgress', 'lateCallbacks'] as const;
  return (
    <Card title={t('dashboard.cmp.title')} help={t('dashboard.cmp.help')}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={c} className={i ? 'num' : undefined}>
                  {t(`dashboard.cmp.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.comparison.map((c) => (
              <tr key={c.id}>
                <td className="wide px-cw" data-l={t('dashboard.cmp.team')}>
                  <div className="px-clamp">
                    <b>
                      {c.id !== 'none' && c.rate !== null && c.rate === best && <Icon name="trophy" className="bji-gold" />} {c.name}
                    </b>
                  </div>
                </td>
                <td className="num ltr" data-l={t('dashboard.cmp.agents')}>{n(c.agents)}</td>
                <td className="num ltr" data-l={t('dashboard.cmp.orders')}>{n(c.orders)}</td>
                <td className="num ltr" data-l={t('dashboard.cmp.confirmed')}>{n(c.confirmed)}</td>
                <td className="num" data-l={t('dashboard.cmp.perf')}>
                  <Badge tone={confTone(c.perf, true)}>{pct(c.perf)}</Badge>
                </td>
                <td className="num" data-l={t('dashboard.cmp.rate')}>
                  <Badge tone={confTone(c.rate, true)}>{pct(c.rate)}</Badge>
                </td>
                <td className="num ltr" data-l={t('dashboard.cmp.confirmationsInPeriod')}>{n(c.confirmationsInPeriod)}</td>
                <td className="num ltr" data-l={t('dashboard.cmp.calls')}>{n(c.calls)}</td>
                <td className="num ltr" data-l={t('dashboard.cmp.inProgress')}>{n(c.inProgress)}</td>
                <td className="num" data-l={t('dashboard.cmp.lateCallbacks')}>{c.lateCallbacks ? <Badge tone="bad">{c.lateCallbacks}</Badge> : <span className="ltr">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TeamCard({ team, hourly, rateType }: { team: Team; hourly: boolean; rateType: 'taux' | 'perf' }) {
  const { t } = useTranslation();
  const k = team.total;
  const [chart, setChart] = useState<'conf' | 'calls'>('conf');
  const [sort, setSort] = useState<Sort>('confRate');
  const perConf = k.confirmed ? (k.calls / k.confirmed).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—';
  const head =
    team.id === 'none'
      ? t('dashboard.team.agents', { count: team.agentCount })
      : team.id === 'me'
        ? ''
        : `${t('dashboard.team.agents', { count: team.agentCount })}${team.managerName ? ` · ${t('dashboard.team.manager', { name: team.managerName })}` : ''}`;
  return (
    <section className="card bjt-team">
      <div className="card-head">
        <h2>{team.name}</h2>
        <span className="muted small">{head}</span>
      </div>
      <Kpis>
        <KpiBox label={t('dashboard.team.received')} value={n(k.orders)} sub={t('dashboard.team.receivedSub', { n: k.todo })} help={t('dashboard.help.received')} />
        <KpiBox label={t('dashboard.team.confirmed')} value={n(k.confirmed)} sub={t('dashboard.team.confirmedSub', { n: k.confirmationsInPeriod })} tone="ok" help={t('dashboard.help.confirmed')} />
        <KpiBox
          label={t('dashboard.team.confRate')}
          value={pct(k.confRate)}
          sub={t('dashboard.team.confRateSub', { c: k.cancelled, f: k.fake, d: k.duplicates })}
          tone={confTone(k.confRate)}
          help={rateType === 'perf' ? t('dashboard.help.confRatePerf') : t('dashboard.help.confRate')}
        />
        <KpiBox label={t('dashboard.team.delivRate')} value={pct(k.deliveryRate)} sub={t('dashboard.team.delivered', { count: k.delivered })} help={t('dashboard.help.delivRate')} />
        <KpiBox label={t('dashboard.team.finalRate')} value={pct(k.finalRate)} sub={t('dashboard.team.finalSub')} help={t('dashboard.help.finalRate')} />
        <KpiBox label={t('dashboard.team.inProgress')} value={n(k.inProgress)} sub={t('dashboard.team.inProgressSub', { n: team.unassigned })} help={t('dashboard.help.inProgress')} />
        <KpiBox label={t('dashboard.team.late')} value={n(k.lateCallbacks)} sub={t('dashboard.team.lateSub')} tone={k.lateCallbacks ? 'bad' : undefined} help={t('dashboard.help.late')} />
        <KpiBox
          label={t('dashboard.team.first')}
          value={pct(k.firstRate)}
          sub={k.firstMedianMs !== null ? t('dashboard.team.firstSub', { d: dur(k.firstMedianMs) }) : t('dashboard.team.noFirst')}
          tone={timeTone(k.firstRate)}
          help={t('dashboard.help.first')}
        />
        <KpiBox label={t('dashboard.team.tries')} value={pct(k.triesRate)} sub={t('dashboard.team.triesSub', { ok: k.triesOnTime, ko: k.triesMissed })} tone={timeTone(k.triesRate)} help={t('dashboard.help.tries')} />
        <KpiBox label={t('dashboard.team.calls')} value={n(k.calls)} sub={t('dashboard.team.callsSub', { v: perConf })} help={t('dashboard.help.calls')} />
      </Kpis>
      <div className="bjt-chead">
        <h3>{chart === 'conf' ? t('dashboard.chart.confTitle') : t('dashboard.chart.callsTitle')}</h3>
        <label className="bjt-mlab">
          <span>{t('dashboard.chart.label')}</span>
          <select className="bjt-msel" aria-label={t('dashboard.chart.choose')} value={chart} onChange={(e) => setChart(e.target.value as 'conf' | 'calls')}>
            <option value="conf">{t('dashboard.chart.conf')}</option>
            <option value="calls">{t('dashboard.chart.calls')}</option>
          </select>
        </label>
      </div>
      <Chart series={team.series} kind={chart} hourly={hourly} />
      <div className="bjt-chead">
        <h3>{t('dashboard.rank.title')}</h3>
        <label className="bjt-mlab">
          <span>{t('dashboard.rank.sortBy')}</span>
          <select className="bjt-msel" aria-label={t('dashboard.rank.sortAria')} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`dashboard.rank.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Ranking agents={team.agents} sort={sort} />
    </section>
  );
}

function Chart({ series, kind, hourly }: { series: Team['series']; kind: 'conf' | 'calls'; hourly: boolean }) {
  const { t } = useTranslation();
  const W = 760;
  const H = 230;
  const L = 34;
  const R = 44;
  const T = 16;
  const B = 26;
  const vals = series.map((s) => (kind === 'conf' ? s.confirmed : s.calls));
  const max = Math.max(5, ...vals);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / (step / 2)) * (step / 2);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => Math.round(top * f));
  const iw = W - L - R;
  const ih = H - T - B;
  const bw = series.length ? iw / series.length : iw;
  const x = (i: number) => L + bw * i + bw / 2;
  const y = (v: number) => T + ih - (v / top) * ih;
  const yr = (r: number) => T + ih - r * ih;
  const pts = series.map((s, i) => (s.rate === null ? null : [x(i), yr(s.rate)] as const));
  const every = Math.max(1, Math.ceil(series.length / (hourly ? 12 : 14)));
  let path = '';
  pts.forEach((p) => {
    if (p) path += `${path ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  });
  return (
    <div className="bjt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={kind === 'conf' ? t('dashboard.chart.confTitle') : t('dashboard.chart.callsTitle')}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="g" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text x={L - 6} y={y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {[0, 0.5, 1].map((r) => (
          <text key={r} className="pr" x={W - R + 6} y={yr(r) + 3}>
            {Math.round(r * 100)}%
          </text>
        ))}
        {series.map((s, i) => {
          const v = vals[i];
          const h = Math.max(v ? 2 : 0, (v / top) * ih);
          return (
            <g key={i}>
              <rect className="b" x={x(i) - bw * 0.32} width={bw * 0.64} y={T + ih - h} height={h} rx={2} />
              {v > 0 && (
                <text className="vl" x={x(i)} y={T + ih - h - 4} textAnchor="middle">
                  {v}
                </text>
              )}
              {i % every === 0 && (
                <text x={x(i)} y={H - 8} textAnchor="middle">
                  {s.label}
                </text>
              )}
            </g>
          );
        })}
        {path && <path className="ln" d={path} />}
        {pts.map((p, i) => p && <circle key={i} className="dt" cx={p[0]} cy={p[1]} r={3.5} />)}
      </svg>
      <div className="bjt-lg">
        <span>
          <i className="lb" />
          {kind === 'conf' ? (hourly ? t('dashboard.chart.legConfH') : t('dashboard.chart.legConf')) : hourly ? t('dashboard.chart.legCallsH') : t('dashboard.chart.legCalls')}
        </span>
        <span>
          <i className="ll" />
          {t('dashboard.chart.legRate')}
        </span>
      </div>
    </div>
  );
}

function Ranking({ agents, sort }: { agents: Agent[]; sort: Sort }) {
  const { t } = useTranslation();
  const rows = useMemo(() => [...agents].sort((a, b) => ((b[sort] as number | null) ?? -1) - ((a[sort] as number | null) ?? -1) || b.orders - a.orders), [agents, sort]);
  if (!rows.length) return <p className="muted">{t('dashboard.rank.empty')}</p>;
  const bestTries = Math.max(...rows.map((r) => r.triesRate ?? -1));
  const medals = ['bji-gold', 'bji-silver', 'bji-bronze'];
  const cols: [string, Sort | null][] = [
    ['#', null], ['agent', null], ['orders', 'orders'], ['confirmation', 'confRate'], ['delivery', 'deliveryRate'], ['final', 'finalRate'],
    ['cancelled', null], ['inProgress', null], ['late', null], ['calls', 'calls'], ['first', 'firstRate'], ['tries', 'triesRate'],
  ];
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {cols.map(([c, s], i) => (
              <th key={c} className={`${i > 1 ? 'num' : ''} ${s === sort ? 'bjt-on' : ''}`.trim() || undefined}>
                {c === '#' ? '#' : t(`dashboard.rank.col.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((a, i) => {
            const last = rows.length > 3 && i === rows.length - 1;
            return (
              <tr key={a.id} className={last ? 'warn-row' : undefined}>
                <td data-l="#">{i < 3 ? <Icon name="medal" className={medals[i]} /> : <span className="ltr">{i + 1}</span>}</td>
                <td className="wide px-cw" data-l={t('dashboard.rank.col.agent')}>
                  <div className="px-clamp">
                    <b>{a.name}</b>
                    {last && (
                      <small>
                        <Icon name="alert" /> {t('dashboard.rank.lowest')}
                      </small>
                    )}
                  </div>
                </td>
                <td className="num ltr" data-l={t('dashboard.rank.col.orders')}>{n(a.orders)}</td>
                <td className="num" data-l={t('dashboard.rank.col.confirmation')}>
                  <Badge tone={confTone(a.confRate, true)}>{pct(a.confRate)}</Badge>
                  <small>{t('dashboard.rank.confirmed', { count: a.confirmed })}</small>
                </td>
                <td className="num" data-l={t('dashboard.rank.col.delivery')}>
                  <Badge tone={delivTone(a.deliveryRate, true)}>{pct(a.deliveryRate)}</Badge>
                  <small>{t('dashboard.rank.delivered', { count: a.delivered })}</small>
                </td>
                <td className="num" data-l={t('dashboard.rank.col.final')}>
                  <Badge tone={delivTone(a.finalRate === null ? null : a.finalRate * 2, true)}>{pct(a.finalRate)}</Badge>
                </td>
                <td className="num" data-l={t('dashboard.rank.col.cancelled')}>
                  <span className="ltr">{n(a.cancelled)}</span>
                  <small>{t('dashboard.rank.fakes', { count: a.fake })}</small>
                </td>
                <td className="num ltr" data-l={t('dashboard.rank.col.inProgress')}>{n(a.inProgress)}</td>
                <td className="num" data-l={t('dashboard.rank.col.late')}>{a.lateCallbacks ? <Badge tone="bad">{a.lateCallbacks}</Badge> : <span className="ltr">0</span>}</td>
                <td className="num ltr" data-l={t('dashboard.rank.col.calls')}>{n(a.calls)}</td>
                <td className="num" data-l={t('dashboard.rank.col.first')}>
                  <Badge tone={timeTone(a.firstRate)}>{t('dashboard.rank.onTime', { v: pct(a.firstRate) })}</Badge>
                  {a.firstMedianMs !== null && <small>{t('dashboard.rank.median', { d: dur(a.firstMedianMs) })}</small>}
                </td>
                <td className="num" data-l={t('dashboard.rank.col.tries')}>
                  <Badge tone={timeTone(a.triesRate)} className={a.triesRate !== null && a.triesRate === bestTries ? 'bjt-top' : ''}>
                    {pct(a.triesRate)}
                  </Badge>
                  <small>{t('dashboard.rank.missed', { count: a.triesMissed })}</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Delays({ d }: { d: Data }) {
  const { t } = useTranslation();
  const x = d.delays;
  return (
    <Card title={t('dashboard.delays.title')} help={t('dashboard.delays.help')}>
      <Kpis>
        <KpiBox label={t('dashboard.delays.lateNow')} value={n(x.lateFirstNow)} sub={t('dashboard.delays.lateNowSub')} tone={x.lateFirstNow ? 'bad' : undefined} href="#/confirmation/nouvelles" />
        <KpiBox label={t('dashboard.team.first')} value={pct(x.firstRate)} sub={x.firstMedianMs !== null ? t('dashboard.team.firstSub', { d: dur(x.firstMedianMs) }) : t('dashboard.team.noFirst')} tone={timeTone(x.firstRate)} />
        <KpiBox label={t('dashboard.team.tries')} value={pct(x.triesRate)} sub={t('dashboard.team.triesSub', { ok: x.triesOnTime, ko: x.triesMissed })} tone={timeTone(x.triesRate)} />
      </Kpis>
      {x.worst.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('dashboard.rank.col.agent')}</th>
                <th className="num">{t('dashboard.delays.lateFirst')}</th>
                <th className="num">{t('dashboard.rank.col.first')}</th>
                <th className="num">{t('dashboard.delays.missed')}</th>
                <th className="num">{t('dashboard.rank.col.tries')}</th>
              </tr>
            </thead>
            <tbody>
              {x.worst.map((w) => (
                <tr key={w.id}>
                  <td data-l={t('dashboard.rank.col.agent')}>{w.name}</td>
                  <td className="num ltr" data-l={t('dashboard.delays.lateFirst')}>{n(w.lateFirst)}</td>
                  <td className="num" data-l={t('dashboard.rank.col.first')}>
                    <Badge tone={timeTone(w.firstRate)}>{pct(w.firstRate)}</Badge>
                    {w.firstMedianMs !== null && <small>{t('dashboard.rank.median', { d: dur(w.firstMedianMs) })}</small>}
                  </td>
                  <td className="num ltr" data-l={t('dashboard.delays.missed')}>{n(w.triesMissed)}</td>
                  <td className="num" data-l={t('dashboard.rank.col.tries')}>
                    <Badge tone={timeTone(w.triesRate)}>{pct(w.triesRate)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function TeamEditor({ meta }: { meta: Meta }) {
  const { t } = useTranslation();
  const init = () => Object.fromEntries(meta.agents.map((a) => [a.id, a.managerId])) as Record<number, number | null>;
  const [map, setMap] = useState(init);
  useEffect(() => setMap(init()), [meta]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction('stats.saveTeams', { success: t('dashboard.editor.saved') });
  if (!meta.agents.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('dashboard.editor.title')}</h2>
        <span className="muted small">{t('dashboard.editor.sub')}</span>
      </div>
      {!meta.managers.length ? (
        <p className="muted">{t('dashboard.editor.noManagers')}</p>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.editor.agent')}</th>
                  <th>{t('dashboard.editor.manager')}</th>
                </tr>
              </thead>
              <tbody>
                {meta.agents.map((a) => (
                  <tr key={a.id}>
                    <td className="wide px-cw" data-l={t('dashboard.editor.agent')}>
                      <div className="px-clamp">
                        <b>{a.name}</b>
                      </div>
                    </td>
                    <td className="wide px-cw" data-l={t('dashboard.editor.manager')}>
                      <select aria-label={t('dashboard.editor.managerOf', { name: a.name })} value={map[a.id] ?? ''} onChange={(e) => setMap({ ...map, [a.id]: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">{t('dashboard.editor.none')}</option>
                        {meta.managers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row end">
            <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ assignments: meta.agents.map((a) => ({ agentId: a.id, managerId: map[a.id] ?? null })) })}>
              {t('dashboard.editor.save')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
