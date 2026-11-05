// The shops' videos on the server's disk (CM AI agent › Planner): kept in MEDIA_DIR/<shop schema>/<id>-<key>.<mp4|mov>
// until their post goes out (and a week more), never re-encoded. A video comes in pieces of the same size (the last one
// smaller): a piece sent again (a weak line) replaces itself, a piece too far ahead is refused (the browser starts again
// from what the server has). Meta and the editor read it through a public address, with byte ranges.
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import * as core from '@pilotix/core';
import { config } from './config';

const SAFE = /^[a-z0-9_]+$/i;

function fileOf(schema: string, id: number, key: string, ext: string): string {
  if (!SAFE.test(schema) || !/^[a-f0-9]{24}$/.test(key) || !/^(mp4|mov)$/.test(ext) || !Number.isInteger(id)) throw new core.AppError('bad_request', 'Vidéo inconnue');
  return path.join(config.mediaDir, schema, `${id}-${key}.${ext}`);
}

/** One piece of a video being sent: written at its place in the file (part × chunk). */
export async function writePart(schema: string, v: { id: number; key: string; ext: string; size: number; chunk: number }, part: number, body: Buffer): Promise<{ received: number }> {
  const file = `${fileOf(schema, v.id, v.key, v.ext)}.part`;
  const at = part * v.chunk;
  const end = at + body.length;
  if (!Number.isInteger(part) || part < 0 || at >= v.size) throw new core.AppError('bad_request', 'Morceau de vidéo inconnu');
  if (end > v.size || (body.length !== v.chunk && end !== v.size)) throw new core.AppError('bad_request', 'Morceau de vidéo de la mauvaise taille');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const have = (await fs.stat(file).catch(() => null))?.size ?? 0;
  // a piece the server already has (sent again after a lost answer): nothing to do
  if (have >= end) return { received: have };
  if (at > have) throw new core.AppError('conflict', `Il manque un morceau : la vidéo reprend à ${have} octets.`);
  const fh = await fs.open(file, have ? 'r+' : 'w');
  try {
    await fh.truncate(at);
    await fh.write(body, 0, body.length, at);
  } finally {
    await fh.close();
  }
  return { received: end };
}

/** The server's file hooks for one shop (core: ctx.server.media). */
export function mediaHooks(schema: string): NonNullable<core.ServerHooks['media']> {
  return async (action, a) => {
    const file = fileOf(schema, a.id, a.key, a.ext);
    if (action === 'finish') {
      const st = await fs.stat(`${file}.part`).catch(() => null);
      if (!st) {
        // already finished (the answer was lost): the whole file is there
        if ((await fs.stat(file).catch(() => null))?.size === a.size) return { ok: true };
        throw new core.AppError('bad_request', 'La vidéo n’est pas arrivée : envoyez-la encore.');
      }
      if (st.size !== a.size) throw new core.AppError('bad_request', `La vidéo n’est pas arrivée entière (${st.size} octets sur ${a.size}) : envoyez-la encore.`);
      await fs.rename(`${file}.part`, file);
      return { ok: true };
    }
    if (action === 'remove') {
      await fs.rm(file, { force: true });
      await fs.rm(`${file}.part`, { force: true });
      return { ok: true };
    }
    throw new core.AppError('bad_request', `Action inconnue : ${action}`);
  };
}

/** A whole video, or the byte range asked (Meta's downloads, the editor's player). */
export async function sendVideo(schema: string, v: { id: number; key: string; ext: string; mime: string }, range: string | undefined, res: any): Promise<unknown> {
  const file = fileOf(schema, v.id, v.key, v.ext);
  const st = await fs.stat(file).catch(() => null);
  if (!st) return res.status(404).send();
  const size = st.size;
  const head = (r: any) => r.header('Content-Type', v.mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=31536000, immutable');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range ?? '').trim());
  if (!m || (!m[1] && !m[2])) return head(res.status(200)).header('Content-Length', String(size)).send(createReadStream(file));
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  if (start >= size || start > end) return res.status(416).header('Content-Range', `bytes */${size}`).send();
  end = Math.min(end, size - 1);
  start = Math.max(0, start);
  return head(res.status(206))
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Content-Length', String(end - start + 1))
    .send(createReadStream(file, { start, end }));
}
