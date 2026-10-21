import { z } from 'zod';
import { proc } from '../rpc';

/** suivi procedures. */
export const suiviProcs = {
  'suivi.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
