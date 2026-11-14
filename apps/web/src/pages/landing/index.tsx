// Landing pages: one public page per product (its address, colour, pictures, text), the orders customers abandoned
// (added to Commandes by themselves), the orders the fake-order check held back, and the settings (Meta pixel,
// automations). #/landing/pages/new/<product> opens the editor on a product; #/landing/voir/<slug> shows a page as the
// customer sees it.
import { LandingPreview } from './Preview';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, rpc, serverUrl, shopApi } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { usePagesBase } from '../../lib/pages';
import { useSession } from '../../lib/session';
import { copyText, Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { store } from '../../lib/store';
import { toast } from '../../ui/toast';
import { SectionHeader } from '../ai/agent';
import '../depot/produits.css';
import type { PageProps } from '../registry';
import { Abandoned } from './Abandoned';
import { Blocked } from './Blocked';
import { Editor } from './Editor';
import { Groups } from './Groups';
import { demoSubmit, useLandingFrame } from './frame';
import { Protection } from './Protection';
import { Settings } from './Settings';
import './landing.css';

const TABS = ['pages', 'groupes', 'protection', 'abandons', 'bloquees', 'reglages'] as const;
type Tab = (typeof TABS)[number];
const ICON: Record<Tab, string> = { pages: 'globe', groupes: 'grid', protection: 'shield', abandons: 'cart', bloquees: 'ban', reglages: 'settings' };
/** what agents (confirmation) see: the orders to handle and the attacks, not the pages */
const AGENT_TABS: Tab[] = ['protection', 'abandons', 'bloquees'];

/** the store's part of the pages' address (Réglages); undefined while it loads */
export const useStore = () => useRpc('landing.store', {}, { staleTime: 60_000 }).data?.store;
export { usePagesBase } from '../../lib/pages';

/** the address customers open: <pages' address>/<store>/<page> in real use, the in-app view in the demo */
export function publicUrl(slug: string, store: string | undefined, base: string = serverUrl()): string {
  return backend.kind === 'demo' ? `#/landing/voir/${slug}` : store ? `${base}/${store}/${slug}` : `${shopApi(serverUrl())}/lp/${slug}`;
}

export function Landing({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const canEdit = !!session && (session.isAdmin || session.roles.includes('marketer'));
  const allowed = TABS.filter((k) => canEdit || AGENT_TABS.includes(k));
  const tab: Tab = (allowed as readonly string[]).includes(sub ?? '') ? (sub as Tab) : allowed[0];
  const counts = useRpc('landing.counts', {});
  if (sub === 'voir' && rest?.[0]) return <Viewer key={rest.join('/')} slug={decodeURIComponent(rest[0])} group={rest[1] ? decodeURIComponent(rest[1]) : undefined} />;
  const arg = rest?.[0];
  if (tab === 'groupes' && arg) return <Groups edit={arg} />;
  if (tab === 'pages' && arg) return <Editor id={arg === 'new' ? null : Number(arg)} productId={arg === 'new' && rest?.[1] ? Number(rest[1]) : undefined} />;
  const tabs = allowed.map((k) => ({
    key: k,
    label: t(`landing.tabs.${k}`),
    icon: ICON[k],
    href: `#/landing/${k}`,
    count: k === 'bloquees' ? counts.data?.blocked : k === 'abandons' ? counts.data?.abandoned : k === 'pages' ? counts.data?.noPage : undefined,
    alert: k !== 'reglages' && k !== 'protection' && k !== 'groupes',
  }));
  return (
    <div className="pd lp">
      <SectionHeader icon="globe" title={t('landing.title')} help={t('landing.help')} about={t(`landing.about.${tab}`)} tabs={tabs} current={tab} aside={<AlertSwitch />} />
      {tab === 'pages' && <Pages />}
      {tab === 'groupes' && <Groups />}
      {tab === 'protection' && <Protection />}
      {tab === 'abandons' && <Abandoned />}
      {tab === 'bloquees' && <Blocked />}
      {tab === 'reglages' && <Settings />}
    </div>
  );
}

function Pages() {
  const { t } = useTranslation();
  const list = useRpc('landing.list', {});
  const store = useStore();
  const base = usePagesBase();
  const copy = async (slug: string) => {
    if (await copyText(backend.kind === 'demo' ? `${location.origin}${location.pathname}${publicUrl(slug, store, base)}` : publicUrl(slug, store, base))) toast(t('landing.copied'), 'ok');
  };
  const rows = list.data ?? [];
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  // a page deleted elsewhere: not chosen any more
  useEffect(() => {
    const ids = new Set(rows.map((p) => p.id));
    if ([...sel].some((x) => !ids.has(x))) setSel(new Set([...sel].filter((x) => ids.has(x))));
  }, [rows, sel]);
  const all = rows.length > 0 && rows.every((p) => sel.has(p.id));
  const flip = (id: number) => {
    const s = new Set(sel);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSel(s);
  };
  const title = (id: number) => {
    const p = rows.find((x) => x.id === id);
    return p ? p.title || p.productName : '';
  };
  // one page: its copy opens in the editor (offline) to be changed before going online; several: they stay in the list
  const duplicate = async (ids: number[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const made: number[] = [];
      for (const id of ids) made.push((await rpc('landing.duplicate', { id })).id);
      setSel(new Set());
      await list.refetch();
      if (made.length === 1) {
        toast(t('landing.list.duplicated'), 'ok');
        location.hash = `#/landing/pages/${made[0]}`;
      } else toast(t('landing.list.duplicatedN', { count: made.length }), 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
      list.refetch();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (ids: number[]) => {
    if (!ids.length || busy) return;
    if (!window.confirm(ids.length === 1 ? t('landing.list.removeAsk', { name: title(ids[0]) }) : t('landing.list.removeAskN', { count: ids.length }))) return;
    setBusy(true);
    let done = 0;
    try {
      for (const id of ids) {
        await rpc('landing.remove', { id });
        done++;
      }
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
      setSel(new Set());
      if (done) toast(t('landing.list.removed', { count: done }), 'ok');
      list.refetch();
    }
  };
  return (
    <>
      <Missing />
      <section className="card pd-card">
        <div className="pd-tools">
          <p className="pd-tools-t">{t('landing.list.count', { count: list.data?.length ?? 0 })}</p>
          <div className="pd-tools-a">
            <a className="btn primary" href="#/landing/pages/new">
              <Icon name="plus" /> {t('landing.list.new')}
            </a>
          </div>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data?.length ? (
          <Empty>{t('landing.list.empty')}</Empty>
        ) : (
          <>
            {sel.size > 0 && (
              <div className="bulkbar lp-bulk">
                <b>{t('landing.list.chosen', { count: sel.size })}</b>
                <span className="lp-bulk-sp" />
                <button type="button" className="btn small" disabled={busy} onClick={() => duplicate([...sel])}>
                  <Icon name="copy" /> {t('landing.list.duplicate')}
                </button>
                <button type="button" className="btn small lp-del" disabled={busy} onClick={() => remove([...sel])}>
                  <Icon name="trash" /> {t('landing.list.remove')}
                </button>
                <button type="button" className="btn small ghost" onClick={() => setSel(new Set())} aria-label={t('landing.list.clear')} title={t('landing.list.clear')}>
                  <Icon name="x" />
                </button>
              </div>
            )}
            <div className="tbl-wrap">
              <table className="tbl lp-tbl">
                <thead>
                  <tr>
                    <th className="ck">
                      <input type="checkbox" aria-label={t('landing.list.selectAll')} checked={all} ref={(el) => {
                        if (el) el.indeterminate = sel.size > 0 && !all;
                      }} onChange={() => setSel(all ? new Set() : new Set(rows.map((p) => p.id)))} />
                    </th>
                    <th>{t('landing.list.page')}</th>
                    <th>{t('landing.list.state')}</th>
                    <th className="num">{t('landing.list.views')}</th>
                    <th className="num">{t('landing.list.orders')}</th>
                    <th className="num" title={t('landing.list.convHelp')}>{t('landing.list.conv')}</th>
                    <th className="num">{t('landing.list.abandoned')}</th>
                    <th className="num">{t('landing.list.blocked')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className={sel.has(p.id) ? 'sel' : ''}>
                      <td className="ck">
                        <input type="checkbox" aria-label={t('landing.list.select')} checked={sel.has(p.id)} onChange={() => flip(p.id)} />
                      </td>
                      <td data-l={t('landing.list.page')}>
                        <a className="lp-row-p" href={`#/landing/pages/${p.id}`}>
                          <span className="lp-row-img" style={{ ['--lc' as string]: p.color }}>
                            {p.thumb ? <img src={p.thumb} alt="" loading="lazy" decoding="async" /> : <Icon name="image" />}
                          </span>
                          <span className="lp-row-t">
                            <b dir="auto">{p.title || p.productName}</b>
                            <code className="ltr">/{p.slug}</code>
                            {!p.active && <em className="lp-off-m">{t('landing.list.offline')}</em>}
                          </span>
                        </a>
                      </td>
                      <td data-l={t('landing.list.state')}>
                        <span className={`chip ${p.active ? 'lp-on' : ''}`}>{p.active ? t('landing.list.online') : t('landing.list.offline')}</span>
                      </td>
                      <td className="num" data-l={t('landing.list.views')}>
                        <b className="ltr">{n(p.views)}</b>
                      </td>
                      <td className="num" data-l={t('landing.list.orders')}>
                        <b className="ltr">{n(p.orders)}</b>
                      </td>
                      <td className={`num lp-conv ${p.conversion ? "" : "z"}`} data-l={t('landing.list.conv')} title={p.uniqueSince ? t('landing.list.convSince', { date: p.uniqueSince }) : t('landing.list.convNone')}>
                        <b className="ltr">{p.conversion == null ? '—' : `${p.conversion.toLocaleString(undefined, { maximumFractionDigits: 1 })} %`}</b>
                        {p.unique > 0 && <small className="ltr">{n(p.convOrders)} / {n(p.unique)}</small>}
                      </td>
                      <td className={`num ${p.abandoned ? 'warn' : ''}`} data-l={t('landing.list.abandoned')}>
                        <b className="ltr">{n(p.abandoned)}</b>
                      </td>
                      <td className={`num ${p.blocked ? 'bad' : ''}`} data-l={t('landing.list.blocked')}>
                        <b className="ltr">{n(p.blocked)}</b>
                      </td>
                      <td className="lp-row-a">
                        <a className="btn small lp-edit" title={t('landing.list.edit')} href={`#/landing/pages/${p.id}`}>
                          <Icon name="pencil" /> <span className="lp-edit-t">{t('landing.list.edit')}</span>
                        </a>
                        <a className="btn small icon lp-sec" href={publicUrl(p.slug, store, base)} target={backend.kind === 'demo' ? undefined : '_blank'} rel="noreferrer" aria-label={t('landing.list.open')} title={t('landing.list.open')}>
                          <Icon name="external" />
                        </a>
                        <button type="button" className="btn small icon lp-sec" onClick={() => copy(p.slug)} aria-label={t('landing.list.copy')} title={t('landing.list.copy')}>
                          <Icon name="link" />
                        </button>
                        <button type="button" className="btn small icon" disabled={busy} onClick={() => duplicate([p.id])} aria-label={t('landing.list.duplicate')} title={t('landing.list.duplicate')}>
                          <Icon name="copy" />
                        </button>
                        <button type="button" className="btn small icon lp-del" disabled={busy} onClick={() => remove([p.id])} aria-label={t('landing.list.remove')} title={t('landing.list.remove')}>
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

/** This device: a toast and a chime when an order arrives from a landing page (agents see it on every screen). */
function AlertSwitch() {
  const { t } = useTranslation();
  const [on, setOn] = useState(store.get('lp-sound') !== 'off');
  const flip = () => {
    store.set('lp-sound', on ? 'off' : null);
    setOn(!on);
  };
  return (
    <button type="button" className={`btn small lp-alert ${on ? 'on' : ''}`} onClick={flip} aria-pressed={on} title={t('landing.alertHelp')}>
      <Icon name={on ? 'sparkles' : 'x'} /> {on ? t('landing.alertOn') : t('landing.alertOff')}
    </button>
  );
}

/** Products on sale with no page yet (a new product appears here at once): one click makes its page. */
function Missing() {
  const { t } = useTranslation();
  const list = useRpc('landing.missing', {});
  const [busy, setBusy] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const ignore = useAction('landing.ignore', { success: t('landing.miss.ignored') });
  if (!list.data?.length) return null;
  const create = async (productId: number) => {
    setBusy(productId);
    try {
      const r = await rpc('landing.quickCreate', { productId });
      toast(t('landing.miss.created'), 'ok');
      location.hash = `#/landing/pages/${r.id}`;
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  const shown = all ? list.data : list.data.slice(0, 4);
  return (
    <section className="card lp-miss" aria-live="polite">
      <div className="lp-miss-h">
        <span className="lp-miss-i" aria-hidden="true">
          <Icon name="alert" />
        </span>
        <div>
          <h2>{t('landing.miss.title', { count: list.data.length })}</h2>
          <p className="pd-note">{t('landing.miss.help')}</p>
        </div>
      </div>
      <div className="lp-miss-l">
        {shown.map((p) => (
          <div key={p.id} className="lp-miss-r">
            <span className="pd-thumb" aria-hidden="true">
              {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <Icon name="package" />}
            </span>
            <span className="pd-name">
              <b>{p.name}</b>
              <small>
                <span className="ltr">{da(p.price)}</span>
                <span>{t('landing.miss.stock', { n: p.stock })}</span>
                <span>{t('landing.miss.added', { when: when(p.createdAt) })}</span>
              </small>
            </span>
            <span className="lp-miss-a">
              <button className="btn small primary" disabled={busy !== null} onClick={() => create(p.id)}>
                <Icon name="sparkles" /> {busy === p.id ? '…' : t('landing.miss.quick')}
              </button>
              <a className="btn small" href={`#/landing/pages/new/${p.id}`}>
                <Icon name="pencil" /> {t('landing.miss.custom')}
              </a>
              <button className="btn small ghost" disabled={ignore.isPending} onClick={() => ignore.mutate({ productId: p.id, on: true })} title={t('landing.miss.ignoreHelp')}>
                {t('landing.miss.ignore')}
              </button>
            </span>
          </div>
        ))}
      </div>
      {list.data.length > 4 && (
        <button className="btn small ghost" onClick={() => setAll(!all)}>
          {all ? t('landing.miss.less') : t('landing.miss.more', { count: list.data.length - 4 })}
        </button>
      )}
    </section>
  );
}

/** The page as the customer sees it, full screen (demo: the order goes through the demo database, fake-order check included). */
function Viewer({ slug, group }: { slug: string; group?: string }) {
  const { t } = useTranslation();
  const page = useRpc('landing.preview', { slug, group }, { refetchOnWindowFocus: false, staleTime: Infinity });
  // kept as first loaded: an order refreshes Pilotix's data, which must not reload the page under the thank-you screen
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (page.data && html === null) setHtml(page.data.html);
  }, [page.data, html]);
  const frame = useRef<HTMLIFrameElement>(null);
  // a group's product tapped: its page (with the « back » bar); the « back » bar: the group again
  useLandingFrame(frame, demoSubmit, (s, g) => {
    location.hash = g ? `#/landing/voir/${s}/${g}` : `#/landing/voir/${s}`;
  });
  return (
    <div className="lp-view">
      <div className="lp-view-bar">
        <a className="btn small" href="#/landing/pages">
          <Icon name="chevl" /> {t('landing.view.back')}
        </a>
        <span className="ltr">/{slug}</span>
        <span className="muted small">{t('landing.view.demo')}</span>
      </div>
      {page.error && html === null ? <ErrorBox error={page.error} /> : html === null ? <Loading /> : <LandingPreview frame={frame} title={slug} html={html} />}
    </div>
  );
}
