import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';

/** what the ad link carried (Meta fills the ids when the ad's « URL parameters » are set: Landing pages › Réglages) */
export function adOf(o: Order) {
  const u = o.utm ?? {};
  const adId = u.ad_id || '';
  const name = o.adName || u.utm_content || '';
  return {
    adId,
    adsetId: u.adset_id || '',
    campaignId: u.campaign_id || '',
    campaign: u.utm_campaign || '',
    name,
    source: u.utm_source || '',
    group: u.g || '',
    placement: u.placement || '',
    fromAd: !!(adId || u.fbclid || u.adset_id || u.campaign_id || u.utm_source),
  };
}

/** a small chip on the order list: which ad brought the order */
export function AdChip({ o }: { o: Order }) {
  const a = adOf(o);
  if (!a.adId && !a.name) return null;
  const label = a.name || `…${a.adId.slice(-6)}`;
  return (
    <span className="chip ad-chip" title={[a.name, a.adId && `ID ${a.adId}`].filter(Boolean).join(' · ')}>
      📣 <span dir="auto">{label.length > 22 ? `${label.slice(0, 21)}…` : label}</span>
    </span>
  );
}

function Copy({ v }: { v: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="icon-btn ad-copy"
      title={t('orders.ad.copy')}
      aria-label={t('orders.ad.copy')}
      onClick={async () => {
        if (await copyText(v)) toast(t('orders.ad.copied'), 'ok');
      }}
    >
      <Icon name="copy" />
    </button>
  );
}

/** the order card: where the order came from (ad, ad set, campaign, group page) */
export function AdSection({ o }: { o: Order }) {
  const { t } = useTranslation();
  const a = adOf(o);
  if (!a.fromAd && !o.source && o.channel !== 'landing') return null;
  const row = (label: string, v: string, copy = false) =>
    v ? (
      <>
        <dt>{label}</dt>
        <dd className="ad-v">
          <span dir="auto" className={copy ? 'ltr' : ''}>
            {v}
          </span>
          {copy && <Copy v={v} />}
        </dd>
      </>
    ) : null;
  return (
    <section className="card">
      <h3>{t('orders.ad.title')}</h3>
      <dl className="kv">
        {row(t('orders.ad.source'), [o.source, a.source && a.source !== o.source ? a.source : ''].filter(Boolean).join(' · '))}
        {row(t('orders.ad.group'), a.group)}
        {row(t('orders.ad.campaign'), a.campaign)}
        {row(t('orders.ad.name'), a.name)}
        {row(t('orders.ad.adId'), a.adId, true)}
        {row(t('orders.ad.adsetId'), a.adsetId, true)}
        {row(t('orders.ad.campaignId'), a.campaignId, true)}
        {row(t('orders.ad.placement'), a.placement)}
      </dl>
      {o.channel === 'landing' && !a.adId && <p className="pd-note" style={{ marginTop: 8 }}>{a.fromAd ? t('orders.ad.noIdAd') : t('orders.ad.noAd')}</p>}
      {a.adId && <p className="muted small" style={{ marginTop: 8 }}>{t('orders.ad.searchHint')}</p>}
    </section>
  );
}

/** abandoned and blocked orders: the ad their customer came from (its id, copied on a tap) */
export function UtmAdChip({ utm }: { utm: Record<string, string> | null | undefined }) {
  const { t } = useTranslation();
  const id = utm?.ad_id || '';
  const name = utm?.utm_content || '';
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
