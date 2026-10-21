// The adapter of each courier kind. Importing this file does not call any API.
import type { CourierKind } from '@pilotix/shared';
import { custom } from './custom';
import { ecotrack } from './ecotrack';
import { manual } from './manual';
import { noest } from './noest';
import { procolis } from './procolis';
import type { CourierAdapter } from './types';
import { yalidine } from './yalidine';
import { zr } from './zr';

export const ADAPTERS: Record<CourierKind, CourierAdapter> = { zr, zr_legacy: procolis, yalidine, ecotrack, noest, custom, own: manual, manual };
