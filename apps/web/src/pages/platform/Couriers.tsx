// Delivery companies (control room): for every Algerian delivery company, what Pilotix does through its API (Done) and
// what is still missing (To do), with why — « Tests »: the team's own API keys of each company, to check that each
// API really works (connection, prices, offices, tracking; on demand a real test parcel created then cancelled) —
// « Changements API »: the to-do list of what changed at each company's API (found every morning by the server, or
// added by hand), each line « Non résolu » until someone marks it « Résolu » — and a company can be removed from
// Pilotix (asked twice: the shops no longer get it; those that use it keep it), then put back (« Supprimées »).
// « Tester toutes les API » calls every API from the server: with the saved keys when there are some, otherwise with
// made-up keys (is it up and reached?). Shops' users do all of it in Pilotix; their own keys are never used here.
import type { CatalogCompany, KindField } from '@pilotix/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY } from '../../lib/backend';
import { dateTime } from '../../lib/format';
import { CourierCheckResult, CourierProbe, courierCheck, courierCheckAll, couriersTest, courierWatchNow, POut, prpc, usePAction, usePRpc } from '../../lib/platform';
import { Card, Empty, ErrorBox, Field, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { Seg } from '../../ui/Sheet';
import { toast } from '../../ui/toast';

/** The catalog: from the server, or computed in the browser preview (same data, no network). */
async function loadCatalog(): Promise<CatalogCompany[]> {
  if (DEMO_ONLY) return (await import('@pilotix/core')).courierCatalog();
  return prpc('p.couriers', {}) as Promise<CatalogCompany[]>;
}

/** Items with the same note shown once (« Réclamation · Retour · … » then the reason). */
function groups(items: CatalogCompany['items']) {
  const out: { features: string[]; note: string; done: boolean }[] = [];
  for (const i of items) {
    const g = out.find((x) => x.note === i.note && x.done === i.done);
    if (g) g.features.push(i.feature);
    else out.push({ features: [i.feature], note: i.note, done: i.done });
  }
  return out;
}

type TestState = { keysSet: string[]; settings: Record<string, unknown>; updatedAt: string | null; by: string | null; last: CourierCheckResult | null };
type AdminState = POut<'p.couriers.state'>;
type WatchItem = AdminState['watch']['items'][number];
type Tab = 'todo' | 'done' | 'tests' | 'changes' | 'removed';

/** The browser preview has no server: « Changements API » shows what its lines look like. */
function demoWatch(): AdminState['watch'] {
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const line = (id: number, company: string, kind: WatchItem['kind'], title: string, detail: string, link: string | null, h: number, done = false): WatchItem => ({
    id,
    company,
    kind,
    key: `demo:${id}`,
    title,
    detail,
    link,
    at: ago(h),
    by: kind === 'manual' ? 'Pilotix' : null,
    status: done ? 'resolved' : 'open',
    resolvedAt: done ? ago(h - 2) : null,
    resolvedBy: done ? 'Pilotix' : null,
  });
  return {
    running: null,
    last: { at: ago(3), by: null, companies: 14, added: 2, notes: [] },
    items: [
      line(4, 'zr', 'docs', 'La documentation API a changé', 'Documentation API ZR Express\nAjouté (1) : « Cancel a claim: Cancels a claim that is still open »', 'https://docs.zrexpress.app/', 3),
      line(3, 'yalidine', 'code', 'Le code open-source qui suit son API a changé', 'Vargo (code open-source de 90+ sociétés) : « Yalidine: new stop desk fields » — 2 fichiers : YalidineExpressDriver.php, YalidineParcelMapper.php', 'https://github.com/KaziSTM/vargo', 3),
      line(2, 'noest', 'broken', 'Le test « Connexion » ne marche plus', 'Il marchait au test d’avant. Réponse de la société : NOEST Express (test) refuse les clés API (401).', null, 30, true),
      line(1, 'colivraison', 'manual', 'Demander la documentation API', 'Message envoyé le lundi, relancer jeudi.', null, 70),
    ],
  };
}

export function CouriersPage({ demo }: { demo?: boolean }) {
  const { t } = useTranslation();
  const server = !demo && !DEMO_ONLY;
  const q = useQuery({ queryKey: ['p-couriers'], queryFn: loadCatalog });
  const [tab, setTab] = useState<Tab>('todo');
  const [probe, setProbe] = useState<{ at: string; results: CourierProbe[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CatalogCompany | null>(null);
  // « Tester toutes les API »: the companies checked in the background, read again every 3 s until all answered
  const [waiting, setWaiting] = useState<{ since: string; companies: string[] } | null>(null);
  // « Vérifier maintenant »: the look runs on the server, the list is read again every 3 s until it ends
  const [looking, setLooking] = useState<string | null>(null);
  const tests = usePRpc('p.couriers.tests', {}, { enabled: server, refetchInterval: waiting ? 3000 : false });
  const admin = usePRpc('p.couriers.state', {}, { enabled: server, refetchInterval: (x) => (looking || x.state.data?.watch.running ? 3000 : false) });
  const state = (tests.data ?? {}) as Record<string, TestState>;
  const removed = (server ? admin.data?.removed ?? {} : {}) as Record<string, { at: string; by: string | null }>;
  const watch = server ? admin.data?.watch : demoWatch();
  useEffect(() => {
    if (!waiting) return;
    const done = waiting.companies.every((k) => (state[k]?.last?.at ?? '') >= waiting.since);
    const tooLong = Date.now() - Date.parse(waiting.since) > 180_000;
    if (done || tooLong) setWaiting(null);
  }, [tests.data, waiting]);
  useEffect(() => {
    if (!looking) return;
    const w = admin.data?.watch;
    if (w?.last && w.last.at >= looking && !w.running) {
      setLooking(null);
      toast(w.last.added ? t('platform.co.lookFound', { count: w.last.added }) : t('platform.co.lookNothing'), w.last.added ? 'info' : 'ok');
    } else if (Date.now() - Date.parse(looking) > 8 * 60_000) setLooking(null);
  }, [admin.data, looking]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error as Error} onRetry={() => q.refetch()} />;
  const every = q.data ?? [];
  // a company removed from Pilotix leaves every list but « Supprimées »
  const list = every.filter((c) => !removed[c.key]);
  const gone = every.filter((c) => removed[c.key]);
  const all = list.flatMap((c) => c.items);
  const done = all.filter((i) => i.done).length;
  const todo = all.length - done;
  const checked = list.filter((c) => state[c.key]?.last);
  const working = checked.filter((c) => state[c.key]!.last!.ok).length;
  const lines = (watch?.items ?? []).filter((i) => list.some((c) => c.key === i.company));
  const open = lines.filter((i) => i.status === 'open').length;
  const testAll = async () => {
    setTesting(true);
    setTestErr(null);
    try {
      const [p, run] = await Promise.all([couriersTest(), courierCheckAll()]);
      setProbe(p);
      if (run.companies.length) setWaiting({ since: run.startedAt, companies: run.companies });
      setTab('tests');
    } catch (e: any) {
      setTestErr(e?.message ?? 'Erreur');
    } finally {
      setTesting(false);
    }
  };
  const lookNow = async () => {
    try {
      const r = await courierWatchNow();
      if (r.running) toast(t('platform.co.lookRunning'), 'info');
      setLooking(r.startedAt ?? admin.data?.watch.running ?? new Date().toISOString());
      setTab('changes');
    } catch (e: any) {
      toast(e?.message ?? 'Erreur', 'bad');
    }
  };
  const probeOf = (c: CatalogCompany) => (c.kind ? probe?.results.find((r) => r.kind === c.kind) : undefined);
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'todo', label: t('platform.co.todo'), count: todo },
    { value: 'done', label: t('platform.co.done'), count: done },
    { value: 'tests', label: t('platform.co.tests'), count: checked.length },
    { value: 'changes', label: t('platform.co.changes'), count: open },
    ...(gone.length ? [{ value: 'removed' as Tab, label: t('platform.co.removedTab'), count: gone.length }] : []),
  ];
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.couriers')}</h1>
          <p className="muted">{t('platform.co.sub')}</p>
        </div>
        <button className="btn primary" onClick={testAll} disabled={testing || !!waiting || !server} title={!server ? t('platform.co.serverOnly') : undefined}>
          <Icon name="refresh" /> {testing || waiting ? t('platform.co.testing') : t('platform.co.test')}
        </button>
      </div>
      <Kpis>
        <Kpi label={t('platform.co.companies')} value={list.length} icon="truck" />
        <Kpi label={t('platform.co.done')} value={done} icon="checkcircle" tone="ok" onClick={() => setTab('done')} active={tab === 'done'} />
        <Kpi label={t('platform.co.todo')} value={todo} icon="list" tone={todo ? 'warn' : undefined} onClick={() => setTab('todo')} active={tab === 'todo'} />
        <Kpi
          label={t('platform.co.working')}
          value={checked.length ? `${working} / ${checked.length}` : '—'}
          icon="refresh"
          tone={checked.length ? (working === checked.length ? 'ok' : 'bad') : undefined}
          sub={checked.length ? undefined : t('platform.co.noTests')}
          onClick={() => setTab('tests')}
          active={tab === 'tests'}
        />
        <Kpi
          label={t('platform.co.changesKpi')}
          value={open}
          icon="bell"
          tone={open ? 'warn' : 'ok'}
          sub={watch?.last ? t('platform.co.lastLookShort', { at: dateTime(watch.last.at) }) : t('platform.co.neverLookedShort')}
          onClick={() => setTab('changes')}
          active={tab === 'changes'}
        />
      </Kpis>
      {testErr && <p className="pp-warn">{testErr}</p>}
      {waiting && <p className="pp-co-wait">{t('platform.co.waiting', { n: waiting.companies.length })}</p>}
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === 'tests' ? (
        <>
          <p className="small muted">{t('platform.co.testsHelp')}</p>
          <div className="pp-co-grid">
            {list.map((c) => (
              <TestCard key={c.key} c={c} st={state[c.key]} server={server} running={!!waiting?.companies.includes(c.key)} probe={probeOf(c)} />
            ))}
          </div>
        </>
      ) : tab === 'changes' ? (
        <ChangesTab list={list} lines={lines} watch={watch} server={server} looking={!!looking || !!watch?.running} onLook={lookNow} />
      ) : tab === 'removed' ? (
        <RemovedTab gone={gone} removed={removed} server={server} />
      ) : (
        <div className="pp-co-grid">
          {list.map((c) => {
            const items = c.items.filter((i) => (tab === 'done' ? i.done : !i.done));
            const p = probeOf(c);
            return (
              <Card
                key={c.key}
                title={c.name}
                badge={p ? <ProbeBadge p={p} /> : c.platform ? <span className="pp-co-plat">{t('platform.co.platform', { name: c.platform })}</span> : undefined}
                actions={
                  <button type="button" className="btn small ghost pp-co-del" title={t('platform.co.remove', { name: c.name })} aria-label={t('platform.co.remove', { name: c.name })} onClick={() => setRemoving(c)}>
                    <Icon name="trash" />
                  </button>
                }
              >
                {p && !p.ok && <p className="small pp-co-msg">{p.message}</p>}
                {items.length ? (
                  <ul className="pp-co-list">
                    {groups(items).map((g) => (
                      <li key={g.features.join()} className={g.done ? 'done' : 'todo'}>
                        <Icon name={g.done ? 'checkcircle' : 'xcircle'} className="pp-co-ic" />
                        <div>
                          <b>{g.features.map((f) => t(`platform.co.f.${f}`)).join(' · ')}</b>
                          <span className="small muted">{g.note}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">{tab === 'done' ? t('platform.co.noneDone') : t('platform.co.allDone')}</p>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {removing && <RemoveModal c={removing} server={server} onClose={() => setRemoving(null)} onDone={() => (setRemoving(null), setTab('removed'))} />}
    </div>
  );
}

/** Removing a company, asked twice: « Êtes-vous sûr ? », then its word typed (SUPPRIMER). */
function RemoveModal({ c, server, onClose, onDone }: { c: CatalogCompany; server: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const word = t('platform.co.removeWord');
  const [typed, setTyped] = useState('');
  const usage = usePRpc('p.couriers.usage', { company: c.key }, { enabled: server });
  const rm = usePAction('p.couriers.remove', { success: t('platform.co.removedOk', { name: c.name }), onDone });
  const sure = typed.trim().toLocaleLowerCase() === word.toLocaleLowerCase();
  const stores = usage.data?.stores;
  return (
    <Modal
      sheet
      title={t('platform.co.removeTitle', { name: c.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn pp-danger" disabled={!server || !sure || rm.isPending} title={!server ? t('platform.co.serverOnly') : undefined} onClick={() => rm.mutate({ company: c.key, confirm: true })}>
            <Icon name="trash" /> {t('platform.co.removeGo')}
          </button>
        </>
      }
    >
      <p className="pp-co-sure">
        <Icon name="trash" /> {t('platform.co.removeSure', { name: c.name })}
      </p>
      <ul className="pp-co-what">
        <li>{t('platform.co.removeNoNew')}</li>
        <li>{!server || stores === undefined ? t('platform.co.removeUsedAny') : stores ? t('platform.co.removeUsed', { count: stores }) : t('platform.co.removeUnused')}</li>
        <li>{t('platform.co.removeBack')}</li>
      </ul>
      <Field label={t('platform.co.removeType', { word })}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={word} autoComplete="off" autoFocus />
      </Field>
    </Modal>
  );
}

/** The companies removed from Pilotix, each one with « Restaurer ». */
function RemovedTab({ gone, removed, server }: { gone: CatalogCompany[]; removed: Record<string, { at: string; by: string | null }>; server: boolean }) {
  const { t } = useTranslation();
  const restore = usePAction('p.couriers.restore', { success: t('platform.co.restored') });
  return (
    <>
      <p className="small muted">{t('platform.co.removedHelp')}</p>
      <div className="pp-co-grid">
        {gone.map((c) => (
          <Card
            key={c.key}
            title={c.name}
            badge={
              <span className="pp-co-probe bad">
                <Icon name="trash" /> {t('platform.co.removedBadge')}
              </span>
            }
          >
            <p className="small muted">{t('platform.co.removedOn', { at: dateTime(removed[c.key]?.at), by: removed[c.key]?.by || '—' })}</p>
            <button className="btn small primary" disabled={!server || restore.isPending} onClick={() => restore.mutate({ company: c.key })}>
              <Icon name="history" /> {t('platform.co.restore')}
            </button>
          </Card>
        ))}
      </div>
    </>
  );
}

const KIND_ICON: Record<string, string> = { docs: 'clipboard', code: 'puzzle', gone: 'ban', broken: 'xcircle', fields: 'columns', manual: 'user' };

/** « Changements API »: what changed at each company's API, « Non résolu » until someone marks it « Résolu ». */
function ChangesTab({ list, lines, watch, server, looking, onLook }: { list: CatalogCompany[]; lines: WatchItem[]; watch: AdminState['watch'] | undefined; server: boolean; looking: boolean; onLook: () => void }) {
  const { t } = useTranslation();
  const [show, setShow] = useState<'open' | 'resolved' | 'all'>('open');
  const [adding, setAdding] = useState(false);
  const names = new Map(list.map((c) => [c.key, c.name]));
  const open = lines.filter((i) => i.status === 'open');
  const solved = lines.filter((i) => i.status === 'resolved');
  const shown = show === 'open' ? open : show === 'resolved' ? solved : lines;
  const last = watch?.last;
  return (
    <>
      <div className="pp-co-watchhead">
        <p className="small muted">{t('platform.co.watchHelp')}</p>
        <div className="pp-co-acts">
          <button className="btn small primary" disabled={!server || looking} onClick={onLook} title={!server ? t('platform.co.serverOnly') : undefined}>
            <Icon name="refresh" /> {looking ? t('platform.co.looking') : t('platform.co.lookNow')}
          </button>
          <button className="btn small" disabled={!server} onClick={() => setAdding(true)} title={!server ? t('platform.co.serverOnly') : undefined}>
            <Icon name="plus" /> {t('platform.co.todoAdd')}
          </button>
        </div>
      </div>
      {!server && <p className="pp-co-wait">{t('platform.co.watchDemo')}</p>}
      {looking && <p className="pp-co-wait">{t('platform.co.lookingLong')}</p>}
      <p className="small muted pp-co-when">
        {last
          ? `${t(last.by ? 'platform.co.lastLookBy' : 'platform.co.lastLookAuto', { at: dateTime(last.at), by: last.by, n: last.companies })} ${last.added ? t('platform.co.lastLookAdded', { count: last.added }) : t('platform.co.lastLookNothing')}`
          : t('platform.co.neverLooked')}
      </p>
      {last?.notes?.length ? (
        <details className="pp-co-notes">
          <summary className="small muted">{t('platform.co.notes', { count: last.notes.length })}</summary>
          <ul className="small muted">
            {last.notes.map((n, k) => (
              <li key={k}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <Seg
        label={t('platform.co.changes')}
        value={show}
        onChange={setShow}
        items={[
          { k: 'open', label: `${t('platform.co.unresolvedMany')} · ${open.length}` },
          { k: 'resolved', label: `${t('platform.co.resolvedMany')} · ${solved.length}` },
          { k: 'all', label: `${t('common.all')} · ${lines.length}` },
        ]}
      />
      {shown.length ? (
        <ul className="pp-co-todo">
          {shown.map((i) => (
            <WatchLine key={i.id} i={i} name={names.get(i.company) ?? i.company} server={server} />
          ))}
        </ul>
      ) : (
        <Empty>{show === 'open' ? t('platform.co.todoEmpty') : t('platform.co.todoNone')}</Empty>
      )}
      {adding && <AddTodoModal list={list} onClose={() => setAdding(false)} />}
    </>
  );
}

function WatchLine({ i, name, server }: { i: WatchItem; name: string; server: boolean }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState(false);
  const set = usePAction('p.couriers.todo.set', { success: (r) => (r.status === 'resolved' ? t('platform.co.resolvedOk') : t('platform.co.unresolvedOk')) });
  const rm = usePAction('p.couriers.todo.remove', { success: t('platform.co.todoRemoved') });
  const isOpen = i.status === 'open';
  return (
    <li className={`pp-co-line ${isOpen ? 'open' : 'resolved'}`}>
      <span className={`pp-co-kind k-${i.kind}`}>
        <Icon name={KIND_ICON[i.kind] ?? 'info'} />
      </span>
      <div className="pp-co-body">
        <div className="pp-co-top">
          <b>{name}</b>
          <span className="pp-co-tag">{t(`platform.co.kind.${i.kind}`)}</span>
          <span className={`pp-co-state ${isOpen ? 'open' : 'resolved'}`}>{isOpen ? t('platform.co.unresolved') : t('platform.co.resolved')}</span>
          <small className="muted">{dateTime(i.at)}</small>
        </div>
        <div className="pp-co-title">{i.title}</div>
        {i.detail && <div className="small muted pp-co-detail">{i.detail}</div>}
        <div className="pp-co-foot">
          {i.link && (
            <a className="btn small ghost" href={i.link} target="_blank" rel="noreferrer">
              <Icon name="external" /> {t('platform.co.openLink')}
            </a>
          )}
          {isOpen ? (
            <button className="btn small primary" disabled={!server || set.isPending} onClick={() => set.mutate({ id: i.id, status: 'resolved' })}>
              <Icon name="checkcircle" /> {t('platform.co.resolve')}
            </button>
          ) : (
            <>
              <span className="small muted pp-co-res">{t('platform.co.resolvedBy', { by: i.resolvedBy || '—', at: dateTime(i.resolvedAt) })}</span>
              <button className="btn small ghost" disabled={!server || set.isPending} onClick={() => set.mutate({ id: i.id, status: 'open' })}>
                {t('platform.co.unresolve')}
              </button>
            </>
          )}
          {i.kind === 'manual' &&
            (ask ? (
              <button className="btn small pp-danger" disabled={!server || rm.isPending} onClick={() => rm.mutate({ id: i.id })}>
                <Icon name="trash" /> {t('platform.co.todoRemoveSure')}
              </button>
            ) : (
              <button className="btn small ghost pp-co-del" disabled={!server} title={t('platform.co.todoRemove')} aria-label={t('platform.co.todoRemove')} onClick={() => setAsk(true)}>
                <Icon name="trash" />
              </button>
            ))}
        </div>
      </div>
    </li>
  );
}

/** A line added by hand: a call to make, a question asked to a company… */
function AddTodoModal({ list, onClose }: { list: CatalogCompany[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [company, setCompany] = useState(list[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const add = usePAction('p.couriers.todo.add', { success: t('platform.co.todoAdded'), onDone: onClose });
  return (
    <Modal
      sheet
      title={t('platform.co.todoAddTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!company || title.trim().length < 2 || add.isPending} onClick={() => add.mutate({ company, title: title.trim(), detail: detail.trim() })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="pp-co-form">
        <Field label={t('platform.co.todoCompany')}>
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            {list.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('platform.co.todoTitle')}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={t('platform.co.todoTitlePh')} autoFocus />
        </Field>
        <Field label={t('platform.co.todoDetail')}>
          <textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1500} />
        </Field>
      </div>
    </Modal>
  );
}

function ProbeBadge({ p }: { p: CourierProbe }) {
  const { t } = useTranslation();
  return (
    <span className={`pp-co-probe ${p.ok ? 'ok' : 'bad'}`} title={p.message}>
      <Icon name={p.ok ? 'checkcircle' : 'xcircle'} /> {p.ok ? t('platform.co.up') : p.reached ? t('platform.co.odd') : t('platform.co.down')} · <span className="ltr">{p.ms} ms</span>
    </span>
  );
}

/** One company in « Tests »: its saved test keys, « Tester », « Test complet » (a real parcel), and the last result. */
function TestCard({ c, st, server, running, probe }: { c: CatalogCompany; st: TestState | undefined; server: boolean; running: boolean; probe?: CourierProbe }) {
  const { t } = useTranslation();
  const [keysOpen, setKeysOpen] = useState(false);
  const [busy, setBusy] = useState<false | 'quick' | 'deep'>(false);
  const [askDeep, setAskDeep] = useState(false);
  const [last, setLast] = useState<CourierCheckResult | null>(null);
  const result = last && (!st?.last || last.at >= st.last.at) ? last : st?.last ?? null;
  const hasKeys = !!st?.keysSet.length;
  const run = async (deep: boolean) => {
    setBusy(deep ? 'deep' : 'quick');
    setAskDeep(false);
    try {
      const r = await courierCheck(c.key, deep);
      setLast(r);
      toast(r.ok ? t('platform.co.checkOk', { name: c.name }) : t('platform.co.checkBad', { name: c.name }), r.ok ? 'ok' : 'bad');
    } catch (e: any) {
      toast(e?.message ?? 'Erreur', 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (!c.kind)
    return (
      <Card title={c.name}>
        <p className="small muted">{c.items[0]?.note}</p>
      </Card>
    );
  const status = result ? (result.ok ? 'ok' : 'bad') : null;
  // the full test cancels its parcel right after: impossible without a cancel through the API (it would stay there)
  const noDeep = c.kind === 'near' ? 'noDeepNear' : !c.items.find((i) => i.feature === 'cancel')?.done ? 'noDeep' : null;
  return (
    <Card
      title={c.name}
      badge={
        status ? (
          <span className={`pp-co-probe ${status}`}>
            <Icon name={status === 'ok' ? 'checkcircle' : 'xcircle'} /> {status === 'ok' ? t('platform.co.works') : t('platform.co.broken')}
          </span>
        ) : probe ? (
          <ProbeBadge p={probe} />
        ) : c.platform ? (
          <span className="pp-co-plat">{t('platform.co.platform', { name: c.platform })}</span>
        ) : undefined
      }
    >
      <div className="pp-co-keys">
        <span className={`badge ${hasKeys ? 't-ok' : 't-off'}`}>{hasKeys ? t('platform.co.keysSet') : t('platform.co.keysNone')}</span>
        {st?.updatedAt && <small className="muted">{dateTime(st.updatedAt)}</small>}
      </div>
      <div className="pp-co-acts">
        <button className="btn small" disabled={!server} onClick={() => setKeysOpen(true)}>
          <Icon name="lock" /> {t('platform.co.keys')}
        </button>
        <button className="btn small primary" disabled={!server || !hasKeys || !!busy || running} onClick={() => run(false)}>
          <Icon name="refresh" /> {busy === 'quick' || running ? t('platform.co.checking') : t('platform.co.check')}
        </button>
        {!noDeep && (
          <button className="btn small" disabled={!server || !hasKeys || !!busy || running} onClick={() => setAskDeep(true)}>
            <Icon name="package" /> {busy === 'deep' ? t('platform.co.checking') : t('platform.co.deep')}
          </button>
        )}
      </div>
      {noDeep && <p className="small muted">{t(`platform.co.${noDeep}`)}</p>}
      {askDeep && (
        <div className="pp-co-deep">
          <p className="small">{t('platform.co.deepWarn', { name: c.name })}</p>
          <div className="pp-co-acts">
            <button className="btn small primary" onClick={() => run(true)}>
              {t('platform.co.deepGo')}
            </button>
            <button className="btn small ghost" onClick={() => setAskDeep(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {result ? (
        <>
          <p className="small muted pp-co-when">
            {t(result.deep ? 'platform.co.lastDeep' : 'platform.co.last', { at: dateTime(result.at) })}
          </p>
          <ul className="pp-co-list">
            {result.steps.map((s) => (
              <li key={s.step} className={s.ok === null ? 'skip' : s.ok ? 'done' : 'bad'}>
                <Icon name={s.ok === false ? 'xcircle' : 'checkcircle'} className="pp-co-ic" />
                <div>
                  <b>
                    {t(`platform.co.step.${s.step}`, { defaultValue: s.step })}
                    {s.ok !== null && <small className="muted ltr"> · {(s.ms / 1000).toFixed(1)} s</small>}
                  </b>
                  <span className="small muted">{s.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="small muted">{hasKeys ? t('platform.co.notTested') : t('platform.co.addKeys')}</p>
      )}
      {keysOpen && <KeysModal c={c} st={st} onClose={() => setKeysOpen(false)} />}
    </Card>
  );
}

/** The company's API keys for the tests: secret ones are never shown back (an empty box keeps the saved key). */
function KeysModal({ c, st, onClose }: { c: CatalogCompany; st: TestState | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const set = new Set(st?.keysSet ?? []);
  const initial = (f: KindField): string | boolean => {
    const v = st?.settings?.[f.key] ?? c.presets[f.key] ?? f.default;
    return f.type === 'check' ? v === true || v === 'true' : String(v ?? '');
  };
  const [vals, setVals] = useState<Record<string, string | boolean>>(() => Object.fromEntries(c.fields.filter((f) => f.type !== 'secret').map((f) => [f.key, initial(f)])));
  const [secret, setSecret] = useState<Record<string, string>>({});
  const save = usePAction('p.couriers.saveKeys', { success: t('platform.co.keysSaved'), onDone: onClose });
  const clear = usePAction('p.couriers.clearKeys', { success: t('platform.co.keysCleared'), onDone: onClose });
  return (
    <Modal
      sheet
      title={t('platform.co.keysTitle', { name: c.name })}
      onClose={onClose}
      footer={
        <>
          {set.size > 0 && (
            <button className="btn ghost" disabled={clear.isPending} onClick={() => clear.mutate({ company: c.key })}>
              {t('platform.co.keysClear')}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ company: c.key, secret, settings: vals })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <p className="small muted">{t('platform.co.keysHelp')}</p>
      <div className="pp-co-form">
        {c.fields.map((f) =>
          f.type === 'secret' ? (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                type="password"
                dir="ltr"
                autoComplete="off"
                value={secret[f.key] ?? ''}
                placeholder={set.has(f.key) ? t('platform.co.keyKept') : ''}
                onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })}
              />
            </Field>
          ) : f.type === 'check' ? (
            <label key={f.key} className="pp-co-check">
              <input type="checkbox" checked={!!vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.checked })} />
              <span>{f.label}</span>
            </label>
          ) : (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input dir="ltr" value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            </Field>
          ),
        )}
      </div>
    </Modal>
  );
}
