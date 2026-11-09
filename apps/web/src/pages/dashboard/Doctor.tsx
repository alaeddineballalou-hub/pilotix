// Co-Pilot (Accueil): what is going wrong, or about to — with what to do. Each person sees their own part: the whole
// shop (admin / vendeur), their teams' areas (agent manager), their own orders or parcels (an agent), stock (dépôt)…
// It keeps itself up to date: every change in the shop refreshes it (live updates), and it looks again every minute.
// An agent's own Co-Pilot sits on his Dashboard (he has no Accueil), folded when the page opens: one row with its face,
// what it found and his score; open, every check with what to do. In a confirmation agency's space: its orders in its
// sellers' stores (the chief and the managers on Accueil and the Dashboard, the agents on their Dashboard).
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { copilotMood, CopilotIcon } from '../doctor/CopilotIcon';
import { DoctorHero, DoctorList } from '../doctor/parts';

export function ShopDoctor({ card, fold }: { card?: boolean; fold?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  const q = useRpc('stats.doctor', {}, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const r = q.data;
  // nothing to look at for this person (a livreur): no card
  if (r && !r.items.length) return null;
  const sub = !r?.scope ? t('doctor.shopSub') : r.scope.whole ? t(r.scope.agency ? 'doctor.scope.agency' : 'doctor.scope.whole') : r.scope.mine ? t('doctor.scope.mine') : t('doctor.scope.team');
  const body = q.error ? (
    <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  ) : !r ? (
    <Loading />
  ) : (
    <div className="dr">
      <DoctorHero title={t('doctor.shopTitle')} sub={sub} score={r.score} items={r.items} checkedAt={r.checkedAt} />
      <DoctorList items={r.items} />
    </div>
  );
  if (fold) {
    const bad = r ? r.items.filter((i) => i.level === 'bad').length : 0;
    const warn = r ? r.items.filter((i) => i.level === 'warn').length : 0;
    const tone = !r ? '' : r.score >= 80 ? 'ok' : r.score >= 50 ? 'warn' : 'bad';
    const say = !r ? '' : bad ? t('doctor.say.bad', { count: bad }) : warn ? t('doctor.say.warn', { count: warn }) : t('doctor.say.ok');
    return (
      <section className={`card dr-home dr-mine${open ? ' open' : ''}`}>
        <button type="button" className="dr-mine-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <CopilotIcon mood={r ? copilotMood(r.items) : null} size={38} label={t('doctor.shopTitle')} />
          <span className="dr-mine-t">
            <b>{t('doctor.mineTitle')}</b>
            {/* open, the cockpit below says it all */}
            {!open && <small>{r ? say : sub}</small>}
          </span>
          {r && !open && (
            <span className={`dr-mine-score dr-${tone}`}>
              <b className="ltr">{r.score}</b>
              <small>{t('doctor.outOf')}</small>
            </span>
          )}
          <Icon name="chevron" className="dr-mine-ch" />
        </button>
        <div id={id} className="dr-mine-b" hidden={!open}>
          {body}
        </div>
      </section>
    );
  }
  if (!card) return body;
  return <section className="card dr-home">{body}</section>;
}
