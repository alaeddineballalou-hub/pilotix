import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';

/** where the click came from, as people say it (Meta's {{site_source_name}}: fb, ig, msg, an, th) */
const SOURCE_NAMES: Record<string, string> = { fb: 'Facebook', ig: 'Instagram', msg: 'Messenger', an: 'Audience Network', th: 'Threads' };
export const sourceName = (v: string | null | undefined) => {
  const s = String(v ?? '').trim();
  return SOURCE_NAMES[s.toLowerCase()] ?? s;
};

/** a number alone (Meta's own id under utm_*, not a name): shown in its id row, not as the campaign's or ad's name */
const isNumber = (v: string | undefined) => !!v && /^\d{12,20}$/.test(v);

/**
 * what the ad link carried (Meta fills the ids when the ad's « URL parameters » are set: Landing pages › Réglages;
 * without them, Meta's own numbers on the link: the server found the ids from them, `ids` says how)
 */
export function adOf(o: Order) {
  const u = o.utm ?? {};
  const adId = u.ad_id || '';
  const name = o.adName || (isNumber(u.utm_content) ? '' : u.utm_content) || '';
  return {
    adId,
    adsetId: u.adset_id || '',
    campaignId: u.campaign_id || '',
    campaign: isNumber(u.utm_campaign) ? '' : u.utm_campaign || '',
    name,
    ids: u.px_ids || '',
    source: sourceName(u.utm_source),
    group: u.g || '',
    placement: u.placement || '',
    fromAd: !!(adId || u.fbclid || u.adset_id || u.campaign_id || u.utm_source),
  };
}

/** abandoned and blocked orders: the ad their customer came from (its id, copied on a tap) */
export function UtmAdChip({ utm }: { utm: Record<string, string> | null | undefined }) {
  const { t } = useTranslation();
  const id = utm?.ad_id || '';
  const name = isNumber(utm?.utm_content) ? '' : utm?.utm_content || '';
  if (!id && !name) return null;
  return (
    <button
      type="button"
      className="chip ad-chip"
      title={[name, id && `ID ${id}`, t('orders.ad.copy')].filter(Boolean).join(' · ')}
      onClick={async () => {
        if (id && (await copyText(id))) toast(t('orders.ad.copied'), 'ok');
      }}
    >
      📣 <span dir="auto">{name ? (name.length > 22 ? `${name.slice(0, 21)}…` : name) : `ID …${id.slice(-6)}`}</span>
    </button>
  );
}
