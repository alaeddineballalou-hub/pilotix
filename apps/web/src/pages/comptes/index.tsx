// Pilot AI › Comptes: THE one place where a boutique connects Meta and TikTok. « Continuer avec Facebook » opens
// Facebook's login in a new tab; the person logs in, ticks everything and accepts there, Pilotix does the rest on its
// server, and this page turns green (it asks every two seconds): the Pages (messages, comments, forms), Instagram, the
// ad accounts (Publicité, the catalogue, the pixels) come together. WhatsApp (Meta's own window for a number) and
// TikTok are connected in the same card. An account serves this boutique (its first Page and ad account are used at
// once) or all the owner's boutiques (each boutique picks its Page and its ad account in one click). « Tester » says,
// part by part, what works and where a problem is. The tokens never come to a page (packages/core/src/modules/social.ts).
// When Pilotix's Meta app has a second configuration for the ads (the control room), Meta is connected in two steps,
// each asking Facebook for its own things: « Facebook et Instagram » (Pages, messages, comments, posts), then
// « Publicité Meta » (ad accounts, catalogue, pixels, lead forms). That slot also takes a Meta Ads key pasted by hand.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc } from '../../lib/backend';
import { clock, dateOnly, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
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
const PROVIDERS: Provider[] = ['meta', 'tiktok'];
/** « Tester »'s parts, in the order the page shows them (a part without a line is not shown). */
const GROUPS: Check['group'][] = ['key', 'fb', 'ig', 'ads', 'forms', 'catalog', 'pixels', 'content', 'wa', 'app'];
/** each provider's ad accounts (a boutique counts all of a linked account's together) */
const AD_KIND: Record<Provider, Kind> = { meta: 'ad_account', tiktok: 'advertiser' };
const K = 'comptes.';
/** Meta's own « f » logo for « Continue with Facebook »: the file from Meta's brand centre (facebookbrand.com), dropped as
 * it is in assets/brand/ — never redrawn or recoloured (Meta's rule). Until it is there, the button shows its words only. */
const FB_LOGO = Object.values(import.meta.glob('../../assets/brand/facebook-f-logo.{svg,png}', { eager: true, import: 'default' }))[0] as string | undefined;

/** A login in its tab: started here, asked about every two seconds until it is back. */
interface Pending {
  provider: Provider;
  /** « Connecter la publicité »: Meta's second window (the ads' own slot waits, not the Pages' one) */
  ads?: boolean;
  state: string;
  url: string | null;
  win: Window | null;
  blocked: boolean;
  /** the account is back: its tab asks « Oui, c'est ma boutique ? » */
  confirm?: boolean;
}

/** A Meta account that came for the ads alone (« Publicité Meta », a pasted key): linked again in the ads' own window. */
const adsOnly = (l: Link) => l.provider === 'meta' && !l.assets.some((a) => a.kind === 'page') && l.assets.some((a) => a.kind === 'ad_account');

export function ProviderBadge({ p }: { p: Provider }) {
  return (
    <span className={`dl-ch ${p === 'meta' ? 'dl-messenger' : 'dl-tiktok'}`} aria-hidden="true">
      {p === 'meta' ? 'FB' : 'TT'}
    </span>
  );
}

export function Comptes(_: PageProps) {
  const { t } = useTranslation();
  const q = useRpc('social.list', {});
  const [scope, setScope] = useState<Scope>('here');
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<{ provider: Provider; ads?: boolean; linkId: number | null } | null>(null);
  // which accounts are open (null: the first view — one account open, several folded)
  const [openIds, setOpenIds] = useState<Set<number> | null>(null);
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

  // the green « linked » stays a few seconds; the account just linked opens
  useEffect(() => {
    if (!done) return;
    if (done.linkId) setOpenIds((prev) => new Set([...(prev ?? []), done.linkId!]));
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

  return (
    <div className="cpt">
      <SectionHeader icon="link" title={t(K + 'title')} help={t(K + 'help')} about={t(K + 'about')} tabs={[]} current="" />
      <HereCard d={d} />
      <Card title={t(K + 'add')} className="cpt-add">
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
            <small className="cpt-muted">{scope === 'here' ? t(K + 'scopeHereHint') : t(K + 'scopeAllHint')}</small>
          </div>
        )}
        <div className="cpt-providers four">
          {PROVIDERS.map((p) => [
            <ProviderSlot key={p} p={p} part={p === 'meta' && d.adsReady ? 'content' : undefined} ready={d.apps[p]} preview={d.preview} pending={pending?.provider === p && !pending.ads ? pending : null} busy={!!pending} done={done?.provider === p && !done.ads ? (d.links.find((l) => l.id === done.linkId)?.name ?? '') : null} onStart={() => start(p)} onReopen={reopen} onCancel={() => setPending(null)} />,
            // the ads sit next to Facebook: their own Facebook window when Pilotix has its configuration, and a key pasted by hand
            p === 'meta' && (
              <ProviderSlot key="ads" p="meta" part="ads" ready={d.apps.meta && d.adsReady} hideButton={!d.adsReady} preview={d.preview} pending={pending?.provider === 'meta' && pending.ads ? pending : null} busy={!!pending} done={done?.provider === 'meta' && done.ads ? (d.links.find((l) => l.id === done.linkId)?.name ?? '') : null} onStart={() => start('meta', true)} onReopen={reopen} onCancel={() => setPending(null)}>
                <AdsKeyBox onSaved={(linkId) => setOpenIds((prev) => new Set([...(prev ?? []), linkId]))} />
              </ProviderSlot>
            ),
            // WhatsApp too is Meta's, but a number is given in a window of its own
            p === 'meta' && <WhatsappSlot key="wa" d={d} busy={!!pending} />,
          ])}
        </div>
      </Card>

      <section className="cpt-list" aria-labelledby="cpt-list-h">
        <h2 id="cpt-list-h">{t(K + 'yours')}</h2>
        {!d.links.length ? (
          <p className="cpt-empty">{t(K + 'none')}</p>
        ) : (
          d.links.map((l) => {
            const isOpen = openIds ? openIds.has(l.id) : d.links.length === 1;
            const toggle = () =>
              setOpenIds((prev) => {
                const next = new Set(prev ?? (d.links.length === 1 ? [d.links[0].id] : []));
                if (next.has(l.id)) next.delete(l.id);
                else next.add(l.id);
                return next;
              });
            return <LinkCard key={l.id} l={l} d={d} fresh={done?.linkId === l.id} open={isOpen} onToggle={toggle} onRelink={() => start(l.provider, adsOnly(l) && d.adsReady)} busy={!!pending} />;
          })
        )}
      </section>
    </div>
  );
}

/**
 * What this boutique's agents use right now: its Page (messages, comments), its Meta and TikTok ad accounts, its
 * WhatsApp number. Below, the keys connected before somewhere else (Réglages › Meta Ads, Pilot Message): they still
 * work, and go when the Facebook account takes their place or the boutique removes them.
 */
function HereCard({ d }: { d: List }) {
  const { t } = useTranslation();
  const dropOld = useAction('social.dropOld', { success: t(K + 'old.removed') });
  const ads = (x: List['here']['ad_account'], none: string) => (x ? (x.count > 1 ? t(K + 'here.adsMany', { n: x.count, account: x.account }) : t(K + 'here.adsName', { name: x.name })) : t(K + none));
  // Publicité still on a key pasted before: it works (orange, not grey)
  const adsOld = !d.here.ad_account && !!d.old.ads;
  const rows: { key: string; label: string; state: 'ok' | 'old' | ''; value: string }[] = [
    {
      key: 'page',
      label: t(K + 'here.page'),
      state: d.here.page ? 'ok' : '',
      value: d.here.page ? (d.here.page.igUsername ? t(K + 'here.pageIg', { name: d.here.page.name, ig: d.here.page.igUsername }) : t(K + 'here.pageOnly', { name: d.here.page.name })) : t(K + 'here.noPage'),
    },
    { key: 'ads', label: t(K + 'here.ads'), state: d.here.ad_account ? 'ok' : adsOld ? 'old' : '', value: adsOld ? t(K + 'here.adsOld') : ads(d.here.ad_account, 'here.noAds') },
    { key: 'wa', label: t(K + 'here.wa'), state: d.whatsapp ? 'ok' : '', value: d.whatsapp ? d.whatsapp.phone || t(K + 'here.waId', { id: d.whatsapp.phoneId }) : t(K + 'here.noWa') },
    { key: 'tt', label: t(K + 'here.tiktok'), state: d.here.advertiser ? 'ok' : '', value: ads(d.here.advertiser, 'here.noTiktok') },
  ];
  // an old Instagram key may go only once the Facebook account's key can answer in its place (« Tester » or « Relier » says so)
  const old: { what: 'ads' | 'instagram'; text: string; hint: string; can: boolean }[] = [
    ...(d.old.ads ? [{ what: 'ads' as const, text: t(K + 'old.ads', { id: d.old.ads.adAccountId || '—' }), hint: t(K + 'old.adsHint'), can: true }] : []),
    ...(d.old.instagram
      ? [{ what: 'instagram' as const, text: t(K + 'old.ig', { user: d.old.instagram.username || '—' }), hint: t(K + (d.old.instagram.ready ? 'old.igHint' : 'old.igWait')), can: d.old.instagram.ready }]
      : []),
  ];
  return (
    <Card title={t(K + 'here.title', { name: d.shop.name })} className="cpt-here">
      <dl>
        {rows.map((r) => (
          <div key={r.key} className={r.state}>
            <dt>{r.label}</dt>
            <dd>
              <i className="cpt-dot" aria-hidden="true" />
              <bdi>{r.value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
      {old.length > 0 && (
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
      )}
    </Card>
  );
}

/** One way to link: Facebook (and Instagram) or TikTok; it shows the login on its way, then the green « linked ». */
function ProviderSlot({ p, part, ready, hideButton, preview, pending, busy, done, onStart, onReopen, onCancel, children }: { p: Provider; part?: 'content' | 'ads'; ready: boolean; hideButton?: boolean; preview: boolean; pending: Pending | null; busy: boolean; done: string | null; onStart: () => void; onReopen: () => void; onCancel: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  // Meta in two steps: the Pages and Instagram (part 'content'), the ads (part 'ads'); without a part, one login for all
  const base = K + (part === 'ads' ? 'p.metaAds' : part === 'content' ? 'p.metaContent' : `p.${p}`);
  const name = t(base + '.name');
  return (
    <div className={`cpt-slot ${pending ? 'wait' : ''} ${done !== null ? 'done' : ''}`} aria-live="polite">
      <div className="cpt-slot-id">
        <ProviderBadge p={p} />
        <div>
          <h3>{name}</h3>
          <p className="cpt-muted">{t(base + '.what')}</p>
          {/* what this login brings, at a glance */}
          {p === 'meta' && (
            <ul className="cpt-all" aria-label={t(K + 'p.meta.allLabel')}>
              {(t(base + '.all', { returnObjects: true }) as string[]).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {done !== null ? (
        <p className="cpt-slot-done">
          <Icon name="checkcircle" />
          <span>
            <b>{t(K + 'linked')}</b> {done && <bdi>{t(K + 'linkedName', { name: done })}</bdi>}
          </span>
        </p>
      ) : pending ? (
        <div className="cpt-slot-wait">
          <p>
            <span className="cpt-spin" aria-hidden="true" />
            <b>{pending.confirm ? t(K + 'confirmWait') : t(K + 'waiting')}</b>
          </p>
          <p className="cpt-muted">{preview ? t(K + 'waitingPreview') : pending.confirm ? t(K + 'confirmHelp', { name }) : pending.blocked ? t(K + 'blocked', { name }) : t(K + 'waitingHelp', { name })}</p>
          <div className="cpt-do">
            {pending.url && (
              <button type="button" className={`btn small ${pending.blocked ? 'primary' : 'ghost'}`} onClick={onReopen}>
                {pending.blocked ? t(K + 'open', { name }) : t(K + 'reopen')}
              </button>
            )}
            <button type="button" className="btn ghost small" onClick={onCancel}>
              {t(K + 'cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="cpt-do">
          {hideButton ? (
            // one login asks for everything: the first button brings the ads too
            <small className="cpt-muted cpt-fb-allow">{t(base + '.viaFirst')}</small>
          ) : (
            <>
              {/* read before pressing (Meta asks to tell the Page admin to allow the business assets); above, so the two buttons line up */}
              {p === 'meta' && ready && <small className="cpt-muted cpt-fb-allow">{t(base + '.allow')}</small>}
              {p === 'meta' ? (
                // Meta's login button rules: « Continue with Facebook » inside the button, white on Facebook blue, its logo first
                <button type="button" className="btn fb-btn" disabled={!ready || busy} onClick={onStart}>
                  {FB_LOGO && <img src={FB_LOGO} alt="" className="fb-btn-logo" />}
                  {t(K + 'p.meta.link')}
                </button>
              ) : (
                <button type="button" className="btn primary" disabled={!ready || busy} onClick={onStart}>
                  <Icon name="link" /> {t(K + `p.${p}.link`)}
                </button>
              )}
              {!ready && <small className="cpt-muted">{t(base + '.notReady')}</small>}
            </>
          )}
        </div>
      )}
      {children}
    </div>
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
 * « Connecter WhatsApp »: the boutique's WhatsApp number, in Meta's own window (Embedded Signup: the shop picks or makes
 * its WhatsApp Business account and its number). Meta's popup (its JavaScript SDK) is loaded before the click so it
 * opens on the click itself; without it (Meta's script blocked, the preview) a tab opens, asked about every two
 * seconds like the Facebook login. Pilotix keeps the key; the number answers in Pilot Message and sends the delivery
 * messages. Always for this boutique only.
 */
function WhatsappSlot({ d, busy }: { d: List; busy: boolean }) {
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
  return (
    <div className={`cpt-slot ${waiting ? 'wait' : ''}`} aria-live="polite">
      <div className="cpt-slot-id">
        <span className="dl-ch dl-whatsapp" aria-hidden="true">
          WA
        </span>
        <div>
          <h3>{t(K + 'wa.name')}</h3>
          <p className="cpt-muted">{t(K + 'wa.what')}</p>
        </div>
      </div>
      {waiting ? (
        <div className="cpt-slot-wait">
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
      ) : wa ? (
        <div className="cpt-do">
          <p className="cpt-wa-on">
            <Icon name="checkcircle" />
            <span>
              <b>
                <bdi dir="ltr">{wa.phone || t(K + 'here.waId', { id: wa.phoneId })}</bdi>
              </b>{' '}
              {t(K + 'wa.on')}
              {wa.old && <small>{t(K + 'wa.old')}</small>}
            </span>
          </p>
          <button type="button" className="btn ghost small" disabled={!d.waReady || busy} onClick={start}>
            <Icon name="refresh" /> {t(K + 'wa.again')}
          </button>
          <ConfirmButton className="btn ghost small danger" question={t(K + 'wa.removeAsk')} onConfirm={() => remove.mutate({})} disabled={remove.isPending}>
            <Icon name="unlink" /> {t(K + 'remove')}
          </ConfirmButton>
        </div>
      ) : (
        <div className="cpt-do">
          {d.waReady && <small className="cpt-muted cpt-fb-allow">{t(K + 'wa.allow')}</small>}
          <button type="button" className="btn primary" disabled={!d.waReady || busy} onClick={start}>
            <Icon name="whatsapp" /> {t(K + 'wa.link')}
          </button>
          {!d.waReady && <small className="cpt-muted">{t(K + 'wa.notReady')}</small>}
        </div>
      )}
    </div>
  );
}

/**
 * A linked account. Folded: who, its state, what this boutique uses from it, « Tester ». Open: the Page this boutique
 * answers on (picked in a list: one account often has dozens of Pages), its ad accounts (all counted here, or none),
 * what the last test found, then « Relier » and « Retirer ».
 */
function LinkCard({ l, d, fresh, open, onToggle, onRelink, busy }: { l: Link; d: List; fresh: boolean; open: boolean; onToggle: () => void; onRelink: () => void; busy: boolean }) {
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
  const summary = [page ? t(K + 'sumPage', { name: page.name }) : null, adsHere ? t(K + 'sumAds', { n: adList.length }) : null].filter(Boolean).join(' · ') || t(K + 'sumNone');
  const runTest = () => {
    if (!open) onToggle();
    test.mutate({ linkId: l.id });
  };
  const testBtn = (
    <button type="button" className="btn small" disabled={test.isPending} onClick={runTest}>
      <Icon name="pulse" /> {test.isPending ? t(K + 'testing') : t(K + 'test')}
    </button>
  );
  return (
    <article className={`cpt-link ${fresh ? 'fresh' : ''} ${open ? 'open' : ''}`} aria-label={l.name}>
      <header>
        <button type="button" className="cpt-fold" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <ProviderBadge p={l.provider} />
          <span className="cpt-link-id">
            <span className="cpt-link-name">
              <bdi>{l.name || t(K + `p.${l.provider}.name`)}</bdi>
            </span>
            <span className="cpt-link-sub">
              <span className={`cpt-st ${status.cls}`}>{status.text}</span>
              <span className="cpt-sum">
                <bdi>{summary}</bdi>
              </span>
            </span>
          </span>
          <Icon name="chevron" className="cpt-chev" />
        </button>
        <div className="cpt-do">
          {broken && (
            <button type="button" className="btn primary small" disabled={busy} onClick={onRelink}>
              <Icon name="refresh" /> {t(K + 'relink')}
            </button>
          )}
          {testBtn}
        </div>
      </header>
      {open && (
        <div id={bodyId} className="cpt-link-body">
          {broken && <p className="cpt-link-err">{l.error || t(K + 'relinkNow')}</p>}
          {/* an account that came for the ads alone (« Publicité Meta », a pasted key) has no Page to pick */}
          {l.provider === 'meta' && !(pages.length === 0 && adList.length > 0) && (
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
          {(result || test.isPending) && <TestLines r={result} pending={test.isPending} provider={l.provider} />}
          <footer>
            <span className="cpt-muted">{t(K + 'by', { by: l.by || '—', date: dateOnly(l.createdAt) })}</span>
            <span className="cpt-do">
              {d.canAll ? (
                <select className="cpt-scope-sel" aria-label={t(K + 'for')} value={l.scope} disabled={scope.isPending} onChange={(e) => scope.mutate({ linkId: l.id, scope: e.target.value as Scope })}>
                  <option value="here">{t(K + 'scopeHereOnly', { name: d.shop.name })}</option>
                  <option value="all">{t(K + 'scopeAllShort')}</option>
                </select>
              ) : (
                <span className="chip">{l.scope === 'all' ? t(K + 'scopeAllShort') : t(K + 'scopeHereOnly', { name: l.shopName ?? d.shop.name })}</span>
              )}
              {!broken && (
                <button type="button" className="btn ghost small" disabled={busy} onClick={onRelink} title={t(K + 'relinkHint')}>
                  <Icon name="refresh" /> {t(K + 'relink')}
                </button>
              )}
              {(l.scope === 'here' || d.isOwner) && (
                <ConfirmButton className="btn ghost small danger" question={t(K + 'removeAsk')} onConfirm={() => remove.mutate({ linkId: l.id })} disabled={remove.isPending}>
                  <Icon name="unlink" /> {t(K + 'remove')}
                </ConfirmButton>
              )}
            </span>
          </footer>
        </div>
      )}
    </article>
  );
}

const WORST: CheckState[] = ['bad', 'warn', 'info', 'ok'];
const worstOf = (list: Check[]): CheckState => WORST.find((s) => list.some((c) => c.state === s)) ?? 'ok';
const ICON: Record<CheckState, string> = { ok: 'checkcircle', warn: 'alert', bad: 'xcircle', info: 'info' };

/**
 * What « Tester » found, part by part (the key, the Page, Instagram, Publicité, the forms, the catalogue, the pixels,
 * WhatsApp, Pilotix's Meta app). The top says where the problems are; a part that works is folded to one green line,
 * a part with a problem is open. In a part, line by line: green works, orange to look at, red to fix, grey to know
 * (the platform's own words under a line).
 */
function TestLines({ r, pending, provider }: { r: TestResult | null; pending: boolean; provider: Provider }) {
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
