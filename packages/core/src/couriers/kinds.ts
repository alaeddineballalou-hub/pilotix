// Catalog of courier kinds: what the "API Integration" page shows and which keys each one needs.
// Pure data (no network): used by the core procedures and sent to the app through delivery.kinds.
import type { CourierKind } from '@pilotix/shared';

export interface KindField {
  key: string;
  label: string;
  /** secret = write-only API key; check = boolean setting; text = setting */
  type: 'secret' | 'text' | 'check';
  default?: string | boolean;
  hint?: string;
}

export interface KindInfo {
  kind: CourierKind;
  label: string;
  help: string;
  fields: KindField[];
  /** has an API to import tariffs / stop desks / cancel / print labels */
  fees: boolean;
  desks: boolean;
  cancel: boolean;
  label_: boolean;
  api: boolean;
  /** réclamations are created at the courier through its API */
  claims?: boolean;
  /** the labels of many parcels come as one file (ZR: one PDF for up to 250 parcels) */
  labels_?: boolean;
  /** the courier's other services through its API (ZR): pickup bags, exchanges, modification requests, parcel journey */
  zr?: boolean;
  /** the parcel at the courier, seen and changed from Pilotix (journey, price / phone / address changes) */
  parcel?: boolean;
  /** price / address / phone changes of a parcel sent, from Pilotix */
  change?: boolean;
  /** asks the courier for a return / a new delivery try / adds a note for its agents, from Pilotix */
  askReturn?: boolean;
  retry?: boolean;
  note?: boolean;
  /** instant status updates: 'api' = turned on from Pilotix, 'manual' = the address is pasted in the courier's space */
  webhook?: 'api' | 'manual';
  /** the courier's money through its API: balance, payment requests, payments and their parcels */
  payments?: boolean;
  /** exchanges: 'api' = the courier's own exchange (new parcel + return parcel), 'create' = sent as an exchange parcel */
  exchange?: 'api' | 'create';
}

export const KINDS: Record<CourierKind, KindInfo> = {
  own: {
    kind: 'own', label: 'Livreur à moi', api: false, fees: false, desks: false, cancel: false, label_: false,
    help: 'Un livreur de votre équipe. S’il a un compte « Livreur », il voit ses colis dans « Ma tournée » et marque livré / échec / retour lui-même.',
    fields: [],
  },
  zr: {
    kind: 'zr', label: 'ZR Express (nouvelle plateforme)', api: true, fees: true, desks: true, cancel: true, label_: true, claims: true, labels_: true, zr: true, parcel: true, webhook: 'api', exchange: 'api', payments: true,
    help: 'Nouvelle plateforme ZR Express. Clé API et identifiant du compte (tenant) : dans votre espace ZR → Paramètres → API.',
    fields: [
      { key: 'api_key', label: 'Clé API (X-Api-Key)', type: 'secret' },
      { key: 'tenant', label: 'Tenant (X-Tenant)', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.zrexpress.app' },
      { key: 'label_format', label: 'Format des étiquettes ZR', type: 'text', default: 'a6', hint: 'a6 : une étiquette 10 × 15 cm par page (imprimante d’étiquettes) · a4 : quatre par page' },
    ],
  },
  zr_legacy: {
    kind: 'zr_legacy', label: 'ZR Express (ancienne : Procolis)', api: true, fees: true, desks: false, cancel: false, label_: false,
    help: 'Ancienne plateforme ZR Express (Procolis) — aussi ABEX, Colilog… (même adresse). Token et clé : dans Procolis → Paramètres → API.',
    fields: [
      { key: 'token', label: 'Token', type: 'secret' },
      { key: 'key', label: 'Clé (key)', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://procolis.com/api_v1' },
      { key: 'validate', label: 'Colis « prêt à expédier » dès l’envoi', type: 'check', default: true },
    ],
  },
  yalidine: {
    kind: 'yalidine', label: 'Yalidine', api: true, fees: true, desks: true, cancel: true, label_: true, parcel: true, change: true, webhook: 'manual', exchange: 'create',
    help: 'Yalidine, ou une société sur la même plateforme (ex. Guepex : changez seulement l’adresse). API ID et token : Yalidine → Développement → Gestionnaire d’API.',
    fields: [
      { key: 'api_id', label: 'API ID', type: 'secret' },
      { key: 'api_token', label: 'API Token', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.yalidine.app/v1/' },
      { key: 'from_wilaya_id', label: 'Wilaya de départ (n°)', type: 'text', default: '', hint: 'Vide = wilaya de la boutique (Réglages)' },
    ],
  },
  ecotrack: {
    kind: 'ecotrack', label: 'EcoTrack', api: true, fees: true, desks: false, cancel: true, label_: true, parcel: true, change: true, askReturn: true, note: true, exchange: 'create',
    help: 'Mettez l’adresse du site de votre société de livraison et le token API de votre compte chez elle.',
    fields: [
      { key: 'token', label: 'Token API', type: 'secret' },
      { key: 'base_url', label: 'Adresse de la société', type: 'text', default: 'https://platform.dhd-dz.com' },
      { key: 'validate', label: 'Valider le colis dès l’envoi', type: 'check', default: true },
      { key: 'ask_collection', label: 'Demander le ramassage (sinon vous déposez les colis)', type: 'check', default: true },
      { key: 'fragile', label: 'Colis fragiles', type: 'check', default: false },
    ],
  },
  noest: {
    kind: 'noest', label: 'NOEST Express', api: true, fees: true, desks: true, cancel: true, label_: true, parcel: true, change: true, askReturn: true, retry: true, note: true, exchange: 'create',
    help: 'NOEST Express. Token API et « user GUID » : dans votre espace NOEST → API.',
    fields: [
      { key: 'api_token', label: 'Token API', type: 'secret' },
      { key: 'user_guid', label: 'User GUID', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://app.noest-dz.com' },
      { key: 'validate', label: 'Valider le colis dès l’envoi (sinon il reste en brouillon chez NOEST)', type: 'check', default: true },
      { key: 'can_open', label: 'Le client peut ouvrir le colis', type: 'check', default: false },
    ],
  },
  maystro: {
    kind: 'maystro', label: 'Maystro Delivery', api: true, fees: false, desks: false, cancel: true, label_: true, labels_: true, parcel: true, change: true, webhook: 'api',
    help: 'Maystro Delivery. Token API et identifiant de la boutique (store ID) : dans votre espace Maystro → Paramètres → API.',
    fields: [
      { key: 'token', label: 'Token API', type: 'secret' },
      { key: 'store_id', label: 'Store ID', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://backend.maystro-delivery.com/api' },
    ],
  },
  zimou: {
    kind: 'zimou', label: 'Zimou Express', api: true, fees: true, desks: true, cancel: true, label_: true, labels_: true, parcel: true, change: true, askReturn: true, note: true,
    help: 'Zimou Express. Token API : dans votre espace Zimou → API.',
    fields: [
      { key: 'api_token', label: 'Token API', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://zimou.express/api' },
    ],
  },
  elogistia: {
    kind: 'elogistia', label: 'Elogistia', api: true, fees: true, desks: true, cancel: true, label_: true, parcel: true,
    help: 'Elogistia. Clé API : dans votre espace Elogistia → API.',
    fields: [
      { key: 'api_key', label: 'Clé API', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.elogistia.com' },
      { key: 'email', label: 'E-mail du client (demandé par Elogistia)', type: 'text', default: '', hint: 'Vide = une adresse Pilotix par défaut' },
      { key: 'label_format', label: 'Format des étiquettes', type: 'text', default: '10x15', hint: '10x15 ou 15x20' },
    ],
  },
  ecom: {
    kind: 'ecom', label: 'E-COM Delivery', api: true, fees: false, desks: true, cancel: true, label_: false, parcel: true, change: true,
    help: 'E-COM Delivery. Token et clé : dans votre espace E-COM → API.',
    fields: [
      { key: 'token', label: 'Token', type: 'secret' },
      { key: 'key', label: 'Clé (key)', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://ecom-dz.net' },
      { key: 'validate', label: 'Colis « à expédier » dès l’envoi', type: 'check', default: true },
    ],
  },
  mdm: {
    kind: 'mdm', label: 'MDM Express', api: true, fees: false, desks: true, cancel: false, label_: true, labels_: true, parcel: true,
    help: 'MDM Express. Clé API (x-api-key) et identifiant de la boutique (store ID) : dans votre espace MDM → API.',
    fields: [
      { key: 'api_key', label: 'Clé API (x-api-key)', type: 'secret' },
      { key: 'store_id', label: 'Store ID', type: 'secret' },
      { key: 'token', label: 'Token (si MDM vous en donne un)', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.mdm.express' },
      { key: 'label_format', label: 'Format des étiquettes', type: 'text', default: '', hint: 'A4, A5 ou A6 (vide = format de MDM)' },
      { key: 'free_shipping', label: 'Livraison gratuite pour le client', type: 'check', default: false },
      { key: 'can_open', label: 'Le client peut ouvrir le colis', type: 'check', default: false },
      { key: 'fragile', label: 'Colis fragiles', type: 'check', default: false },
    ],
  },
  near: {
    kind: 'near', label: 'Near Delivery', api: true, fees: true, desks: true, cancel: true, label_: true, parcel: true, change: true, exchange: 'create',
    help: 'Near Delivery (livraison en point relais seulement). ApiKey et ApiSecret : dans votre espace Near → API.',
    fields: [
      { key: 'api_key', label: 'ApiKey', type: 'secret' },
      { key: 'api_secret', label: 'ApiSecret', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.neardelivery.app/api/v1' },
      { key: 'pickup_type', label: 'Remise des colis à Near', type: 'text', default: 'center', hint: 'center : vous déposez au centre Near · address : Near ramasse à votre adresse' },
      { key: 'pickup_address', label: 'Votre adresse de ramassage', type: 'text', default: '', hint: 'Seulement si « address »' },
      { key: 'sender_center_id', label: 'Votre centre Near (n°)', type: 'text', default: '' },
      { key: 'return_center_id', label: 'Centre des retours / échanges (n°)', type: 'text', default: '' },
      { key: 'size', label: 'Taille des colis', type: 'text', default: 'S', hint: 'S, M ou L' },
    ],
  },
  custom: {
    kind: 'custom', label: 'API personnalisée', api: true, fees: false, desks: false, cancel: true, label_: false,
    help: 'N’importe quelle société qui a une API : décrivez ci-dessous comment créer un colis et comment lire son statut. Demandez sa documentation API à la société.',
    fields: [
      { key: 'token', label: 'Clé / token', type: 'secret' },
      { key: 'token2', label: '2e clé', type: 'secret' },
    ],
  },
  manual: {
    kind: 'manual', label: 'Société sans API', api: false, fees: false, desks: false, cancel: false, label_: false,
    help: 'Société sans API : vous créez les colis chez elle à la main, puis vous mettez le numéro de suivi et changez les statuts ici (page Suivi).',
    fields: [],
  },
};

/** « API Livraison »: every company a shop can connect, one card each with its own logo (couriers/companies.ts). */
export { COMPANY_CARDS as CARDS } from './companies';
export type { CourierCard } from './companies';

/** Secret keys a kind needs (all must be present for "clés OK"). */
export const requiredKeys = (kind: CourierKind) => KINDS[kind]?.fields.filter((f) => f.type === 'secret' && f.key !== 'token2').map((f) => f.key) ?? [];
