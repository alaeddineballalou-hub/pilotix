import { z } from 'zod';
import { proc } from '../rpc';

/** customers procedures. */
export const customersProcs = {
  'customers.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
