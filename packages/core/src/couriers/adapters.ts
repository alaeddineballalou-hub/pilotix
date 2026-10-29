// The adapter of each courier kind. Importing this file does not call any API.
import type { CourierKind } from '@pilotix/shared';
import { custom } from './custom';
import { ecom } from './ecom';
import { elogistia } from './elogistia';
import { maystro } from './maystro';
import { mdm } from './mdm';
import { near } from './near';
import { zimou } from './zimou';
import { ecotrack } from './ecotrack';
import { manual } from './manual';
import { noest } from './noest';
import { procolis } from './procolis';
import type { CourierAdapter } from './types';
import { yalidine } from './yalidine';
import { zr } from './zr';

export const ADAPTERS: Record<CourierKind, CourierAdapter> = { zr, zr_legacy: procolis, yalidine, ecotrack, noest, maystro, zimou, elogistia, ecom, mdm, near, custom, own: manual, manual };
