// Dashboard › Pilotix Doctor (admin / vendeur): what is going wrong in the shop, or about to — with what to do.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { ErrorBox, Loading } from '../../ui/kit';
import { DoctorHero, DoctorList } from '../doctor/parts';

export function ShopDoctor() {
  const { t } = useTranslation();
  // looks again every 5 minutes while the page is open
  const q = useRpc('stats.doctor', {}, { refetchInterval: 5 * 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  return (
    <div className="dr">
      <DoctorHero title={t('doctor.shopTitle')} sub={t('doctor.shopSub')} score={r.score} items={r.items} checkedAt={r.checkedAt} onRefresh={() => q.refetch()} busy={q.isFetching} />
      <DoctorList items={r.items} />
    </div>
  );
}
