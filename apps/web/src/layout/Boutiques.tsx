// The person's boutiques: their logo (or their initials), the list (boutiques.list), and the boutique at the bottom of
// the menu — the one open now; a click lists the others to go into, « Toutes les boutiques » later, « Mes boutiques »
// and « Ajouter une boutique ». A seller never adds another seller: one account, many boutiques.
import type { Boutique } from '@pilotix/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { backend } from '../lib/backend';
import { useRpcFor } from '../lib/query';
import { useMedia } from '../lib/useMedia';
import { useSession } from '../lib/session';
import { Icon } from '../ui/kit';
import { toast } from '../ui/toast';
import { AddStoreModal } from './Accounts';
import './boutiques.css';

/** The person's boutiques (kept a minute; any change on screen asks again). */
export function useBoutiques() {
  const { session } = useSession();
  return useRpcFor(null, 'boutiques.list', {}, { staleTime: 60_000, enabled: !!session });
}

/** Two letters for a boutique without a logo: « Maison Fatima » → MF. */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  const s = w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

/** A boutique's logo, or its initials on a soft square. */
export function BoutiqueLogo({ name, logo, size = 32, className = '' }: { name: string; logo: string | null; size?: number; className?: string }) {
  return logo ? (
    <img className={`bq-logo ${className}`} src={logo} alt="" width={size} height={size} style={{ width: size, height: size }} draggable={false} />
  ) : (
    <span className={`bq-logo bq-logo-none ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Shown when the person has other boutiques, or owns this one (to reach « Mes boutiques »). */
export function showSwitch(list: Boutique[] | undefined): boolean {
  if (!list?.length) return false;
  const cur = list.find((b) => b.current);
  return list.length > 1 || (!!cur && cur.owner && cur.kind === 'store');
}

/** The boutique at the bottom of the menu; its list opens upwards. `folded`: the narrow menu shows the logo only. */
export function BoutiqueSwitch({ folded: foldedMenu }: { folded: boolean }) {
  const { t } = useTranslation();
  // the phone's menu is never narrow (it slides over the page)
  const phone = useMedia('(max-width: 900px)');
  const folded = foldedMenu && !phone;
  const { session, switchStore } = useSession();
  const q = useBoutiques();
  const list = q.data;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [add, setAdd] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  // the list floats above the page (the menu itself cuts what goes past its edges)
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const width = Math.max(r.width, 248);
      const rtl = document.documentElement.dir === 'rtl';
      const left = rtl ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
      setPos({ left, bottom: window.innerHeight - r.top + 8, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, folded]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !btn.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [open]);

  if (!session || !showSwitch(list)) return null;
  const cur = list!.find((b) => b.current) ?? list![0];
  const owns = list!.some((b) => b.owner && b.kind === 'store');
  const canAdd = backend.kind === 'demo' ? false : !!session.shop?.canAddStore;
  const go = async (b: Boutique) => {
    if (b.current) return setOpen(false);
    setBusy(b.id);
    try {
      await switchStore(b.id);
      setOpen(false);
      location.hash = '#/accueil';
      toast(t('boutiques.switched', { name: b.name }), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const kindChip = (b: Boutique) => (b.kind === 'agency' ? t('agency.badge') : b.kind === 'marketer' ? t('agency.mk.badge') : null);
  return (
    <div className={`bq-switch${folded ? ' folded' : ''}`}>
      <button
        ref={btn}
        type="button"
        className={`bq-switch-btn${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('boutiques.switchTitle', { name: cur.name })}
        onClick={() => setOpen((v) => !v)}
      >
        <BoutiqueLogo name={cur.name} logo={cur.logo} size={folded ? 34 : 36} />
        {!folded && (
          <>
            <span className="bq-switch-t">
              <b>{cur.name}</b>
              <small>{list!.length > 1 ? t('boutiques.switchHint') : t('boutiques.openNow')}</small>
            </span>
            <svg className="bq-switch-ch" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 15 5 5 5-5" />
              <path d="m7 9 5-5 5 5" />
            </svg>
          </>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menu} className="bq-menu" role="menu" style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}>
            {list!.length > 1 && <span className="bq-menu-cap">{t('boutiques.switch')}</span>}
            {list!.length > 1 &&
              list!.map((b) => (
                <button key={b.id} type="button" role="menuitem" className={`bq-menu-item${b.current ? ' here' : ''}`} disabled={busy !== null} onClick={() => void go(b)} aria-current={b.current ? 'true' : undefined}>
                  <BoutiqueLogo name={b.name} logo={b.logo} size={26} />
                  <span className="bq-menu-name">{b.name}</span>
                  {kindChip(b) && <span className="chip bq-kind">{kindChip(b)}</span>}
                  {b.locked && <span className="chip px-chip-bad">{t('shop.acc.locked')}</span>}
                  {busy === b.id ? <span className="bq-menu-busy">…</span> : b.current ? <Icon name="check" className="bq-menu-here" /> : null}
                </button>
              ))}
            {list!.length > 1 && (owns || canAdd) && <hr />}
            {owns && (
              <a role="menuitem" className="bq-menu-item" href="#/boutiques" onClick={() => setOpen(false)}>
                <span className="bq-menu-ic">
                  <Icon name="store" />
                </span>
                <span className="bq-menu-name">{t('boutiques.title')}</span>
              </a>
            )}
            {canAdd && (
              <button type="button" role="menuitem" className="bq-menu-item" onClick={() => (setOpen(false), setAdd(true))}>
                <span className="bq-menu-ic">
                  <Icon name="plus" />
                </span>
                <span className="bq-menu-name">{t('shop.acc.addStore')}</span>
              </button>
            )}
          </div>,
          document.body,
        )}
      {add && <AddStoreModal onClose={() => setAdd(false)} />}
    </div>
  );
}
