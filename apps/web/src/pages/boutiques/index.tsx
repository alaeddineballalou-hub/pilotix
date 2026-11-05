// « Mes boutiques » (design 5, « Aperçu en direct »): the seller's boutiques as tabs; for the one chosen, its logo, its
// name and its link on the left, and on the right what they look like where people see them (the top bar, the parcel
// label, the landing page, the livreur's route sheet) — changing as they are typed. Only the boutique's owner changes
// its name and logo (boutiques.save). Its link (pilotix.online/<link>/…) was chosen when the boutique was made and never
// changes: it is shown, locked.
import type { Boutique } from '@pilotix/shared';
import { DragEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, serverUrl } from '../../lib/backend';
import { usePagesBase } from '../../lib/pages';
import { useAction } from '../../lib/query';
import { go } from '../../lib/route';
import { useSession } from '../../lib/session';
import { AddStoreModal } from '../../layout/Accounts';
import { BoutiqueLogo, useBoutiques } from '../../layout/Boutiques';
import { CopyCard } from './CopyCard';
import type { PageProps } from '../registry';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import './boutiques.css';

/** The site's address as people read it: pilotix.online (the preview: its own made-up address) */
const siteHost = () => (backend.kind === 'demo' ? 'demo.pilotix.local' : serverUrl() || window.location.origin).replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** A picture chosen by the seller, made a small square logo (256 px at most, WebP or PNG), as the server keeps it. */
async function toLogo(file: File, t: (k: string) => string): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error(t('boutiques.logoType'));
  if (file.size > 5 * 1024 * 1024) throw new Error(t('boutiques.logoBig'));
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 256;
    const h = img.naturalHeight || 256;
    for (const size of [256, 192, 128]) {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      if (!g) break;
      const k = Math.min(size / w, size / h);
      g.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
      let out = c.toDataURL('image/webp', 0.9);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');
      if (out.length <= 150_000) return out;
    }
    throw new Error(t('boutiques.logoBig'));
  } catch (e: any) {
    throw new Error(e?.message && e.message !== 'EncodingError' ? e.message : t('boutiques.logoType'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Boutiques({ sub }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const q = useBoutiques();
  const [add, setAdd] = useState(false);
  if (q.isLoading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const mine = (q.data ?? []).filter((b) => b.owner && b.kind === 'store');
  if (!mine.length)
    return (
      <div className="card">
        <Empty>{t('boutiques.notOwner')}</Empty>
      </div>
    );
  const chosen = mine.find((b) => String(b.id) === sub) ?? mine.find((b) => b.current) ?? mine[0];
  const canAdd = backend.kind !== 'demo' && !!session?.shop?.canAddStore;
  // « 2 boutiques sur 3 »: how many the seller has, and the most he may have (the control room sets it)
  const own = session?.shop?.ownStores;
  const max = session?.shop?.maxStores;
  const full = own !== undefined && !!max && own >= max;
  return (
    <div className="bqp">
      <div className="bqp-head">
        <nav className="bqp-tabs" aria-label={t('boutiques.title')}>
          {mine.map((b) => (
            <a key={b.id} href={`#/boutiques/${b.id}`} className={`bqp-tab${b.id === chosen.id ? ' on' : ''}`} aria-current={b.id === chosen.id ? 'page' : undefined}>
              <BoutiqueLogo name={b.name} logo={b.logo} size={30} />
              <span>{b.name}</span>
              {b.current && <span className="bqp-here" title={t('boutiques.openNow')} />}
            </a>
          ))}
          {canAdd && (
            <button type="button" className="bqp-tab bqp-tab-add" onClick={() => setAdd(true)}>
              <Icon name="plus" />
              <span>{t('shop.acc.addStore')}</span>
            </button>
          )}
        </nav>
        {own !== undefined && !!max && (
          <span className={`bqp-count${full ? ' full' : ''}`}>
            <b>
            {t('boutiques.count', { n: own, max })}
            {session?.shop?.plan ? ` · ${t('boutiques.countPlan', { plan: session.shop.plan })}` : ''}
          </b>
            {full && <small>{t('boutiques.countFull')}</small>}
          </span>
        )}
      </div>
      <Editor key={chosen.id} b={chosen} />
      {mine.length > 1 && <CopyCard key={`copy-${chosen.id}`} to={chosen} others={mine.filter((b) => b.id !== chosen.id)} />}
      {add && <AddStoreModal onClose={() => setAdd(false)} />}
    </div>
  );
}

function Editor({ b }: { b: Boutique }) {
  const { t } = useTranslation();
  const { session, refresh, switchStore } = useSession();
  const [name, setName] = useState(b.name);
  const [logo, setLogo] = useState<string | null>(b.logo);
  const [drag, setDrag] = useState(false);
  const [opening, setOpening] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const host = siteHost();
  // the landing pages' own address (go.<domain>) once it answers: the preview shows a page's link there
  const pagesBase = usePagesBase();
  const pagesHost = backend.kind === 'demo' ? host : pagesBase.replace(/^https?:\/\//, '').replace(/\/+$/, '') || host;
  const changed = name.trim() !== b.name || logo !== b.logo;
  const save = useAction('boutiques.save', {
    success: t('boutiques.saved'),
    onDone: () => {
      // the boutique open now: its name and logo at the top change at once
      if (b.current) void refresh().catch(() => {});
    },
  });

  const pick = async (f: File | undefined | null) => {
    if (!f) return;
    try {
      setLogo(await toLogo(f, t));
    } catch (e: any) {
      toast(e?.message ?? t('boutiques.logoType'), 'bad');
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void pick(e.dataTransfer.files?.[0]);
  };
  const blocked = name.trim().length < 2;
  // its link is not sent: it never changes
  const submit = () => save.mutate({ id: b.id, name: name.trim(), ...(logo !== b.logo ? { logo } : {}) });
  const open = async () => {
    setOpening(true);
    try {
      await switchStore(b.id);
      go('#/accueil');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setOpening(false);
    }
  };
  const role = useMemo(() => (session ? session.roles.map((r) => t(`roles.${r}`))[0] : ''), [session, t]);
  const shown = name.trim() || b.name;

  return (
    <div className="bqp-grid">
      <section className="card bqp-form" aria-labelledby="bqp-form-h">
        <h2 id="bqp-form-h">{t('boutiques.settingsTitle')}</h2>
        <p className="bqp-sub">{t('boutiques.settingsSub')}</p>

        <div className="bqp-field">
          <span className="lab" id="bqp-logo-l">
            {t('boutiques.logo')}
          </span>
          <div
            className={`bqp-drop${drag ? ' drag' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setDrag(true))}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            aria-labelledby="bqp-logo-l"
          >
            <BoutiqueLogo name={shown} logo={logo} size={84} className="bqp-drop-logo" />
            <div className="bqp-drop-t">
              <b>{t('boutiques.dropHere')}</b>
              <div className="bqp-drop-btns">
                <button type="button" className="btn small" onClick={() => file.current?.click()}>
                  <Icon name="upload" /> {logo ? t('boutiques.changeLogo') : t('boutiques.chooseFile')}
                </button>
                {logo && (
                  <button type="button" className="btn small ghost bqp-remove" onClick={() => setLogo(null)}>
                    <Icon name="trash" /> {t('boutiques.removeLogo')}
                  </button>
                )}
              </div>
              <span className="bqp-hint">{t('boutiques.logoHint')}</span>
            </div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} />
          </div>
        </div>

        <label className="bqp-field">
          <span className="lab">{t('boutiques.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
          <span className="bqp-hint">{t('boutiques.nameHint')}</span>
        </label>

        <div className="bqp-field">
          <label className="lab" htmlFor="bqp-slug">
            {t('boutiques.link')}
          </label>
          <span className="bqp-slug bqp-slug-locked">
            <span className="bqp-slug-pre ltr">{host}/</span>
            <input id="bqp-slug" className="ltr" value={b.slug} readOnly aria-describedby="bqp-slug-state" />
            <Icon name="lock" />
          </span>
          <span id="bqp-slug-state" className="bqp-state idle">
            {t('boutiques.linkLocked')}
          </span>
          {b.oldSlugs.length > 0 && (
            <div className="bqp-olds">
              <span className="lab">{t('boutiques.oldLinks')}</span>
              {b.oldSlugs.map((s) => (
                <span key={s} className="bqp-old ltr">
                  <span>
                    {host}/<b>{s}</b>
                  </span>
                  <small>{t('boutiques.leadsHere')}</small>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="bqp-actions">
          {!b.current ? (
            <button type="button" className="btn" onClick={() => void open()} disabled={opening}>
              <Icon name="external" /> {opening ? '…' : t('boutiques.open')}
            </button>
          ) : (
            <span className="bqp-in">{t('boutiques.youAreIn')}</span>
          )}
          <button type="button" className="btn primary" disabled={!changed || blocked || save.isPending} onClick={submit}>
            {save.isPending ? '…' : t('boutiques.save')}
          </button>
        </div>
      </section>

      <section className="card bqp-live" aria-labelledby="bqp-live-h">
        <div className="bqp-live-h">
          <h2 id="bqp-live-h">{t('boutiques.liveTitle')}</h2>
          <span className="chip bqp-live-chip">
            <Icon name="eye" /> {t('boutiques.liveSub')}
          </span>
        </div>
        <Preview name={shown} logo={logo} slug={b.slug} host={pagesHost} person={session?.profile.name ?? ''} role={role} />
        <p className="bqp-sample">{t('boutiques.sample')}</p>
      </section>
    </div>
  );
}

/** Where the boutique's name and logo show (the orders are examples). */
function Preview({ name, logo, slug, host, person, role }: { name: string; logo: string | null; slug: string; host: string; person: string; role: string }) {
  const { t } = useTranslation();
  return (
    <div className="bqp-stage">
      <div className="bqp-pv">
        <span className="bqp-pv-cap">{t('boutiques.pvTop')}</span>
        <div className="bqp-pv-bar" aria-hidden="true">
          <span className="bqp-pv-search" />
          <span className="bqp-pv-me">
            <BoutiqueLogo name={name} logo={logo} size={26} />
            <span>
              <b>{name}</b>
              <small>
                {person} · {role}
              </small>
            </span>
          </span>
        </div>
      </div>
      <div className="bqp-two">
        <div className="bqp-pv">
          <span className="bqp-pv-cap">
            {t('boutiques.pvLabel')}
          </span>
          <div className="bqp-lbl" aria-hidden="true">
            <div className="bqp-lbl-top">
              <b>ZR Express</b>
              <span className="ltr">ZR-16-58214</span>
            </div>
            <div className="bqp-lbl-mid">
              <span className="bqp-lbl-w">16</span>
              <span>
                <b>Amina B.</b>
                <small className="ltr">Bab Ezzouar · 0661 24 87 15</small>
              </span>
            </div>
            <div>
              {t('boutiques.toCollect')} <b className="ltr">12 900 DA</b>
            </div>
            <div className="bqp-lbl-bar" />
            <div className="bqp-lbl-shop">
              <BoutiqueLogo name={name} logo={logo} size={22} />
              <span>
                <b>{name}</b>
                <small className="ltr">SAV 0550 12 34 56</small>
              </span>
            </div>
          </div>
        </div>
        <div className="bqp-col">
          <div className="bqp-pv">
            <span className="bqp-pv-cap">
              {t('boutiques.pvLanding')}
            </span>
            <div className="bqp-land" aria-hidden="true">
              <div className="bqp-land-url ltr">
                {host}/{slug}/poussette
              </div>
              <div className="bqp-land-head">
                <BoutiqueLogo name={name} logo={logo} size={26} />
                <b>{name}</b>
              </div>
              <div className="bqp-land-body">
                <b>Poussette 3 en 1</b>
                <span className="ltr">12 900 DA</span>
                <span className="bqp-land-btn">{t('boutiques.order')}</span>
              </div>
            </div>
          </div>
          <div className="bqp-pv">
            <span className="bqp-pv-cap">
              {t('boutiques.pvRoute')}
            </span>
            <div className="bqp-rt" aria-hidden="true">
              <div className="bqp-rt-head">
                <BoutiqueLogo name={name} logo={logo} size={24} />
                <span>
                  <b>{name}</b>
                  <small>{t('boutiques.routeOf', { who: 'Lamine' })}</small>
                </span>
              </div>
              {[
                ['PX-48211', 'Bab Ezzouar', '12 900'],
                ['PX-48217', 'Kouba', '4 500'],
                ['PX-48230', 'Hydra', '7 800'],
              ].map(([r, c, a]) => (
                <div key={r} className="bqp-rt-row">
                  <span className="ltr">{r}</span>
                  <span>{c}</span>
                  <b className="ltr">{a}</b>
                </div>
              ))}
              <div className="bqp-rt-tot">
                <span>{t('boutiques.parcels', { count: 3 })}</span>
                <b className="ltr">25 200 DA</b>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
