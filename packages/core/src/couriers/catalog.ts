// The control room's « Sociétés de livraison » page: for every Algerian delivery company, what Pilotix does through its
// API (Done) and what is still missing (To do), with why. Pure data, built from the courier kinds (no network): the
// shops' users do all of it inside Pilotix, never on the company's own site.
import { hostMatches, type CourierKind } from '@pilotix/shared';
import { COMPANY_CARDS } from './companies';
import { KindField, KINDS, KindInfo } from './kinds';

export type CourierFeature =
  | 'create' | 'tracking' | 'modify' | 'cancel' | 'swap' | 'claim' | 'return' | 'retry' | 'note'
  | 'label' | 'fees' | 'desks' | 'webhook' | 'payments';

export const COURIER_FEATURES: CourierFeature[] = ['create', 'tracking', 'webhook', 'modify', 'cancel', 'swap', 'claim', 'return', 'retry', 'note', 'label', 'fees', 'desks', 'payments'];

export interface CatalogItem {
  feature: CourierFeature;
  done: boolean;
  /** how it works in Pilotix (done), or why it is missing and what to do (to do) */
  note: string;
}
export interface CatalogCompany {
  key: string;
  name: string;
  /** the Pilotix kind it uses (companies on one platform share it) */
  kind: CourierKind | null;
  platform: string | null;
  items: CatalogItem[];
  /** the keys and settings its API needs (the control room's test keys form) */
  fields: KindField[];
  /** settings this company needs on its platform (its own API address) */
  presets: Record<string, string>;
  /** companies sharing a kind are told apart by the host of their API address: 'guepex.app' = it is (a sub-domain
   *  of) guepex.app, '!a,b' = none of these (same rule as the shops' cards) */
  host: string | null;
}

/** Is a shop's delivery company (its kind and API address) this control-room company? */
export function isCompany(co: Pick<CatalogCompany, 'kind' | 'host'>, kind: string, baseUrl: string): boolean {
  return !!co.kind && co.kind === kind && hostMatches(co.host, baseUrl);
}

/** The host rule of a shop's card (the Yalidine platform's companies are told apart by it). */
const hostOf = (id: string) => COMPANY_CARDS.find((c) => c.id === id)?.host ?? null;
/** How many EcoTrack companies a shop can pick. */
const ECOTRACK_COUNT = COMPANY_CARDS.filter((c) => c.kind === 'ecotrack').length;

/** What is known about each company's API beyond what Pilotix does (from its docs and open-source clients, Oct 2026). */
const MISSING: Partial<Record<CourierKind, Partial<Record<CourierFeature, string>>>> = {
  yalidine: {
    claim: 'Pas d’API de réclamation chez Yalidine : demander à Yalidine de l’ouvrir.',
    return: 'Pas d’API pour demander un retour : seulement le statut.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    note: 'Pas d’API pour une note.',
    payments: 'Pas d’API de versements chez Yalidine.',
    webhook: '',
  },
  ecotrack: {
    claim: 'Pas d’API de réclamation chez EcoTrack : Pilotix envoie une note à la société à la place.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    webhook: 'Pas de webhook chez EcoTrack : Pilotix demande les statuts toutes les 5 minutes (limite : 50 appels / minute).',
    payments: 'Pas d’API de versements : seulement les statuts « encaissé / payé ».',
    desks: 'Les bureaux sont choisis par commune (code postal), pas de liste.',
  },
  noest: {
    claim: 'Pas d’API de réclamation chez NOEST : Pilotix envoie une note à la place.',
    webhook: 'Pas de webhook chez NOEST : Pilotix demande les statuts toutes les 5 minutes.',
    payments: 'Pas d’API de versements : seulement le statut « versement ».',
    swap: 'Échange envoyé avec type_id = 2 : à vérifier avec de vraies clés.',
  },
  maystro: {
    claim: 'Pas d’API de réclamation chez Maystro.',
    return: 'Pas d’API pour demander un retour.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    note: 'Pas d’API pour une note.',
    swap: 'Pas d’échange par API trouvé chez Maystro : demander leur documentation.',
    payments: 'Pas d’API de versements trouvée.',
    desks: 'Pas de liste des bureaux par API.',
    fees: 'Pas d’API des tarifs trouvée chez Maystro : à remplir à la main.',
    webhook: '',
  },
  zimou: {
    claim: 'Pas d’API de réclamation chez Zimou.',
    swap: 'Pas d’échange par API chez Zimou.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    webhook: 'Pas de webhook chez Zimou : Pilotix demande les statuts toutes les 5 minutes.',
    payments: 'Zimou a une API /payments, mais ses champs ne sont pas documentés : à brancher avec de vraies clés.',
  },
  elogistia: {
    claim: 'Pas d’API de réclamation chez Elogistia.',
    swap: 'Pas d’échange par API.',
    modify: 'Pas d’API pour modifier un colis chez Elogistia.',
    return: 'Pas d’API pour demander un retour.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    note: 'Pas d’API pour une note.',
    webhook: 'Pas de webhook : Pilotix demande les statuts toutes les 5 minutes.',
    payments: 'Pas d’API de versements.',
  },
  ecom: {
    claim: 'Pas d’API de réclamation chez E-COM.',
    swap: 'Pas d’échange par API.',
    return: 'Pas d’API pour demander un retour.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    note: 'Pas d’API pour une note.',
    label: 'L’étiquette n’est donnée qu’à la création du colis (gardée par Pilotix).',
    fees: 'Pas d’API des tarifs : à remplir à la main.',
    webhook: 'Pas de webhook : Pilotix demande les statuts toutes les 5 minutes.',
    payments: 'Pas d’API de versements.',
  },
  mdm: {
    modify: 'Pas d’API pour modifier un colis chez MDM.',
    cancel: 'Pas d’API pour annuler un colis chez MDM.',
    claim: 'Pas d’API de réclamation.',
    swap: 'Pas d’échange par API.',
    return: 'Pas d’API pour demander un retour.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    note: 'Pas d’API pour une note.',
    fees: 'Pas d’API des tarifs : à remplir à la main.',
    webhook: 'Pas de webhook : Pilotix demande les statuts toutes les 5 minutes.',
    payments: 'Pas d’API de versements.',
  },
  near: {
    claim: 'Pas d’API de réclamation chez Near.',
    return: 'Pas d’API pour demander un retour.',
    retry: 'Pas d’API pour une nouvelle tentative.',
    note: 'Pas d’API pour une note.',
    webhook: 'Pas de webhook : Pilotix demande les statuts toutes les 5 minutes.',
    payments: 'Pas d’API de versements.',
  },
  zr: {
    return: 'Pas d’appel « demander le retour » dans l’API ZR : passez par une réclamation ZR (faite depuis Pilotix).',
    retry: 'Pas d’appel « nouvelle tentative » dans l’API ZR : passez par une réclamation ZR (faite depuis Pilotix).',
    note: 'Pas de note libre dans l’API ZR : les messages passent par les réclamations ZR (faites depuis Pilotix).',
  },
};
/** Old ZR platform (Procolis): one reason for everything it lacks. */
const LEGACY = 'Ancienne plateforme (Procolis) : son API ne le permet pas. Passez la boutique sur la nouvelle plateforme ZR.';

const DONE: Record<CourierFeature, (k: KindInfo) => string | null> = {
  create: (k) => (k.api ? 'Pilotix crée le colis chez la société (bouton Envoyer).' : null),
  tracking: (k) => (k.api ? 'Pilotix lit les statuts toutes les 5 minutes et sur « Mettre à jour ».' : null),
  webhook: (k) =>
    k.webhook === 'api'
      ? 'Mises à jour en direct : activées depuis Pilotix, la société prévient Pilotix à chaque statut.'
      : k.webhook === 'manual'
        ? 'Mises à jour en direct : Pilotix donne l’adresse à coller dans l’espace de la société (une fois).'
        : null,
  modify: (k) => (k.zr ? 'Prix, adresse, domicile ↔ bureau, téléphone : demandes envoyées depuis le colis.' : k.change ? 'Prix, adresse, téléphone : changés directement depuis le colis (avant l’enlèvement).' : null),
  cancel: (k) => (k.cancel ? 'Annuler / supprimer le colis depuis Pilotix (avant l’enlèvement).' : null),
  swap: (k) => (k.exchange === 'api' ? 'Échange de la société : nouveau colis + colis retour de l’ancien produit.' : k.exchange === 'create' ? 'Échange envoyé comme colis d’échange (produit à récupérer).' : null),
  claim: (k) => (k.claims ? 'Réclamations créées, suivies et relancées depuis Pilotix.' : null),
  return: (k) => (k.askReturn ? 'Demander le retour du colis depuis Pilotix.' : null),
  retry: (k) => (k.retry ? 'Demander une nouvelle tentative de livraison depuis Pilotix.' : null),
  note: (k) => (k.note ? 'Envoyer une note aux agents de la société depuis Pilotix.' : null),
  label: (k) => (k.label_ ? 'Étiquette de la société imprimée depuis Pilotix.' : null),
  fees: (k) => (k.fees ? 'Tarifs importés depuis la société.' : null),
  desks: (k) => (k.desks ? 'Bureaux (stop desks) importés depuis la société.' : null),
  payments: (k) => (k.payments ? 'Solde, demandes de paiement et versements dans la Caisse.' : null),
};

function itemsOf(kind: CourierKind): CatalogItem[] {
  const k = KINDS[kind];
  return COURIER_FEATURES.map((f) => {
    const done = DONE[f](k);
    if (done) return { feature: f, done: true, note: done };
    const why = kind === 'zr_legacy' ? LEGACY : MISSING[kind]?.[f];
    return { feature: f, done: false, note: why || 'Pas encore dans Pilotix : à vérifier dans la documentation API de la société.' };
  });
}

/** Every company, Done / To do per feature. */
export function courierCatalog(): CatalogCompany[] {
  const one = (key: string, name: string, kind: CourierKind, platform: string | null = null, presets: Record<string, string> = {}, host: string | null = null): CatalogCompany => ({
    key,
    name,
    kind,
    platform,
    items: itemsOf(kind),
    fields: KINDS[kind].fields,
    presets,
    host,
  });
  return [
    one('zr', 'ZR Express', 'zr'),
    one('yalidine', 'Yalidine', 'yalidine', null, {}, hostOf('yalidine')),
    one('guepex', 'Guepex', 'yalidine', 'Yalidine', { base_url: 'https://api.guepex.app/v1/' }, hostOf('guepex')),
    one('yalitec', 'Yalitec', 'yalidine', 'Yalidine', { base_url: 'https://api.yalitec.me/v1/' }, hostOf('yalitec')),
    one('maystro', 'Maystro Delivery', 'maystro'),
    one('ecotrack', `DHD, Conexlog, World Express… (${ECOTRACK_COUNT} sociétés)`, 'ecotrack', 'EcoTrack', { base_url: 'https://platform.dhd-dz.com' }),
    one('noest', 'NOEST Express', 'noest'),
    one('zimou', 'Zimou Express', 'zimou'),
    one('elogistia', 'Elogistia', 'elogistia'),
    one('ecom', 'E-COM Delivery', 'ecom'),
    one('mdm', 'MDM Express', 'mdm'),
    one('near', 'Near Delivery', 'near'),
    one('procolis', 'ZR Express (ancienne : Procolis), ABEX', 'zr_legacy', 'Procolis'),
    {
      key: 'colivraison',
      name: 'Colivraison',
      kind: null,
      platform: null,
      fields: [],
      presets: {},
      host: null,
      items: COURIER_FEATURES.map((f) => ({ feature: f, done: false, note: 'Son API existe mais sa documentation n’est pas publique : la demander à Colivraison. En attendant, les boutiques l’ajoutent en « API personnalisée » ou « Société sans API ».' })),
    },
  ];
}
