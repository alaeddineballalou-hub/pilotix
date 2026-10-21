import { z } from 'zod';
import { proc } from '../rpc';

/** admin procedures. */
export const adminProcs = {
  'admin.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
