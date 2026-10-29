// The customer's score out of 100 (core: modules/clientscore.ts): a chip in lists and on an order, and the card that
// says why — every reason with the points it added or took off.
import { CLIENT_LEVELS, type ClientLevel, type ClientReason, type ClientScore } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './kit';
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

/** Tous · Très fiable · Fiable · À surveiller · Risqué · Nouveau — one at a time, the chosen one wears its level's colour */
export function LevelPicker({ value, onChange, className = '' }: { value: ClientLevel | undefined; onChange: (v: ClientLevel | undefined) => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`cs-levels ${className}`} role="group" aria-label={t('clients.score.filter')}>
      <button type="button" className={`cs-lvbtn cs-all${!value ? ' on' : ''}`} aria-pressed={!value} onClick={() => onChange(undefined)}>
        {t('clients.score.allLevels')}
      </button>
      {CLIENT_LEVELS.map((l) => (
        <button key={l} type="button" className={`cs-lvbtn cs-${l}${value === l ? ' on' : ''}`} aria-pressed={value === l} onClick={() => onChange(value === l ? undefined : l)}>
          <i aria-hidden="true" />
          {t(`clients.score.level.${l}`)}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- before confirming a risky customer
/** what an order carries about its customer (orders.list, confirmation.list, orders.get) */
type RiskOrder = { ref: string; clientScore?: { score: number; level: ClientLevel; reasons?: ClientReason[] } | null };
let asking: { o: RiskOrder; resolve: (ok: boolean) => void } | null = null;
const listeners = new Set<() => void>();
const ping = () => listeners.forEach((f) => f());

/**
 * Before confirming: a « Risqué » customer shows why (the reasons of the score) and the agent chooses — it never blocks
 * on its own. Resolves true at once for every other customer.
 */
export function askRisk(o: RiskOrder): Promise<boolean> {
  if (o.clientScore?.level !== 'risk') return Promise.resolve(true);
  return new Promise((resolve) => {
    asking?.resolve(false);
    asking = { o, resolve };
    ping();
  });
}

/** Mounted once, above every other dialog (main.tsx). */
export function RiskAskHost() {
  const { t } = useTranslation();
  const [, setN] = useState(0);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const f = () => setN((x) => x + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  const cur = asking;
  const done = (ok: boolean) => {
    const a = asking;
    asking = null;
    ping();
    a?.resolve(ok);
  };
  useEffect(() => {
    if (!cur) return;
    // Escape closes this question only, not the order form under it
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      done(false);
    };
    window.addEventListener('keydown', k, true);
    // the safe answer has the focus: Entrée does not confirm by accident
    okRef.current?.focus();
    return () => window.removeEventListener('keydown', k, true);
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cur) return null;
  const s = cur.o.clientScore!;
  // what pulls the score down (all the reasons when nothing does: a level the seller moved up)
  const bad = (s.reasons ?? []).filter((r) => r.points < 0 || r.code === 'blacklist' || r.code === 'stopdesk');
  const score: ClientScore = { score: s.score, level: s.level, reasons: bad.length ? bad : s.reasons ?? [] };
  return (
    <div className="modal-wrap cs-ask-wrap" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="modal cs-ask" role="alertdialog" aria-modal="true" aria-labelledby="cs-ask-t" aria-describedby="cs-ask-d">
        <div className="modal-head">
          <h2 id="cs-ask-t">
            <Icon name="alert" /> {t('clients.score.ask.title', { ref: cur.o.ref })}
          </h2>
          <button type="button" className="icon-btn" onClick={() => done(false)} aria-label={t('common.close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <p id="cs-ask-d" className="cs-ask-lead">
            {t('clients.score.ask.lead')}
          </p>
          <ScoreCard s={score} />
        </div>
        <div className="modal-foot">
          <button ref={okRef} type="button" className="btn" onClick={() => done(false)}>
            {t('clients.score.ask.no')}
          </button>
          <button type="button" className="btn danger" onClick={() => done(true)}>
            {t('clients.score.ask.yes')}
          </button>
        </div>
      </div>
    </div>
  );
}
