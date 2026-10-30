// Management › Affectation automatique: who gets a new order (Confirmation) and a new alert (Suivi), without anyone
// choosing — the way (Manuel, Tour de rôle, Moins chargé), the rules, and each agent's own settings (in or out of the
// split, ×2, his hours, his channels and products). « Répartir maintenant » gives what is waiting at once.
import { CONF_STATUSES, SALES_CHANNELS } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import '../livraison/prefs.css';
import './affectation.css';

type Data = Out<'assign.get'>;
type Cfg = Data['cfg'];
type AreaCfg = Cfg['conf'];
type AgentCfg = Cfg['agents'][string];
type Tab = 'conf' | 'follow' | 'agents';
const MODES: AreaCfg['mode'][] = ['manual', 'turn', 'load'];
const MODE_ICON: Record<string, string> = { manual: 'pencil', turn: 'refresh', load: 'sliders', smart: 'sparkles' };
const AGENT0: AgentCfg = { out: false, weight: 1, channels: [], products: [], from: null, to: null, langs: [], senior: false };

export function Affectation() {
  const { t } = useTranslation();
  const q = useRpc('assign.get', {}, { refetchInterval: 30_000 });
  const products = (useRpc('catalog.search', { limit: 100 }).data ?? []).map((p) => ({ id: p.id, name: p.name }));
  const [tab, setTab] = useState<Tab>('conf');
  const [draft, setDraft] = useState<Cfg | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const save = useAction('assign.set', { success: t('admin.aa.saved'), onDone: () => setDraft(null) });
  const run = useAction('assign.run', { success: (r) => t('admin.aa.ran', { n: r.conf.assigned + r.follow.assigned, b: r.conf.back + r.follow.back }) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const v = draft ?? d.cfg;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(d.cfg);
  const setArea = (k: 'conf' | 'follow', p: Partial<AreaCfg>) => setDraft({ ...v, [k]: { ...v[k], ...p } });
  const agentOf = (id: number): AgentCfg => ({ ...AGENT0, ...(v.agents[String(id)] ?? {}) });
  const setAgent = (id: number, p: Partial<AgentCfg>) => setDraft({ ...v, agents: { ...v.agents, [String(id)]: { ...agentOf(id), ...p } } });
  // the line of the turns: the manager's order, then the others
  const people = [...new Map([...d.conf, ...d.follow].map((x) => [x.id, x])).values()];
  const ordered = [...people].sort((a, b) => {
    const ia = v.order.indexOf(a.id);
    const ib = v.order.indexOf(b.id);
    return (ia < 0 ? 1e6 + a.id : ia) - (ib < 0 ? 1e6 + b.id : ib);
  });
  const move = (id: number, dir: -1 | 1) => {
    const ids = ordered.map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setDraft({ ...v, order: ids });
  };

  const Area = ({ k }: { k: 'conf' | 'follow' }) => {
    const a = v[k];
    const list = k === 'conf' ? d.conf : d.follow;
    const on = list.filter((x) => x.online && !agentOf(x.id).out);
    return (
      <>
        <section className="pf-group">
          <h3>{t('admin.aa.how')}</h3>
          <div className="aa-modes" role="radiogroup" aria-label={t('admin.aa.how')}>
            {MODES.map((m) => (
              <label key={m} className={`aa-mode ${a.mode === m ? 'on' : ''}`}>
                <input type="radio" name={`aa-${k}`} checked={a.mode === m} onChange={() => setArea(k, { mode: m })} />
                <Icon name={MODE_ICON[m]} />
                <b>{t(`admin.aa.mode.${m}`)}</b>
                <small>{t(`admin.aa.modeHint.${m}`)}</small>
              </label>
            ))}
          </div>
          {a.mode === 'turn' && (
            <div className="pf-row pf-col">
              <span className="pf-text">
                <b>{t('admin.aa.by')}</b>
                <small>{t('admin.aa.byHint')}</small>
              </span>
              <div className="pf-chips">
                {(['all', 'channel', 'product'] as const).map((b) => (
                  <label key={b} className={`pf-chip ${a.by === b ? 'on' : ''}`}>
                    <input type="radio" name={`aa-by-${k}`} checked={a.by === b} onChange={() => setArea(k, { by: b })} />
                    <Icon name="checkcircle" />
                    {t(`admin.aa.byOpt.${b}`)}
                  </label>
                ))}
              </div>
            </div>
          )}
          {a.mode === 'load' && k === 'conf' && (
            <div className="pf-row pf-col">
              <span className="pf-text">
                <b>{t('admin.aa.excluded')}</b>
                <small>{t('admin.aa.excludedHint')}</small>
              </span>
              <div className="pf-chips pf-chips-s">
                {CONF_STATUSES.map((s) => (
                  <label key={s} className={`pf-chip ${a.excluded.includes(s) ? 'on' : ''}`}>
                    <input type="checkbox" checked={a.excluded.includes(s)} onChange={() => setArea(k, { excluded: a.excluded.includes(s) ? a.excluded.filter((x) => x !== s) : [...a.excluded, s] })} />
                    <Icon name="checkcircle" />
                    {t(`status.conf.${s}`)}
                  </label>
                ))}
              </div>
            </div>
          )}
        </section>

        {a.mode !== 'manual' && (
          <section className="pf-group">
            <h3>{t('admin.aa.rules')}</h3>
            {(['sameClient', 'respectAccess', 'speedFirst', 'hideHistory'] as const).map((r) => (
              <label key={r} className="pf-row">
                <span className="pf-text">
                  <b>{t(`admin.aa.rule.${r}`)}</b>
                  <small>{t(`admin.aa.ruleHint.${r}`)}</small>
                </span>
                <input type="checkbox" role="switch" className="pf-sw" checked={a[r]} onChange={(e) => setArea(k, { [r]: e.target.checked })} />
              </label>
            ))}
            <div className="pf-row">
              <span className="pf-text">
                <b>{t('admin.aa.max')}</b>
                <small>{t('admin.aa.maxHint')}</small>
              </span>
              <label className="pf-num">
                <input type="number" min={0} max={500} inputMode="numeric" aria-label={t('admin.aa.max')} value={a.max} onChange={(e) => setArea(k, { max: Math.max(0, Math.min(500, Math.round(Number(e.target.value) || 0))) })} />
              </label>
            </div>
            <div className="pf-row">
              <span className="pf-text">
                <b>{t('admin.aa.offline')}</b>
                <small>{t('admin.aa.offlineHint')}</small>
              </span>
              <label className="pf-num">
                <input type="number" min={5} max={240} inputMode="numeric" aria-label={t('admin.aa.offline')} value={a.offlineMin} onChange={(e) => setArea(k, { offlineMin: Math.max(5, Math.min(240, Math.round(Number(e.target.value) || 15))) })} />
                <span>{t('admin.aa.min')}</span>
              </label>
            </div>
          </section>
        )}

        <section className="pf-group aa-live">
          <h3>{t('admin.aa.now')}</h3>
          <div className="aa-now">
            <span>
              <b className="ltr">{d.waiting[k]}</b> {t(k === 'conf' ? 'admin.aa.waitingConf' : 'admin.aa.waitingFollow')}
            </span>
            <span>
              <b className="ltr">{on.length}</b> {t('admin.aa.onlineN', { count: on.length })}
            </span>
            <button type="button" className="btn primary small" disabled={run.isPending || a.mode === 'manual' || dirty} onClick={() => run.mutate({})} title={dirty ? t('admin.aa.saveFirst') : undefined}>
              <Icon name="refresh" /> {t('admin.aa.runNow')}
            </button>
          </div>
          <ul className="aa-people">
            {list.map((x) => (
              <li key={x.id} className={!x.online || agentOf(x.id).out ? 'off' : ''}>
                <span className={`aa-dot ${x.online ? (x.free ? 'ok' : 'call') : 'off'}`} title={t(x.online ? (x.free ? 'admin.aa.st.free' : 'admin.aa.st.call') : 'admin.aa.st.off')} />
                <b>{x.name}</b>
                <small>{agentOf(x.id).out ? t('admin.aa.st.out') : !x.inHours ? t('admin.aa.st.hours') : t(x.online ? (x.free ? 'admin.aa.st.free' : 'admin.aa.st.call') : 'admin.aa.st.off')}</small>
                <span className="aa-load ltr" title={t('admin.aa.loadTip')}>
                  {x.load}
                  {a.max > 0 ? ` / ${a.max}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  };

  return (
    <div className="card pf aa">
      <div className="pf-head">
        <div className="pf-title">
          <h2>{t('admin.aa.title')}</h2>
          <p className="muted">{t('admin.aa.help')}</p>
        </div>
      </div>
      <div className="aa-tabs" role="tablist">
        {(['conf', 'follow', 'agents'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span className="aa-full">{t(`admin.aa.tab.${k}`)}</span>
            <span className="aa-short">{t(`admin.aa.role.${k === 'follow' ? 'follow' : k === 'conf' ? 'conf' : 'agents'}`)}</span>
            {k !== 'agents' && <span className={`aa-badge ${v[k].mode === 'manual' ? '' : 'on'}`}>{t(`admin.aa.mode.${v[k].mode}`)}</span>}
          </button>
        ))}
      </div>

      {tab === 'conf' && <Area k="conf" />}
      {tab === 'follow' && <Area k="follow" />}
      {tab === 'agents' && (
        <section className="pf-group">
          <h3>{t('admin.aa.agentsT')}</h3>
          <p className="pf-lead">{t('admin.aa.agentsHint')}</p>
          <div className="tbl-wrap">
            <table className="tbl aa-tbl">
              <thead>
                <tr>
                  <th>{t('admin.aa.col.order')}</th>
                  <th>{t('admin.aa.col.agent')}</th>
                  <th>{t('admin.aa.col.in')}</th>
                  <th>{t('admin.aa.col.weight')}</th>
                  <th>{t('admin.aa.col.hours')}</th>
                  <th>{t('admin.aa.col.access')}</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((x, i) => {
                  const c = agentOf(x.id);
                  const roles = [d.conf.some((y) => y.id === x.id) ? t('admin.aa.role.conf') : '', d.follow.some((y) => y.id === x.id) ? t('admin.aa.role.follow') : ''].filter(Boolean).join(' · ');
                  return (
                    <tr key={x.id} className={c.out ? 'dim' : ''}>
                      <td data-l={t('admin.aa.col.order')} className="aa-ord">
                        <span className="ltr">{i + 1}</span>
                        <button type="button" className="bjp-ib" aria-label={t('admin.aa.up')} disabled={i === 0} onClick={() => move(x.id, -1)}>
                          <span aria-hidden="true">▲</span>
                        </button>
                        <button type="button" className="bjp-ib" aria-label={t('admin.aa.down')} disabled={i === ordered.length - 1} onClick={() => move(x.id, 1)}>
                          <span aria-hidden="true">▼</span>
                        </button>
                      </td>
                      <td data-l={t('admin.aa.col.agent')} className="aa-name">
                        <span className={`aa-dot ${x.online ? (x.free ? 'ok' : 'call') : 'off'}`} /> <b>{x.name}</b>
                        <small className="muted"> {roles}</small>
                      </td>
                      <td data-l={t('admin.aa.col.in')} className="aa-in">
                        <input type="checkbox" role="switch" className="pf-sw" aria-label={t('admin.aa.col.in')} checked={!c.out} onChange={(e) => setAgent(x.id, { out: !e.target.checked })} />
                      </td>
                      <td data-l={t('admin.aa.col.weight')} className="aa-w">
                        <select value={c.weight} aria-label={t('admin.aa.col.weight')} onChange={(e) => setAgent(x.id, { weight: Number(e.target.value) })}>
                          {[1, 2, 3].map((w) => (
                            <option key={w} value={w}>
                              ×{w}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td data-l={t('admin.aa.col.hours')} className="aa-hours">
                        <select value={c.from ?? ''} aria-label={t('admin.aa.from')} onChange={(e) => setAgent(x.id, { from: e.target.value === '' ? null : Number(e.target.value), to: e.target.value === '' ? null : c.to ?? 17 })}>
                          <option value="">{t('admin.aa.anyTime')}</option>
                          {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>
                              {String(h).padStart(2, '0')}:00
                            </option>
                          ))}
                        </select>
                        {c.from !== null && (
                          <>
                            <span>→</span>
                            <select value={c.to ?? ''} aria-label={t('admin.aa.to')} onChange={(e) => setAgent(x.id, { to: Number(e.target.value) })}>
                              {Array.from({ length: 24 }, (_, h) => (
                                <option key={h} value={h}>
                                  {String(h).padStart(2, '0')}:00
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                      </td>
                      <td data-l={t('admin.aa.col.access')} className="aa-acc">
                        <button type="button" className="aa-accb" onClick={() => setPick(x.id)}>
                          <Icon name="pencil" />
                          {c.channels.length || c.products.length ? t('admin.aa.limited', { c: c.channels.length, p: c.products.length }) : t('admin.aa.all')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {pick !== null && (
        <AccessModal
          name={people.find((x) => x.id === pick)?.name ?? ''}
          value={agentOf(pick)}
          products={products}
          onClose={() => setPick(null)}
          onSave={(p) => {
            setAgent(pick, p);
            setPick(null);
          }}
        />
      )}

      {dirty && (
        <div className="pf-foot" role="region" aria-label={t('livraison.prefs.unsaved')}>
          <span className="pf-state">{t('livraison.prefs.unsaved')}</span>
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate(v)}>
            {save.isPending ? '…' : t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}

/** What an agent may get: some sales channels and products (none ticked: everything). */
function AccessModal({ name, value, products, onClose, onSave }: { name: string; value: AgentCfg; products: { id: number; name: string }[]; onClose: () => void; onSave: (p: Partial<AgentCfg>) => void }) {
  const { t } = useTranslation();
  const [ch, setCh] = useState<string[]>(value.channels);
  const [pr, setPr] = useState<number[]>(value.products);
  const flip = <T,>(l: T[], x: T) => (l.includes(x) ? l.filter((y) => y !== x) : [...l, x]);
  return (
    <Modal
      sheet
      title={t('admin.aa.accessT', { name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => onSave({ channels: ch, products: pr })}>
            {t('admin.aa.done')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('admin.aa.accessHint')}</p>
      <h4 className="aa-h4">{t('admin.aa.channels')}</h4>
      <div className="pf-chips pf-chips-s">
        {SALES_CHANNELS.map((c) => (
          <label key={c} className={`pf-chip ${ch.includes(c) ? 'on' : ''}`}>
            <input type="checkbox" checked={ch.includes(c)} onChange={() => setCh(flip(ch, c))} />
            <Icon name="checkcircle" />
            {t(`status.channel.${c}`)}
          </label>
        ))}
      </div>
      <h4 className="aa-h4">{t('admin.aa.products')}</h4>
      <div className="pf-chips pf-chips-s aa-prods">
        {products.map((p) => (
          <label key={p.id} className={`pf-chip ${pr.includes(p.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={pr.includes(p.id)} onChange={() => setPr(flip(pr, p.id))} />
            <Icon name="checkcircle" />
            {p.name}
          </label>
        ))}
      </div>
    </Modal>
  );
}
