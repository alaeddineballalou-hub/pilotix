# Pilotix (extension Chrome)

Une seule extension gratuite pour Pilotix dans Chrome (et Edge). Depuis la version 2.0.0 elle remplace les deux
anciennes, **Pilotix Spy** et **Pilotix WhatsApp** : retirez-les de `chrome://extensions` après l’avoir installée.

## Français

### Ce qu’elle fait

- **AI Spy** (Marketing › AI Spy › **Chercher**) : la bibliothèque publicitaire publique de Facebook s’ouvre dans un
  navigateur, mais Facebook la refuse aux serveurs. L’extension ouvre donc la recherche dans un onglet en arrière-plan
  de **votre** Chrome, lit les pubs affichées (jusqu’à 30 environ), ferme l’onglet, prépare une petite image de chaque
  pub et les donne à votre page Pilotix, avec le lien de la vidéo d’une pub vidéo (sur les serveurs de Facebook : elle se
  lit dans AI Spy). Une seule recherche à la fois, avec une courte pause entre deux.
- **Envoyer photos** (Confirmation › une commande › **Envoyer sur WhatsApp**, sur un ordinateur) : elle ouvre WhatsApp
  Web sur la discussion du client, y colle les vraies photos des produits et met le message dessous. L’agent appuie sur
  **Entrée** : c’est lui qui envoie. Un site seul ne peut pas mettre de photos dans WhatsApp Web.
- **Lire la page** (l’icône Pilotix sur le site d’un concurrent) : le serveur de Pilotix lit lui-même le site de chaque
  pub, mais il respecte la règle « pas de robots » d’un site (robots.txt) et ne force jamais une protection
  anti-robots (**Site bloqué** dans AI Spy). Ouvrez alors le site, cliquez sur l’icône Pilotix puis sur **Lire la
  page** : votre Chrome lit ce que vous voyez (prix, prix barré, offres, livraison, ce que la boutique promet) et
  l’envoie à Pilotix, qui le range sur toutes les pubs de cette page (« Lu sur la page par votre Chrome »).

- **Fiche client** sur WhatsApp Web : à côté de la discussion ouverte, une pastille dit qui est ce numéro dans
  Pilotix (niveau, liste noire) ; un clic ouvre la fiche : ses dernières commandes et des réponses rapides du guide de
  vente du produit (un clic met la réponse dans la zone de message, l’agent l’envoie). Un agent ne voit que ses propres
  clients : un autre numéro s’affiche comme inconnu.
- **Bibliothèque de pubs** de Facebook : sur chaque pub, le produit, son tag (Identique, Ressemble, Pas le même, ou un
  de vos tags d’AI Spy) et « Suivre la boutique ». Un tag ou un suivi met la pub dans AI Spy.
- **Gestionnaire de publicités** de Meta : à côté de chaque pub, ses commandes confirmées et livrées des 7 derniers
  jours, le coût par commande confirmée et où il est par rapport au bid limit du produit (sous le bid limit, au-dessus,
  alert limit × 1,33, stop limit × 1,58) ; le bouton « Pilotix » en bas à droite ouvre la liste de toutes vos pubs (7,
  14 ou 30 jours). Une commande compte pour une pub quand elle est venue par son lien.

L’extension n’a pas de compte Pilotix à elle : tout ce qu’elle montre ou enregistre passe par **votre onglet Pilotix
ouvert** dans ce Chrome, avec vos droits. Gardez Pilotix ouvert (et connecté).

### Vie privée

- AI Spy : elle ouvre la bibliothèque publicitaire **publique** de Facebook seulement quand votre page Pilotix (ou le
  bouton « Tester ») le demande, et n’y lit que les pubs publiques et leurs images.
- Envoyer photos : elle ne lit **aucune** discussion WhatsApp. Elle ne télécharge que les photos des produits depuis
  Pilotix (`pilotix.online/api/…/lp/dp/…`), ouvre seulement la discussion du numéro demandé par Pilotix et n’envoie
  jamais de message elle-même.
- Lire la page : seulement quand vous cliquez, et seulement cet onglet (permission « activeTab » de Chrome : cet
  onglet, à ce moment-là). Le texte de la page part à votre Pilotix, qui en tire les offres et la livraison (avec l’IA
  de Pilotix quand elle est active, sinon avec des règles simples).
- Fiche client : elle lit seulement le numéro de la discussion ouverte (son titre, ou l’identifiant des messages),
  jamais leur texte. La fiche est une page de l’extension dans un cadre : WhatsApp ne peut pas la lire.
- Bibliothèque de pubs : elle lit les données publiques d’une pub seulement quand vous cliquez sur un tag ou sur
  « Suivre la boutique ». Gestionnaire de publicités : elle lit le nom et l’identifiant des pubs du tableau pour y
  mettre vos chiffres, et ne change rien dans le Gestionnaire. Les boutons et les chiffres sont dessinés dans un
  « shadow root » fermé ; la liste complète est une page de l’extension dans un cadre.
- Tout va **seulement à votre Pilotix** (pilotix.online, direct.pilotix.online, ou l’adresse de votre propre serveur
  que vous avez ajoutée). Aucun autre serveur. Elle ne publie, n’aime, ne commente et ne clique jamais rien.
- Aucun code distant, aucune dépendance.

### Installation (une fois par ordinateur, 2 minutes)

1. Téléchargez `pilotix.zip` depuis Pilotix (AI Spy › Réglages › **Télécharger**, la fenêtre Envoyer photos, ou
   `https://pilotix.online/pilotix.zip`) et décompressez-le (clic droit › **Extraire tout**) : un dossier `pilotix`
   apparaît. Gardez-le (Chrome charge l’extension depuis ce dossier).
2. Ouvrez `chrome://extensions` dans Chrome et activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l’extension non empaquetée** et choisissez le dossier `pilotix`.
4. Retirez **Pilotix Spy** et **Pilotix WhatsApp** s’ils sont là. Épinglez Pilotix (icône puzzle).
5. Rechargez Pilotix. Pour Envoyer photos, WhatsApp Web doit être connecté dans ce même Chrome.

pilotix.online et direct.pilotix.online sont déjà dans l’extension. Seulement si votre boutique a son propre serveur
Pilotix : ouvrez l’extension › **Votre boutique a sa propre adresse Pilotix ?**, tapez-la (ex.
`https://app.maboutique.dz`), cliquez sur **Ajouter** et acceptez la demande de Chrome (`http://localhost:5173` est
accepté pour le développement).

Le bouton **Tester** cherche « poussette » en Algérie et affiche le nombre de pubs trouvées. Si Facebook demande une
connexion ou une vérification, ouvrez une fois `facebook.com/ads/library` dans Chrome, puis réessayez.

### Mettre à jour

Chrome ne met pas à jour une extension chargée depuis un dossier : téléchargez le nouveau `pilotix.zip`, remplacez le
contenu du dossier `pilotix`, puis cliquez sur ⟳ (Recharger) dans `chrome://extensions`. AI Spy › Réglages dit quand
votre version est ancienne.

### Si WhatsApp Web ou Facebook change

L’extension cherche la zone de message et la fenêtre d’aperçu des photos de WhatsApp Web, et les pubs dans la page de
la bibliothèque de Facebook. Si l’un d’eux change son site, Pilotix l’affiche (« WhatsApp Web n’a pas pris les
photos », « Facebook n’a pas montré la bibliothèque de pubs ») : il faut alors mettre l’extension à jour.

---

## English

One free extension for Pilotix in Chrome (and Edge). Since 2.0.0 it replaces the two older ones, **Pilotix Spy** and
**Pilotix WhatsApp**: remove them from `chrome://extensions` once it is installed.

- **AI Spy**: Facebook’s public Ad Library works in a browser but refuses servers, so the search runs in a background
  tab of **your** Chrome; the ads (about 30 at most), a small picture of each and a video ad's link to its video (on
  Facebook's servers: it plays in AI Spy) go to your Pilotix page.
- **Send photos** (on a computer): opens WhatsApp Web on the customer’s chat, pastes the products’ real photos and puts
  the message under them; the agent presses Enter.
- **Lire la page** (the Pilotix icon on a competitor’s site): Pilotix’s server follows a site’s “no robots” rule and
  never forces an anti-robot wall (**Site bloqué**). Open the site, click the icon, then **Lire la page**: your Chrome
  reads what you see (price, crossed price, offers, delivery, what the shop promises) and sends it to Pilotix, which
  puts it on every ad of that page.

- **Customer card** on WhatsApp Web: who the open chat's number is in Pilotix (level, blacklist, last orders) and quick
  replies from the sales guide; a click puts one in the message box. An agent sees only their own customers.
- **Ad library**: on each ad, the product, a tag (Identique, Ressemble, Pas le même or one of AI Spy's own tags) and
  « Suivre la boutique »; a tag or a follow keeps the ad in AI Spy.
- **Ads Manager**: next to each ad, its confirmed and delivered orders of the last 7 days, the cost per confirmed order
  and where it stands against the product's bid limit; the « Pilotix » button lists every ad.

The extension has no Pilotix account of its own: everything goes through **your open Pilotix tab** in this Chrome,
with your rights.

Privacy: the Ad Library only when Pilotix asks, public ads only; no WhatsApp chat is read, only Pilotix’s product
photos are downloaded and no message is ever sent by the extension; **Lire la page** reads only the tab you clicked on
(“activeTab”), when you click. Everything goes only to your Pilotix; no other server, no remote code, no dependencies.

Install: download `pilotix.zip` from Pilotix, unzip it (a `pilotix` folder), open `chrome://extensions`, turn on
Developer mode, **Load unpacked** › the `pilotix` folder, remove Pilotix Spy and Pilotix WhatsApp, reload Pilotix.
pilotix.online and direct.pilotix.online are built in; a shop’s own Pilotix server is added in the popup.

## How the pieces talk

```
Pilotix page                     bridge.js (content script on Pilotix)        background.js (service worker)
 lib/spyExtension.ts  ─ window.postMessage ─▶  { source: 'pilotix-page' }  ─ port 'pilotix-search' ─▶  search queue,
 lib/waShare.ts         (ping, search, wa-send)                             ─ runtime message 'send' ─▶  wa.js
 lib/extBridge.ts     ◀─ { source: 'pilotix-ext', type: 'site-price' | 'rpc' } ◀─ tabs.sendMessage ──  askPilotix()
                         answers '<type>-done'                                                         ▲
popup.js (Lire la page) ─ runtime message 'sitePrice' ─────────────────────────────────────────────────┘
whatsapp.js (WhatsApp Web) ◀─ tabs.sendMessage 'attach' ── wa.js
```

- `<html data-pilotix-ext="2.0.0">` tells the page the merged extension is here; the older extensions use other
  message names (`pilotix-spy-page`, `pilotix-wa:send`), so only one of them acts. Loaded twice from two folders, the
  first copy on the page (`data-pilotix-ext-id`) is the only one that acts.
- What another site's piece may ask Pilotix for is listed in `actions.js` (checked by the worker) and again in
  `apps/web/src/lib/extBridge.ts` (checked by the page); the server checks the rights of whoever is logged in.

## Files

- `manifest.json`: Manifest V3, version 2.0.0.
- `background.js`: the service worker (search queue, Facebook tab, reading, pictures, Pilotix addresses, asking the
  open Pilotix tab); imports `wa.js` (Envoyer photos) and `actions.js`.
- `bridge.js`: on Pilotix pages. `whatsapp.js`: on WhatsApp Web (pastes the photos and the message). `wa-card.js` +
  `card.html/js/css`: the customer card on WhatsApp Web. `library.js`: the bar on each ad of Facebook's ad library.
  `adsmanager.js` + `adspanel.html/js/css`: Pilotix's numbers in Ads Manager. `actions.js`: what those pieces may ask
  Pilotix for.
- `parse.js`: reading Facebook's page (`readAdLibrary`) and `fromLibrary`, a port of the one in
  `packages/core/src/modules/spy.ts` (change both together: the test compares them when `packages/core` is built).
- `pictures.js`: small JPEG pictures. `price.js`: what an open page shows and its price in DA. `sites.js`: Pilotix
  addresses.
- `popup.html`, `popup.js`, `popup.css`: the extension's window.
- Tests: `npm test` (parse, price); syntax: `npm run check`.
- The website's build zips this folder (without `test/` and `package.json`) into `apps/web/public/pilotix.zip`, with
  `pilotix-whatsapp.zip` and `pilotix-spy.zip` as copies for the old links (`node scripts/extension-zips.mjs`). Change
  `version` in `manifest.json` (and `EXT_VERSION` in `apps/web/src/lib/spyExtension.ts`) with every change.
