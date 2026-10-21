// Demo accounts of the in-browser preview (invented people). Never created on a real server.
export const DEMO_PASSWORD = 'demo-pilotix';
export const DEMO_ACCOUNTS = [
  { key: 'admin', name: 'Administrateur', email: 'admin@demo.pilotix.dz', roles: ['admin'] },
  { key: 'vendeur', name: 'Sofiane (Vendeur)', email: 'vendeur@demo.pilotix.dz', roles: ['vendeur'] },
  { key: 'manager1', name: 'Yacine', email: 'yacine@demo.pilotix.dz', roles: ['agent_manager'] },
  { key: 'manager2', name: 'Amel', email: 'amel@demo.pilotix.dz', roles: ['agent_manager'] },
  { key: 'conf1', name: 'Samira', email: 'samira@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'conf2', name: 'Rania', email: 'rania@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'conf3', name: 'Imane', email: 'imane@demo.pilotix.dz', roles: ['confirmation'] },
  { key: 'suivi', name: 'Nadia', email: 'nadia@demo.pilotix.dz', roles: ['suivi'] },
  { key: 'depot', name: 'Karim', email: 'karim@demo.pilotix.dz', roles: ['depot'] },
  { key: 'livreur', name: 'Lamine', email: 'lamine@demo.pilotix.dz', roles: ['livreur'] },
  { key: 'livreur2', name: 'Walid', email: 'walid@demo.pilotix.dz', roles: ['livreur'] },
  { key: 'marketer', name: 'Lyes (Marketeur)', email: 'lyes@demo.pilotix.dz', roles: ['marketer'] },
] as const;
