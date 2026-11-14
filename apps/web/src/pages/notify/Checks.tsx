// Pilot Automations › Pilot Checks (admins): the owner's rules for the cases of the « Pilotix Judge » — what can go
// wrong in the offer, the video, the landing page, the page's trust, Meta and the team (packages/shared/src/pilotchecks.ts).
// One row per case: its name and its number (« this ÷ that »), when it is bad, what to do, the helper that watches it
// (door, bell, doctor, or off) and what Pilotix has today to count it. « Modifier » opens the row: the limit, the helper,
// the wait before judging, his own words for the action and the other part; « Revenir au départ » forgets his changes.
// Every change is listed at the bottom (who, when, old, new). The rules are only kept for now: nothing is counted,
// blocked or rung with them yet, and the page says so.
import { type CheckDef, type CheckLevel, type CheckPart, type CheckRule, CHECK_PARTS, CHECK_RANGE, CHECK_TEXT_MAX, CHECK_WAIT_MAX, CHECKS, checkDef, checkLevels } from '@pilotix/shared';
import { type CSSProperties, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { In, Out } from '../../lib/backend';
import { when as whenAt } from '../../lib/format';
import i18n from '../../lib/i18n';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Filters, SearchBox } from '../ai/agent';
import './checks.css';

type S = Out<'auto.checks'>;
type Line = S['log'][number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = (k: string, o?: any) => string;
type DataGroup = 'ready' | 'toAdd' | 'unverified';

const GLYPH: Record<CheckLevel, string> = { door: 'door', bell: 'bell', doctor: 'stethoscope', off: 'power' };
/** the helpers, from the earliest to the latest */
const HELPERS: CheckLevel[] = ['door', 'bell', 'doctor', 'off'];
const GROUP_OF: Record<CheckDef['data'], DataGroup> = { ready: 'ready', reason: 'toAdd', tags: 'toAdd', tick: 'toAdd', none: 'toAdd', unverified: 'unverified' };
const DATA_ICON: Record<CheckDef['data'], string> = { ready: 'check', reason: 'list', tags: 'tag', tick: 'checkcircle', none: 'eyeoff', unverified: 'help' };

/** 0.8 → « 0,8 », 1000 → « 1 000 » (two decimals at most, Latin digits in every language) */
const num = (x: number | null | undefined) =>
  x === null || x === undefined || !isFinite(x) ? '' : new Intl.NumberFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR', { numberingSystem: 'latn', maximumFractionDigits: 2 } as Intl.NumberFormatOptions).format(x);
/** a text the owner typed, kept whole inside a sentence of the other direction */
const own = (s: string) => `⁨${s}⁩`;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** « 2,5 » or « 2.5 » as typed → 2.5 (NaN when it is not a number) */
const typed = (s: string) => (s.trim() === '' ? NaN : Number(s.trim().replace(/\s/g, '').replace(',', '.')));

/** « Moins de 5 % »: the limit as a sentence (a fixed condition: its own words). */
const whenBase = (t: T, d: CheckDef, v: number | null, v2: number | null): string => (d.op === 'fixed' ? t(`checks.c.${d.id}.when`) : t(`checks.when.${d.op}.${d.unit}`, { v: num(v), v2: num(v2) }));
/** the case's own condition after its limit (« pendant 3 semaines de suite… »), when it has one */
const whenTail = (t: T, d: CheckDef): string => (d.tail ? t(`checks.c.${d.id}.tail`) : '');
const whenText = (t: T, d: CheckDef, v: number | null, v2: number | null): string => [whenBase(t, d, v, v2), whenTail(t, d)].filter(Boolean).join(' ');
const waitText = (t: T, d: CheckDef, v: number) => (d.wait ? t(`checks.wait.${d.wait.unit}`, { count: v, v: num(v) }) : '');

export function Checks() {
  const q = useRpc('auto.checks', {});
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Board d={q.data} />;
}

function Board({ d }: { d: S }) {
  const { t } = useTranslation();
  const [part, setPart] = useState<'all' | CheckPart>('all');
  const [level, setLevel] = useState<CheckLevel | null>(null);
  const [data, setData] = useState<'all' | DataGroup>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rules = useMemo(() => new Map(d.rules.map((r) => [r.id, r])), [d.rules]);
  const ruleOf = (c: CheckDef) => rules.get(c.id)!;
  const lang = i18n.language;
  // what a search looks in: the case's name, its number, what to do, the other part (in the reader's language)
  const words = useMemo(
    () => new Map(CHECKS.map((c) => { const r = rules.get(c.id); return [c.id, fold([c.id, t(`checks.c.${c.id}.name`), t(`checks.c.${c.id}.kpi`), r?.action ?? t(`checks.c.${c.id}.do`), r?.other ?? (c.also ? t(`checks.c.${c.id}.also`) : '')].join(' '))] as const; })),
    [rules, lang], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const q = fold(search.trim());
  const inPart = (c: CheckDef) => part === 'all' || c.part === part;
  const rest = (c: CheckDef) => (data === 'all' || GROUP_OF[c.data] === data) && (!q || words.get(c.id)!.includes(q));
  const shown = CHECKS.filter((c) => inPart(c) && rest(c) && (!level || ruleOf(c).level === level));
  const countLevel = (lv: CheckLevel) => CHECKS.filter((c) => inPart(c) && rest(c) && ruleOf(c).level === lv).length;
  const group = (g: DataGroup) => CHECKS.filter((c) => GROUP_OF[c.data] === g).length;
  const filtered = part !== 'all' || !!level || data !== 'all' || !!q;
  const clear = () => {
    setPart('all');
    setLevel(null);
    setData('all');
    setSearch('');
  };
  const helpers = HELPERS.filter((lv) => lv !== 'off' || d.rules.some((r) => r.level === 'off'));
  return (
    <div className="pc">
      <p className="au-lead">{t('checks.lead')}</p>
      <p className="pc-step">
        <Icon name="info" />
        <span>
          <b>{t('checks.step.title')}</b> {t('checks.step.text')}
        </span>
      </p>

      {/* the helpers: what each one does, how many cases it watches; a tap keeps only its cases */}
      <div className="pc-key" role="group" aria-label={t('checks.keyLabel')} style={{ '--n': helpers.length } as CSSProperties}>
        {helpers.map((lv) => (
          <button key={lv} type="button" className={`pc-keyb lv-${lv} ${level === lv ? 'on' : ''}`} aria-pressed={level === lv} onClick={() => setLevel(level === lv ? null : lv)}>
            <span className={`pc-glyph lv-${lv}`} aria-hidden="true">
              <Icon name={GLYPH[lv]} />
            </span>
            <span className="pc-keyt">
              <span className="pc-keyn">
                <b>{t(`checks.level.${lv}`)}</b>
                <i className="ltr">{countLevel(lv)}</i>
              </span>
              <small>{t(`checks.levelHelp.${lv}`)}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="pc-bar">
        <div className="pc-barrow">
          <SearchBox value={search} onChange={setSearch} placeholder={t('checks.search')} />
          <select value={data} aria-label={t('checks.dataFilter')} onChange={(e) => setData(e.target.value as 'all' | DataGroup)}>
            <option value="all">
              {t('checks.dataFilter')} · {t('checks.dataGroup.all')}
            </option>
            {(['ready', 'toAdd', 'unverified'] as const).map((g) => (
              <option key={g} value={g}>
                {t(`checks.dataGroup.${g}`)} ({group(g)})
              </option>
            ))}
          </select>
        </div>
        <Filters
          value={part}
          onChange={setPart}
          label={t('checks.title')}
          items={[{ value: 'all' as const, label: t('checks.parts.all'), count: CHECKS.length }, ...CHECK_PARTS.map((p) => ({ value: p, label: t(`checks.parts.${p}`), count: CHECKS.filter((c) => c.part === p).length }))]}
        />
        <p className="ai-note">
          {t('checks.dataSum', { ready: group('ready'), toAdd: group('toAdd'), unverified: group('unverified'), total: CHECKS.length })}
          {filtered && <> {t('checks.shownOf', { shown: shown.length, total: CHECKS.length })}.</>}
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="ai-empty">
          <Icon name="search" />
          <p>{t('checks.none')}</p>
          <button type="button" className="btn" onClick={clear}>
            {t('checks.clear')}
          </button>
        </div>
      ) : (
        CHECK_PARTS.filter((p) => shown.some((c) => c.part === p)).map((p) => {
          const list = shown.filter((c) => c.part === p);
          return (
            <section key={p} className="card pc-part">
              <div className="card-head">
                <h2>{t(`checks.parts.${p}`)}</h2>
                <span className="muted small">{t('checks.cases', { count: list.length })}</span>
              </div>
              <div className="pc-head" aria-hidden="true">
                <span />
                <span>{t('checks.head.case')}</span>
                <span>{t('checks.f.when')}</span>
                <span>{t('checks.f.do')}</span>
                <span />
              </div>
              <ul className="pc-list">
                {list.map((c) => (
                  <Row key={c.id} c={c} rule={ruleOf(c)} log={d.log} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onClose={() => setOpen(null)} />
                ))}
              </ul>
            </section>
          );
        })
      )}

      <section className="card pc-log">
        <div className="card-head">
          <h2>{t('checks.log.title')}</h2>
        </div>
        {d.log.length === 0 ? (
          <p className="pc-logempty">{t('checks.log.empty')}</p>
        ) : (
          <ul className="pc-lines">
            {d.log.map((l) => (
              <LogLine key={l.id} l={l} withCase />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Row({ c, rule, log, open, onToggle, onClose }: { c: CheckDef; rule: CheckRule; log: Line[]; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const panel = useId();
  const name = t(`checks.c.${c.id}.name`);
  const also = rule.other ?? (c.also ? t(`checks.c.${c.id}.also`) : '');
  return (
    <li className={`pc-row ${open ? 'is-open' : ''} ${rule.level === 'off' ? 'is-off' : ''}`}>
      <div className="pc-line">
        <span className={`pc-glyph lv-${rule.level}`} title={t(`checks.level.${rule.level}`)} aria-hidden="true">
          <Icon name={GLYPH[rule.level]} />
        </span>
        <div className="pc-what">
          <h3>
            <span>{name}</span>
            <span className="pc-id ltr">{c.id}</span>
          </h3>
          <p className="pc-kpi">{t(`checks.c.${c.id}.kpi`)}</p>
          <p className="pc-tags">
            <span className={`pc-lv lv-${rule.level}`}>{t(`checks.level.${rule.level}`)}</span>
            {c.data !== 'ready' && (
              <span className="pc-data">
                <Icon name={DATA_ICON[c.data]} />
                {t(`checks.data.${c.data}`)}
              </span>
            )}
            {rule.changed.length > 0 && (
              <span className="pc-mine">
                <Icon name="pencil" />
                {t('checks.changed')}
              </span>
            )}
          </p>
        </div>
        <div className="pc-cell pc-when">
          <span className="pc-lab">{t('checks.f.when')}</span>
          <b>{whenBase(t, c, rule.v, rule.v2)}</b>
          {c.tail && <span className="pc-tail">{whenTail(t, c)}</span>}
          {c.wait && rule.wait !== null && (
            <span className="pc-wait">
              <Icon name="hourglass" />
              {t('checks.f.wait', { what: waitText(t, c, rule.wait) })}
            </span>
          )}
        </div>
        <div className="pc-cell pc-do">
          <span className="pc-lab">{t('checks.f.do')}</span>
          <p>{rule.action ?? t(`checks.c.${c.id}.do`)}</p>
          {also && (
            <p className="pc-also">
              <span>{t('checks.f.also')}</span> {also}
            </p>
          )}
        </div>
        <button type="button" className="btn small pc-edit" aria-expanded={open} aria-controls={panel} aria-label={t('checks.editOf', { name })} onClick={onToggle}>
          <Icon name={open ? 'x' : 'pencil'} />
          <span>{open ? t('checks.close') : t('checks.edit')}</span>
        </button>
      </div>
      {open && <Editor id={panel} c={c} rule={rule} log={log.filter((l) => l.checkId === c.id)} onClose={onClose} />}
    </li>
  );
}

function Editor({ id, c, rule, log, onClose }: { id: string; c: CheckDef; rule: CheckRule; log: Line[]; onClose: () => void }) {
  const { t } = useTranslation();
  const k = 'checks.ed';
  const uid = useId();
  const range = CHECK_RANGE[c.unit];
  const ownDo = t(`checks.c.${c.id}.do`);
  const ownAlso = c.also ? t(`checks.c.${c.id}.also`) : '';
  const [v, setV] = useState(rule.v === null ? '' : String(rule.v));
  const [v2, setV2] = useState(rule.v2 === null ? '' : String(rule.v2));
  const [level, setLevel] = useState<CheckLevel>(rule.level);
  const [wait, setWait] = useState(rule.wait === null ? '' : String(rule.wait));
  const [action, setAction] = useState(rule.action ?? ownDo);
  const [other, setOther] = useState(rule.other ?? ownAlso);
  const [err, setErr] = useState<{ v?: string; wait?: string }>({});
  const save = useAction('auto.checkSave', { success: (r) => t(r.changed ? `${k}.saved` : `${k}.nothing`), onDone: onClose });
  const reset = useAction('auto.checkReset', { success: t(`${k}.resetDone`), onDone: onClose });
  const busy = save.isPending || reset.isPending;
  const levels = checkLevels(c);
  const unit = t(`checks.unit.${c.unit}`);
  // the sentence as it will read with what is typed (the saved limit while a number is not valid)
  const a = typed(v);
  const b = typed(v2);
  const preview = whenText(t, c, isFinite(a) ? a : rule.v, isFinite(b) ? b : rule.v2);
  const start = whenText(t, c, c.v, c.v2);

  const submit = () => {
    const e: typeof err = {};
    const patch: In<'auto.checkSave'> = { id: c.id };
    if (c.v !== null) {
      const hi = c.v2 !== null ? b : null;
      const out = (x: number) => !isFinite(x) || x < range.min || x > range.max;
      if (out(a) || (hi !== null && out(hi))) e.v = t(`${k}.badNumber`, { min: num(range.min), max: num(range.max) });
      else if (hi !== null && a >= hi) e.v = t(`${k}.badOrder`);
      else {
        if (a !== rule.v) patch.v = a;
        if (hi !== null && hi !== rule.v2) patch.v2 = hi;
      }
    }
    if (c.wait) {
      const w = typed(wait);
      if (!Number.isInteger(w) || w < 1 || w > CHECK_WAIT_MAX) e.wait = t(`${k}.badWait`);
      else if (w !== rule.wait) patch.wait = w;
    }
    if (level !== rule.level) patch.level = level;
    // his own words: the app's text (or nothing) typed back means « not mine any more »
    const words = (now: string, mine: string | null, app: string) => {
      const s = now.trim().replace(/\s+/g, ' ');
      const next = s === '' || s === app ? null : s;
      return next === mine ? undefined : (next ?? '');
    };
    const act = words(action, rule.action, ownDo);
    const oth = words(other, rule.other, ownAlso);
    if (act !== undefined) patch.action = act;
    if (oth !== undefined) patch.other = oth;
    setErr(e);
    if (e.v || e.wait) return;
    if (Object.keys(patch).length === 1) {
      toast(t(`${k}.nothing`));
      onClose();
      return;
    }
    save.mutate(patch);
  };

  return (
    <form
      id={id}
      className="pc-ed"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="pc-edgrid">
        <div className="pc-f">
          <span className="pc-flab" id={`${uid}-lim`}>
            {t(`${k}.limit`)}
          </span>
          {c.v === null ? (
            <p className="pc-hint">{t(`${k}.fixed`)}</p>
          ) : (
            <>
              <div className="pc-nums" role="group" aria-labelledby={`${uid}-lim`}>
                <label className={`pc-num ${err.v ? 'bad' : ''}`}>
                  {c.v2 !== null && <span>{t(`${k}.low`)}</span>}
                  <input type="text" inputMode="decimal" className="ltr" value={v} aria-invalid={!!err.v} aria-describedby={err.v ? `${uid}-ev` : undefined} aria-label={c.v2 !== null ? t(`${k}.low`) : t(`${k}.limit`)} onChange={(e) => { setV(e.target.value); setErr({ ...err, v: undefined }); }} />
                  {unit && <i>{unit}</i>}
                </label>
                {c.v2 !== null && (
                  <label className={`pc-num ${err.v ? 'bad' : ''}`}>
                    <span>{t(`${k}.high`)}</span>
                    <input type="text" inputMode="decimal" className="ltr" value={v2} aria-invalid={!!err.v} aria-label={t(`${k}.high`)} onChange={(e) => { setV2(e.target.value); setErr({ ...err, v: undefined }); }} />
                    {unit && <i>{unit}</i>}
                  </label>
                )}
              </div>
              {err.v ? (
                <p className="pc-err" id={`${uid}-ev`} role="alert">
                  {err.v}
                </p>
              ) : (
                <p className="pc-read">{preview}</p>
              )}
              <p className="pc-hint">{t(`${k}.start`, { v: start })}</p>
            </>
          )}
          {c.wait && (
            <>
              <label className="pc-flab pc-gap" htmlFor={`${uid}-w`}>
                {t(`${k}.wait`)}
              </label>
              <span className={`pc-num ${err.wait ? 'bad' : ''}`}>
                <input id={`${uid}-w`} type="text" inputMode="numeric" className="ltr" value={wait} aria-invalid={!!err.wait} aria-describedby={err.wait ? `${uid}-ew` : undefined} onChange={(e) => { setWait(e.target.value); setErr({ ...err, wait: undefined }); }} />
                <i>{t(`checks.waitUnit.${c.wait.unit}`)}</i>
              </span>
              {err.wait && (
                <p className="pc-err" id={`${uid}-ew`} role="alert">
                  {err.wait}
                </p>
              )}
              <p className="pc-hint">{t(`${k}.start`, { v: waitText(t, c, c.wait.v) })}</p>
            </>
          )}
        </div>

        <div className="pc-f">
          <span className="pc-flab" id={`${uid}-lv`}>
            {t(`${k}.level`)}
          </span>
          <div className="pc-levels" role="radiogroup" aria-labelledby={`${uid}-lv`}>
            {levels.map((lv) => (
              <label key={lv} className={`pc-level lv-${lv} ${level === lv ? 'on' : ''}`}>
                <input type="radio" name={`${uid}-level`} value={lv} checked={level === lv} onChange={() => setLevel(lv)} />
                <Icon name={GLYPH[lv]} />
                <span>{t(`checks.level.${lv}`)}</span>
              </label>
            ))}
          </div>
          <p className="pc-read">{t(`checks.levelHelp.${level}`)}</p>
          <p className="pc-hint">{c.doors.length ? t('checks.doorAt', { where: c.doors.map((x) => t(`checks.door.${x}`)).join(' · ') }) : t(`${k}.noDoor`)}</p>
        </div>

        <label className="pc-f">
          <span className="pc-flab">{t(`${k}.do`)}</span>
          <textarea rows={3} maxLength={CHECK_TEXT_MAX} value={action} onChange={(e) => setAction(e.target.value)} />
          <span className="pc-hint">{t(`${k}.own`)}</span>
        </label>
        <label className="pc-f">
          <span className="pc-flab">{t(`${k}.also`)}</span>
          <textarea rows={3} maxLength={CHECK_TEXT_MAX} value={other} onChange={(e) => setOther(e.target.value)} />
        </label>
      </div>

      <div className="pc-edfoot">
        {rule.changed.length > 0 && (
          <button type="button" className="btn ghost pc-reset" disabled={busy} onClick={() => reset.mutate({ id: c.id })}>
            <Icon name="undo" />
            {t(`${k}.reset`)}
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {t(`${k}.cancel`)}
        </button>
        <button type="submit" className={`btn primary ${save.isPending ? 'busy' : ''}`} disabled={busy}>
          {t(`${k}.save`)}
        </button>
      </div>

      {log.length > 0 && (
        <div className="pc-hist">
          <h4>{t(`${k}.history`)}</h4>
          <ul className="pc-lines">
            {log.map((l) => (
              <LogLine key={l.id} l={l} />
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

/** One change, in the reader's language: « limite : 20 % → 25 % ». */
function lineText(t: T, l: Line): string {
  const field = t(`checks.log.field.${l.field}`);
  const c = checkDef(l.checkId);
  if (l.field === 'reset' || !c) return field;
  const say = (x: string | null): string => {
    if (l.field === 'action' || l.field === 'other') return x === null ? t('checks.log.own') : `« ${own(x)} »`;
    if (x === null) return '—';
    if (l.field === 'level') return t(`checks.level.${x}`);
    if (l.field === 'wait') return waitText(t, c, Number(x));
    return t(`checks.val.${c.unit}`, { v: num(Number(x)) });
  };
  return t('checks.log.line', { field, old: say(l.old), new: say(l.new) });
}

function LogLine({ l, withCase }: { l: Line; withCase?: boolean }) {
  const { t } = useTranslation();
  return (
    <li>
      <span className="pc-dot" aria-hidden="true">
        <Icon name={l.field === 'reset' ? 'undo' : 'pencil'} />
      </span>
      <span className="pc-linet">
        {withCase && checkDef(l.checkId) && <b>{t(`checks.c.${l.checkId}.name`)}</b>}
        <span>{lineText(t, l)}</span>
      </span>
      <time dateTime={l.at}>
        {l.by ?? t('checks.log.someone')} · {whenAt(l.at)}
      </time>
    </li>
  );
}
