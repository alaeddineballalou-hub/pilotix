# Pilotix app (Android + iPhone): notebook

This file is the notebook for building the phone app. It is updated after every small step, so the
work never starts again from zero when a chat stops (usage limit, closed chat…).

**To continue in a new chat, say: "continue Pilotix app".** Claude then reads this file on the branch
`mobile-app` (or on `main` once the app is pushed) and goes on from the first step that isn't ✅.

## How the app works (the plan, 4 parts)

1. **Live pages.** The app has no copy of the screens: it opens `https://pilotix.online` (the same
   server, database and code as the website). A website change shows in the app the next time it opens,
   on Android and iPhone, with nothing to download. When Cloudflare's road is cut, it opens the backup
   door `https://direct.pilotix.online` by itself (same app and server, without Cloudflare).
2. **Phone powers inside the app:** calls, notifications, camera scanner, icon. The website "asks" the
   app to use them.
3. **Auto-check for app updates:** only needed when a new phone power is added (rare). The app asks the
   server "am I too old?" and shows "please update" (soft or required).
4. **Menus from the server:** the plans decide the menus for each shop. The app shows the website, so it
   already follows the same rules at the same moment.

## Rules for this work

- Work on the branch **`mobile-app`**. Save to GitHub often (small commits, every finished piece).
- Nothing goes to `main` / pilotix.online until the owner says **"push"**. When it goes to main,
  also refresh the Pilotix artifact (standing rule for every Pilotix push/deploy).
- Commits are authored `alaeddineballalou-hub <alaeddineballalou@gmail.com>`, with **no** Claude
  attribution lines.
- Explain everything to the owner in very simple words, and end with 5 choices.

## Steps

| # | Step | State |
|---|------|-------|
| 1 | Base app (`mobile/`, Capacitor 8, Android project) | ✅ done 29 Oct 2026 |
| 2 | Icon (winking face) and navy start screen | ✅ done 29 Oct 2026 |
| 3 | Live pages (opens pilotix.online) + "no internet" screen | ✅ done 29 Oct 2026, doors 30 Oct |
| 4 | GitHub builds the Android test app (`.github/workflows/mobile.yml`) | ✅ done 29 Oct 2026 (build ok, APK 4.2 MB, signed) |
| 5 | Owner installs the test app on his phone and checks it | 🔨 1st test 30 Oct: pilotix.online unreachable from his Wi‑Fi → app now picks a door; 2nd test waiting |
| 6 | One-tap calls (today a `tel:` link opens the phone's dialer with the number) | ⏭️ |
| 7 | Notifications: the app asks for permission at start ✅ (30 Oct); sending them needs the owner's Firebase project → `google-services.json` | 🔨 |
| 8 | Scanner: test the website's camera scanner in the app (camera permission is in) | ⏭️ |
| 9 | Auto-update check (server says the minimum app version) | ⏭️ |
| 10 | iPhone (`npx cap add ios`, Mac build on GitHub, Apple account) | ⏭️ |

## Facts and decisions

- App folder: `mobile/` (its own `package.json`, not part of the website's npm workspaces).
  Capacitor **8.6.0** (Android minSdk 24, target/compile SDK 36). Plugins: `@capacitor/app`,
  `@capacitor/splash-screen`.
- `mobile/capacitor.config.json`: no `server.url`. The app starts on its own page `www/index.html`, and
  `www/door.js` asks both doors at once (5 s max): `https://pilotix.online` wins when it answers, else
  `https://direct.pilotix.online` (the backup door). `server.allowNavigation` = both hosts, so they stay
  inside the app and get Capacitor's bridge (Android lists allowNavigation hosts in its local server, so
  their pages are fetched with the WebView's cookies and get the bridge). `server.errorPath = offline.html`
  (same `door.js`: tries the other door first; « server » message + 15 s wait when pages fail twice in a
  minute). `appendUserAgent = PilotixApp` (the website/server can tell it runs inside the app),
  navy `#1B2A47` background, start screen 1.5 s, `SystemBars` insets `css` + style `DEFAULT`
  (the website already pads with `env(safe-area-inset-*)` and has `viewport-fit=cover`).
- App ID: **`com.pilotix.app`** (it was already in the old setup). ⚠️ It can never change once the app
  is on Google Play: confirm it with the owner before the first Play upload.
- Screens of `door.js` (FR / AR / EN from the phone's language): « Connexion à Pilotix… » (spinner),
  « Pas de connexion internet » (the phone's internet is down: checked with Google's
  `connectivitycheck.gstatic.com/generate_204`), « Pilotix ne répond pas sur cette connexion » (internet
  works but no door answers: try 4G), « Pilotix revient dans un instant » (the server itself fails).
  It keeps trying by itself. The bottom line shows the build: « Pilotix app · test N (sha) » (`www/build.js`,
  written by mobile.yml).
- Icons and start screens: `python3 scripts/make-icons.py` (from `mobile/`) makes them from
  `mobile/resources/icon-only.png` and `logo.png`. Run it again if the icon changes.
- Android permissions: `INTERNET`, `CAMERA` (camera optional), `POST_NOTIFICATIONS` (asked when the app
  opens, Android 13+: `MainActivity.java`; Android stops asking after two « Don't allow »).
- The backup door needs the DNS record `direct` (A, DNS only / grey cloud) in Cloudflare: the owner's
  step from the Pilot AI chat (30 Oct). Without it, the app just uses the main door.
- How the live pages work on Android: Capacitor fetches the page's HTML itself (with the WebView's
  cookies) and adds its bridge, so plugins work on pilotix.online. Other links (WhatsApp, other sites)
  open outside the app. `tel:` links open the dialer.
- The old setup (`apps/web/capacitor.config.json`, which packed a copy of the website inside the app,
  and the `android` / `ios` jobs in `build.yml`) is replaced by `mobile/`. The two jobs are removed from
  `build.yml` on this branch. `apps/web/capacitor.config.json` and the `@capacitor/*` packages in
  `apps/web` can be removed later; `@capacitor/core` stays there for the website's "doors".
- Test app download (made by GitHub after each build of `mobile/`):
  `https://github.com/alaeddineballalou-hub/pilotix/releases/download/app-test/pilotix-test.apk`
- Test builds are signed with a new random test key each time **until** the secret
  `ANDROID_TEST_KEYSTORE_BASE64` is added in GitHub (Settings → Secrets and variables → Actions).
  Without it, uninstall the old test app before installing a new one.

## To test on the phone (things a website-in-an-app can get wrong)

- **Google sign-in can't work inside the app** (Google blocks sign-in in apps' web views, and
  accounts.google.com opens outside the app): sign in with e-mail and password. Later: hide the Google
  button when the user agent has `PilotixApp`, or add a native Google sign-in.

- Login stays after closing and opening the app.
- Camera scanner (Dépôt / Suivi): the phone asks for the camera once.
- Downloads (Excel / PDF exports) and printing labels: probably don't work yet inside the app → step to add.
- Links that open a new window (`target=_blank`).
- Back button of the phone.
- Top bar: nothing hidden under the phone's clock/battery.
- If the "no internet" screen shows while the internet works, check Cloudflare (WAF rule / Bot Fight
  Mode) for the app's first page load.
- Notifications: the website's own web push (`apps/web/public/sw.js`, `src/lib/push.ts`) can't work
  inside an Android app (the WebView has no web push) → step 7 replaces it with Firebase in the app.
  `sw.js` has no fetch/cache handler, so it doesn't get in the way of the live pages.

## Good to know

- Installing the test APK by hand ("sideloading") still works in Algeria. Google's developer
  verification started 30 Sep 2026 only in Brazil, Indonesia, Singapore and Thailand, and goes
  worldwide in 2027: by then the app must be registered to the owner's verified developer account
  (his Play Console account covers it).

## Log

- 30 Oct 2026: owner's 1st test (video): the app opened, but pilotix.online didn't answer from his Wi‑Fi
  (his computer had the same timeout; his speed test was 140 Mbps) and the app wrongly said « No internet ».
  Fixed: start page + doors + true messages + build number. Owner asked: « the app should ask for
  permission for notification » → done at app start.
- 29 Oct 2026: started (owner said "start now" instead of Monday). Steps 1–4 done: the app, icon,
  start screen, no-internet screen, GitHub build + download link. Couldn't run it on a phone from the
  cloud (no Android emulator there): the owner's phone test is next.
