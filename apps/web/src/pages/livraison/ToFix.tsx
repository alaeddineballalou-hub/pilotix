// Pilot Auto Assign › « À corriger »: companies whose tariffs were never imported (Pilot cannot know where they
// deliver), and « Mettre à jour maintenant » (tariffs and bureaus from the companies' systems, also every night).
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
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
      ) : !f.prices.length ? (
        <p className="pl-ok">
          <Icon name="checkcircle" /> {t('livraison.cov.allGood')}
        </p>
      ) : (
        <ul className="pl-fix">
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
    </section>
  );
}
