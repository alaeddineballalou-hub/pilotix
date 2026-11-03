// Pilot AI › Comptes: the boutique's Facebook and TikTok accounts. « Lier » opens Facebook's (or TikTok's) login in a new
// tab; the person logs in and accepts there, Pilotix does the rest on its server, and this page turns green (it asks
// every two seconds). An account serves this boutique (its first Page and ad account are used at once) or all the
// owner's boutiques (each boutique picks its Page and its ad account in one click). The tokens never come to a page
// (packages/core/src/modules/social.ts).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { dateOnly } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { ConfirmButton } from '../admin/bits';
import { SectionHeader } from '../ai/agent';
import type { PageProps } from '../registry';
import '../messages/messages.css';
import './comptes.css';

type List = Out<'social.list'>;
type Link = List['links'][number];
type Asset = Link['assets'][number];
type Provider = Link['provider'];
type Kind = Asset['kind'];
type Scope = 'here' | 'all';
const PROVIDERS: Provider[] = ['meta', 'tiktok'];
const KINDS: Record<Provider, Kind[]> = { meta: ['page', 'ad_account'], tiktok: ['advertiser'] };
const K = 'comptes.';

/** A login in its tab: started here, asked about every two seconds until it is back. */
interface Pending {
  provider: Provider;
  state: string;
  url: string | null;
  win: Window | null;
  blocked: boolean;
}

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
  const [done, setDone] = useState<{ provider: Provider; linkId: number | null } | null>(null);
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
          setDone({ provider: pending.provider, linkId: r.linkId });
          await q.refetch();
          return;
        }
        if (r.status === 'error' || r.status === 'expired') {
          setPending(null);
          toast(r.error ?? t(K + 'expired'), 'bad');
          return;
        }
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

  const start = async (provider: Provider) => {
    if (pending) return;
    // the tab opens now, on the click (a tab opened after waiting for the server is blocked by browsers)
    const win = d.preview ? null : window.open('', '_blank');
    try {
      const r = await rpc('social.start', { provider, scope: d.canAll ? scope : 'here' });
      if (r.url && win && !win.closed) win.location.href = r.url;
      setDone(null);
      setPending({ provider, state: r.state, url: r.url, win, blocked: !!r.url && (!win || win.closed) });
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
        <div className="cpt-providers">
          {PROVIDERS.map((p) => (
            <ProviderSlot key={p} p={p} ready={d.apps[p]} preview={d.preview} pending={pending?.provider === p ? pending : null} busy={!!pending} done={done?.provider === p ? (d.links.find((l) => l.id === done.linkId)?.name ?? '') : null} onStart={() => start(p)} onReopen={reopen} onCancel={() => setPending(null)} />
          ))}
        </div>
      </Card>

      <section className="cpt-list" aria-labelledby="cpt-list-h">
        <h2 id="cpt-list-h">{t(K + 'yours')}</h2>
        {!d.links.length ? (
          <p className="cpt-empty">{t(K + 'none')}</p>
        ) : (
          d.links.map((l) => <LinkCard key={l.id} l={l} d={d} fresh={done?.linkId === l.id} onRelink={() => start(l.provider)} busy={!!pending} />)
        )}
      </section>
    </div>
  );
}

/** What this boutique's agents use right now: its Page (messages, comments), its Meta and TikTok ad accounts. */
function HereCard({ d }: { d: List }) {
  const { t } = useTranslation();
  const rows: { key: string; label: string; ok: boolean; value: string }[] = [
    {
      key: 'page',
      label: t(K + 'here.page'),
      ok: !!d.here.page,
      value: d.here.page ? (d.here.page.igUsername ? t(K + 'here.pageIg', { name: d.here.page.name, ig: d.here.page.igUsername }) : t(K + 'here.pageOnly', { name: d.here.page.name })) : t(K + 'here.noPage'),
    },
    { key: 'ads', label: t(K + 'here.ads'), ok: !!d.here.ad_account, value: d.here.ad_account ? t(K + 'here.adsName', { name: d.here.ad_account.name }) : t(K + 'here.noAds') },
    { key: 'tt', label: t(K + 'here.tiktok'), ok: !!d.here.advertiser, value: d.here.advertiser ? t(K + 'here.adsName', { name: d.here.advertiser.name }) : t(K + 'here.noTiktok') },
  ];
  return (
    <Card title={t(K + 'here.title', { name: d.shop.name })} className="cpt-here">
      <dl>
        {rows.map((r) => (
          <div key={r.key} className={r.ok ? 'ok' : ''}>
            <dt>{r.label}</dt>
            <dd>
              <i className="cpt-dot" aria-hidden="true" />
              <bdi>{r.value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** One way to link: Facebook (and Instagram) or TikTok; it shows the login on its way, then the green « linked ». */
function ProviderSlot({ p, ready, preview, pending, busy, done, onStart, onReopen, onCancel }: { p: Provider; ready: boolean; preview: boolean; pending: Pending | null; busy: boolean; done: string | null; onStart: () => void; onReopen: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const name = t(K + `p.${p}.name`);
  return (
    <div className={`cpt-slot ${pending ? 'wait' : ''} ${done !== null ? 'done' : ''}`} aria-live="polite">
      <div className="cpt-slot-id">
        <ProviderBadge p={p} />
        <div>
          <h3>{name}</h3>
          <p className="cpt-muted">{t(K + `p.${p}.what`)}</p>
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
            <b>{t(K + 'waiting')}</b>
          </p>
          <p className="cpt-muted">{preview ? t(K + 'waitingPreview') : pending.blocked ? t(K + 'blocked', { name }) : t(K + 'waitingHelp', { name })}</p>
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
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={onStart}>
            <Icon name="link" /> {t(K + `p.${p}.link`)}
          </button>
          {!ready && <small className="cpt-muted">{t(K + `p.${p}.notReady`)}</small>}
        </div>
      )}
    </div>
  );
}

/** A linked account: who, for which boutiques, its state, its Pages and ad accounts (each one used here in one click). */
function LinkCard({ l, d, fresh, onRelink, busy }: { l: Link; d: List; fresh: boolean; onRelink: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const scope = useAction('social.scope', { success: t(K + 'scopeSaved') });
  const remove = useAction('social.remove', { success: t(K + 'removed') });
  const status =
    l.status === 'ok'
      ? { cls: 'ok', text: t(K + 'st.ok') }
      : l.status === 'soon'
        ? { cls: 'warn', text: t(K + 'st.soon', { date: dateOnly(l.expiresAt) }) }
        : l.status === 'expired'
          ? { cls: 'bad', text: t(K + 'st.expired') }
          : { cls: 'bad', text: t(K + 'st.error') };
  return (
    <article className={`cpt-link ${fresh ? 'fresh' : ''}`} aria-label={l.name}>
      <header>
        <ProviderBadge p={l.provider} />
        <div className="cpt-link-id">
          <h3>
            <bdi>{l.name || t(K + `p.${l.provider}.name`)}</bdi>
          </h3>
          <p>
            <span className={`cpt-st ${status.cls}`}>{status.text}</span>
            {d.canAll ? (
              <select className="cpt-scope-sel" aria-label={t(K + 'for')} value={l.scope} disabled={scope.isPending} onChange={(e) => scope.mutate({ linkId: l.id, scope: e.target.value as Scope })}>
                <option value="here">{t(K + 'scopeHereOnly', { name: d.shop.name })}</option>
                <option value="all">{t(K + 'scopeAllShort')}</option>
              </select>
            ) : (
              <span className="chip">{l.scope === 'all' ? t(K + 'scopeAllShort') : t(K + 'scopeHereOnly', { name: l.shopName ?? d.shop.name })}</span>
            )}
          </p>
        </div>
        <div className="cpt-do">
          <button type="button" className="btn ghost small" disabled={busy} onClick={onRelink} title={t(K + 'relinkHint')}>
            <Icon name="refresh" /> {t(K + 'relink')}
          </button>
          {(l.scope === 'here' || d.isOwner) && (
            <ConfirmButton className="btn ghost small danger" question={t(K + 'removeAsk')} onConfirm={() => remove.mutate({ linkId: l.id })} disabled={remove.isPending}>
              <Icon name="unlink" /> {t(K + 'remove')}
            </ConfirmButton>
          )}
        </div>
      </header>
      {l.status !== 'ok' && l.status !== 'soon' && <p className="cpt-link-err">{l.error || t(K + 'relinkNow')}</p>}
      {KINDS[l.provider].map((kind) => {
        const list = l.assets.filter((a) => a.kind === kind);
        return (
          <section key={kind} className="cpt-assets">
            <h4>{t(K + `kind.${kind}`)}</h4>
            {!list.length ? (
              <p className="cpt-muted">{t(K + `kind.${kind}None`)}</p>
            ) : (
              <ul>
                {list.map((a) => (
                  <AssetRow key={a.id} a={a} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <footer className="cpt-muted">{t(K + 'by', { by: l.by || '—', date: dateOnly(l.createdAt) })}</footer>
    </article>
  );
}

function AssetRow({ a }: { a: Asset }) {
  const { t } = useTranslation();
  const use = useAction('social.use', { success: t(K + 'used') });
  const unuse = useAction('social.unuse', { success: t(K + 'unused') });
  const other = a.usedBy[0];
  return (
    <li className={a.usedHere ? 'here' : ''}>
      <div className="cpt-asset-id">
        <bdi className="cpt-asset-name">{a.name}</bdi>
        {a.igUsername && <span className="cpt-ig">{t(K + 'ig', { ig: a.igUsername })}</span>}
        {a.currency && <span className="cpt-muted ltr">{a.currency}</span>}
        {a.noHook && <span className="cpt-warn">{t(K + 'noHook')}</span>}
      </div>
      <div className="cpt-asset-do">
        {a.usedHere ? (
          <>
            <span className="cpt-here-tag">
              <Icon name="check" /> {t(K + 'usedHere')}
            </span>
            <button type="button" className="btn ghost small" disabled={unuse.isPending} onClick={() => unuse.mutate({ kind: a.kind })}>
              {t(K + 'stop')}
            </button>
          </>
        ) : (
          <>
            {other && a.kind === 'page' ? (
              <span className="cpt-muted">{t(K + 'usedThere', { name: other.name })}</span>
            ) : (
              <>
                {other && <span className="cpt-muted">{t(K + 'usedThere', { name: a.usedBy.map((x) => x.name).join(', ') })}</span>}
                <button type="button" className="btn small" disabled={use.isPending} onClick={() => use.mutate({ assetId: a.id })}>
                  {t(K + 'use')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </li>
  );
}
