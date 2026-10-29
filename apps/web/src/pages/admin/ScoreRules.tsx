// Réglages › Score client: how many points each thing adds or takes off the customer's score out of 100, where a customer
// starts, the highest score of a blacklisted / stop-desk customer, and where each level begins — tried on a few example
// customers before saving (the same rule as the server: shared/clientscore.ts). Admin only.
import { DEFAULT_SCORE_RULES, SCORE_RULE_KEYS, scoreClient, type ClientFacts, type ScoreRules } from '@pilotix/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Loading } from '../../ui/kit';
import { ScoreChip } from '../../ui/clientScore';
import './scoreRules.css';

type Flat = Record<string, string>;
const PATHS = [
  'base',
  ...SCORE_RULE_KEYS.flatMap((k) => [`${k}.each`, `${k}.max`]),
  'markFake',
  'markCompetitor',
  'network.first',
  'network.more',
  'network.max',
  'caps.blacklistAuto',
  'caps.blacklistManual',
  'caps.stopdesk',
  'levels.top',
  'levels.good',
  'levels.watch',
] as const;
/** the only boxes that may stay empty: « au plus » of a counted thing (no limit) */
const MAY_BE_EMPTY = new Set<string>(SCORE_RULE_KEYS.map((k) => `${k}.max`));

const get = (r: any, p: string) => p.split('.').reduce((o, k) => o?.[k], r);
const toFlat = (r: ScoreRules): Flat => Object.fromEntries(PATHS.map((p) => [p, get(r, p) === null ? '' : String(get(r, p))]));
function fromFlat(f: Flat): { rules: ScoreRules } | { error: 'empty' | 'range' | 'levels' } {
  const out: any = {};
  for (const p of PATHS) {
    const raw = (f[p] ?? '').trim();
    let v: number | null;
    if (raw === '') {
      if (!MAY_BE_EMPTY.has(p)) return { error: 'empty' };
      v = null;
    } else {
      v = Number(raw);
      if (!Number.isInteger(v) || v < 0 || v > 100) return { error: 'range' };
    }
    const [a, b] = p.split('.');
    if (b) (out[a] ??= {})[b] = v;
    else out[a] = v;
  }
  const L = out.levels;
  if (!(L.top > L.good && L.good > L.watch && L.watch > 0)) return { error: 'levels' };
  return { rules: out as ScoreRules };
}

const NONE: ClientFacts = { delivered: 0, returned: 0, fake: 0, cancelled: 0, blocked: 0, review: 0, markFake: 0, markCompetitor: 0, network: 0, blacklisted: false, blacklistAuto: false, stopdeskOnly: false };
/** a few customers everyone knows, to see what the points do */
const EXAMPLES: { k: string; f: Partial<ClientFacts> }[] = [
  { k: 'd2', f: { delivered: 2 } },
  { k: 'd1', f: { delivered: 1 } },
  { k: 'c1', f: { cancelled: 1 } },
  { k: 'd1r1', f: { delivered: 1, returned: 1 } },
  { k: 'r1', f: { returned: 1 } },
  { k: 'n2', f: { network: 2 } },
  { k: 'f1', f: { fake: 1 } },
];

export function ScoreRulesCard() {
  const { t } = useTranslation();
  const q = useRpc('clientscore.rules', {});
  const [draft, setDraft] = useState<Flat | null>(null);
  const save = useAction('clientscore.setRules', { success: t('admin.score.saved'), onDone: () => setDraft(null) });
  const saved = q.data?.rules;
  const flat = draft ?? (saved ? toFlat(saved) : null);
  const parsed = useMemo(() => (flat ? fromFlat(flat) : null), [flat]);
  if (q.isLoading) return <Card title={t('admin.score.title')} className="sr-card"><Loading /></Card>;
  if (q.error || !flat || !saved) return <Card title={t('admin.score.title')} className="sr-card"><ErrorBox error={q.error} onRetry={() => q.refetch()} /></Card>;
  const rules = parsed && 'rules' in parsed ? parsed.rules : saved;
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(toFlat(saved));
  const isDefault = JSON.stringify(flat) === JSON.stringify(toFlat(DEFAULT_SCORE_RULES));
  const set = (p: string, v: string) => setDraft({ ...flat, [p]: v.replace(/[^\d]/g, '').slice(0, 3) });
  const box = (p: string, sign: '+' | '−' | '', label: string, placeholder?: string) => (
    <span className={`sr-box${sign === '+' ? ' up' : sign ? ' down' : ''}`}>
      {sign && <b aria-hidden="true">{sign}</b>}
      <input className="sr-in" inputMode="numeric" aria-label={label} placeholder={placeholder} value={flat[p] ?? ''} onChange={(e) => set(p, e.target.value)} />
    </span>
  );
  const row = (k: string, sign: '+' | '−') => {
    const name = t(`admin.score.what.${k}`);
    return (
      <tr key={k}>
        <th scope="row">{name}</th>
        <td>{box(`${k}.each`, sign, t('admin.score.eachOf', { what: name }))}</td>
        <td>{box(`${k}.max`, sign, t('admin.score.maxOf', { what: name }), t('admin.score.noLimit'))}</td>
      </tr>
    );
  };
  const once = (k: 'markFake' | 'markCompetitor') => {
    const name = t(`admin.score.what.${k}`);
    return (
      <tr key={k}>
        <th scope="row">{name}</th>
        <td>{box(k, '−', t('admin.score.eachOf', { what: name }))}</td>
        <td className="sr-note">{t('admin.score.once')}</td>
      </tr>
    );
  };
  const err = parsed && 'error' in parsed ? parsed.error : null;
  return (
    <Card title={t('admin.score.title')} help={t('admin.score.help')} className="sr-card">
      <p className="sr-lead">
        {t('admin.score.startA')} {box('base', '', t('admin.score.start'))} {t('admin.score.startB')}
      </p>
      <div className="sr-grid">
        <div className="sr-rules">
          <table className="sr-tbl">
            <thead>
              <tr>
                <th scope="col">{t('admin.score.col.what')}</th>
                <th scope="col">{t('admin.score.col.each')}</th>
                <th scope="col">{t('admin.score.col.max')}</th>
              </tr>
            </thead>
            <tbody>
              {row('delivered', '+')}
              {SCORE_RULE_KEYS.filter((k) => k !== 'delivered').map((k) => row(k, '−'))}
              {once('markFake')}
              {once('markCompetitor')}
              <tr>
                <th scope="row">
                  {t('admin.score.what.network')}
                  <small>
                    {t('admin.score.networkMoreA')} {box('network.more', '−', t('admin.score.networkMore'))} {t('admin.score.networkMoreB')}
                  </small>
                </th>
                <td>{box('network.first', '−', t('admin.score.eachOf', { what: t('admin.score.what.network') }))}</td>
                <td>{box('network.max', '−', t('admin.score.maxOf', { what: t('admin.score.what.network') }))}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="sr-side">
          <section aria-labelledby="sr-lv">
            <h3 id="sr-lv">{t('admin.score.levelsTitle')}</h3>
            <ul className="sr-levels">
              {(['top', 'good', 'watch'] as const).map((l) => (
                <li key={l} className={`cs-${l}`}>
                  <i aria-hidden="true" />
                  <span>{t(`clients.score.level.${l}`)}</span>
                  <small>{t('admin.score.from')}</small>
                  {box(`levels.${l}`, '', t('admin.score.levelFrom', { level: t(`clients.score.level.${l}`) }))}
                </li>
              ))}
              <li className="cs-risk">
                <i aria-hidden="true" />
                <span>{t('clients.score.level.risk')}</span>
                <small>{t('admin.score.below')}</small>
              </li>
            </ul>
          </section>
          <section aria-labelledby="sr-cap">
            <h3 id="sr-cap">{t('admin.score.capsTitle')}</h3>
            <ul className="sr-caps">
              {(['blacklistAuto', 'blacklistManual', 'stopdesk'] as const).map((c) => (
                <li key={c}>
                  <span>{t(`admin.score.cap.${c}`)}</span>
                  {box(`caps.${c}`, '', t(`admin.score.cap.${c}`))}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="sr-try" className="sr-try">
            <h3 id="sr-try">{t('admin.score.tryTitle')}</h3>
            <ul>
              {EXAMPLES.map((x) => (
                <li key={x.k}>
                  <span>{t(`admin.score.ex.${x.k}`)}</span>
                  <ScoreChip s={scoreClient({ ...NONE, ...x.f }, rules)} showNew />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      {err && <p className="form-err" role="alert">{t(`admin.score.err.${err}`)}</p>}
      <div className="row end sr-foot">
        <button type="button" className="btn ghost" disabled={isDefault} onClick={() => setDraft(toFlat(DEFAULT_SCORE_RULES))}>
          {t('admin.score.reset')}
        </button>
        {changed && (
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" className="btn primary" disabled={!changed || !!err || save.isPending} onClick={() => parsed && 'rules' in parsed && save.mutate(parsed.rules)}>
          {t('common.save')}
        </button>
      </div>
    </Card>
  );
}
