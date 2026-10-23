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
  /** demandes de modification (amount, home ↔ stop desk, commune) through the API */
  mods?: boolean;
}

export const KINDS: Record<CourierKind, KindInfo> = {
  own: {
    kind: 'own', label: 'Livreur à moi', api: false, fees: false, desks: false, cancel: false, label_: false,
    help: 'Un livreur de votre équipe. S’il a un compte « Livreur », il voit ses colis dans « Ma tournée » et marque livré / échec / retour lui-même.',
    fields: [],
  },
  zr: {
    kind: 'zr', label: 'ZR Express (nouvelle plateforme)', api: true, fees: true, desks: true, cancel: true, label_: true, claims: true, mods: true,
    help: 'Nouvelle plateforme ZR Express. Clé API et identifiant du compte (tenant) : dans votre espace ZR → Paramètres → API.',
    fields: [
      { key: 'api_key', label: 'Clé API (X-Api-Key)', type: 'secret' },
      { key: 'tenant', label: 'Tenant (X-Tenant)', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.zrexpress.app' },
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
    kind: 'yalidine', label: 'Yalidine', api: true, fees: true, desks: true, cancel: true, label_: true,
    help: 'Yalidine, ou une société sur la même plateforme (ex. Guepex : changez seulement l’adresse). API ID et token : Yalidine → Développement → Gestionnaire d’API.',
    fields: [
      { key: 'api_id', label: 'API ID', type: 'secret' },
      { key: 'api_token', label: 'API Token', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://api.yalidine.app/v1/' },
      { key: 'from_wilaya_id', label: 'Wilaya de départ (n°)', type: 'text', default: '', hint: 'Vide = wilaya de la boutique (Réglages)' },
    ],
  },
  ecotrack: {
    kind: 'ecotrack', label: 'EcoTrack', api: true, fees: true, desks: false, cancel: true, label_: true,
    help: 'Sociétés qui utilisent EcoTrack (DHD, Conexlog, Anderson, Areex, World Express…). Mettez l’adresse de leur site et le token API de votre compte chez eux.',
    fields: [
      { key: 'token', label: 'Token API', type: 'secret' },
      { key: 'base_url', label: 'Adresse de la société', type: 'text', default: 'https://dhd.ecotrack.dz' },
      { key: 'validate', label: 'Valider le colis dès l’envoi', type: 'check', default: true },
      { key: 'ask_collection', label: 'Demander le ramassage (sinon vous déposez les colis)', type: 'check', default: true },
      { key: 'fragile', label: 'Colis fragiles', type: 'check', default: false },
    ],
  },
  noest: {
    kind: 'noest', label: 'NOEST Express', api: true, fees: true, desks: true, cancel: true, label_: true,
    help: 'NOEST Express. Token API et « user GUID » : dans votre espace NOEST → API.',
    fields: [
      { key: 'api_token', label: 'Token API', type: 'secret' },
      { key: 'user_guid', label: 'User GUID', type: 'secret' },
      { key: 'base_url', label: 'Adresse de l’API', type: 'text', default: 'https://app.noest-dz.com' },
      { key: 'validate', label: 'Valider le colis dès l’envoi (sinon il reste en brouillon chez NOEST)', type: 'check', default: true },
      { key: 'can_open', label: 'Le client peut ouvrir le colis', type: 'check', default: false },
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

/** The provider cards of « API Integration » (several cards can share one kind, e.g. Guepex on Yalidine). */
export const CARDS: { title: string; sub: string; kind: CourierKind; settings?: Record<string, string>; host?: string }[] = [
  { title: 'ZR Express', sub: 'ZR Express (nouvelle plateforme)', kind: 'zr' },
  { title: 'ZR Express (Procolis)', sub: 'ZR Express (ancienne : Procolis)', kind: 'zr_legacy', host: '!abex' },
  { title: 'ABEX', sub: 'Plateforme Procolis', kind: 'zr_legacy', host: 'abex', settings: { base_url: 'https://abex.procolis.com/api_v1' } },
  { title: 'Yalidine', sub: 'Yalidine', kind: 'yalidine', host: '!guepex' },
  { title: 'Guepex', sub: 'Plateforme Yalidine', kind: 'yalidine', host: 'guepex', settings: { base_url: 'https://api.guepex.app/v1/' } },
  { title: 'NOEST Express', sub: 'NOEST Express', kind: 'noest' },
  { title: 'DHD Livraison', sub: 'Plateforme EcoTrack', kind: 'ecotrack', host: 'dhd', settings: { base_url: 'https://dhd.ecotrack.dz' } },
  { title: 'Autre société EcoTrack', sub: 'Conexlog, Anderson, World Express…', kind: 'ecotrack', host: '!dhd', settings: { base_url: '' } },
  { title: 'Autre API', sub: 'API personnalisée', kind: 'custom' },
];

/** Secret keys a kind needs (all must be present for "clés OK"). */
export const requiredKeys = (kind: CourierKind) => KINDS[kind]?.fields.filter((f) => f.type === 'secret' && f.key !== 'token2').map((f) => f.key) ?? [];
