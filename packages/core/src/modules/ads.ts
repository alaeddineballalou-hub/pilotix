import { z } from 'zod';
import { proc } from '../rpc';

/** ads procedures. */
export const adsProcs = {
  'ads.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
