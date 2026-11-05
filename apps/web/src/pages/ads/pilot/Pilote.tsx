// « Pilote auto »: what it suggests now (Appliquer / Ignorer), its rules (each one off, suggesting, or acting alone
// within the owner's limits), the owner's limits and « Tout arrêter », and what it did. The rules themselves are in
// core (packages/core/src/modules/pilotads.ts); the job runs them every 15 minutes.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../../lib/backend';
import { since } from '../../../lib/format';
import { useAction, useRpc } from '../../../lib/query';
import { Empty, ErrorBox, Icon, Loading } from '../../../ui/kit';
import { ActionLog, usd } from './Hub';

type S = Out<'ads.pilot.state'>;
type Sug = S['suggestions'][number];
type RuleKey = 'stop' | 'scale' | 'trim' | 'confirm' | 'deliver' | 'tired' | 'cap';
type Mode = 'off' | 'suggest' | 'auto';
const RULES: RuleKey[] = ['stop', 'trim', 'deliver', 'confirm', 'tired', 'scale', 'cap'];
const AUTO: RuleKey[] = ['stop', 'trim', 'cap', 'scale'];
const RULE_ICON: Record<RuleKey, string> = { stop: 'cut', trim: 'trenddown', deliver: 'truck', confirm: 'phone', tired: 'film', scale: 'trend', cap: 'shield' };

export function Pilote() {
  const { t } = useTranslation();
  const q = useRpc('ads.pilot.state', {});
  const check = useAction('ads.pilot.check', { success: (r) => t('pilotads.pilot.checked', { n: r.checked, open: r.open }) });
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  return (
    <div className="pa-pilot">
      <section className="card pa-pilot-head">
        <span className="pa-pilot-ico">
          <Icon name="sparkles" />
        </span>
        <div>
          <h2>{t('pilotads.pilot.title')}</h2>
          <p className="muted">
            {t('pilotads.pilot.sub')} {d.lastRun ? t('pilotads.pilot.last', { when: t('pilotads.ago', { d: since(d.lastRun) }) }) : ''}
          </p>
        </div>
        <div className="pa-pilot-meter">
          <b className="ltr">
            {d.autoToday}/{d.autoPerDay}
          </b>
          <small>{t('pilotads.pilot.autoToday')}</small>
        </div>
        {d.owner && (
          <button type="button" className="btn" disabled={check.isPending} onClick={() => check.mutate({})}>
            <Icon name="refresh" /> {t('pilotads.pilot.check')}
          </button>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            {t('pilotads.pilot.now')}
            <span className="count">{d.suggestions.length}</span>
          </h2>
        </div>
        {!d.suggestions.length ? <Empty>{t('pilotads.pilot.none')}</Empty> : <ul className="pa-sugs">{d.suggestions.map((s) => <Suggestion key={s.id} s={s} />)}</ul>}
      </section>

      <div className="pa-pilot-grid">
        <Rules d={d} />
        <Limits d={d} />
      </div>
      <ActionLog rows={d.history} title={t('pilotads.pilot.history')} />
    </div>
  );
}

/** One suggestion, in words, with its button. */
function Suggestion({ s }: { s: Sug }) {
  const { t } = useTranslation();
  const decide = useAction('ads.pilot.decide', { success: (r) => (r.status === 'ignored' ? t('pilotads.pilot.ignored') : r.action?.status === 'waiting_yes' ? t('pilotads.sentToOwner') : t('pilotads.doneToast')) });
  const w = s.why as Record<string, any>;
  const rule = s.rule as RuleKey;
  const key = rule === 'tired' ? `pilotads.why.tired_${w.diag ?? 'fatigue'}` : `pilotads.why.${rule}`;
  const canApply = s.op === 'pause' || s.op === 'budget' || s.op === 'copy';
  const tone = rule === 'scale' ? 'ok' : rule === 'stop' || rule === 'deliver' ? 'bad' : 'mid';
  return (
    <li className={`pa-sug pa-tone-${tone}`}>
      <span className="pa-sug-ico">
        <Icon name={RULE_ICON[rule] ?? 'sparkles'} />
      </span>
      <div className="pa-sug-what">
        <b>
          {t(`pilotads.rule.${rule}.name`)} · {s.objectName}
        </b>
        <span>{t(key, { ...w, value: s.value, spend: usd(w.spend, 1), cost: usd(w.cost, 2), limit: usd(w.limit, 2), from: usd(w.from, 0), to: usd(s.value, 0) })}</span>
        <small className="muted">{t('pilotads.ago', { d: since(s.at) })}</small>
      </div>
      <div className="pa-sug-btns">
        <button type="button" className="btn" disabled={decide.isPending} onClick={() => decide.mutate({ id: s.id, apply: false })}>
          {t('pilotads.pilot.ignore')}
        </button>
        {canApply ? (
          <button type="button" className={`btn ${s.op === 'pause' ? 'danger' : 'primary'}`} disabled={decide.isPending} onClick={() => decide.mutate({ id: s.id, apply: true })}>
            {t(`pilotads.pilot.apply_${s.op}`, { to: usd(s.value, 0) })}
          </button>
        ) : s.op === 'creative' ? (
          <a className="btn primary" href="#/marketing/publicite/lancer">
            {t('pilotads.pilot.newCrea')}
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Rules({ d }: { d: S }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Record<RuleKey, Mode>>(d.rules as Record<RuleKey, Mode>);
  useEffect(() => setRules(d.rules as Record<RuleKey, Mode>), [d.rules]);
  const save = useAction('ads.pilot.save', { success: t('pilotads.pilot.saved') });
  const change = (k: RuleKey, m: Mode) => {
    const next = { ...rules, [k]: m };
    setRules(next);
    save.mutate({ rules: { [k]: m } });
  };
  return (
    <section className="card pa-rules">
      <div className="card-head">
        <h2>{t('pilotads.pilot.rules')}</h2>
      </div>
      {!d.owner && <p className="note">{t('pilotads.pilot.ownerOnly')}</p>}
      <ul>
        {RULES.map((k) => (
          <li key={k}>
            <span className="pa-rule-ico">
              <Icon name={RULE_ICON[k]} />
            </span>
            <div>
              <b>{t(`pilotads.rule.${k}.name`)}</b>
              <small>{t(`pilotads.rule.${k}.text`)}</small>
            </div>
            <div className="pa-mode small" role="radiogroup" aria-label={t(`pilotads.rule.${k}.name`)}>
              {(['off', 'suggest', 'auto'] as Mode[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={rules[k] === m} className={rules[k] === m ? 'on' : ''} disabled={!d.owner || (m === 'auto' && !AUTO.includes(k)) || save.isPending} onClick={() => change(k, m)} title={m === 'auto' && !AUTO.includes(k) ? t('pilotads.pilot.askOnly') : undefined}>
                  {t(`pilotads.pilot.m_${m}`)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="note">{t('pilotads.pilot.rulesNote')}</p>
    </section>
  );
}

function Limits({ d }: { d: S }) {
  const { t } = useTranslation();
  const g = d.guard;
  const [v, setV] = useState({ maxDailyUsd: g.maxDailyUsd === null ? '' : String(g.maxDailyUsd), maxRaisePct: String(g.maxRaisePct), yesAboveUsd: g.yesAboveUsd === null ? '' : String(g.yesAboveUsd), launchYes: g.launchYes });
  useEffect(() => setV({ maxDailyUsd: g.maxDailyUsd === null ? '' : String(g.maxDailyUsd), maxRaisePct: String(g.maxRaisePct), yesAboveUsd: g.yesAboveUsd === null ? '' : String(g.yesAboveUsd), launchYes: g.launchYes }), [g.maxDailyUsd, g.maxRaisePct, g.yesAboveUsd, g.launchYes]);
  const save = useAction('ads.ctl.guard', { success: t('pilotads.guard.saved') });
  const num = (s: string) => (s.trim() === '' ? null : Math.max(1, Number(s)));
  const changed = v.maxDailyUsd !== (g.maxDailyUsd === null ? '' : String(g.maxDailyUsd)) || v.maxRaisePct !== String(g.maxRaisePct) || v.yesAboveUsd !== (g.yesAboveUsd === null ? '' : String(g.yesAboveUsd)) || v.launchYes !== g.launchYes;
  return (
    <section className="card pa-limits">
      <div className="card-head">
        <h2>
          <Icon name="shield" /> {t('pilotads.guard.title')}
        </h2>
      </div>
      <div className="pa-limit-fields">
        <label className="field">
          <span className="lab">{t('pilotads.guard.maxDaily')}</span>
          <span className="pa-usd">
            <input type="number" min={1} disabled={!d.owner} value={v.maxDailyUsd} placeholder="∞" onChange={(e) => setV({ ...v, maxDailyUsd: e.target.value })} />
            <b>$</b>
          </span>
        </label>
        <label className="field">
          <span className="lab">{t('pilotads.guard.maxRaise')}</span>
          <span className="pa-usd">
            <input type="number" min={5} max={200} disabled={!d.owner} value={v.maxRaisePct} onChange={(e) => setV({ ...v, maxRaisePct: e.target.value })} />
            <b>%</b>
          </span>
        </label>
        <label className="field">
          <span className="lab">{t('pilotads.guard.yesAbove')}</span>
          <span className="pa-usd">
            <input type="number" min={1} disabled={!d.owner} value={v.yesAboveUsd} placeholder="∞" onChange={(e) => setV({ ...v, yesAboveUsd: e.target.value })} />
            <b>$</b>
          </span>
        </label>
        <label className="pa-check">
          <input type="checkbox" disabled={!d.owner} checked={v.launchYes} onChange={(e) => setV({ ...v, launchYes: e.target.checked })} />
          <span>
            <b>{t('pilotads.guard.launchYes')}</b>
            <small>{t('pilotads.guard.launchYesTip')}</small>
          </span>
        </label>
      </div>
      {d.owner && (
        <div className="pa-limit-btns">
          <button type="button" className="btn primary" disabled={!changed || save.isPending} onClick={() => save.mutate({ maxDailyUsd: num(v.maxDailyUsd), maxRaisePct: Math.round(Number(v.maxRaisePct) || 30), yesAboveUsd: num(v.yesAboveUsd), launchYes: v.launchYes })}>
            {t('common.save')}
          </button>
        </div>
      )}
      <p className="note">{t('pilotads.guard.note')}</p>
    </section>
  );
}
