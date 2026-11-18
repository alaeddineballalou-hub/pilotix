import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LegalInfo, legalText, publisherName, publisherOf } from '../lib/backend';
import './pubFooter.css';

/**
 * At the bottom of every page inside Pilotix: the company that publishes it, as on its papers and in Meta (its name, in
 * Arabic on the pages in Arabic, its address, phone and tax number), with the link to the terms. Read from control room
 * › Réglages › Société; nothing shows while Pilotix names no company there (or in the demo).
 */
export function PubFooter() {
  const { t, i18n } = useTranslation();
  const [pub, setPub] = useState<LegalInfo | null>(null);
  useEffect(() => {
    let on = true;
    legalText().then((d) => on && setPub(publisherOf(d)));
    return () => {
      on = false;
    };
  }, []);
  if (!pub) return null;
  const phone = pub.phone?.trim();
  const tax = pub.taxId?.trim();
  return (
    <footer className="px-pubfoot">
      <address>
        <span className="px-pubfoot-name">{t('auth.publisher', { company: publisherName(pub, i18n.language) })}</span>
        {pub.address?.trim() && (
          <span>
            <bdi>{pub.address.trim()}</bdi>
          </span>
        )}
        {(phone || tax) && (
          <span className="px-pubfoot-ids">
            {phone && (
              <span>
                {t('auth.pubPhone')} <bdi dir="ltr">{phone}</bdi>
              </span>
            )}
            {tax && (
              <span>
                {t('auth.pubTax')} <bdi dir="ltr">{tax}</bdi>
              </span>
            )}
          </span>
        )}
      </address>
      <a href="#/conditions">{t('auth.terms')}</a>
    </footer>
  );
}
