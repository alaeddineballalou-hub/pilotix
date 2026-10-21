// "Livreur à moi" (own) and "Société sans API" (manual): nothing is sent anywhere.
// Own livreurs see their parcels in « Ma tournée » and set the statuses themselves; for a manual company the team types the
// tracking number and changes statuses by hand (page Suivi).
import type { CourierAdapter } from './types';
import { CourierError } from './util';

const noApi = (name: string) => new CourierError(`${name} n’a pas d’API : changez les statuts à la main (page Suivi).`);

export const manual: CourierAdapter = {
  statuses: {},
  async test(c) {
    return { ok: true, message: `${c.name} n’a pas d’API : rien à tester.` };
  },
  async create(c) {
    throw noApi(c.name);
  },
  async track() {
    return [];
  },
};
