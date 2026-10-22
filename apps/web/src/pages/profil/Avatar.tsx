import type { Profile } from '@pilotix/shared';

const initials = (name?: string | null) =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

/** The round picture of a user, or their initials. */
export function Avatar({ p, size }: { p: Pick<Profile, 'name' | 'avatar'> | null | undefined; size?: 'big' | 'xl' | 'xxl' }) {
  const cls = `px-me-av${size ? ` ${size}` : ''}`;
  return p?.avatar ? (
    <img className={cls} src={p.avatar} alt="" />
  ) : (
    <span className={cls} aria-hidden="true">
      {initials(p?.name)}
    </span>
  );
}

