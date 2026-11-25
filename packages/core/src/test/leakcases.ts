// Contrôle's cases (the owner's ask, 25 Nov 2026: « 1000 tests, each one a different case where it leaks, for each
// delivery company, each company alone »). Each case is a made-up situation written as plain facts — a parcel, a payment,
// a company's answers — with the problems Pilotix must find in it, and nothing else: a clean case expects nothing (no
// false alarm). Every family runs for every company with that company's own delays (just before and just after them),
// its own words (one line, or « status · reason »), and the cases a company without API can never have.
// Used by test/leakrules.test.ts; `node dist/test/leakreport.js` writes them as a table.
import { COURIER_KINDS, leakArea, type CourierKind, type FollowStatus, type LeakKind } from '@pilotix/shared';
import { PROFILES, type LeakCompany, type LeakFacts, type LeakHealth, type LeakKnown, type LeakParcel, type LeakPayout } from '../leaks/rules';

export const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

export interface LeakCase {
  /** unique: « ZR Express · Argent · payé 700 DA de moins » */
  name: string;
  company: CourierKind;
  family: string;
  facts: LeakFacts;
  expect: LeakKind[];
  /** the money each finding must carry (DA), when the case says it */
  amount?: number;
  /** the companies the findings must belong to (default: the case's company) */
  owners?: number[];
}

const NAMES: Record<CourierKind, string> = {
  own: 'Nos livreurs', zr: 'ZR Express', zr_legacy: 'ZR (Procolis)', yalidine: 'Yalidine', ecotrack: 'EcoTrack', noest: 'NOEST', maystro: 'Maystro',
  zimou: 'Zimou', elogistia: 'Elogistia', ecom: 'E-COM', mdm: 'MDM', near: 'Near', custom: 'API perso', manual: 'Société sans API',
};
const company = (kind: CourierKind, id = 1, active = true): LeakCompany => ({ id, name: NAMES[kind], kind, active });

let seq = 0;
/** A parcel on its way, all in agreement: scanned out by the depot, taken by the company, its words read. */
export function parcel(c: LeakCompany, over: Partial<LeakParcel> = {}): LeakParcel {
  const P = PROFILES[c.kind];
  const n = ++seq;
  const words = P.api ? (P.twoLines ? 'Sortie en livraison · Client contacté' : 'En livraison') : null;
  const p: LeakParcel = {
    id: n,
    ref: `PX${10_000 + n}`,
    tracking: P.api ? `${c.kind.toUpperCase()}-${700_000 + n}` : `PX${10_000 + n}`,
    companyId: c.id,
    conf: 'confirmed',
    follow: 'out_for_delivery',
    sub: null,
    total: 4500,
    cost: 400,
    isExchange: false,
    preparedAt: ago(40 * H),
    takenAt: P.api ? ago(28 * H) : null,
    deliveredAt: null,
    returningAt: null,
    cashed: false,
    sendError: null,
    updatedAt: ago(2 * H),
    words,
    wordsAt: P.api ? ago(2 * H) : null,
    meaning: P.api ? 'out_for_delivery' : null,
    meaningWords: words,
    depotOutAt: ago(30 * H),
    depotBackAt: null,
    courierBackAt: null,
    alertAt: null,
    swapped: false,
    ...over,
  };
  // the sync read the words it was given, unless the case says otherwise
  if (over.words !== undefined && over.meaningWords === undefined) p.meaningWords = over.words;
  return p;
}
const facts = (companies: LeakCompany[], parcels: LeakParcel[], more: { payouts?: LeakPayout[]; health?: LeakHealth[]; known?: LeakKnown[] } = {}): LeakFacts => ({
  now: NOW,
  companies,
  parcels,
  payouts: more.payouts ?? [],
  health: more.health ?? [],
  known: more.known ?? [],
});
let pays = 0;
const payout = (c: LeakCompany, over: Partial<LeakPayout> = {}): LeakPayout => ({
  id: ++pays,
  companyId: c.id,
  ref: `PAY-${String(300 + pays).padStart(5, '0')}`,
  amount: 12_000,
  done: true,
  at: ago(6 * D),
  doneAt: ago(5 * D),
  importedAt: ago(5 * D),
  inCaisse: true,
  lines: [],
  ...over,
});

const DELIVERED = (c: LeakCompany, P: (typeof PROFILES)[CourierKind]): Partial<LeakParcel> => ({
  follow: 'delivered',
  deliveredAt: ago(3 * D),
  cashed: true,
  ...(P.api ? { words: P.twoLines ? 'Livré · Encaissé' : 'Livré', meaning: 'delivered' } : {}),
});

/** Every case, every company. */
export function leakCases(): LeakCase[] {
  seq = 0;
  pays = 0;
  const out: LeakCase[] = [];
  for (const kind of COURIER_KINDS) {
    const c = company(kind);
    const P = PROFILES[kind];
    const add = (family: string, name: string, f: LeakFacts, expect: LeakKind[], more: Partial<LeakCase> = {}) =>
      out.push({ name: `${NAMES[kind]} · ${family} · ${name}`, company: kind, family, facts: f, expect, ...more });
    const one = (family: string, name: string, over: Partial<LeakParcel>, expect: LeakKind[], more: Partial<LeakCase> = {}) => add(family, name, facts([c], [parcel(c, over)]), expect, more);
    const api = (k: LeakKind): LeakKind[] => (P.api ? [k] : []);
    const two = (status: string, reason: string) => (P.twoLines ? `${status} · ${reason}` : reason);

    // ---------------------------------------------------------------- all in agreement: nothing to find
    one('Tout va bien', 'colis en route, scanné, pris par la société', {}, []);
    one('Tout va bien', 'livré et son argent reçu', DELIVERED(c, P), []);
    one('Tout va bien', 'retour reçu et scanné au dépôt', { follow: 'returned', depotBackAt: ago(1 * D), returningAt: ago(4 * D), ...(P.api ? { words: 'Retour vers vendeur', meaning: 'returning' } : {}) }, []);
    one('Tout va bien', 'à préparer, pas encore parti', { follow: 'to_prepare', tracking: null, takenAt: null, depotOutAt: null, words: null, meaning: null, wordsAt: null }, []);
    one('Tout va bien', 'en dispatch avec son numéro, pas encore pris', { follow: 'prepared', takenAt: null, depotOutAt: null, preparedAt: ago(10 * H), ...(P.api ? { words: 'Prêt à expédier', meaning: '' } : {}) }, []);
    one('Tout va bien', 'alerte traitée par le suivi', { follow: 'alert', sub: 'alert_traitee', alertAt: ago(5 * D) }, []);
    one('Tout va bien', 'annulé avant de partir', { follow: 'cancelled', conf: 'cancelled', takenAt: null, depotOutAt: null, updatedAt: ago(20 * D) }, []);

    // ---------------------------------------------------------------- dispatch: packed without the company's number
    const packed = (h: number, over: Partial<LeakParcel> = {}): Partial<LeakParcel> => ({ follow: 'prepared', tracking: null, takenAt: null, depotOutAt: null, preparedAt: ago(h), words: null, meaning: null, wordsAt: null, ...over });
    for (const [d, name] of [[0.5 * H, '30 min après le délai'], [6 * H, '6 h après'], [3 * D, '3 jours après']] as const)
      one('Dispatch sans numéro', name, packed(P.labelHours * H + d), api('no_tracking'), P.api ? { amount: 4500 } : {});
    one('Dispatch sans numéro', 'la société a refusé l’envoi', packed(P.labelHours * H + 2 * H, { sendError: 'Commune inconnue chez la société' }), api('no_tracking'));
    for (const [d, name] of [[-0.5 * H, '30 min avant le délai'], [-2 * H, '2 h avant']] as const) one('Dispatch sans numéro', name, packed(P.labelHours * H + d), []);
    one('Dispatch sans numéro', 'son numéro est arrivé', packed(3 * D, { tracking: `${kind}-OK` }), []);

    // ---------------------------------------------------------------- dispatch: scanned out, the company never took it
    const out_ = (h: number, over: Partial<LeakParcel> = {}): Partial<LeakParcel> => ({ follow: 'shipped', takenAt: null, depotOutAt: ago(h), ...(P.api ? { words: 'Prêt à expédier', meaning: '' } : {}), ...over });
    for (const [d, name] of [[1 * H, '1 h après le délai'], [12 * H, '12 h après'], [5 * D, '5 jours après']] as const)
      one('Sorti, jamais pris', name, out_(P.takeHours * H + d), api('out_not_taken'), P.api ? { amount: 4500 } : {});
    for (const [d, name] of [[-1 * H, '1 h avant le délai'], [-12 * H, '12 h avant']] as const) one('Sorti, jamais pris', name, out_(P.takeHours * H + d), []);
    one('Sorti, jamais pris', 'la société l’a pris', out_(5 * D, { takenAt: ago(4 * D) }), []);
    one('Sorti, jamais pris', 'colis d’un swap (jamais passé au dépôt)', out_(5 * D, { swapped: true }), []);

    // ---------------------------------------------------------------- dispatch: the company took it, never scanned out
    const taken = (h: number, over: Partial<LeakParcel> = {}): Partial<LeakParcel> => ({ depotOutAt: null, takenAt: ago(h), ...over });
    for (const [d, name] of [[1 * H, '1 h après le délai'], [30 * H, '30 h après'], [10 * D, '10 jours après']] as const) one('Pris sans scan', name, taken(P.scanHours * H + d), api('taken_not_scanned'));
    one('Pris sans scan', 'encore « En dispatch »', taken(P.scanHours * H + 3 * H, { follow: 'prepared' }), api('taken_not_scanned'));
    one('Pris sans scan', 'parti vers la wilaya', taken(2 * D, { follow: 'shipped' }), api('taken_not_scanned'));
    one('Pris sans scan', 'livré, argent pas encore reçu', taken(4 * D, { ...DELIVERED(c, P), cashed: false, deliveredAt: ago(1 * D) }), api('taken_not_scanned'));
    one('Pris sans scan', '2 h avant le délai', taken(P.scanHours * H - 2 * H), []);
    one('Pris sans scan', 'le dépôt l’a scanné', taken(3 * D, { depotOutAt: ago(3 * D + H) }), []);
    one('Pris sans scan', 'livré et payé : réglé', taken(9 * D, DELIVERED(c, P)), []);
    one('Pris sans scan', 'revenu et scanné : réglé', taken(9 * D, { follow: 'returned', depotBackAt: ago(1 * D), ...(P.api ? { words: 'Retour vers vendeur', meaning: 'returning' } : {}) }), []);
    one('Pris sans scan', 'colis d’un swap', taken(3 * D, { swapped: true }), []);

    // ---------------------------------------------------------------- statuses: the company stopped, Pilotix still says « on its way »
    const STOPS: [string, string][] = [
      ['Sortie en livraison', 'Commande annulée'],
      ['En livraison', 'Refusé par le client'],
      ['Sortie en livraison', 'Ne répond pas 3'],
      ['Vers wilaya', 'Retour demandé'],
      ['Sortie en livraison', 'الطلب ملغى'],
      ['En livraison', 'Client a refusé le colis'],
      ['Sortie en livraison', 'Numéro erroné'],
      ['Sortie en livraison', 'Ne répond pas (3)'],
      ['En livraison', 'Cancelled by customer'],
      ['Sortie en livraison', 'رفض الاستلام'],
    ];
    STOPS.forEach(([s, r], i) => {
      const follow: FollowStatus = i === 3 ? 'shipped' : i === 7 ? 'failed' : 'out_for_delivery';
      one('Arrêté par la société', `« ${two(s, r)} »`, { follow, words: two(s, r), meaning: follow, wordsAt: ago(3 * H) }, api('stop_words'), P.api ? { amount: 4500 } : {});
    });
    const GOING: [string, string][] = [
      ['Sortie en livraison', 'Client absent'],
      ['Sortie en livraison', 'Ne répond pas'],
      ['En livraison', 'Reporté au 27/11'],
      ['Sortie en livraison', 'Appel téléphonique'],
      ['En livraison', 'Client injoignable'],
    ];
    for (const [s, r] of GOING) one('Arrêté par la société', `pas un arrêt : « ${two(s, r)} »`, { words: two(s, r), meaning: 'out_for_delivery', wordsAt: ago(3 * H) }, []);
    one('Arrêté par la société', 'déjà en alerte', { follow: 'alert', alertAt: ago(2 * H), words: two('Sortie en livraison', 'Commande annulée'), meaning: 'alert' }, []);
    one('Arrêté par la société', 'alerte déjà traitée par le suivi', { sub: 'alert_traitee', words: two('Sortie en livraison', 'Commande annulée') }, []);
    one('Arrêté par la société', 'déjà en retour', { follow: 'returning', returningAt: ago(1 * D), words: two('Retour', 'Commande annulée'), meaning: 'returning' }, []);

    // ---------------------------------------------------------------- statuses: words Pilotix does not know
    for (const [follow, w] of [
      ['shipped', two('En attente de dédouanement', 'Contrôle hub')],
      ['out_for_delivery', two('Colis en transit spécial', 'Hub Sétif')],
      ['prepared', 'Nouvel état inconnu'],
      ['shipped', 'في انتظار المعالجة'],
    ] as [FollowStatus, string][])
      one('Mots inconnus', `« ${w} »`, { follow, words: w, meaning: '?', ...(follow === 'prepared' ? { depotOutAt: null, takenAt: null } : {}) }, api('unknown_words'));
    one('Mots inconnus', 'lus avant, pour d’autres mots', { words: 'Mot changé depuis', meaning: '?', meaningWords: 'Ancien mot' }, []);
    one('Mots inconnus', 'mots connus', { words: two('Sortie en livraison', 'Client contacté'), meaning: 'out_for_delivery' }, []);
    one('Mots inconnus', 'colis livré et payé', { ...DELIVERED(c, P), ...(P.api ? { words: 'Livré bizarre', meaning: '?' } : {}) }, []);

    // ---------------------------------------------------------------- statuses: delivered / lost at the company, not in Pilotix
    const liv = P.twoLines ? 'Livré · Encaissé' : 'Livré';
    for (const [d, name, follow] of [[1 * H, '1 h après le délai', 'out_for_delivery'], [2 * D, '2 jours après', 'out_for_delivery'], [3 * H, 'échec puis livré', 'failed'], [3 * H, 'en alerte puis livré', 'alert'], [3 * H, 'en retour puis livré', 'returning']] as [number, string, FollowStatus][])
      one('Livré pas suivi', name, { follow, words: liv, meaning: 'delivered', wordsAt: ago(P.catchHours * H + d), returningAt: follow === 'returning' ? ago(1 * D) : null, alertAt: follow === 'alert' ? ago(2 * H) : null }, api('delivered_not_in_pilotix'));
    one('Livré pas suivi', '1 h avant le délai', { words: liv, meaning: 'delivered', wordsAt: ago(P.catchHours * H - H) }, []);
    one('Livré pas suivi', 'colis d’échange', { words: liv, meaning: 'delivered', wordsAt: ago(2 * D), isExchange: true }, []);
    for (const [d, name] of [[1 * H, '1 h après le délai'], [3 * D, '3 jours après']] as const)
      one('Perdu pas suivi', name, { follow: 'shipped', words: 'Colis perdu', meaning: 'lost', wordsAt: ago(P.catchHours * H + d) }, api('lost_at_company'));
    one('Perdu pas suivi', '1 h avant le délai', { follow: 'shipped', words: 'Colis perdu', meaning: 'lost', wordsAt: ago(P.catchHours * H - H) }, []);
    one('Perdu pas suivi', 'déjà « Perdu » dans Pilotix', { follow: 'lost', words: 'Colis perdu', meaning: 'lost', wordsAt: ago(3 * D) }, []);

    // ---------------------------------------------------------------- statuses: delivered in Pilotix, the company says it comes back
    const back = { follow: 'delivered' as FollowStatus, cashed: false, deliveredAt: ago(1 * D), words: 'Retour vers vendeur' };
    one('Livré mais en retour', 'retour en cours chez la société', { ...back, meaning: 'returning' }, api('delivered_but_returning'));
    one('Livré mais en retour', 'rendu au vendeur par la société', { ...back, meaning: 'returned' }, api('delivered_but_returning'));
    one('Livré mais en retour', 'argent reçu : la société l’a bien livré', { ...back, meaning: 'returning', cashed: true }, []);
    one('Livré mais en retour', 'colis d’échange', { ...back, meaning: 'returning', isExchange: true }, []);

    // ---------------------------------------------------------------- returns: given back by the company, never scanned
    const given = P.twoLines ? 'Récupéré par le fournisseur · Retour' : 'Retourné au vendeur';
    for (const [d, name] of [[0.5 * D, '12 h après le délai'], [6 * D, '6 jours après']] as const)
      one('Retour pas scanné', `rendu par la société, ${name}`, { follow: 'returning', returningAt: ago(P.scanDays * D + d + D), words: given, meaning: 'returned', wordsAt: ago(P.scanDays * D + d) }, api('return_not_scanned'), P.api ? { amount: 4500 } : {});
    one('Retour pas scanné', 'rendu par la société, 12 h avant le délai', { follow: 'returning', returningAt: ago(P.scanDays * D), words: given, meaning: 'returned', wordsAt: ago(P.scanDays * D - 0.5 * D) }, []);
    for (const [d, name] of [[1 * D, '1 jour après le délai'], [9 * D, '9 jours après']] as const)
      one('Retour pas scanné', `« Retourné » par la société seule, ${name}`, { follow: 'returned', courierBackAt: ago(P.scanDays * D + d), words: given, meaning: 'returned' }, api('return_not_scanned'));
    one('Retour pas scanné', '« Retourné » par la société, 1 jour avant le délai', { follow: 'returned', courierBackAt: ago(P.scanDays * D - D), words: given, meaning: 'returned' }, []);
    one('Retour pas scanné', '« Retourné » par la société puis scanné au dépôt', { follow: 'returned', courierBackAt: ago(8 * D), depotBackAt: ago(2 * D), words: given, meaning: 'returned' }, []);

    // ---------------------------------------------------------------- returns: coming back for too long
    for (const [d, name] of [[1 * D, '1 jour après le délai'], [20 * D, '20 jours après']] as const)
      one('Retour bloqué', name, { follow: 'returning', returningAt: ago(P.returnDays * D + d), words: 'Retour en cours', meaning: 'returning', wordsAt: ago(P.returnDays * D + d) }, api('return_stalled'));
    one('Retour bloqué', '1 jour avant le délai', { follow: 'returning', returningAt: ago(P.returnDays * D - D), words: 'Retour en cours', meaning: 'returning' }, []);
    one('Retour bloqué', 'rendu hier par la société', { follow: 'returning', returningAt: ago(P.returnDays * D + 5 * D), words: given, meaning: 'returned', wordsAt: ago(1 * D) }, []);

    // ---------------------------------------------------------------- returns: back at the depot, the company says delivered
    one('Retour mais livré', 'scanné au dépôt, la société dit « Livré »', { follow: 'returned', depotBackAt: ago(1 * D), words: liv, meaning: 'delivered' }, api('return_but_delivered'));
    one('Retour mais livré', 'scanné au dépôt, la société dit « Retour »', { follow: 'returned', depotBackAt: ago(1 * D), words: 'Retour vers vendeur', meaning: 'returning' }, []);

    // ---------------------------------------------------------------- dispatch: cancelled after it left, not back
    const left = (d: number, over: Partial<LeakParcel> = {}): Partial<LeakParcel> => ({ follow: 'cancelled', conf: 'cancelled', updatedAt: ago(d), takenAt: P.api ? ago(10 * D) : null, depotOutAt: ago(10 * D), ...over });
    for (const [d, name] of [[1 * D, '1 jour après le délai'], [20 * D, '20 jours après']] as const) one('Annulé dehors', name, left(P.cancelDays * D + d), ['cancelled_but_out'], { amount: 4500 });
    one('Annulé dehors', '1 jour avant le délai', left(P.cancelDays * D - D), []);
    one('Annulé dehors', 'revenu et scanné', left(20 * D, { depotBackAt: ago(2 * D) }), []);
    one('Annulé dehors', 'colis swappé vers une autre commande', left(20 * D, { sub: 'annule_swappe' }), []);
    one('Annulé dehors', 'jamais parti', left(20 * D, { takenAt: null, depotOutAt: null }), []);

    // ---------------------------------------------------------------- statuses: an alert waiting too long
    const alert = (h: number, over: Partial<LeakParcel> = {}): Partial<LeakParcel> => ({ follow: 'alert', alertAt: ago(h), ...(P.api ? { words: two('Echec de livraison', 'Client absent'), meaning: 'alert' } : {}), ...over });
    for (const [d, name] of [[1 * H, '1 h après le délai'], [3 * D, '3 jours après']] as const) one('Alerte en retard', name, alert(P.alertHours * H + d), ['alert_late']);
    one('Alerte en retard', '1 h avant le délai', alert(P.alertHours * H - H), []);
    one('Alerte en retard', 'traitée', alert(5 * D, { sub: 'alert_traitee' }), []);

    // ---------------------------------------------------------------- money: delivered, never received
    const done = (d: number, over: Partial<LeakParcel> = {}): Partial<LeakParcel> => ({ ...DELIVERED(c, P), cashed: false, deliveredAt: ago(d), ...over });
    for (const [d, name] of [[1 * D, '1 jour après le délai'], [30 * D, '30 jours après']] as const) one('Pas payé', name, done(P.payDays * D + d), ['not_paid'], { amount: 4100 });
    one('Pas payé', 'échange livré, pas reçu', done(P.payDays * D + D, { follow: 'exchanged' }), ['not_paid'], { amount: 4100 });
    one('Pas payé', 'prix de la société pas connu', done(P.payDays * D + D, { cost: 0 }), ['not_paid'], { amount: 4500 });
    one('Pas payé', '1 jour avant le délai', done(P.payDays * D - D), []);
    one('Pas payé', 'argent reçu', done(P.payDays * D + 5 * D, { cashed: true }), []);
    one('Pas payé', 'rien à encaisser (0 DA)', done(P.payDays * D + 5 * D, { total: 0 }), []);
    // the same day for every company: each one's own delay decides
    one('Pas payé', 'livré il y a 9 jours (le délai de cette société)', done(9 * D), P.payDays < 9 ? ['not_paid'] : []);

    // ---------------------------------------------------------------- the company's link
    const sick = (h: number | null, active = true): LeakFacts => {
      const cc = company(kind, 1, active);
      return facts([cc], [parcel(cc)], { health: [{ companyId: 1, okAt: ago(30 * H), error: h === null ? null : `${NAMES[kind]} refuse les clés API`, errorSince: h === null ? null : ago(h) }] });
    };
    for (const [d, name] of [[0.5 * H, '30 min après le délai'], [2 * D, 'depuis 2 jours']] as const) add('Société muette', name, sick(P.syncHours * H + d), api('sync_down'));
    add('Société muette', '30 min avant le délai', sick(P.syncHours * H - 0.5 * H), []);
    add('Société muette', 'répond bien', sick(null), []);
    add('Société muette', 'société désactivée', sick(3 * D, false), []);

    // ---------------------------------------------------------------- money: the company's payments (those that pay by API)
    if (P.pay) {
      const order = parcel(c, { ...DELIVERED(c, P), total: 5200, cost: 400 });
      const line = (amount: number, over: Record<string, unknown> = {}) => ({ tracking: order.tracking, amount, costs: 0, delivery: 400, ...over });
      const payCase = (name: string, p: Partial<LeakPayout>, expect: LeakKind[], more: Partial<LeakCase> = {}, parcels: LeakParcel[] = [order], known: LeakKnown[] = []) =>
        add('Paiements', name, facts([c], parcels, { payouts: [payout(c, p)], known }), expect, more);
      for (const [d, name] of [[1 * D, '1 jour après le délai'], [10 * D, '10 jours après']] as const)
        payCase(`prêt à l’agence, pas récupéré (${name})`, { done: false, importedAt: null, doneAt: null, at: ago(P.pickupDays * D + d), lines: null }, ['payout_waiting'], { amount: 12_000 });
      payCase('prêt à l’agence, 1 jour avant le délai', { done: false, importedAt: null, doneAt: null, at: ago(P.pickupDays * D - D), lines: null }, []);
      payCase('prêt à l’agence, 0 DA', { done: false, importedAt: null, doneAt: null, amount: 0, at: ago(9 * D), lines: null }, []);
      payCase('remis il y a 3 h, pas dans une caisse', { importedAt: null, doneAt: ago(3 * H), at: ago(4 * H) }, ['payout_not_in_caisse'], { amount: 12_000 });
      payCase('remis il y a 1 h (import en cours)', { importedAt: null, doneAt: ago(1 * H), at: ago(2 * H) }, []);
      payCase('versement annulé dans la caisse', { inCaisse: false }, ['payout_not_in_caisse']);
      payCase('dans la caisse', {}, []);
      payCase('ligne d’un colis inconnu', { lines: [line(3900, { tracking: 'ZR-99999999' })] }, ['paid_unknown'], { amount: 3900 });
      payCase('ligne sans numéro de colis', { lines: [line(2500, { tracking: null })] }, ['paid_unknown'], { amount: 2500 });
      payCase('ligne d’un colis connu', { lines: [line(4800)] }, []);
      for (const [amount, name] of [[4800, 'prix moins livraison'], [5200, 'prix entier'], [4830, 'à 30 DA près']] as const) payCase(`montant juste : ${name}`, { lines: [line(amount)] }, []);
      payCase('montant juste : moins livraison et frais', { lines: [line(4700, { costs: 100 })] }, []);
      payCase('montant juste : prix de livraison de la société (500 DA)', { lines: [line(4700, { delivery: 500 })] }, []);
      payCase('payé 700 DA de moins', { lines: [line(4100)] }, ['paid_wrong_amount'], { amount: 700 });
      payCase('payé 1 000 DA de trop', { lines: [line(5800)] }, ['paid_wrong_amount'], { amount: 1000 });
      payCase('prix de livraison inconnu : pas jugé', { lines: [line(3000, { delivery: null })] }, [], {}, [{ ...order, cost: 0 }]);
      add('Paiements', 'payé deux fois', facts([c], [order], { payouts: [payout(c, { lines: [line(4800)] }), payout(c, { lines: [line(4800)] })] }), ['paid_twice'], { amount: 4800 });
      add('Paiements', 'payé trois fois : un seul problème', facts([c], [order], { payouts: [payout(c, { lines: [line(4800)] }), payout(c, { lines: [line(4800)] }), payout(c, { lines: [line(4800)] })] }), ['paid_twice']);
      add('Paiements', 'deux colis différents', facts([c], [order, parcel(c, { ...DELIVERED(c, P), tracking: 'ZR-2' })], { payouts: [payout(c, { lines: [line(4800)] }), payout(c, { lines: [line(4100, { tracking: 'ZR-2' })] })] }), []);
      const backAtDepot = parcel(c, { follow: 'returned', depotBackAt: ago(2 * D), words: 'Retour vers vendeur', meaning: 'returning' });
      payCase('payé, et le colis est revenu au dépôt', { lines: [line(4800, { tracking: backAtDepot.tracking })] }, ['paid_but_back'], { amount: 4800 }, [backAtDepot]);
      const neverLeft = parcel(c, { follow: 'cancelled', conf: 'cancelled', takenAt: null, depotOutAt: null, updatedAt: ago(1 * D) });
      payCase('payé, et le colis n’est jamais parti', { lines: [line(4100, { tracking: neverLeft.tracking })] }, ['paid_but_back'], {}, [neverLeft]);
      payCase('payé, colis livré il y a longtemps', { lines: [line(4800, { tracking: 'ZR-OLD-1' })] }, [], {}, [], [{ id: 9001, ref: 'PX9001', companyId: c.id, tracking: 'ZR-OLD-1', follow: 'delivered', total: 5200, cost: 400, depotBack: false, neverLeft: false, isExchange: false, swapped: false }]);
      payCase('paiement en attente : « Pas payé » attend', { done: false, importedAt: null, doneAt: null, at: ago(1 * D), lines: [line(4800)] }, [], {}, [{ ...order, cashed: false, deliveredAt: ago(P.payDays * D + 2 * D) }]);
    }
  }

  // ---------------------------------------------------------------- each company alone, side by side
  const zr = company('zr', 1);
  const yal = company('yalidine', 2);
  const eco = company('ecotrack', 3);
  const own = company('own', 4);
  const side = (name: string, f: LeakFacts, expect: LeakKind[], owners: number[]) => out.push({ name: `Chaque société seule · ${name}`, company: 'zr', family: 'Chaque société seule', facts: f, expect, owners });
  side('ZR ne répond plus, Yalidine répond', facts([zr, yal], [parcel(zr), parcel(yal)], { health: [{ companyId: 1, okAt: ago(5 * H), error: 'ZR ne répond pas', errorSince: ago(3 * H) }, { companyId: 2, okAt: ago(0.2 * H), error: null, errorSince: null }] }), ['sync_down'], [1]);
  side('Yalidine ne répond plus, ZR répond', facts([zr, yal], [parcel(zr), parcel(yal)], { health: [{ companyId: 2, okAt: ago(5 * H), error: 'Yalidine refuse les clés', errorSince: ago(3 * H) }, { companyId: 1, okAt: ago(0.2 * H), error: null, errorSince: null }] }), ['sync_down'], [2]);
  const yalOrder = parcel(yal, { ...DELIVERED(yal, PROFILES.yalidine), tracking: 'SAME-123' });
  side('même numéro chez deux sociétés : la ligne de ZR ne paie pas le colis Yalidine', facts([zr, yal], [yalOrder], { payouts: [payout(zr, { lines: [{ tracking: 'SAME-123', amount: 4100, costs: 0, delivery: 400 }] })] }), ['paid_unknown'], [1]);
  side('ZR et EcoTrack arrêtent chacun un colis', facts([zr, eco], [parcel(zr, { words: 'Sortie en livraison · Commande annulée' }), parcel(eco, { words: 'En livraison · Refusé par le client' })]), ['stop_words', 'stop_words'], [1, 3]);
  side('livré il y a 9 jours chez ZR, Yalidine et nos livreurs : chacun son délai', facts([zr, yal, own], [zr, yal, own].map((c) => parcel(c, { ...DELIVERED(c, PROFILES[c.kind]), cashed: false, deliveredAt: ago(9 * D) }))), ['not_paid', 'not_paid'], [1, 4]);
  side('une société sans API à côté de ZR : rien de faux pour elle', facts([zr, company('manual', 5)], [parcel(company('manual', 5), { follow: 'shipped', takenAt: null, depotOutAt: ago(10 * D) }), parcel(zr)]), [], []);
  return out;
}

export const areaOf = (k: LeakKind) => leakArea(k);
