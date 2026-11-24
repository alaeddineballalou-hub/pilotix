#!/usr/bin/env python3
"""The delivery companies' own icons, for their small badge (Suivi, Dépôt, Livré, Annulé, Caisse, Réclamations…).

Only a company's OWN icon, never a piece cut from its logo (the owner's rule, 24 Nov 2026): its app icon, or the icon
of its own website (apple-touch-icon, manifest icon, favicon). Save it as scripts/courier-icons/<logo>.png, with <logo>
the logo name of its card in packages/core/src/couriers/companies.ts, write where it comes from in
scripts/courier-icons/SOURCES.md, then run this script. It makes apps/web/public/couriers/icon/<logo>.webp (96×96; a
see-through icon sits on white, like an app icon) and writes the list of companies that have one in
apps/web/src/ui/courierIcons.ts. A company without its own icon yet shows its letters.

Run after adding or changing an icon:  python3 scripts/courier-logos-icon.py   (needs Pillow)
"""
import glob
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
SRC = os.path.join(HERE, 'courier-icons')
OUT = os.path.join(ROOT, 'apps/web/public/couriers/icon')
LIST = os.path.join(ROOT, 'apps/web/src/ui/courierIcons.ts')
LOGOS = os.path.join(ROOT, 'apps/web/public/couriers')
SIZE = 96


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    done = []
    for path in sorted(glob.glob(os.path.join(SRC, '*.png'))):
        name = os.path.basename(path)[:-4]
        if not os.path.exists(os.path.join(LOGOS, f'{name}.webp')):
            raise SystemExit(f'{name}.png: no company has the logo « {name} » (couriers/{name}.webp)')
        icon = Image.open(path).convert('RGBA')
        tile = Image.new('RGBA', icon.size, (255, 255, 255, 255))
        tile.alpha_composite(icon)
        tile.convert('RGB').resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(OUT, f'{name}.webp'), 'WEBP', quality=92, method=6)
        done.append(name)
    # an icon whose own picture was taken away goes too
    for path in glob.glob(os.path.join(OUT, '*.webp')):
        if os.path.basename(path)[:-5] not in done:
            os.remove(path)
    names = ', '.join(f"'{n}'" for n in done)
    with open(LIST, 'w', encoding='utf-8') as f:
        f.write('// Written by scripts/courier-logos-icon.py: the delivery companies whose OWN icon Pilotix has\n')
        f.write('// (apps/web/public/couriers/icon/<logo>.webp). Do not edit by hand: add the icon, then run the script.\n')
        f.write(f'export const COURIER_ICONS: ReadonlySet<string> = new Set([{names}]);\n')
    print(f'{len(done)} icons: {", ".join(done)}')


if __name__ == '__main__':
    main()
