import { z } from 'zod';
import { proc } from '../rpc';

/** cash procedures. */
export const cashProcs = {
  'cash.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
