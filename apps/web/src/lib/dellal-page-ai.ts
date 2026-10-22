// Dellal in the Pilotix preview opened in Claude: Claude answers through the page (the viewer's own Claude account, which
// asks once), and Dellal's tools run in the page through core's runTool, on the preview's own data. The server keeps
// using its API key (ctx.server.dellal); outside Claude this resolves to null and the demo seller answers as before.
import type { DellalPageAi } from '@pilotix/core';

type Turn = { role: 'user' | 'assistant'; content: string };
type SampleError = { code?: string; message?: string };
type Sample = ((input: string | Turn[], options?: Record<string, unknown>) => Promise<{ text: string }>) & {
  limits?: () => Promise<{ tools?: { maxCount: number } }>;
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
};
/** After one of these, this view cannot use Claude: the demo seller answers again. */
const PERMANENT = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'tools_unavailable']);

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
  const s = sample;

  const fail = (e: unknown): never => {
    const code = (e as SampleError)?.code ?? 'upstream_error';
    if (PERMANENT.has(code)) off = true;
    throw new Error(ERRORS[code] ?? 'Claude n’a pas pu répondre (erreur passagère). Réessayez.');
  };

  return async (req) => {
    // the Darija rewrite: no tools, one short answer
    if (!req.tools.length) {
      try {
        const r = await s(`${req.system}\n\n${req.messages.map((m) => textOf(m.content)).join('\n\n')}`, { cache: false });
        return { content: [{ type: 'text', text: r.text }], stop_reason: 'end_turn' };
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
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      execute: async (input: Record<string, unknown>) => {
        cut = latest.length;
        return req.runTool(t.name, input ?? {});
      },
    }));
    try {
      const r = await s(turns, { tools, onText: ({ text }: { text: string }) => (latest = text) });
      const after = cut ? r.text.slice(cut).trim() : '';
      return { content: [{ type: 'text', text: after || r.text.trim() }], stop_reason: 'end_turn' };
    } catch (e) {
      return fail(e);
    }
  };
}
