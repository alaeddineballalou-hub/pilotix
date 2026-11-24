// « Le chemin de la commande » (24 Nov 2026, the owner's choice 3 of 5): where an order came from and how it was made,
// for every boutique. The order card draws it step by step (the ad, the place, how and by whom, the landing page's
// check, the confirmation); every list shows it as one chip; what Pilotix did by itself carries Pilotix's mark, never
// the first administrator's name. The steps come from orders.origin (core/modules/origin.ts).
import { CONF_TODO, cameOf, makerOf, type ConfStatus, type Order, type OrderCame, type OrderOrigin } from '@pilotix/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { adOf } from './AdSource';
import './orders.css';

type T = (k: string, o?: any) => string;

/** Pilotix's own mark: what Pilotix did by itself (a landing page, Dellal's webhook, the courier's statuses…) */
export function PilotixMark({ size = 14 }: { size?: number }) {
  return <span className="px-mk" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** a history line nobody of the boutique wrote, the customer's own answers aside */
export const pilotixLine = (e: { userId: number | null; userName: string | null; kind: string; toValue: string | null }) =>
  e.userId === null && !e.userName && !(e.kind === 'chat' && e.toValue === 'reply');

/** the chats, as people name them (a Dellal order of Messenger has the « facebook » channel) */
const CHAT_NAME: Record<string, string> = { messenger: 'Messenger', facebook: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp', tiktok: 'TikTok' };
const chatName = (t: T, c: string | null | undefined) => CHAT_NAME[String(c ?? '')] ?? t('orders.path.chatAny');

/** what a person typed it from (the channel he picked) */
const HAND_ICON: Record<string, string> = { appel: 'phone', whatsapp: 'chat', facebook: 'chat', instagram: 'chat', tiktok: 'chat', site: 'store', landing: 'globe', autre: 'pencil' };
const WHERE_ICON: Record<OrderCame, string> = {
  form: 'globe',
  abandoned: 'cart',
  recovered: 'cart',
  restored: 'globe',
  meta_form: 'clipboard',
  chat: 'chat',
  chat_auto: 'chat',
  site: 'store',
  sheet: 'columns',
  hand: 'pencil',
  exchange: 'swap',
  copy: 'copy',
  test: 'settings',
};

/** who made it, as the lists say it: the customer, Dellal, Pilotix or the person */
export function makerName(t: T, o: Pick<Order, 'came' | 'channel' | 'source' | 'isExchange' | 'landingId' | 'creatorName'>): string {
  const m = makerOf(cameOf(o));
  return m === 'person' ? o.creatorName || t('orders.path.someone') : t(`orders.path.maker.${m}`);
}

/** the place, in a word or two (the chip of the lists) */
function whereShort(t: T, o: Order, came: OrderCame): string {
  if (came === 'chat' || came === 'chat_auto') return chatName(t, o.channel);
  if (came === 'hand') return t(`status.channel.${o.channel}`, { defaultValue: o.channel });
  return t(`orders.path.chip.${came}`);
}

/**
 * In every list: the ad the customer came from (when there was one), then the place · who made it — two small chips
 * that go one under the other when the column or the card is narrow, so neither is cut to nothing.
 */
export function OriginChip({ o }: { o: Order }) {
  const { t } = useTranslation();
  const came = cameOf(o);
  const a = adOf(o);
  const label = `${whereShort(t, o, came)} · ${makerName(t, o)}`;
  const ad = a.fromAd ? a.name || t('orders.path.chip.ad') : '';
  const icon = came === 'hand' ? HAND_ICON[o.channel] ?? 'pencil' : WHERE_ICON[came];
  return (
    <span className="px-ocs" title={[ad && `${t('orders.path.chip.ad')} : ${a.name || '—'}`, label].filter(Boolean).join(' › ')}>
      {ad && (
        <span className="chip px-oc px-oc-ad">
          <Icon name="megaphone" />
          <span className="px-oc-w" dir="auto">
            {ad}
          </span>
        </span>
      )}
      <span className="chip px-oc">
        <Icon name={icon} />
        <span className="px-oc-w" dir="auto">
          {label}
        </span>
      </span>
    </span>
  );
}

interface Step {
  icon?: string;
  /** Pilotix's mark instead of an icon */
  mark?: boolean;
  title: string;
  sub?: string | null;
  /** a step Pilotix could not know (no ad found) */
  muted?: boolean;
  action?: ReactNode;
}

function stepsOf(t: T, p: OrderOrigin, more: { seePage: boolean; copyAd: (id: string) => void }): Step[] {
  const out: Step[] = [];
  const someone = t('orders.path.someone');

  // 1. the ad the customer came from
  if (p.ad) {
    const platform = p.ad.platform ?? 'Meta';
    out.push({
      icon: 'megaphone',
      title: p.ad.name ? t('orders.path.ad', { platform, name: p.ad.name }) : t('orders.path.adNoName', { platform }),
      sub: [[p.ad.campaign, p.ad.adset].filter(Boolean).join(' › '), p.ad.ids === 'meta' ? t('orders.ad.fromMeta') : p.ad.ids === 'found' ? t('orders.ad.found') : ''].filter(Boolean).join(' · ') || null,
      action: p.ad.id ? (
        <button type="button" className="px-step-a" onClick={() => more.copyAd(p.ad!.id!)}>
          <Icon name="copy" />
          {t('orders.path.copyId')}
        </button>
      ) : null,
    });
  } else if (p.noAd) out.push({ icon: 'megaphone', muted: true, title: t('orders.path.noAd'), sub: t(p.noAd === 'noIds' ? 'orders.ad.noIdAd' : 'orders.path.noAdNone') });

  // 2. the place it was sent from
  const page = p.page;
  switch (p.came) {
    case 'form':
    case 'abandoned':
    case 'recovered':
    case 'restored':
      out.push({
        icon: page?.group ? 'grid' : 'globe',
        title: page?.group ? t('orders.path.group', { group: page.group }) : page?.slug ? t('orders.path.page', { slug: page.slug }) : t('orders.path.pageAny'),
        sub: p.came === 'abandoned' || p.came === 'recovered' ? t('orders.path.unsent') : null,
        action:
          more.seePage && page?.slug ? (
            <a className="px-step-a" href={page.group ? `#/landing/voir/${page.slug}/${page.group}` : `#/landing/voir/${page.slug}`}>
              <Icon name="eye" />
              {t('orders.path.seePage')}
            </a>
          ) : null,
      });
      break;
    case 'meta_form':
      out.push({ icon: 'clipboard', title: p.form?.name ? t('orders.path.metaForm', { name: p.form.name }) : t('orders.path.metaFormAny'), sub: p.form?.platform ?? null });
      break;
    case 'chat':
    case 'chat_auto':
      out.push({ icon: 'chat', title: t('orders.path.chat', { channel: chatName(t, p.chat?.channel) }), sub: p.chat?.post ? t('orders.path.chatPost', { post: p.chat.post }) : null });
      break;
    case 'site':
      out.push({ icon: 'store', title: p.channelName ? t('orders.path.site', { name: p.channelName }) : t('orders.path.siteAny') });
      break;
    case 'sheet':
      out.push({ icon: 'columns', title: p.channelName ? t('orders.path.sheet', { name: p.channelName }) : t('orders.path.sheetAny') });
      break;
    case 'hand':
      out.push({ icon: HAND_ICON[p.channel] ?? 'pencil', title: t('orders.path.channel', { channel: t(`status.channel.${p.channel}`, { defaultValue: p.channel }) }) });
      break;
    case 'exchange':
      out.push({ icon: 'swap', title: p.from?.ref ? t('orders.path.exchangeOf', { ref: p.from.ref }) : t('orders.path.exchangeAny'), sub: p.from?.ticket ? t('orders.path.ticket', { ticket: p.from.ticket }) : null });
      break;
    case 'copy':
      out.push({ icon: 'copy', title: p.from?.ref ? t('orders.path.copyOf', { ref: p.from.ref }) : t('orders.path.copyAny') });
      break;
    case 'test':
      out.push({ icon: 'settings', title: t('orders.path.test') });
      break;
  }

  // 3. how it was made, by whom, when
  const maker = makerOf(p.came);
  out.push({
    ...(maker === 'pilotix' ? { mark: true } : { icon: maker === 'client' ? 'user' : maker === 'dellal' ? 'sparkles' : 'pencil' }),
    title: t(`orders.path.how.${p.came}`, { by: p.by ?? someone }),
    sub: when(p.at),
  });

  // 4. the landing page's fake-order check
  if (p.check) out.push({ mark: true, title: t(`orders.path.check.${p.check.verdict}`, { score: p.check.score }) });

  // 5. where the confirmation stands
  if (p.conf) {
    const status = t(`status.conf.${p.conf.status}`, { defaultValue: p.conf.status });
    if (CONF_TODO.includes(p.conf.status as ConfStatus)) out.push({ icon: 'headset', muted: true, title: t('orders.path.conf.todo', { status }) });
    else {
      const auto = !p.conf.by;
      const by = p.conf.by ?? (p.came === 'chat' || p.came === 'chat_auto' ? t('orders.path.maker.dellal') : t('orders.path.maker.pilotix'));
      out.push({ ...(auto && !(p.came === 'chat' || p.came === 'chat_auto') ? { mark: true } : { icon: auto ? 'sparkles' : 'headset' }), title: t('orders.path.conf.done', { status, by }), sub: p.conf.at ? when(p.conf.at) : null });
    }
  }
  return out;
}

/** The order card: « Le chemin de la commande », step by step. */
export function PathSection({ o }: { o: Order }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const q = useRpc('orders.origin', { id: o.id }, { placeholderData: undefined });
  const p = q.data;
  if (!p) return null;
  const roles = session?.roles ?? [];
  // the page as the customer saw it, inside Pilotix (never its public address: a visit there would count)
  const seePage = !!session && (session.isAdmin || roles.includes('marketer') || roles.includes('vendeur'));
  const copyAd = async (id: string) => {
    if (await copyText(id)) toast(t('orders.ad.copied'), 'ok');
  };
  const steps = stepsOf(t, p, { seePage, copyAd });
  return (
    <section className="card px-path">
      <h3>{t('orders.path.title')}</h3>
      <ol className="px-steps">
        {steps.map((s, k) => (
          <li key={k} className={s.muted ? 'px-step muted-step' : 'px-step'}>
            <span className="px-dot" aria-hidden="true">
              {s.mark ? <PilotixMark size={18} /> : <Icon name={s.icon ?? 'help'} />}
            </span>
            <div className="px-step-b">
              <span className="px-step-t" dir="auto">
                {s.title}
              </span>
              {s.sub && (
                <span className="px-step-s" dir="auto">
                  {s.sub}
                </span>
              )}
              {s.action}
            </div>
          </li>
        ))}
      </ol>
      <p className="px-next">{t('orders.path.next')}</p>
    </section>
  );
}
