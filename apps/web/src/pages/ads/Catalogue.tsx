// Marketing › Catalogue: the shop's products on the left, its lists on the right. A product dragged into a list (or added
// with its « + », on a phone or with the keyboard) joins it; dragged from one list to another, it moves. « Envoyer »
// sends the list to the shop's Meta catalog as a product set, picked when making a catalog ad, and to its TikTok catalog
// too when « Envoyer aussi à TikTok » is on (each list then says where it is). A product that cannot go says why (no
// page, a picture too small, refused) with the way to fix it. The pictures Meta and TikTok take are JPEG: the browser
// makes those copies by itself. « Résultats » (CatalogueResults.tsx, #/marketing/catalogue/resultats) says what the
// catalog ads brought and which colours / sizes left the ads because little is left. Everything is decided in core
// (metacatalog.*).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Results } from './CatalogueResults';
import './formulaires.css';
import './catalogue.css';

type Board = Out<'metacatalog.board'>;
type Product = Board['products'][number];
type List = Board['lists'][number];
type Drag = { productId: number; fromListId?: number };

const DRAG = 'application/x-pilotix-product';

export function Catalogue({ rest }: { rest?: string[] } = {}) {
  const { t } = useTranslation();
  const view = rest?.[0] === 'resultats' ? 'results' : 'lists';
  const q = useRpc('metacatalog.board', {}, { refetchInterval: 30_000 });
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const add = useAction('metacatalog.add');
  // the JPEG copies Meta takes, made here in the background (silent: tried again next time)
  const photo = useAction('metacatalog.photo', { silent: true });
  const d = q.data;
  useJpegCopies(d?.needJpeg ?? [], (imageId, jpeg) => photo.mutateAsync({ imageId, jpeg }));
  const products = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (d?.products ?? []).filter((p) => !s || p.name.toLowerCase().includes(s));
  }, [d, search]);
  if (q.error && !d) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const byId = new Map(d.products.map((p) => [p.id, p]));
  const drop = (listId: number, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    try {
      const x = JSON.parse(e.dataTransfer.getData(DRAG) || e.dataTransfer.getData('text/plain')) as Drag;
      if (x.productId && x.fromListId !== listId) add.mutate({ listId, productId: x.productId, ...(x.fromListId ? { fromListId: x.fromListId } : {}) });
    } catch {
      /* not one of ours */
    }
  };
  return (
    <div className="lf ct">
      <section className="lf-main ct-main" aria-labelledby="ct-title">
        <div className="lf-head">
          <h2 id="ct-title">{t('metacatalog.title')}</h2>
          <div className="px-vsw ct-views" role="tablist" aria-label={t('metacatalog.view.label')}>
            {(['lists', 'results'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={view === k}
                className={view === k ? 'on' : ''}
                onClick={() => (location.hash = k === 'results' ? '#/marketing/catalogue/resultats' : '#/marketing/catalogue')}
              >
                <Icon name={k === 'results' ? 'chart' : 'list'} />
                {t(`metacatalog.view.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <Networks d={d} />
        {!d.catalog.ready && !(d.tiktok.on && d.tiktok.linked) && (
          <div className="cp-warn ct-warn" role="note">
            <Icon name="alert" />
            <span>
              {t('metacatalog.ready')} <a href="#/comptes">{t('metacatalog.readyFix')}</a>
            </span>
          </div>
        )}
        {view === 'results' ? (
          <Results />
        ) : (
          <div className="ct-board">
            <aside className="ct-lib" aria-labelledby="ct-lib">
              <h3 id="ct-lib">{t('metacatalog.products')}</h3>
              <p className="lf-muted ct-small">{t('metacatalog.dragHint')}</p>
              <label className="ct-search">
                <Icon name="search" />
                <span className="sr-only">{t('metacatalog.search')}</span>
                <input type="search" value={search} placeholder={t('metacatalog.search')} onChange={(e) => setSearch(e.target.value)} />
              </label>
              <ul className="ct-items">
                {products.map((p) => (
                  <LibItem key={p.id} p={p} lists={d.lists} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />
                ))}
                {!products.length && <li className="lf-muted ct-small">{t('metacatalog.noProduct')}</li>}
              </ul>
            </aside>
            <div className="ct-cols">
              {d.lists.map((l) => (
                <Column
                  key={l.id}
                  l={l}
                  where={d.catalog.ready && d.tiktok.on && d.tiktok.linked ? 'both' : d.tiktok.on && d.tiktok.linked ? 'tiktok' : 'meta'}
                  nets={d.tiktok.on}
                  byId={byId}
                  over={over === l.id}
                  onOver={(on) => setOver(on ? l.id : over === l.id ? null : over)}
                  onDrop={(e) => drop(l.id, e)}
                />
              ))}
              <NewList />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- where the lists go: Meta, and TikTok when it is on
function Networks({ d }: { d: Board }) {
  const { t } = useTranslation();
  const sw = useAction('metacatalog.tiktok', {
    onDone: (r) => {
      if (r.error) toast(r.error, 'info', 6000);
      else toast(r.on ? t('metacatalog.tt.onDone', { count: r.sent }) : t('metacatalog.tt.offDone'), 'ok');
    },
  });
  const m = d.catalog;
  const k = d.tiktok;
  return (
    <div className="ct-nets">
      <div className="ct-net">
        <b className="ct-net-name">Meta</b>
        <span className="ct-net-facts">
          {m.connected ? (
            <span>
              {t('metacatalog.account')}{' '}
              <b>
                <bdi>{m.businessName || '—'}</bdi>
              </b>
            </span>
          ) : m.ready ? (
            <span>{t('metacatalog.notYet')}</span>
          ) : (
            <span>
              {t('metacatalog.notLinked')} <a href="#/comptes">{t('metacatalog.readyFix')}</a>
            </span>
          )}
          {m.connected && <span>{m.pixelsLinked ? t('metacatalog.pixelOn') : t('metacatalog.pixelOff')}</span>}
          {m.connected && <span className="ct-count">{t('metacatalog.articles', { count: d.articles, n: n(d.articles) })}</span>}
        </span>
      </div>
      <div className="ct-net">
        <b className="ct-net-name">TikTok</b>
        <span className="ct-net-facts">
          {!k.linked ? (
            <span>
              {t('metacatalog.notLinked')} <a href="#/comptes">{t('metacatalog.readyFix')}</a>
            </span>
          ) : !k.on ? (
            <span>{t('metacatalog.tt.off')}</span>
          ) : (
            <>
              {k.connected ? (
                <span>
                  {t('metacatalog.tt.bc')}{' '}
                  <b>
                    <bdi>{k.bcName || '—'}</bdi>
                  </b>
                </span>
              ) : (
                <span>{t('metacatalog.tt.notYet')}</span>
              )}
              {k.connected && <span>{k.pixelBound ? t('metacatalog.pixelOn') : t('metacatalog.pixelOff')}</span>}
              {k.connected && <span className="ct-count">{t('metacatalog.articles', { count: k.articles, n: n(k.articles) })}</span>}
            </>
          )}
        </span>
        {/* on but no longer linked: it can still be turned off */}
        {(k.linked || k.on) && (
          <label className="ct-net-switch">
            <span>{t('metacatalog.tt.switch')}</span>
            <button type="button" role="switch" className="lf-switch" aria-checked={k.on} disabled={sw.isPending} onClick={() => sw.mutate({ on: !k.on })}>
              <span aria-hidden="true" />
            </button>
          </label>
        )}
      </div>
      {k.error && (
        <div className="cp-warn ct-warn" role="note">
          <Icon name="alert" />
          <span>{k.error}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the products
function Thumb({ p, size = 40 }: { p: Product; size?: number }) {
  return p.thumb ? (
    <img className={`ct-thumb ${p.stock !== null && p.stock <= 0 ? 'out' : ''}`} src={p.thumb} alt="" width={size} height={size} style={{ width: size, height: size }} loading="lazy" />
  ) : (
    <span className="ct-thumb none" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="package" />
    </span>
  );
}

function problemLabel(p: Product, t: (k: string) => string): string | null {
  if (p.problem === 'nopage') return t('metacatalog.pb.nopage');
  if (p.problem === 'photo') return t('metacatalog.pb.photo');
  if (p.meta === 'error') return t('metacatalog.pb.meta');
  if (p.tiktok === 'error') return t('metacatalog.pb.tiktok');
  if (p.preparing) return t('metacatalog.pb.preparing');
  return null;
}
/** Something to fix before the product can go (or Meta / TikTok refused it). */
const isBad = (p: Product) => !!p.problem || p.meta === 'error' || p.tiktok === 'error';
/** Out of the ads because little (or nothing) is left: all of it, or some colours / sizes (« Résultats » says which). */
function hiddenLabel(p: Product, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (!p.hidden) return null;
  if (p.hidden < p.variants) return t('metacatalog.res.st.some', { count: p.hidden, total: p.variants });
  return t(p.stock === 0 ? 'metacatalog.res.st.out' : 'metacatalog.res.st.low');
}
function HiddenHint({ p }: { p: Product }) {
  const { t } = useTranslation();
  const h = hiddenLabel(p, t);
  return h ? (
    <small className="ct-hidhint">
      <Icon name="eyeoff" />
      {h}
    </small>
  ) : null;
}

function LibItem({ p, lists, open, onToggle }: { p: Product; lists: List[]; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const add = useAction('metacatalog.add', { success: t('metacatalog.added') });
  const page = useAction('landing.quickCreate', { success: t('metacatalog.pageMade') });
  const pb = problemLabel(p, t);
  const bad = isBad(p);
  return (
    <li
      className={`ct-item ${bad ? 'ct-bad' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG, JSON.stringify({ productId: p.id }));
        e.dataTransfer.setData('text/plain', JSON.stringify({ productId: p.id }));
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
    >
      <div className="ct-row">
        <span className="ct-grip" aria-hidden="true">
          <Icon name="grip" />
        </span>
        <Thumb p={p} />
        <span className="ct-name">
          <b>
            <bdi>{p.name}</bdi>
          </b>
          <span>
            <span className="ltr">{da(p.price)}</span>
            {p.oldPrice && <s className="ltr">{da(p.oldPrice)}</s>}
          </span>
          {pb && <small className={bad ? 'warn' : ''}>{pb}</small>}
          {!bad && <HiddenHint p={p} />}
        </span>
        <button type="button" className="ct-plus" aria-expanded={open} aria-label={t('metacatalog.addTo', { name: p.name })} onClick={onToggle}>
          <Icon name="plus" />
        </button>
      </div>
      {open && (
        <div className="ct-menu">
          {bad && p.problemText && <p className="ct-why">{p.problemText}</p>}
          {p.problem === 'nopage' && (
            <button type="button" className="lf-btn primary" disabled={page.isPending} onClick={() => page.mutate({ productId: p.id })}>
              <Icon name="plus" />
              {t('metacatalog.makePage')}
            </button>
          )}
          {p.problem === 'photo' && p.slug && (
            <a className="lf-btn" href="#/landing">
              {t('metacatalog.changePhoto')}
            </a>
          )}
          <span className="lf-muted ct-small">{t('metacatalog.addToList')}</span>
          <div className="ct-choices">
            {lists.map((l) => {
              const inIt = p.lists.includes(l.id);
              return (
                <button key={l.id} type="button" className={`ct-choice ${inIt ? 'on' : ''}`} disabled={inIt || add.isPending} onClick={() => add.mutate({ listId: l.id, productId: p.id })}>
                  {inIt && <Icon name="check" />}
                  <bdi>{l.name}</bdi>
                </button>
              );
            })}
            {!lists.length && <span className="lf-muted ct-small">{t('metacatalog.noList')}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- a list
type Where = 'meta' | 'tiktok' | 'both';

function Column({
  l,
  where,
  nets,
  byId,
  over,
  onOver,
  onDrop,
}: {
  l: List;
  /** where « Envoyer » sends the list */
  where: Where;
  /** TikTok is on: the list says where it is */
  nets: boolean;
  byId: Map<number, Product>;
  over: boolean;
  onOver: (on: boolean) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const remove = useAction('metacatalog.remove');
  const send = useAction('metacatalog.send', {
    onDone: (r) => {
      const to = t(`metacatalog.where.${r.meta && r.tiktok && !r.tiktok.error ? 'both' : r.meta ? 'meta' : 'tiktok'}`);
      toast(r.blocked.length ? t('metacatalog.sentSome', { count: r.ready, blocked: r.blocked.length }) : t('metacatalog.sentAll', { count: r.ready, where: to }), r.blocked.length ? 'info' : 'ok');
      // TikTok said no: its reason (Meta's sending went on)
      if (r.tiktok?.error) toast(r.tiktok.error, 'info', 6000);
    },
  });
  const auto = useAction('metacatalog.listAuto');
  const del = useAction('metacatalog.listRemove', { success: t('metacatalog.removed') });
  const rename = useAction('metacatalog.listSave');
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(l.name);
  const depth = useRef(0);
  const prods = l.productIds.map((x) => byId.get(x)).filter((x): x is Product => !!x);
  const primary = l.state === 'new' || l.state === 'changed';
  return (
    <section
      className={`ct-col ${over ? 'over' : ''}`}
      aria-label={l.name}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        onOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) onOver(false);
      }}
      onDrop={(e) => {
        depth.current = 0;
        onDrop(e);
      }}
    >
      <div className="ct-col-head">
        {editing ? (
          <form
            className="ct-rename"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate({ id: l.id, name: name.trim() }, { onSuccess: () => setEditing(false) });
            }}
          >
            <input value={name} maxLength={80} aria-label={t('metacatalog.listName')} autoFocus onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="lf-btn" disabled={name.trim().length < 2 || rename.isPending}>
              {t('metacatalog.ok')}
            </button>
          </form>
        ) : (
          <>
            <b>
              <bdi>{l.name}</bdi>
            </b>
            <span className="ct-n ltr">{prods.length}</span>
            <button type="button" className="ct-more" aria-expanded={menu} aria-label={t('metacatalog.listMenu', { name: l.name })} onClick={() => setMenu(!menu)}>
              <Icon name="more" />
            </button>
          </>
        )}
      </div>
      {menu && !editing && (
        <div className="ct-colmenu">
          <button
            type="button"
            className="lf-link"
            onClick={() => {
              setMenu(false);
              setName(l.name);
              setEditing(true);
            }}
          >
            <Icon name="pencil" />
            {t('metacatalog.rename')}
          </button>
          <label className="ct-auto">
            <span>
              <b>{t('metacatalog.auto')}</b>
              <small>{t('metacatalog.autoHint')}</small>
            </span>
            <button type="button" role="switch" className="lf-switch" aria-checked={l.autoUpdate} aria-label={t('metacatalog.auto')} disabled={auto.isPending} onClick={() => auto.mutate({ id: l.id, on: !l.autoUpdate })}>
              <span aria-hidden="true" />
            </button>
          </label>
          <button type="button" className="lf-link mute" disabled={del.isPending} onClick={() => window.confirm(t('metacatalog.removeAsk', { name: l.name })) && del.mutate({ id: l.id })}>
            {t('metacatalog.remove')}
          </button>
        </div>
      )}
      <ul className="ct-in">
        {prods.map((p) => {
          const bad = isBad(p);
          return (
            <li
              key={p.id}
              className={bad ? 'ct-bad' : ''}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG, JSON.stringify({ productId: p.id, fromListId: l.id }));
                e.dataTransfer.setData('text/plain', JSON.stringify({ productId: p.id, fromListId: l.id }));
                e.dataTransfer.effectAllowed = 'move';
              }}
              title={bad ? (p.problemText ?? undefined) : undefined}
            >
              <Thumb p={p} size={32} />
              <span className="ct-name">
                <bdi>{p.name}</bdi>
                {bad ? <small className="warn">{problemLabel(p, t)}</small> : <HiddenHint p={p} />}
              </span>
              {bad && (
                <span className="ct-alert" aria-hidden="true">
                  <Icon name="alert" />
                </span>
              )}
              <button type="button" className="ct-x" aria-label={t('metacatalog.takeOut', { name: p.name })} disabled={remove.isPending} onClick={() => remove.mutate({ listId: l.id, productId: p.id })}>
                <Icon name="x" />
              </button>
            </li>
          );
        })}
        {!prods.length && <li className="ct-drop">{t('metacatalog.dropHere')}</li>}
        {over && prods.length > 0 && <li className="ct-drop on">{t('metacatalog.dropNow')}</li>}
      </ul>
      <div className="ct-col-foot">
        <State l={l} />
        {nets && (l.metaState || l.tiktokState) && (
          <span className="ct-chips">
            {l.metaState && <Chip name="Meta" state={l.metaState} />}
            {l.tiktokState && <Chip name="TikTok" state={l.tiktokState} />}
          </span>
        )}
        <button type="button" className={`lf-btn ${primary ? 'primary' : ''}`} disabled={send.isPending || !prods.length} onClick={() => send.mutate({ id: l.id })}>
          <Icon name="send" />
          {send.isPending ? t('metacatalog.sending') : t(where === 'both' ? 'metacatalog.sendBoth' : where === 'tiktok' ? 'metacatalog.sendTt' : 'metacatalog.send')}
        </button>
        {l.sentAt && <small className="lf-muted">{t('metacatalog.sentAt', { when: when(l.sentAt) })}</small>}
      </div>
    </section>
  );
}

function State({ l }: { l: List }) {
  const { t } = useTranslation();
  const tone = l.state === 'ok' ? 'ok' : l.state === 'fix' ? 'warn' : l.state === 'pending' ? 'info' : 'mute';
  return <span className={`lf-tag ${tone}`}>{t(`metacatalog.state.${l.state}`, { count: l.fix })}</span>;
}

/** One catalog the list is in, with its state as a dot (and in words for screen readers and on hover). */
function Chip({ name, state }: { name: string; state: NonNullable<List['metaState']> }) {
  const { t } = useTranslation();
  const label = t('metacatalog.chip', { name, state: t(`metacatalog.net.${state}`) });
  return (
    <span className={`ct-chip ${state}`} title={label}>
      <i aria-hidden="true" />
      <span aria-hidden="true">{name}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function NewList() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const save = useAction('metacatalog.listSave', { success: t('metacatalog.made') });
  if (!open)
    return (
      <button type="button" className="ct-new" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        {t('metacatalog.newList')}
      </button>
    );
  return (
    <form
      className="ct-col ct-newform"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { name: name.trim() },
          {
            onSuccess: () => {
              setName('');
              setOpen(false);
            },
          },
        );
      }}
    >
      <label className="lf-field">
        <span>{t('metacatalog.listName')}</span>
        <input value={name} maxLength={80} autoFocus placeholder={t('metacatalog.listNamePh')} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="ct-newbtns">
        <button type="button" className="lf-btn" onClick={() => setOpen(false)}>
          {t('metacatalog.cancel')}
        </button>
        <button type="submit" className="lf-btn primary" disabled={name.trim().length < 2 || save.isPending}>
          {t('metacatalog.create')}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the JPEG copies Meta takes
/** Turns the pictures the catalog needs into JPEG, one after the other, in the background (once each). */
function useJpegCopies(list: { id: number; url: string | null }[], save: (imageId: number, jpeg: string) => Promise<unknown>) {
  const busy = useRef(new Set<number>());
  const key = list.map((x) => x.id).join(',');
  useEffect(() => {
    let stop = false;
    (async () => {
      for (const x of list) {
        if (stop || !x.url || busy.current.has(x.id)) continue;
        busy.current.add(x.id);
        try {
          const jpeg = await toJpeg(x.url);
          if (jpeg) await save(x.id, jpeg);
        } catch {
          /* tried again on the next visit */
        }
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

async function toJpeg(url: string): Promise<string | null> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d');
  if (!g) return null;
  // JPEG has no transparency: a white background
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0);
  return c.toDataURL('image/jpeg', 0.92).replace(/^data:[^,]+,/, '');
}
