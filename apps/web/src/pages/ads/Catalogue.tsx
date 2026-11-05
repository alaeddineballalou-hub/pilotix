// Marketing › Catalogue: the shop's products on the left, its lists on the right. A product dragged into a list (or added
// with its « + », on a phone or with the keyboard) joins it; dragged from one list to another, it moves. « Envoyer à
// Meta » sends the list to the shop's Meta catalog as a product set, picked when making a catalog ad. A product that
// cannot go says why (no page, a picture too small) with the way to fix it. The pictures Meta takes are JPEG: the
// browser makes those copies by itself. Everything is decided in core (metacatalog.*).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import './formulaires.css';
import './catalogue.css';

type Board = Out<'metacatalog.board'>;
type Product = Board['products'][number];
type List = Board['lists'][number];
type Drag = { productId: number; fromListId?: number };

const DRAG = 'application/x-pilotix-product';

export function Catalogue() {
  const { t } = useTranslation();
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
        </div>
        <p className="ct-top">
          <span>
            <Icon name="user" />
            {d.catalog.connected ? (
              <>
                {t('metacatalog.account')} <b>{d.catalog.businessName || '—'}</b>
              </>
            ) : (
              t('metacatalog.notYet')
            )}
          </span>
          {d.catalog.connected && (
            <span>
              <Icon name="check" />
              {d.catalog.pixelsLinked ? t('metacatalog.pixelOn') : t('metacatalog.pixelOff')}
            </span>
          )}
          <span>
            <Icon name="layers" />
            {t('metacatalog.counts', { lists: d.lists.length, articles: n(d.articles) })}
          </span>
        </p>
        {!d.catalog.ready && (
          <div className="cp-warn ct-warn" role="note">
            <Icon name="alert" />
            <span>
              {t('metacatalog.ready')} <a href="#/comptes">{t('metacatalog.readyFix')}</a>
            </span>
          </div>
        )}
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
                byId={byId}
                over={over === l.id}
                onOver={(on) => setOver(on ? l.id : over === l.id ? null : over)}
                onDrop={(e) => drop(l.id, e)}
              />
            ))}
            <NewList />
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- the products
function Thumb({ p, size = 40 }: { p: Product; size?: number }) {
  return p.thumb ? (
    <img className={`ct-thumb ${p.stock <= 0 ? 'out' : ''}`} src={p.thumb} alt="" width={size} height={size} style={{ width: size, height: size }} loading="lazy" />
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
  if (p.preparing) return t('metacatalog.pb.preparing');
  return null;
}

function LibItem({ p, lists, open, onToggle }: { p: Product; lists: List[]; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const add = useAction('metacatalog.add', { success: t('metacatalog.added') });
  const page = useAction('landing.quickCreate', { success: t('metacatalog.pageMade') });
  const pb = problemLabel(p, t);
  const bad = !!p.problem || p.meta === 'error';
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
function Column({ l, byId, over, onOver, onDrop }: { l: List; byId: Map<number, Product>; over: boolean; onOver: (on: boolean) => void; onDrop: (e: React.DragEvent) => void }) {
  const { t } = useTranslation();
  const remove = useAction('metacatalog.remove');
  const send = useAction('metacatalog.send', {
    onDone: (r) => {
      toast(r.blocked.length ? t('metacatalog.sentSome', { count: r.ready, blocked: r.blocked.length }) : t('metacatalog.sentAll', { count: r.ready }), r.blocked.length ? 'info' : 'ok');
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
          const bad = !!p.problem || p.meta === 'error';
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
                {bad && <small className="warn">{problemLabel(p, t)}</small>}
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
        <button type="button" className={`lf-btn ${primary ? 'primary' : ''}`} disabled={send.isPending || !prods.length} onClick={() => send.mutate({ id: l.id })}>
          <Icon name="send" />
          {send.isPending ? t('metacatalog.sending') : t('metacatalog.send')}
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
