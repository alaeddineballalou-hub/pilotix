// Pilot AI › Spy AI (control room): Pilotix's own AI Spy search key. Shops never bring one: they pick « Recherche
// Pilotix » (or the free Chrome extension) in AI Spy › Réglages. The main tool searches Facebook's Ad Library in Algeria;
// the other tool, when it has a key too, takes over when the main one fails. Each shop may make `perShopDay` searches a
// day (1 search = 1 keyword, the morning scan included). The keys are pasted here only, and never shown again.
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n } from '../../lib/format';
import type { POut } from '../../lib/platform';
import { Card, Field, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { usePilotAction, usePilotCall, usePilotRpc } from './pilotDemo';

const TOOLS = ['scrapecreators', 'searchapi'] as const;
type Tool = (typeof TOOLS)[number];
type Keys = Record<Tool, string>;
const NO_KEYS: Keys = { scrapecreators: '', searchapi: '' };
const SITE: Record<Tool, string> = { scrapecreators: 'https://scrapecreators.com', searchapi: 'https://www.searchapi.io' };
type Test = POut<'p.spy.keyTest'>;

export function SpyKeyCard({ manager }: { manager: boolean }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.spyKey.';
  const q = usePilotRpc('p.spy.key', {});
  const d = q.data;
  const [on, setOn] = useState(false);
  const [main, setMain] = useState<Tool>('scrapecreators');
  const [per, setPer] = useState('20');
  const [keys, setKeys] = useState<Keys>(NO_KEYS);
  useEffect(() => {
    if (!d) return;
    setOn(d.enabled);
    setMain(d.main);
    setPer(String(d.perShopDay));
  }, [d?.enabled, d?.main, d?.perShopDay]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = usePilotAction('p.spy.keySave', { success: t('platform.saved'), onDone: () => setKeys(NO_KEYS) });
  const perShopDay = Math.min(500, Math.max(1, Math.round(Number(per) || 20)));
  /** typed keys go with the save; a key not typed is kept; null removes it */
  const send = (extra: Partial<Record<Tool, string | null>> = {}) => {
    const typed: Partial<Record<Tool, string | null>> = {};
    for (const tool of TOOLS) if (keys[tool].trim()) typed[tool] = keys[tool].trim();
    save.mutate({ enabled: on, main, perShopDay, keys: { ...typed, ...extra } });
  };
  const remove = (tool: Tool) => window.confirm(t(k + 'removeAsk', { name: t(k + `tools.${tool}.name`) })) && send({ [tool]: null });
  const dirty = !!d && (on !== d.enabled || main !== d.main || perShopDay !== d.perShopDay || !!keys.scrapecreators.trim() || !!keys.searchapi.trim());
  const ready = !!d && d.enabled && (d.keys.scrapecreators || d.keys.searchapi);
  const backup: Tool = main === 'scrapecreators' ? 'searchapi' : 'scrapecreators';
  return (
    <Card
      title={t(k + 'title')}
      className="pk-card"
      badge={d && <span className={`chip ${ready ? 'pp-chip-ok' : 'pp-chip-warn'}`}>{ready ? t('platform.pilot.on') : t('platform.pilot.off')}</span>}
    >
      <p className="small muted pk-text">{t(k + 'text')}</p>
      {!d ? (
        <p className="muted small">{q.error?.message ?? '…'}</p>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" disabled={!manager} checked={on} onChange={(e) => setOn(e.target.checked)} /> {t(k + 'enable')}
          </label>
          <div className="pk-tools" role="radiogroup" aria-label={t(k + 'main')}>
            {TOOLS.map((tool) => (
              <ToolBox
                key={tool}
                tool={tool}
                main={main === tool}
                stored={d.keys[tool]}
                value={keys[tool]}
                manager={manager}
                onMain={() => setMain(tool)}
                onChange={(v) => setKeys((x) => ({ ...x, [tool]: v }))}
                onRemove={() => remove(tool)}
              />
            ))}
          </div>
          {on && !d.keys.scrapecreators && !d.keys.searchapi && <p className="warnbox small">{t(k + 'noKey')}</p>}
          {on && !d.keys[main] && d.keys[backup] && <p className="warnbox small">{t(k + 'mainMissing', { name: t(k + `tools.${backup}.name`) })}</p>}
          {!on && <p className="small muted">{t(k + 'offNote')}</p>}
          <div className="pk-foot">
            <Field label={t(k + 'perShopDay')} hint={t(k + 'perShopDayHint')}>
              <input type="number" inputMode="numeric" className="ltr" min={1} max={500} step={1} disabled={!manager} value={per} onChange={(e) => setPer(e.target.value)} />
            </Field>
            <p className="pk-today" role="status">
              <Icon name="search" /> {t(k + 'today', { count: d.today.searches, n: n(d.today.searches), shops: n(d.today.shops) })}
            </p>
          </div>
          {manager && (
            <div className="row pk-actions">
              <button type="button" className="btn primary" disabled={save.isPending || !dirty} onClick={() => send()}>
                <Icon name="check" /> {t('common.save')}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** One tool: main or backup, its key (typed here, never shown), « Tester » on the saved key, « Retirer la clé ». */
function ToolBox({ tool, main, stored, value, manager, onMain, onChange, onRemove }: { tool: Tool; main: boolean; stored: boolean; value: string; manager: boolean; onMain: () => void; onChange: (v: string) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.spyKey.';
  const id = useId();
  const call = usePilotCall();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Test | null>(null);
  const name = t(k + `tools.${tool}.name`);
  const test = async () => {
    setBusy(true);
    setRes(null);
    try {
      setRes(await call('p.spy.keyTest', { tool, query: 'poussette' }));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`pk-tool ${main ? 'on' : ''}`}>
      <label className="pk-tool-h">
        <input type="radio" name="pk-main" checked={main} disabled={!manager} onChange={onMain} />
        <span className="pk-tool-name">
          <b>{name}</b>
          <span className={`chip ${main ? 'pk-chip-main' : ''}`}>{main ? t(k + 'mainBadge') : t(k + 'backupBadge')}</span>
        </span>
        <span className="pk-price">{t(k + `tools.${tool}.price`)}</span>
      </label>
      <p className="small muted">{t(k + `tools.${tool}.desc`)}</p>
      <div className="field">
        <label className="lab" htmlFor={id}>
          {t(k + 'key', { name })}
        </label>
        <div className="pk-keyrow">
          <input id={id} className="ltr" type="password" autoComplete="off" spellCheck={false} disabled={!manager} value={value} placeholder={stored ? '••••••••' : t(k + 'keyPh', { name })} onChange={(e) => onChange(e.target.value)} />
          <button type="button" className="btn small" disabled={!manager || busy || !stored} title={stored ? undefined : t(k + 'testNeedsKey')} onClick={test}>
            {busy ? t(k + 'testing') : t(k + 'test')}
          </button>
        </div>
        <span className="hint">
          {stored ? (
            t(k + 'keySaved')
          ) : (
            <>
              {t(k + 'keyNone')}{' '}
              <a href={SITE[tool]} target="_blank" rel="noopener noreferrer" className="ltr">
                {SITE[tool].replace(/^https:\/\/(www\.)?/, '')}
              </a>
            </>
          )}
        </span>
      </div>
      {stored && manager && (
        <button type="button" className="pk-link" onClick={onRemove}>
          {t('platform.pilot.keyRemove')}
        </button>
      )}
      {res && <TestResult r={res} />}
    </div>
  );
}

function TestResult({ r }: { r: Test }) {
  const { t } = useTranslation();
  const k = 'platform.pilot.spyKey.';
  if (r.message)
    return (
      <div className="pk-test" role="status">
        {r.message}
      </div>
    );
  return (
    <div className={`pk-test ${r.ok ? 'ok' : 'bad'}`} role="status">
      <b>{r.ok ? t(k + 'testOk', { n: n(r.count) }) : t(k + 'testNone')}</b>
      {r.sample.length > 0 && (
        <ul>
          {r.sample.map((s, i) => (
            <li key={i}>
              <b dir="auto">{s.page}</b> · <span dir="auto">{s.text || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
