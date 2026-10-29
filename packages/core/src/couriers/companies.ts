// Every delivery company a shop can connect in « API Livraison », one card each with its own logo — also the ones
// that run on a shared API platform (EcoTrack: DHD, Conexlog, World Express…; Yalidine: Guepex, Yalitec…; Procolis:
// ABEX, Colilog…): the seller picks their company, never the platform. Names, API addresses and logos: Vargo
// (github.com/KaziSTM/vargo, MIT licence), every address checked live on 29 Oct 2026; the companies whose API answered
// « not found » are left out (Anderson, Mars Express, Tawsil Star). Logos: apps/web/public/couriers/<logo>.webp.
import type { CourierKind } from '@pilotix/shared';

export interface CourierCard {
  /** its id: kept in the shop's company (settings.card) */
  id: string;
  title: string;
  kind: CourierKind;
  /** its logo file (couriers/<logo>.webp); null: its initials */
  logo: string | null;
  /** a white logo: shown on a dark tile */
  dark?: boolean;
  /** the settings it needs on its platform (its own API address) */
  settings?: Record<string, string>;
  /**
   * A shop's company saved without its card is this one when the host of its API address is one of these (or ends
   * with « .one of these »); « !… »: none of these. byCard: companies sharing one address, told apart by their card only.
   */
  host?: string;
  byCard?: boolean;
  /** the control room's company (Sociétés de livraison: a removed one is no longer offered) */
  company?: string;
  /** among the most used: shown first */
  top?: boolean;
  /** one short line under its name, only where it matters */
  sub?: string;
  /** where the seller finds its keys (otherwise the platform's help) */
  help?: string;
}

/** White logos (made for dark backgrounds). */
const DARK = new Set(['colilog', 'conexlog', 'fz-delivery', 'lihlih-express', 'mazaya-logistics', 'noest', 'ovred', 'packers', 'pdex', 'rj360', 'speed-mail', 'univer-delivery']);
/** No logo found: their initials. */
const NO_LOGO = new Set(['eco-rapide-express']);
/** The most used, in this order. */
const TOP = ['zr', 'yalidine', 'noest', 'maystro', 'dhd', 'zimou', 'guepex', 'yalitec', 'elogistia', 'ecom', 'mdm', 'near', 'conexlog', 'world-express', 'areex', 'swift-express'];

type Row = [id: string, title: string, url: string, host: string];

/** EcoTrack companies: one API token; each one its own address. */
const ECOTRACK: Row[] = [
  ['48hr', '48HR Courrier Express', 'https://48hr.ecotrack.dz', '48hr.ecotrack.dz'],
  ['alania-express', 'Alania Express', 'https://alania.ecotrack.dz', 'alania.ecotrack.dz'],
  ['allo-livraison', 'Allo Livraison', 'https://allolivraison.ecotrack.dz', 'allolivraison.ecotrack.dz'],
  ['amana-speed', 'AMANA Speed', 'https://amana.ecotrack.dz', 'amana.ecotrack.dz'],
  ['aranex', 'Aranex', 'https://aranex.ecotrack.dz', 'aranex.ecotrack.dz'],
  ['areex', 'Areex Delivery', 'https://areex.ecotrack.dz', 'areex.ecotrack.dz'],
  ['atlas-express', 'Atlas Express', 'https://atlaexpress.ecotrack.dz', 'atlaexpress.ecotrack.dz'],
  ['ba-express', 'BA Consult Express', 'https://bacexpress.ecotrack.dz', 'bacexpress.ecotrack.dz'],
  ['bfk-express', 'BFK Express', 'https://bfkexpress.ecotrack.dz', 'bfkexpress.ecotrack.dz'],
  ['boogi', 'Boogi Technologie', 'https://boogi.ecotrack.dz', 'boogi.ecotrack.dz'],
  ['champion-logistics', 'Champion Logistics', 'https://champion.ecotrack.dz', 'champion.ecotrack.dz'],
  ['chronorex', 'Chronorex Express', 'https://chronorex.ecotrack.dz', 'chronorex.ecotrack.dz'],
  ['cirta-express', 'Cirta Express', 'https://cirtaexpress.ecotrack.dz', 'cirtaexpress.ecotrack.dz'],
  ['colex', 'Colex', 'https://colex.ecotrack.dz', 'colex.ecotrack.dz'],
  ['colireli', 'ColiReli', 'https://colireli.ecotrack.dz', 'colireli.ecotrack.dz'],
  ['colizone', 'Colizone', 'https://colizone.ecotrack.dz', 'colizone.ecotrack.dz'],
  ['conexlog', 'Conexlog', 'https://app.conexlog-dz.com', 'conexlog-dz.com'],
  ['coyote-express', 'Coyote Express', 'https://coyoteexpressdz.ecotrack.dz', 'coyoteexpressdz.ecotrack.dz'],
  ['delivro-mail', 'Delivro Mail', 'https://delivromail.ecotrack.dz', 'delivromail.ecotrack.dz'],
  ['dhd', 'DHD', 'https://platform.dhd-dz.com', 'dhd.ecotrack.dz,platform.dhd-dz.com'],
  ['distazero', 'Distazero', 'https://distazero.ecotrack.dz', 'distazero.ecotrack.dz'],
  ['eco-rapide-express', 'Eco Rapide Express', 'https://ecorapide-express.ecotrack.dz', 'ecorapide-express.ecotrack.dz'],
  ['elguide-delivery', 'El Guide Delivery', 'https://elguidedelivery.ecotrack.dz', 'elguidedelivery.ecotrack.dz'],
  ['expedia-chrono', 'Expedia Chrono', 'https://expediachrono.ecotrack.dz', 'expediachrono.ecotrack.dz'],
  ['fast-horse-express', 'Fast Horse Express', 'https://fasthorse.ecotrack.dz', 'fasthorse.ecotrack.dz'],
  ['fret-direct', 'Fret Direct', 'https://fret.ecotrack.dz', 'fret.ecotrack.dz'],
  ['fz-delivery', 'FZ Delivery', 'https://fzdelivery.ecotrack.dz', 'fzdelivery.ecotrack.dz'],
  ['golivri', 'Golivri', 'https://golivri.ecotrack.dz', 'golivri.ecotrack.dz'],
  ['gs-ecommerce', 'GS Ecommerce', 'https://gsecommerce.ecotrack.dz', 'gsecommerce.ecotrack.dz'],
  ['hdd-express', 'HDD Express', 'https://hhdexpress.ecotrack.dz', 'hhdexpress.ecotrack.dz'],
  ['imir-logistics', 'Imir Logistics', 'https://imir.ecotrack.dz', 'imir.ecotrack.dz'],
  ['jaguar-livraison', 'Jaguar Livraison', 'https://jaguar.ecotrack.dz', 'jaguar.ecotrack.dz'],
  ['jo-express', 'Jo Express', 'https://joexpress.ecotrack.dz', 'joexpress.ecotrack.dz'],
  ['lihlih-express', 'Lih Lih Express', 'https://lihlihexpress.ecotrack.dz', 'lihlihexpress.ecotrack.dz'],
  ['lynx-express', 'Lynx Express', 'https://lynx.ecotrack.dz', 'lynx.ecotrack.dz'],
  ['major-ex', 'Major Express', 'https://majorex.ecotrack.dz', 'majorex.ecotrack.dz'],
  ['mazaya-logistics', 'Mazaya Logistics', 'https://mazaya.ecotrack.dz', 'mazaya.ecotrack.dz'],
  ['med-express', 'Med Express', 'https://medexpress.ecotrack.dz', 'medexpress.ecotrack.dz'],
  ['msmgo', 'MSM GO', 'https://msmgo.ecotrack.dz', 'msmgo.ecotrack.dz'],
  ['navex-delivery', 'Navex Delivery', 'https://navexdelivery.ecotrack.dz', 'navexdelivery.ecotrack.dz'],
  ['om-express', 'Om Courrier Express', 'https://omexpress.ecotrack.dz', 'omexpress.ecotrack.dz'],
  ['on-time-express', 'On Time Express', 'https://ontime.ecotrack.dz', 'ontime.ecotrack.dz'],
  ['ovred', 'Ovred', 'https://ovred.ecotrack.dz', 'ovred.ecotrack.dz'],
  ['packers', 'Packers', 'https://packers.ecotrack.dz', 'packers.ecotrack.dz'],
  ['pdex', 'PDEX', 'https://pdex.ecotrack.dz', 'pdex.ecotrack.dz'],
  ['prest', 'Prest', 'https://prest.ecotrack.dz', 'prest.ecotrack.dz'],
  ['quick-delivery', 'Quick Delivery DZ', 'https://quickdelivery.ecotrack.dz', 'quickdelivery.ecotrack.dz'],
  ['rb-livraison', 'RB Livraison', 'https://rblivraison.ecotrack.dz', 'rblivraison.ecotrack.dz'],
  ['red-ex', 'Red Ex', 'https://redex.ecotrack.dz', 'redex.ecotrack.dz'],
  ['rex-livraison', 'Rex Livraison', 'https://rex.ecotrack.dz', 'rex.ecotrack.dz'],
  ['rihal-express', 'Rihal Express', 'https://rihalexpress.ecotrack.dz', 'rihalexpress.ecotrack.dz'],
  ['rj360', 'RJ 360 Express', 'https://rj360express.ecotrack.dz', 'rj360express.ecotrack.dz'],
  ['rm-express', 'RM Express', 'https://rmexpress.ecotrack.dz', 'rmexpress.ecotrack.dz'],
  ['rocket-delivery', 'Rocket Delivery', 'https://rocket.ecotrack.dz', 'rocket.ecotrack.dz'],
  ['rs-express', 'RS Express', 'https://rsexpress.ecotrack.dz', 'rsexpress.ecotrack.dz'],
  ['ruta-express', 'Ruta Express', 'https://rutaexpress.ecotrack.dz', 'rutaexpress.ecotrack.dz'],
  ['salva-delivery', 'Salva Delivery', 'https://salvadelivery.ecotrack.dz', 'salvadelivery.ecotrack.dz'],
  ['samex', 'Samex', 'https://samex.ecotrack.dz', 'samex.ecotrack.dz'],
  ['sbl-express', 'SBL Express', 'https://sbl.ecotrack.dz', 'sbl.ecotrack.dz'],
  ['speed-mail', 'Speed Mail', 'https://speedmail.ecotrack.dz', 'speedmail.ecotrack.dz'],
  ['sultan-colis-express', 'Sultan Colis Express', 'https://sultancolisexpress.ecotrack.dz', 'sultancolisexpress.ecotrack.dz'],
  ['swift-express', 'Swift Express', 'https://swift.ecotrack.dz', 'swift.ecotrack.dz'],
  ['tsl-express', 'TSL Express', 'https://tsl.ecotrack.dz', 'tsl.ecotrack.dz'],
  ['univer-delivery', 'Univer Delivery', 'https://univerdelivery.ecotrack.dz', 'univerdelivery.ecotrack.dz'],
  ['vitrans', 'Vitrans', 'https://vitrans.ecotrack.dz', 'vitrans.ecotrack.dz'],
  ['weewee-delivery', 'Wee Wee Delivery', 'https://weeweedelivery.ecotrack.dz', 'weeweedelivery.ecotrack.dz'],
  ['win-delivery', 'Win Delivery', 'https://windelivery.ecotrack.dz', 'windelivery.ecotrack.dz'],
  ['world-express', 'World Express', 'https://world-express.ecotrack.dz', 'world-express.ecotrack.dz'],
  ['zinya-tec', 'Zinya Tec', 'https://zinyatec.ecotrack.dz', 'zinyatec.ecotrack.dz'],
];

/** The Yalidine platform: API ID + API token; each one its own address. */
const YALIDINE: Row[] = [
  ['easy-and-speed', 'Easy & Speed', 'https://api.easyandspeed.app/v1/', 'easyandspeed.app'],
  ['economiqua', 'Economiqua', 'https://api.economiqua.app/v1/', 'economiqua.app'],
  ['guepex', 'Guepex', 'https://api.guepex.app/v1/', 'guepex.app'],
  ['we-can', 'We Can Services', 'https://api.wecanservices.me/v1/', 'wecanservices.me'],
  ['yalidine', 'Yalidine', 'https://api.yalidine.app/v1/', 'yalidine.app'],
  ['yalitec', 'Yalitec', 'https://api.yalitec.me/v1/', 'yalitec.me'],
];

/** The Procolis platform (the old ZR Express): token + key, one address for all (told apart by their card). */
const PROCOLIS: Row[] = [
  ['abex', 'ABEX Express', 'https://procolis.com/api_v1', ''],
  ['colilog', 'Colilog Express', 'https://procolis.com/api_v1', ''],
  ['flash-delivery', 'Flash Delivery', 'https://procolis.com/api_v1', ''],
  ['leopard-express', 'Leopard Express', 'https://procolis.com/api_v1', ''],
];

const card = (c: Omit<CourierCard, 'logo'> & { logo?: string | null }): CourierCard => {
  const logo = c.logo === undefined ? (NO_LOGO.has(c.id) ? null : c.id) : c.logo;
  const out: CourierCard = { ...c, logo };
  if (logo && DARK.has(logo)) out.dark = true;
  if (TOP.includes(c.id)) out.top = true;
  return out;
};

/** Every company, the most used first (in TOP's order), then A → Z; « Autre API » last. */
export const COMPANY_CARDS: CourierCard[] = (() => {
  const all: CourierCard[] = [
    card({ id: 'zr', title: 'ZR Express', kind: 'zr', company: 'zr' }),
    card({ id: 'noest', title: 'NOEST Express', kind: 'noest', company: 'noest' }),
    card({ id: 'maystro', title: 'Maystro Delivery', kind: 'maystro', company: 'maystro' }),
    card({ id: 'zimou', title: 'Zimou Express', kind: 'zimou', company: 'zimou' }),
    card({ id: 'elogistia', title: 'Elogistia', kind: 'elogistia', company: 'elogistia' }),
    card({ id: 'ecom', title: 'E-COM Delivery', kind: 'ecom', company: 'ecom' }),
    card({ id: 'mdm', title: 'MDM Express', kind: 'mdm', company: 'mdm' }),
    card({ id: 'near', title: 'Near Delivery', kind: 'near', company: 'near', sub: 'Point relais seulement' }),
    ...YALIDINE.map(([id, title, url, host]) =>
      card({
        id,
        title,
        kind: 'yalidine',
        settings: { base_url: url },
        // Yalidine itself: any address that is not one of the others (an empty one is Yalidine's)
        host: id === 'yalidine' ? `!${YALIDINE.filter((r) => r[0] !== 'yalidine').map((r) => r[3]).join(',')}` : host,
        company: ['yalidine', 'guepex', 'yalitec'].includes(id) ? id : undefined,
        help: `API ID et API Token : dans votre espace ${title} → Développement → Gestionnaire d’API.`,
      }),
    ),
    card({
      id: 'zr-procolis',
      title: 'ZR Express (ancienne plateforme)',
      kind: 'zr_legacy',
      logo: 'zr',
      settings: { base_url: 'https://procolis.com/api_v1' },
      host: '!abex.procolis.com',
      company: 'procolis',
      sub: 'Ancienne plateforme (Procolis)',
      help: 'Token et clé : dans votre espace Procolis → Paramètres → API.',
    }),
    ...PROCOLIS.map(([id, title, url]) =>
      card({
        id,
        title,
        kind: 'zr_legacy',
        settings: { base_url: url },
        // ABEX was once saved with its own address (abex.procolis.com): still recognized by it
        ...(id === 'abex' ? { host: 'abex.procolis.com' } : { byCard: true }),
        company: 'procolis',
        help: `Token et clé : dans votre espace ${title} → Paramètres → API.`,
      }),
    ),
    ...ECOTRACK.map(([id, title, url, host]) =>
      card({ id, title, kind: 'ecotrack', settings: { base_url: url }, host, company: 'ecotrack', help: `Token API : dans votre espace ${title} → API (sinon, demandez-le à ${title}).` }),
    ),
  ];
  const rank = (c: CourierCard) => (c.top ? TOP.indexOf(c.id) : TOP.length);
  const sorted = all.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'fr'));
  return [...sorted, card({ id: 'custom', title: 'Autre API', kind: 'custom', logo: null, sub: 'Toute autre société qui a une API' })];
})();
