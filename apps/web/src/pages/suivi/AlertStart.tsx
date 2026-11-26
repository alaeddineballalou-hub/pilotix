// Suivi › Réglages › « Quand une alerte commence » (the owner's design 1 « Cartes », 26 Nov 2026): one choice for every
// delivery company — the 1st, the 2nd (advised: time to call before the last try) or the 3rd failed try, or only the
// cancel; a cancel always makes an alert; the problems (« Commune erronée », « Bloqué »…) in their own tab « Erreurs » or
// with the alerts. The table says what the choice means at each company, in its own words (Pilotix's code: only ZR's
// were read on a real account). Admin only; saved apart from the other Préférences.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { CoChip } from '../../ui/CoIcon';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import '../livraison/prefs.css';
import './alertstart.css';

export type AlertStartKey = 't1' | 't2' | 't3' | 'cancel';
type Problems = 'errors' | 'alert';
const STARTS: AlertStartKey[] = ['t1', 't2', 't3', 'cancel'];
const TRY: Record<AlertStartKey, number | null> = { t1: 1, t2: 2, t3: 3, cancel: null };
/** the owner's advised start */
const ADVISED: AlertStartKey = 't2';
type Row = Out<'delivery.alertWords'>[number];

const quote = (w: string) => `« ${w} »`;

export function AlertStart() {
  const { t } = useTranslation();
  const q = useRpc('prefs.get', {});
  const words = useRpc('delivery.alertWords', {});
  const save = useAction('prefs.setAlertStart', { silent: true });
  const [draft, setDraft] = useState<{ start: AlertStartKey; problems: Problems } | null>(null);
  const [scope, setScope] = useState<'mine' | 'all' | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const saved = { start: q.data.prefs.suiviAlertStart as AlertStartKey, problems: q.data.prefs.suiviProblems as Problems };
  const v = draft ?? saved;
  const dirty = v.start !== saved.start || v.problems !== saved.problems;
  const rows: Row[] = words.data ?? [];
  const mine = rows.filter((r) => r.mine);
  const sc = scope ?? (mine.length ? 'mine' : 'all');
  const shown = sc === 'mine' ? mine : rows;
  const n = TRY[v.start];
  const set = (x: Partial<{ start: AlertStartKey; problems: Problems }>) => setDraft({ ...v, ...x });
  const submit = async () => {
    try {
      await save.mutateAsync({ start: v.start, problems: v.problems });
      toast(t('livraison.prefs.saved'), 'ok');
      setDraft(null);
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    }
  };
  // what the choice means at a company: its numbered try, the tries Pilotix counts, or only its cancel
  const whenOf = (r: Row): [string, string] => {
    if (n === null) return [t('suivi.as.atCancel'), t('suivi.as.noneBefore')];
    if (r.numbered) return [quote(r.numbered.replace('{n}', String(n))), t('suivi.as.byCo', { co: r.label.replace(/\s*\(.*\)\s*/, '') })];
    if (r.tries.length) return [t('suivi.as.nthTry', { nth: t(`suivi.as.nth.${n}`), word: r.tries[0] }), t('suivi.as.byPilotix')];
    return [t('suivi.as.atCancel'), t('suivi.as.noTries')];
  };
  const cancelOf = (r: Row) => (r.cancels.length ? r.cancels.map(quote).join(', ') : r.cancelsBack.length ? t('suivi.as.cancelBack', { words: r.cancelsBack.map(quote).join(', ') }) : '—');
  const problemsOf = (r: Row) => (r.problems.length ? r.problems.map(quote).join(', ') : t('suivi.as.noProblem'));
  const badge = (r: Row) => (
    <CoChip companyId={null} kind={r.kind} className={`as-ic k-${r.kind}`} aria-hidden="true">
      {r.label.replace(/express|delivery|livraison|\(.*\)/gi, '').trim().slice(0, 2).toUpperCase()}
    </CoChip>
  );
  const name = (r: Row) => (
    <span className="as-co">
      {badge(r)}
      <span className="as-co-t">
        <b>{r.label}</b>
        {r.mine && <span className="as-on">{t('suivi.as.connected')}</span>}
      </span>
    </span>
  );
  return (
    <div className="pf as">
      <section className="pf-group" aria-labelledby="as-h">
        <h3 id="as-h">{t('suivi.as.becomes')}</h3>
        <div className="as-opts" role="radiogroup" aria-label={t('suivi.cfg.quand.t')}>
          {STARTS.map((k) => (
            <label key={k} className={`as-opt ${v.start === k ? 'on' : ''}`}>
              <input type="radio" name="as-start" checked={v.start === k} onChange={() => set({ start: k })} />
              <span className="as-dot" aria-hidden="true" />
              <b>{t(`suivi.as.opt.${k}.t`)}</b>
              <small>{t(`suivi.as.opt.${k}.d`)}</small>
              <span className="as-chips">
                <span className="as-ev">{t(`suivi.as.opt.${k}.e`)}</span>
                {k === ADVISED && <span className="as-best">{t('suivi.as.advised')}</span>}
              </span>
            </label>
          ))}
        </div>
        <p className="as-lock">
          <Icon name="lock" />
          <span>
            <b>{t('suivi.as.lock')}</b>
            <small>{t('suivi.as.lockHint')}</small>
          </span>
        </p>
      </section>

      <section className="pf-group" aria-labelledby="as-cos-h">
        <div className="as-cos-h">
          <span>
            <h3 id="as-cos-h">{t('suivi.as.cosT')}</h3>
            <p className="pf-lead">{t('suivi.as.cosD')}</p>
          </span>
          {mine.length > 0 && (
            <span className="as-seg" role="radiogroup" aria-label={t('suivi.as.cosT')}>
              {(['mine', 'all'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={sc === k} className={sc === k ? 'on' : ''} onClick={() => setScope(k)}>
                  {t(`suivi.as.scope.${k}`, { n: k === 'mine' ? mine.length : rows.length })}
                </button>
              ))}
            </span>
          )}
        </div>
        {words.isLoading ? (
          <Loading />
        ) : words.error ? (
          <ErrorBox error={words.error} onRetry={() => words.refetch()} />
        ) : (
          <>
            <div className="as-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('suivi.as.col.co')}</th>
                    <th scope="col">{t('suivi.as.col.when')}</th>
                    <th scope="col">{t('suivi.as.col.cancel')}</th>
                    <th scope="col">{t('suivi.as.col.problems')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const [when, how] = whenOf(r);
                    return (
                      <tr key={r.kind}>
                        <td>{name(r)}</td>
                        <td>
                          <b dir="auto">{when}</b>
                          <small>{how}</small>
                        </td>
                        <td dir="auto">{cancelOf(r)}</td>
                        <td dir="auto" className={r.problems.length ? '' : 'muted'}>
                          {problemsOf(r)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="as-stack">
              {shown.map((r) => {
                const [when, how] = whenOf(r);
                return (
                  <li key={r.kind}>
                    {name(r)}
                    <dl>
                      <dt>{t('suivi.as.col.whenShort')}</dt>
                      <dd>
                        <b dir="auto">{when}</b>
                        <small>{how}</small>
                      </dd>
                      <dt>{t('suivi.as.col.cancelShort')}</dt>
                      <dd dir="auto">{cancelOf(r)}</dd>
                      <dt>{t('suivi.as.col.problems')}</dt>
                      <dd dir="auto" className={r.problems.length ? '' : 'muted'}>
                        {problemsOf(r)}
                      </dd>
                    </dl>
                  </li>
                );
              })}
            </ul>
            <p className="as-note">
              <Icon name="info" /> {t('suivi.as.tested')}
            </p>
          </>
        )}
      </section>

      <section className="pf-group" aria-labelledby="as-pb-h">
        <h3 id="as-pb-h">{t('suivi.as.pbT')}</h3>
        <p className="pf-lead">{t('suivi.as.pbD')}</p>
        <div className="as-opts as-opts-2" role="radiogroup" aria-label={t('suivi.as.pbT')}>
          {(['alert', 'errors'] as const).map((k) => (
            <label key={k} className={`as-opt ${v.problems === k ? 'on' : ''}`}>
              <input type="radio" name="as-problems" checked={v.problems === k} onChange={() => set({ problems: k })} />
              <span className="as-dot" aria-hidden="true" />
              <b>{t(`suivi.as.pb.${k}.t`)}</b>
              <small>{t(`suivi.as.pb.${k}.d`)}</small>
            </label>
          ))}
        </div>
      </section>

      {dirty && (
        <div className="pf-foot" role="region" aria-label={t('livraison.prefs.unsaved')}>
          <span className="pf-state">{t('livraison.prefs.unsaved')}</span>
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? '…' : t('livraison.prefs.save')}
          </button>
        </div>
      )}
    </div>
  );
}
