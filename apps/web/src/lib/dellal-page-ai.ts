// Dellal in the Pilotix preview opened in Claude: Claude answers through the page (the viewer's own Claude account, which
// asks once), and Dellal's tools run in the page through core's runTool, on the preview's own data. The server keeps
// using its API key (ctx.server.dellal); outside Claude this resolves to null and the demo seller answers as before.
// A customer's photo is looked at the same way, when the page may send pictures to Claude: the photo and the catalogue's
// photos go with the question (the demo's drawings drawn as pictures first, since Claude reads no SVG).
import type { DellalPageAi } from '@pilotix/core';

type Turn = { role: 'user' | 'assistant'; content: string };
type SampleError = { code?: string; message?: string };
type Sample = ((input: string | Turn[], options?: Record<string, unknown>) => Promise<{ text: string }>) & {
  limits?: () => Promise<{ tools?: { maxCount: number }; images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
};

const FRAME =
  'Tu joues Dellal, le vendeur IA d’une boutique en ligne algérienne. Voici ses instructions, exactement celles que Pilotix lui donne : suis-les à la lettre. ' +
  'Après les instructions vient la conversation : chaque tour « Message du client » est écrit par le client, et tes réponses précédentes sont tes propres tours. ' +
  'Utilise les outils quand les instructions le demandent, sans rien écrire avant de les appeler. Écris ensuite uniquement le prochain message de Dellal au client, prêt à être envoyé, sans commentaire, sans guillemets et sans signature.';

const ERRORS: Record<string, string> = {
  not_granted: 'Claude n’est pas autorisé dans cette page : rechargez la page et acceptez pour que Dellal réponde.',
  sampling_disabled: 'Claude n’est pas disponible pour ce compte.',
  rate_limited: 'Trop de messages d’un coup, ou limite d’utilisation de votre compte Claude atteinte. Réessayez dans un moment.',
  session_expired: 'Votre session Claude a expiré : reconnectez-vous puis réessayez.',
  refused: 'Claude n’a pas voulu répondre à ce message. Écrivez-le autrement.',
  prompt_too_large: 'La conversation est devenue trop longue : commencez une nouvelle conversation.',
  image_rejected: 'Cette photo n’a pas pu être envoyée à Claude : essayez une autre photo (JPEG ou PNG).',
  images_unavailable: 'Cette page ne peut pas montrer de photos à Claude.',
};
/** After one of these, this view cannot use Claude: the demo seller answers again. */
const PERMANENT = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'tools_unavailable']);
/** Tools whose answer is pictures: a page tool can only give text back, so they stay on the server. */
const PICTURE_TOOLS = new Set(['product_photos']);

let ready: Promise<DellalPageAi | null> | null = null;
let off = false;

/** Claude through the page, or null (outside Claude, not allowed, or no page tools in this view). */
export function pageAi(): Promise<DellalPageAi | null> {
  if (off) return Promise.resolve(null);
  if (!ready) ready = connect();
  return ready.then((ai) => (off ? null : ai));
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n') : '';

/** base64 → the file's bytes */
function fromBase64(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** a drawing (data:image/svg+xml) drawn as a PNG, 512 px on its long side */
async function drawSvg(url: string): Promise<Blob | null> {
  let ratio = 1;
  try {
    const src = url.includes(';base64,') ? atob(url.slice(url.indexOf(',') + 1)) : decodeURIComponent(url.slice(url.indexOf(',') + 1));
    const vb = /viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(src);
    if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) ratio = Number(vb[1]) / Number(vb[2]);
  } catch {
    /* unreadable: square */
  }
  const img = new Image();
  const ok = await new Promise<boolean>((done) => {
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
  if (!ok) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(ratio >= 1 ? 512 : 512 * ratio);
  canvas.height = Math.round(ratio >= 1 ? 512 / ratio : 512);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((done) => canvas.toBlob((b) => done(b), 'image/png'));
}

/** One picture of the question, as a file Claude can look at (null: a link the page cannot open, or a refused type). */
async function pictureOf(block: any, types: string[]): Promise<Blob | null> {
  const s = block?.source;
  try {
    if (s?.type === 'base64' && s.data) {
      const type = String(s.media_type ?? 'image/jpeg');
      return types.includes(type) ? fromBase64(String(s.data), type) : null;
    }
    const url = String(s?.url ?? '');
    if (/^data:image\/svg\+xml[,;]/i.test(url)) return await drawSvg(url);
    const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(url);
    if (m && types.includes(m[1].toLowerCase())) return fromBase64(m[2], m[1].toLowerCase());
  } catch {
    /* not a picture after all */
  }
  return null; // an https link: the page cannot fetch it
}

async function connect(): Promise<DellalPageAi | null> {
  const use = (window as any).claude?.use;
  if (typeof use !== 'function') return null;
  let sample: Sample | null = null;
  try {
    sample = (await use('sample')) as Sample | null;
  } catch {
    return null;
  }
  if (!sample) return null;
  const limits = await sample.limits?.().catch(() => null);
  if (!limits?.tools || limits.tools.maxCount < 4) return null;
  // the tools come in order of need: a page that takes fewer leaves the last ones out
  const maxTools = limits.tools.maxCount;
  // pictures: only when the preview declares them and this view can send them
  const eyes = limits.images && limits.images.maxCount > 0 ? limits.images : null;
  const s = sample;

  const fail = (e: unknown): never => {
    const code = (e as SampleError)?.code ?? 'upstream_error';
    if (PERMANENT.has(code)) off = true;
    throw new Error(ERRORS[code] ?? 'Claude n’a pas pu répondre (erreur passagère). Réessayez.');
  };

  /** A question with pictures (a customer's photo and the catalogue's): each one numbered in the text, in order. */
  const withPictures = async (system: string, content: unknown[]) => {
    const images: Blob[] = [];
    const parts: string[] = [];
    for (const b of content as any[]) {
      if (b?.type === 'text') parts.push(String(b.text ?? ''));
      else if (b?.type === 'image') {
        const pic = eyes && images.length < eyes.maxCount ? await pictureOf(b, eyes.mediaTypes) : null;
        if (pic && pic.size <= eyes!.maxInputBytes) {
          images.push(pic);
          parts.push(`[image ${images.length}]`);
        } else parts.push('[photo non jointe]');
      }
    }
    const note = images.length ? `\n\n(Les images sont jointes à ce message dans l’ordre de leurs numéros : [image 1] est la première.)` : '';
    try {
      const r = await s(`${system}\n\n${parts.join('\n')}${note}`, { cache: false, modelTier: 'quick', ...(images.length ? { images } : {}) });
      return { content: [{ type: 'text' as const, text: r.text }], stop_reason: 'end_turn' };
    } catch (e) {
      return fail(e);
    }
  };

  const ai = async (req: Parameters<DellalPageAi>[0]) => {
    // no tools: the Darija rewrite (one short answer), or a customer's photo to look at
    if (!req.tools.length) {
      const last = req.messages[req.messages.length - 1]?.content;
      if (Array.isArray(last) && last.some((b: any) => b?.type === 'image')) return withPictures(req.system, last);
      try {
        const r = await s(`${req.system}\n\n${req.messages.map((m) => textOf(m.content)).join('\n\n')}`, { cache: false });
        return { content: [{ type: 'text' as const, text: r.text }], stop_reason: 'end_turn' };
      } catch (e) {
        return fail(e);
      }
    }
    const turns: Turn[] = [{ role: 'user', content: `${FRAME}\n\n===== INSTRUCTIONS DE DELLAL =====\n${req.system}\n===== FIN DES INSTRUCTIONS =====` }];
    for (const m of req.messages) {
      const c = textOf(m.content).trim();
      if (c) turns.push(m.role === 'user' ? { role: 'user', content: `Message du client :\n${c}` } : { role: 'assistant', content: c });
    }
    if (turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: '(Réponds au client.)' });
    // like on the server, only the text written after the last tool call is sent
    let latest = '';
    let cut = 0;
    const tools = req.tools
      .filter((t) => !PICTURE_TOOLS.has(t.name))
      .slice(0, maxTools)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
        execute: async (input: Record<string, unknown>) => {
          cut = latest.length;
          // a page tool answers in text only: never a photo's bytes
          const { _images: _pics, ...out } = (await req.runTool(t.name, input ?? {})) ?? {};
          return out;
        },
      }));
    try {
      const r = await s(turns, { tools, onText: ({ text }: { text: string }) => (latest = text) });
      const after = cut ? r.text.slice(cut).trim() : '';
      return { content: [{ type: 'text' as const, text: after || r.text.trim() }], stop_reason: 'end_turn' };
    } catch (e) {
      return fail(e);
    }
  };
  return Object.assign(ai, { sees: !!eyes });
}
