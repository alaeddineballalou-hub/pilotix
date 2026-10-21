# Pilotix

Pilotix as one codebase for three targets:

| Target | How it is built |
| --- | --- |
| **Website** | `www/` is a static site, deployed to GitHub Pages by the `web` job |
| **Android** | [Capacitor](https://capacitorjs.com) wraps `www/` into a native app; the `android` job builds a debug APK |
| **iOS** | Capacitor iOS project; the `iOS` job builds an unsigned simulator app |

Every push to `main` runs `.github/workflows/build.yml`. Download the APK and iOS build from the run's **Artifacts** section.

## Run locally

```bash
npm install
npx serve www            # website at http://localhost:3000

npx cap add android      # once
npx cap sync android
npx cap open android     # opens Android Studio → Run

npx cap add ios          # once, on a Mac with Xcode
npx cap sync ios
npx cap open ios         # opens Xcode → Run
```

After changing anything in `www/`, run `npx cap sync` before rebuilding the apps.

## Publishing to the stores

- **Google Play**: in Android Studio, *Build → Generate Signed Bundle* (.aab) with your upload key.
- **App Store**: in Xcode, set your Apple Developer team under *Signing & Capabilities*, then *Product → Archive*.

App id: `com.pilotix.app` (change it in `capacitor.config.json` before the first store upload).

## Important: live data

`www/index.html` was exported from a Claude artifact. Its live features (CodPilot orders, products, agents, ads data and saved state) go through `window.claude.use(...)`, which only exists when the page runs inside claude.ai. On GitHub Pages or inside the Android/iOS apps those calls have nothing to answer them, so the screens load but stay empty until the data layer is pointed at a real backend (for example the CodPilot API with your own key, served from a small server — never put the key in the app).

## GitHub Pages

Turn it on once: *Settings → Pages → Source: GitHub Actions*. Pages on a private repository needs a paid GitHub plan; otherwise make the repo public or host `www/` elsewhere (Netlify, Vercel, Cloudflare Pages).
