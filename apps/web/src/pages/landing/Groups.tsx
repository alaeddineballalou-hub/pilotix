// Landing pages › Groupes: one page with several products. The customer taps one; it opens that product's own landing
// page (« back to all the products » at its top). Five designs; in « best seller » the shop picks the product shown big.
import { GROUP_THEMES, GroupTheme, LANDING_COLORS, LANDING_DEFAULT_COLOR } from '@pilotix/shared';
import { ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc, serverUrl, shopApi } from '../../lib/backend';
import { n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { copyText, Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SaveBar } from '../ai/agent';
import { useDebounced } from '../depot/OrderList';
import { useLandingFrame } from './frame';
import { publicUrl, useStore } from './index';
import { PixelSelects } from './Pixels';

type Group = Out<'landing.groups'>[number];

/** a tiny drawing of each design (what the customer sees) */
function ThemeShape({ k }: { k: GroupTheme }) {
  const b = (x: number, y: number, w: number, h: number, key: string, strong = false) => <rect key={key} x={x} y={y} width={w} height={h} rx="2" className={strong ? 's' : ''} />;
  const shapes: Record<GroupTheme, ReactElement[]> = {
    grid: [b(4, 4, 18, 18, 'a'), b(26, 4, 18, 18, 'b'), b(4, 26, 18, 18, 'c'), b(26, 26, 18, 18, 'd')],
    big: [b(4, 4, 40, 18, 'a'), b(4, 26, 40, 18, 'b')],
    best: [b(4, 4, 40, 20, 'a', true), b(4, 28, 18, 16, 'b'), b(26, 28, 18, 16, 'c')],
    list: [b(4, 4, 10, 10, 'a'), b(17, 6, 27, 6, 'a2'), b(4, 18, 10, 10, 'b'), b(17, 20, 27, 6, 'b2'), b(4, 32, 10, 10, 'c'), b(17, 34, 27, 6, 'c2')],
    tabs: [b(4, 4, 40, 6, 'a'), b(4, 13, 10, 5, 't1', true), b(16, 13, 10, 5, 't2'), b(28, 13, 10, 5, 't3'), b(4, 22, 18, 22, 'c'), b(26, 22, 18, 22, 'd')],
  };
  return (
    <svg viewBox="0 0 48 48" className="lp-gshape" aria-hidden="true">
      {shapes[k]}
    </svg>
  );
}

export function Groups({ edit }: { edit?: string }) {
  if (edit) return <GroupEditor id={edit === 'new' ? null : Number(edit)} />;
  return <GroupList />;
}

function GroupList() {
  const { t } = useTranslation();
  const list = useRpc('landing.groups', {});
  const store = useStore();
  const copy = async (slug: string) => {
    if (await copyText(backend.kind === 'demo' ? `${location.origin}${location.pathname}${publicUrl(slug, store)}` : publicUrl(slug, store))) toast(t('landing.copied'), 'ok');
  };
  return (
    <section className="card pd-card">
      <div className="pd-tools">
        <p className="pd-tools-t">{t('landing.gr.count', { count: list.data?.length ?? 0 })}</p>
        <div className="pd-tools-a">
          <a className="btn primary" href="#/landing/groupes/new">
            <Icon name="plus" /> {t('landing.gr.new')}
          </a>
        </div>
      </div>
      <p className="pd-note">{t('landing.gr.help')}</p>
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data?.length ? (
        <Empty>{t('landing.gr.empty')}</Empty>
      ) : (
        <div className="lp-grid">
          {list.data.map((g) => (
            <article key={g.id} className="lp-tile" style={{ ['--lc' as string]: g.color }}>
              <a className="lp-tile-img lp-gtile" href={`#/landing/groupes/${g.id}`} aria-label={t('landing.list.edit')}>
                <span className="lp-gthumbs">
                  {g.items.slice(0, 4).map((x) => (x.thumb ? <img key={x.pageId} src={x.thumb} alt="" loading="lazy" /> : <span key={x.pageId} />))}
                </span>
                <span className={`chip ${g.active ? 'lp-on' : ''}`}>{g.active ? t('landing.list.online') : t('landing.list.offline')}</span>
              </a>
              <div className="lp-tile-b">
                <b dir="auto">{g.title}</b>
                <small>
                  {t(`landing.gr.theme.${g.theme}`)} · {t('landing.gr.nProducts', { count: g.items.length })}
                </small>
                <code className="ltr">/{g.slug}</code>
                <div className="lp-tile-n">
                  <span>
                    <b className="ltr">{n(g.views)}</b> {t('landing.list.views')}
                  </span>
                  <span>
                    <b className="ltr">{n(g.clicks)}</b> {t('landing.gr.clicks')}
                  </span>
                  <span>
                    <b className="ltr">{n(g.orders)}</b> {t('landing.list.orders')}
                  </span>
                </div>
                <div className="lp-tile-a">
                  <a className="btn small" href={`#/landing/groupes/${g.id}`}>
                    <Icon name="pencil" /> {t('landing.list.edit')}
                  </a>
                  <a className="btn small" href={publicUrl(g.slug, store)} target={backend.kind === 'demo' ? undefined : '_blank'} rel="noreferrer">
                    <Icon name="external" /> {t('landing.list.open')}
                  </a>
                  <button type="button" className="btn small" onClick={() => copy(g.slug)} aria-label={t('landing.list.copy')} title={t('landing.list.copy')}>
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

function GroupEditor({ id }: { id: number | null }) {
  const list = useRpc('landing.groups', {}, { refetchOnWindowFocus: false });
  if (list.isLoading) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={() => list.refetch()} />;
  const g = id ? list.data?.find((x) => x.id === id) ?? null : null;
  if (id && !g) return <ErrorBox error={new Error('Groupe introuvable')} />;
  return <Form key={id ?? 'new'} g={g} />;
}

const draftOf = (g: Group | null) => ({
  slug: g?.slug ?? '',
  active: g ? g.active : true,
  title: g?.title ?? '',
  subtitle: g?.subtitle ?? '',
  color: g?.color ?? LANDING_DEFAULT_COLOR,
  theme: (g?.theme ?? 'grid') as GroupTheme,
  bestPageId: g?.bestPageId ?? null,
  items: (g?.items ?? []).map((x) => ({ pageId: x.pageId, tab: x.tab, note: x.note })),
  pixelId: g?.pixelId ?? '',
  metaPixelRef: (g?.metaPixelRef ?? null) as number | null,
  tiktokPixelRef: (g?.tiktokPixelRef ?? null) as number | null,
});
type Draft = ReturnType<typeof draftOf>;

function Form({ g }: { g: Group | null }) {
  const { t } = useTranslation();
  const store = useStore();
  const pages = useRpc('landing.list', {});
  const [d, setD] = useState<Draft>(() => draftOf(g));
  const [saved, setSaved] = useState(() => JSON.stringify(draftOf(g)));
  const [slugTouched, setSlugTouched] = useState(!!g);
  const [add, setAdd] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(d) !== saved;
  const P = new Map((pages.data ?? []).map((p) => [p.id, p]));
  const stats = new Map((g?.items ?? []).map((x) => [x.pageId, x]));

  // a new group takes its title as address, until the address is typed by hand
  const title = useDebounced(d.title, 400);
  useEffect(() => {
    if (slugTouched || !title.trim()) return;
    let live = true;
    rpc('landing.groupSlug', { title, id: g?.id }).then((r) => live && set('slug', r.slug));
    return () => {
      live = false;
    };
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useAction('landing.groupSave', {
    success: t('landing.gr.saved'),
    onDone: (r) => {
      setSaved(JSON.stringify(d));
      if (!g) location.hash = `#/landing/groupes/${r.id}`;
    },
  });
  const submit = () => {
    if (!d.title.trim()) return toast(t('landing.gr.needTitle'), 'bad');
    if (!d.items.length) return toast(t('landing.gr.needProducts'), 'bad');
    save.mutate({ ...d, id: g?.id, title: d.title.trim(), subtitle: d.subtitle.trim(), slug: d.slug.trim(), bestPageId: d.theme === 'best' ? d.bestPageId : null });
  };
  const remove = async () => {
    if (!g || !window.confirm(t('landing.gr.removeAsk'))) return;
    await rpc('landing.groupRemove', { id: g.id });
    toast(t('landing.gr.removed'), 'ok');
    location.hash = '#/landing/groupes';
  };
  const move = (i: number, by: number) =>
    setD((x) => {
      const items = [...x.items];
      const j = i + by;
      if (j < 0 || j >= items.length) return x;
      [items[i], items[j]] = [items[j], items[i]];
      return { ...x, items };
    });
  const setItem = (i: number, patch: Partial<Draft['items'][number]>) => setD((x) => ({ ...x, items: x.items.map((it, k) => (k === i ? { ...it, ...patch } : it)) }));
  const free = (pages.data ?? []).filter((p) => !d.items.some((x) => x.pageId === p.id));

  // the preview: drawn by the server's own function, from what the form holds
  const view = useDebounced(d, 350);
  const [html, setHtml] = useState('');
  useEffect(() => {
    let live = true;
    rpc('landing.groupDraft', { ...view, title: view.title.trim() || t('landing.gr.titlePh'), slug: view.slug || 'groupe' })
      .then((r) => live && setHtml(r.html))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const frame = useRef<HTMLIFrameElement>(null);
  useLandingFrame(frame, undefined, () => toast(t('landing.gr.navHint'), 'ok'));

  return (
    <div className="pd lp">
      <div className="lp-ed-top">
        <a className="btn small" href="#/landing/groupes">
          <Icon name="chevl" /> {t('landing.gr.back')}
        </a>
        <h1 dir="auto">{g ? d.title || g.title : t('landing.gr.newTitle')}</h1>
        {g && (
          <a className="btn small" href={publicUrl(g.slug, store)} target={backend.kind === 'demo' ? undefined : '_blank'} rel="noreferrer">
            <Icon name="external" /> {t('landing.list.open')}
          </a>
        )}
      </div>
      <div className="lp-ed">
        <form
          className="lp-ed-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <section className="card">
            <h2>{t('landing.gr.sGroup')}</h2>
            <Field label={t('landing.gr.title')}>
              <input dir="auto" value={d.title} placeholder={t('landing.gr.titlePh')} maxLength={160} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <Field label={t('landing.gr.subtitle')} hint={t('landing.gr.subtitleHint')}>
              <input dir="auto" value={d.subtitle} placeholder={t('landing.gr.subtitlePh')} maxLength={300} onChange={(e) => set('subtitle', e.target.value)} />
            </Field>
            <Field label={t('landing.ed.slug')} hint={t('landing.gr.slugHint')}>
              <div className="lp-slug">
                <span className="ltr">{backend.kind === 'demo' ? '…/lp/' : (store ? `${serverUrl() || ''}/${store}/` : `${shopApi(serverUrl() || '')}/lp/`).replace(/^https?:\/\//, '')}</span>
                <input
                  className="ltr"
                  value={d.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                  }}
                />
              </div>
            </Field>
            <label className="check">
              <input type="checkbox" checked={d.active} onChange={(e) => set('active', e.target.checked)} />
              {t('landing.gr.active')}
            </label>
          </section>

          <section className="card">
            <h2>{t('landing.gr.sDesign')}</h2>
            <div className="lp-gthemes" role="radiogroup" aria-label={t('landing.gr.sDesign')}>
              {GROUP_THEMES.map((k) => (
                <label key={k} className={`lp-gtheme ${d.theme === k ? 'on' : ''}`}>
                  <input type="radio" name="theme" checked={d.theme === k} onChange={() => set('theme', k)} />
                  <ThemeShape k={k} />
                  <b>{t(`landing.gr.theme.${k}`)}</b>
                  <small>{t(`landing.gr.themeHelp.${k}`)}</small>
                </label>
              ))}
            </div>
            <Field label={t('landing.ed.color')}>
              <div className="lp-colors" role="radiogroup" aria-label={t('landing.ed.color')}>
                {LANDING_COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={c} className={`lp-sw ${d.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} />
                ))}
                <label className="lp-sw lp-sw-pick" title={t('landing.ed.colorOther')}>
                  <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} aria-label={t('landing.ed.colorOther')} />
                  <Icon name="pipette" />
                </label>
              </div>
            </Field>
          </section>

          <section className="card">
            <h2>{t('landing.gr.sProducts')}</h2>
            <p className="pd-note">{d.theme === 'best' ? t('landing.gr.bestHelp') : d.theme === 'tabs' ? t('landing.gr.tabsHelp') : t('landing.gr.productsHelp')}</p>
            {!pages.isLoading && !pages.data?.length && <p className="lp-warn-note">{t('landing.gr.noPages')}</p>}
            <ol className="lp-gitems">
              {d.items.map((it, i) => {
                const p = P.get(it.pageId);
                const st = stats.get(it.pageId);
                const best = d.theme === 'best' && (d.bestPageId ?? d.items[0]?.pageId) === it.pageId;
                return (
                  <li key={it.pageId} className={best ? 'best' : ''}>
                    <span className="pd-thumb" aria-hidden="true">
                      {p?.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <Icon name="image" />}
                    </span>
                    <span className="lp-gi-b">
                      <b dir="auto">{p ? p.title || p.productName : `#${it.pageId}`}</b>
                      <small>
                        <code className="ltr">/{p?.slug}</code>
                        {p && !p.active && <span className="chip">{t('landing.list.offline')}</span>}
                        {st && (
                          <span className="muted">
                            {t('landing.gr.itemStats', { clicks: n(st.clicks), orders: n(st.orders) })}
                          </span>
                        )}
                      </small>
                      {d.theme === 'best' && (
                        <label className="lp-gbest">
                          <input type="radio" name="best" checked={best} onChange={() => set('bestPageId', it.pageId)} /> ⭐ {t('landing.gr.best')}
                        </label>
                      )}
                      {d.theme === 'tabs' && <input dir="auto" className="lp-gi-in" value={it.tab} maxLength={40} placeholder={t('landing.gr.tabPh')} onChange={(e) => setItem(i, { tab: e.target.value })} />}
                      {(d.theme === 'big' || d.theme === 'best') && (
                        <input dir="auto" className="lp-gi-in" value={it.note} maxLength={120} placeholder={t('landing.gr.notePh')} onChange={(e) => setItem(i, { note: e.target.value })} />
                      )}
                    </span>
                    <span className="lp-gi-a">
                      <button type="button" className="btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('landing.gr.up')} title={t('landing.gr.up')}>
                        ↑
                      </button>
                      <button type="button" className="btn small ghost" disabled={i === d.items.length - 1} onClick={() => move(i, 1)} aria-label={t('landing.gr.down')} title={t('landing.gr.down')}>
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn small ghost danger"
                        onClick={() => setD((x) => ({ ...x, items: x.items.filter((_, k) => k !== i), bestPageId: x.bestPageId === it.pageId ? null : x.bestPageId }))}
                        aria-label={t('landing.gr.removeItem')}
                        title={t('landing.gr.removeItem')}
                      >
                        <Icon name="x" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
            {!!free.length && (
              <div className="lp-gadd">
                <select value={add} onChange={(e) => setAdd(e.target.value)} aria-label={t('landing.gr.add')}>
                  <option value="">{t('landing.gr.pick')}</option>
                  {free.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || p.productName} {p.active ? '' : `(${t('landing.list.offline')})`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={!add}
                  onClick={() => {
                    set('items', [...d.items, { pageId: Number(add), tab: '', note: '' }]);
                    setAdd('');
                  }}
                >
                  <Icon name="plus" /> {t('landing.gr.add')}
                </button>
                <button type="button" className="btn ghost" onClick={() => set('items', [...d.items, ...free.map((p) => ({ pageId: p.id, tab: '', note: '' }))])}>
                  {t('landing.gr.addAll', { count: free.length })}
                </button>
              </div>
            )}
          </section>

          <section className="card">
            <h2>{t('landing.gr.sPixel')}</h2>
            <PixelSelects meta={d.metaPixelRef} tiktok={d.tiktokPixelRef} onChange={(k, v) => setD((x) => ({ ...x, [k]: v, ...(k === 'metaPixelRef' ? { pixelId: '' } : {}) }))} />
          </section>

          <div className="lp-ed-foot">
            {g && (
              <button type="button" className="btn ghost danger" onClick={remove}>
                <Icon name="trash" /> {t('landing.gr.remove')}
              </button>
            )}
            <SaveBar dirty={dirty || !g} busy={save.isPending} disabled={!d.items.length || !d.title.trim()} onSave={submit} label={t('common.save')} />
          </div>
        </form>

        <aside className="lp-pv card">
          <div className="lp-pv-bar">
            <b>{t('landing.ed.preview')}</b>
            <span className="muted small">{t('landing.gr.previewHint')}</span>
          </div>
          <div className="lp-pv-box phone">{html ? <iframe ref={frame} title={t('landing.ed.preview')} srcDoc={html} sandbox="allow-scripts allow-forms" /> : <Loading />}</div>
        </aside>
      </div>
    </div>
  );
}
