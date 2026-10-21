import { z } from 'zod';
import { proc } from '../rpc';

/** catalog procedures. */
export const catalogProcs = {
  'catalog.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
