// Pilot AI › Comptes: the boutique's Facebook and TikTok accounts. « Lier » opens Facebook's (or TikTok's) login in a new
// tab; the person logs in and accepts there, Pilotix does the rest on its server, and this page turns green (it asks
// every two seconds). An account serves this boutique (its first Page and ad account are used at once) or all the
// owner's boutiques (each boutique picks its Page and its ad account in one click). The tokens never come to a page
// (packages/core/src/modules/social.ts).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { clock, dateOnly, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { ConfirmButton, Switch } from '../admin/bits';
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
type TestResult = Out<'social.test'>;
const PROVIDERS: Provider[] = ['meta', 'tiktok'];
/** each provider's ad accounts (a boutique counts all of a linked account's together) */
const AD_KIND: Record<Provider, Kind> = { meta: 'ad_account', tiktok: 'advertiser' };
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
          d.links.map((l) => {
            const isOpen = openIds ? openIds.has(l.id) : d.links.length === 1;
            const toggle = () =>
              setOpenIds((prev) => {
                const next = new Set(prev ?? (d.links.length === 1 ? [d.links[0].id] : []));
                if (next.has(l.id)) next.delete(l.id);
                else next.add(l.id);
                return next;
              });
            return <LinkCard key={l.id} l={l} d={d} fresh={done?.linkId === l.id} open={isOpen} onToggle={toggle} onRelink={() => start(l.provider)} busy={!!pending} />;
          })
        )}
      </section>
    </div>
  );
}

/** What this boutique's agents use right now: its Page (messages, comments), its Meta and TikTok ad accounts. */
function HereCard({ d }: { d: List }) {
  const { t } = useTranslation();
  const ads = (x: List['here']['ad_account'], none: string) => (x ? (x.count > 1 ? t(K + 'here.adsMany', { n: x.count, account: x.account }) : t(K + 'here.adsName', { name: x.name })) : t(K + none));
  const rows: { key: string; label: string; ok: boolean; value: string }[] = [
    {
      key: 'page',
      label: t(K + 'here.page'),
      ok: !!d.here.page,
      value: d.here.page ? (d.here.page.igUsername ? t(K + 'here.pageIg', { name: d.here.page.name, ig: d.here.page.igUsername }) : t(K + 'here.pageOnly', { name: d.here.page.name })) : t(K + 'here.noPage'),
    },
    { key: 'ads', label: t(K + 'here.ads'), ok: !!d.here.ad_account, value: ads(d.here.ad_account, 'here.noAds') },
    { key: 'tt', label: t(K + 'here.tiktok'), ok: !!d.here.advertiser, value: ads(d.here.advertiser, 'here.noTiktok') },
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
          {l.provider === 'meta' && (
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

/** What « Tester » found, line by line: green works, orange to look at, red to fix (the platform's own words under it). */
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
  const todo = r.checks.filter((c) => c.state !== 'ok').length;
  const time = clock(r.at);
  return (
    <section className={`cpt-test ${pending ? 'again' : ''}`} aria-live="polite">
      <h4>
        <span>{t(K + 'testTitle', { time })}</span>
        <span className={`cpt-st ${todo ? 'warn' : 'ok'}`}>{todo ? t(K + 'testTodo', { n: todo }) : t(K + 'testAll')}</span>
      </h4>
      <ul>
        {r.checks.map((c, i) => {
          const key = c.key === 'token' && provider === 'tiktok' ? 'tokenTiktok' : c.key;
          const v =
            c.key === 'pageHook' && c.params?.fixed
              ? 'fixed'
              : c.key === 'reach' && c.params?.why === 'cloudflare'
                ? 'cloudflare'
                : c.key === 'igSeen' && c.params?.lost
                  ? 'lost'
                  : c.key === 'igSeen' && c.params?.why
                    ? String(c.params.why)
                    : c.state;
          const { count, at, ...rest } = c.params ?? {};
          return (
            <li key={`${c.key}-${i}`} className={c.state}>
              <Icon name={c.state === 'ok' ? 'checkcircle' : c.state === 'warn' ? 'alert' : 'xcircle'} />
              <span>
                <bdi>{t(K + `check.${key}.${v}`, { ...rest, n: count ?? '', when: at ? when(String(at)) : '', defaultValue: c.key })}</bdi>
                {c.detail && <small>{c.detail}</small>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
