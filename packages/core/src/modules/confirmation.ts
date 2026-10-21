import { z } from 'zod';
import { proc } from '../rpc';

/** confirmation procedures. */
export const confirmationProcs = {
  'confirmation.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
