// Every action the app can call, by name. Each feature has its own module file.
import { adminProcs } from './modules/admin';
import { adsProcs } from './modules/ads';
import { adsMgrProcs } from './modules/adsmgr';
import { adsLaunchProcs } from './modules/adslaunch';
import { agencyProcs } from './modules/agencies';
import { managementPlanProcs } from './modules/managementplans';
import { bonusProcs } from './modules/bonusrules';
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
import { automationsProcs } from './modules/automations';
import { dispatchProcs } from './modules/dispatch';
import { livreurProcs } from './modules/livreur';
import { pilotProcs } from './modules/pilot';
import { assignProcs } from './modules/assign';
import { agencyAssignProcs } from './modules/agencyassign';
import { agencyStatsProcs } from './modules/agencystats';
import { undoProcs } from './modules/undo';
import { coverageProcs } from './modules/coverage';
import { pushProcs } from './modules/push';
import { catalogProcs } from './modules/catalog';
import { hdPhotoProcs } from './modules/hdphotos';
import { guideProcs } from './modules/guidedraft';
import { productImportProcs } from './modules/productimport';
import { cmProcs } from './modules/cm';
import { cmPlanProcs } from './modules/cmplan';
import { cmSocialProcs } from './modules/cmsocial';
import { confirmationProcs } from './modules/confirmation';
import { customersProcs } from './modules/customers';
import { clientScoreProcs } from './modules/clientscore';
import { deliveryProcs } from './modules/delivery';
import { dellalProcs } from './modules/dellal';
import { landingProcs } from './modules/landing';
import { landingGroupProcs } from './modules/landinggroups';
import { pixelProcs } from './modules/pixels';
import { posProcs } from './modules/pos';
import { payProcs } from './modules/pay';
import { shopModulesProcs } from './modules/shopmodules';
import { marketersProcs } from './modules/marketers';
import { notifyProcs } from './modules/notify';
import { socialProcs } from './modules/social';
import { pickingProcs } from './modules/picking';
import { pickupProcs } from './modules/pickup';
import { parcelsProcs } from './modules/parcels';
import { ordersProcs } from './modules/orders';
import { savProcs } from './modules/sav';
import { sheetsProcs } from './modules/sheets';
import { spyProcs } from './modules/spy';
import { leadsProcs } from './modules/leads';
import { campaignsProcs } from './modules/campaigns';
import { metacatalogProcs } from './modules/metacatalog';
import { partnersProcs } from './modules/partners';
import { statsProcs } from './modules/stats';
import { boardProcs } from './modules/board';
import { boutiqueProcs } from './modules/boutiques';
import { boutiqueCopyProcs } from './modules/boutiquecopy';
import { sharedBlacklistProcs } from './modules/sharedblacklist';
import { filterProcs } from './modules/filters';
import { boutiqueWorkProcs } from './modules/boutiquework';
import { doctorProcs } from './modules/doctor';
import { stockProcs } from './modules/stock';
import { suiviProcs } from './modules/suivi';
import { usersProcs } from './modules/users';
import { photoShareProcs } from './modules/photoshare';

export const REGISTRY = {
  ...ordersProcs,
  ...filterProcs,
  ...boutiqueWorkProcs,
  ...usersProcs,
  ...sheetsProcs,
  ...confirmationProcs,
  ...statsProcs,
  ...boardProcs,
  ...doctorProcs,
  ...catalogProcs,
  ...hdPhotoProcs,
  ...guideProcs,
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
  ...automationsProcs,
  ...dispatchProcs,
  ...livreurProcs,
  ...pilotProcs,
  ...assignProcs,
  ...agencyAssignProcs,
  ...agencyStatsProcs,
  ...undoProcs,
  ...photoShareProcs,
  ...coverageProcs,
  ...pushProcs,
  ...adminProcs,
  ...adsProcs,
  ...adsMgrProcs,
  ...adsLaunchProcs,
  ...dellalProcs,
  ...cmProcs,
  ...cmPlanProcs,
  ...cmSocialProcs,
  ...notifyProcs,
  ...socialProcs,
  ...marketersProcs,
  ...landingProcs,
  ...landingGroupProcs,
  ...pixelProcs,
  ...spyProcs,
  ...leadsProcs,
  ...campaignsProcs,
  ...metacatalogProcs,
  ...partnersProcs,
  ...archiveProcs,
  ...agencyProcs,
  ...managementPlanProcs,
  ...bonusProcs,
  ...proProcs,
  ...agencyWorkProcs,
  ...boutiqueProcs,
  ...boutiqueCopyProcs,
  ...sharedBlacklistProcs,
  // a boutique's optional modules (Management › Modules), and the first of them: Point de vente
  ...shopModulesProcs,
  ...posProcs,
  ...payProcs,
};
