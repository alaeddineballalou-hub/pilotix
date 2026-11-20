// Meta's « effective_status » of a campaign, an ad set or an ad, in the shop's words (« Campagne en pause »), never
// Meta's own code (CAMPAIGN_PAUSED) on the page. A status Meta adds later is shown in small letters until it has words.
const KNOWN = [
  'ACTIVE',
  'PAUSED',
  'CAMPAIGN_PAUSED',
  'ADSET_PAUSED',
  'ARCHIVED',
  'DELETED',
  'IN_PROCESS',
  'WITH_ISSUES',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'PREAPPROVED',
  'PENDING_BILLING_INFO',
];

export function adStatusLabel(status: string | null | undefined, t: (k: string) => string): string {
  if (!status) return '—';
  const k = status.toUpperCase();
  return KNOWN.includes(k) ? t(`ads.st.${k.toLowerCase()}`) : status.toLowerCase().replace(/_/g, ' ');
}
