// Banner above every page for confirmation agents (#bj-alert): late calls, night orders,
// calls of the current slot, and the next order with its countdown. Refreshed about every 55 s.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { Countdown } from './Countdown';

export function AgentBanner() {
  const { t } = useTranslation();
  const q = useRpc('confirmation.banner', {}, { refetchInterval: 55_000, refetchOnWindowFocus: true });
  const b = q.data;
  if (!b || (!b.late && !b.now && !b.fresh && !b.night)) return null;
  const bad = b.late > 0 || b.firstLate > 0;
  const title = bad
    ? t('confirmation.banner.late')
    : !b.fresh && !b.now && b.night
      ? t('confirmation.banner.night')
      : t('confirmation.banner.todo') + (b.slot ? ` · ${t('confirmation.banner.slot', { name: t(`confirmation.slot.${b.slot.key}`, { defaultValue: b.slot.key }), h: b.slot.to })}` : '');
  const parts = [
    b.fresh ? t('confirmation.banner.fresh', { count: b.fresh }) + (b.firstLate ? ` (${t('confirmation.banner.firstLate', { n: b.firstLate })})` : '') : null,
    b.now ? t('confirmation.banner.now', { count: b.now }) : null,
    b.late ? t('confirmation.banner.missed', { count: b.late }) : null,
    b.night ? `🌙 ${t('confirmation.banner.nightTxt', { count: b.night, h: b.nightFrom })}` : null,
  ].filter(Boolean);
  const href = b.fresh && !b.now && !b.late ? '#/confirmation/nouvelles' : '#/confirmation/attente';
  return (
    <div id="bj-alert" className={`bj-alert ${bad ? 'bad' : ''}`} role="status">
      <span className="bj-al-ic" aria-hidden="true">
        📞
      </span>
      <div className="bj-al-t">
        <b>{title}</b>
        <span>{parts.join(' · ')}</span>
      </div>
      {b.next?.deadline && (
        <div className="bj-al-next">
          <small>{t('confirmation.banner.next', { ref: b.next.ref })}</small>
          <Countdown d={b.next.deadline} />
        </div>
      )}
      <a className="btn small primary" href={href}>
        {t('confirmation.call')}
      </a>
    </div>
  );
}
