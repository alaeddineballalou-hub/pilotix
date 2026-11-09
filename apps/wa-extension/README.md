# Pilotix WhatsApp (extension Chrome)

## Français

### Ce qu’elle fait

Dans **Confirmation › Envoyer photos**, sur un ordinateur, le bouton **Envoyer sur WhatsApp** :

1. ouvre WhatsApp Web sur la discussion du client (l’onglet déjà ouvert, sinon un nouveau) ;
2. y colle les **vraies photos** des produits (celles de Produits & stock), prêtes à partir ;
3. met le message sous les photos.

L’agent appuie sur **Entrée** : c’est lui qui envoie. Un site seul ne peut pas mettre de photos dans WhatsApp Web
(le navigateur l’interdit) : cette petite extension le fait pour Pilotix.

### Installation (une fois par ordinateur, 2 minutes)

1. Téléchargez `https://pilotix.online/pilotix-whatsapp.zip` (le lien est aussi dans la fenêtre Envoyer photos).
2. Décompressez-le (clic droit › **Extraire tout**) : un dossier `pilotix-whatsapp` apparaît.
3. Dans Chrome (ou Edge), ouvrez `chrome://extensions` et activez le **Mode développeur** (en haut à droite).
4. Cliquez sur **Charger l’extension non empaquetée** et choisissez le dossier `pilotix-whatsapp`.
5. Rechargez Pilotix. WhatsApp Web doit être connecté dans ce même Chrome.

### Vie privée

- L’extension ne lit **aucune** discussion WhatsApp et n’envoie rien ailleurs : aucun serveur à elle.
- Elle ne télécharge que les photos des produits depuis Pilotix (`pilotix.online/api/…/lp/dp/…`).
- Elle ouvre seulement la discussion du numéro demandé par Pilotix, et n’envoie jamais de message elle-même.
- Pas de code distant, pas de dépendance.

### Si WhatsApp Web change

L’extension cherche la zone de message de la discussion et la fenêtre d’aperçu des photos de WhatsApp Web. Si WhatsApp
change son site et que les photos ne se collent plus, Pilotix l’affiche (« WhatsApp Web n’a pas pris les photos ») :
il faut alors mettre l’extension à jour.

## English

On a computer, **Envoyer sur WhatsApp** opens WhatsApp Web on the customer’s chat, pastes the products’ real photos
and puts the message under them; the agent presses Enter. A website alone cannot put files into WhatsApp Web, so this
small extension does it for Pilotix. Install it once: download `pilotix-whatsapp.zip`, unzip it, open
`chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `pilotix-whatsapp` folder, then
reload Pilotix. It reads no WhatsApp chat, talks to no other server, only downloads the product photos from Pilotix and
never sends a message itself.

## Files

- `manifest.json` — Manifest V3; WhatsApp Web and Pilotix only.
- `pilotix.js` — on Pilotix: marks `<html data-pilotix-wa="version">` and passes the page’s request to the worker.
- `background.js` — downloads the photos from Pilotix, opens or reuses the WhatsApp Web tab on the customer’s chat.
- `whatsapp.js` — on WhatsApp Web: waits for the chat, pastes the photos, puts the message as their caption.

`node scripts/wa-extension-zip.mjs` rebuilds `apps/web/public/pilotix-whatsapp.zip` from this folder (the website
serves it). Change `version` in `manifest.json` with every change.
