# Official brand logos

Each file here is a company's own logo, taken from its own brand page (or sent by that company) and dropped as it is:
never redrawn, never recoloured, used as that company's rules say, and only once the shop's owner may use it. Pilotix
ships none of them. Until a file is here, its place shows what it showed before (the channel's two letters, or the name
alone).

One file per name, as `svg`, `png`, `webp` or `jpg`. The name must be exactly the one below.

| File name        | Whose              | Where it shows                                                                    |
| ---------------- | ------------------ | --------------------------------------------------------------------------------- |
| `facebook-logo`  | Facebook (Meta)    | Comptes (« Facebook et Instagram », a linked account), Pilot Comments — the blue logo: it sits on a white tile |
| `facebook-f-logo`| Facebook (Meta)    | Comptes › the « Continuer avec Facebook » button (never `facebook-logo`: the button shows its words alone) — the white logo: it sits on the button's Facebook blue |
| `meta-logo`      | Meta               | Comptes › « Publicité Meta »                                                      |
| `instagram-logo` | Instagram (Meta)   | Comptes (« Facebook et Instagram »), Pilot Comments (an Instagram post, the channels in Réglages) |
| `whatsapp-logo`  | WhatsApp (Meta)    | Comptes › WhatsApp, Pilot Notify (the messages, « Comment ça marche »)            |
| `tiktok-logo`    | TikTok             | Comptes › TikTok and a linked TikTok account, Pilot Comments                      |
| `claude-logo`    | Claude (Anthropic) | « Autoriser » page, Mon profil › Assistants IA                                    |
| `chatgpt-logo`   | ChatGPT (OpenAI)   | « Autoriser » page, Mon profil › Assistants IA                                    |
| `messenger-logo` | Messenger (Meta)   | no place yet                                                                      |

A square file looks best: it is shown small (32 to 46 px), whole, on a white tile, in the light and the dark theme —
so every logo here but `facebook-f-logo` must be the coloured one: a white logo on the white tile does not show at all.
The code that reads this folder is `ui/BrandLogo.tsx`.

## Where Meta's files come from (20 Nov 2026)

From Meta's Brand Resource Center, after its box « I have read and accept the applicable guidelines »:

- `facebook-logo.png`: `Facebook_Logo_Primary.png` of Facebook-Brand-Asset-Pack.zip
  (meta.com/brand/resources/facebook/logo), as it is: Facebook blue, white « f ».
- `facebook-f-logo.png`: `Facebook_Logo_Secondary.png` of the same pack, as it is: white, see-through « f ».
- `instagram-logo.png`: `Instagram_Glyph_Gradient.png` of IG_brand_asset_pack_2023.zip
  (meta.com/brand/resources/instagram/instagram-brand), made smaller (5000 px → 256 px, 2.6 MB → 44 kB):
  the same picture, nothing redrawn or recoloured.

## Their rules, and how Pilotix keeps them

- Facebook: the blue logo on white, the white logo on Facebook blue; never the « f » alone, never recoloured, never
  « Facebook » written against it; at least 16 px wide on a screen. The smallest tile (32 px) shows it at 18 px.
- « Continuer avec Facebook » (Facebook Login): the white logo before the words, inside the blue button (#1877F2).
- Instagram: only Meta's glyph files; the glyph never smaller than 29 × 29 px; free space of half its size on every
  side, with no text or other logo in it. So `BrandLogo` gives Instagram a 40 px tile with a 29 px glyph (30 px in the
  46 px tile), and the places around it keep their distance. In Comptes, « Facebook et Instagram » links its two logos
  on round 42 px tiles (`.cpt-logo-duo`): Facebook's logo 22 px, Instagram's glyph 29 px, the two logos 14.5 px apart. Where only a small
  corner badge fits (the comment authors in Pilot Comments), the place shows the letters, not a logo.
