// Meta's ads MCP server (https://mcp.facebook.com/ads) — SERVER ONLY. Publicité › Demander uses it through
// runMeta('mcpTools' | 'mcpCall'): Pilot AI reads the shop's ads with Meta's own tools, and a change it proposes runs only
// after the owner's yes (./modules/adsask.ts decides; this file only talks to Meta).
//
// The Model Context Protocol over HTTP: JSON-RPC 2.0 posted to one address, the shop's Meta token as a Bearer (it needs
// ads_mcp_management, with ads_read or ads_management). A session starts with « initialize » (Meta may give it an id,
// sent back on each call), then « tools/list » and « tools/call ». An answer comes as JSON or as an event stream (SSE):
// both are read. A session is kept a few minutes for the same token, then opened again.
import { createHash } from 'node:crypto';
import { AppError } from './rpc';

export const MCP_URL = 'https://mcp.facebook.com/ads';
const PROTOCOL = '2025-06-18';
const KEEP_MS = 10 * 60_000;

export interface McpTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: unknown;
  /** what the tool says of itself (MCP annotations): reads only, or changes things */
  readOnly: boolean | null;
  destructive: boolean | null;
}
export interface McpResult {
  text: string;
  isError: boolean;
}

type Fetch = typeof fetch;

/** One MCP session with Meta for one token. */
export class McpSession {
  private n = 0;
  private sid: string | null = null;
  private opened = false;
  constructor(
    private readonly token: string,
    private readonly url = MCP_URL,
    private readonly http: Fetch = fetch,
  ) {}

  private async post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
      'MCP-Protocol-Version': PROTOCOL,
    };
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    try {
      return await this.http(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    } catch {
      throw new AppError('bad_request', 'Meta (Pilot AI) injoignable. Réessayez plus tard.');
    }
  }

  /** one request and its answer (a notification gets none) */
  async request(method: string, params?: unknown): Promise<any> {
    const id = ++this.n;
    const res = await this.post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw httpError(res.status, raw);
    const msg = readMessage(raw, res.headers.get('content-type') ?? '', id);
    if (!msg) throw new AppError('bad_request', 'Meta (Pilot AI) a donné une réponse illisible.');
    if (msg.error) throw rpcError(msg.error);
    return msg.result;
  }
  async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method }).catch(() => null);
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Pilotix', version: '1.0' } });
    await this.notify('notifications/initialized');
    this.opened = true;
  }

  /** every tool Meta offers this token (its pages, followed) */
  async tools(): Promise<McpTool[]> {
    await this.open();
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of Array.isArray(r?.tools) ? r.tools : []) out.push(toolOf(t));
      cursor = r?.nextCursor ? String(r.nextCursor) : undefined;
      if (!cursor) break;
    }
    return out.filter((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpResult> {
    await this.open();
    const r = await this.request('tools/call', { name, arguments: args ?? {} });
    return resultOf(r);
  }
}

/** What a tool says of itself, kept short (its input schema as Meta gives it: the AI fills it). */
export function toolOf(t: any): McpTool {
  const a = t?.annotations ?? {};
  return {
    name: String(t?.name ?? ''),
    title: t?.title ? String(t.title) : a.title ? String(a.title) : null,
    description: String(t?.description ?? '').slice(0, 1500),
    inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    readOnly: typeof a.readOnlyHint === 'boolean' ? a.readOnlyHint : null,
    destructive: typeof a.destructiveHint === 'boolean' ? a.destructiveHint : null,
  };
}

/** A tool's answer as text for the AI (its text blocks, else its structured content), at most 12,000 characters. */
export function resultOf(r: any): McpResult {
  const blocks: any[] = Array.isArray(r?.content) ? r.content : [];
  let text = blocks
    .map((b) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'resource' && b.resource?.text ? String(b.resource.text) : ''))
    .filter(Boolean)
    .join('\n');
  if (!text && r?.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  return { text: text.slice(0, 12_000), isError: !!r?.isError };
}

/** The JSON-RPC answer to request `id`, from a JSON body or an event stream. */
export function readMessage(raw: string, type: string, id: number): any {
  if (!raw.trim()) return null;
  if (type.includes('text/event-stream') || /^(event|data|id):/m.test(raw.trimStart().slice(0, 12))) {
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        const list = Array.isArray(m) ? m : [m];
        const hit = list.find((x) => x && x.id === id && ('result' in x || 'error' in x));
        if (hit) return hit;
      } catch {
        // a block that is not JSON (a ping): skipped
      }
    }
    return null;
  }
  try {
    const m = JSON.parse(raw);
    const list = Array.isArray(m) ? m : [m];
    return list.find((x) => x && (x.id === id || x.id === undefined) && ('result' in x || 'error' in x)) ?? null;
  } catch {
    return null;
  }
}

function httpError(status: number, raw: string): AppError {
  if (status === 401 || status === 403)
    return new AppError('bad_request', 'Meta refuse Pilot AI pour ce compte : reliez Meta à nouveau (Pilot AI › Comptes) et acceptez « Gérer les pubs avec l’IA » (ads_mcp_management).');
  if (status === 429) return new AppError('conflict', 'Meta limite les demandes pour l’instant : réessayez dans quelques minutes.');
  if (status === 404) return new AppError('bad_request', 'Meta (Pilot AI) : session expirée (erreur 404)');
  let why = '';
  try {
    const m = JSON.parse(raw);
    why = String(m?.error?.message ?? m?.message ?? '');
  } catch {
    why = raw.slice(0, 160);
  }
  return new AppError('bad_request', `Meta (Pilot AI) : ${why || `erreur ${status}`}`);
}
function rpcError(e: any): AppError {
  const m = String(e?.message ?? 'erreur');
  if (/permission|scope|unauthori[sz]ed|access token/i.test(m)) return new AppError('bad_request', `Meta refuse : ${m.slice(0, 200)}. Reliez Meta à nouveau (Pilot AI › Comptes).`);
  return new AppError('bad_request', `Meta (Pilot AI) : ${m.slice(0, 300)}`);
}

// ---------------------------------------------------------------- one session per token, a few minutes
const sessions = new Map<string, { s: McpSession; at: number }>();
const keyOf = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 24);

/** Runs `fn` with the token's session; a session Meta forgot (404, expired) is opened again once. */
export async function withMcp<T>(token: string, fn: (s: McpSession) => Promise<T>, http?: Fetch): Promise<T> {
  const k = keyOf(token);
  const now = Date.now();
  for (const [key, v] of sessions) if (now - v.at > KEEP_MS) sessions.delete(key);
  let held = sessions.get(k);
  if (!held || http) {
    held = { s: new McpSession(token, MCP_URL, http ?? fetch), at: now };
    if (!http) sessions.set(k, held);
  }
  held.at = now;
  try {
    return await fn(held.s);
  } catch (e) {
    if (!/erreur 404|session/i.test(String((e as Error)?.message ?? ''))) throw e;
    const fresh = new McpSession(token, MCP_URL, http ?? fetch);
    if (!http) sessions.set(k, { s: fresh, at: now });
    return fn(fresh);
  }
}
