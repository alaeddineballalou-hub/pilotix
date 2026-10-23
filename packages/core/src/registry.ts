// Every action the app can call, by name. Each feature has its own module file.
import { adminProcs } from './modules/admin';
import { adsProcs } from './modules/ads';
import { cashProcs } from './modules/cash';
import { caissesProcs } from './modules/caisses';
import { courierPayProcs } from './modules/courierpay';
import { catalogProcs } from './modules/catalog';
import { cmProcs } from './modules/cm';
import { confirmationProcs } from './modules/confirmation';
import { customersProcs } from './modules/customers';
import { deliveryProcs } from './modules/delivery';
import { dellalProcs } from './modules/dellal';
import { marketersProcs } from './modules/marketers';
import { modsProcs } from './modules/mods';
import { notifyProcs } from './modules/notify';
import { pickingProcs } from './modules/picking';
import { ordersProcs } from './modules/orders';
import { savProcs } from './modules/sav';
import { statsProcs } from './modules/stats';
import { stockProcs } from './modules/stock';
import { suiviProcs } from './modules/suivi';
import { usersProcs } from './modules/users';

export const REGISTRY = {
  ...ordersProcs,
  ...usersProcs,
  ...confirmationProcs,
  ...statsProcs,
  ...catalogProcs,
  ...pickingProcs,
  ...stockProcs,
  ...customersProcs,
  ...suiviProcs,
  ...modsProcs,
  ...savProcs,
  ...deliveryProcs,
  ...cashProcs,
  ...caissesProcs,
  ...courierPayProcs,
  ...adminProcs,
  ...adsProcs,
  ...dellalProcs,
  ...cmProcs,
  ...notifyProcs,
  ...marketersProcs,
};
