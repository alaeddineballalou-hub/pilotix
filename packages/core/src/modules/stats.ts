import { z } from 'zod';
import { proc } from '../rpc';

/** stats procedures. */
export const statsProcs = {
  'stats.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
