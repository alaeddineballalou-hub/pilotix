# Original Pilotix — inventory (what to rebuild)

Source: the original single-file app (/home/claude/ref/legacy.html). Hash routing `#/<page>/<sub>/...`. Its demo used the shop "Baby Joy"
(refs "BJ…"); the new app uses refs "PX…" and the shop name from settings. Screenshots: /home/claude/ref/shots, text: ref/text, markup: ref/dom.

## 1. Navigation (final layout)
Menu shown: Accueil · Dashboard · Commandes{Confirmation, Dépôt, Suivi, Livré, Annulé (with counts)} · Scanner · SAV · Ma tournée (livreur) ·
Produits & stock · Clients · Publicité (marketer) · Caisse (admin) · Sociétés de livraison (admin) · Utilisateurs (admin) · Management (admin) · Réglages (admin).
Sub-pages appear as a stage bar at the top of the page (`.bjm-bar`, flow with › for Confirmation and Dépôt).

| id | Label | Roles | Sub-pages |
|---|---|---|---|
| accueil | Accueil | all | – |
| dashboard | Dashboard | agent_manager, vendeur | confirmation, depot, suivi, livreurs, sav |
| commandes | Commandes | confirmation, suivi, depot | (all orders) livrees "Livré", annulees "Annulé" |
| confirmation | Confirmation | confirmation | nouvelles "Nouvelles", attente "En cours", confirmees "Confirmées" (+ terminees) |
| depot | Dépôt | depot | preparer "En préparation", prepares "En dispatch", dispatchees "Dispatchées", enlivraison "En livraison", retours "Retours / Échanges" |
| scanner | Scanner | depot | – |
| suivi | Suivi | suivi | alertes, traites, livres, annules, reclamation "Réclamation", swap "Swap" |
| livrees / retournees | hidden pages | confirmation, suivi, depot | – |
| sav | SAV | confirmation, suivi, depot | tickets, nouveau "+ Nouveau ticket", attente, depot "Au dépôt", livraison, livres, annules |
| tournee | Ma tournée | livreur | – |
| produits | Produits & stock | depot | stock, produits, mouvements |
| clients | Clients | confirmation, suivi | – |
| publicite | Publicité | marketer | – |
| caisse | Caisse | admin | due "À recevoir", done "Déjà reçu" |
| livraison | Sociétés de livraison | admin | societes "Sociétés & tarifs", api "API Integration", livreurs |
| utilisateurs | Utilisateurs | admin | roles, admins, vendeurs, agents, marketeurs, managers "Agent managers" |
| management | Management | admin | statuts, paie "Paie des agents", prix "Prix de livraison", canaux "Canaux de vente" |
| reglages | Réglages | admin | – |

Default page: livreur → tournee; confirmation only → confirmation; others → accueil. Menu counts refresh every 60 s.

## 2. Roles
admin Administrateur · vendeur "Vendeur (propriétaire)" (also gets confirmation, suivi, depot, marketer) · agent_manager (also confirmation) ·
confirmation · suivi · depot · livreur · marketer "Marketeur". Several roles add up; admin can do everything.
Descriptions (Rôles page): admin "Tout voir, tout régler (sociétés, utilisateurs, prix)"; vendeur "Le propriétaire de la boutique : commandes,
confirmation, suivi, stock, clients et publicité (sans utilisateurs ni réglages)"; agent_manager "Fait tout ce que fait un agent, et supervise…";
confirmation "Appeler les clients et confirmer les commandes"; suivi "Suivre les colis…"; depot "Préparer, expédier, recevoir les retours, gérer le stock";
livreur "Voir sa tournée, marquer livré / échec / retour"; marketer "Ses ad sets et ses résultats (publicité)".
Team view (assign/remove agents): admin, vendeur, agent_manager. Managers see dashboard areas from setting mgrScope (admin edits a "scope" card).
Delivery status changes: suivi = all; depot = to_prepare, prepared, shipped, returned; livreur = out_for_delivery, delivered, failed, returning.
Products locked once shipped ("Commande déjà partie : produits non modifiables").

## 3. Statuses
Confirmation (conf_status): to_check À vérifier (warn, todo) · new Nouvelle (info, todo) · no_answer Pas de réponse (mid, todo; shown as "Tentative 01/02/03"
by attempts) · busy Occupé (mid, todo) · callback À rappeler (mid, todo) · postponed Reportée (mid, todo) · no_stock Confirmée sans stock (warn) ·
confirmed Confirmée (ok) · cancelled Annulée (bad) · duplicate Doublon (off) · wrong_number Faux numéro (bad) · fake Fausse commande (bad).
Delivery (follow_status): to_prepare À préparer (info) · prepared Préparée (info) · shipped Expédiée (mid) · out_for_delivery En livraison (mid) ·
failed Reportée / échec (warn) · alert Alerte (bad) · in_exchange En échange (mid) · delivered Livrée (ok) · returning Retour en cours (bad) ·
returned Retournée (bad) · exchanged Échangée (off) · lost Perdue (bad) · cancelled Annulée (off).
Suivi sub-statuses: alert_traitee "Alerte traitée", annule_swappe "Annulé · swappé", livraison_swappe "En livraison · swappé".
Custom statuses: admin renames (fr/ar), recolours, reorders, hides, adds custom statuses that "behave like" a base one (Management → Statuts; settings statusLabels/customStatuses).
callback/postponed: datetime "Rappeler quand ?" / "Reporter à quand ?" + note (default +2 h / tomorrow 10:00). cancelled/fake/wrong_number: reason required.
Reasons: shared `status.cancelReason/failReason/returnReason`. Channels: site, facebook, instagram, tiktok, appel, whatsapp, autre.
Courier kinds: own "Livreur à moi", zr "ZR Express", zr_legacy "Procolis", yalidine, ecotrack (DHD, Conexlog…), noest "NOEST Express", custom "API personnalisée", manual "sans API".

## 4. Pages

### Accueil
Users without confirmation/suivi/depot: "Bonjour <name>" (livreur: "Voir ma tournée"). Card "Maintenant" (KPI links): À appeler maintenant (+ rappels prévus plus tard),
Confirmées sans stock, À préparer (+ déjà préparées), En livraison (+ en échec / alerte), admin: Argent à recevoir (delivered not cashed).
Card "Période" tabs Aujourd'hui/Hier/7 jours/30 jours/Ce mois: Commandes reçues ("à appeler"), Confirmées (taux), Annulées, Expédiées ("encore en route"),
Livrées (taux de livraison), Retours, Encaissé (livrées) ("dont produits"). Table "Agents de confirmation": Agent, Traitées, Confirmées, Taux conf., Livrées, Retours, Taux livraison.
"Livreurs" card. Presence card "Agents en ligne": En appel / En ligne / Hors ligne (heartbeat every 60 s).

### Dashboard (tabs Confirmation, Dépôt, Suivi, Livreurs, SAV; period Aujourd'hui/7 jours/30 jours/Ce mois/Mois dernier)
Dépôt KPIs: En préparation, En dispatch, Dispatchées, En livraison, Retours à recevoir, Expédiées sur la période, Délai confirmation → expédition (median); table Personne/Emballées/Expédiées/Retours reçus.
Suivi KPIs: Alertes à traiter, En route, Annulés en retour, Livrées, Retournées, Taux de livraison; table Agent/Livrées/Retournées/Taux.
Livreurs KPIs: En tournée, Livrées, Retours, Taux, À encaisser; table Livreur/En tournée/Livrées/Retours/Taux/À encaisser.
SAV KPIs: En attente, En traitement, Plus de 48 h, Nouveaux; table Responsable/À traiter/Réglés.
Confirmation (teams): filters period incl. "Dates personnalisées…", date type Date de création / Changement de statut, team + agent selects, rate type Taux (business) vs Performance (agents);
"Comparaison des équipes": Équipe, Agents, Commandes, Confirmées, Performance, Taux, Appels, En cours, Rappels en retard; card "Délais et tentatives" (late first calls, missed tries); team editor (setting teams).

### Commandes
Header: 5 clickable KPIs that are tabs: Confirmation "à appeler" (warn), Dépôt, Suivi, Livré (% of total, ok), Annulé ("x à la confirmation · y retours", bad).
Generic list: search "Nom, téléphone, réf. PX…, n° de suivi"; filters Confirmation (Toutes / À traiter / statuses), Livraison (Toutes / À préparer + préparées /
En cours de livraison / Retours / statuses), Société (Toutes / Pas encore choisie / …), Wilaya, Source, Agent. Columns: Commande, Client, Adresse, Produits, Total,
Confirmation, Livraison, Société, Agent; flags "DOUBLON ?" and "LISTE NOIRE". Row checkboxes → navy bulk bar: Société…, Statut livraison…, Envoyer aux sociétés,
Imprimer les bons, Exporter, Désélectionner. Row click → order card. "Toutes les commandes": "+ Nouvelle commande", "⟳ Mettre à jour depuis les sociétés",
status tabs with counts (À préparer, Préparées, Expédiées, En livraison, Reportées / échec, Alertes, En échange, Retour en cours, Retournées, Livrées, Annulées).
Livrées adds columns "Frais société", "Encaissé" (badge Encaissé/Non encaissé) + card "Bilan livré": date range, tabs Total livré / Par société de livraison,
columns Société, Livrés, Encaissé par la société, Reçu, Frais livraison, Surpoids, Retours, Retours · frais, Total; "Net à recevoir".
Livrées/Retournées hidden pages: KPIs Livrées, Retournées, Taux de livraison, En route vers le dépôt.

### Confirmation queue
Sub-pages: nouvelles (new), attente (to_check, no_answer, busy, callback, postponed), confirmees (confirmed, no_stock), terminees (duplicate, wrong_number, fake).
Header title + count badge + description + "+ Nouvelle commande". Collapsible "Statistiques" section (Masquer/Afficher).
Tools: search "Réf., nom du client, téléphone, n° de suivi…"; "Filtres (n)" panel: Wilaya, Agent (incl. "Sans agent"), Canal, Statut, Du, Au, Effacer;
"Colonnes (x/y)" checkbox list saved per sub-page + "Tout afficher"; "Exporter" (CSV up to 3000).
Toggleable columns: Source UTM, N° de suivi, Créée par, Canal, Produit, SKU, Client, Téléphone, Wilaya, Commune, Agent, Total, Temps passé, Créée le,
Prochain appel (Confirmées: Confirmée le + Livraison), Statut. Sortable headers (↕ ▲ ▼). Default sort: created desc (nouvelles, terminees), confirmed_at desc (confirmees), next_call_at asc nulls first (attente).
Each row: expand chevron (round 32px, navy when open) · checkbox · "Commande" (bold ref + created date + countdown chip `.bj-cd`) · columns ·
3 orange 36px buttons `.qo`: Appeler (tel:), Message (WhatsApp "Bonjour <nom>, ici <boutique> à propos de votre commande <ref>."), Modifier (pencil → order form).
Agent cell: badge + "−" remove (admins/managers). Temps passé: badge, warn after 24 h. Statut: pill select (confirmed / no_stock open the order form to confirm; others save → toast).
Pager: Total N, ‹ ›, page, size 20/50/100, Aller à. Bulk toolbar: Dupliquer, Message, Assigner un agent (select), Retirer l'agent, Statut de confirmation (select), Bloquer le client.
KPI blocks per sub-page:
- Nouvelles: "Rapidité du 1er appel" — Maintenant: En attente du 1er appel (x sans agent), En retard maintenant, Attend depuis le plus longtemps (ref · name);
  Aujourd'hui: Reçues / appelées, 1er appel à temps, Délai médian, Appelées en moins de 5 min; bar "Délai du 1er appel" (<5 min, 5–15, 15–30, 30–60, >1 h).
  "Nouvelles commandes de la période": Reçues (amount), Pas encore appelées, Appelées, Confirmées, Annulées, Taux de confirmation (confirmées ÷ (confirmées + annulées)).
- En cours: En cours, À rappeler maintenant, En retard, Rappels programmés, Sans agent, Appels par commande, 3 appels ou plus, En cours depuis +48 h, Récupérées, Taux de récupération + "Par agent" table.
- Confirmées: Confirmées, Taux de confirmation, Panier moyen, Délai création → confirmation, Commandes avec upsell, Taux d'upsell, CA upsell, Packs quantité + "Par agent".
Single-order mode: "Commande suivante →" + "Passer à la suivante automatiquement".
Expanded row: note chips (Client / Livreur / Interne) · product table (Produit + chip upsell/pack, Variante select, Quantité −/+, Prix unitaire (locked when fixed price), Prix (q × pu), ✕) ·
"Ajouter un produit" search + history link · delivery table (Type Stop desk / Domicile + "tarif : X" when grid differs, Prix de livraison inline input, Remise, Total) ·
offers row (Packs chips with saving, Produits liés chips) · save bar "Commande modifiée" Annuler / Enregistrer. "Gardez au moins un produit."
Timers: slots Matin 9–12, Midi 12–16, Soir 16–21; 3 tries; first call due 15 min after assignment + 5 min per more recent order ahead; night orders count from 9 h.
Chip `.bj-cd`: "⏱ mm:ss" ok (green) / soon (<5 min, blinking) / late "⏱ +…" (coral) / wait "⏳ créneau dans …" (grey). Agent banner `#bj-alert.bj-alert`
(📞, "Appels en retard" / "Commandes de la nuit" / "Appels à faire · créneau X (jusqu'à Hh)", counts) refreshed ~55 s. (shared/src/timers.ts implements the rules.)

### Order form modal (`.pxo`)
"Nouvelle commande" / "Modifier la commande X" / "Échange pour X". Sections: Notes (source select + Note client/livreur/équipe) · Détails du client (Nom, Téléphone 05/06/07 + "+ Deuxième numéro",
Wilaya, Commune (communes list), Adresse, Type de livraison Domicile / Stop desk + bureau, "Livrable" check, Société) · Détails du produit (lines: Produit search, Variante, Quantité −/+, Prix, Total, ×;
"+ Ajouter un produit", "★ Upsell", packs + linked products, "Rupture de stock" flags) · Livraison (Frais from grid, Remise capped per product (red when over), "Total à encaisser").
Footer: Fermer · "Créer la commande"/"Enregistrer" · confirmers: "Créer & marquer confirmé".

### Order card modal
Sections Client, Produits, Livraison, Historique (timeline). Actions: Modifier, Changer la confirmation…, Changer de société / Envoyer à <société>, Étiquette, Statut chez <société>,
Annuler le colis, Changer la livraison…, Ajouter une note, Liste noire, Créer un échange, Imprimer. Fields: Suivi, Statut société, Tentatives, notes.

### Dépôt
En préparation: "Quantités à préparer" (Produit, À préparer, Déjà préparé, Commandes, Stock dépôt with "manque N"), "Imprimer la feuille", list "Commandes à préparer".
En dispatch: scan card + list with "Retirer". Dispatchées: "Remis depuis" badge (ok/warn/bad at 24 h/48 h). En livraison: "Parti depuis" (info/warn 4 d/bad 7 d).
Retours / Échanges: "Réceptionner un retour" (search ref/tracking/phone; "Reçu au dépôt" → returned + restock), lists "Retours en route vers le dépôt", "Échanges en cours chez le client".

### Scanner
"Que faites-vous ?" Expédier / Retour / Échange; input "Scanner le n° de suivi ou la réf. PX…" (barcode gun, phone camera via BarcodeDetector/ZXing, photo upload);
beeps; results Bon / Stop / "! À vérifier"; history; "Annuler ce scan"; picker when several match.

### Suivi
"Suivi des livraisons" + "⟳ Mettre à jour depuis les sociétés". KPI tabs Alertes, Traités, Livrés (30 days), Annulés. Columns Commande, Client, Wilaya, Produits, Livraison, Depuis, Statut + actions:
Traiter (modal "Ce qui a été fait": Client joint : nouvelle date de livraison / Adresse ou téléphone corrigé / Client injoignable : nouvel essai / Autre; Nouvelle date; Note), Client annule, Livré, Nouvelle alerte.
Swap: give a cancelled parcel to another confirmed unshipped order (ranked same wilaya / same product / other variant) then "📋 Copier pour ZR" sheet.
Réclamation: tabs Rechercher une commande / Sociétés de livraison / Livreurs; message (Bonjour, Réclamation, N° de suivi, Réf., Client, Problème) via WhatsApp/e-mail/copy;
statuses En attente / Toujours en attente; ready reasons "Client joint : merci de relivrer le colis", "Colis en retard / bloqué", "Le client dit qu'on ne l'a pas appelé".

### SAV
KPIs En attente, Au dépôt, En livraison, Plus de 48 h, Livrés en 7 jours (avg delay). Search "N° ticket, réf. PX…, client, téléphone". Columns Commande, Problème, Souhait, Ticket, Dépôt / livraison, Responsable, Depuis.
Types defect, missing, wrong, late, notdelivered, refund, exchange, help, other. Wishes exchange, refund, part, repair, info. Statuses open "En attente" (bad), progress "En traitement" (mid), resolved "Livré" (ok), closed "Annulé" (off).
New ticket: find order (or "sans commande"), Ce que veut le client, Détails, Responsable. Exchange kinds Même article (neuf) / Autre couleur / taille / Autre produit / Pièces seulement → creates an exchange order.

### Ma tournée (livreur)
"🖨 Imprimer ma feuille de route"; KPIs À livrer (+amount), Livrées aujourd'hui, À récupérer au dépôt; card per order (ref, status, total, customer, commune, address, items, delivery note)
with "Appeler <tel>", WhatsApp, En route, ✓ Livrée, Échec / reporté…, Retour…; chat with the shop.

### Produits & stock
Stock tab: search, "Seulement les manquants", "Avec les produits masqués"; columns Produit/SKU, Dépôt, En stock, Réservé, Disponible, Prix achat; actions + Entrée, Compter, Perte, Alerte de stock bas, Transférer.
Produits tab: columns Produit, Variantes, Prix, Achat, Marge, État; form Nom, SKU, Prix de vente, Prix d'achat, Poids (kg), Photo (lien), Service, Actif, variants, pièces, Packs quantité (qty + price), Produits liés;
"Remise maximale par produit" card. Mouvements tab.

### Clients
Search "Nom ou téléphone…", "Liste noire seulement"; columns Client (+LISTE NOIRE), Téléphone, Wilaya, Commandes, Livrées, Retours, Dernière; click → history modal (Commande, Produits, Total, Confirmation, Livraison) + blacklist toggle.

### Publicité (marketer) — now with Pilotix's own Meta connection
Header period Du/Au, product filter, USD→DZD rate per month. KPIs Dépense pub, Commandes reçues / livrées, Coût par commande / par livrée, Bénéfice net après pub.
Sections: Résultats par produit, Ad sets, Meta jour par jour, Pubs de cet ad set, Bénéfice réel · ligne par ligne, Mois par mois (closes), "Quel produit vend cet ad set ?".
Diagnostics: Augmenter le budget, Couper, Hook faible, Fatigue des vidéos, Audience épuisée, La page ne convertit pas.

### Caisse (admin)
"À recevoir": delivered uncashed grouped by company (Commande, Livrée, Client, Produits, Payé par le client, Net), check → "Argent reçu", Exporter. "Déjà reçu": Reçu le, Commande, Société, Client, Montant.
Livreurs cash module: Colis en main, Colis livrés, Encaissé / Non encaissé, "Ta part", "Net à ramasser"; "Encaisser la sélection", "Tout encaisser"; pay light/heavy.

### Sociétés de livraison (admin)
API cards per provider (ZR, Procolis, Yalidine, Guepex, NOEST, DHD, EcoTrack, Conexlog…, Autre API JSON template). Table Société, Connexion (clés OK / manquantes), À expédier, En livraison, État.
Livreurs: Livreur, Compte, Fin de tournée, À expédier, En livraison. Per company: Tarifs, Feuille de route, Stop desks, Statuts, Tester, Aperçu de l'envoi.

### Utilisateurs (admin)
Rôles table (Rôle, Ce qu'il fait, Pages chips, Utilisateurs); per role list (Nom, Téléphone, Rôles, Dernière connexion, État) + "+ Nouvel agent"; form Nom, Téléphone, Email, Mot de passe, rôles, livreur's company.

### Management (admin)
Statuts (rename fr/ar, colour, behaves-like, enable, reorder per group conf/depot/suivi/sav/livraison) · Paie des agents (agents threshold/below/above/upsell bonus/form order; managers per delivered;
suivi per delivered; depot per prepared; call delays & slots; livreur light/heavy) + monthly payslips · Prix de livraison (named grids per wilaya Domicile/Bureau, assigned to products) ·
Canaux de vente (Google Sheets, WooCommerce, Shopify, YouCan, Lightfunnels, API, Connecteur; Nom, Créateur, SKU obligatoire, Actif, sync, webhook).

### Réglages (admin)
Boutique (nom, wilaya de départ, société par défaut, annulation auto après N appels, modèle WhatsApp) · Dépôts (Nom, Wilaya, Commune, Adresse, par défaut, Actif) ·
Commandes du site web (webhook URL + key, sample JSON, "Changer la clé") · Mise à jour automatique des colis (cron key).

## 5. Exports and printing
CSV (BOM + ";"): Réf, Créée, Client, Téléphone, Téléphone 2, Wilaya, Commune, Adresse, Stop desk, Produits, Pièces, Produits DA, Livraison DA, Remise, Total DA, Confirmation, Livraison, Société, Suivi, Agent, Note livreur.
Print: picking sheet, delivery slips "Imprimer les bons", livreur route sheet, order print.
