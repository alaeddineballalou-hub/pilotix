// Admin pages: Utilisateurs, Management (Statuts, Paie des agents, Prix de livraison, Canaux de vente), Réglages.
import { useTranslation } from 'react-i18next';
import type { PageProps } from '../registry';
import { StageBar } from '../../ui/kit';
import { Canaux } from './Canaux';
import { Paie } from './Paie';
import { Prix } from './Prix';
import { ReglagesPage } from './Reglages';
import { Statuts } from './Statuts';
import { UsersPage } from './Users';

export function Utilisateurs({ sub, rest }: PageProps) {
  return <UsersPage sub={sub} rest={rest} />;
}

const MGMT = ['statuts', 'paie', 'prix', 'canaux'] as const;
export function Management({ sub }: PageProps) {
  const { t } = useTranslation();
  const cur = (MGMT as readonly string[]).includes(sub ?? '') ? (sub as (typeof MGMT)[number]) : 'statuts';
  return (
    <>
      <StageBar flow={false} current={cur} items={MGMT.map((k) => ({ key: k, label: t(`admin.subs.${k}`), href: `#/management/${k}` }))} />
      {cur === 'statuts' ? <Statuts /> : cur === 'paie' ? <Paie /> : cur === 'prix' ? <Prix /> : <Canaux />}
    </>
  );
}

export function Reglages(_: PageProps) {
  return <ReglagesPage />;
}
