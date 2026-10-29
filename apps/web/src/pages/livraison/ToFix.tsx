// Pilot Auto Assign › « À corriger »: communes Pilotix could not match on waiting orders (the closest official name
// suggested; those it matched by itself listed under « reconnues toutes seules », to change if wrong; corrected once, remembered, the orders fixed and Pilot chooses again), companies whose tariffs were never
// imported, and « Mettre à jour maintenant » (tariffs and bureaus from the companies' systems, also every night).
import { communesOf } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { when, wilaya } from '../../lib/format';
import i18n from '../../lib/i18n';
import { useAction, useRpc } from '../../lib/query';
import { Icon, Loading } from '../../ui/kit';

export function ToFix() {
  const { t } = useTranslation();
  const q = useRpc('coverage.toFix', {});
  const refresh = useAction('coverage.refresh', { success: (r) => t('livraison.cov.refreshed', { count: r.results.filter((x) => x.ok).length }) });
  const f = q.data;
  const bad = f?.refresh.results.filter((x) => !x.ok) ?? [];
  return (
    <section className="pl-card" aria-labelledby="pl-fix-h">
      <div className="pl-card-h pl-fix-h">
        <span>
          <b id="pl-fix-h">
            <Icon name="alert" /> {t('livraison.cov.fixT')}
          </b>
          <small>{t('livraison.cov.fixHint')}</small>
        </span>
        <span className="pl-ref">
          <button type="button" className="btn small" disabled={refresh.isPending} onClick={() => refresh.mutate({})}>
            <Icon name="refresh" /> {refresh.isPending ? t('livraison.cov.refreshing') : t('livraison.cov.refresh')}
          </button>
          <small className="muted">
            {f?.refresh.at ? t('livraison.cov.lastAt', { when: when(f.refresh.at) }) : t('livraison.cov.never')} · {t('livraison.cov.nightly')}
          </small>
        </span>
      </div>
      {bad.length > 0 && (
        <p className="pl-warn">
          <Icon name="alert" /> {bad.map((x) => `${x.name} : ${x.error}`).join(' · ')}
        </p>
      )}
      {!f ? (
        <Loading />
      ) : !f.communes.length && !f.prices.length ? (
        <p className="pl-ok">
          <Icon name="checkcircle" /> {t('livraison.cov.allGood')}
        </p>
      ) : (
        <ul className="pl-fix">
          {f.communes.map((c) => (
            <CommuneFix key={`${c.wilayaId}|${c.commune}`} c={c} />
          ))}
          {f.prices.map((p) => (
            <li key={p.companyId}>
              <Icon name="coins" />
              <span className="pl-fx-t">
                <b>{p.name}</b>
                <small>{t('livraison.cov.noFees')}</small>
              </span>
              <a className="btn small" href="#/livraison/societes">
                {t('livraison.cov.toPrices')}
              </a>
            </li>
          ))}
        </ul>
      )}
      {!!f?.auto.length && (
        <details className="pl-auto">
          <summary>
            <Icon name="checkcircle" /> {t('livraison.cov.autoT', { count: f.auto.length })}
          </summary>
          <small className="muted">{t('livraison.cov.autoHint')}</small>
          <ul className="pl-fix">
            {f.auto.map((c) => (
              <CommuneFix key={`${c.wilayaId}|${c.commune}`} c={{ ...c, suggestion: c.to }} auto />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CommuneFix({ c, auto }: { c: Omit<Out<'coverage.toFix'>['communes'][number], 'suggestion'> & { suggestion: string | null }; auto?: boolean }) {
  const { t } = useTranslation();
  const [to, setTo] = useState(c.suggestion ?? '');
  const fix = useAction('coverage.fixCommune', { success: (r) => t('livraison.cov.fixed', { count: r.fixed, c: r.commune }) });
  return (
    <li className={auto ? 'is-auto' : undefined}>
      <Icon name={auto ? 'checkcircle' : 'flag'} />
      <span className="pl-fx-t">
        <b>
          « {c.commune} »{auto && <> → {c.suggestion}</>} · {wilaya(c.wilayaId)}
        </b>
        <small>{t('livraison.cov.orders', { count: c.count })}</small>
      </span>
      <label className="pl-fx-sel">
        <span className="sr-only">{t('livraison.cov.isWhich')}</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('livraison.cov.pick')}</option>
          {communesOf(c.wilayaId).map((x) => (
            <option key={x[1]} value={x[1]}>
              {i18n.language === 'ar' && x[2] ? x[2] : x[1]}
              {x[1] === c.suggestion ? ` — ${auto ? t('livraison.cov.auto') : t('livraison.cov.suggested')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn small primary" disabled={!to || fix.isPending || (auto && to === c.suggestion)} onClick={() => fix.mutate({ wilayaId: c.wilayaId, from: c.commune, to })}>
        {auto ? t('livraison.cov.change') : t('livraison.cov.fix')}
      </button>
    </li>
  );
}
