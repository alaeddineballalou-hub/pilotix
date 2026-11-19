// The official logo of another company's product (Facebook, Instagram, WhatsApp, Messenger, Meta, TikTok, Claude,
// ChatGPT) beside its name: the file from that company's own brand page, dropped as it is in assets/brand/ (see the
// README there) — never redrawn, never recoloured, used as that company's rules say. Pilotix ships none of them: the
// shop's owner adds each file once he may use it. Until a file is there, the place shows what it showed before (the
// two letters of the channel, or nothing): no page waits for a logo.
import type { ReactNode } from 'react';
import './brandLogo.css';

export const BRANDS = ['facebook', 'instagram', 'whatsapp', 'messenger', 'meta', 'tiktok', 'claude', 'chatgpt'] as const;
export type Brand = (typeof BRANDS)[number];

const FILES = import.meta.glob('../assets/brand/*-logo.{svg,png,webp,jpg,jpeg}', { eager: true, import: 'default' }) as Record<string, string>;

/** The file `<name>-logo.<svg|png|webp|jpg|jpeg>` of assets/brand/, when it is there (« facebook » is not « facebook-f »). */
export function brandFile(name: string): string | undefined {
  return Object.entries(FILES).find(([path]) => path.includes(`/${name}-logo.`))?.[1];
}

/**
 * A brand's logo on a white tile (the file as it is, whole, never cropped), or `fallback` while its file is missing.
 * Beside the brand's name, which says it: the picture adds no words.
 */
export function BrandLogo({ name, size, title, fallback = null }: { name: Brand; size?: 'sm' | 'big'; title?: string; fallback?: ReactNode }) {
  const src = brandFile(name);
  // `title`: where the brand's name is not written beside the tile (a list of comments), the tile still says it
  return src ? <img src={src} alt={title ?? ''} title={title} className={`px-brand${size ? ` ${size}` : ''}`} /> : <>{fallback}</>;
}
