// A boutique's optional modules (@pilotix/shared SHOP_MODULES: Point de vente…): off until one of its administrators
// turns one on in Management › Modules. A module's actions start with requireModule; the app hides its page meanwhile.
import { SHOP_MODULES, ShopModule } from '@pilotix/shared';
import { z } from 'zod';
import { Db } from '../db';
import { notFound, proc } from '../rpc';
import { getRaw, setRaw } from './admin';

export const MODULES_KEY = 'modules';
export type ShopModules = Record<ShopModule, boolean>;

/** Which modules are on in this boutique (a module never set is off). */
export async function modulesOf(db: Db): Promise<ShopModules> {
  const v = await getRaw<Partial<Record<string, unknown>> | null>(db, MODULES_KEY, {});
  return Object.fromEntries(SHOP_MODULES.map((m) => [m, v?.[m] === true])) as ShopModules;
}

export async function setModule(db: Db, m: ShopModule, on: boolean, userId?: number) {
  await setRaw(db, MODULES_KEY, { ...(await modulesOf(db)), [m]: on }, userId);
}

/** What a module's action answers while the module is off. */
const OFF: Record<ShopModule, string> = { pos: 'Le Point de vente est éteint : un administrateur l’allume dans Management › Modules' };
export async function requireModule(db: Db, m: ShopModule) {
  if (!(await modulesOf(db))[m]) throw notFound(OFF[m]);
}

export const shopModulesProcs = {
  /** The modules on in this boutique (the menu shows their pages). */
  'modules.get': proc(null, z.object({}), async (ctx) => modulesOf(ctx.db)),

  /** Management › Modules (administrators): turns one on or off. */
  'modules.set': proc([], z.object({ module: z.enum(SHOP_MODULES), on: z.boolean() }), async (ctx, i) => {
    await setModule(ctx.db, i.module, i.on, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return modulesOf(ctx.db);
  }),
};
