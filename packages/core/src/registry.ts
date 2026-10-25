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
import { landingProcs } from './modules/landing';
import { marketersProcs } from './modules/marketers';
import { notifyProcs } from './modules/notify';
import { pickingProcs } from './modules/picking';
import { pickupProcs } from './modules/pickup';
import { parcelsProcs } from './modules/parcels';
import { ordersProcs } from './modules/orders';
import { savProcs } from './modules/sav';
import { statsProcs } from './modules/stats';
import { boardProcs } from './modules/board';
import { stockProcs } from './modules/stock';
import { suiviProcs } from './modules/suivi';
import { usersProcs } from './modules/users';

export const REGISTRY = {
  ...ordersProcs,
  ...usersProcs,
  ...confirmationProcs,
  ...statsProcs,
  ...boardProcs,
  ...catalogProcs,
  ...pickingProcs,
  ...pickupProcs,
  ...parcelsProcs,
  ...stockProcs,
  ...customersProcs,
  ...suiviProcs,
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
  ...landingProcs,
};
