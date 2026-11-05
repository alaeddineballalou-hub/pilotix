// A landing page shown inside Pilotix (the editor's preview, a page's preview in the list, a group's preview).
// The app's pages run only Pilotix's own scripts (Content-Security-Policy): a page written into a frame of the app
// would have its scripts blocked. So the page is sent to a blank page of the server (/api/lp/preview-host), a frame of
// its own, sandboxed: its scripts run there, with no access to the app. In the demo (no server) it is written as before.
import { RefObject, useMemo } from 'react';
import { apiUrl, backend } from '../../lib/backend';

let n = 0;

export function LandingPreview({ html, frame, title }: { html: string; frame: RefObject<HTMLIFrameElement>; title: string }) {
  // a new frame for each new page (as a new srcdoc would load one): nothing of the previous page stays behind
  const key = useMemo(() => ++n, [html]);
  if (backend.kind === 'demo') return <iframe ref={frame} title={title} srcDoc={html} sandbox="allow-scripts allow-forms" />;
  const send = () => frame.current?.contentWindow?.postMessage({ lpHtml: html }, '*');
  return <iframe key={key} ref={frame} title={title} src={`${apiUrl()}/api/lp/preview-host`} sandbox="allow-scripts allow-forms" onLoad={send} />;
}
