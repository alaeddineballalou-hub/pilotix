# Pilotix Spy (extension Chrome)

## Français

### Ce qu’elle fait

La page **Marketing › AI Spy** de Pilotix cherche les pubs Facebook de vos concurrents en Algérie. La bibliothèque
publicitaire publique de Facebook s’ouvre normalement dans un navigateur, mais Facebook la refuse aux serveurs, et son
API officielle ne donne pas les pubs des boutiques algériennes. Cette extension gratuite fait donc la recherche dans
**votre** Chrome :

1. vous cliquez sur **Chercher** dans AI Spy ;
2. l’extension ouvre la bibliothèque de pubs de Facebook pour ce mot-clé dans un onglet en arrière-plan ;
3. elle lit les pubs affichées (jusqu’à 30 environ), ferme l’onglet et prépare une petite image de chaque pub ;
4. elle donne les pubs à votre page Pilotix, qui les enregistre avec sa propre API.

Une seule recherche à la fois, avec une courte pause entre deux recherches.

### Vie privée

- L’extension ouvre la bibliothèque publicitaire **publique** de Facebook seulement quand votre page Pilotix (ou le
  bouton « Tester ») le demande.
- Elle lit uniquement les pubs publiques de cette page et leurs images.
- Elle envoie les pubs **seulement à votre propre page Pilotix** (les adresses que vous avez ajoutées). Rien n’est
  envoyé ailleurs, aucun serveur tiers.
- Elle ne publie, n’aime, ne commente et ne clique jamais rien, et ne lit rien d’autre (ni vos messages, ni votre
  fil, ni vos autres onglets).
- Aucun code distant, aucune dépendance.

### Installation

1. Ouvrez `chrome://extensions` dans Chrome.
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l’extension non empaquetée** et choisissez le dossier `apps/extension` de Pilotix.
4. Épinglez l’extension (icône puzzle) et ouvrez-la.
5. Dans **Adresse de votre Pilotix**, tapez l’adresse de votre Pilotix (ex. `https://app.maboutique.dz`), cliquez sur
   **Ajouter** et acceptez la demande de Chrome. Pour le développement, `http://localhost:5173` est aussi accepté.
6. Rechargez la page Pilotix si elle était ouverte, puis cliquez sur **Chercher** dans AI Spy.

Le bouton **Tester** cherche « poussette » en Algérie et affiche le nombre de pubs trouvées.

Si Facebook demande une connexion ou une vérification, l’extension répond : « Facebook n’a pas montré la bibliothèque
de pubs… ». Ouvrez alors une fois `facebook.com/ads/library` dans Chrome, puis réessayez.

### Pour les développeurs

- Pas d’étape de build : JavaScript simple (ES2022), Manifest V3.
- `background.js` : service worker (file d’attente, onglet Facebook, lecture, images, adresses Pilotix).
- `parse.js` : lecture de la page (`readAdLibrary`) et `fromLibrary` (copie de celle de `packages/core/src/modules/spy.ts`,
  à garder identique).
- `pictures.js` : petites images JPEG (400 px de large au plus, 600 px de haut au plus).
- `sites.js` : adresses Pilotix (origine, motif, identifiant du script).
- `bridge.js` : script de contenu sur la page Pilotix ; protocole décrit dans `apps/web/src/lib/spyExtension.ts`.
- `popup.html`, `popup.js`, `popup.css` : la fenêtre de l’extension.
- Tests : `node apps/extension/test/parse.test.mjs` (compare aussi avec `packages/core` quand il est compilé).

---

## English

### What it does

Pilotix’s **Marketing › AI Spy** page searches competitors’ Facebook ads in Algeria. Facebook’s public Ad Library page
works in a normal browser but refuses servers, and Facebook’s official API returns no Algerian shop ads. This free
extension therefore runs the search in **your own** Chrome:

1. you click **Chercher** in AI Spy;
2. the extension opens Facebook’s Ad Library for that keyword in a background tab;
3. it reads the ads shown (about 30 at most), closes the tab and makes a small picture of each ad;
4. it hands the ads to your Pilotix page, which stores them through its own API.

One search at a time, with a short pause between two searches.

### Privacy

- It only opens Facebook’s **public** Ad Library when your Pilotix page (or the “Tester” button) asks for it.
- It only reads the public ads on that page and their pictures.
- It sends the ads **only to your own Pilotix page** (the addresses you added). Nothing goes anywhere else; no
  third-party server.
- It never posts, likes, comments or clicks anything, and never reads anything else (not your messages, your feed or
  your other tabs).
- No remote code, no dependencies.

### Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `apps/extension` folder of Pilotix.
4. Pin the extension (puzzle icon) and open it.
5. In **Adresse de votre Pilotix**, type your Pilotix address (e.g. `https://app.maboutique.dz`), click **Ajouter** and
   accept Chrome’s prompt. For development, `http://localhost:5173` is accepted too.
6. Reload the Pilotix page if it was open, then click **Chercher** in AI Spy.

The **Tester** button searches “poussette” in Algeria and shows how many ads were found.

If Facebook asks to log in or for a check, the extension answers “Facebook n’a pas montré la bibliothèque de pubs…”.
Open `facebook.com/ads/library` once in Chrome, then try again.

### How the pieces talk

```
Pilotix page (spyExtension.ts)
   │  window.postMessage { source: 'pilotix-spy-page', id, type: 'ping' | 'search', query, country, max }
   ▼
bridge.js (content script, registered only on the Pilotix addresses you added)
   │  chrome.runtime port 'pilotix-search'
   ▼
background.js (service worker, one search at a time, 75 s at most)
   ├─ opens the Ad Library in a background tab, waits for it to load      → progress 'open'
   ├─ executeScript(readAdLibrary) until the ads are there (≤ 20 s)       → progress 'read'
   ├─ closes the tab, maps each item with fromLibrary (RawAd)
   └─ makes the pictures (OffscreenCanvas, JPEG, data URL)                → progress 'pictures'
   ▲
   │  { type: 'result', count, ads } or { type: 'error', message }, relayed to the page with the same id
```

### For developers

- No build step: plain JavaScript (ES2022), Manifest V3.
- Tests: `node apps/extension/test/parse.test.mjs`. Syntax check: `npm run check` in `apps/extension`.
- `fromLibrary` in `parse.js` is a port of the one in `packages/core/src/modules/spy.ts`: change both together (the test
  compares them when `packages/core` is built).
