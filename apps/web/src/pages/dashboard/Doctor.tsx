// Co-Pilot (Accueil, admin / vendeur): what is going wrong in the shop, or about to — with what to do.
// `card`: inside a card titled « Co-Pilot », like « Maintenant », with its living icon (CopilotIcon).
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { ErrorBox, Loading } from '../../ui/kit';
import { copilotMood, CopilotIcon } from '../doctor/CopilotIcon';
import { DoctorHero, DoctorList } from '../doctor/parts';

export function ShopDoctor({ card }: { card?: boolean }) {
  const { t } = useTranslation();
  // looks again every 5 minutes while the page is open
  const q = useRpc('stats.doctor', {}, { refetchInterval: 5 * 60_000 });
  const r = q.data;
  const body = q.error ? (
    <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  ) : !r ? (
    <Loading />
  ) : (
    <div className="dr">
      <DoctorHero title={card ? undefined : t('doctor.shopTitle')} sub={t('doctor.shopSub')} score={r.score} items={r.items} checkedAt={r.checkedAt} onRefresh={() => q.refetch()} busy={q.isFetching} />
      <DoctorList items={r.items} />
    </div>
  );
  if (!card) return body;
  return (
    <section className="card dr-home">
      <div className="card-head">
        <h2 className="dr-home-h">
          <CopilotIcon mood={r && !q.isFetching ? copilotMood(r.items) : null} label={t('doctor.shopTitle')} />
          {t('doctor.shopTitle')}
        </h2>
      </div>
      {body}
    </section>
  );
}
