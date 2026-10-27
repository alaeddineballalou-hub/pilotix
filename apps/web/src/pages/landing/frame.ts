// A landing page shown inside Pilotix (editor preview, or the page itself in the demo) asks the window around it for
// the communes of a wilaya and, in the demo, sends its order through it, as the real page does to the server.
import { communesOf } from '@pilotix/shared';
import { RefObject, useEffect } from 'react';
import { rpc } from '../../lib/backend';

/** onNav: a group page's product tapped (slug), or a product page's « back » bar (g: the group) */
export function useLandingFrame(
  frame: RefObject<HTMLIFrameElement>,
  onOrder?: (slug: string, body: Record<string, unknown>) => Promise<unknown>,
  onNav?: (slug: string, group: string | null) => void,
) {
  useEffect(() => {
    const on = async (e: MessageEvent) => {
      const m = e.data;
      if (!m || typeof m !== 'object' || !m.lp || e.source !== frame.current?.contentWindow) return;
      if (m.lp === 'nav') {
        if (onNav && /^[a-z0-9-]{2,60}$/.test(String(m.slug))) onNav(String(m.slug), m.g && /^[a-z0-9-]{2,60}$/.test(String(m.g)) ? String(m.g) : null);
        return;
      }
      let r: unknown = null;
      if (m.lp === 'geo') r = communesOf(Number(m.body)).map((c) => [c[1], c[2]]);
      else if (m.lp === 'order' && onOrder) r = await onOrder(String(m.slug), m.body).catch(() => null);
      else if (m.lp === 'lead' && onOrder) r = await demoCapture(String(m.slug), m.body).catch(() => null);
      (e.source as Window).postMessage({ lp: 1, id: m.id, r }, '*');
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [frame, onOrder, onNav]);
}

const visitor = () => ({ ip: '105.235.0.1', ua: navigator.userAgent, country: 'DZ' });
/** the demo's order path: what the server does with a real page's order, with what it would know of the visitor */
export const demoSubmit = (slug: string, body: Record<string, unknown>) => rpc('landing.submit', { ...body, slug, meta: visitor() } as any);
/** the demo's abandoned-order path (what the customer typed so far) */
const demoCapture = (slug: string, body: Record<string, unknown>) => rpc('landing.capture', { ...body, slug, meta: visitor() } as any);
