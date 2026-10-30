// Admin pages: Utilisateurs, Management (Statuts, Paie des agents, Prix de livraison, Canaux de vente, Alertes dépôt, Archives), Réglages.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../lib/session';
import type { PageProps } from '../registry';
import { pageIsOn } from '../../lib/features';
import { useAction, useRpc } from '../../lib/query';
import { StageBar } from '../../ui/kit';
import { Archive } from './Archive';
import { Canaux } from './Canaux';
import { LivreurCfg } from './LivreurCfg';
import { Paie } from './Paie';
import { Prix } from './Prix';
import { ReglagesPage } from './Reglages';
import { Statuts } from './Statuts';
import { Affectation } from './Affectation';
import { UsersPage } from './Users';

export function Utilisateurs({ sub, rest }: PageProps) {
  return <UsersPage sub={sub} rest={rest} />;
}

const MGMT = ['statuts', 'affectation', 'paie', 'prix', 'canaux', 'alertes', 'livreur', 'archive'] as const;
const ARCHIVE_KINDS = ['users', 'products', 'warehouses'] as const;
export function Management({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  // not an administrator: let in for the Affectation only
  const mine = session?.isAdmin ? MGMT : (['affectation'] as const);
  const cur = (mine as readonly string[]).includes(sub ?? '') ? (sub as (typeof MGMT)[number]) : mine[0];
  // #/management/archive/<users|products|warehouses> opens that list
  const kind = (ARCHIVE_KINDS as readonly string[]).includes(rest?.[0] ?? '') ? (rest![0] as (typeof ARCHIVE_KINDS)[number]) : undefined;
  return (
    <>
      <StageBar flow={false} current={cur} items={mine.filter((k) => pageIsOn('management', k)).map((k) => ({ key: k, label: t(`admin.subs.${k}`), href: `#/management/${k}` }))} />
      {cur === 'statuts' ? <Statuts /> : cur === 'affectation' ? <Affectation /> : cur === 'paie' ? <Paie /> : cur === 'prix' ? <Prix /> : cur === 'canaux' ? <Canaux /> : cur === 'alertes' ? <DepotAlertsCfg /> : cur === 'livreur' ? <LivreurCfg /> : <Archive key={kind ?? 'users'} initial={kind} />}
    </>
  );
}

/** Management › Alertes dépôt: who gets the red alert when an order still in the depot is changed or cancelled. */
function DepotAlertsCfg() {
  const { t } = useTranslation();
  const q = useRpc('depot.alertConfig', {});
  const [to, setTo] = useState<number[] | null>(null);
  const save = useAction('depot.alertConfigSet', { success: t('common.saved') });
  const cur = to ?? q.data?.to ?? [];
  const flip = (id: number) => setTo(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  return (
    <div className="card">
      <h2>{t('admin.dalert.title')}</h2>
      <p className="muted">{t('admin.dalert.help')}</p>
      {!q.data ? (
        <p className="muted">…</p>
      ) : !q.data.people.length ? (
        <p className="muted">{t('admin.dalert.nobody')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}>
          {q.data.people.map((p) => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700 }}>
              <input type="checkbox" checked={cur.includes(p.id)} onChange={() => flip(p.id)} /> {p.name}
            </label>
          ))}
        </div>
      )}
      <p className="muted small">{cur.length ? t('admin.dalert.chosen', { count: cur.length }) : t('admin.dalert.all')}</p>
      <button className="btn primary" disabled={save.isPending || to === null} onClick={() => save.mutate({ to: cur }, { onSuccess: () => setTo(null) })}>
        {t('common.save')}
      </button>
    </div>
  );
}

export function Reglages(_: PageProps) {
  return <ReglagesPage />;
}
