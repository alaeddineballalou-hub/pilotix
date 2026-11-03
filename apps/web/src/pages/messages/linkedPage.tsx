// The Facebook Page (and its Instagram account) the agents answer on, in Message AI agent › Réglages and CM AI agent ›
// Réglages: it comes only from a linked account (Pilot AI › Comptes, pages/comptes).
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/kit';

/**
 * The Facebook Page (and its Instagram account) the agents answer on: it comes only from a linked account (Pilot AI ›
 * Comptes). An old Page token pasted by hand keeps working until a Page is linked (it is then replaced).
 */
export function LinkedPage({ page, old }: { page: { name: string; igUsername: string | null; account: string } | null; old?: boolean }) {
  const { t } = useTranslation();
  if (page)
    return (
      <div className="dl-linked ok">
        <Icon name="checkcircle" />
        <p>
          <b>
            <bdi>{page.igUsername ? t('messages.settings.pageLinkedIg', { name: page.name, ig: page.igUsername }) : t('messages.settings.pageLinked', { name: page.name })}</bdi>
          </b>
          <small>
            <bdi>{t('messages.settings.pageVia', { account: page.account })}</bdi>
          </small>
        </p>
        <a className="btn ghost small" href="#/comptes">
          {t('messages.settings.pageChange')}
        </a>
      </div>
    );
  return (
    <div className="dl-linked">
      <Icon name="link" />
      <p>
        <b>{t('messages.settings.pageNone')}</b>
        <small>{old ? t('messages.settings.pageOld') : t('messages.settings.pageNoneHint')}</small>
      </p>
      <a className="btn primary small" href="#/comptes">
        {t('messages.settings.pageLink')}
      </a>
    </div>
  );
}
