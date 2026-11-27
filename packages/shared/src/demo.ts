// Demo accounts of the in-browser preview (invented people). Never created on a real server.
export const DEMO_PASSWORD = 'demo-pilotix';
export const DEMO_ACCOUNTS = [
  { key: 'admin', name: 'Administrateur', email: 'admin@demo.pilotix.dz', roles: ['admin'] },
  { key: 'vendeur', name: 'Sofiane (Vendeur)', email: 'vendeur@demo.pilotix.dz', roles: ['vendeur'] },
  { key: 'manager1', name: 'Yacine', email: 'yacine@demo.pilotix.dz', roles: ['agent_manager'] },
  { key: 'manager2', name: 'Amel', email: 'amel@demo.pilotix.dz', roles: ['agent_manager'] },
  { key: 'manager3', name: 'Mouna', email: 'mouna@demo.pilotix.dz', roles: ['agent_manager'] },
  { key: 'conf1', name: 'Samira', email: 'samira@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'conf2', name: 'Rania', email: 'rania@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'conf3', name: 'Imane', email: 'imane@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'conf4', name: 'Sara', email: 'sara@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'conf5', name: 'Amine', email: 'amine@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'suivi', name: 'Nadia', email: 'nadia@demo.pilotix.dz', roles: ['suivi'] },
  { key: 'suivi2', name: 'Meriem', email: 'meriem@demo.pilotix.dz', roles: ['suivi'] },
  { key: 'suivi3', name: 'Adel', email: 'adel@demo.pilotix.dz', roles: ['suivi'] },
  { key: 'depot', name: 'Karim', email: 'karim@demo.pilotix.dz', roles: ['depot'] },
  { key: 'depot2', name: 'Nabil', email: 'nabil@demo.pilotix.dz', roles: ['depot'] },
  { key: 'livreur', name: 'Lamine', email: 'lamine@demo.pilotix.dz', roles: ['livreur'] },
  { key: 'livreur2', name: 'Walid', email: 'walid@demo.pilotix.dz', roles: ['livreur'] },
  { key: 'livreur3', name: 'Hichem', email: 'hichem@demo.pilotix.dz', roles: ['livreur'] },
  { key: 'marketer', name: 'Lyes (Marketeur)', email: 'lyes@demo.pilotix.dz', roles: ['marketer'] },
  { key: 'admin2', name: 'Salma (Administratrice)', email: 'salma@demo.pilotix.dz', roles: ['admin'] },
  { key: 'vendeur2', name: 'Anis (Vendeur)', email: 'anis@demo.pilotix.dz', roles: ['vendeur'] },
  { key: 'conf6', name: 'Houda', email: 'houda@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'depot3', name: 'Bilal', email: 'bilal@demo.pilotix.dz', roles: ['depot'] },
  { key: 'marketer2', name: 'Sarah (Marketeuse)', email: 'sarah@demo.pilotix.dz', roles: ['marketer'] },
  { key: 'polyvalent', name: 'Riad (Confirmation et Suivi)', email: 'riad@demo.pilotix.dz', roles: ['confirmation', 'suivi'] },
  // the Community manager (25 Nov 2026): Pilot Message, Pilot Comments, the orders of her chats and calls (in Yacine's team)
  { key: 'cm', name: 'Lina (Community manager)', email: 'lina@demo.pilotix.dz', roles: ['cm'] },
] as const;

/**
 * The in-browser demo's partners (invented): a confirmation agency and a marketer working for the demo store, each
 * opened with its chief's account (the demo password too).
 */
export const DEMO_PARTNER_ACCOUNTS = [
  { key: 'agence', kind: 'agency', name: 'Samir Benali', email: 'agence@demo.pilotix.dz', shop: 'Rapide Call Center' },
  { key: 'mkpartner', kind: 'marketer', name: 'Nassim Belaid', email: 'marketer@demo.pilotix.dz', shop: 'Nassim Ads' },
] as const;

/** A person of a demo partner's team (invented), opened with the demo password like everyone. */
export interface DemoTeamPerson {
  /** the « Essayer » link's account (lib/tryLink): #essayer-nora---commandes--livrees */
  key: string;
  name: string;
  email: string;
  roles: string[];
}
/** The demo agency's people: its agents work for its two sellers (« Tous les vendeurs »). */
export const DEMO_AGENCY_TEAM: readonly DemoTeamPerson[] = [
  { key: 'nora', name: 'Nora Hamdi', email: 'nora.agence@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'yasmine', name: 'Yasmine Kaci', email: 'yasmine.agence@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'ali', name: 'Ali Mansouri', email: 'ali.agence@demo.pilotix.dz', roles: ['suivi'] },
  { key: 'bouzid', name: 'Riad Bouzid', email: 'riad.agence@demo.pilotix.dz', roles: ['agent_manager'] },
  { key: 'leila', name: 'Leïla Mansouri', email: 'leila.agence@demo.pilotix.dz', roles: ['sav'] },
];
/** The demo marketer's people. */
export const DEMO_MARKETER_TEAM: readonly DemoTeamPerson[] = [
  { key: 'nadir', name: 'Nadir Ferhat', email: 'nadir.mk@demo.pilotix.dz', roles: ['marketer'] },
  { key: 'selma', name: 'Selma Kaci', email: 'selma.mk@demo.pilotix.dz', roles: ['marketer'] },
];
