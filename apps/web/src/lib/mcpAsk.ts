// An AI assistant (Claude, ChatGPT) asking to be linked to the person's Pilotix: the server sends their browser to the
// app with « ?mcp=<ticket> » in the address (apps/server mcp.ts). The app shows its « Autoriser » page
// (layout/McpAuthorize) once the person is logged in; the ticket leaves the address when the question is over.
import { useEffect, useState } from 'react';
import { DEMO_ONLY } from './backend';
import { ROUTE_EVENT } from './route';

const read = (): string | null => {
  try {
    const v = new URLSearchParams(window.location.search).get('mcp');
    return v && /^pxq_[A-Za-z0-9_.-]{20,4000}$/.test(v) ? v : null;
  } catch {
    return null;
  }
};

/** The question an assistant asked, as the address carries it (null: none). */
export function useMcpTicket(): string | null {
  const [ticket, setTicket] = useState(read);
  useEffect(() => {
    const on = () => setTicket(read());
    window.addEventListener(ROUTE_EVENT, on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener(ROUTE_EVENT, on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return ticket;
}

/** An assistant sent the person here and waits for their answer (never in the demo-only build: it has no server). */
export function useMcpAsked(): boolean {
  return !!useMcpTicket() && !DEMO_ONLY;
}

/**
 * The question is over (answered, expired, or left): it leaves the address, in the same history entry. `quiet`: the
 * browser is leaving for the assistant's site — the page stays as it is until then.
 */
export function dropMcpTicket(quiet = false) {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('mcp');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch {
    /* the address stays */
  }
  if (!quiet) window.dispatchEvent(new Event(ROUTE_EVENT));
}
