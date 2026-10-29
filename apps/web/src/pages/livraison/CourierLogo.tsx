// A delivery company's own logo (couriers/<logo>.webp, from its card in « API Livraison »), or its initials when it
// has none. Light theme: the logo on the white card, a white logo on navy. Dark theme: no white plate — the logo's
// « on dark » version (couriers/dark/<logo>.webp: its black or navy writing turned light, its colours kept; made by
// scripts/courier-logos-dark.py), a white logo as it is.
import { courierCardOf } from '@pilotix/shared';
import { useState } from 'react';
import { useIsDark } from '../../lib/useMedia';
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
  const darkTheme = useIsDark();
  // 0: fine · 1: no « on dark » version (the usual logo, on a light plate) · 2: no logo at all (initials)
  const [broken, setBroken] = useState<0 | 1 | 2>(0);
  const label = name || card?.title || '';
  if (!card?.logo || broken === 2)
    return (
      <span className={`px-cologo ${size} none`} aria-hidden="true">
        {initials(label)}
      </span>
    );
  const onDark = darkTheme && !card.dark && broken === 0;
  const plate = darkTheme && !card.dark && broken === 1;
  return (
    <span className={`px-cologo ${size}${card.dark ? ' dark' : ''}${plate ? ' plate' : ''}`} aria-hidden="true">
      <img
        key={onDark ? 'd' : 'l'}
        src={`${import.meta.env.BASE_URL}couriers/${onDark ? 'dark/' : ''}${card.logo}.webp`}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(onDark ? 1 : 2)}
      />
    </span>
  );
}

/** The logo of a shop's company: the card it was made from, else the one its API address belongs to. */
export function CompanyLogo({ cards, company, size = 'sm' }: { cards: readonly LogoCard[] | undefined; company: { kind: string; name: string; settings?: unknown }; size?: 'md' | 'sm' }) {
  return <CourierLogo card={cards ? courierCardOf(cards, company) : null} name={company.name} size={size} />;
}
