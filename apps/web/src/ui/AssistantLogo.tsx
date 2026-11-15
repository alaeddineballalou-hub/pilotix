// The official logo of an AI assistant (Claude, ChatGPT) beside its name: the file from its company's own brand page,
// dropped as it is in assets/brand/ (see the README there) — never redrawn or recoloured. Until the file is there,
// nothing shows. The logo is chosen by the site the assistant's answers go to (checked by the server: mcp-server.ts),
// never by the name an assistant gives itself: a tool that calls itself « Claude » gets no logo.
import '../layout/mcp.css';

const FILES = import.meta.glob('../assets/brand/{claude,chatgpt}-logo.{svg,png,webp}', { eager: true, import: 'default' }) as Record<string, string>;
const fileOf = (name: string): string | undefined => Object.entries(FILES).find(([path]) => path.includes(`/${name}-logo.`))?.[1];
const BY_SITE = new Map<string, string | undefined>([
  ['claude.ai', fileOf('claude')],
  ['claude.com', fileOf('claude')],
  ['chatgpt.com', fileOf('chatgpt')],
]);

/** The logo of the assistant whose answers go to this site; nothing for any other site, or while its file is missing. */
export function AssistantLogo({ host, size }: { host: string; size?: 'big' }) {
  const src = BY_SITE.get(host.toLowerCase());
  // beside the assistant's name, which says it: the picture adds no words
  return src ? <img src={src} alt="" className={`pxm-logo${size ? ` ${size}` : ''}`} /> : null;
}
