// A team's board for one area (Confirmation, Suivi, Dépôt, Livreurs, SAV): where the team stands (its numbers against the
// target and the period before), what is late now, every member next to the team with what they should work on and
// what they do best, day by day, and the reasons given. A member opens their own page (a drawer, a sheet on a phone).
import { ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../../lib/backend';
import { dayRange, n } from '../../../lib/format';
import { useRpc } from '../../../lib/query';
import { useSession } from '../../../lib/session';
import { useIsPhone } from '../../../lib/useMedia';
import { ErrorBox, Help, Icon, Loading } from '../../../ui/kit';
import { Sheet } from '../../../ui/Sheet';
import { AnyPeriod, inputsOf, rangeOf, useStored } from '../util';
import { AreaDef, AreaKey, AREAS, coachOf, fmt, outOf, teamRef, toneOf, Vals } from './defs';
import { Avatar, BCard, DayChart, Meter, NowList, PeriodChips, ReasonBars, TrendChip } from './parts';
import './board.css';

type BoardData = Out<'stats.board'>;
export type Member = BoardData['members'][number];

/** The period of the boards, remembered for the viewer. */
export function useBoardPeriod(key = 'dash.tb', initial: AnyPeriod = '7d') {
  const [period, setPeriod] = useStored<AnyPeriod>(`${key}.period`, initial);
  const [custom, setCustom] = useStored<{ from: string; to: string }>(`${key}.custom`, inputsOf(rangeOf('7d')));
  const range = useMemo(() => rangeOf(period, custom), [period, custom.from, custom.to]); // eslint-disable-line react-hooks/exhaustive-deps
  return { period, setPeriod, custom, setCustom, range };
}

export function Board({ area, extra, range, compact }: { area: AreaKey; extra?: ReactNode; range?: { from: string; to: string }; compact?: boolean }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const phone = useIsPhone();
  const per = useBoardPeriod();
  const [teamId, setTeamId] = useStored<string>('dash.tb.team', '');
  const def = AREAS[area];
  const q = useRpc('stats.board', { ...(range ?? per.range), area, teamId: area === 'confirmation' && teamId && !compact ? teamId : undefined }, { refetchInterval: 60_000 });
  const pres = useRpc('stats.presence', {}, { enabled: area === 'confirmation', refetchInterval: 30_000 });
  const presence = new Map((pres.data?.agents ?? []).map((a) => [a.id, a.presence]));
  const [open, setOpen] = useState<Member | null>(null);
  const b = q.data;
  const teamName = b && b.teamId ? b.teams.find((x) => x.id === b.teamId)?.name : null;
  const showTeams = area === 'confirmation' && (b?.teams.length ?? 0) > 1;

  return (
    <div className={`tb tb-${area}${compact ? ' compact' : ''}`}>
      {compact ? (
        <header className="tb-chead">
          <h2>
            <Icon name="users" />
            <span className="tb-chn">{t('dashboard.tb.myTeam')}</span>
            {b && b.teams.length === 1 && b.teams[0].id !== 'me' && <small>· {b.teams[0].name}</small>}
          </h2>
          <a className="tb-open" href={`#/dashboard/${area}`}>
            {t('dashboard.tb.openBoard')} <Icon name="chevr" />
          </a>
        </header>
      ) : (
      <header className="tb-head">
        <div className="tb-ht">
          <h2>{t(`dashboard.areas.${area}`)}</h2>
          {b && (
            <p className="tb-cap">
              {dayRange(b.range.from, b.range.to)}
              <span className="tb-capvs"> · {t('dashboard.tb.vs', { range: dayRange(b.prevRange.from, b.prevRange.to) })}</span>
            </p>
          )}
        </div>
        <PeriodChips value={per.period} onChange={per.setPeriod} custom={per.custom} onCustom={per.setCustom} />
        {showTeams && b && (
          <div className="tb-teams" role="radiogroup" aria-label={t('dashboard.teams.team')}>
            <button type="button" role="radio" aria-checked={!b.teamId} className={!b.teamId ? 'on' : ''} onClick={() => setTeamId('')}>
              {t('dashboard.tb.allTeams')}
            </button>
            {b.teams.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={b.teamId === x.id} className={b.teamId === x.id ? 'on' : ''} onClick={() => setTeamId(x.id)}>
                {x.id === 'none' ? t('dashboard.tb.noManager') : x.name}
                <small className="ltr">{x.size}</small>
              </button>
            ))}
          </div>
        )}
      </header>
      )}

      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !b ? (
        <Loading />
      ) : (
        <div className={`tb-body${q.isFetching && q.isPlaceholderData ? ' busy' : ''}`}>
          <NowList area={area} def={def} items={b.now} isAdmin={!!session?.isAdmin} />
          <Pulse area={area} def={def} b={b} />
          <BCard
            id={`tb-team-${area}`}
            className="tb-teamcard"
            title={
              <>
                {t('dashboard.tb.team')}
                {teamName && <small> · {teamName}</small>}
              </>
            }
            aside={t('dashboard.tb.members', { count: b.members.filter((m) => !m.none).length })}
          >
            {phone ? <TeamCards area={area} def={def} b={b} presence={presence} onOpen={setOpen} /> : <TeamTable area={area} def={def} b={b} presence={presence} onOpen={setOpen} />}
          </BCard>
          {!compact && (
          <div className="tb-two">
            <BCard id={`tb-days-${area}`} title={t('dashboard.tb.days')}>
              {b.days.length < 2 ? <p className="tb-calm">{t('dashboard.tb.daysOne')}</p> : <DayChart days={b.days} barLabel={t(`dashboard.tb.bar.${area}`)} lineLabel={t(`dashboard.tb.line.${area}`)} />}
            </BCard>
            {def.reasons && (
              <BCard id={`tb-why-${area}`} title={t(`dashboard.tb.why.${area}`)}>
                {b.reasons.length ? <ReasonBars list={b.reasons} /> : <p className="tb-calm">{t(`dashboard.tb.whyNone.${area}`)}</p>}
              </BCard>
            )}
          </div>
          )}
          {!compact && b.groups.length > 0 && <Groups area={area} def={def} b={b} onPick={setTeamId} />}
          {extra}
        </div>
      )}
      {open && b && <MemberSheet area={area} def={def} m={open} b={b} presence={presence.get(open.id ?? -1)} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- the team's numbers
function Pulse({ area, def, b }: { area: AreaKey; def: AreaDef; b: BoardData }) {
  const { t } = useTranslation();
  return (
    <div className="tb-pulse">
      {def.pulse.map((k) => {
        const d = def.metrics[k];
        const tone = toneOf(def, k, b.team);
        return (
          <section key={k} className={`tb-k is-${tone ?? 'none'}`}>
            <span className="tb-kl">
              {t(`dashboard.tb.m.${area}.${k}.l`)}
              <Help text={t(`dashboard.tb.m.${area}.${k}.h`)} label={t(`dashboard.tb.m.${area}.${k}.l`)} />
            </span>
            <b className="tb-kv ltr">{fmt(d, b.team[k])}</b>
            {d.target && <Meter def={d} v={b.team[k]} tone={tone} big />}
            <span className="tb-kf">
              <TrendChip def={d} v={b.team[k]} p={b.prev[k]} label={t('dashboard.tb.vsPrevShort')} />
              <small>{d.target ? t(d.better === 'up' ? 'dashboard.tb.targetUp' : 'dashboard.tb.targetDown', { v: fmt(d, d.target[0]) }) : t(`dashboard.tb.m.${area}.${k}.s`)}</small>
            </span>
          </section>
        );
      })}
    </div>
  );
}

const PRES: Record<string, string> = { call: 'call', online: 'on', idle: 'idle', offline: 'off' };

/** A member's name in the board (work that belongs to nobody yet has its own name). */
function nameOf(t: (k: string) => string, area: AreaKey, m: Member) {
  return m.none ? t(`dashboard.tb.none.${area}`) : m.name;
}

function FocusChip({ area, def, m, team }: { area: AreaKey; def: AreaDef; m: Member; team: Vals }) {
  const { t } = useTranslation();
  if (m.none) return null;
  const c = coachOf(def, m.v, team);
  if (c.focus)
    return (
      <span className="tb-focus">
        <Icon name="flag" /> {t(`dashboard.tb.m.${area}.${c.focus.key}.l`)}
      </span>
    );
  if (c.strength)
    return (
      <span className="tb-strong">
        <Icon name="trophy" /> {t(`dashboard.tb.m.${area}.${c.strength.key}.l`)}
      </span>
    );
  return <span className="tb-fine">{!outOf(def, m.v, def.volume) ? t('dashboard.tb.noWork') : c.judged ? t('dashboard.tb.allGood') : t('dashboard.tb.fewShort')}</span>;
}

function Cell({ def, k, v, b }: { def: AreaDef; k: string; v: Vals; b: BoardData }) {
  const d = def.metrics[k];
  const tone = toneOf(def, k, v);
  return (
    <span className={`tb-cell is-${tone ?? 'none'}`}>
      <b className="ltr">{fmt(d, v[k])}</b>
      {(d.target || d.fmt === 'pct') && v[k] !== null && <Meter def={d} v={v[k]} team={teamRef(def, k, b.team, b.members)} tone={tone} />}
    </span>
  );
}

function TeamTable({ area, def, b, presence, onOpen }: { area: AreaKey; def: AreaDef; b: BoardData; presence: Map<number, string>; onOpen: (m: Member) => void }) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: def.volume, dir: -1 });
  const rows = [...b.members].sort((a, x) => Number(a.none) - Number(x.none) || sort.dir * ((a.v[sort.k] ?? -Infinity) - (x.v[sort.k] ?? -Infinity)) || a.name.localeCompare(x.name));
  const head = (k: string) => {
    const on = sort.k === k;
    return (
      <th key={k} className="num" aria-sort={on ? (sort.dir === -1 ? 'descending' : 'ascending') : undefined}>
        <button type="button" className={on ? 'on' : ''} onClick={() => setSort({ k, dir: on && sort.dir === -1 ? 1 : -1 })}>
          {t(`dashboard.tb.m.${area}.${k}.l`)}
          {on && <span aria-hidden="true">{sort.dir === -1 ? '↓' : '↑'}</span>}
        </button>
      </th>
    );
  };
  return (
    <div className="tb-tw">
      <table className="tb-tbl">
        <thead>
          <tr>
            <th>{t(`dashboard.tb.who.${area}`)}</th>
            {def.cols.map(head)}
            <th>{t('dashboard.tb.coach')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id ?? 'none'} className={m.none ? 'none' : ''} tabIndex={m.none ? undefined : 0} onClick={() => !m.none && onOpen(m)} onKeyDown={(e) => !m.none && e.key === 'Enter' && onOpen(m)}>
              <td>
                <span className="tb-who">
                  <Avatar name={m.name} none={m.none} presence={m.id !== null ? PRES[presence.get(m.id) ?? ''] : undefined} />
                  <b>{nameOf(t, area, m)}</b>
                </span>
              </td>
              {def.cols.map((k) => (
                <td key={k} className="num">
                  <Cell def={def} k={k} v={m.v} b={b} />
                </td>
              ))}
              <td>
                <FocusChip area={area} def={def} m={m} team={b.team} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>
              <b>{t('dashboard.tb.teamRow')}</b>
            </td>
            {def.cols.map((k) => (
              <td key={k} className="num">
                <b className="ltr">{fmt(def.metrics[k], b.team[k])}</b>
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
      <p className="tb-legend">
        <span>
          <i className="tgt" /> {t('dashboard.tb.legTarget')}
        </span>
        <span>
          <i className="avg" /> {t('dashboard.tb.legTeam')}
        </span>
        <span>{t('dashboard.tb.legOpen')}</span>
      </p>
    </div>
  );
}

function TeamCards({ area, def, b, presence, onOpen }: { area: AreaKey; def: AreaDef; b: BoardData; presence: Map<number, string>; onOpen: (m: Member) => void }) {
  const { t } = useTranslation();
  return (
    <ul className="tb-cards">
      {b.members.map((m) => {
        const body = (
          <>
            <span className="tb-cardh">
              <Avatar name={m.name} none={m.none} presence={m.id !== null ? PRES[presence.get(m.id) ?? ''] : undefined} />
              <span className="tb-cardn">
                <b>{nameOf(t, area, m)}</b>
                <small>
                  <span className="ltr">{n(m.v[def.volume])}</span> {t(`dashboard.tb.m.${area}.${def.volume}.u`)}
                </small>
              </span>
              {!m.none && <Icon name="chevr" />}
            </span>
            <span className="tb-cardm">
              {def.card.map((k) => (
                <span key={k}>
                  <small>{t(`dashboard.tb.m.${area}.${k}.l`)}</small>
                  <Cell def={def} k={k} v={m.v} b={b} />
                </span>
              ))}
            </span>
            {!m.none && <FocusChip area={area} def={def} m={m} team={b.team} />}
          </>
        );
        return (
          <li key={m.id ?? 'none'}>
            {m.none ? (
              <div className="tb-mcard none">{body}</div>
            ) : (
              <button type="button" className="tb-mcard" onClick={() => onOpen(m)}>
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- the teams side by side (admin, every team)
function Groups({ area, def, b, onPick }: { area: AreaKey; def: AreaDef; b: BoardData; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const keys = [def.volume, ...def.pulse.filter((k) => k !== def.volume)];
  return (
    <BCard id={`tb-groups-${area}`} title={t('dashboard.tb.groups')} aside={t('dashboard.tb.groupsSub')}>
      <div className="tb-groups">
        {b.groups.map((g) => (
          <button key={g.id} type="button" className="tb-group" onClick={() => onPick(g.id)}>
            <span className="tb-gh">
              <b>{g.id === 'none' ? t('dashboard.tb.noManager') : g.name}</b>
              <small>{t('dashboard.tb.members', { count: g.size })}</small>
            </span>
            {keys.map((k) => {
              const d = def.metrics[k];
              const tone = toneOf(def, k, g.v);
              return (
                <span key={k} className="tb-gm">
                  <small>{t(`dashboard.tb.m.${area}.${k}.l`)}</small>
                  <span className={`tb-cell is-${tone ?? 'none'}`}>
                    <b className="ltr">{fmt(d, g.v[k])}</b>
                    <TrendChip def={d} v={g.v[k]} p={g.p[k]} />
                  </span>
                </span>
              );
            })}
          </button>
        ))}
      </div>
    </BCard>
  );
}

// ---------------------------------------------------------------- one member
function MemberSheet({ area, def, m, b, presence, onClose }: { area: AreaKey; def: AreaDef; m: Member; b: BoardData; presence?: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet
      title={
        <span className="tb-sht">
          <Avatar name={m.name} presence={PRES[presence ?? '']} />
          {m.name}
        </span>
      }
      sub={`${presence ? `${t(`dashboard.pres.state.${presence}`)} · ` : ''}${dayRange(b.range.from, b.range.to)}`}
      onClose={onClose}
      className="tb-side"
      tall
    >
      <MemberDetail area={area} v={m.v} p={m.p} days={m.days} reasons={m.reasons} team={b.team} teamDays={b.days} refOf={(k) => teamRef(def, k, b.team, b.members)} />
    </Sheet>
  );
}

/** A person's numbers next to the team's: what to work on first (and how), their strength, each number with its meter
 *  and its trend, what is waiting now, day by day, the reasons. (A member's page, and an agent's own day.) */
export function MemberDetail({
  area,
  v,
  p,
  days,
  reasons,
  team,
  teamDays,
  refOf,
  mine,
  wide,
}: {
  area: AreaKey;
  v: Vals;
  p: Vals;
  days: { d: string; n: number; ok: number; of: number }[];
  reasons: { reason: string; n: number }[];
  team: Vals;
  teamDays?: { d: string; ok: number; of: number }[];
  /** what a number is compared with (the team's rate, or its average per person for a count) */
  refOf: (key: string) => number | null;
  /** the agent's own day: the tip speaks to them */
  mine?: boolean;
  /** two columns (a wide screen) */
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const def = AREAS[area];
  const c = coachOf(def, v, team);
  const rows = Object.values(def.metrics).filter((d) => !d.live && (d.coach || d.key === def.volume || def.cols.includes(d.key)));
  const live = Object.values(def.metrics).filter((d) => d.live);
  const vol = outOf(def, v, def.volume);
  const coach = c.focus ? (
    <section className="tb-coach focus">
      <span className="tb-coachh">
        <Icon name="flag" /> {t(mine ? 'dashboard.tb.focusMine' : 'dashboard.tb.focus')} · <b>{t(`dashboard.tb.m.${area}.${c.focus.key}.l`)}</b>
      </span>
      <p className="tb-coachv">
        <b className="ltr">{fmt(def.metrics[c.focus.key], c.focus.v)}</b>
        {c.focus.team !== null && <span>{t('dashboard.tb.teamIs', { v: fmt(def.metrics[c.focus.key], c.focus.team) })}</span>}
        {def.metrics[c.focus.key].target && <span>{t(def.metrics[c.focus.key].better === 'up' ? 'dashboard.tb.targetUp' : 'dashboard.tb.targetDown', { v: fmt(def.metrics[c.focus.key], def.metrics[c.focus.key].target![0]) })}</span>}
      </p>
      <p className="tb-tip-t">
        <Icon name="sparkles" /> {t(`dashboard.tb.tip.${area}.${c.focus.key}`)}
      </p>
    </section>
  ) : (
    <section className="tb-coach fine">
      <span className="tb-coachh">
        <Icon name="checkcircle" /> {!vol ? t('dashboard.tb.noWorkLong') : c.judged ? t(mine ? 'dashboard.tb.fineMine' : 'dashboard.tb.fineLong') : t('dashboard.tb.fewLong')}
      </span>
    </section>
  );
  const strength = c.strength && (
    <p className="tb-strongl">
      <Icon name="trophy" /> {t('dashboard.tb.strength')} · <b>{t(`dashboard.tb.m.${area}.${c.strength.key}.l`)}</b> <span className="ltr">{fmt(def.metrics[c.strength.key], c.strength.v)}</span>
      {c.strength.team !== null && <small> ({t('dashboard.tb.teamIs', { v: fmt(def.metrics[c.strength.key], c.strength.team) })})</small>}
    </p>
  );
  const list = (
    <ul className="tb-mrows">
      {rows.map((d) => {
        const tone = toneOf(def, d.key, v);
        const few = d.min && outOf(def, v, d.key) < d.min && v[d.key] !== null;
        const ref = refOf(d.key);
        return (
          <li key={d.key}>
            <span className="tb-mrl">
              {t(`dashboard.tb.m.${area}.${d.key}.l`)}
              <Help text={t(`dashboard.tb.m.${area}.${d.key}.h`)} label={t(`dashboard.tb.m.${area}.${d.key}.l`)} />
            </span>
            <span className={`tb-mrv is-${tone ?? 'none'}`}>
              <b className="ltr">{fmt(d, v[d.key])}</b>
              <TrendChip def={d} v={v[d.key]} p={p[d.key]} label={t('dashboard.tb.vsPrevShort')} />
            </span>
            <span className="tb-mrm">
              <Meter def={d} v={v[d.key]} team={ref} tone={tone} />
              <small>{few ? t('dashboard.tb.few') : t(d.fmt === 'n' ? 'dashboard.tb.teamAvg' : 'dashboard.tb.teamIs', { v: fmt(d, ref) })}</small>
            </span>
          </li>
        );
      })}
    </ul>
  );
  const now = live.length > 0 && (
    <section className="tb-live">
      <h4>{t('dashboard.tb.liveNow')}</h4>
      <div>
        {live.map((d) => (
          <span key={d.key} className={(v[d.key] ?? 0) > 0 && d.better === 'down' ? 'hot' : ''}>
            <b className="ltr">{fmt(d, v[d.key])}</b>
            <small>{t(`dashboard.tb.m.${area}.${d.key}.l`)}</small>
          </span>
        ))}
      </div>
    </section>
  );
  const chart = days.length >= 2 && (
    <section className="tb-msec">
      <h4>{t('dashboard.tb.days')}</h4>
      <DayChart days={days} team={teamDays} barLabel={t(`dashboard.tb.bar.${area}`)} lineLabel={t(`dashboard.tb.line.${area}`)} teamLabel={t('dashboard.tb.lineTeam')} />
    </section>
  );
  const why = def.reasons && reasons.length > 0 && (
    <section className="tb-msec">
      <h4>{t(`dashboard.tb.why.${area}`)}</h4>
      <ReasonBars list={reasons} />
    </section>
  );
  if (wide)
    return (
      <div className="tb-myw">
        <div className="tb-myl">
          {coach}
          {strength}
          {now}
          {chart}
        </div>
        <div className="tb-myr">
          {list}
          {why}
        </div>
      </div>
    );
  return (
    <>
      {coach}
      {strength}
      {list}
      {now}
      {chart}
      {why}
    </>
  );
}
