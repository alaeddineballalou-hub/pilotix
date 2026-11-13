// Point de vente: the boutique's counter — Vendre (the products and the ticket), Ventes du jour, Clôture (the drawer
// counted) and Réglages (the owner). Shown once an administrator turns it on (Management › Modules).
import { useTranslation } from 'react-i18next';
import { useSession } from '../../lib/session';
import { StageBar } from '../../ui/kit';
import type { PageProps } from '../registry';
import { Close } from './Close';
import { Sales } from './Sales';
import { Sell } from './Sell';
import { PosSettingsPage } from './Settings';
import './pos.css';
import { tabOn } from '../../lib/rights';

const TABS = ['vendre', 'ventes', 'cloture', 'reglages'] as const;
type Tab = (typeof TABS)[number];

export function Pos({ sub }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const manage = !!session && (session.isAdmin || session.roles.includes('vendeur'));
  const tabs = TABS.filter((k) => (k !== 'reglages' || manage) && tabOn('pos', k));
  const view: Tab = (tabs as readonly string[]).includes(sub ?? '') ? (sub as Tab) : 'vendre';
  return (
    <div className="pos">
      <StageBar flow={false} current={view} items={tabs.map((k) => ({ key: k, label: t(`pos.tabs.${k}`), href: `#/pos/${k}` }))} />
      {view === 'vendre' ? <Sell /> : view === 'ventes' ? <Sales /> : view === 'cloture' ? <Close /> : <PosSettingsPage />}
    </div>
  );
}
