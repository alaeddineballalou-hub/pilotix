// Every action the app can call, by name. Each feature has its own module file.
import { adminProcs } from './modules/admin';
import { adsProcs } from './modules/ads';
import { adsMgrProcs } from './modules/adsmgr';
import { adsLaunchProcs } from './modules/adslaunch';
import { adsTreeProcs } from './modules/adstree';
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
import { pilotChecksProcs } from './modules/pilotchecks';
import { dispatchProcs } from './modules/dispatch';
import { livreurProcs } from './modules/livreur';
import { pilotProcs } from './modules/pilot';
import { assignProcs } from './modules/assign';
import { agencyBellProcs } from './modules/agencybell';
import { agencyAssignProcs } from './modules/agencyassign';
import { agencyStatsProcs } from './modules/agencystats';
import { undoProcs } from './modules/undo';
import { coverageProcs } from './modules/coverage';
import { pushProcs } from './modules/push';
import { inboxProcs } from './modules/inbox';
import { promoProcs } from './modules/promo';
import { rightsProcs } from './modules/rights';
import { catalogProcs } from './modules/catalog';
import { readinessProcs } from './modules/readiness';
import { hdPhotoProcs } from './modules/hdphotos';
import { guideProcs } from './modules/guidedraft';
import { productImportProcs } from './modules/productimport';
import { cmProcs } from './modules/cm';
import { cmPlanProcs } from './modules/cmplan';
import { cmSocialProcs } from './modules/cmsocial';
import { confirmationProcs } from './modules/confirmation';
import { noAnswerProcs } from './modules/noanswer';
import { confBlockProcs } from './modules/confblock';
import { customersProcs } from './modules/customers';
import { welcomeProcs } from './modules/welcome';
import { clientScoreProcs } from './modules/clientscore';
import { deliveryProcs } from './modules/delivery';
import { dellalProcs } from './modules/dellal';
import { landingProcs } from './modules/landing';
import { siteProcs } from './modules/site';
import { landingListsProcs } from './modules/landinglists';
import { pageLinksProcs } from './modules/pagelinks';
import { landingTitleProcs } from './modules/landingtitle';
import { landingGroupProcs } from './modules/landinggroups';
import { pixelProcs } from './modules/pixels';
import { posProcs } from './modules/pos';
import { payProcs } from './modules/pay';
import { billingProcs } from './modules/billing';
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
import { createurProcs } from './modules/createur';
import { studioProcs } from './modules/studio';
import { montageProcs } from './modules/montage';
import { strategiesProcs } from './modules/strategies';

export const REGISTRY = {
  // Espace créateur: the AI credits and the AI tools that use them (subtitles, post texts, hook ideas)
  ...createurProcs,
  ...studioProcs,
  ...montageProcs,
  // Marketing › Stratégies: the products' type for the ads and the formats recommended for it
  ...strategiesProcs,
  ...ordersProcs,
  ...filterProcs,
  ...boutiqueWorkProcs,
  ...usersProcs,
  ...sheetsProcs,
  ...confirmationProcs,
  ...noAnswerProcs,
  // Confirmation › « Bloquer jusqu'à l'appel »: a new order covers the plain agent's screen and rings until he calls
  ...confBlockProcs,
  ...statsProcs,
  ...boardProcs,
  ...doctorProcs,
  ...catalogProcs,
  ...readinessProcs,
  ...hdPhotoProcs,
  ...guideProcs,
  ...productImportProcs,
  ...pickingProcs,
  ...pickupProcs,
  ...parcelsProcs,
  ...stockProcs,
  ...customersProcs,
  ...welcomeProcs,
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
  ...pilotChecksProcs,
  ...dispatchProcs,
  ...livreurProcs,
  ...pilotProcs,
  ...assignProcs,
  ...agencyAssignProcs,
  ...agencyBellProcs,
  ...agencyStatsProcs,
  ...undoProcs,
  ...photoShareProcs,
  ...coverageProcs,
  ...pushProcs,
  // the bell at the top of every page
  ...inboxProcs,
  ...promoProcs,
  // Utilisateurs › Rôles: what each role of the boutique sees and does
  ...rightsProcs,
  ...adminProcs,
  ...adsProcs,
  ...adsMgrProcs,
  ...adsLaunchProcs,
  // Lancer une pub and Mes pubs › Campaign › Ad set › Ad
  ...adsTreeProcs,
  ...dellalProcs,
  ...cmProcs,
  ...cmPlanProcs,
  ...cmSocialProcs,
  ...notifyProcs,
  ...socialProcs,
  ...marketersProcs,
  ...landingProcs,
  ...siteProcs,
  ...landingListsProcs,
  ...pageLinksProcs,
  ...landingTitleProcs,
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
  // « J'ai payé »: a store sends its receipt to Pilotix (the control room checks it)
  ...billingProcs,
};
