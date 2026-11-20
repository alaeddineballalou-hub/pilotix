// Accueil › « Venez avec vos données » (20 Nov 2026): a shop coming to Pilotix from its old app sees what is already in
// and what is left, in 4 steps — its products, its clients with their history, its delivery company, its team. The
// steps' imports and pages already exist; this only counts what is done. Admin only (the card is the owner's).
import { z } from 'zod';
import { num } from '../db';
import { proc } from '../rpc';

export interface WelcomeStatus {
  /** products in the catalogue */
  products: number;
  /** customers brought from the old database with their history (Clients › « Importer des clients ») */
  importedClients: number;
  /** delivery companies that are on */
  couriers: number;
  /** the store's own people (its owner included; a confirmation agency's agents not) */
  team: number;
}

export const welcomeProcs = {
  'welcome.status': proc([], z.object({}), async (ctx): Promise<WelcomeStatus> => {
    const r = (
      await ctx.db.query(
        `SELECT (SELECT count(*)::int FROM products) AS products,
                (SELECT count(*)::int FROM customers WHERE imp_source IS NOT NULL) AS clients,
                (SELECT count(*)::int FROM delivery_companies WHERE active) AS couriers,
                (SELECT count(*)::int FROM profiles WHERE active AND agency_id IS NULL) AS team`,
      )
    )[0];
    return {
      products: num(r?.products),
      importedClients: num(r?.clients),
      couriers: num(r?.couriers),
      team: num(r?.team),
    };
  }),
};
