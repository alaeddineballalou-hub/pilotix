// Turns the single-file build into an artifact page: the host adds <!doctype>, <html>, <head> and <body>,
// so keep only what goes inside them (title, metas, links, styles, scripts and the app root).
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let html = readFileSync(file, 'utf8');
const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, ''])[1];
const title = (head.match(/<title>[\s\S]*?<\/title>/i) || ['<title>Pilotix</title>'])[0];
const rest = head
  .replace(/<title>[\s\S]*?<\/title>/i, '')
  .replace(/<meta\s+charset[^>]*>/i, '')
  .replace(/<meta\s+name="viewport"[^>]*>/i, '');
html = `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${rest.trim()}\n${body.trim()}\n`;
writeFileSync(file, html);
console.log(`Artifact page ready: ${file} (${Math.round(html.length / 1024)} KB)`);
