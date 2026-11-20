// Pilot AI › Comptes: THE one place where a boutique connects Meta and TikTok. One line per thing to connect (the
// owner's design « Lignes », 20 Nov 2026): Facebook and Instagram, Meta's ads, WhatsApp, TikTok. A line shows, on its
// right, what is connected — the Page's and its Instagram account's pictures, the business portfolio of the ad accounts
// (name and picture), the WhatsApp number — or the platform's own button to connect it: Meta's « Continuer avec
// Facebook » (white « f » on Facebook blue, its words inside the button: Meta's rules; WhatsApp's Embedded Signup is a
// Facebook login too) and TikTok's « Continuer avec TikTok » (white on black). The login opens in a new tab; the person
// ticks everything and accepts there, Pilotix does the rest on its server, and the line turns green (it asks every two
// seconds). An account serves this boutique, or all the owner's boutiques (each picks its Page and its ad account in one
// click). A connected account opens below its line: its Page, its ad accounts, « Tester » part by part, link again,
// remove. The tokens never come to a page (packages/core/src/modules/social.ts). When Pilotix's Meta app has a second
// configuration for the ads (the control room), Meta is connected in two steps: « Facebook et Instagram » (Pages,
// messages, comments, posts), then « Publicité Meta » (ad accounts, catalogue, pixels, lead forms), which also takes a
// Meta Ads key pasted by hand.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc } from '../../lib/backend';
import { clock, dateOnly, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { BrandLogo, brandFile } from '../../ui/BrandLogo';
import { toast } from '../../ui/toast';
import { ConfirmButton, Switch } from '../admin/bits';
import { SectionHeader } from '../ai/agent';
import type { PageProps } from '../registry';
import { loadFacebookSdk, openWaSignup } from '../messages/waSignup';
import '../messages/messages.css';
import './comptes.css';

type List = Out<'social.list'>;
type Link = List['links'][number];
type Asset = Link['assets'][number];
type Provider = Link['provider'];
type Kind = Asset['kind'];
type Scope = 'here' | 'all';
type TestResult = Out<'social.test'>;
type Check = TestResult['checks'][number];
type CheckState = Check['state'];
/** « Tester »'s parts, in the order the page shows them (a part without a line is not shown; « app » is the control room's). */
const GROUPS: Check['group'][] = ['key', 'fb', 'ig', 'ads', 'forms', 'catalog', 'pixels', 'content', 'wa', 'app'];
/** each provider's ad accounts (a boutique counts all of a linked account's together) */
const AD_KIND: Record<Provider, Kind> = { meta: 'ad_account', tiktok: 'advertiser' };
const K = 'comptes.';
/** Meta's white logo for « Continuer avec Facebook » (Facebook Login): the file from Meta's brand centre, dropped as it
 * is in assets/brand/ (facebook-f-logo) — never redrawn or recoloured (Meta's rule). Never the blue facebook-logo: blue on
 * the button's blue breaks Meta's rule, so until the white file is there, the button shows its words only. */
const FB_LOGO = brandFile('facebook-f');
/** TikTok's own logo in « Continuer avec TikTok » (assets/brand/tiktok-logo), as TikTok gives it. */
const TT_LOGO = brandFile('tiktok');

/** A login in its tab: started here, asked about every two seconds until it is back. */
interface Pending {
  provider: Provider;
  /** « Publicité Meta »: Meta's second window (the ads' own line waits, not the Pages' one) */
  ads?: boolean;
  state: string;
  url: string | null;
  win: Window | null;
  blocked: boolean;
  /** the account is back: its tab asks « Oui, c'est ma boutique ? » */
  confirm?: boolean;
}

/** A Meta connection for the ads alone (« Publicité Meta », a pasted key): linked again in the ads' own window, no Page. */
const adsOnly = (l: Link) => l.provider === 'meta' && (l.part === 'ads' || (!l.assets.some((a) => a.kind === 'page') && l.assets.some((a) => a.kind === 'ad_account')));
/** Meta's two doors are open (Pilotix has the ads configuration): a Facebook account is the boutique's one Page, for it alone. */
const pageDoor = (l: Link, d: List) => l.provider === 'meta' && d.adsReady && !adsOnly(l);

/** A provider's tile: its official logo once its file is in assets/brand/ (ui/BrandLogo), else its two letters as before.
 * Meta's ads line is Meta's own (the ad accounts are Meta's, not Facebook's). `row`: a service line's 40 px tile, beside
 * the Instagram one (Instagram's glyph is never under 29 px); else a linked account's 32 px one. */
export function ProviderBadge({ p, part, row }: { p: Provider; part?: 'ads' | 'content'; row?: boolean }) {
  return (
    <BrandLogo
      name={p === 'tiktok' ? 'tiktok' : part === 'ads' ? 'meta' : 'facebook'}
      size={row ? undefined : 'sm'}
      fallback={
        <span className={`dl-ch ${p === 'meta' ? 'dl-messenger' : 'dl-tiktok'}`} aria-hidden="true">
          {p === 'meta' ? 'FB' : 'TT'}
        </span>
      }
    />
  );
}

/** Meta's login button, as Meta's rules ask: its « f » first, « Continuer avec Facebook » inside, white on Facebook blue. */
function FbButton({ small, disabled, onClick }: { small?: boolean; disabled?: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={`btn fb-btn${small ? ' small' : ''}`} disabled={disabled} onClick={onClick}>
      {FB_LOGO && <img src={FB_LOGO} alt="" className="fb-btn-logo" />}
      {t(K + 'p.meta.link')}
    </button>
  );
}

/** TikTok's login button, as TikTok's rules ask: its logo first, « Continuer avec TikTok » inside, white on black. */
function TtButton({ small, disabled, onClick }: { small?: boolean; disabled?: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={`btn tt-btn${small ? ' small' : ''}`} disabled={disabled} onClick={onClick}>
      {TT_LOGO && <img src={TT_LOGO} alt="" className="tt-btn-logo" />}
      {t(K + 'p.tiktok.link')}
    </button>
  );
}

/** Two letters of a name (its picture's stand-in). */
const initialsOf = (name: string) =>
  name
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '·';

/**
 * A picture from Meta (a Page's, an Instagram account's, a business portfolio's), or its name's two letters while it
 * has none or Meta's address no longer answers. Its name is written beside it: the picture adds no words.
 */
function Avatar({ src, name, shape, ig }: { src: string | null; name: string; shape: 'round' | 'square'; ig?: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`cpt-av ${shape}${ig ? ' ig' : ''}`} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <span>{initialsOf(name)}</span>}
    </span>
  );
}

export function Comptes({ sub }: PageProps) {
  const { t } = useTranslation();
  const q = useRpc('social.list', {});
  // « #/comptes/pub » (the Ads pages' « Connecter la publicité »): the ads' line comes into view, lit for a moment
  const [spot, setSpot] = useState(false);
  const listed = !!q.data;
  useEffect(() => {
    if (sub !== 'pub' || !listed) return;
    const el = document.getElementById('cpt-ads');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setSpot(true);
    const id = window.setTimeout(() => setSpot(false), 4000);
    return () => window.clearTimeout(id);
  }, [sub, listed]);
  const [scope, setScope] = useState<Scope>('here');
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<{ provider: Provider; ads?: boolean; linkId: number | null } | null>(null);
  // which accounts are open below their line (none at first: each line already shows what is connected)
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const closedTicks = useRef(0);

  // the login's tab: asked every two seconds; done → green, failed → said, tab closed before the end → stopped
  useEffect(() => {
    if (!pending) return;
    closedTicks.current = 0;
    let stop = false;
    const tick = async () => {
      try {
        const r = await rpc('social.state', { state: pending.state });
        if (stop) return;
        if (r.status === 'done') {
          setPending(null);
          setDone({ provider: pending.provider, ads: pending.ads, linkId: r.linkId });
          await q.refetch();
          return;
        }
        if (r.status === 'error' || r.status === 'expired') {
          setPending(null);
          toast(r.error ?? t(K + 'expired'), 'bad');
          return;
        }
        if (r.status === 'confirm' && !pending.confirm) setPending({ ...pending, confirm: true });
        if (pending.win?.closed && ++closedTicks.current >= 3) {
          setPending(null);
          toast(t(K + 'closed'), 'bad');
        }
      } catch (e) {
        if (!stop) {
          setPending(null);
          toast((e as Error).message, 'bad');
        }
      }
    };
    const id = window.setInterval(tick, 2000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // the green « linked » stays a few seconds
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(null), 6000);
    return () => window.clearTimeout(id);
  }, [done]);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;

  const start = async (provider: Provider, ads = false) => {
    if (pending) return;
    // the tab opens now, on the click (a tab opened after waiting for the server is blocked by browsers)
    const win = d.preview ? null : window.open('', '_blank');
    try {
      const r = await rpc('social.start', { provider, scope: d.canAll ? scope : 'here', ...(ads ? { kind: 'ads' as const } : {}) });
      if (r.url && win && !win.closed) win.location.href = r.url;
      setDone(null);
      setPending({ provider, ads, state: r.state, url: r.url, win, blocked: !!r.url && (!win || win.closed) });
    } catch (e) {
      win?.close();
      toast((e as Error).message, 'bad');
    }
  };
  const reopen = () => {
    if (!pending?.url) return;
    const win = window.open(pending.url, '_blank');
    setPending({ ...pending, win, blocked: !win });
  };
  const toggle = (id: number) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openOne = (id: number) => setOpenIds((prev) => new Set([...prev, id]));

  const meta = d.links.filter((l) => l.provider === 'meta');
  // Facebook and Instagram (with one login for all Meta: its ads too); the ads' own connections; TikTok
  const contentLinks = meta.filter((l) => !adsOnly(l));
  const adsLinks = meta.filter(adsOnly);
  const ttLinks = d.links.filter((l) => l.provider === 'tiktok');
  const doneName = (provider: Provider, ads: boolean) => (done?.provider === provider && !!done.ads === ads ? (d.links.find((l) => l.id === done.linkId)?.name ?? '') : null);
  const links = (list: Link[]) =>
    list.map((l) => <LinkCard key={l.id} l={l} d={d} fresh={done?.linkId === l.id} open={openIds.has(l.id)} onToggle={() => toggle(l.id)} onOpen={() => openOne(l.id)} onRelink={() => start(l.provider, adsOnly(l) && d.adsReady)} busy={!!pending} />);
  const contentBase = K + (d.adsReady ? 'p.metaContent' : 'p.meta');

  return (
    <div className="cpt">
      <SectionHeader icon="link" title={t(K + 'title')} help={t(K + (d.adsReady ? 'helpTwo' : 'help'))} about={t(K + 'about')} tabs={[]} current="" />
      <Card title={t(K + 'rows.title')} className="cpt-rows">
        {d.canAll && (
          <div className="cpt-scope">
            <span id="cpt-scope-l">{t(K + 'for')}</span>
            <div className="cpt-seg" role="radiogroup" aria-labelledby="cpt-scope-l">
              {(['here', 'all'] as Scope[]).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={scope === s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>
                  {s === 'here' ? (
                    <>
                      {t(K + 'scopeHere')} <bdi className="cpt-muted">{d.shop.name}</bdi>
                    </>
                  ) : (
                    t(K + 'scopeAll', { n: d.sisters.length })
                  )}
                </button>
              ))}
            </div>
            <small className="cpt-muted">{scope === 'here' ? t(K + 'scopeHereHint') : t(K + (d.adsReady ? 'scopeAllHintTwo' : 'scopeAllHint'))}</small>
          </div>
        )}

        {/* Facebook and Instagram: the boutique's one Page and its Instagram account (one login for all Meta: its ads too) */}
        <ServiceRow
          // the two logos linked like the account's pictures (the owner, 20 Nov 2026): see .cpt-logo-duo
          logos={
            <span className="cpt-logo-duo">
              <BrandLogo name="facebook" fallback={<span className="dl-ch dl-messenger" aria-hidden="true">FB</span>} />
              <BrandLogo name="instagram" fallback={<span className="dl-ch dl-instagram" aria-hidden="true">IG</span>} />
            </span>
          }
          title={t(contentBase + '.name')}
          what={t(contentBase + '.what')}
          help={!contentLinks.length && d.apps.meta ? t(contentBase + '.allow') : null}
          pending={pending?.provider === 'meta' && !pending.ads ? pending : null}
          done={doneName('meta', false)}
          preview={d.preview}
          onReopen={reopen}
          onCancel={() => setPending(null)}
          button={contentLinks.length ? null : <FbButton disabled={!d.apps.meta || !!pending} onClick={() => start('meta')} />}
          note={!d.apps.meta ? t(contentBase + '.notReady') : d.adsReady && d.canAll && scope === 'all' ? t(K + 'p.metaContent.hereOnly') : null}
        >
          {links(contentLinks)}
        </ServiceRow>

        {/* Meta's ads: the ad accounts, the catalogue, the pixels and the lead forms; also a Meta Ads key pasted by hand */}
        <ServiceRow
          id="cpt-ads"
          spot={spot}
          logos={<BrandLogo name="meta" fallback={<span className="dl-ch dl-messenger" aria-hidden="true">M</span>} />}
          title={t(K + 'p.metaAds.name')}
          what={t(K + 'p.metaAds.what')}
          help={d.adsReady && !adsLinks.length && d.apps.meta ? t(K + 'p.metaAds.allow') : null}
          pending={pending?.provider === 'meta' && pending.ads ? pending : null}
          done={doneName('meta', true)}
          preview={d.preview}
          onReopen={reopen}
          onCancel={() => setPending(null)}
          // one login for all Meta: the first button brings the ads too
          button={!d.adsReady || adsLinks.length ? null : <FbButton disabled={!d.apps.meta || !!pending} onClick={() => start('meta', true)} />}
          note={!d.adsReady ? t(K + 'p.metaAds.viaFirst') : !d.apps.meta ? t(K + 'p.metaAds.notReady') : null}
          after={<AdsKeyBox onSaved={openOne} />}
        >
          {links(adsLinks)}
        </ServiceRow>

        {/* WhatsApp: a number, in Meta's own window (Embedded Signup is a Facebook login: Meta's button starts it) */}
        <WhatsappRow d={d} busy={!!pending} />

        {/* TikTok: the TikTok ad accounts (Catalogue lists, Publicité) */}
        <ServiceRow
          logos={<ProviderBadge p="tiktok" row />}
          title={t(K + 'p.tiktok.name')}
          what={t(K + 'p.tiktok.what')}
          pending={pending?.provider === 'tiktok' ? pending : null}
          done={doneName('tiktok', false)}
          preview={d.preview}
          onReopen={reopen}
          onCancel={() => setPending(null)}
          button={ttLinks.length ? null : <TtButton disabled={!d.apps.tiktok || !!pending} onClick={() => start('tiktok')} />}
          note={!d.apps.tiktok ? t(K + 'p.tiktok.notReady') : null}
        >
          {links(ttLinks)}
        </ServiceRow>
      </Card>
      <OldKeys d={d} />
    </div>
  );
}

/**
 * One thing to connect, on one line: its logos, its name and what it brings, then on the right what is connected (each
 * account, opening below its line) or the platform's own button. A login on its way shows below the line.
 */
function ServiceRow({
  id,
  spot,
  logos,
  title,
  what,
  help,
  note,
  button,
  pending,
  done,
  preview,
  onReopen,
  onCancel,
  after,
  children,
}: {
  id?: string;
  spot?: boolean;
  logos: ReactNode;
  title: string;
  what: string;
  help?: string | null;
  note?: string | null;
  button: ReactNode;
  pending: Pending | null;
  done: string | null;
  preview: boolean;
  onReopen: () => void;
  onCancel: () => void;
  after?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section id={id} className={`cpt-svc${spot ? ' spot' : ''}${pending ? ' wait' : ''}${done !== null ? ' done' : ''}`} aria-label={title} aria-live="polite">
      <div className="cpt-svc-logos">{logos}</div>
      <div className="cpt-svc-txt">
        <h3>{title}</h3>
        <p className="cpt-muted">{what}</p>
        {help && <small className="cpt-muted cpt-svc-help">{help}</small>}
        {note && <small className="cpt-muted cpt-svc-help">{note}</small>}
      </div>
      {button && !pending && <div className="cpt-svc-act">{button}</div>}
      {children}
      {done !== null && (
        <p className="cpt-svc-wide cpt-slot-done">
          <Icon name="checkcircle" />
          <span>
            <b>{t(K + 'linked')}</b> {done && <bdi>{t(K + 'linkedName', { name: done })}</bdi>}
          </span>
        </p>
      )}
      {pending && (
        <div className="cpt-svc-wide cpt-slot-wait">
          <p>
            <span className="cpt-spin" aria-hidden="true" />
            <b>{pending.confirm ? t(K + 'confirmWait') : t(K + 'waiting')}</b>
          </p>
          <p className="cpt-muted">{preview ? t(K + 'waitingPreview') : pending.confirm ? t(K + 'confirmHelp', { name: title }) : pending.blocked ? t(K + 'blocked', { name: title }) : t(K + 'waitingHelp', { name: title })}</p>
          <div className="cpt-do">
            {pending.url && (
              <button type="button" className={`btn small ${pending.blocked ? 'primary' : 'ghost'}`} onClick={onReopen}>
                {pending.blocked ? t(K + 'open', { name: title }) : t(K + 'reopen')}
              </button>
            )}
            <button type="button" className="btn ghost small" onClick={onCancel}>
              {t(K + 'cancel')}
            </button>
          </div>
        </div>
      )}
      {after && <div className="cpt-svc-wide">{after}</div>}
    </section>
  );
}

/**
 * The keys connected before somewhere else (Réglages › Meta Ads, Pilot Message): they still work, and go when the
 * Facebook account takes their place or the boutique removes them.
 */
function OldKeys({ d }: { d: List }) {
  const { t } = useTranslation();
  const dropOld = useAction('social.dropOld', { success: t(K + 'old.removed') });
  // an old Instagram key may go only once the Facebook account's key can answer in its place (« Tester » or « Relier » says so)
  const old: { what: 'ads' | 'instagram'; text: string; hint: string; can: boolean }[] = [
    ...(d.old.ads ? [{ what: 'ads' as const, text: t(K + 'old.ads', { id: d.old.ads.adAccountId || '—' }), hint: t(K + 'old.adsHint'), can: true }] : []),
    ...(d.old.instagram
      ? [{ what: 'instagram' as const, text: t(K + 'old.ig', { user: d.old.instagram.username || '—' }), hint: t(K + (d.old.instagram.ready ? 'old.igHint' : 'old.igWait')), can: d.old.instagram.ready }]
      : []),
  ];
  if (!old.length) return null;
  return (
    <section className="cpt-old" aria-labelledby="cpt-old-h">
      <h3 id="cpt-old-h">
        <Icon name="history" /> {t(K + 'old.title')}
      </h3>
      <p className="cpt-muted">{t(K + 'old.text')}</p>
      <ul>
        {old.map((o) => (
          <li key={o.what}>
            <span>
              <b>
                <bdi>{o.text}</bdi>
              </b>
              <small>{o.hint}</small>
            </span>
            {o.can && (
              <ConfirmButton className="btn ghost small danger" question={t(K + `old.ask.${o.what}`)} onConfirm={() => dropOld.mutate({ what: o.what })} disabled={dropOld.isPending}>
                <Icon name="unlink" /> {t(K + 'remove')}
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * « Coller une clé Meta Ads »: the other way to connect the ads, for a boutique whose Facebook window does not give its
 * ad accounts. The key is made in the boutique's own Meta business (a system user's token, for Pilotix's app, with
 * ads_read and ads_management); the server asks Meta about it and keeps it (it never comes back to a page).
 */
function AdsKeyBox({ onSaved }: { onSaved: (linkId: number) => void }) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const save = useAction('social.adsKey', {
    success: t(K + 'adsKey.saved'),
    onDone: (r) => {
      setKey('');
      onSaved(r.linkId);
    },
  });
  return (
    <details className="cpt-key">
      <summary>{t(K + 'adsKey.toggle')}</summary>
      <p className="cpt-muted">{t(K + 'adsKey.help')}</p>
      <bdi className="dl-path" dir="ltr">
        Meta Business Suite › Settings › Users › System users › Generate token
      </bdi>
      <form
        className="cpt-key-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() && !save.isPending) save.mutate({ token: key.trim() });
        }}
      >
        <label htmlFor="cpt-key-in">{t(K + 'adsKey.label')}</label>
        <input id="cpt-key-in" type="password" className="ltr" autoComplete="off" spellCheck={false} value={key} placeholder="EAA…" onChange={(e) => setKey(e.target.value)} />
        <button type="submit" className="btn small" disabled={key.trim().length < 30 || save.isPending}>
          {save.isPending ? t(K + 'adsKey.saving') : t(K + 'adsKey.save')}
        </button>
      </form>
    </details>
  );
}

/**
 * WhatsApp's line: the boutique's WhatsApp number, connected in Meta's own window (Embedded Signup: the shop picks or
 * makes its WhatsApp Business account and its number). Embedded Signup is a Facebook login, so Meta's own « Continuer
 * avec Facebook » starts it (Meta's example does the same); WhatsApp's logo says what the line is for. Meta's popup
 * (its JavaScript SDK) is loaded before the click so it opens on the click itself; without it (Meta's script blocked,
 * the preview) a tab opens, asked about every two seconds like the Facebook login. Pilotix keeps the key; the number
 * answers in Pilot Message and sends the delivery messages. Always for this boutique only.
 */
function WhatsappRow({ d, busy }: { d: List; busy: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const remove = useAction('social.waRemove', { success: t(K + 'wa.removed') });
  const [pending, setPending] = useState<{ state: string; url: string | null; win: Window | null } | null>(null);
  const [popup, setPopup] = useState(false);
  const closed = useRef(0);
  const demo = backend.kind === 'demo';
  useEffect(() => {
    if (!pending) return;
    closed.current = 0;
    let stop = false;
    const tick = async () => {
      try {
        const r = await rpc('social.state', { state: pending.state });
        if (stop) return;
        if (r.status === 'done') {
          setPending(null);
          await qc.invalidateQueries();
          toast(t(K + 'wa.done'), 'ok');
          return;
        }
        if (r.status === 'error' || r.status === 'expired') {
          setPending(null);
          toast(r.error ?? t(K + 'expired'), 'bad');
          return;
        }
        if (pending.win?.closed && ++closed.current >= 3) {
          setPending(null);
          toast(t(K + 'closed'), 'bad');
        }
      } catch (e) {
        if (!stop) {
          setPending(null);
          toast((e as Error).message, 'bad');
        }
      }
    };
    const id = window.setInterval(tick, 2000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const sdkQ = useRpc('social.waSdk', {}, { enabled: !demo && d.waReady });
  const sdk = sdkQ.data ?? null;
  const [fb, setFb] = useState<Awaited<ReturnType<typeof loadFacebookSdk>> | null>(null);
  useEffect(() => {
    if (!sdk) return;
    let on = true;
    loadFacebookSdk(sdk)
      .then((x) => on && setFb(x))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [sdk?.appId, sdk?.configId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startTab = async () => {
    // opened now, on the click: a tab opened after waiting for the server is blocked by browsers
    const win = demo ? null : window.open('', '_blank');
    try {
      const r = await rpc('social.start', { provider: 'meta', kind: 'whatsapp' });
      if (r.url && win && !win.closed) win.location.href = r.url;
      setPending({ state: r.state, url: r.url, win });
    } catch (e) {
      win?.close();
      toast((e as Error).message, 'bad');
    }
  };
  const startPopup = () => {
    if (!fb || !sdk) return;
    setPopup(true);
    // the login's state is asked while Meta's popup is open (the popup itself must open now, on the click)
    const st = rpc('social.start', { provider: 'meta', kind: 'whatsapp' });
    openWaSignup(fb, sdk)
      .then(async (r) => {
        const s = await st;
        const done = await rpc('social.waFinish', { state: s.state, code: r.code, wabaId: r.wabaId, phoneId: r.phoneId });
        await qc.invalidateQueries();
        toast(done.warn ? done.warn : t(K + 'wa.done'), done.warn ? 'bad' : 'ok');
      })
      .catch((e: Error) => toast(e.message === 'cancelled' ? t(K + 'closed') : e.message, 'bad'))
      .finally(() => setPopup(false));
    st.catch(() => undefined);
  };
  const start = () => {
    if (pending || popup) return;
    if (fb && sdk) startPopup();
    else void startTab();
  };
  const waiting = !!pending || popup;
  const wa = d.whatsapp;
  const name = t(K + 'wa.name');
  return (
    <section className={`cpt-svc${waiting ? ' wait' : ''}`} aria-label={name} aria-live="polite">
      <div className="cpt-svc-logos">
        <BrandLogo
          name="whatsapp"
          fallback={
            <span className="dl-ch dl-whatsapp" aria-hidden="true">
              WA
            </span>
          }
        />
      </div>
      <div className="cpt-svc-txt">
        <h3>{name}</h3>
        <p className="cpt-muted">{t(K + 'wa.what')}</p>
        {!wa && d.waReady && <small className="cpt-muted cpt-svc-help">{t(K + 'wa.allow')}</small>}
        {!d.waReady && <small className="cpt-muted cpt-svc-help">{t(K + 'wa.notReady')}</small>}
      </div>
      {!waiting && (
        <div className="cpt-svc-act">
          {wa ? (
            <div className="cpt-conn ok">
              <span className="cpt-conn-who static">
                <BrandLogo name="whatsapp" size="sm" fallback={<span className="dl-ch dl-whatsapp" aria-hidden="true">WA</span>} />
                <span className="cpt-conn-id">
                  <b>
                    <bdi dir="ltr">{wa.phone || t(K + 'here.waId', { id: wa.phoneId })}</bdi>
                  </b>
                  {wa.old && <small>{t(K + 'wa.old')}</small>}
                </span>
              </span>
              <span className="cpt-st ok">{t(K + 'wa.onShort')}</span>
              <ConfirmButton className="btn ghost small danger" question={t(K + 'wa.removeAsk')} onConfirm={() => remove.mutate({})} disabled={remove.isPending}>
                <Icon name="unlink" /> {t(K + 'remove')}
              </ConfirmButton>
            </div>
          ) : (
            <FbButton disabled={!d.waReady || busy} onClick={start} />
          )}
        </div>
      )}
      {/* another number: Meta's window again (its own « Continuer avec Facebook ») */}
      {wa && !waiting && (
        <div className="cpt-svc-wide cpt-again">
          <span className="cpt-muted">{t(K + 'wa.againLead')}</span>
          <FbButton small disabled={!d.waReady || busy} onClick={start} />
        </div>
      )}
      {waiting && (
        <div className="cpt-svc-wide cpt-slot-wait">
          <p>
            <span className="cpt-spin" aria-hidden="true" />
            <b>{t(K + 'waiting')}</b>
          </p>
          <p className="cpt-muted">{d.preview ? t(K + 'waitingPreview') : t(K + 'wa.waitingHelp')}</p>
          {pending && (
            <div className="cpt-do">
              {pending.url && (
                <button type="button" className="btn ghost small" onClick={() => setPending({ ...pending, win: window.open(pending.url!, '_blank') })}>
                  {t(K + 'reopen')}
                </button>
              )}
              <button type="button" className="btn ghost small" onClick={() => setPending(null)}>
                {t(K + 'cancel')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** What a linked account looks like on its line: its pictures, its name, and under it what it brings here. */
function lookOf(l: Link, d: List, t: ReturnType<typeof useTranslation>['t']) {
  const adList = l.assets.filter((a) => a.kind === AD_KIND[l.provider]);
  if (l.provider === 'tiktok') return { pics: <ProviderBadge p="tiktok" />, main: l.name || t(K + 'p.tiktok.name'), sub: adList.length ? t(K + 'sumAds', { n: adList.length }) : t(K + 'kind.advertiserNone') };
  if (adsOnly(l)) {
    // the business portfolio of the ad account new ads go out from (else of the first one that has it)
    const withBiz = adList.filter((a) => a.business);
    const biz = (withBiz.find((a) => d.launch?.id === a.extId) ?? withBiz[0])?.business ?? null;
    return {
      pics: biz ? <Avatar src={biz.picture} name={biz.name} shape="square" /> : <ProviderBadge p="meta" part="ads" />,
      main: biz?.name || l.name || t(K + 'p.metaAds.name'),
      sub: [t(K + 'sumAds', { n: adList.length }), biz && l.name && l.name !== biz.name ? t(K + 'conn.via', { name: l.name }) : null].filter(Boolean).join(' · '),
    };
  }
  // a Facebook account: the Page this boutique answers on, and its Instagram account
  const pages = l.assets.filter((a) => a.kind === 'page');
  const page = pages.find((a) => a.usedHere) ?? (pages.length === 1 ? pages[0] : null);
  const adsHere = adList.some((a) => a.usedHere);
  const ads = adsHere ? t(K + 'sumAds', { n: adList.length }) : null;
  if (!page) return { pics: <ProviderBadge p="meta" />, main: l.name || t(K + 'p.meta.name'), sub: [pages.length ? t(K + 'pageNone') : t(K + 'kind.pageNone'), ads].filter(Boolean).join(' · ') };
  return {
    pics: (
      <span className="cpt-duo">
        <Avatar src={page.picture} name={page.name} shape="round" />
        {page.igUsername && <Avatar src={page.igPicture} name={page.igUsername} shape="round" ig />}
      </span>
    ),
    main: page.name,
    sub: [page.igUsername ? `@${page.igUsername}` : t(K + 'noIg'), ads].filter(Boolean).join(' · '),
  };
}

/**
 * A linked account on its line. Closed: its pictures and name, its state, « Tester ». Open (below the line): the Page
 * this boutique answers on (picked in a list: one account often has dozens of Pages), its ad accounts (all counted
 * here, or none), what the last test found, then « Continuer avec Facebook » to link it again, and « Retirer ».
 */
function LinkCard({ l, d, fresh, open, onToggle, onOpen, onRelink, busy }: { l: Link; d: List; fresh: boolean; open: boolean; onToggle: () => void; onOpen: () => void; onRelink: () => void; busy: boolean }) {
  const { t, i18n } = useTranslation();
  const scope = useAction('social.scope', { success: t(K + 'scopeSaved') });
  const remove = useAction('social.remove', { success: t(K + 'removed') });
  const use = useAction('social.use', { success: t(K + 'pageSaved') });
  const unuse = useAction('social.unuse', { success: t(K + 'pageStopped') });
  const ads = useAction('social.ads', { success: (r) => (r.links.find((x) => x.id === l.id)?.assets.some((a) => a.kind === AD_KIND[l.provider] && a.usedHere) ? t(K + 'adsOn') : t(K + 'adsOff')) });
  const [result, setResult] = useState<TestResult | null>(null);
  const launch = useAction('social.launchAccount', { success: (r) => t(K + 'launchSaved', { name: r.launch?.accounts.find((a) => a.id === r.launch?.id)?.name || r.launch?.id || '' }) });
  const test = useAction('social.test', { onDone: (r) => setResult(r) });
  const bodyId = `cpt-link-${l.id}`;
  const status =
    l.status === 'ok'
      ? { cls: 'ok', text: t(K + 'st.ok') }
      : l.status === 'soon'
        ? { cls: 'warn', text: t(K + 'st.soon', { date: dateOnly(l.expiresAt) }) }
        : l.status === 'expired'
          ? { cls: 'bad', text: t(K + 'st.expired') }
          : { cls: 'bad', text: t(K + 'st.error') };
  const broken = l.status === 'expired' || l.status === 'error';
  const pages = l.assets.filter((a) => a.kind === 'page').sort((a, b) => a.name.localeCompare(b.name, i18n.language));
  const page = pages.find((a) => a.usedHere) ?? null;
  const adKind = AD_KIND[l.provider];
  const adList = l.assets.filter((a) => a.kind === adKind);
  const adsHere = adList.some((a) => a.usedHere);
  const adsAlso = adList[0]?.usedBy ?? [];
  // this boutique counts another account's ad accounts: switching these on replaces them
  const adsOther = !adsHere ? d.here[adKind === 'ad_account' ? 'ad_account' : 'advertiser'] : null;
  const money = [...new Set(adList.map((a) => a.currency).filter((c): c is string => !!c))];
  // dinars count in dinars in Publicité; any other money is taken as dollars
  const otherMoney = money.filter((c) => c !== 'USD' && c !== 'DZD');
  const mainTwo = pageDoor(l, d);
  const look = lookOf(l, d, t);
  const runTest = () => {
    onOpen();
    test.mutate({ linkId: l.id });
  };
  // the platform's own login button links it again (Meta's « f » on blue, TikTok's logo on black)
  const relinkBtn = (small: boolean) => (l.provider === 'tiktok' ? <TtButton small={small} disabled={busy} onClick={onRelink} /> : <FbButton small={small} disabled={busy} onClick={onRelink} />);
  return (
    <div className={`cpt-link${open ? ' open' : ''}${fresh ? ' fresh' : ''}`}>
      <div className={`cpt-conn ${status.cls}`}>
        <button type="button" className="cpt-conn-who" aria-expanded={open} aria-controls={bodyId} title={t(K + 'conn.details')} onClick={onToggle}>
          {look.pics}
          <span className="cpt-conn-id">
            <b>
              <bdi>{look.main}</bdi>
            </b>
            {look.sub && (
              <small>
                <bdi>{look.sub}</bdi>
              </small>
            )}
          </span>
          <Icon name="chevron" className="cpt-chev" />
        </button>
        <span className={`cpt-st ${status.cls}`}>{status.text}</span>
        {broken && relinkBtn(true)}
        <button type="button" className="btn small" disabled={test.isPending} onClick={runTest}>
          <Icon name="pulse" /> {test.isPending ? t(K + 'testing') : t(K + 'test')}
        </button>
      </div>
      {open && (
        <div id={bodyId} className="cpt-link-body">
          {broken && <p className="cpt-link-err">{l.error || t(K + 'relinkNow')}</p>}
          {/* an account that came for the ads alone (« Publicité Meta », a pasted key) has no Page to pick */}
          {l.provider === 'meta' && !adsOnly(l) && (
            <div className="cpt-row">
              <div className="cpt-row-l">
                <label className="cpt-row-t" htmlFor={`cpt-page-${l.id}`}>
                  {t(K + 'pageLabel')}
                </label>
                <p>{t(K + 'pageHint', { name: d.shop.name })}</p>
              </div>
              <div className="cpt-row-r">
                <select id={`cpt-page-${l.id}`} className="cpt-pick" value={page ? String(page.id) : ''} disabled={!pages.length || use.isPending || unuse.isPending} onChange={(e) => (e.target.value ? use.mutate({ assetId: Number(e.target.value) }) : unuse.mutate({ kind: 'page' }))}>
                  <option value="">{pages.length ? t(K + 'pageNone') : t(K + 'pageEmpty')}</option>
                  {pages.map((a) => {
                    const there = !a.usedHere && a.usedBy[0] ? a.usedBy[0].name : null;
                    return (
                      <option key={a.id} value={a.id} disabled={!!there}>
                        {there ? t(K + 'pageThere', { name: a.name, there }) : a.name}
                      </option>
                    );
                  })}
                </select>
                {page ? (
                  <p className="cpt-row-note">
                    {page.igUsername ? <span className="cpt-ig">{t(K + 'ig', { ig: page.igUsername })}</span> : <span>{t(K + 'noIg')}</span>}
                    {page.noHook && <span className="cpt-warn">{t(K + 'noHook')}</span>}
                  </p>
                ) : (
                  <p className="cpt-row-note">{pages.length ? t(K + 'pageCount', { n: pages.length }) : t(K + 'kind.pageNone')}</p>
                )}
              </div>
            </div>
          )}
          {!(mainTwo && !adList.length) && (
            <div className="cpt-row">
              <div className="cpt-row-l">
                <span className="cpt-row-t">{t(K + `adsLabel.${l.provider}`, { n: adList.length })}</span>
                <p>{t(K + 'adsHint')}</p>
              </div>
              <div className="cpt-row-r">
                {adList.length ? (
                  <>
                    <div className="cpt-switch-row">
                      <Switch checked={adsHere} disabled={ads.isPending} onChange={(v) => ads.mutate({ linkId: l.id, on: v })} label={t(K + 'adsUse', { name: d.shop.name })} />
                      <span>
                        <bdi>{t(K + 'adsUse', { name: d.shop.name })}</bdi>
                      </span>
                    </div>
                    <ul className={`cpt-chips ${adsHere ? 'on' : ''}`}>
                      {adList.map((a) => (
                        <li key={a.id}>
                          <bdi>{a.name}</bdi>
                          {a.currency && <span className="ltr">{a.currency}</span>}
                        </li>
                      ))}
                    </ul>
                    {/* the business portfolios these ad accounts belong to (a pasted key may reach several) */}
                    {[...new Set(adList.map((a) => a.business?.name).filter((x): x is string => !!x))].length > 0 && (
                      <p className="cpt-row-note">{t(K + 'conn.business', { names: [...new Set(adList.map((a) => a.business?.name).filter((x): x is string => !!x))].map((x) => t(K + 'quoted', { name: x })).join(', ') })}</p>
                    )}
                    {adsHere && l.provider === 'meta' && d.launch && d.launch.accounts.length > 1 && (
                      <div className="cpt-launch">
                        <label className="cpt-row-t" htmlFor={`cpt-launch-${l.id}`}>
                          {t(K + 'launchLabel')}
                        </label>
                        <select id={`cpt-launch-${l.id}`} className="cpt-pick" value={d.launch.id} disabled={launch.isPending} onChange={(e) => launch.mutate({ adAccountId: e.target.value })}>
                          {d.launch.accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.currency ? t(K + 'launchOption', { name: a.name || a.id, money: a.currency }) : a.name || a.id}
                            </option>
                          ))}
                        </select>
                        <p className="cpt-row-note">{t(K + 'launchHint')}</p>
                      </div>
                    )}
                    {adsOther && <p className="cpt-row-note">{t(K + 'adsOther', { account: adsOther.account })}</p>}
                    {adsAlso.length > 0 && <p className="cpt-row-note">{t(K + 'adsAlso', { names: adsAlso.map((x) => t(K + 'quoted', { name: x.name })).join(', ') })}</p>}
                    {otherMoney.length > 0 ? (
                      <p className="cpt-warn">{t(K + 'adsMixed', { list: otherMoney.join(', ') })}</p>
                    ) : (
                      money.includes('DZD') && <p className="cpt-row-note">{t(K + 'adsDzd')}</p>
                    )}
                  </>
                ) : (
                  <p className="cpt-row-note">{t(K + `kind.${adKind}None`)}</p>
                )}
              </div>
            </div>
          )}
          {(result || test.isPending) && <TestLines r={result} pending={test.isPending} provider={l.provider} />}
          <footer>
            <span className="cpt-muted">{t(K + 'by', { by: l.by || '—', date: dateOnly(l.createdAt) })}</span>
            <span className="cpt-do">
              {d.canAll && !(mainTwo && l.scope === 'here') ? (
                <select className="cpt-scope-sel" aria-label={t(K + 'for')} value={l.scope} disabled={scope.isPending} onChange={(e) => scope.mutate({ linkId: l.id, scope: e.target.value as Scope })}>
                  <option value="here">{t(K + 'scopeHereOnly', { name: d.shop.name })}</option>
                  {/* the two doors: a Page's account is linked to one boutique only */}
                  <option value="all" disabled={mainTwo}>
                    {t(K + 'scopeAllShort')}
                  </option>
                </select>
              ) : (
                <span className="chip">{l.scope === 'all' ? t(K + 'scopeAllShort') : t(K + 'scopeHereOnly', { name: l.shopName ?? d.shop.name })}</span>
              )}
              {(l.scope === 'here' || d.isOwner) && (
                <ConfirmButton className="btn ghost small danger" question={t(K + 'removeAsk')} onConfirm={() => remove.mutate({ linkId: l.id })} disabled={remove.isPending}>
                  <Icon name="unlink" /> {t(K + 'remove')}
                </ConfirmButton>
              )}
            </span>
          </footer>
          {/* linked again (a new Page, more ad accounts, a key near its end): the platform's own login, as at first */}
          {!broken && (
            <div className="cpt-again" title={t(K + 'relinkHint')}>
              <span className="cpt-muted">{t(K + 'relinkLead')}</span>
              {relinkBtn(true)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const WORST: CheckState[] = ['bad', 'warn', 'info', 'ok'];
const worstOf = (list: Check[]): CheckState => WORST.find((s) => list.some((c) => c.state === s)) ?? 'ok';
const ICON: Record<CheckState, string> = { ok: 'checkcircle', warn: 'alert', bad: 'xcircle', info: 'info' };

/**
 * What « Tester » found, part by part (the key, the Page, Instagram, Publicité, the forms, the catalogue, the pixels,
 * WhatsApp; in the control room, Pilotix's Meta app). The top says where the problems are; a part that works is folded
 * to one green line, a part with a problem is open. In a part, line by line: green works, orange to look at, red to
 * fix, grey to know (the platform's own words under a line).
 */
export function TestLines({ r, pending, provider }: { r: TestResult | null; pending: boolean; provider: Provider }) {
  const { t } = useTranslation();
  if (!r)
    return (
      <section className="cpt-test" aria-live="polite">
        <p className="cpt-test-wait">
          <span className="cpt-spin" aria-hidden="true" /> {t(K + 'testing')}
        </p>
      </section>
    );
  const parts = GROUPS.map((g) => ({ g, list: r.checks.filter((c) => c.group === g) })).filter((x) => x.list.length);
  const count = (s: CheckState) => r.checks.filter((c) => c.state === s).length;
  const bad = count('bad');
  const warn = count('warn');
  // where to look: the parts with something red (the problem), then the ones with something to look at
  const namesOf = (s: CheckState) => parts.filter((x) => worstOf(x.list) === s).map((x) => t(K + `grp.${x.g}`));
  const where: { state: 'bad' | 'warn'; text: string; names: string[] }[] = [
    { state: 'bad' as const, text: t(K + 'testWhereBad'), names: namesOf('bad') },
    { state: 'warn' as const, text: t(K + (bad ? 'testWhereAlso' : 'testWhere')), names: namesOf('warn') },
  ].filter((x) => x.names.length);
  const time = clock(r.at);
  const line = (c: Check, i: number) => {
    const key = c.key === 'token' && provider === 'tiktok' ? 'tokenTiktok' : c.key;
    // a line's own text when it says more than its state: fixed, taken by no shop, why (Cloudflare, standby, an error…)
    const v = c.params?.fixed ? 'fixed' : c.params?.lost ? 'lost' : c.params?.why ? String(c.params.why) : c.state;
    const { count: n, at, until, ...rest } = c.params ?? {};
    return (
      <li key={`${c.key}-${i}`} className={c.state}>
        <Icon name={ICON[c.state]} />
        <span>
          <bdi>{t(K + `check.${key}.${v}`, { ...rest, n: n ?? '', when: at ? when(String(at)) : '', date: until ? dateOnly(String(until)) : '', defaultValue: c.key })}</bdi>
          {c.detail && <small>{c.detail}</small>}
        </span>
      </li>
    );
  };
  return (
    <section className={`cpt-test ${pending ? 'again' : ''}`} aria-live="polite">
      <h4>
        <span>{t(K + 'testTitle', { time })}</span>
        <span className={`cpt-st ${bad ? 'bad' : warn ? 'warn' : 'ok'}`}>{bad ? t(K + 'testBad', { n: bad }) : warn ? t(K + 'testTodo', { n: warn }) : t(K + 'testAll')}</span>
      </h4>
      {where.map((x) => (
        <p key={x.state} className={`cpt-test-where ${x.state}`}>
          <Icon name={ICON[x.state]} />
          <span>
            {x.text} <b>{x.names.join(' · ')}</b>
          </span>
        </p>
      ))}
      <div className="cpt-parts">
        {parts.map(({ g, list }) => {
          const state = worstOf(list);
          const todo = list.filter((c) => c.state === 'bad' || c.state === 'warn').length;
          return (
            <details key={`${r.at}-${g}`} className={`cpt-part ${state}`} open={state !== 'ok'}>
              <summary>
                <Icon name={ICON[state]} />
                <b>{t(K + `grp.${g}`)}</b>
                <span className="cpt-part-st">{state === 'bad' || state === 'warn' ? t(K + (state === 'bad' ? 'partBad' : 'partTodo'), { n: todo }) : state === 'info' ? t(K + 'partInfo') : t(K + 'partOk')}</span>
                <Icon name="chevron" className="cpt-chev" />
              </summary>
              <ul>{list.map(line)}</ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}
