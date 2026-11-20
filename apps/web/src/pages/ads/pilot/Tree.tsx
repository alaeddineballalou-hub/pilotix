// Lancer une pub and Mes pubs › the shop's ads as Meta has them: campaigns, their ad sets, their ads (« Campagne ›
// Ensemble › Pub »), like Facebook's Ads Manager but simple.
//  - A computer (and a tablet): three tabs with a switch on every line, many lines ticked at once (on, off, delete), a
//    search, and a campaign or an ad set opened by its name (its ad sets, its ads).
//  - A phone: one level at a time, big lines, the path on top to go back.
// « Campagne vide » makes TEST, SCALE (the life ad circle's) or another one; « Ensemble » and « Pub » open « Lancer une
// pub » at that place (…/lancer/dans/<campaign>[/<ad set>]). « Supprimer » is the owner's alone, after « Vous êtes sûr ? »:
// gone from Meta for good. Every switch goes through Pilot Ads' own button (the owner's limits, the log, « Annuler »).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Out, rpc } from '../../../lib/backend';
import { useRpc } from '../../../lib/query';
import { useScope } from '../../../lib/seller';
import { useIsPhone } from '../../../lib/useMedia';
import { Empty, ErrorBox, Icon, Loading } from '../../../ui/kit';
import { Modal } from '../../../ui/modal';
import { toast } from '../../../ui/toast';
import { Switch } from '../../admin/bits';
import { adStatusLabel } from '../adStatus';
import { clientId, usd } from './Hub';

export type Tree = Out<'ads.tree.state'>;
type Camp = Tree['campaigns'][number];
type AdSet = Tree['adsets'][number];
type Ad = Tree['ads'][number];
type Level = 'campaigns' | 'adsets' | 'ads';
type Item = { id: string; name: string; on: boolean };
/** the lines shown before « Voir les N autres » (TEST and SCALE come first) */
const LIMIT = 6;
/** the goals a campaign made empty may have (« Autre campagne ») */
const GOALS = ['sales', 'messages', 'calls', 'form', 'awareness', 'traffic', 'engagement'] as const;

/** « Lancer une pub » at a place of the tree */
export const launchAt = (base: string, campaignId?: string | null, adsetId?: string | null) =>
  campaignId ? `${base}/lancer/dans/${campaignId}${adsetId ? `/${adsetId}` : ''}` : `${base}/lancer`;

export function CampaignTree({ base }: { base: string }) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const q = useRpc('ads.tree.state', {}, { refetchInterval: 120_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  return (
    <section className="card pa-tree" aria-label={t('pilotads.tree.title')}>
      {phone ? <PhoneTree tree={q.data} base={base} /> : <DeskTree tree={q.data} base={base} />}
      <p className="pa-tree-note">
        <Icon name="lock" />
        <span>{q.data.owner ? t('pilotads.tree.delNote') : t('pilotads.tree.delNoteMk')}</span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- what every view does
function useActs(tree: Tree) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const seller = useScope();
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Item[] | null>(null);
  const [made, setMade] = useState<'menu' | null>(null);
  /** on or off, one after the other (a marketer's change may wait for the owner) */
  const turn = async (items: Item[], on: boolean) => {
    const todo = items.filter((x) => x.on !== on);
    if (!todo.length) return;
    setBusy(true);
    let done = 0;
    let wait = 0;
    const bad: string[] = [];
    for (const x of todo) {
      try {
        const r = await rpc('ads.ctl.act', { objectId: x.id, op: on ? 'resume' : 'pause', clientId: clientId() }, seller);
        if (r.status === 'waiting_yes') wait++;
        else done++;
      } catch (e: any) {
        bad.push(`${x.name} : ${e?.message ?? t('common.error')}`);
      }
    }
    setBusy(false);
    await qc.invalidateQueries();
    if (done) toast(t(on ? 'pilotads.tree.done.on' : 'pilotads.tree.done.off', { count: done }), 'ok');
    if (wait) toast(t('pilotads.tree.done.wait', { count: wait }), 'info', 6000);
    if (bad.length) toast(t('pilotads.tree.done.failed', { list: bad.join(' · ') }), 'bad', 9000);
  };
  const remove = async (items: Item[]) => {
    setBusy(true);
    try {
      const r = await rpc('ads.tree.delete', { ids: items.map((x) => x.id) }, seller);
      if (r.deleted) toast(t('pilotads.tree.deleted', { count: r.deleted }), 'ok');
      if (r.failed.length) toast(t('pilotads.tree.done.failed', { list: r.failed.map((f) => `${items.find((x) => x.id === f.id)?.name ?? f.id} : ${f.why}`).join(' · ') }), 'bad', 9000);
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(false);
      setDel(null);
      await qc.invalidateQueries();
    }
  };
  return { owner: tree.owner, busy, turn, del, askDelete: setDel, remove, made, setMade };
}
type Acts = ReturnType<typeof useActs>;

function Dialogs({ a, tree, onMade }: { a: Acts; tree: Tree; onMade: (id: string) => void }) {
  const taken = useMemo(() => new Set(tree.campaigns.map((c) => c.name.trim().toLowerCase())), [tree]);
  return (
    <>
      {a.del && <DeleteAsk items={a.del} busy={a.busy} onClose={() => a.askDelete(null)} onYes={() => a.remove(a.del!)} />}
      {a.made && <NewCampaign taken={taken} onClose={() => a.setMade(null)} onMade={(id) => { a.setMade(null); onMade(id); }} />}
    </>
  );
}

function DeleteAsk({ items, busy, onClose, onYes }: { items: Item[]; busy: boolean; onClose: () => void; onYes: () => void }) {
  const { t } = useTranslation();
  const names = items.slice(0, 3).map((x) => `«\u00a0${x.name}\u00a0»`).join(', ') + (items.length > 3 ? t('pilotads.tree.delMore', { count: items.length - 3 }) : '');
  return (
    <Modal
      sheet
      title={t('pilotads.tree.delAsk')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={onYes}>
            <Icon name="trash" /> {t('pilotads.tree.delYes')}
          </button>
        </>
      }
    >
      <p>{t('pilotads.tree.delText', { list: names, count: items.length })}</p>
      <p className="pa-tree-deltip">
        <Icon name="pause" />
        <span>{t('pilotads.tree.delTip')}</span>
      </p>
    </Modal>
  );
}

/** « Campagne vide »: TEST, SCALE, or another one with its goal */
function NewCampaign({ taken, onClose, onMade }: { taken: Set<string>; onClose: () => void; onMade: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const seller = useScope();
  // a name not used yet (« TEST » made already: « TEST 2 »)
  const free = (base: string) => {
    if (!base || !taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 100; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
    return base;
  };
  const [kind, setKind] = useState<'test' | 'scale' | 'other'>('test');
  const [name, setName] = useState(() => free('TEST'));
  const [goal, setGoal] = useState<(typeof GOALS)[number]>('awareness');
  const [busy, setBusy] = useState(false);
  const [cid] = useState(clientId);
  const pick = (k: typeof kind) => {
    setKind(k);
    setName(free(k === 'test' ? 'TEST' : k === 'scale' ? 'SCALE' : ''));
  };
  const base = kind === 'test' ? 'TEST' : kind === 'scale' ? 'SCALE' : null;
  const dup = taken.has(name.trim().toLowerCase());
  const make = async () => {
    setBusy(true);
    try {
      const r = await rpc('ads.tree.campaign', { kind, name: name.trim(), goal: kind === 'other' ? goal : 'sales', clientId: cid }, seller);
      toast(t('pilotads.tree.new.made', { name: r.name }), 'ok');
      await qc.invalidateQueries();
      onMade(r.id);
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad', 7000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      sheet
      title={t('pilotads.tree.new.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !name.trim() || dup} onClick={make}>
            <Icon name="plus" /> {t('pilotads.tree.new.make')}
          </button>
        </>
      }
    >
      <p className="muted pa-tree-newsub">{t('pilotads.tree.new.sub')}</p>
      <div className="pa-tree-kinds" role="radiogroup" aria-label={t('pilotads.tree.new.title')}>
        {(['test', 'scale', 'other'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`pa-tree-kind ${kind === k ? 'on' : ''}`} onClick={() => pick(k)}>
            <span className={`pa-tree-ico k-${k}`}>
              <Icon name={k === 'test' ? 'flag' : k === 'scale' ? 'trend' : 'layers'} />
            </span>
            <b>{k === 'other' ? t('pilotads.tree.new.other') : t(`pilotads.tree.kind.${k}`)}</b>
            <small>{t(`pilotads.tree.new.${k}Sub`)}</small>
          </button>
        ))}
      </div>
      {/* TEST and SCALE are usually one campaign each, with many ad sets in them */}
      {base && taken.has(base.toLowerCase()) && <p className="pa-tree-has">{t('pilotads.tree.new.has', { name: base })}</p>}
      <label className="field pa-tree-namefield">
        <span className="lab">{t('pilotads.tree.new.name')}</span>
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-invalid={dup || undefined} />
        {dup && <small className="neg">{t('pilotads.tree.new.taken', { name: name.trim() })}</small>}
      </label>
      {kind === 'other' && (
        <label className="field">
          <span className="lab">{t('pilotads.tree.new.goal')}</span>
          <select value={goal} onChange={(e) => setGoal(e.target.value as typeof goal)}>
            {GOALS.map((g) => (
              <option key={g} value={g}>
                {t(`pilotads.goal.${g}.name`)}
              </option>
            ))}
          </select>
        </label>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- small pieces
/** the one ad account the tree shows: the one new ads go to (Comptes › « Compte pour lancer »), never another one */
function AccountLine({ tree }: { tree: Tree }) {
  const { t } = useTranslation();
  if (!tree.account) return null;
  return (
    <p className="pa-tree-acct">
      <Icon name="megaphone" />
      <span>
        {t('pilotads.tree.account')} <b><bdi>{tree.account.name || tree.account.id}</bdi></b>
      </span>
    </p>
  );
}
function More({ full, rest, onClick }: { full: boolean; rest: number; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="pa-tree-more" aria-expanded={full} onClick={onClick}>
      {full ? t('pilotads.tree.less') : t('pilotads.tree.more', { count: rest })}
      <Icon name="chevron" className={full ? 'up' : ''} />
    </button>
  );
}
function KindBadge({ c }: { c: Camp }) {
  const { t } = useTranslation();
  // « TEST » named TEST: the name says it already
  if (!c.kind || c.name.trim().toUpperCase() === c.kind.toUpperCase()) return null;
  return <span className={`badge pa-kind k-${c.kind}`}>{t(`pilotads.tree.kind.${c.kind}`)}</span>;
}
const campIcon = (c: Camp) => (c.kind === 'test' ? 'flag' : c.kind === 'scale' ? 'trend' : c.objective === 'OUTCOME_AWARENESS' ? 'eye' : c.objective === 'OUTCOME_ENGAGEMENT' ? 'message' : 'layers');
function useMoney() {
  const { t } = useTranslation();
  return {
    camp: (c: Camp) => (c.cbo ? (c.budgetUsd !== null ? t('pilotads.tree.budget.perDay', { v: usd(c.budgetUsd, 0) }) : '—') : t('pilotads.tree.budget.adsets')),
    set: (s: AdSet) => (s.budgetLevel === 'campaign' ? t('pilotads.tree.budget.campaign') : s.budgetUsd !== null ? t('pilotads.tree.budget.perDay', { v: usd(s.budgetUsd, 0) }) : '—'),
  };
}
function objectiveOf(t: (k: string) => string, c: Camp) {
  return t(`pilotads.tree.objective.${c.objective && ['OUTCOME_SALES', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC'].includes(c.objective) ? c.objective : 'other'}`);
}

// ---------------------------------------------------------------- a computer: three tabs, a table, many at once
function DeskTree({ tree, base }: { tree: Tree; base: string }) {
  const { t } = useTranslation();
  const a = useActs(tree);
  const money = useMoney();
  const [level, setLevel] = useState<Level>('campaigns');
  const [camp, setCamp] = useState<string | null>(null);
  const [set, setSet] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [full, setFull] = useState(false);
  const campById = useMemo(() => new Map(tree.campaigns.map((c) => [c.id, c])), [tree]);
  const setById = useMemo(() => new Map(tree.adsets.map((s) => [s.id, s])), [tree]);
  const has = (name: string) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());
  const camps = tree.campaigns.filter((c) => has(c.name));
  const sets = tree.adsets.filter((s) => (!camp || s.campaignId === camp) && has(s.name));
  const ads = tree.ads.filter((x) => (set ? x.adsetId === set : !camp || setById.get(x.adsetId)?.campaignId === camp) && has(x.name));
  const rows: Item[] = level === 'campaigns' ? camps : level === 'adsets' ? sets : ads;
  // a search shows every match; otherwise the first lines, the rest on « Voir les N autres »
  const cut = <T,>(xs: T[]) => (full || q.trim() ? xs : xs.slice(0, LIMIT));
  const shown = cut(rows);
  const chosen = shown.filter((r) => picked.has(r.id));
  const go = (l: Level, c: string | null = camp, s: string | null = set) => {
    setLevel(l);
    setCamp(c);
    setSet(s);
    setPicked(new Set());
    setFull(false);
  };
  const tick = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const all = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const theCamp = camp ? campById.get(camp) ?? null : null;
  const theSet = set ? setById.get(set) ?? null : null;
  const counts: Record<Level, number> = { campaigns: camps.length, adsets: sets.length, ads: ads.length };
  return (
    <div className="pa-tree-desk">
      <div className="pa-tree-head">
        <div>
          <h3 className="pa-h">{t('pilotads.tree.title')}</h3>
          <p className="muted">{t('pilotads.tree.sub')}</p>
          <AccountLine tree={tree} />
        </div>
        <input className="pa-tree-q" type="search" value={q} placeholder={t('pilotads.tree.search')} aria-label={t('pilotads.tree.search')} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pa-tree-tabs" role="tablist" aria-label={t('pilotads.tree.title')}>
        {(['campaigns', 'adsets', 'ads'] as const).map((l) => (
          <button key={l} type="button" role="tab" aria-selected={level === l} className={level === l ? 'on' : ''} onClick={() => go(l, l === 'campaigns' ? null : camp, l === 'ads' ? set : null)}>
            {t(`pilotads.tree.level.${l}`)} <span className="n ltr">{counts[l]}</span>
          </button>
        ))}
      </div>
      <div className="pa-tree-bar">
        {theCamp && level !== 'campaigns' && (
          <span className="pa-tree-filter">
            {t('pilotads.tree.filterCampaign', { name: theCamp.name })}
            <button type="button" aria-label={t('pilotads.tree.clearFilter', { name: theCamp.name })} onClick={() => go(level, null, null)}>
              <Icon name="x" />
            </button>
          </span>
        )}
        {theSet && level === 'ads' && (
          <span className="pa-tree-filter">
            {t('pilotads.tree.filterAdset', { name: theSet.name })}
            <button type="button" aria-label={t('pilotads.tree.clearFilter', { name: theSet.name })} onClick={() => go('ads', camp, null)}>
              <Icon name="x" />
            </button>
          </span>
        )}
        <div className="pa-tree-adds">
          <button type="button" className="btn small" onClick={() => a.setMade('menu')}>
            <Icon name="plus" /> {t('pilotads.tree.addCampaign')}
          </button>
          {theCamp && (
            <a className="btn small" href={launchAt(base, theCamp.id)}>
              <Icon name="plus" /> {t('pilotads.tree.addAdsetIn', { name: theCamp.name })}
            </a>
          )}
          <a className="btn small primary" href={launchAt(base, theSet?.campaignId ?? theCamp?.id ?? null, theSet?.id ?? null)}>
            <Icon name="plus" /> {t('pilotads.tree.addAd')}
          </a>
        </div>
      </div>
      {chosen.length > 0 && (
        <div className="pa-tree-bulk" role="region" aria-label={t('pilotads.tree.picked', { count: chosen.length })}>
          <b>{t('pilotads.tree.picked', { count: chosen.length })}</b>
          <div>
            <button type="button" className="btn small" disabled={a.busy} onClick={() => a.turn(chosen, true).then(() => setPicked(new Set()))}>
              {t('pilotads.tree.on')}
            </button>
            <button type="button" className="btn small" disabled={a.busy} onClick={() => a.turn(chosen, false).then(() => setPicked(new Set()))}>
              {t('pilotads.tree.off')}
            </button>
            {a.owner && (
              <button type="button" className="btn small pa-tree-del" disabled={a.busy} onClick={() => a.askDelete(chosen)}>
                <Icon name="trash" /> {t('pilotads.tree.del')}
              </button>
            )}
          </div>
        </div>
      )}
      {!rows.length ? (
        <Empty>{q.trim() ? t('pilotads.tree.emptySearch', { q: q.trim() }) : t(`pilotads.tree.empty.${level}`)}</Empty>
      ) : (
        <div className="pa-tree-box">
          <table className="pa-tree-table">
            <thead>
              <tr>
                <th className="pa-tree-cb">
                  <input type="checkbox" checked={all} aria-label={t('pilotads.tree.pickAll')} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} />
                </th>
                <th>{t('pilotads.tree.col.on')}</th>
                <th className="pa-tree-namecol">{t(`pilotads.tree.col.${level === 'campaigns' ? 'campaign' : level === 'adsets' ? 'adset' : 'ad'}`)}</th>
                <th>{t('pilotads.tree.col.state')}</th>
                {level !== 'ads' && <th>{t('pilotads.tree.col.budget')}</th>}
                <th className="num hide-md">{t(level === 'campaigns' ? 'pilotads.tree.col.adsets' : level === 'adsets' ? 'pilotads.tree.col.ads' : 'pilotads.tree.col.type')}</th>
                <th className="end">{t('pilotads.tree.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {level === 'campaigns' &&
                cut(camps).map((c) => (
                  <tr key={c.id} className={picked.has(c.id) ? 'sel' : ''}>
                    <td className="pa-tree-cb">
                      <input type="checkbox" checked={picked.has(c.id)} aria-label={t('pilotads.tree.pick', { name: c.name })} onChange={(e) => tick(c.id, e.target.checked)} />
                    </td>
                    <td>
                      <Switch checked={c.on} disabled={a.busy || !c.mine} label={c.mine ? t(c.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: c.name }) : t('pilotads.tree.notMine')} onChange={(v) => a.turn([c], v)} />
                    </td>
                    <td>
                      <button type="button" className="pa-tree-name" onClick={() => go('adsets', c.id, null)} title={t('pilotads.tree.open', { name: c.name })}>
                        <span className={`pa-tree-ico k-${c.kind ?? 'other'}`}>
                          <Icon name={campIcon(c)} />
                        </span>
                        <span className="pa-tree-tx">
                          <b>
                            {c.name} <KindBadge c={c} />
                          </b>
                          <small>{objectiveOf(t, c)}</small>
                        </span>
                      </button>
                    </td>
                    <td className="muted" title={c.allSets === 0 ? t('pilotads.tree.emptyState') : undefined}>{c.allSets === 0 ? t('pilotads.tree.emptyShort') : adStatusLabel(c.status, t)}</td>
                    <td className="ltr-num">{money.camp(c)}</td>
                    <td className="num hide-md">{c.adsets}</td>
                    <td className="end">
                      <a className="btn small" href={launchAt(base, c.id)} aria-label={t('pilotads.tree.addAdsetIn', { name: c.name })} title={t('pilotads.tree.addAdsetIn', { name: c.name })}>
                        <Icon name="plus" /> <span className="pa-tree-btxt">{t('pilotads.tree.addAdset')}</span>
                      </a>
                      {a.owner && (
                        <button type="button" className="pa-ib pa-tree-del" aria-label={t('pilotads.tree.delOne', { name: c.name })} disabled={a.busy} onClick={() => a.askDelete([c])}>
                          <Icon name="trash" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              {level === 'adsets' &&
                cut(sets).map((s) => (
                  <tr key={s.id} className={picked.has(s.id) ? 'sel' : ''}>
                    <td className="pa-tree-cb">
                      <input type="checkbox" checked={picked.has(s.id)} aria-label={t('pilotads.tree.pick', { name: s.name })} onChange={(e) => tick(s.id, e.target.checked)} />
                    </td>
                    <td>
                      <Switch checked={s.on} disabled={a.busy} label={t(s.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: s.name })} onChange={(v) => a.turn([s], v)} />
                    </td>
                    <td>
                      <button type="button" className="pa-tree-name" onClick={() => go('ads', s.campaignId, s.id)} title={t('pilotads.tree.open', { name: s.name })}>
                        <span className="pa-tree-ico k-set">
                          <Icon name="layers" />
                        </span>
                        <span className="pa-tree-tx">
                          <b>{s.name}</b>
                          <small>{[s.campaignId ? campById.get(s.campaignId)?.name : null, s.productName, s.marketerName].filter(Boolean).join(' · ')}</small>
                        </span>
                      </button>
                    </td>
                    <td className="muted" title={s.ads === 0 ? t('pilotads.tree.emptyState') : undefined}>{s.ads === 0 ? t('pilotads.tree.emptyShort') : adStatusLabel(s.status, t)}</td>
                    <td className="ltr-num">{money.set(s)}</td>
                    <td className="num hide-md">{s.ads}</td>
                    <td className="end">
                      <a className="btn small" href={launchAt(base, s.campaignId, s.id)} aria-label={t('pilotads.tree.addAdIn', { name: s.name })} title={t('pilotads.tree.addAdIn', { name: s.name })}>
                        <Icon name="plus" /> <span className="pa-tree-btxt">{t('pilotads.tree.addAd')}</span>
                      </a>
                      {a.owner && (
                        <button type="button" className="pa-ib pa-tree-del" aria-label={t('pilotads.tree.delOne', { name: s.name })} disabled={a.busy} onClick={() => a.askDelete([s])}>
                          <Icon name="trash" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              {level === 'ads' &&
                cut(ads).map((x) => {
                  const s = setById.get(x.adsetId);
                  return (
                    <tr key={x.id} className={picked.has(x.id) ? 'sel' : ''}>
                      <td className="pa-tree-cb">
                        <input type="checkbox" checked={picked.has(x.id)} aria-label={t('pilotads.tree.pick', { name: x.name })} onChange={(e) => tick(x.id, e.target.checked)} />
                      </td>
                      <td>
                        <Switch checked={x.on} disabled={a.busy} label={t(x.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: x.name })} onChange={(v) => a.turn([x], v)} />
                      </td>
                      <td>
                        <span className="pa-tree-name static">
                          <span className={`pa-tree-ico ${x.isVideo ? 'k-video' : 'k-photo'}`}>
                            <Icon name={x.isVideo ? 'play' : 'image'} />
                          </span>
                          <span className="pa-tree-tx">
                            <b>{x.name}</b>
                            <small>{[s?.campaignId ? campById.get(s.campaignId)?.name : null, s?.name].filter(Boolean).join(' › ')}</small>
                          </span>
                        </span>
                      </td>
                      <td className="muted">{adStatusLabel(x.status, t)}</td>
                      <td className="num hide-md">{t(x.isVideo ? 'pilotads.tree.video' : 'pilotads.tree.photo')}</td>
                      <td className="end">
                        {a.owner && (
                          <button type="button" className="pa-ib pa-tree-del" aria-label={t('pilotads.tree.delOne', { name: x.name })} disabled={a.busy} onClick={() => a.askDelete([x])}>
                            <Icon name="trash" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      {!q.trim() && rows.length > LIMIT && <More full={full} rest={rows.length - LIMIT} onClick={() => { setFull(!full); setPicked(new Set()); }} />}
      <Dialogs a={a} tree={tree} onMade={(id) => go('adsets', id, null)} />
    </div>
  );
}

// ---------------------------------------------------------------- a phone: one level at a time
function PhoneTree({ tree, base }: { tree: Tree; base: string }) {
  const { t } = useTranslation();
  const a = useActs(tree);
  const money = useMoney();
  const [camp, setCamp] = useState<string | null>(null);
  const [set, setSet] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const cut = <T,>(xs: T[]) => (full ? xs : xs.slice(0, LIMIT));
  // a campaign or an ad set deleted meanwhile: its level is simply not shown (the one above is)
  const c = camp ? tree.campaigns.find((x) => x.id === camp) ?? null : null;
  const s = c && set ? tree.adsets.find((x) => x.id === set && x.campaignId === c.id) ?? null : null;
  const open = (cid: string | null, sid: string | null = null) => {
    setCamp(cid);
    setSet(sid);
    setFull(false);
  };
  const sets = c ? tree.adsets.filter((x) => x.campaignId === c.id) : [];
  const ads = s ? tree.ads.filter((x) => x.adsetId === s.id) : [];
  return (
    <div className="pa-tree-phone">
      <div className="pa-tree-head">
        <div>
          <h3 className="pa-h">{t('pilotads.tree.title')}</h3>
          <p className="muted">{t('pilotads.tree.subPhone')}</p>
          <AccountLine tree={tree} />
        </div>
      </div>
      {c && (
        <div className="pa-tree-path">
          <button type="button" className="pa-ib" aria-label={t('pilotads.tree.back')} onClick={() => open(s ? c.id : null)}>
            <Icon name="chevl" />
          </button>
          <nav aria-label={t('pilotads.tree.crumbs')}>
            <button type="button" onClick={() => open(null)}>
              {t('pilotads.tree.all')}
            </button>
            <span aria-hidden="true">›</span>
            {s ? (
              <>
                <button type="button" onClick={() => open(c.id)}>
                  {c.name}
                </button>
                <span aria-hidden="true">›</span>
                <b aria-current="page">{s.name}</b>
              </>
            ) : (
              <b aria-current="page">{c.name}</b>
            )}
          </nav>
        </div>
      )}
      {!c && (
        <div className="pa-tree-list">
          {!tree.campaigns.length && <Empty>{t('pilotads.tree.empty.campaigns')}</Empty>}
          {cut(tree.campaigns).map((x) => (
            <div key={x.id} className="pa-tree-row big">
              <button type="button" className="pa-tree-name" onClick={() => open(x.id)}>
                <span className={`pa-tree-ico k-${x.kind ?? 'other'}`}>
                  <Icon name={campIcon(x)} />
                </span>
                <span className="pa-tree-tx">
                  <b>
                    {x.name} <KindBadge c={x} />
                  </b>
                  <small>{x.allSets === 0 ? t('pilotads.tree.emptyState') : x.adsets === 0 ? t('pilotads.tree.othersOnly') : t('pilotads.tree.nSets', { count: x.adsets })}</small>
                </span>
              </button>
              <Switch checked={x.on} disabled={a.busy || !x.mine} label={x.mine ? t(x.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: x.name }) : t('pilotads.tree.notMine')} onChange={(v) => a.turn([x], v)} />
              <Icon name="chevr" className="pa-tree-chev" />
            </div>
          ))}
          {tree.campaigns.length > LIMIT && <More full={full} rest={tree.campaigns.length - LIMIT} onClick={() => setFull(!full)} />}
          <button type="button" className="pa-tree-add" onClick={() => a.setMade('menu')}>
            <Icon name="plus" /> {t('pilotads.tree.addCampaign')}
            <small>{t('pilotads.tree.new.sub')}</small>
          </button>
        </div>
      )}
      {c && !s && (
        <>
          <div className="pa-tree-panel">
            <div className="pa-tree-tx">
              <b>
                {c.name} <KindBadge c={c} />
              </b>
              <small>
                {objectiveOf(t, c)} · {money.camp(c)}
              </small>
            </div>
            <Switch checked={c.on} disabled={a.busy || !c.mine} label={c.mine ? t(c.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: c.name }) : t('pilotads.tree.notMine')} onChange={(v) => a.turn([c], v)} />
            {a.owner && (
              <button type="button" className="pa-ib pa-tree-del" aria-label={t('pilotads.tree.delOne', { name: c.name })} disabled={a.busy} onClick={() => a.askDelete([c])}>
                <Icon name="trash" />
              </button>
            )}
          </div>
          <div className="pa-tree-list">
            {!sets.length && <Empty>{c.allSets > 0 ? t('pilotads.tree.othersOnly') : t('pilotads.tree.empty.adsets')}</Empty>}
            {cut(sets).map((x) => (
              <div key={x.id} className="pa-tree-row big">
                <button type="button" className="pa-tree-name" onClick={() => open(c.id, x.id)}>
                  <span className="pa-tree-ico k-set">
                    <Icon name="layers" />
                  </span>
                  <span className="pa-tree-tx">
                    <b>{x.name}</b>
                    <small>
                      {money.set(x)} · {t('pilotads.tree.nAds', { count: x.ads })}
                    </small>
                  </span>
                </button>
                <Switch checked={x.on} disabled={a.busy} label={t(x.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: x.name })} onChange={(v) => a.turn([x], v)} />
                <Icon name="chevr" className="pa-tree-chev" />
              </div>
            ))}
            {sets.length > LIMIT && <More full={full} rest={sets.length - LIMIT} onClick={() => setFull(!full)} />}
            <a className="pa-tree-add" href={launchAt(base, c.id)}>
              <Icon name="plus" /> {t('pilotads.tree.addAdsetIn', { name: c.name })}
              {(c.kind === 'test' || c.kind === 'scale') && <small>{t('pilotads.tree.circleFill')}</small>}
            </a>
          </div>
        </>
      )}
      {c && s && (
        <>
          <div className="pa-tree-panel">
            <div className="pa-tree-tx">
              <b>{s.name}</b>
              <small>{[money.set(s), s.productName].filter(Boolean).join(' · ')}</small>
            </div>
            <Switch checked={s.on} disabled={a.busy} label={t(s.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: s.name })} onChange={(v) => a.turn([s], v)} />
            {a.owner && (
              <button type="button" className="pa-ib pa-tree-del" aria-label={t('pilotads.tree.delOne', { name: s.name })} disabled={a.busy} onClick={() => a.askDelete([s])}>
                <Icon name="trash" />
              </button>
            )}
          </div>
          <div className="pa-tree-list">
            {!ads.length && <Empty>{t('pilotads.tree.empty.ads')}</Empty>}
            {cut(ads).map((x) => (
              <div key={x.id} className="pa-tree-row big">
                <span className="pa-tree-name static">
                  <span className={`pa-tree-ico ${x.isVideo ? 'k-video' : 'k-photo'}`}>
                    <Icon name={x.isVideo ? 'play' : 'image'} />
                  </span>
                  <span className="pa-tree-tx">
                    <b>{x.name}</b>
                    <small>{adStatusLabel(x.status, t)}</small>
                  </span>
                </span>
                <Switch checked={x.on} disabled={a.busy} label={t(x.on ? 'pilotads.tree.switchOff' : 'pilotads.tree.switchOn', { name: x.name })} onChange={(v) => a.turn([x], v)} />
                {a.owner && (
                  <button type="button" className="pa-ib pa-tree-del" aria-label={t('pilotads.tree.delOne', { name: x.name })} disabled={a.busy} onClick={() => a.askDelete([x])}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            ))}
            {ads.length > LIMIT && <More full={full} rest={ads.length - LIMIT} onClick={() => setFull(!full)} />}
            <a className="pa-tree-add" href={launchAt(base, c.id, s.id)}>
              <Icon name="plus" /> {t('pilotads.tree.addAdHere')}
            </a>
          </div>
        </>
      )}
      <Dialogs a={a} tree={tree} onMade={(id) => open(id)} />
    </div>
  );
}
