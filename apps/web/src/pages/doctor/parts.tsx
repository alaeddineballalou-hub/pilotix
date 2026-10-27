// The Doctor's screen pieces, shared by Pilotix Doctor (each shop, Dashboard) and the server Doctor (control room):
// the score, the problems (worst first, each with what to do and a link), what is fine.
import type { DoctorItem, DoctorLevel, DoctorLine } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, wilaya } from '../../lib/format';
import { Icon } from '../../ui/kit';
import { copilotMood, CopilotIcon } from './CopilotIcon';
import './doctor.css';

const AREA_ICON: Record<string, string> = {
  stock: 'package',
  confirmation: 'phone',
  team: 'users',
  depot: 'scanbar',
  delivery: 'truck',
  sales: 'megaphone',
  cash: 'wallet',
  server: 'sliders',
  database: 'layers',
  jobs: 'refresh',
  code: 'alert',
  shops: 'users',
  config: 'lock',
};

/** A number of a sentence, written for the reader (money in DA, the rest in the reader's language). */
function fmtParams(p: DoctorItem['params']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p ?? {})) out[k] = typeof v !== 'number' ? v : k === 'amount' ? da(v) : n(v);
  // i18next picks the plural from `count`: it must stay a number
  if (typeof p?.count === 'number') out.count = p.count;
  return out;
}

export function lineValue(t: (k: string, o?: any) => string, l: DoctorLine): string {
  switch (l.unit) {
    case 'pct':
      return `${n(l.n)} %`;
    case 'days':
      return t('doctor.u.days', { count: l.n });
    case 'hours':
      return t('doctor.u.hours', { count: l.n });
    case 'da':
      return da(l.n);
    case 'min':
      return `${n(l.n)} min`;
    case 'text':
      return '';
    case 'ms':
      return `${n(l.n)} ms`;
    case 'mb':
      return t('doctor.u.mb', { n: n(l.n) });
    default:
      return n(l.n);
  }
}

/** The score as a ring: green 80+, orange 50+, red below. */
export function ScoreRing({ score }: { score: number }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const tone = score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
  return (
    <svg className={`dr-ring dr-${tone}`} viewBox="0 0 110 110" role="img" aria-label={`${score} / 100`}>
      <circle cx="55" cy="55" r={r} className="dr-ring-bg" />
      <circle cx="55" cy="55" r={r} className="dr-ring-v" strokeDasharray={`${(c * score) / 100} ${c}`} transform="rotate(-90 55 55)" />
      <text x="55" y="58" textAnchor="middle" className="dr-ring-n">
        {score}
      </text>
      <text x="55" y="76" textAnchor="middle" className="dr-ring-s">
        / 100
      </text>
    </svg>
  );
}

/** "il y a 12 s", "il y a 3 min": how long ago it looked, ticking every second. */
function Live({ at }: { at: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  const ago = s < 60 ? t('doctor.ago.s', { n: s }) : t('doctor.ago.min', { n: Math.round(s / 60) });
  return (
    <span className="dr-live" aria-live="off">
      <i aria-hidden="true" />
      {t('doctor.live', { ago })}
    </span>
  );
}

/**
 * The top of a Doctor / Co-Pilot (the "cockpit"): the living face, one sentence, a bar of every check's colour, the
 * counts, the score. No "look again" button: the page keeps it up to date by itself.
 */
export function DoctorHero({ title, sub, score, items, checkedAt, badge }: { title: string; sub?: string; score: number; items: DoctorItem[]; checkedAt: string; badge?: string }) {
  const { t } = useTranslation();
  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  // the same checks as the folded « all good » list below (what only informs is fine too)
  const ok = items.filter((i) => i.level === 'ok' || i.level === 'info').length;
  const mood = copilotMood(items);
  return (
    <section className={`dr-cock dr-cock-${mood}`}>
      <CopilotIcon mood={mood} size={64} label={title} />
      <div className="dr-cock-m">
        <div className="dr-cock-top">
          <h2 className="dr-cock-t">{title}</h2>
          {badge && <span className="dr-cock-badge">{badge}</span>}
          <Live at={checkedAt} />
        </div>
        <p className="dr-cock-say">{bad ? t('doctor.say.bad', { count: bad }) : warn ? t('doctor.say.warn', { count: warn }) : t('doctor.say.ok')}</p>
        {sub && <p className="dr-cock-sub">{sub}</p>}
        <div className="dr-cock-bar" role="img" aria-label={`${bad} ${t('doctor.lv.bad')}, ${warn} ${t('doctor.lv.warn')}, ${ok} ${t('doctor.lv.ok')}`}>
          {bad > 0 && <i className="dr-seg-bad" style={{ flexGrow: bad }} />}
          {warn > 0 && <i className="dr-seg-warn" style={{ flexGrow: warn }} />}
          {ok > 0 && <i className="dr-seg-ok" style={{ flexGrow: ok }} />}
        </div>
        <div className="dr-cock-legend">
          <span>
            <b>{bad}</b> {t('doctor.lv.bad')}
          </span>
          <span>
            <b>{warn}</b> {t('doctor.lv.warn')}
          </span>
          <span>
            <b>{ok}</b> {t('doctor.lv.ok')}
          </span>
        </div>
      </div>
      <div className="dr-cock-score">
        <b className="ltr">{score}</b>
        <small>{t('doctor.outOf')}</small>
      </div>
    </section>
  );
}

/** The sentence of one check: its problem, or what is fine. */
function itemTitle(t: (k: string, o?: any) => string, item: DoctorItem) {
  const p = fmtParams(item.params);
  const key = `doctor.c.${item.id}`;
  const open = item.level === 'bad' || item.level === 'warn';
  return open ? t(`${key}.title`, p) : t(`${key}.${item.level === 'info' ? 'info' : 'okTitle'}`, { ...p, defaultValue: t(`${key}.short`, p) });
}

/** One line of the list: colour, icon, the sentence, its team; a click unfolds why, the worst cases, what to do, where. */
function DoctorRow({ item, open, onToggle }: { item: DoctorItem; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const p = fmtParams(item.params);
  const key = `doctor.c.${item.id}`;
  const problem = item.level === 'bad' || item.level === 'warn';
  const id = `dr-row-${item.id}`;
  return (
    <li className={`dr-row dr-${item.level} ${open ? 'open' : ''}`}>
      <button type="button" className="dr-row-h" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <i className="dr-row-bar" aria-hidden="true" />
        <span className="dr-row-ic">
          <Icon name={AREA_ICON[item.area] ?? 'help'} />
        </span>
        <span className="dr-row-t">
          <b>{itemTitle(t, item)}</b>
          <small>{t(`doctor.area.${item.area}`)}</small>
        </span>
        <span className={`dr-tag dr-${item.level}`}>{t(`doctor.tag.${item.level}`)}</span>
        <Icon name="chevron" className="dr-row-ch" />
      </button>
      {open && (
        <div className="dr-row-d" id={id}>
          {problem && <p className="dr-why">{t(`${key}.${item.params?.amount !== undefined ? 'whyMoney' : 'why'}`, { ...p, defaultValue: t(`${key}.why`, p) })}</p>}
          {!!item.list?.length && (
            <ul className="dr-list">
              {item.list.map((l, i) => (
                <li key={i}>
                  <span>{l.wilaya ? wilaya(l.wilaya) : item.id === 'jobs' ? t(`doctor.job.${l.label}`, { defaultValue: l.label }) : l.label}</span>
                  {l.unit !== 'text' && <b className="ltr">{lineValue(t, l)}</b>}
                </li>
              ))}
            </ul>
          )}
          {problem && (
            <p className="dr-fix">
              <Icon name="checkcircle" />
              <span>{t(`${key}.fix`, p)}</span>
            </p>
          )}
          {!problem && <p className="dr-why">{t(`${key}.short`, p)}</p>}
          {problem && item.href && (
            <a className="btn small primary dr-go" href={item.href}>
              {t('doctor.go')}
            </a>
          )}
        </div>
      )}
    </li>
  );
}

type Group = 'bad' | 'warn' | 'ok';

/**
 * Every check, as a list that folds: the urgent ones, then the ones to watch, then what is fine. Each group folds on its
 * own, each line unfolds its details, and one button folds or unfolds everything. What is open stays open while the
 * page updates itself.
 */
export function DoctorList({ items }: { items: DoctorItem[] }) {
  const { t } = useTranslation();
  const groups: { g: Group; label: string; xs: DoctorItem[] }[] = [
    { g: 'bad', label: t('doctor.g.bad'), xs: items.filter((i) => i.level === 'bad') },
    { g: 'warn', label: t('doctor.g.warn'), xs: items.filter((i) => i.level === 'warn') },
    { g: 'ok', label: t('doctor.g.ok'), xs: items.filter((i) => i.level === 'ok' || i.level === 'info') },
  ];
  const shown = groups.filter((x) => x.xs.length);
  // groups: urgent and to watch open, what is fine folded; lines: all folded
  const [closed, setClosed] = useState<Record<Group, boolean>>({ bad: false, warn: false, ok: true });
  const [rows, setRows] = useState<Set<string>>(() => new Set());
  const everythingOpen = shown.every((x) => !closed[x.g]) && items.every((i) => rows.has(i.id));
  const all = (open: boolean) => {
    setClosed({ bad: !open, warn: !open, ok: !open });
    setRows(open ? new Set(items.map((i) => i.id)) : new Set());
  };
  const toggleRow = (id: string) =>
    setRows((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const problems = groups[0].xs.length + groups[1].xs.length;
  return (
    <div className="dr-body">
      {!problems && (
        <div className="dr-allgood">
          <Icon name="checkcircle" />
          <div>
            <b>{t('doctor.allGood')}</b>
            <p className="muted small">{t('doctor.allGoodSub')}</p>
          </div>
        </div>
      )}
      <div className="dr-tools">
        <button type="button" className="btn small" onClick={() => all(!everythingOpen)}>
          <Icon name="chevron" className={everythingOpen ? 'dr-up' : ''} />
          {everythingOpen ? t('doctor.foldAll') : t('doctor.unfoldAll')}
        </button>
      </div>
      {shown.map(({ g, label, xs }) => (
        <section key={g} className={`dr-grp dr-${g}`}>
          <button type="button" className="dr-gh dr-fold" aria-expanded={!closed[g]} onClick={() => setClosed((c) => ({ ...c, [g]: !c[g] }))}>
            {label} <span>{xs.length}</span>
            <Icon name="chevron" />
          </button>
          {!closed[g] && (
            <ul className="dr-rows">
              {xs.map((i) => (
                <DoctorRow key={i.id} item={i} open={rows.has(i.id)} onToggle={() => toggleRow(i.id)} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
