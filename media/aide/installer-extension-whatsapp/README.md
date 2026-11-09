# « Installer l'extension WhatsApp » — the help film (menu › Aide)

A 62.5 s film, in French, with sound: the 7 steps of the « Envoyer photos » install guide (Pilotix › Envoyer photos ›
Installer l'extension, download, Extraire tout, chrome://extensions › Mode développeur, Charger l'extension non
empaquetée, link WhatsApp Web, Envoyer sur WhatsApp › Entrée). It plays in **menu › Aide** (`#/aide`) and from the
install guide (« Voir la vidéo »). The website's copy is `apps/web/public/videos/installer-extension-whatsapp.mp4`
(1280×720, about 4 MB) with its first image `installer-extension-whatsapp.jpg`.

Everything on screen is code: `index.html` draws any moment of the film from the time alone (`window.seek(seconds)`).
The Pilotix and Chrome screens are real screenshots of the demo build and of `chrome://extensions` (French, the
add-on loaded); the Windows windows, the phone and WhatsApp Web are simple drawings with no logo.

## Files

| File | What it does |
|---|---|
| `index.html` | the film: scenes, captions (« 1 Dans Pilotix : … »), camera, cursor, all timings |
| `px-shots.cjs` | the Pilotix screenshots (demo build, Samira, 1440×694 at 1680 px wide) into `shots/` |
| `ext-shots.cjs` | the `chrome://extensions` screenshots (French Chromium, the add-on from `apps/wa-extension`) into `shots/` |
| `score.py` | the sound, made in code (soft chords, a chime per step, clicks, keys): `score.wav` |
| `render.cjs` | renders one part of the film to MP4 (JPEG frames piped to ffmpeg) |
| `frames.cjs` | a few still frames, to look at before rendering |

## Make it again (after a change of words, of screens, or for another language)

```sh
# 1 the demo build, served (any port; px-shots.cjs reads DEMO_URL)
npm run build:artifact -w @pilotix/web
python3 -m http.server 8814 --directory apps/web/dist-artifact &
# 2 the screenshots (Playwright: PLAYWRIGHT=<path to the playwright package> if it is not installed here)
cd media/aide/installer-extension-whatsapp
node px-shots.cjs && node ext-shots.cjs
# 3 look at a few moments (JPEGs in $OUT, default /tmp)
node frames.cjs 7.4,13.8,20.3,36.8,53.6
# 4 the sound and the film (9 parts, then joined with the sound)
mkdir -p out && python3 score.py out/score.wav
for p in "0 4.0 s0" "4.0 11.5 s1" "11.5 16.5 s2" "16.5 26.0 s3" "26.0 32.0 s4" "32.0 41.5 s5" "41.5 48.6 s6" "48.6 58.6 s7" "58.6 62.5 s8"; do set -- $p; node render.cjs $1 $2 out/$3.mp4; done
for i in 0 1 2 3 4 5 6 7 8; do echo "file 's$i.mp4'"; done > out/list.txt
ffmpeg -f concat -safe 0 -i out/list.txt -c copy out/film.mp4
ffmpeg -i out/film.mp4 -i out/score.wav -map 0:v -map 1:a -vf scale=1280:720:flags=lanczos -c:v libx264 -preset veryfast -crf 25 -pix_fmt yuv420p -c:a aac -b:a 96k -shortest -movflags +faststart ../../../apps/web/public/videos/installer-extension-whatsapp.mp4
ffmpeg -ss 3.3 -i ../../../apps/web/public/videos/installer-extension-whatsapp.mp4 -frames:v 1 -q:v 3 ../../../apps/web/public/videos/installer-extension-whatsapp.jpg
```

Timings: the steps start at 4.0, 11.5, 16.5, 26.0, 32.0, 41.5 and 48.6 s (`STEPS` in `index.html`); a changed
timing is changed in `score.py` too (the chimes and clicks follow the film). `shots/` and `out/` are not kept in git.
