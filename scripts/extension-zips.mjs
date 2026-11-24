// The Pilotix Chrome extension as the zip the website offers to download (apps/web/public, served at the site's root):
// apps/extension → pilotix.zip (AI Spy, Envoyer photos on WhatsApp Web and the rest, in one extension since 2.0.0); its
// tests and package.json stay out, the shops only need the extension itself. pilotix-whatsapp.zip and pilotix-spy.zip,
// the two extensions it replaced, are the same zip: an old link or an old help page gives the new extension.
// The zip has its files at the top. « Extraire tout » (Windows) and a Mac's unzip make the folder « pilotix » from the
// zip's name, with manifest.json right inside it: the one folder Chrome loads. (A folder inside the zip gave
// pilotix › pilotix on Windows, and Chrome refuses the outer one.)
// Run by the website's build (apps/web: build, build:artifact), so the download is always this folder. No dependency:
// a plain zip (deflate), the same bytes for the same files (fixed dates).
import * as zlib from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** zlib's CRC-32 (Node 22.2+), or the same in plain code */
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 =
  zlib.crc32 ??
  ((buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  });
const walk = (d) => readdirSync(d).sort().flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

// 1 Jan 2026 00:00 (DOS date and time): the same zip for the same files
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** The folder `from` (from the repo's root) as apps/web/public/`names[…]`, without the top-level files or folders in `skip`. */
function zipFolder(from, names, skip = []) {
  const src = join(root, from);
  const files = walk(src)
    .map((p) => ({ name: relative(src, p).split('\\').join('/'), data: readFileSync(p) }))
    .filter((f) => !skip.includes(f.name.split('/')[0]));
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const fname = Buffer.from(f.name, 'utf8');
    const packed = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, fname, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // made by
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(fname.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, fname);
    offset += local.length + fname.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...parts, cd, end]);
  for (const name of names) {
    const out = join(root, 'apps/web/public', name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, zip);
  }
  console.log(`${names.join(', ')}: ${files.length} files`);
}

zipFolder('apps/extension', ['pilotix.zip', 'pilotix-whatsapp.zip', 'pilotix-spy.zip'], ['test', 'package.json']);
