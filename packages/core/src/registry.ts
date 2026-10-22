// Every action the app can call, by name. Each feature has its own module file.
import { adminProcs } from './modules/admin';
import { adsProcs } from './modules/ads';
import { cashProcs } from './modules/cash';
import { catalogProcs } from './modules/catalog';
import { confirmationProcs } from './modules/confirmation';
import { customersProcs } from './modules/customers';
import { deliveryProcs } from './modules/delivery';
import { dellalProcs } from './modules/dellal';
import { marketersProcs } from './modules/marketers';
import { ordersProcs } from './modules/orders';
import { savProcs } from './modules/sav';
import { statsProcs } from './modules/stats';
import { suiviProcs } from './modules/suivi';
import { usersProcs } from './modules/users';

export const REGISTRY = {
  ...ordersProcs,
  ...usersProcs,
  ...confirmationProcs,
  ...statsProcs,
  ...catalogProcs,
  ...customersProcs,
  ...suiviProcs,
  ...savProcs,
  ...deliveryProcs,
  ...cashProcs,
  ...adminProcs,
  ...adsProcs,
  ...dellalProcs,
  ...marketersProcs,
};
