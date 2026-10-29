// Delivery companies (control room): for every Algerian delivery company, what Pilotix does through its API (Done) and
// what is still missing (To do), with why — and « Tests »: the team's own API keys of each company, to check that each
// API really works (connection, prices, offices, tracking; on demand a real test parcel created then cancelled).
// « Tester toutes les API » calls every API from the server: with the saved keys when there are some, otherwise with
// made-up keys (is it up and reached?). Shops' users do all of it in Pilotix; their own keys are never used here.
import type { CatalogCompany, KindField } from '@pilotix/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY } from '../../lib/backend';
import { dateTime } from '../../lib/format';
import { CourierCheckResult, CourierProbe, courierCheck, courierCheckAll, couriersTest, prpc, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Field, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import { Modal } from '../../ui/modal';
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

export function CouriersPage({ demo }: { demo?: boolean }) {
  const { t } = useTranslation();
  const server = !demo && !DEMO_ONLY;
  const q = useQuery({ queryKey: ['p-couriers'], queryFn: loadCatalog });
  const [tab, setTab] = useState<'todo' | 'done' | 'tests'>('todo');
  const [probe, setProbe] = useState<{ at: string; results: CourierProbe[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  // « Tester toutes les API »: the companies checked in the background, read again every 3 s until all answered
  const [waiting, setWaiting] = useState<{ since: string; companies: string[] } | null>(null);
  const tests = usePRpc('p.couriers.tests', {}, { enabled: server, refetchInterval: waiting ? 3000 : false });
  const state = (tests.data ?? {}) as Record<string, TestState>;
  useEffect(() => {
    if (!waiting) return;
    const done = waiting.companies.every((k) => (state[k]?.last?.at ?? '') >= waiting.since);
    const tooLong = Date.now() - Date.parse(waiting.since) > 180_000;
    if (done || tooLong) setWaiting(null);
  }, [tests.data, waiting]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error as Error} onRetry={() => q.refetch()} />;
  const list = q.data ?? [];
  const all = list.flatMap((c) => c.items);
  const done = all.filter((i) => i.done).length;
  const todo = all.length - done;
  const checked = list.filter((c) => state[c.key]?.last);
  const working = checked.filter((c) => state[c.key]!.last!.ok).length;
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
  const probeOf = (c: CatalogCompany) => (c.kind ? probe?.results.find((r) => r.kind === c.kind) : undefined);
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
      </Kpis>
      {testErr && <p className="pp-warn">{testErr}</p>}
      {waiting && <p className="pp-co-wait">{t('platform.co.waiting', { n: waiting.companies.length })}</p>}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'todo', label: t('platform.co.todo'), count: todo },
          { value: 'done', label: t('platform.co.done'), count: done },
          { value: 'tests', label: t('platform.co.tests'), count: checked.length },
        ]}
      />
      {tab === 'tests' ? (
        <>
          <p className="small muted">{t('platform.co.testsHelp')}</p>
          <div className="pp-co-grid">
            {list.map((c) => (
              <TestCard key={c.key} c={c} st={state[c.key]} server={server} running={!!waiting?.companies.includes(c.key)} probe={probeOf(c)} />
            ))}
          </div>
        </>
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
    </div>
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
