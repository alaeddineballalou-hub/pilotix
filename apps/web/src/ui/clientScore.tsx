// The customer's score out of 100 (core: modules/clientscore.ts): a chip in lists and on an order, and the card that
// says why — every reason with the points it added or took off.
import type { ClientScore } from '@pilotix/core';
import { useTranslation } from 'react-i18next';
import './clientScore.css';

/** « 85/100 · Très fiable », coloured by level. A new customer (nothing known yet) shows no chip in the order lists —
 *  a grey badge on most rows said nothing and hid the ones that matter; the Clients page asks for it with `showNew`. */
export function ScoreChip({ s, short, showNew }: { s: Pick<ClientScore, 'score' | 'level'>; short?: boolean; showNew?: boolean }) {
  const { t } = useTranslation();
  if (s.level === 'new' && !showNew) return null;
  return (
    <span className={`cs-chip cs-${s.level}${short ? ' short' : ''}`} title={`${t(`clients.score.level.${s.level}`)} — ${t('clients.score.help')}`}>
      <b className="ltr">{s.score}</b>
      <small className="ltr">/100</small>
      {!short && <span>{t(`clients.score.level.${s.level}`)}</span>}
    </span>
  );
}

/** the score, its level, and each reason (green when it added, red when it took off) */
export function ScoreCard({ s, compact }: { s: ClientScore; compact?: boolean }) {
  const { t } = useTranslation();
  const reasons = compact ? s.reasons.slice(0, 3) : s.reasons;
  return (
    <div className={`cs-card cs-${s.level}${compact ? ' compact' : ''}`}>
      <div className="cs-head">
        <span className="cs-big ltr">
          {s.score}
          <small>/100</small>
        </span>
        <span className="cs-lv">
          <b>{t(`clients.score.level.${s.level}`)}</b>
          <small>{t(`clients.score.say.${s.level}`)}</small>
        </span>
        <span className="cs-meter" aria-hidden="true">
          <i style={{ width: `${s.score}%` }} />
        </span>
      </div>
      <ul className="cs-why">
        {reasons.map((r) => (
          <li key={r.code} className={r.points > 0 ? 'up' : r.points < 0 ? 'down' : ''}>
            <span className="ltr">{r.points > 0 ? `+${r.points}` : r.points < 0 ? `−${-r.points}` : '·'}</span>
            <span>{t(`clients.score.why.${r.code}`, { count: r.n })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
