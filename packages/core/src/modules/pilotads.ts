// Pilot Ads, the rules with no database and no network: what Pilotix sends to Meta to launch an ad (Marketing API v26),
// what a delivered order may cost, the budgets it suggests, the owner's limits, and Pilote auto's rules. The procs in
// ./adsmgr.ts and ./adslaunch.ts use them; the tests check them one by one.
//
// Safety, everywhere: every campaign, ad set and ad is created PAUSED, and only « Lancer » turns them on; a dollar
// amount is always in the ad account's own money, in cents (Meta's "offset 100", USD and DZD alike).

export const GOALS = ['sales', 'messages', 'calls', 'form', 'awareness', 'traffic', 'engagement'] as const;
export type Goal = (typeof GOALS)[number];
/** the five goals of the simple mode; traffic and engagement are in the pro mode only */
export const SIMPLE_GOALS: readonly Goal[] = ['sales', 'messages', 'calls', 'form', 'awareness'];
export const CHANNELS = ['messenger', 'instagram', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Meta's names for each goal: the campaign objective, where people go, what Meta looks for, the ad's button. */
export const GOAL_META: Record<Goal, { objective: string; destination: string | null; optimization: string; cta: string }> = {
  sales: { objective: 'OUTCOME_SALES', destination: 'WEBSITE', optimization: 'OFFSITE_CONVERSIONS', cta: 'SHOP_NOW' },
  messages: { objective: 'OUTCOME_ENGAGEMENT', destination: 'MESSENGER', optimization: 'CONVERSATIONS', cta: 'MESSAGE_PAGE' },
  calls: { objective: 'OUTCOME_LEADS', destination: 'PHONE_CALL', optimization: 'QUALITY_CALL', cta: 'CALL_NOW' },
  form: { objective: 'OUTCOME_LEADS', destination: 'ON_AD', optimization: 'LEAD_GENERATION', cta: 'SIGN_UP' },
  awareness: { objective: 'OUTCOME_AWARENESS', destination: null, optimization: 'REACH', cta: 'LEARN_MORE' },
  traffic: { objective: 'OUTCOME_TRAFFIC', destination: 'WEBSITE', optimization: 'LANDING_PAGE_VIEWS', cta: 'LEARN_MORE' },
  engagement: { objective: 'OUTCOME_ENGAGEMENT', destination: 'ON_POST', optimization: 'POST_ENGAGEMENT', cta: 'LEARN_MORE' },
};

/** The ad's link carries its ids: the landing page keeps them on the order, so each order knows its ad (and marketer). */
export const URL_TAGS = 'utm_source=facebook&utm_medium=paid&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}';

/**
 * Meta's automatic changes to the ad: only those that keep the shop's own words and prices (lighting, cropping to each
 * placement). The ones that rewrite the text, invent a background or add stickers stay off (they can change a price).
 */
export const SAFE_CREATIVE = {
  creative_features_spec: {
    adapt_to_placement: { enroll_status: 'OPT_IN' },
    image_touchups: { enroll_status: 'OPT_IN' },
    text_optimizations: { enroll_status: 'OPT_OUT' },
    image_templates: { enroll_status: 'OPT_OUT' },
    image_uncrop: { enroll_status: 'OPT_OUT' },
    image_background_gen: { enroll_status: 'OPT_OUT' },
    image_animation: { enroll_status: 'OPT_OUT' },
    enhance_cta: { enroll_status: 'OPT_OUT' },
    inline_comment: { enroll_status: 'OPT_OUT' },
    video_uncrop: { enroll_status: 'OPT_OUT' },
  },
} as const;

export interface LaunchMedia {
  kind: 'photo' | 'video';
  /**
   * In the shop's library (cm_media): a photo goes to Meta as its bytes (Meta needs no address to download it), and a
   * video's still too.
   */
  mediaId?: number | null;
  /** a video: the public address Meta downloads it from; a photo outside the library: its address */
  url?: string | null;
  /** a video's still (its first picture), when it is not in the library */
  thumb?: string | null;
  name: string;
}
export interface LaunchInput {
  goal: Goal;
  name: string;
  pageId: string;
  instagramId?: string | null;
  pixelId?: string | null;
  /** the landing page (sales, traffic; awareness when there is one) */
  link?: string | null;
  /** calls: +213… */
  phone?: string | null;
  /** form: the instant form, made on the Page just before */
  formId?: string | null;
  /** engagement: an existing post of the Page (page_post) */
  postId?: string | null;
  channels?: Channel[];
  /** messages on WhatsApp: the shop's WhatsApp Business number (+213…), when the Page has more than one */
  whatsappNumber?: string | null;
  welcome?: { text: string; questions: string[] } | null;
  text: { primary: string; headline: string };
  media: LaunchMedia[];
  /** per day, in the account's money, in cents: for the campaign (Advantage+ budget) or for each ad set */
  budgetCents: number;
  budgetLevel: 'campaign' | 'adset';
  /** one ad set per photo / video (a test of the créas), or all the ads in one ad set */
  split: 'one' | 'perMedia';
  /** Meta's region keys of the wilayas kept; empty = all of Algeria */
  regions: string[];
  /** Meta's region keys of the wilayas left out (parcels that do not arrive there) */
  excludeRegions?: string[];
  ageMin: number;
  ageMax: number;
  /** 1 men, 2 women; empty = everyone */
  genders: number[];
  advantageAudience: boolean;
  excludeAudiences: string[];
  includeAudiences: string[];
  bid?: { strategy: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP'; amountCents?: number | null } | null;
  /** start (ISO); none = as soon as it is turned on */
  start?: string | null;
}
export interface LaunchPlan {
  /** photos (and videos' stills) sent as bytes first: `{image:k}` becomes Meta's image hash */
  images: { key: string; mediaId: number; col: 'jpeg' | 'thumb' }[];
  campaign: Record<string, unknown>;
  adsets: { key: string; body: Record<string, unknown> }[];
  creatives: { key: string; body: Record<string, unknown>; video?: { key: string; url: string } }[];
  ads: { key: string; adset: string; creative: string; body: Record<string, unknown> }[];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** What the input misses for its goal (French, for the person): nothing is sent to Meta while one is left. */
export function launchProblems(i: LaunchInput): string[] {
  const out: string[] = [];
  if (!i.pageId) out.push('Reliez la Page Facebook de la boutique (Pilot AI › Comptes).');
  if (!i.media.length && i.goal !== 'engagement') out.push('Choisissez au moins une photo ou une vidéo.');
  if (i.media.length > 10) out.push('10 photos ou vidéos au plus par lancement.');
  if (i.media.some((m) => m.kind === 'video' && !m.url)) out.push('Une vidéo n’est pas encore prête (envoi en cours) : attendez la fin.');
  if (i.media.some((m) => m.kind === 'photo' && !m.mediaId && !m.url)) out.push('Une photo est introuvable : choisissez-la à nouveau.');
  if (i.goal !== 'engagement' && !i.text.primary.trim()) out.push('Écrivez le texte de la pub.');
  if (i.text.primary.length > 2000) out.push('Le texte de la pub est trop long (2 000 caractères au plus).');
  if ((i.goal === 'sales' || i.goal === 'traffic') && !i.link) out.push('Ce produit n’a pas de page de vente : créez-la d’abord (Landing pages).');
  if (i.goal === 'sales' && !i.pixelId) out.push('Ajoutez un pixel Meta (Landing pages › Réglages › Pixels) : Meta doit savoir qui achète.');
  if (i.goal === 'calls' && !/^\+213[5-7]\d{8}$/.test(i.phone ?? '')) out.push('Le numéro à appeler doit être un numéro algérien (+213 5, 6 ou 7…).');
  if (i.goal === 'form' && !i.formId && !i.media.length) out.push('Le formulaire n’est pas prêt.');
  if (i.goal === 'engagement' && !i.postId) out.push('Choisissez la publication à booster.');
  if (i.goal === 'messages' && !(i.channels ?? []).length) out.push('Choisissez où les clients écrivent : Messenger, Instagram ou WhatsApp.');
  if (i.budgetCents < 100) out.push('Le budget est trop petit : 1 $ par jour au moins.');
  if (i.ageMin < 18 || i.ageMax > 65 || i.ageMin > i.ageMax) out.push('L’âge va de 18 à 65 ans.');
  if (i.bid && i.bid.strategy !== 'LOWEST_COST_WITHOUT_CAP' && !(i.bid.amountCents && i.bid.amountCents > 0)) out.push('Donnez le coût visé (en cents) pour cette stratégie.');
  return out;
}

/** Meta's welcome message in Messenger (with up to 3 ready questions under it). */
export function welcomeOf(w: { text: string; questions: string[] }): string {
  return JSON.stringify({
    type: 'VISUAL_EDITOR',
    version: 2,
    landing_screen_type: 'welcome_message',
    media_type: 'text',
    text_format: {
      customer_action_type: 'ice_breakers',
      message: { text: clip(w.text, 300), ice_breakers: w.questions.slice(0, 3).filter(Boolean).map((q) => ({ title: clip(q, 80), response: '' })), quick_replies: [] },
    },
    user_edit: false,
    surface: 'visual_editor_new',
  });
}

const MESSAGE_CTA: Record<Channel, { type: string; value: { app_destination: string; link?: string } }> = {
  messenger: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER', link: 'https://fb.com/messenger_doc/' } },
  instagram: { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT', link: 'https://www.instagram.com' } },
  whatsapp: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP', link: 'https://api.whatsapp.com/send' } },
};
/** Meta's destination for the chat apps chosen (several: Meta sends each person to the one they answer in). */
export function messageDestination(channels: Channel[]): string {
  const c = new Set(channels);
  const ig = c.has('instagram'), ms = c.has('messenger'), wa = c.has('whatsapp');
  if (ig && ms && wa) return 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP';
  if (ig && ms) return 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER';
  if (ms && wa) return 'MESSAGING_MESSENGER_WHATSAPP';
  if (ig && wa) return 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP';
  return ig ? 'INSTAGRAM_DIRECT' : wa ? 'WHATSAPP' : 'MESSENGER';
}

/**
 * Everything Pilotix sends to Meta for one launch, in order: one campaign, its ad sets, the créas and the ads, all
 * PAUSED. `{campaign}`, `{adset:k}`, `{creative:k}` and `{video:k}` are replaced by Meta's ids as they come back.
 */
export function metaPlan(i: LaunchInput): LaunchPlan {
  const g = GOAL_META[i.goal];
  const channels: Channel[] = i.goal === 'messages' ? (i.channels?.length ? i.channels : ['messenger']) : [];
  const destination = i.goal === 'messages' ? messageDestination(channels) : g.destination;
  const multi = channels.length > 1;
  const campaign: Record<string, unknown> = {
    name: clip(i.name, 200),
    objective: g.objective,
    status: 'PAUSED',
    buying_type: 'AUCTION',
    special_ad_categories: [],
  };
  if (i.budgetLevel === 'campaign') {
    campaign.daily_budget = i.budgetCents;
    campaign.bid_strategy = i.bid?.strategy ?? 'LOWEST_COST_WITHOUT_CAP';
  } else campaign.is_adset_budget_sharing_enabled = false;

  const targeting: Record<string, unknown> = {
    geo_locations: i.regions.length ? { regions: i.regions.map((key) => ({ key })) } : { countries: ['DZ'] },
    age_min: i.ageMin,
    age_max: i.ageMax,
    targeting_automation: { advantage_audience: i.advantageAudience ? 1 : 0 },
  };
  if (i.excludeRegions?.length) targeting.excluded_geo_locations = { regions: i.excludeRegions.map((key) => ({ key })) };
  if (i.genders.length && i.genders.length < 2) targeting.genders = i.genders;
  if (i.includeAudiences.length) targeting.custom_audiences = i.includeAudiences.map((id) => ({ id }));
  if (i.excludeAudiences.length) targeting.excluded_custom_audiences = i.excludeAudiences.map((id) => ({ id }));

  const promoted: Record<string, unknown> | null =
    i.goal === 'sales'
      ? { pixel_id: i.pixelId, custom_event_type: 'PURCHASE' }
      : i.goal === 'traffic' || i.goal === 'awareness'
        ? null
        : { page_id: i.pageId, ...(i.goal === 'messages' && channels.includes('whatsapp') && i.whatsappNumber ? { whatsapp_phone_number: i.whatsappNumber } : {}) };
  const images: LaunchPlan['images'] = [];

  const adsetBody = (name: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      name: clip(name, 200),
      campaign_id: '{campaign}',
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: g.optimization,
      targeting,
    };
    if (destination) b.destination_type = destination;
    if (promoted) b.promoted_object = promoted;
    if (i.budgetLevel === 'adset') {
      b.daily_budget = i.budgetCents;
      b.bid_strategy = i.bid?.strategy ?? 'LOWEST_COST_WITHOUT_CAP';
    }
    if (i.bid && i.bid.strategy !== 'LOWEST_COST_WITHOUT_CAP' && i.bid.amountCents) b.bid_amount = i.bid.amountCents;
    if (i.start) b.start_time = i.start;
    return b;
  };

  const story = (m: LaunchMedia, key: string): { body: Record<string, unknown>; video?: { key: string; url: string } } => {
    const cta: Record<string, unknown> =
      i.goal === 'messages'
        ? MESSAGE_CTA[channels[0]]
        : i.goal === 'calls'
          ? { type: 'CALL_NOW', value: { link: `tel:${i.phone}` } }
          : i.goal === 'form'
            ? { type: g.cta, value: { lead_gen_form_id: i.formId ?? '{form}', link: 'http://fb.me/' } }
            : { type: g.cta, value: { link: i.link ?? `https://www.facebook.com/${i.pageId}` } };
    const link = i.goal === 'messages' ? (MESSAGE_CTA[channels[0]].value.link as string) : i.goal === 'calls' ? `tel:${i.phone}` : i.goal === 'form' ? 'http://fb.me/' : (i.link ?? `https://www.facebook.com/${i.pageId}`);
    const welcome = i.goal === 'messages' && i.welcome && channels.includes('messenger') ? { page_welcome_message: welcomeOf(i.welcome) } : {};
    const spec: Record<string, unknown> = { page_id: i.pageId };
    if (i.instagramId) spec.instagram_user_id = i.instagramId;
    let video: { key: string; url: string } | undefined;
    if (m.kind === 'video') {
      video = { key, url: m.url ?? '' };
      // Meta wants a still for every video ad: the library's own, sent as bytes, else its address
      let still: Record<string, string> = {};
      if (m.mediaId) {
        images.push({ key: `t${key}`, mediaId: m.mediaId, col: 'thumb' });
        still = { image_hash: `{image:t${key}}` };
      } else if (m.thumb) still = { image_url: m.thumb };
      spec.video_data = { video_id: `{video:${key}}`, ...still, message: i.text.primary, title: clip(i.text.headline, 100), call_to_action: cta, ...welcome };
    } else {
      let pic: Record<string, string> = { picture: m.url ?? '' };
      if (m.mediaId) {
        images.push({ key: `p${key}`, mediaId: m.mediaId, col: 'jpeg' });
        pic = { image_hash: `{image:p${key}}` };
      }
      spec.link_data = { link, message: i.text.primary, name: clip(i.text.headline, 100), ...pic, call_to_action: cta, ...welcome };
    }
    const body: Record<string, unknown> = { name: clip(`${i.name} · ${m.name}`, 200), object_story_spec: spec, degrees_of_freedom_spec: SAFE_CREATIVE };
    if (i.goal === 'sales' || i.goal === 'traffic' || i.goal === 'awareness') body.url_tags = URL_TAGS;
    if (multi) body.asset_feed_spec = { optimization_type: 'DOF_MESSAGING_DESTINATION', call_to_actions: channels.map((c) => MESSAGE_CTA[c]) };
    return { body, video };
  };

  const adsets: LaunchPlan['adsets'] = [];
  const creatives: LaunchPlan['creatives'] = [];
  const ads: LaunchPlan['ads'] = [];
  if (i.goal === 'engagement') {
    adsets.push({ key: 'a0', body: adsetBody(i.name) });
    creatives.push({ key: 'c0', body: { name: clip(`${i.name} · publication`, 200), object_story_id: i.postId, degrees_of_freedom_spec: SAFE_CREATIVE } });
    ads.push({ key: 'd0', adset: 'a0', creative: 'c0', body: { name: clip(i.name, 200), status: 'PAUSED' } });
  } else {
    const perMedia = i.split === 'perMedia' && i.media.length > 1;
    if (!perMedia) adsets.push({ key: 'a0', body: adsetBody(i.name) });
    i.media.forEach((m, n) => {
      const a = perMedia ? `a${n}` : 'a0';
      if (perMedia) adsets.push({ key: a, body: adsetBody(`${i.name} · ${m.name}`) });
      const c = story(m, `v${n}`);
      creatives.push({ key: `c${n}`, body: c.body, ...(c.video ? { video: c.video } : {}) });
      ads.push({ key: `d${n}`, adset: a, creative: `c${n}`, body: { name: clip(`${i.name} · ${m.name}`, 200), status: 'PAUSED' } });
    });
  }
  return { images, campaign, adsets, creatives, ads };
}

// ---------------------------------------------------------------- what a delivered order may cost
/**
 * From the product's own numbers: what one delivered order leaves before ads (price − purchase − delivery − agent),
 * and its share of orders that end delivered. `max` is the most ads may cost per delivered order before losing money;
 * Pilotix aims at 70 % of it (where Publicité already says « Augmenter »).
 */
export function limitOf(perDeliveredDzd: number, rate: number | null): { maxDzd: number; targetDzd: number; maxUsd: number | null; targetUsd: number | null } {
  const maxDzd = Math.max(0, Math.round(perDeliveredDzd));
  const targetDzd = Math.round(maxDzd * 0.7);
  return { maxDzd, targetDzd, maxUsd: rate ? Math.round((maxDzd / rate) * 100) / 100 : null, targetUsd: rate ? Math.round((targetDzd / rate) * 100) / 100 : null };
}

/** Three budgets to start (dollars per day) with the delivered orders each may bring, at the target cost. */
export function budgetPacks(targetUsd: number | null): { key: 'test' | 'best' | 'fast'; usd: number; delivered: number | null }[] {
  const packs = [
    { key: 'test' as const, usd: 5 },
    { key: 'best' as const, usd: 10 },
    { key: 'fast' as const, usd: 20 },
  ];
  return packs.map((p) => ({ ...p, delivered: targetUsd && targetUsd > 0 ? Math.round((p.usd / targetUsd) * 10) / 10 : null }));
}

// ---------------------------------------------------------------- the owner's limits
export interface Guard {
  /** the most all the shop's ads may spend per day, in dollars (Pilotix refuses a raise above it) */
  maxDailyUsd: number | null;
  /** a marketer's raise above this % at once waits for the owner's yes */
  maxRaisePct: number;
  /** a marketer's new budget above this (dollars per day) waits for the owner's yes */
  yesAboveUsd: number | null;
  /** every launch by a marketer waits for the owner's yes */
  launchYes: boolean;
  /** « Tout arrêter »: nothing starts again while it is on */
  stopped: boolean;
}
export const DEFAULT_GUARD: Guard = { maxDailyUsd: 100, maxRaisePct: 30, yesAboveUsd: 30, launchYes: false, stopped: false };
/** Meta lets an ad set's budget change 4 times an hour; Pilotix stays under it. */
export const BUDGET_CHANGES_PER_HOUR = 4;

export type GuardVerdict = { ok: true; needsYes: boolean; why: string | null } | { ok: false; why: string };
/**
 * Whether a change may go, and whether it waits for the owner. Pausing is always allowed (it only stops spending);
 * starting again is refused while « Tout arrêter » is on; a raise is checked against the limits.
 */
export function checkChange(
  g: Guard,
  c: { op: 'pause' | 'resume' | 'budget' | 'copy'; owner: boolean; fromUsd: number | null; toUsd: number | null; shopDailyUsd: number; changesLastHour: number },
): GuardVerdict {
  if (c.op === 'pause') return { ok: true, needsYes: false, why: null };
  if (g.stopped && (c.op === 'resume' || c.op === 'copy' || (c.op === 'budget' && (c.toUsd ?? 0) > (c.fromUsd ?? 0)))) return { ok: false, why: 'Tout est arrêté par le propriétaire : il doit d’abord tout relancer.' };
  if (c.op === 'budget') {
    if (c.toUsd === null || c.toUsd <= 0) return { ok: false, why: 'Budget invalide.' };
    if (c.changesLastHour >= BUDGET_CHANGES_PER_HOUR) return { ok: false, why: 'Meta n’accepte que 4 changements de budget par heure sur un ad set : réessayez plus tard.' };
    const raise = c.fromUsd && c.toUsd > c.fromUsd ? (c.toUsd - c.fromUsd) / c.fromUsd : 0;
    const total = c.shopDailyUsd - (c.fromUsd ?? 0) + c.toUsd;
    if (g.maxDailyUsd !== null && total > g.maxDailyUsd && c.toUsd > (c.fromUsd ?? 0))
      return c.owner ? { ok: true, needsYes: false, why: `Au-dessus de la limite du jour (${g.maxDailyUsd} $).` } : { ok: false, why: `La boutique dépenserait ${Math.round(total)} $ par jour : la limite est ${g.maxDailyUsd} $.` };
    if (c.owner) return { ok: true, needsYes: false, why: null };
    if (raise * 100 > g.maxRaisePct) return { ok: true, needsYes: true, why: `Hausse de ${Math.round(raise * 100)} % : au-dessus de ${g.maxRaisePct} %, le propriétaire dit oui.` };
    if (g.yesAboveUsd !== null && c.toUsd > g.yesAboveUsd) return { ok: true, needsYes: true, why: `Plus de ${g.yesAboveUsd} $ par jour : le propriétaire dit oui.` };
    return { ok: true, needsYes: false, why: null };
  }
  return { ok: true, needsYes: false, why: null };
}

// ---------------------------------------------------------------- Pilote auto
export const RULE_KEYS = ['stop', 'scale', 'trim', 'confirm', 'deliver', 'tired', 'cap'] as const;
export type RuleKey = (typeof RULE_KEYS)[number];
export type RuleMode = 'off' | 'suggest' | 'auto';
/** the rules that may act alone (they only lower spending); the others always ask */
export const AUTO_RULES: readonly RuleKey[] = ['stop', 'trim', 'cap', 'scale'];
export const DEFAULT_RULES: Record<RuleKey, RuleMode> = { stop: 'suggest', scale: 'suggest', trim: 'suggest', confirm: 'suggest', deliver: 'suggest', tired: 'suggest', cap: 'auto' };
/** a budget Pilote auto changed is left alone this long (Meta learns again after a change) */
export const RULE_COOLDOWN_H = 72;
/** automatic changes per day for the whole shop */
export const AUTO_PER_DAY = 5;

export interface AdsetStats {
  id: string;
  name: string;
  status: string | null;
  /** daily budget in dollars (null: the campaign holds it) */
  budgetUsd: number | null;
  /** the last 3 days, then the last 7 */
  spend3Usd: number;
  spend7Usd: number;
  orders3: number;
  orders7: number;
  /** the product's numbers (its orders over 30 days): delivered, returned, cancelled, received */
  received: number;
  delivered: number;
  returned: number;
  cancelled: number;
  /** what a delivered order leaves before ads (DZD) */
  perDeliveredDzd: number | null;
  rate: number | null;
  /** Publicité's diagnostic (hook, fatigue, audience…) */
  diag: string | null;
  changedHoursAgo: number | null;
}
export interface Suggestion {
  rule: RuleKey;
  objectId: string;
  objectName: string;
  op: 'pause' | 'budget' | 'creative' | 'copy' | 'check';
  /** budget: the new daily budget in dollars */
  value: number | null;
  /** the numbers the sentence uses */
  why: Record<string, number | string | null>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
/**
 * Pilote auto's rules on one ad set, with the shop's real numbers (delivered orders, not Meta's purchases). One
 * suggestion at most per ad set, the most urgent first: stop the loss, then the delivery and the confirmation
 * problems, then trim, tired créas, and last the raise.
 */
export function suggestFor(s: AdsetStats): Suggestion | null {
  if (s.status && s.status !== 'ACTIVE') return null;
  const base = { objectId: s.id, objectName: s.name };
  const k = s.received ? s.delivered / s.received : 0;
  const maxPerOrderUsd = s.perDeliveredDzd && s.rate ? (s.perDeliveredDzd * (k || 0.5)) / s.rate : null;
  // 1. stop-loss: 2 × what an order may cost spent in 3 days with no order (or 8 $ without numbers yet)
  const stopAt = maxPerOrderUsd ? Math.max(3, 2 * maxPerOrderUsd) : 8;
  if (s.spend3Usd >= stopAt && s.orders3 === 0) return { ...base, rule: 'stop', op: 'pause', value: null, why: { spend: round1(s.spend3Usd), days: 3, orders: 0, limit: round1(stopAt) } };
  const settled = s.delivered + s.returned;
  // 2. parcels that do not arrive: under 55 % delivered on 15 settled parcels at least
  if (settled >= 15 && s.delivered / settled < 0.55) return { ...base, rule: 'deliver', op: 'check', value: null, why: { delivered: s.delivered, settled, rate: Math.round((s.delivered / settled) * 100) } };
  // 3. buyers who say no on the phone: under 35 % confirmed on 20 orders at least
  if (s.received >= 20 && (s.received - s.cancelled) / s.received < 0.35) return { ...base, rule: 'confirm', op: 'check', value: null, why: { yes: s.received - s.cancelled, received: s.received, rate: Math.round(((s.received - s.cancelled) / s.received) * 100) } };
  const cpo7 = s.orders7 ? s.spend7Usd / s.orders7 : null;
  // 4. trim: an order costs more than it may (7 days), the budget goes down 20 %
  if (maxPerOrderUsd && cpo7 !== null && cpo7 > maxPerOrderUsd && s.budgetUsd) return { ...base, rule: 'trim', op: 'budget', value: round1(s.budgetUsd * 0.8), why: { cost: round1(cpo7), limit: round1(maxPerOrderUsd), from: s.budgetUsd } };
  // 5. tired créas or audience (Publicité's diagnostic)
  if (s.diag === 'fatigue' || s.diag === 'hook') return { ...base, rule: 'tired', op: 'creative', value: null, why: { diag: s.diag } };
  if (s.diag === 'audience') return { ...base, rule: 'tired', op: 'copy', value: null, why: { diag: s.diag } };
  // 6. scale: an order costs half of what it may or less, 10 orders in 7 days, no change for 72 h
  const quiet = s.changedHoursAgo === null || s.changedHoursAgo >= RULE_COOLDOWN_H;
  if (maxPerOrderUsd && cpo7 !== null && s.orders7 >= 10 && cpo7 <= maxPerOrderUsd * 0.5 && s.budgetUsd && quiet)
    return { ...base, rule: 'scale', op: 'budget', value: round1(s.budgetUsd * 1.2), why: { cost: round1(cpo7), limit: round1(maxPerOrderUsd), from: s.budgetUsd, orders: s.orders7 } };
  return null;
}

// ---------------------------------------------------------------- audiences
/** An Algerian phone as Meta wants it before hashing: digits, the country code, no 0 (0797… → 213797…). */
export function metaPhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (/^0[5-7]\d{8}$/.test(d)) return `213${d.slice(1)}`;
  if (/^213[5-7]\d{8}$/.test(d)) return d;
  if (/^00213[5-7]\d{8}$/.test(d)) return d.slice(2);
  return null;
}
export const AUDIENCE_KINDS = ['returners', 'fake', 'buyers', 'lookalike'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];
/** by default the ads skip people who returned a parcel or gave a fake order; buyers are welcome again */
export const AUDIENCE_DEFAULT_ON: Record<AudienceKind, boolean> = { returners: true, fake: true, buyers: false, lookalike: false };
