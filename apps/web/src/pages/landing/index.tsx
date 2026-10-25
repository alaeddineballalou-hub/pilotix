// Landing pages: one public page per product (its address, colour, pictures, text), the orders customers abandoned
// (added to Commandes by themselves), the orders the fake-order check held back, and the settings (Meta pixel,
// automations). #/landing/pages/new/<product> opens the editor on a product; #/landing/voir/<slug> shows a page as the
// customer sees it.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, rpc, serverUrl } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
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
import { demoSubmit, useLandingFrame } from './frame';
import { Settings } from './Settings';
import './landing.css';

const TABS = ['pages', 'abandons', 'bloquees', 'reglages'] as const;
type Tab = (typeof TABS)[number];
const ICON: Record<Tab, string> = { pages: 'globe', abandons: 'cart', bloquees: 'ban', reglages: 'settings' };
/** what agents (confirmation) see: the orders to handle, not the pages */
const AGENT_TABS: Tab[] = ['abandons', 'bloquees'];

/** the address customers open: the server's page in real use, the in-app view in the demo */
export function publicUrl(slug: string): string {
  return backend.kind === 'demo' ? `#/landing/voir/${slug}` : `${serverUrl()}/api/lp/${slug}`;
}

export function Landing({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const canEdit = !!session && (session.isAdmin || session.roles.includes('marketer'));
  const allowed = TABS.filter((k) => canEdit || AGENT_TABS.includes(k));
  const tab: Tab = (allowed as readonly string[]).includes(sub ?? '') ? (sub as Tab) : allowed[0];
  const counts = useRpc('landing.counts', {});
  if (sub === 'voir' && rest?.[0]) return <Viewer slug={decodeURIComponent(rest[0])} />;
  const arg = rest?.[0];
  if (tab === 'pages' && arg) return <Editor id={arg === 'new' ? null : Number(arg)} productId={arg === 'new' && rest?.[1] ? Number(rest[1]) : undefined} />;
  const tabs = allowed.map((k) => ({
    key: k,
    label: t(`landing.tabs.${k}`),
    icon: ICON[k],
    href: `#/landing/${k}`,
    count: k === 'bloquees' ? counts.data?.blocked : k === 'abandons' ? counts.data?.abandoned : k === 'pages' ? counts.data?.noPage : undefined,
    alert: k !== 'reglages',
  }));
  return (
    <div className="pd lp">
      <SectionHeader icon="globe" title={t('landing.title')} help={t('landing.help')} about={t(`landing.about.${tab}`)} tabs={tabs} current={tab} aside={<AlertSwitch />} />
      {tab === 'pages' && <Pages />}
      {tab === 'abandons' && <Abandoned />}
      {tab === 'bloquees' && <Blocked />}
      {tab === 'reglages' && <Settings />}
    </div>
  );
}

function Pages() {
  const { t } = useTranslation();
  const list = useRpc('landing.list', {});
  const copy = async (slug: string) => {
    if (await copyText(backend.kind === 'demo' ? `${location.origin}${location.pathname}${publicUrl(slug)}` : publicUrl(slug))) toast(t('landing.copied'), 'ok');
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
          <div className="lp-grid">
            {list.data.map((p) => (
              <article key={p.id} className="lp-tile" style={{ ['--lc' as string]: p.color }}>
                <a className="lp-tile-img" href={`#/landing/pages/${p.id}`} aria-label={t('landing.list.edit')}>
                  {p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <Icon name="image" />}
                  <span className={`chip ${p.active ? 'lp-on' : ''}`}>{p.active ? t('landing.list.online') : t('landing.list.offline')}</span>
                </a>
                <div className="lp-tile-b">
                  <b dir="auto">{p.title || p.productName}</b>
                  <small>{p.productName}</small>
                  <code className="ltr">/{p.slug}</code>
                  <div className="lp-tile-n">
                    <span>
                      <b className="ltr">{n(p.views)}</b> {t('landing.list.views')}
                    </span>
                    <span>
                      <b className="ltr">{n(p.orders)}</b> {t('landing.list.orders')}
                    </span>
                    <span className={p.abandoned ? 'warn' : ''}>
                      <b className="ltr">{n(p.abandoned)}</b> {t('landing.list.abandoned')}
                    </span>
                    <span className={p.blocked ? 'bad' : ''}>
                      <b className="ltr">{n(p.blocked)}</b> {t('landing.list.blocked')}
                    </span>
                  </div>
                  <div className="lp-tile-a">
                    <a className="btn small" href={`#/landing/pages/${p.id}`}>
                      <Icon name="pencil" /> {t('landing.list.edit')}
                    </a>
                    <a className="btn small" href={publicUrl(p.slug)} target={backend.kind === 'demo' ? undefined : '_blank'} rel="noreferrer">
                      <Icon name="external" /> {t('landing.list.open')}
                    </a>
                    <button type="button" className="btn small" onClick={() => copy(p.slug)} aria-label={t('landing.list.copy')} title={t('landing.list.copy')}>
                      <Icon name="copy" />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
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
function Viewer({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const page = useRpc('landing.preview', { slug }, { refetchOnWindowFocus: false, staleTime: Infinity });
  // kept as first loaded: an order refreshes Pilotix's data, which must not reload the page under the thank-you screen
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (page.data && html === null) setHtml(page.data.html);
  }, [page.data, html]);
  const frame = useRef<HTMLIFrameElement>(null);
  useLandingFrame(frame, demoSubmit);
  return (
    <div className="lp-view">
      <div className="lp-view-bar">
        <a className="btn small" href="#/landing/pages">
          <Icon name="chevl" /> {t('landing.view.back')}
        </a>
        <span className="ltr">/{slug}</span>
        <span className="muted small">{t('landing.view.demo')}</span>
      </div>
      {page.error && html === null ? <ErrorBox error={page.error} /> : html === null ? <Loading /> : <iframe ref={frame} title={slug} srcDoc={html} sandbox="allow-scripts allow-forms" />}
    </div>
  );
}
