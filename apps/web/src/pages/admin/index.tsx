// Admin pages: Utilisateurs, Management (Statuts, Paie des agents, Prix de livraison, Canaux de vente, Archives), Réglages.
import { useTranslation } from 'react-i18next';
import type { PageProps } from '../registry';
import { pageIsOn } from '../../lib/features';
import { StageBar } from '../../ui/kit';
import { Archive } from './Archive';
import { Canaux } from './Canaux';
import { Paie } from './Paie';
import { Prix } from './Prix';
import { ReglagesPage } from './Reglages';
import { Statuts } from './Statuts';
import { UsersPage } from './Users';

export function Utilisateurs({ sub, rest }: PageProps) {
  return <UsersPage sub={sub} rest={rest} />;
}

const MGMT = ['statuts', 'paie', 'prix', 'canaux', 'archive'] as const;
const ARCHIVE_KINDS = ['users', 'products', 'warehouses'] as const;
export function Management({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const cur = (MGMT as readonly string[]).includes(sub ?? '') ? (sub as (typeof MGMT)[number]) : 'statuts';
  // #/management/archive/<users|products|warehouses> opens that list
  const kind = (ARCHIVE_KINDS as readonly string[]).includes(rest?.[0] ?? '') ? (rest![0] as (typeof ARCHIVE_KINDS)[number]) : undefined;
  return (
    <>
      <StageBar flow={false} current={cur} items={MGMT.filter((k) => pageIsOn('management', k)).map((k) => ({ key: k, label: t(`admin.subs.${k}`), href: `#/management/${k}` }))} />
      {cur === 'statuts' ? <Statuts /> : cur === 'paie' ? <Paie /> : cur === 'prix' ? <Prix /> : cur === 'canaux' ? <Canaux /> : <Archive key={kind ?? 'users'} initial={kind} />}
    </>
  );
}

export function Reglages(_: PageProps) {
  return <ReglagesPage />;
}
