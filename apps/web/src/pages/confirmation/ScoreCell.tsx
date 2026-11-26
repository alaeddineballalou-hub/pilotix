// Confirmation › « Score client » (the owner's choice 1 « Pastilles », 26 Nov 2026): the customer's score in its pill
// (a new customer: the score he starts with, grey, and « Nouveau » — the owner's choice C) and, under it, a tag that says
// whether the order is a form the customer left without sending it (« Abandonnée », Landing pages › Abandonnées) or not.
// The phone cards show the same two side by side.
import { cameOf, type ClientLevel } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { ScoreChip } from '../../ui/clientScore';
import { Icon } from '../../ui/kit';
import './scoreCell.css';

type CameOf = Parameters<typeof cameOf>[0];

/** An abandoned form: Pilotix added it by itself (`abandoned`), or a person added that unsent form (`recovered`). */
export const isAbandoned = (o: CameOf): boolean => {
  const c = cameOf(o);
  return c === 'abandoned' || c === 'recovered';
};

export function ScoreCell({ o, row }: { o: CameOf & { clientScore?: { score: number; level: ClientLevel } | null }; row?: boolean }) {
  const { t } = useTranslation();
  const s = o.clientScore;
  const ab = isAbandoned(o);
  return (
    <span className={`cf-sc${row ? ' row' : ''}`}>
      {s && s.level !== 'new' ? (
        <ScoreChip s={s} short />
      ) : (
        // nothing known about the number yet: the score it starts with (60 unless the shop changed it), grey and with the
        // word « Nouveau », so it never reads like a « Fiable » earned with delivered parcels (no score at all: the word)
        <span className="cs-chip short cs-new cf-sc-new" title={`${t('clients.score.level.new')} — ${t('clients.score.help')}`}>
          {s && (
            <>
              <b className="ltr">{s.score}</b>
              <small className="ltr">/100</small>
            </>
          )}
          <span>{t('clients.score.level.new')}</span>
        </span>
      )}
      <span className={`cf-cart ${ab ? 'yes' : 'no'}`} title={ab ? t('confirmation.abandon.yesHelp') : t('confirmation.abandon.noHelp')}>
        <Icon name={ab ? 'cart' : 'check'} />
        {t(ab ? 'confirmation.abandon.yes' : 'confirmation.abandon.no')}
      </span>
    </span>
  );
}
