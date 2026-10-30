// Every action the app can call, by name. Each feature has its own module file.
import { adminProcs } from './modules/admin';
import { adsProcs } from './modules/ads';
import { agencyProcs } from './modules/agencies';
import { proProcs } from './modules/pro';
import { agencyWorkProcs } from './modules/agencywork';
import { archiveProcs } from './modules/archive';
import { cashProcs } from './modules/cash';
import { caissesProcs } from './modules/caisses';
import { courierPayProcs } from './modules/courierpay';
import { depotAlertProcs } from './modules/depotalerts';
import { prefsProcs } from './modules/prefs';
import { confirmCheckProcs } from './modules/confirmcheck';
import { noStockProcs } from './modules/nostock';
import { dispatchProcs } from './modules/dispatch';
import { livreurProcs } from './modules/livreur';
import { pilotProcs } from './modules/pilot';
import { assignProcs } from './modules/assign';
import { coverageProcs } from './modules/coverage';
import { pushProcs } from './modules/push';
import { catalogProcs } from './modules/catalog';
import { productImportProcs } from './modules/productimport';
import { cmProcs } from './modules/cm';
import { confirmationProcs } from './modules/confirmation';
import { customersProcs } from './modules/customers';
import { clientScoreProcs } from './modules/clientscore';
import { deliveryProcs } from './modules/delivery';
import { dellalProcs } from './modules/dellal';
import { landingProcs } from './modules/landing';
import { landingGroupProcs } from './modules/landinggroups';
import { pixelProcs } from './modules/pixels';
import { marketersProcs } from './modules/marketers';
import { notifyProcs } from './modules/notify';
import { pickingProcs } from './modules/picking';
import { pickupProcs } from './modules/pickup';
import { parcelsProcs } from './modules/parcels';
import { ordersProcs } from './modules/orders';
import { savProcs } from './modules/sav';
import { sheetsProcs } from './modules/sheets';
import { spyProcs } from './modules/spy';
import { statsProcs } from './modules/stats';
import { boardProcs } from './modules/board';
import { doctorProcs } from './modules/doctor';
import { stockProcs } from './modules/stock';
import { suiviProcs } from './modules/suivi';
import { usersProcs } from './modules/users';

export const REGISTRY = {
  ...ordersProcs,
  ...usersProcs,
  ...sheetsProcs,
  ...confirmationProcs,
  ...statsProcs,
  ...boardProcs,
  ...doctorProcs,
  ...catalogProcs,
  ...productImportProcs,
  ...pickingProcs,
  ...pickupProcs,
  ...parcelsProcs,
  ...stockProcs,
  ...customersProcs,
  ...clientScoreProcs,
  ...suiviProcs,
  ...savProcs,
  ...deliveryProcs,
  ...cashProcs,
  ...caissesProcs,
  ...courierPayProcs,
  ...depotAlertProcs,
  ...prefsProcs,
  ...confirmCheckProcs,
  ...noStockProcs,
  ...dispatchProcs,
  ...livreurProcs,
  ...pilotProcs,
  ...assignProcs,
  ...coverageProcs,
  ...pushProcs,
  ...adminProcs,
  ...adsProcs,
  ...dellalProcs,
  ...cmProcs,
  ...notifyProcs,
  ...marketersProcs,
  ...landingProcs,
  ...landingGroupProcs,
  ...pixelProcs,
  ...spyProcs,
  ...archiveProcs,
  ...agencyProcs,
  ...proProcs,
  ...agencyWorkProcs,
};
