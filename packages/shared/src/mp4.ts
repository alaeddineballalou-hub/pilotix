// An MP4 / MOV video with its index first (« fast start »), as Instagram asks for Reels (« moov atom at the front of the
// file »), without touching a single frame: phones usually write the index (the moov box) at the end, after the
// pictures and sound (mdat). The moov box is moved before mdat, and every chunk address it holds (stco: 32 bits, co64:
// 64 bits) moves by its size. The file keeps its size, its quality and its bytes; only their order changes.
// It works through `read(start, end)`, so a 300 MB video is never loaded whole (the browser sends it piece by piece).

export interface Mp4Box {
  type: string;
  start: number;
  size: number;
}

/** A piece of the file to send: a range of the original (from, to: end excluded), or bytes made here (the moved moov). */
export type Mp4Piece = { from: number; to: number } | Uint8Array;

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const type4 = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** The boxes at the top of the file (only their headers are read). Null when it is not an MP4 / MOV file. */
export async function topBoxes(size: number, read: (start: number, end: number) => Promise<Uint8Array>): Promise<Mp4Box[] | null> {
  const out: Mp4Box[] = [];
  let pos = 0;
  while (pos + 8 <= size) {
    const h = await read(pos, Math.min(size, pos + 16));
    let len = u32(h, 0);
    const type = type4(h, 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (len === 1) {
      if (h.length < 16) return null;
      const hi = u32(h, 8);
      len = hi * 2 ** 32 + u32(h, 12);
    } else if (len === 0) len = size - pos;
    if (len < 8 || pos + len > size) return null;
    out.push({ type, start: pos, size: len });
    pos += len;
  }
  return out.length && out[0].type === 'ftyp' ? out : null;
}

/** Inside a moov box, the boxes that hold the chunk addresses (and the boxes that lead to them). */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** Moves every chunk address of a moov box by `by` bytes, in place. False when a 32-bit address would not fit. */
export function shiftChunkOffsets(moov: Uint8Array, by: number): boolean {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const walk = (start: number, end: number): boolean => {
    let pos = start;
    while (pos + 8 <= end) {
      let len = view.getUint32(pos);
      const type = type4(moov, pos + 4);
      let head = 8;
      if (len === 1) {
        len = Number(view.getBigUint64(pos + 8));
        head = 16;
      } else if (len === 0) len = end - pos;
      if (len < head || pos + len > end) return true; // a damaged box: leave the rest as it is
      if (CONTAINERS.has(type)) {
        if (!walk(pos + head, pos + len)) return false;
      } else if (type === 'stco' || type === 'co64') {
        const n = view.getUint32(pos + head + 4);
        const first = pos + head + 8;
        for (let k = 0; k < n; k++) {
          if (type === 'stco') {
            const at = first + k * 4;
            if (at + 4 > pos + len) break;
            const v = view.getUint32(at) + by;
            if (v > 0xffffffff) return false;
            view.setUint32(at, v);
          } else {
            const at = first + k * 8;
            if (at + 8 > pos + len) break;
            view.setBigUint64(at, view.getBigUint64(at) + BigInt(by));
          }
        }
      }
      pos += len;
    }
    return true;
  };
  return walk(8, moov.length) || false;
}

/**
 * How to send the file with its index first: the pieces in order (their sizes add up to the file's). Null: send the file
 * as it is (its index is already first, it is made of fragments, or it is not an MP4 / MOV file).
 */
export async function faststartPieces(size: number, read: (start: number, end: number) => Promise<Uint8Array>): Promise<Mp4Piece[] | null> {
  const boxes = await topBoxes(size, read);
  if (!boxes) return null;
  const moovAt = boxes.findIndex((b) => b.type === 'moov');
  const mdatAt = boxes.findIndex((b) => b.type === 'mdat');
  if (moovAt < 0 || mdatAt < 0 || moovAt < mdatAt) return null;
  if (boxes.some((b) => b.type === 'moof')) return null;
  if (boxes.filter((b) => b.type === 'moov').length > 1) return null;
  const mb = boxes[moovAt];
  // a big index (very long video): above 64 MB it is sent as it is
  if (mb.size > 64 * 1024 * 1024) return null;
  const moov = (await read(mb.start, mb.start + mb.size)).slice();
  if (!shiftChunkOffsets(moov, mb.size)) return null;
  const pieces: Mp4Piece[] = [];
  const add = (from: number, to: number) => {
    const last = pieces[pieces.length - 1];
    if (last && !(last instanceof Uint8Array) && last.to === from) last.to = to;
    else pieces.push({ from, to });
  };
  for (const [k, b] of boxes.entries()) {
    if (k === moovAt) continue;
    if (k === mdatAt) pieces.push(moov);
    add(b.start, b.start + b.size);
  }
  return pieces;
}

/** The pieces' total size. */
export const piecesSize = (pieces: Mp4Piece[]) => pieces.reduce((n, p) => n + (p instanceof Uint8Array ? p.length : p.to - p.from), 0);

/**
 * A video's length (seconds) and picture size as seen (a phone's portrait video is stored on its side with a turn: the
 * sizes are swapped back), read from its index (mvhd, tkhd) when the browser cannot play it (a codec it lacks).
 */
export async function mp4Info(size: number, read: (start: number, end: number) => Promise<Uint8Array>): Promise<{ duration: number; w: number; h: number } | null> {
  const boxes = await topBoxes(size, read);
  const mb = boxes?.find((b) => b.type === 'moov');
  if (!mb || mb.size > 64 * 1024 * 1024) return null;
  const moov = await read(mb.start, mb.start + mb.size);
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let duration = 0;
  let w = 0;
  let h = 0;
  const walk = (start: number, end: number) => {
    let pos = start;
    while (pos + 8 <= end) {
      let len = view.getUint32(pos);
      const type = type4(moov, pos + 4);
      let head = 8;
      if (len === 1) {
        len = Number(view.getBigUint64(pos + 8));
        head = 16;
      } else if (len === 0) len = end - pos;
      if (len < head || pos + len > end) return;
      const body = pos + head;
      if (type === 'trak' || type === 'moov') walk(body, pos + len);
      else if (type === 'mvhd') {
        const v1 = moov[body] === 1;
        const scale = view.getUint32(body + (v1 ? 20 : 12));
        const dur = v1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
        if (scale) duration = dur / scale;
      } else if (type === 'tkhd') {
        const v1 = moov[body] === 1;
        // the matrix (9 numbers), then the width and height in 16.16
        const mat = body + (v1 ? 52 : 40);
        const tw = view.getUint32(mat + 36) / 65536;
        const th = view.getUint32(mat + 40) / 65536;
        const b = view.getInt32(mat + 4);
        if (tw * th > w * h) {
          // a quarter turn (b = ±1.0 in 16.16): stored on its side
          const turned = Math.abs(b) === 65536;
          w = Math.round(turned ? th : tw);
          h = Math.round(turned ? tw : th);
        }
      }
      pos += len;
    }
  };
  walk(8, moov.length);
  return duration > 0 && w > 0 && h > 0 ? { duration, w, h } : null;
}
