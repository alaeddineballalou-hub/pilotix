import { z } from 'zod';
import { proc } from '../rpc';

/** sav procedures. */
export const savProcs = {
  'sav.ping': proc(null, z.object({}), async () => ({ ok: true })),
};
