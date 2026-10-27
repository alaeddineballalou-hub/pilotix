// Co-Pilot (Accueil): what is going wrong, or about to — with what to do. Each person sees their own part: the whole
// shop (admin / vendeur), their teams' areas (agent manager), their own orders or parcels (an agent), stock (dépôt)…
// It keeps itself up to date: every change in the shop refreshes it (live updates), and it looks again every minute.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { ErrorBox, Loading } from '../../ui/kit';
import { DoctorHero, DoctorList } from '../doctor/parts';

export function ShopDoctor({ card }: { card?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('stats.doctor', {}, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const r = q.data;
  // nothing to look at for this person (a livreur): no card
  if (r && !r.items.length) return null;
  const sub = !r?.scope ? t('doctor.shopSub') : r.scope.whole ? t('doctor.scope.whole') : r.scope.mine ? t('doctor.scope.mine') : t('doctor.scope.team');
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
  if (!card) return body;
  return <section className="card dr-home">{body}</section>;
}
