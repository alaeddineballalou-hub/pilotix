import { z } from 'zod';
import { proc } from '../rpc';

/** delivery procedures. */
export const deliveryProcs = {
  'delivery.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
