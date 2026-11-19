// The official logo of an AI assistant (Claude, ChatGPT) beside its name: the file from its company's own brand page,
// dropped as it is in assets/brand/ (see the README there) — never redrawn or recoloured. Until the file is there,
// nothing shows. The logo is chosen by the site the assistant's answers go to (checked by the server: mcp-server.ts),
// never by the name an assistant gives itself: a tool that calls itself « Claude » gets no logo.
import '../layout/mcp.css';
import { brandFile } from './BrandLogo';

const BY_SITE = new Map<string, string | undefined>([
  ['claude.ai', brandFile('claude')],
  ['claude.com', brandFile('claude')],
  ['chatgpt.com', brandFile('chatgpt')],
]);

/** The logo of the assistant whose answers go to this site; nothing for any other site, or while its file is missing. */
export function AssistantLogo({ host, size }: { host: string; size?: 'big' }) {
  const src = BY_SITE.get(host.toLowerCase());
  // beside the assistant's name, which says it: the picture adds no words
  return src ? <img src={src} alt="" className={`pxm-logo${size ? ` ${size}` : ''}`} /> : null;
}
