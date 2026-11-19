// A photo sent as a file (an AI assistant's, mcp-server.ts › mcpPhotoAdd) made ready the way the app's page makes its own
// before Produits › Photos keeps it (hdphotos.ts › AddInput): a JPEG of 2048 px at most, turned the right way up, on
// white (a PNG's see-through parts), and its small copies — 320 px (JPEG), 160 px (JPEG), 320 px (WebP). SERVER ONLY:
// it needs sharp, which the browser build never has.
import { HD } from './modules/hdphotos';
import { bad } from './rpc';

/** what a photo file may be: its first bytes say it (never the name, never the type it was sent as) */
export type PhotoKind = 'jpeg' | 'png' | 'webp';
export function photoKind(b: Uint8Array): PhotoKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'webp';
  return null;
}

/** a photo as Produits › Photos keeps it (hdphotos.ts › AddInput, without its product) */
export interface ReadyPhoto {
  /** JPEG, base64 (no data: prefix) */
  data: string;
  w: number;
  h: number;
  /** data URLs */
  thumb: string;
  mini: string;
  small: string;
}

/** the biggest picture a file may hold (a 15 MB PNG can say it is 30 000 × 30 000 px: it is refused before it is drawn) */
const MAX_PIXELS = 60_000_000;

let sharpLib: any;
function sharp(): any {
  if (sharpLib === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sharpLib = require('sharp');
    } catch {
      sharpLib = null;
    }
  }
  return sharpLib;
}

/** The file → the photo and its small copies; a file that is not a JPEG, PNG or WebP picture, or too big, is refused. */
export async function preparePhoto(file: Uint8Array): Promise<ReadyPhoto> {
  if (!photoKind(file)) throw bad('Ce fichier n’est pas une photo JPEG, PNG ou WebP.');
  const s = sharp();
  if (!s) throw bad('Ce serveur ne peut pas lire les photos (sharp manque).');
  const input = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  let meta: any;
  try {
    meta = await s(input, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw bad('Cette photo ne peut pas être lue (fichier abîmé ?).');
  }
  if (!['jpeg', 'png', 'webp'].includes(meta?.format)) throw bad('Ce fichier n’est pas une photo JPEG, PNG ou WebP.');
  if (!(meta.width > 0 && meta.height > 0) || meta.width * meta.height > MAX_PIXELS) throw bad('Photo trop grande.');
  // the right way up (its EXIF), see-through parts on white, at most `side` px on its longest side
  const picture = (side: number) => s(input, { limitInputPixels: MAX_PIXELS }).rotate().flatten({ background: '#ffffff' }).resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true });
  try {
    let full: { data: Buffer; info: { width: number; height: number } } | null = null;
    // 2048 px: lighter and lighter until it fits (HD.maxBytes)
    for (const quality of [86, 78, 70, 60]) {
      full = await picture(2048).jpeg({ quality }).toBuffer({ resolveWithObject: true });
      if (full!.data.length <= HD.maxBytes) break;
    }
    if (!full || full.data.length > HD.maxBytes) throw bad('Photo trop lourde, même réduite.');
    const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;
    const thumb = url('image/jpeg', await picture(320).jpeg({ quality: 78 }).toBuffer());
    const mini = url('image/jpeg', await picture(160).jpeg({ quality: 70 }).toBuffer());
    const small = url('image/webp', await picture(320).webp({ quality: 72 }).toBuffer());
    if (thumb.length > HD.thumbMax || mini.length > HD.miniMax || small.length > HD.smallMax) throw bad('Les petites copies de cette photo sont trop lourdes.');
    return { data: full.data.toString('base64'), w: full.info.width, h: full.info.height, thumb, mini, small };
  } catch (e) {
    if ((e as { code?: string })?.code === 'bad_request') throw e;
    throw bad('Cette photo ne peut pas être lue (fichier abîmé ?).');
  }
}
