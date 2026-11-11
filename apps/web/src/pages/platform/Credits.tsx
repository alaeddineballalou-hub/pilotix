// Control room › Crédits IA (Espace créateur): the plans' credits each month, the packs a shop buys, the AI tools (their
// price in credits, their model, their instructions) and the ad strategies. Everything is edited here and saved at once
// (« Enregistrer »); the shops see it at their next look. New tools and strategies are added without a new version.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da } from '../../lib/format';
import { POut, Staff, usePAction, usePRpc } from '../../lib/platform';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { can } from './bits';
import './credits.css';

type Cfg = POut<'p.credits.get'>['config'];
type Tool = Cfg['tools'][number];
type Strat = Cfg['strategies'][number];
type Pack = Cfg['packs'][number];
const K = 'credits.cr.';
const UNITS = ['minute', 'post', 'ten', 'video'] as const;
const STYLES = ['ugly', 'clean'] as const;

function Sw({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`crs-sw${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

const num = (v: string, min = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, n) : min;
};

export function CreditsPage({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.credits.get', {});
  const [c, setC] = useState<Cfg | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const edit = can(staff, 'manager');
  useEffect(() => {
    if (q.data && !c) setC(structuredClone(q.data.config));
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = usePAction('p.credits.save', { success: t(K + 'saved'), onDone: (r) => setC(structuredClone(r)) });
  const dirty = useMemo(() => !!c && !!q.data && JSON.stringify(c) !== JSON.stringify(q.data.config), [c, q.data]);

  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data || !c) return <Loading />;
  const set = (f: (x: Cfg) => void) =>
    setC((o) => {
      const n = structuredClone(o!);
      f(n);
      return n;
    });
  const m = q.data.month;

  return (
    <div className="pp-stack crs">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.credits')}</h1>
          <p className="muted">{t(K + 'sub')}</p>
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <label className="crs-onoff">
            <Sw on={c.on} onChange={(v) => set((x) => void (x.on = v))} label={t(K + 'on')} />
            <span>{c.on ? t(K + 'on') : t(K + 'off')}</span>
          </label>
          {edit && (
            <button type="button" className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ config: c })}>
              {t(K + 'save')}
            </button>
          )}
        </div>
      </div>

      <div className="crs-kpis">
        <div className="card">
          <small>{t(K + 'kSold')}</small>
          <b className="ltr">{m.packs}</b>
        </div>
        <div className="card">
          <small>{t(K + 'kCredits')}</small>
          <b className="ltr">{m.credits}</b>
        </div>
        <div className="card">
          <small>{t(K + 'kAmount')}</small>
          <b className="ltr">{da(m.amount)}</b>
        </div>
        <div className="card">
          <small>{t(K + 'kUsed')}</small>
          <b className="ltr">{m.used}</b>
        </div>
      </div>

      <div className="crs-two">
        <section className="card crs-sec">
          <h2>{t(K + 'plans')}</h2>
          <p className="muted small">{t(K + 'plansHelp')}</p>
          {q.data.plans.map((p) => {
            const k = String(p.id);
            const v = k in c.planCredits ? c.planCredits[k] : null;
            return (
              <div className="crs-row crs-plan" key={p.id}>
                <b>{p.name}</b>
                <input
                  type="number"
                  min={0}
                  value={v === null || v < 0 ? '' : v}
                  placeholder={v === null ? String(c.defaultCredits < 0 ? '∞' : c.defaultCredits) : '∞'}
                  disabled={v === -1}
                  onChange={(e) => set((x) => void (x.planCredits[k] = num(e.target.value)))}
                  aria-label={t(K + 'perMonth')}
                />
                <label className="crs-inf">
                  <input type="checkbox" checked={v === -1} onChange={(e) => set((x) => void (e.target.checked ? (x.planCredits[k] = -1) : delete x.planCredits[k]))} /> ∞
                </label>
              </div>
            );
          })}
          <div className="crs-row crs-plan">
            <span>{t(K + 'others')}</span>
            <input
              type="number"
              min={0}
              value={c.defaultCredits < 0 ? '' : c.defaultCredits}
              disabled={c.defaultCredits < 0}
              onChange={(e) => set((x) => void (x.defaultCredits = num(e.target.value)))}
              aria-label={t(K + 'others')}
            />
            <label className="crs-inf">
              <input type="checkbox" checked={c.defaultCredits < 0} onChange={(e) => set((x) => void (x.defaultCredits = e.target.checked ? -1 : 100))} /> ∞
            </label>
          </div>
          <p className="muted small">{t(K + 'noCarry')}</p>
        </section>

        <section className="card crs-sec">
          <div className="crs-h">
            <h2>{t(K + 'packs')}</h2>
            <button type="button" className="btn small" onClick={() => set((x) => void x.packs.push({ key: '', name: t(K + 'newPack'), credits: 100, price: 500, on: true, best: false } as Pack))}>
              + {t(K + 'addPack')}
            </button>
          </div>
          <div className="crs-row crs-pack crs-cols">
            <span>{t(K + 'name')}</span>
            <span>{t(K + 'credits')}</span>
            <span>{t(K + 'price')}</span>
            <span>{t(K + 'best')}</span>
            <span>{t(K + 'sold')}</span>
            <span />
          </div>
          {c.packs.map((p, k) => (
            <div className="crs-row crs-pack" key={k}>
              <input value={p.name} onChange={(e) => set((x) => void (x.packs[k].name = e.target.value))} aria-label={t(K + 'name')} />
              <input type="number" min={1} value={p.credits} onChange={(e) => set((x) => void (x.packs[k].credits = num(e.target.value, 1)))} aria-label={t(K + 'credits')} />
              <input type="number" min={0} value={p.price} onChange={(e) => set((x) => void (x.packs[k].price = num(e.target.value)))} aria-label={t(K + 'price')} />
              <input type="radio" name="crs-best" checked={p.best} onChange={() => set((x) => x.packs.forEach((y, j) => (y.best = j === k)))} aria-label={t(K + 'best')} />
              <Sw on={p.on} onChange={(v) => set((x) => void (x.packs[k].on = v))} label={t(K + 'sold')} />
              <button type="button" className="icon-btn" aria-label={t(K + 'remove')} onClick={() => set((x) => void x.packs.splice(k, 1))}>
                <Icon name="x" />
              </button>
            </div>
          ))}
        </section>
      </div>

      <section className="card crs-sec">
        <div className="crs-h">
          <h2>{t(K + 'tools')}</h2>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              set((x) => void x.tools.push({ key: '', name: t(K + 'newTool'), desc: '', model: 'claude-haiku-5-5', credits: 1, unit: 'post', on: false, prompt: '', dayLimit: 0 } as Tool));
              setOpen(`t${c.tools.length}`);
            }}
          >
            + {t(K + 'addTool')}
          </button>
        </div>
        <p className="muted small">{t(K + 'toolsHelp')}</p>
        <div className="crs-row crs-tool crs-cols">
          <span>{t(K + 'tool')}</span>
          <span>{t(K + 'model')}</span>
          <span>{t(K + 'cost')}</span>
          <span>{t(K + 'unit')}</span>
          <span>{t(K + 'active')}</span>
          <span />
        </div>
        {c.tools.map((x, k) => (
          <div key={k} className="crs-item">
            <div className="crs-row crs-tool">
              <div>
                <input value={x.name} onChange={(e) => set((y) => void (y.tools[k].name = e.target.value))} aria-label={t(K + 'tool')} />
                {x.key && <small className="muted ltr">{x.key}</small>}
              </div>
              <input className="ltr" value={x.model} onChange={(e) => set((y) => void (y.tools[k].model = e.target.value))} aria-label={t(K + 'model')} list="crs-models" />
              <input type="number" min={0} value={x.credits} onChange={(e) => set((y) => void (y.tools[k].credits = num(e.target.value)))} aria-label={t(K + 'cost')} />
              <select value={x.unit} onChange={(e) => set((y) => void (y.tools[k].unit = e.target.value as Tool['unit']))} aria-label={t(K + 'unit')}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(K + `units.${u}`)}
                  </option>
                ))}
              </select>
              <Sw on={x.on} onChange={(v) => set((y) => void (y.tools[k].on = v))} label={t(K + 'active')} />
              <button type="button" className="btn small" onClick={() => setOpen(open === `t${k}` ? null : `t${k}`)}>
                {t(K + 'edit')}
              </button>
            </div>
            {open === `t${k}` && (
              <div className="crs-more">
                <label className="field">
                  <span className="lab">{t(K + 'desc')}</span>
                  <input value={x.desc} onChange={(e) => set((y) => void (y.tools[k].desc = e.target.value))} />
                </label>
                <label className="field">
                  <span className="lab">{t(K + 'dayLimit')}</span>
                  <input type="number" min={0} value={x.dayLimit} onChange={(e) => set((y) => void (y.tools[k].dayLimit = num(e.target.value)))} />
                </label>
                <label className="field crs-wide">
                  <span className="lab">{t(K + 'prompt')}</span>
                  <textarea rows={3} value={x.prompt} onChange={(e) => set((y) => void (y.tools[k].prompt = e.target.value))} placeholder={t(K + 'promptHint')} />
                </label>
                {!['subtitles', 'posttext', 'hookideas'].includes(x.key) && <p className="muted small crs-wide">{t(K + 'newToolNote')}</p>}
                <button type="button" className="btn small danger" onClick={() => (set((y) => void y.tools.splice(k, 1)), setOpen(null))}>
                  {t(K + 'remove')}
                </button>
              </div>
            )}
          </div>
        ))}
        <datalist id="crs-models">
          <option value="gemini-flash-lite-latest" />
          <option value="gemini-flash-latest" />
          <option value="claude-haiku-5-5" />
          <option value="claude-sonnet-5-5" />
        </datalist>
      </section>

      <section className="card crs-sec">
        <div className="crs-h">
          <h2>{t(K + 'strats')}</h2>
          <button
            type="button"
            className="btn small"
            onClick={() => set((x) => void x.strategies.push({ key: '', name: t(K + 'newStrat'), kind: 'recipe', style: 'ugly', desc: '', credits: 0, trend: false, on: false, idea: '', types: [1, 2, 3] } as Strat))}
          >
            + {t(K + 'addStrat')}
          </button>
        </div>
        <p className="muted small">{t(K + 'stratsHelp')}</p>
        <div className="crs-cards">
          {c.strategies.map((s, k) => (
            <article key={k} className={`crs-card${s.on ? '' : ' off'}`}>
              <div className="crs-h">
                <input className="crs-title" value={s.name} onChange={(e) => set((y) => void (y.strategies[k].name = e.target.value))} aria-label={t(K + 'name')} />
                <Sw on={s.on} onChange={(v) => set((y) => void (y.strategies[k].on = v))} label={t(K + 'active')} />
              </div>
              <div className="crs-grid">
                <label className="field">
                  <span className="lab">{t(K + 'kind')}</span>
                  <select value={s.kind} onChange={(e) => set((y) => void (y.strategies[k].kind = e.target.value as Strat['kind']))}>
                    <option value="style">{t(K + 'kinds.style')}</option>
                    <option value="recipe">{t(K + 'kinds.recipe')}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="lab">{t(K + 'style')}</span>
                  <select value={s.style} onChange={(e) => set((y) => void (y.strategies[k].style = e.target.value as Strat['style']))}>
                    {STYLES.map((x) => (
                      <option key={x} value={x}>
                        {t(K + `styles.${x}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="lab">{t(K + 'perAd')}</span>
                  <input type="number" min={0} value={s.credits} onChange={(e) => set((y) => void (y.strategies[k].credits = num(e.target.value)))} />
                </label>
                <label className="field crs-check">
                  <input type="checkbox" checked={s.trend} onChange={(e) => set((y) => void (y.strategies[k].trend = e.target.checked))} /> {t(K + 'trend')}
                </label>
              </div>
              <fieldset className="field crs-types">
                <legend className="lab">{t(K + 'types')}</legend>
                {([1, 2, 3] as const).map((n) => (
                  <label key={n} className="crs-check" title={t(K + `typeHelp.${n}`)}>
                    <input
                      type="checkbox"
                      checked={s.types.includes(n)}
                      onChange={(e) =>
                        set((y) => {
                          const own = y.strategies[k];
                          const next = e.target.checked ? [...new Set([...own.types, n])].sort() : own.types.filter((x) => x !== n);
                          // never none: a strategy fits at least one type
                          own.types = (next.length ? next : own.types) as Strat['types'];
                        })
                      }
                    />{' '}
                    {t(K + `typeName.${n}`)}
                  </label>
                ))}
              </fieldset>
              <label className="field">
                <span className="lab">{t(K + 'desc')}</span>
                <input value={s.desc} onChange={(e) => set((y) => void (y.strategies[k].desc = e.target.value))} />
              </label>
              <label className="field">
                <span className="lab">{t(K + 'idea')}</span>
                <textarea rows={2} value={s.idea} onChange={(e) => set((y) => void (y.strategies[k].idea = e.target.value))} placeholder={t(K + 'ideaHint')} />
              </label>
              <button type="button" className="btn small danger" onClick={() => set((y) => void y.strategies.splice(k, 1))}>
                {t(K + 'remove')}
              </button>
            </article>
          ))}
        </div>
      </section>

      {edit && <Gift />}
      {edit && dirty && (
        <div className="crs-bar">
          <span>{t(K + 'unsaved')}</span>
          <button type="button" className="btn" onClick={() => setC(structuredClone(q.data!.config))}>
            {t(K + 'undo')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ config: c })}>
            {t(K + 'save')}
          </button>
        </div>
      )}
    </div>
  );
}

/** « Offrir des crédits » to one shop (its id from the shops list), and what it has. */
function Gift() {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [n, setN] = useState('50');
  const [note, setNote] = useState('');
  const shopId = Number(id);
  const ok = Number.isInteger(shopId) && shopId > 0;
  const q = usePRpc('p.credits.shop', { shopId }, { enabled: ok, retry: false });
  const gift = usePAction('p.credits.gift', { success: t(K + 'given') });
  const w = q.data?.wallet;
  return (
    <section className="card crs-sec">
      <h2>{t(K + 'gift')}</h2>
      <div className="crs-gift">
        <label className="field">
          <span className="lab">{t(K + 'shopId')}</span>
          <input inputMode="numeric" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} placeholder="12" />
        </label>
        <label className="field">
          <span className="lab">{t(K + 'credits')}</span>
          <input type="number" value={n} onChange={(e) => setN(e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t(K + 'note')}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn primary"
          disabled={!ok || !Number(n) || gift.isPending || !q.data}
          onClick={() => gift.mutate({ shopId, credits: Math.round(Number(n)), note: note || undefined })}
        >
          {t(K + 'give')}
        </button>
      </div>
      {ok && q.error && <p className="pp-bad small">{q.error.message}</p>}
      {q.data && w && (
        <p className="small">
          <b>{q.data.shop.name}</b> · {t(K + 'left', { n: w.left < 0 ? '∞' : w.left })} · {t(K + 'monthUse', { used: w.used, of: w.allowance < 0 ? '∞' : w.allowance })} ·{' '}
          {t(K + 'bought', { n: w.bonus })}
        </p>
      )}
      {q.data && q.data.log.length > 0 && (
        <ul className="crs-log">
          {q.data.log.slice(0, 8).map((x) => (
            <li key={x.id}>
              <span className="ltr">{x.at.slice(0, 16).replace('T', ' ')}</span> · {t(K + `log.${x.kind}`)} {x.tool ? `· ${x.tool}` : ''} ·{' '}
              <b className="ltr">{x.delta > 0 ? `+${x.delta}` : x.delta}</b>
              {x.note ? ` · ${x.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
