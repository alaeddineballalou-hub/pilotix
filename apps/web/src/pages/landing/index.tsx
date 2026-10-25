// Landing pages: one public page per product (its address, colour, pictures, text) and the orders the fake-order check
// held back. Tabs: Pages (list → editor) · Commandes bloquées. #/landing/voir/<slug> shows a page as the customer sees it.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, serverUrl } from '../../lib/backend';
import { n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { copyText, Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SectionHeader } from '../ai/agent';
import '../depot/produits.css';
import type { PageProps } from '../registry';
import { Blocked } from './Blocked';
import { Editor } from './Editor';
import { demoSubmit, useLandingFrame } from './frame';
import './landing.css';

const TABS = ['pages', 'bloquees'] as const;
type Tab = (typeof TABS)[number];

/** the address customers open: the server's page in real use, the in-app view in the demo */
export function publicUrl(slug: string): string {
  return backend.kind === 'demo' ? `#/landing/voir/${slug}` : `${serverUrl()}/api/lp/${slug}`;
}

export function Landing({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const canEdit = !!session && (session.isAdmin || session.roles.includes('marketer'));
  const tab: Tab = sub === 'bloquees' || !canEdit ? 'bloquees' : 'pages';
  const counts = useRpc('landing.counts', {});
  if (sub === 'voir' && rest?.[0]) return <Viewer slug={decodeURIComponent(rest[0])} />;
  const arg = rest?.[0];
  if (tab === 'pages' && arg) return <Editor id={arg === 'new' ? null : Number(arg)} />;
  const tabs = TABS.filter((k) => canEdit || k === 'bloquees').map((k) => ({
    key: k,
    label: t(`landing.tabs.${k}`),
    icon: k === 'pages' ? 'globe' : 'ban',
    href: `#/landing/${k}`,
    count: k === 'bloquees' ? counts.data?.blocked : undefined,
    alert: k === 'bloquees',
  }));
  return (
    <div className="pd lp">
      <SectionHeader icon="globe" title={t('landing.title')} help={t('landing.help')} about={t(`landing.about.${tab}`)} tabs={tabs} current={tab} />
      {tab === 'pages' ? <Pages /> : <Blocked />}
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
