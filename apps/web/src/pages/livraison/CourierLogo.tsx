// A delivery company's own logo (couriers/<logo>.webp, from its card in « API Livraison »), or its initials when it
// has none. The logo sits on a white plate (it reads the same in the light and dark themes); a white logo on navy.
import { courierCardOf } from '@pilotix/shared';
import { useState } from 'react';
import './couriers.css';

export interface LogoCard {
  id: string;
  title: string;
  kind: string;
  logo: string | null;
  dark?: boolean;
  host?: string;
  byCard?: boolean;
}

/** « Eco Rapide Express » → « ERE » (the words that only say « delivery » left out). */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(express|livraison|delivery|courrier|colis|services?|logistics?|dz)$/i.test(w));
  const s = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? name).slice(0, 3)).toUpperCase();
  return s.slice(0, 3) || '?';
}

export function CourierLogo({ card, name, size = 'md' }: { card: LogoCard | null | undefined; name?: string; size?: 'md' | 'sm' }) {
  const [broken, setBroken] = useState(false);
  const label = name || card?.title || '';
  if (!card?.logo || broken)
    return (
      <span className={`px-cologo ${size} none`} aria-hidden="true">
        {initials(label)}
      </span>
    );
  return (
    <span className={`px-cologo ${size}${card.dark ? ' dark' : ''}`} aria-hidden="true">
      <img src={`${import.meta.env.BASE_URL}couriers/${card.logo}.webp`} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
    </span>
  );
}

/** The logo of a shop's company: the card it was made from, else the one its API address belongs to. */
export function CompanyLogo({ cards, company, size = 'sm' }: { cards: readonly LogoCard[] | undefined; company: { kind: string; name: string; settings?: unknown }; size?: 'md' | 'sm' }) {
  return <CourierLogo card={cards ? courierCardOf(cards, company) : null} name={company.name} size={size} />;
}
