// Delivery companies (control room): for every Algerian delivery company, what Pilotix does through its API (Done) and
// what is still missing (To do), with why — so the team knows what to build or ask the company next. « Tester » calls
// every company's API from the server (made-up keys: is it up and reached?). Shops' users do all of it in Pilotix.
import type { CatalogCompany } from '@pilotix/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY } from '../../lib/backend';
import { dateTime } from '../../lib/format';
import { CourierProbe, couriersTest, prpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';

/** The catalog: from the server, or computed in the browser preview (same data, no network). */
async function loadCatalog(): Promise<CatalogCompany[]> {
  if (DEMO_ONLY) return (await import('@pilotix/core')).courierCatalog();
  return prpc('p.couriers', {}) as Promise<CatalogCompany[]>;
}

export function CouriersPage({ demo }: { demo?: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['p-couriers'], queryFn: loadCatalog });
  const [tab, setTab] = useState<'todo' | 'done'>('todo');
  const [probe, setProbe] = useState<{ at: string; results: CourierProbe[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error as Error} onRetry={() => q.refetch()} />;
  const list = q.data ?? [];
  const all = list.flatMap((c) => c.items);
  const done = all.filter((i) => i.done).length;
  const todo = all.length - done;
  const test = async () => {
    setTesting(true);
    setTestErr(null);
    try {
      setProbe(await couriersTest());
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
        <button className="btn primary" onClick={test} disabled={testing || demo || DEMO_ONLY} title={demo || DEMO_ONLY ? t('platform.co.serverOnly') : undefined}>
          <Icon name="refresh" /> {testing ? t('platform.co.testing') : t('platform.co.test')}
        </button>
      </div>
      <Kpis>
        <Kpi label={t('platform.co.companies')} value={list.length} icon="truck" />
        <Kpi label={t('platform.co.done')} value={done} icon="checkcircle" tone="ok" onClick={() => setTab('done')} active={tab === 'done'} />
        <Kpi label={t('platform.co.todo')} value={todo} icon="list" tone={todo ? 'warn' : undefined} onClick={() => setTab('todo')} active={tab === 'todo'} />
        {probe && (
          <Kpi
            label={t('platform.co.alive')}
            value={`${probe.results.filter((r) => r.ok).length} / ${probe.results.length}`}
            icon="refresh"
            tone={probe.results.every((r) => r.ok) ? 'ok' : 'bad'}
            sub={dateTime(probe.at)}
          />
        )}
      </Kpis>
      {testErr && <p className="pp-warn">{testErr}</p>}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'todo', label: t('platform.co.todo'), count: todo },
          { value: 'done', label: t('platform.co.done'), count: done },
        ]}
      />
      <div className="pp-co-grid">
        {list.map((c) => {
          const items = c.items.filter((i) => (tab === 'done' ? i.done : !i.done));
          const p = probeOf(c);
          return (
            <Card
              key={c.key}
              title={c.name}
              badge={
                p ? (
                  <span className={`pp-co-probe ${p.ok ? 'ok' : 'bad'}`} title={p.message}>
                    <Icon name={p.ok ? 'checkcircle' : 'xcircle'} /> {p.ok ? t('platform.co.up') : p.reached ? t('platform.co.odd') : t('platform.co.down')} · <span className="ltr">{p.ms} ms</span>
                  </span>
                ) : c.platform ? (
                  <span className="pp-co-plat">{t('platform.co.platform', { name: c.platform })}</span>
                ) : undefined
              }
            >
              {p && !p.ok && <p className="small pp-co-msg">{p.message}</p>}
              {items.length ? (
                <ul className="pp-co-list">
                  {items.map((i) => (
                    <li key={i.feature} className={i.done ? 'done' : 'todo'}>
                      <Icon name={i.done ? 'checkcircle' : 'xcircle'} className="pp-co-ic" />
                      <div>
                        <b>{t(`platform.co.f.${i.feature}`)}</b>
                        <span className="small muted">{i.note}</span>
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
    </div>
  );
}
