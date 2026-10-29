# Pilotix app (Android + iPhone): notebook

This file is the notebook for building the phone app. It is updated after every small step, so the
work never starts again from zero when a chat stops (usage limit, closed chat…).

**To continue in a new chat, say: "continue Pilotix app".** Claude then reads this file on the branch
`mobile-app` (or on `main` once the app is pushed) and goes on from the first step that isn't ✅.

## How the app works (the plan, 4 parts)

1. **Live pages.** The app has no copy of the screens: it opens `https://pilotix.online` (the same
   server, database and code as the website). A website change shows in the app the next time it opens,
   on Android and iPhone, with nothing to download.
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
| 3 | Live pages (opens pilotix.online) + "no internet" screen | ✅ done 29 Oct 2026 |
| 4 | GitHub builds the Android test app (`.github/workflows/mobile.yml`) | 🔨 first build running |
| 5 | Owner installs the test app on his phone and checks it | ⏭️ next |
| 6 | One-tap calls (today a `tel:` link opens the phone's dialer with the number) | ⏭️ |
| 7 | Notifications (needs the owner's Firebase project → `google-services.json`) | ⏭️ |
| 8 | Scanner: test the website's camera scanner in the app (camera permission is in) | ⏭️ |
| 9 | Auto-update check (server says the minimum app version) | ⏭️ |
| 10 | iPhone (`npx cap add ios`, Mac build on GitHub, Apple account) | ⏭️ |

## Facts and decisions

- App folder: `mobile/` (its own `package.json`, not part of the website's npm workspaces).
  Capacitor **8.6.0** (Android minSdk 24, target/compile SDK 36). Plugins: `@capacitor/app`,
  `@capacitor/splash-screen`.
- `mobile/capacitor.config.json`: `server.url = https://pilotix.online`, `server.errorPath = offline.html`,
  `appendUserAgent = PilotixApp` (the website/server can tell it runs inside the app),
  navy `#1B2A47` background, start screen 1.5 s, `SystemBars` insets `css` + style `DEFAULT`
  (the website already pads with `env(safe-area-inset-*)` and has `viewport-fit=cover`).
- App ID: **`com.pilotix.app`** (it was already in the old setup). ⚠️ It can never change once the app
  is on Google Play: confirm it with the owner before the first Play upload.
- `mobile/www/offline.html`: the "no internet" screen (FR / AR / EN from the phone's language). It tries
  again by itself, and says "Pilotix revient dans un instant" when the internet works but the server
  doesn't answer (deploy, Cloudflare check…).
- Icons and start screens: `python3 scripts/make-icons.py` (from `mobile/`) makes them from
  `mobile/resources/icon-only.png` and `logo.png`. Run it again if the icon changes.
- Android permissions: `INTERNET`, `CAMERA` (camera optional).
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

- Login stays after closing and opening the app.
- Camera scanner (Dépôt / Suivi): the phone asks for the camera once.
- Downloads (Excel / PDF exports) and printing labels: probably don't work yet inside the app → step to add.
- Links that open a new window (`target=_blank`).
- Back button of the phone.
- Top bar: nothing hidden under the phone's clock/battery.
- If the "no internet" screen shows while the internet works, check Cloudflare (WAF rule / Bot Fight
  Mode) for the app's first page load.

## Log

- 29 Oct 2026: started (owner said "start now" instead of Monday). Steps 1–3 built; first GitHub build.
