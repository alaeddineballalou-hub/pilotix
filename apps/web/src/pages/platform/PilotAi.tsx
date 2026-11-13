// Pilot AI (control room): the shops' AI agents, all on Pilotix's own AI key (shops never bring one). Five tabs:
// Dellal AI (its sales dashboard: conversion and real sales per shop, product and channel, why chats end without a sale;
// its two pushes (« Push en test », then « Push sur le serveur »: PilotRelease.tsx); how it learns, drawn; its
// instruction book to download, always the latest; last night, the coach's morning check of each lesson, the lesson books),
// Test & lessons (talk to Dellal as a customer with the book of your
// choice; teach it a lesson in your own words: PilotLab.tsx), CM AI (the comments it handled), Spy AI (Pilotix's own search
// key for every shop, its daily number of searches per shop: SpyKey.tsx; the competitors it watches), and Settings & costs (the key, the daily limit, the night budget, what each shop's AI costs to bill it; Pilotix's
// Meta and TikTok apps, which let the boutiques link their accounts: SocialApps.tsx).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, dateTime, n, when } from '../../lib/format';
import { downloadCsv } from '../../lib/files';
import type { POut, Staff } from '../../lib/platform';
import { PilotDemo, usePilotAction, usePilotRpc } from './pilotDemo';
import { VersionsCard } from './PilotInsights';
import { Card, ErrorBox, Field, Icon, Loading, Tabs } from '../../ui/kit';
import { can } from './bits';
import { BoardDays, CmBoard, DellalBoard, SpyBoard } from './PilotBoards';
import { BookCard, LearnCard } from './PilotLearn';
import { LabTab } from './PilotLab';
import { ReleaseCard } from './PilotRelease';
import { CaseModal } from './pilotCase';
import { SocialAppsCard } from './SocialApps';
import { PhotoStoreCard } from './PhotoStore';
import { SpyKeyCard } from './SpyKey';
import { AiKeysCard } from './AiKeys';

type State = POut<'p.pilot.state'>;
type Lesson = State['candidates'][number];
const OUTCOMES = ['delivered', 'refused', 'cancelled', 'fake', 'no_order', 'pending', 'stale'] as const;
const pct = (k: number, total: number) => (total ? `${((k / total) * 100).toFixed(1)} %` : '—');
const TABS = ['dellal', 'lab', 'cm', 'spy', 'ai', 'settings'] as const;
type Tab = (typeof TABS)[number];

export function PilotAiPage({ staff, tab, demo }: { staff: Staff; tab?: string; demo?: boolean }) {
  return (
    <PilotDemo.Provider value={!!demo}>
      <PilotAiInner staff={staff} tab={tab} demo={!!demo} />
    </PilotDemo.Provider>
  );
}

function PilotAiInner({ staff, tab, demo }: { staff: Staff; tab?: string; demo: boolean }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.pilot.state', {}, { refetchInterval: 60_000 });
  // the period and the shop stay the same from one tab to the next
  const [days, setDays] = useState<BoardDays>(30);
  const [shopId, setShopId] = useState<number | null>(null);
  const cur: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'dellal';
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const manager = can(staff, 'manager');
  const go = (v: Tab) => (location.hash = v === 'dellal' ? '#/platform/pilot' : `#/platform/pilot/${v}`);
  const board = { days, onDays: setDays, shopId, onShop: setShopId, manager };
  return (
    <div className="pp-stack pilot-page">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.pilot')}</h1>
          <p className="muted">{t('platform.pilot.sub')}</p>
        </div>
      </div>
      {demo && <p className="pp-prot-demo">{t('platform.pilot.demo.note')}</p>}
      <div className="pilot-tabs">
        <Tabs
          value={cur}
          onChange={go}
          items={TABS.map((k) => ({
            value: k,
            label: t(`platform.pilot.tabs.${k}`),
            ...(k === 'dellal' && d.candidates.length ? { count: d.candidates.length } : k === 'lab' && d.lahjaWaiting ? { count: d.lahjaWaiting } : {}),
          }))}
        />
      </div>
      {cur === 'dellal' && (
        <>
          <DellalBoard {...board} aside={<BookCard d={d} />} />
          <ReleaseCard d={d} manager={manager} />
          <LearnCard d={d} />
          <VersionsCard shopId={shopId} />
          <div className="pp-grid">
            <NightCard d={d} />
            <ShopsCard d={d} manager={manager} />
          </div>
          <CoachCard items={d.candidates} />
          <BooksCard d={d} manager={manager} />
        </>
      )}
      {cur === 'lab' && <LabTab d={d} manager={manager} />}
      {cur === 'cm' && <CmBoard {...board} />}
      {cur === 'spy' && (
        <>
          <SpyKeyCard manager={manager} />
          <SpyBoard {...board} />
        </>
      )}
      {cur === 'ai' && (manager ? <AiKeysCard manager={manager} claude={d.config} /> : <p className="muted small">{t('platform.pilot.costs.managers')}</p>)}
      {cur === 'settings' && (
        <>
          <div className="pilot-settings">
            <SettingsCard d={d} manager={manager} />
            <VoiceCard manager={manager} />
          </div>
          <SocialAppsCard manager={manager} />
          <PhotoStoreCard manager={manager} />
          {manager ? <CostCard /> : <p className="muted small">{t('platform.pilot.costs.managers')}</p>}
        </>
      )}
    </div>
  );
}

function SettingsCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(d.config.enabled);
  const [max, setMax] = useState(String(d.config.maxUsd));
  const [share, setShare] = useState(String(Math.round(d.config.share * 100)));
  const [day, setDay] = useState(String(d.config.dayUsd));
  const [key, setKey] = useState('');
  const save = usePilotAction('p.pilot.save', { success: t('platform.saved'), onDone: () => setKey('') });
  const send = (k?: string | null) =>
    save.mutate({ enabled: on, maxUsd: Number(max) || 0, share: (Number(share) || 20) / 100, dayUsd: Math.max(0, Number(day.replace(',', '.')) || 0), ...(k !== undefined ? { key: k } : {}) });
  const ready = d.config.enabled && d.config.hasKey;
  const rest = ready && d.today.rest;
  const usd = (x: number) => `${x.toFixed(2)} $`;
  return (
    <Card
      title={t('platform.pilot.settings')}
      badge={<span className={`chip ${ready && !rest ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{rest ? t('platform.pilot.resting') : ready ? t('platform.pilot.on') : t('platform.pilot.off')}</span>}
    >
      <p className="small muted">{t('platform.pilot.settingsText')}</p>
      <label className="check">
        <input type="checkbox" disabled={!manager} checked={on} onChange={(e) => setOn(e.target.checked)} /> {t('platform.pilot.enable')}
      </label>
      <Field label={t('platform.pilot.key')} hint={d.config.hasKey ? t('platform.pilot.keySaved') : t('platform.pilot.keyHint')}>
        <input type="password" className="ltr" autoComplete="off" disabled={!manager} value={key} placeholder={d.config.hasKey ? '••••••••' : 'sk-ant-…'} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <Field label={t('platform.pilot.dayUsd')} hint={t('platform.pilot.dayUsdHint')}>
        <input type="number" className="ltr" min={0} max={200} step={0.5} disabled={!manager} value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      {rest ? (
        <p className="warnbox">{t('platform.pilot.restText', { usd: usd(d.today.usd), max: usd(d.today.dayUsd) })}</p>
      ) : (
        <p className="small muted">{d.today.dayUsd > 0 ? t('platform.pilot.today', { usd: usd(d.today.usd), max: usd(d.today.dayUsd) }) : t('platform.pilot.todayNoLimit', { usd: usd(d.today.usd) })}</p>
      )}
      <div className="grid2">
        <Field label={t('platform.pilot.maxUsd')} hint={t('platform.pilot.maxUsdHint')}>
          <input type="number" className="ltr" min={0} max={5} step={0.05} disabled={!manager} value={max} onChange={(e) => setMax(e.target.value)} />
        </Field>
        <Field label={t('platform.pilot.share')} hint={t('platform.pilot.shareHint')}>
          <input type="number" className="ltr" min={5} max={50} step={5} disabled={!manager} value={share} onChange={(e) => setShare(e.target.value)} />
        </Field>
      </div>
      <p className="small muted">{t('platform.pilot.sharing', { shops: n(d.sharing.shops), cases: n(d.sharing.cases) })}</p>
      {manager && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={() => send(key.trim() || undefined)}>
            <Icon name="check" /> {t('common.save')}
          </button>
          {d.config.hasKey && (
            <button type="button" className="btn" disabled={save.isPending} onClick={() => send(null)}>
              {t('platform.pilot.keyRemove')}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- voice notes: Google Gemini writes them as text for Dellal
function VoiceCard({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.pilot.voice', {});
  const k = 'platform.pilot.voice.';
  const d = q.data;
  const [on, setOn] = useState(false);
  const [model, setModel] = useState('gemini-flash-latest');
  const [key, setKey] = useState('');
  useEffect(() => {
    if (!d) return;
    setOn(d.enabled);
    setModel(d.model);
  }, [d?.enabled, d?.model]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = usePilotAction('p.pilot.voiceSave', { success: t('platform.saved'), onDone: () => setKey('') });
  const send = (kk?: string | null) => save.mutate({ enabled: on, model: model.trim() || 'gemini-flash-latest', ...(kk !== undefined ? { key: kk } : {}) });
  const ready = !!d?.enabled && !!d?.hasKey;
  return (
    <Card title={t(k + 'title')} badge={d && <span className={`chip ${ready ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{ready ? t('platform.pilot.on') : t('platform.pilot.off')}</span>}>
      <p className="small muted">{t(k + 'text')}</p>
      {!d ? (
        <p className="muted small">{q.error?.message ?? '…'}</p>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" disabled={!manager} checked={on} onChange={(e) => setOn(e.target.checked)} /> {t(k + 'enable')}
          </label>
          <Field label={t(k + 'key')} hint={d.hasKey ? t(k + 'keySaved') : t(k + 'keyHint')}>
            <input type="password" className="ltr" autoComplete="off" disabled={!manager} value={key} placeholder={d.hasKey ? '••••••••' : 'AIza… / AQ.…'} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label={t(k + 'model')} hint={t(k + 'modelHint')}>
            <input className="ltr" maxLength={60} disabled={!manager} value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <p className="small muted">{t(k + 'today', { count: d.today.calls, n: n(d.today.calls), usd: `${d.today.usd.toFixed(d.today.usd > 0 && d.today.usd < 0.01 ? 4 : 2)} $` })}</p>
          {manager && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" disabled={save.isPending} onClick={() => send(key.trim() || undefined)}>
                <Icon name="check" /> {t('common.save')}
              </button>
              {d.hasKey && (
                <button type="button" className="btn" disabled={save.isPending} onClick={() => send(null)}>
                  {t('platform.pilot.keyRemove')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- what each shop's AI costs (to bill it)
type Costs = POut<'p.ai.costs'>;
const FEATS = ['dellal', 'cm', 'spy'] as const;
/** USD with cents; a few tenths of a cent still show (never « 0 » for something that cost) */
const usd = (x: number) => (x > 0 && x < 0.01 ? '< 0.01 $' : `${x.toFixed(2)} $`);
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const shiftMonth = (m: string, k: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function CostCard() {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(thisMonth);
  const q = usePilotRpc('p.ai.costs', { month });
  const save = usePilotAction('p.ai.rate', { success: t('platform.saved') });
  const [rate, setRate] = useState('');
  const d = q.data;
  useEffect(() => {
    if (d) setRate(d.rate ? String(d.rate) : '');
  }, [d?.rate]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
  const csv = (c: Costs) =>
    downloadCsv(`pilotix-ia-${c.month}.csv`, [
      [t('platform.col.shop'), ...FEATS.map((f) => t(`platform.pilot.costs.f.${f}`)), t('platform.pilot.costs.total'), t('platform.pilot.costs.toBill')],
      ...c.shops.map((s) => [s.name, ...FEATS.map((f) => s[f].usd.toFixed(4)), s.pilotixUsd.toFixed(4), s.da ?? '']),
      [t('platform.pilot.costs.all'), ...FEATS.map((f) => c.shops.reduce((a, s) => a + s[f].usd, 0).toFixed(4)), c.total.usd.toFixed(4), c.total.da ?? ''],
    ]);
  return (
    <Card title={t('platform.pilot.costs.title')} help={t('platform.pilot.costs.help')}>
      <div className="pilot-cost-bar">
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <button type="button" className="btn small" aria-label={t('platform.pilot.costs.prev')} onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <Icon name="chevl" />
          </button>
          <b className="pilot-cost-month">{label}</b>
          <button type="button" className="btn small" aria-label={t('platform.pilot.costs.next')} disabled={month >= thisMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            <Icon name="chevr" />
          </button>
        </div>
        <form
          className="row pilot-cost-rate"
          style={{ gap: 6, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ rate: Math.max(0, Number(rate.replace(',', '.')) || 0) });
          }}
        >
          <span className="small">1 $ =</span>
          <input type="number" className="ltr" min={0} max={10000} step={1} value={rate} placeholder="—" onChange={(e) => setRate(e.target.value)} aria-label={t('platform.pilot.costs.rate')} />
          <span className="small">DA</span>
          <button type="submit" className="btn small" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </form>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : d.shops.length === 0 ? (
        <p className="muted">{t('platform.pilot.costs.none')}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl pp-tbl pilot-cost">
            <thead>
              <tr>
                <th>{t('platform.col.shop')}</th>
                {FEATS.map((f) => (
                  <th key={f} className="num">
                    {t(`platform.pilot.costs.f.${f}`)}
                  </th>
                ))}
                <th className="num">{t('platform.pilot.costs.total')}</th>
                {d.rate > 0 && <th className="num">{t('platform.pilot.costs.toBill')}</th>}
              </tr>
            </thead>
            <tbody>
              {d.shops.map((s) => (
                <tr key={s.id}>
                  <td data-l={t('platform.col.shop')}>
                    <a href={`#/platform/shops/${s.id}`}>{s.name}</a>
                    {s.shopUsd > 0 && <small className="muted"> · {t('platform.pilot.costs.ownKey', { usd: usd(s.shopUsd) })}</small>}
                  </td>
                  {FEATS.map((f) => (
                    <td key={f} className="num ltr" data-l={t(`platform.pilot.costs.f.${f}`)}>
                      {s[f].calls ? (
                        <>
                          {usd(s[f].usd)}
                          <small className="muted pilot-cost-n">{t('platform.pilot.costs.calls', { count: s[f].calls, n: n(s[f].calls) })}</small>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ))}
                  <td className="num ltr" data-l={t('platform.pilot.costs.total')}>
                    <b>{usd(s.pilotixUsd)}</b>
                  </td>
                  {d.rate > 0 && (
                    <td className="num ltr" data-l={t('platform.pilot.costs.toBill')}>
                      <b>{s.da === null ? '—' : `${n(s.da)} DA`}</b>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <b>{t('platform.pilot.costs.all')}</b>
                </td>
                {FEATS.map((f) => (
                  <td key={f} className="num ltr" data-l={t(`platform.pilot.costs.f.${f}`)}>
                    {usd(d.shops.reduce((a, s) => a + s[f].usd, 0))}
                  </td>
                ))}
                <td className="num ltr" data-l={t('platform.pilot.costs.total')}>
                  <b>{usd(d.total.usd)}</b>
                </td>
                {d.rate > 0 && (
                  <td className="num ltr" data-l={t('platform.pilot.costs.toBill')}>
                    <b>{d.total.da === null ? '—' : `${n(d.total.da)} DA`}</b>
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {d && (
        <div className="pilot-cost-foot">
          <p className="small muted">
            {t('platform.pilot.costs.night', { usd: usd(d.nightUsd) })}
            {d.labUsd > 0 && <> · {t('platform.pilot.costs.lab', { usd: usd(d.labUsd) })}</>}
            {d.total.shopUsd > 0 && <> · {t('platform.pilot.costs.ownKeyAll', { usd: usd(d.total.shopUsd) })}</>}
          </p>
          <p className="small muted">{d.since ? t('platform.pilot.costs.since', { date: dateOnly(d.since) }) : t('platform.pilot.costs.notYet')}</p>
          {d.shops.length > 0 && (
            <button type="button" className="btn small" onClick={() => csv(d)}>
              <Icon name="download" /> {t('platform.pilot.costs.csv')}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Which shops teach Dellal: chosen here only (their terms say it); turning one off deletes what was kept of its chats. */
function ShopsCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const share = usePilotAction('p.pilot.share', { success: t('platform.saved') });
  const on = d.shops.filter((s) => s.share).length;
  const list = d.shops.filter((s) => !q.trim() || `${s.name} ${s.slug}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Card title={t('platform.pilot.shops')} badge={<span className="chip">{t('platform.pilot.shopsOn', { n: on, total: d.shops.length })}</span>} help={t('platform.pilot.shopsHelp')}>
      {d.shops.length > 8 && <input className="pilot-search" value={q} placeholder={t('platform.searchShop')} onChange={(e) => setQ(e.target.value)} />}
      <ul className="pp-mini">
        {list.map((s) => (
          <li key={s.id}>
            <label className="check">
              <input type="checkbox" disabled={!manager || share.isPending} checked={s.share} onChange={(e) => share.mutate({ shopId: s.id, share: e.target.checked })} />
              <span className="pp-two">
                <b>{s.name}</b>
                <small className="muted ltr">{s.slug}</small>
              </span>
            </label>
            <small className="muted">{t('platform.pilot.shopCases', { n: n(s.cases) })}</small>
          </li>
        ))}
      </ul>
      <p className="small muted">{t('platform.pilot.shopsOff')}</p>
    </Card>
  );
}

function NightCard({ d }: { d: State }) {
  const { t } = useTranslation();
  const r = d.night;
  if (!r)
    return (
      <Card title={t('platform.pilot.night')}>
        <p className="muted">{t('platform.pilot.noNight')}</p>
      </Card>
    );
  const by = r.cases.byOutcome ?? {};
  return (
    <Card title={t('platform.pilot.night')} badge={<span className="chip">{r.night}</span>}>
      <div className="pp-use">
        <div>
          <b className="ltr">{n(r.cases.total)}</b>
          <span>{t('platform.pilot.chats')}</span>
        </div>
        <div>
          <b className="ltr">{n(r.cases.gold)}</b>
          <span>{t('platform.pilot.gold')}</span>
        </div>
        <div>
          <b className="ltr">{n(r.lessons.proposed)}</b>
          <span>{t('platform.pilot.proposed')}</span>
        </div>
        <div>
          <b className="ltr">{n(r.lessons.rejectedByLint)}</b>
          <span>{t('platform.pilot.unsafe')}</span>
        </div>
      </div>
      <div className="pilot-chips">
        {OUTCOMES.filter((o) => by[o]).map((o) => (
          <span key={o} className={`chip o-${o}`}>
            {t(`platform.pilot.outcome.${o}`)} · <b className="ltr">{n(by[o])}</b>
          </span>
        ))}
      </div>
      <p className="small">
        <Icon name="moon" /> {t('platform.pilot.cost', { usd: r.spend.usd.toFixed(3), night: r.spend.nightUsd.toFixed(3), max: r.spend.maxUsd.toFixed(2) })}
        {r.spend.capHit && <span className="chip pp-chip-warn">{t('platform.pilot.capHit')}</span>}
      </p>
      {!r.ai.enabled && <p className="small muted">{t('platform.pilot.noAi')}</p>}
      <p className="small muted">{t('platform.pilot.ranAt', { when: when(r.at) })}</p>
    </Card>
  );
}

function CoachCard({ items }: { items: Lesson[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<[number, number] | null>(null);
  return (
    <Card title={t('platform.pilot.coach')} badge={items.length ? <span className="chip pp-chip-warn">{n(items.length)}</span> : undefined} help={t('platform.pilot.coachHelp')}>
      {!items.length ? <p className="muted">{t('platform.pilot.coachEmpty')}</p> : <div className="pilot-lessons">{items.map((l) => <LessonRow key={l.id} l={l} onCase={setOpen} />)}</div>}
      {open && <CaseModal shopId={open[0]} convId={open[1]} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function LessonRow({ l, onCase }: { l: Lesson; onCase: (c: [number, number]) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(l.text);
  const [note, setNote] = useState('');
  const act = usePilotAction('p.pilot.lesson', { success: t('platform.saved') });
  const ev = (l.evidence ?? {}) as { wins?: number; losses?: number; gold?: number; shops?: number; reasons?: Record<string, number>; cases?: [number, number][] };
  const reasons = Object.entries(ev.reasons ?? {})
    .filter(([k]) => k !== 'none')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const changed = text.trim() !== l.text;
  return (
    <div className="pilot-lesson">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="chip">{t(`platform.pilot.topic.${l.topic}`, { defaultValue: l.topic })}</span>
        <span className="small muted">
          {t('platform.pilot.evidence', { wins: n(ev.wins ?? 0), losses: n(ev.losses ?? 0), gold: n(ev.gold ?? 0), shops: n(ev.shops ?? 0) })}
        </span>
        {reasons.map(([k, v]) => (
          <span key={k} className="chip o-cancelled">
            {t(`platform.pilot.reason.${k}`, { defaultValue: k })} · {n(v)}
          </span>
        ))}
      </div>
      <textarea rows={3} maxLength={400} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'approve', ...(changed ? { text: text.trim() } : {}) })}>
          <Icon name="checkcircle" /> {t('platform.pilot.approve')}
        </button>
        {changed && (
          <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'edit', text: text.trim() })}>
            <Icon name="pencil" /> {t('platform.pilot.saveEdit')}
          </button>
        )}
        <input className="pilot-note" maxLength={300} value={note} placeholder={t('platform.pilot.whyReject')} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'reject', ...(note.trim() ? { note: note.trim() } : {}) })}>
          <Icon name="xcircle" /> {t('platform.pilot.reject')}
        </button>
        {(ev.cases ?? []).slice(0, 3).map((c, i) => (
          <button key={i} type="button" className="btn ghost small" onClick={() => onCase(c)}>
            {t('platform.pilot.seeChat', { n: i + 1 })}
          </button>
        ))}
      </div>
    </div>
  );
}

function BooksCard({ d, manager }: { d: State; manager: boolean }) {
  const { t } = useTranslation();
  const promote = usePilotAction('p.pilot.promote', { success: t('platform.saved') });
  const stop = usePilotAction('p.pilot.stop', { success: t('platform.saved') });
  const back = usePilotAction('p.pilot.rollback', { success: t('platform.saved') });
  const { books, test } = d.books;
  const champion = books.find((b) => b.status === 'champion') ?? null;
  const rep = d.night?.test && test && d.night.test.id === test.id ? d.night.test : null;
  const busy = promote.isPending || stop.isPending || back.isPending;
  return (
    <Card title={t('platform.pilot.books')} help={t('platform.pilot.booksHelp')}>
      <p>
        {champion ? t('platform.pilot.champion', { v: champion.version, lessons: n(champion.lessons), date: dateTime(champion.promotedAt ?? champion.createdAt) }) : t('platform.pilot.noBook')}
      </p>
      {test ? (
        <div className="pilot-test">
          <b>{t('platform.pilot.testRunning', { share: Math.round(test.share * 100), date: when(test.startedAt) })}</b>
          {rep ? (
            <div className="pp-use">
              <div>
                <b className="ltr">{pct(rep.A.k, rep.A.n)}</b>
                <span>{t('platform.pilot.armA', { n: n(rep.A.n) })}</span>
              </div>
              <div>
                <b className="ltr">{pct(rep.B.k, rep.B.n)}</b>
                <span>{t('platform.pilot.armB', { n: n(rep.B.n) })}</span>
              </div>
              <div className="txt">
                <b>{t(`platform.pilot.verdict.${rep.verdict}`, { defaultValue: rep.verdict })}</b>
                <span>{t('platform.pilot.verdictLabel')}</span>
              </div>
            </div>
          ) : (
            <p className="small muted">{t('platform.pilot.testWait')}</p>
          )}
          {manager && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" disabled={busy || rep?.verdict !== 'pass'} onClick={() => promote.mutate({ testId: test.id })}>
                <Icon name="trophy" /> {t('platform.pilot.keep')}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => stop.mutate({ testId: test.id })}>
                <Icon name="xcircle" /> {t('platform.pilot.stop')}
              </button>
            </div>
          )}
        </div>
      ) : (
        // a new book goes out with the two pushes (the « Push » card above); going back stays here
        manager &&
        champion &&
        books.some((b) => b.version < champion.version && (b.status === 'retired' || b.status === 'rolled_back')) && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={busy} onClick={() => back.mutate({})}>
              <Icon name="undo" /> {t('platform.pilot.rollback')}
            </button>
          </div>
        )
      )}
      {!!books.length && (
        <ul className="pp-mini">
          {books.map((b) => (
            <li key={b.id}>
              <span className="pp-two">
                <b>
                  v{b.version} · {t(`platform.pilot.bookStatus.${b.status}`, { defaultValue: b.status })}
                </b>
                <small className="muted">{t('platform.pilot.bookLine', { lessons: n(b.lessons), by: b.by ?? '—', date: dateTime(b.createdAt) })}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
