import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { In } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Loading } from '../../ui/kit';

type Task = In<'partners.routeOrder'>['task'];

export function AgencyRouting({ orderId }: { orderId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Partial<Record<Task, number | null>>>({});
  const query = useRpc('partners.orderRouting', { orderId }, { enabled: open });
  const route = useAction('partners.routeOrder', {
    success: t('agency.routing.saved'),
    onDone: () => setSelected({}),
  });
  const data = query.data;
  const agencyName = (agencyId: number | null) =>
    agencyId === null ? t('agency.routing.store') : data?.agencies.find((agency) => agency.id === agencyId)?.name ?? t('agency.badge');
  return (
    <details className="card" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t('agency.routing.title')}</summary>
      {open && (query.error ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : !data ? <Loading /> : (
        <div className="card-body">
          {data.tasks.map(({ task, agencyId, editable }) => {
            const options = data.agencies.filter((item) => item.tasks.includes(task));
            const next = selected[task] !== undefined ? selected[task] : agencyId;
            if (!options.length && agencyId === null) return null;
            return (
              <div className="row" key={task}>
                <label>
                  {t(`agency.task.${task}`)}
                  <select className="in" value={next ?? ''} disabled={!editable || route.isPending}
                    onChange={(event) => setSelected((old) => ({ ...old, [task]: event.target.value ? Number(event.target.value) : null }))}>
                    <option value="">{t('agency.routing.store')}</option>
                    {options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    {agencyId !== null && !options.some((item) => item.id === agencyId) && <option value={agencyId}>{agencyName(agencyId)}</option>}
                  </select>
                </label>
                {editable && <button type="button" className="btn small" disabled={route.isPending || next === agencyId}
                  onClick={() => route.mutate({ orderId, task, agencyId: next })}>{t('common.save')}</button>}
              </div>
            );
          })}
          {!data.agencies.length && <p className="muted">{t('agency.routing.none')}</p>}
        </div>
      ))}
    </details>
  );
}
