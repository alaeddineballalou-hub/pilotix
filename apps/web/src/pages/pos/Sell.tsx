// Point de vente › Vendre: the products as a grid of photos (search by name, code or barcode, « Packs », « Stock bas »)
// and the ticket beside it (quantities, packs, the customer, the payment, « Encaisser »). On a phone the grid takes the
// screen and the ticket opens from the bar at the bottom. A ticket can wait (« Mettre en attente ») on this device.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { store } from '../../lib/store';
import { useIsPhone } from '../../lib/useMedia';
import { ScoreChip } from '../../ui/clientScore';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { printTicket } from './ticket';
import { caisseName, CartLine, fold, initials, LOW, METHOD_ICON, POS_METHODS, PosCustomer, PosMethod, PosProduct, PosSale, PosState, priced, PricedLine, variantsOf } from './shared';

type Parked = { id: string; at: number; lines: CartLine[]; customer: PosCustomer | null };
type Filter = 'all' | 'packs' | 'low';
const PARKED = 'pos-parked';

export function Sell() {
  const q = useRpc('pos.state', {});
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  return <Counter st={q.data} />;
}

function Counter({ st }: { st: PosState }) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const by = useMemo(() => variantsOf(st.products), [st.products]);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [method, setMethod] = useState<PosMethod>('cash');
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [done, setDone] = useState<PosSale | null>(null);
  const [pick, setPick] = useState<PosProduct | null>(null);
  const [asking, setAsking] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [parked, setParked] = useState<Parked[]>(() => store.json<Parked[]>(PARKED, []));
  const keepParked = (p: Parked[]) => {
    setParked(p);
    store.set(PARKED, p.length ? JSON.stringify(p) : null);
  };
  const cart = useMemo(() => priced(lines, by), [lines, by]);
  const inCart = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of lines) {
      const p = by.get(l.variantId)?.p.id;
      if (p) m.set(p, (m.get(p) ?? 0) + l.qty);
    }
    return m;
  }, [lines, by]);

  const add = (variantId: number, qty = 1) => {
    setDone(null);
    setLines((ls) => (ls.some((l) => l.variantId === variantId) ? ls.map((l) => (l.variantId === variantId ? { ...l, qty: Math.min(999, l.qty + qty) } : l)) : [...ls, { variantId, qty }]));
  };
  const setQty = (variantId: number, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.variantId !== variantId) : ls.map((l) => (l.variantId === variantId ? { ...l, qty: Math.min(999, qty) } : l))));
  const clear = () => {
    setLines([]);
    setCustomer(null);
    setMethod('cash');
  };
  const choose = (p: PosProduct) => (p.variants.length === 1 ? add(p.variants[0].id) : setPick(p));

  const sell = useAction('pos.sell', {
    onDone: (sale) => {
      setDone(sale);
      clear();
      if (st.ticket.autoPrint) printTicket(sale, st.ticket);
    },
  });
  const pay = () => sell.mutate({ lines, method, customerId: customer?.id ?? null });
  const park = () => {
    if (!lines.length) return;
    keepParked([{ id: String(Date.now()), at: Date.now(), lines, customer }, ...parked].slice(0, 10));
    clear();
  };
  const resume = (p: Parked) => {
    const rest = parked.filter((x) => x.id !== p.id);
    keepParked(lines.length ? [{ id: String(Date.now()), at: Date.now(), lines, customer }, ...rest] : rest);
    setDone(null);
    setLines(p.lines.filter((l) => by.has(l.variantId)));
    setCustomer(p.customer);
  };

  const ticket = (
    <Ticket
      st={st}
      cart={cart}
      customer={customer}
      method={method}
      done={done}
      busy={sell.isPending}
      parked={parked}
      onQty={setQty}
      onMethod={setMethod}
      onPay={pay}
      onPark={park}
      onClear={clear}
      onResume={resume}
      onCustomer={() => setAsking(true)}
      onNoCustomer={() => setCustomer(null)}
      onNew={() => setDone(null)}
      onBack={phone ? () => setTicketOpen(false) : undefined}
    />
  );
  return (
    <div className={`pos-sell ${phone ? 'is-phone' : ''}`}>
      {phone && ticketOpen ? (
        ticket
      ) : (
        <>
          <Products st={st} inCart={inCart} onChoose={choose} onAdd={add} />
          {!phone && ticket}
          {phone && (
            <div className="pos-bar" role="region" aria-label={t('pos.sell.ticket')}>
              <span className="pos-bar-sum">
                <small>
                  {done && !lines.length ? t('pos.sell.doneShort', { no: done.no }) : t('pos.sell.items', { count: cart.items })}
                  {cart.saved > 0 && ` · ${t('pos.sell.packLess', { v: da(cart.saved) })}`}
                </small>
                <b className="ltr">{da(cart.total)}</b>
              </span>
              <button type="button" className="btn primary pos-bar-go" onClick={() => setTicketOpen(true)}>
                {t('pos.sell.seeTicket')}
                <Icon name="arrow" className="pos-flip" />
              </button>
            </div>
          )}
        </>
      )}
      {pick && (
        <VariantPick
          p={pick}
          onPick={(v) => {
            add(v);
            setPick(null);
          }}
          onClose={() => setPick(null)}
        />
      )}
      {asking && (
        <CustomerAsk
          onPick={(c) => {
            setCustomer(c);
            setAsking(false);
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the products
function Products({ st, inCart, onChoose, onAdd }: { st: PosState; inCart: Map<number, number>; onChoose: (p: PosProduct) => void; onAdd: (variantId: number) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const box = useRef<HTMLInputElement>(null);
  const phone = useIsPhone();
  // a computer: the cursor waits in the search box, so a barcode scanner (it types the code, then Enter) adds straight away
  useEffect(() => {
    if (!phone) box.current?.focus();
  }, [phone]);
  const words = fold(text.trim());
  const list = st.products.filter((p) => {
    if (filter === 'packs' && !p.packs.length) return false;
    if (filter === 'low' && !p.variants.some((v) => v.stock <= LOW)) return false;
    if (!words) return true;
    const hay = fold([p.name, p.sku, p.barcode ?? '', ...p.variants.map((v) => `${v.title} ${v.sku}`)].join(' '));
    return words.split(/\s+/).every((w) => hay.includes(w));
  });
  /** Enter: a code typed or scanned whole (barcode, product or variant code) goes on the ticket */
  const enter = () => {
    const code = text.trim().toLowerCase();
    if (!code) return;
    for (const p of st.products) {
      const v = p.variants.find((x) => x.sku.toLowerCase() === code);
      if (v) return (onAdd(v.id), setText(''));
      if ((p.barcode ?? '').toLowerCase() === code || p.sku.toLowerCase() === code) return (onChoose(p), setText(''));
    }
    if (list.length === 1) {
      onChoose(list[0]);
      setText('');
    }
  };
  const chips: { k: Filter; label: string }[] = [
    { k: 'all', label: t('pos.sell.all') },
    { k: 'packs', label: t('pos.sell.packs') },
    { k: 'low', label: t('pos.sell.low') },
  ];
  return (
    <section className="card pos-products" aria-label={t('pos.sell.products')}>
      <div className="pos-find">
        <label className="pos-search">
          <Icon name="scanbar" />
          <span className="pos-vh">{t('pos.sell.search')}</span>
          <input ref={box} type="search" value={text} placeholder={t('pos.sell.search')} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), enter())} enterKeyHint="search" />
        </label>
        <div className="pos-chips" role="group" aria-label={t('pos.sell.filter')}>
          {chips.map((c) => (
            <button key={c.k} type="button" className={`pos-chip ${filter === c.k ? 'on' : ''}`} aria-pressed={filter === c.k} onClick={() => setFilter(c.k)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {list.length ? (
        <div className="pos-grid">
          {list.map((p) => (
            <Tile key={p.id} p={p} n={inCart.get(p.id) ?? 0} onClick={() => onChoose(p)} />
          ))}
        </div>
      ) : (
        <Empty>{st.products.length ? t('pos.sell.none') : t('pos.sell.noProducts')}</Empty>
      )}
    </section>
  );
}

function Photo({ src, name, size }: { src: string | null; name: string; size?: 'tile' | 'line' }) {
  return (
    <span className={`pos-photo ${size === 'line' ? 'line' : ''}`} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" /> : <b>{initials(name)}</b>}
    </span>
  );
}

function Tile({ p, n: count, onClick }: { p: PosProduct; n: number; onClick: () => void }) {
  const { t } = useTranslation();
  const stock = p.variants.reduce((s, v) => s + v.stock, 0);
  const prices = [...new Set(p.variants.map((v) => v.price))];
  const pack = p.packs[0];
  const low = p.variants.some((v) => v.stock <= LOW);
  const label = `${p.name}${count ? ` · ${t('pos.sell.onTicket', { count })}` : ''}`;
  return (
    <button type="button" className={`pos-tile ${count ? 'on' : ''}`} onClick={onClick} aria-label={label}>
      {count > 0 && <span className="pos-tile-n ltr">{count}</span>}
      <Photo src={p.photo ?? p.variants.find((v) => v.photo)?.photo ?? null} name={p.name} />
      <b className="pos-tile-name">{p.name}</b>
      <span className="pos-tile-price">
        <b className="ltr">{prices.length > 1 ? t('pos.sell.from', { v: da(Math.min(...prices)) }) : da(prices[0])}</b>
        {pack && <span className="pos-pill ok">{t('pos.sell.packOf', { qty: pack.qty, v: da(pack.price) })}</span>}
      </span>
      {stock <= 0 ? (
        <span className="pos-pill bad">{t('pos.sell.out')}</span>
      ) : low && p.variants.length === 1 ? (
        <span className="pos-pill warn">{t('pos.sell.left', { count: stock })}</span>
      ) : (
        <span className="pos-tile-stock">
          {p.variants.length > 1 && `${t('pos.sell.choices', { count: p.variants.length })} · `}
          {t('pos.sell.inStock', { count: stock })}
          {low && p.variants.length > 1 && <span className="pos-dot" title={t('pos.sell.someLow')} />}
        </span>
      )}
    </button>
  );
}

function VariantPick({ p, onPick, onClose }: { p: PosProduct; onPick: (variantId: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal sheet title={p.name} onClose={onClose} className="pos-modal">
      <p className="muted pos-modal-lead">{t('pos.sell.pickVariant')}</p>
      <div className="pos-variants">
        {p.variants.map((v) => (
          <button key={v.id} type="button" className="pos-variant" onClick={() => onPick(v.id)}>
            <Photo src={v.photo ?? p.photo} name={v.title || p.name} size="line" />
            <span className="pos-variant-t">
              <b>{v.title || p.name}</b>
              <small className={v.stock <= 0 ? 'bad' : v.stock <= LOW ? 'warn' : ''}>{v.stock <= 0 ? t('pos.sell.out') : t('pos.sell.inStock', { count: v.stock })}</small>
            </span>
            <b className="ltr">{da(v.price)}</b>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the ticket
type TicketProps = {
  st: PosState;
  cart: ReturnType<typeof priced>;
  customer: PosCustomer | null;
  method: PosMethod;
  done: PosSale | null;
  busy: boolean;
  parked: Parked[];
  onQty: (variantId: number, qty: number) => void;
  onMethod: (m: PosMethod) => void;
  onPay: () => void;
  onPark: () => void;
  onClear: () => void;
  onResume: (p: Parked) => void;
  onCustomer: () => void;
  onNoCustomer: () => void;
  onNew: () => void;
  onBack?: () => void;
};

function Ticket(p: TicketProps) {
  const { t } = useTranslation();
  const { st, cart } = p;
  const empty = !cart.rows.length;
  return (
    <aside className="card pos-ticket" aria-label={t('pos.sell.ticket')}>
      <div className="pos-ticket-head">
        {p.onBack && (
          <button type="button" className="btn ghost pos-back" onClick={p.onBack}>
            <Icon name="chevl" className="pos-flip" />
            {t('pos.sell.backProducts')}
          </button>
        )}
        <h2>{t('pos.sell.ticket')}</h2>
        <span className="muted ltr">{t('pos.sell.saleNo', { no: st.next })}</span>
        <span className="pos-grow" />
        {p.customer ? (
          <span className="pos-who">
            <button type="button" className="btn pos-who-b" onClick={p.onCustomer} title={p.customer.phone}>
              <Icon name="user" />
              <span className="pos-ell">{p.customer.name}</span>
              {p.customer.level && <ScoreChip s={{ score: p.customer.score ?? 0, level: p.customer.level }} short />}
            </button>
            <button type="button" className="btn ghost pos-x" aria-label={t('pos.sell.noCustomer')} title={t('pos.sell.noCustomer')} onClick={p.onNoCustomer}>
              <Icon name="x" />
            </button>
          </span>
        ) : (
          <button type="button" className="btn" onClick={p.onCustomer}>
            <Icon name="user" />
            {t('pos.sell.walkIn')}
          </button>
        )}
      </div>
      {!st.session && (
        <p className="pos-note">
          <Icon name="info" />
          <span>
            {t('pos.sell.closedDrawer')} <a href="#/pos/cloture">{t('pos.sell.openWithFloat')}</a>
          </span>
        </p>
      )}
      {/* the lines scroll; the totals and « Encaisser » stay in view */}
      <div className="pos-ticket-body">
        {p.done && empty ? (
          <Done sale={p.done} st={st} onNew={p.onNew} />
        ) : empty ? (
          <div className="pos-empty">
            <Icon name="cart" />
            <p>{t('pos.sell.empty')}</p>
          </div>
        ) : (
          <ul className="pos-lines">
            {cart.rows.map((r) => (
              <Line key={r.variantId} r={r} onQty={(q) => p.onQty(r.variantId, q)} />
            ))}
          </ul>
        )}
        {p.parked.length > 0 && (
          <div className="pos-parked">
            <b>{t('pos.sell.waiting', { count: p.parked.length })}</b>
            {p.parked.map((x) => (
              <div key={x.id} className="pos-parked-r">
                <span className="pos-ell">
                  {x.customer?.name ?? t('pos.sell.walkInShort')} · {t('pos.sell.items', { count: x.lines.reduce((s, l) => s + l.qty, 0) })}
                </span>
                <button type="button" className="btn small" onClick={() => p.onResume(x)}>
                  {t('pos.sell.resume')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {!empty && (
        <div className="pos-ticket-foot">
          <div className="pos-totals">
            <div>
              <span>{t('pos.sell.items', { count: cart.items })}</span>
              {cart.saved > 0 && <s className="ltr">{da(cart.before)}</s>}
            </div>
            {cart.saved > 0 && (
              <div className="ok">
                <span>{t('pos.sell.packsSaved')}</span>
                <b className="ltr">−{da(cart.saved)}</b>
              </div>
            )}
            <div className="pos-total">
              <b>{t('pos.sell.total')}</b>
              <b className="ltr">{da(cart.total)}</b>
            </div>
          </div>
          <div className="pos-methods" role="radiogroup" aria-label={t('pos.sell.payWith')}>
            {POS_METHODS.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={p.method === m} className={`pos-method ${p.method === m ? 'on' : ''}`} onClick={() => p.onMethod(m)}>
                <Icon name={METHOD_ICON[m]} />
                {t(`pos.method.${m}`)}
              </button>
            ))}
          </div>
          <p className="pos-into muted">{t('pos.sell.into', { name: caisseName(t, st.into[p.method], st.caisse.key) })}</p>
          <button type="button" className="btn primary pos-pay" disabled={p.busy} onClick={p.onPay}>
            {p.busy ? t('pos.sell.paying') : t('pos.sell.pay', { v: da(cart.total) })}
          </button>
          <div className="pos-row2">
            <button type="button" className="btn" onClick={p.onPark}>
              <Icon name="pause" />
              {t('pos.sell.park')}
            </button>
            <button type="button" className="btn" onClick={p.onClear}>
              <Icon name="trash" />
              {t('pos.sell.clear')}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}


function Line({ r, onQty }: { r: PricedLine; onQty: (q: number) => void }) {
  const { t } = useTranslation();
  const name = r.v.title ? `${r.p.name} · ${r.v.title}` : r.p.name;
  return (
    <li className="pos-line">
      <Photo src={r.v.photo ?? r.p.photo} name={r.p.name} size="line" />
      <span className="pos-line-t">
        <b>{r.p.name}</b>
        <small className="muted">
          {r.v.title && `${r.v.title} · `}
          <span className="ltr">{r.qty > 1 ? `${n(r.qty)} × ${da(r.unit)}` : da(r.unit)}</span>
        </small>
        {(r.saved > 0 || r.left <= 2) && (
          <span className="pos-line-tags">
            {r.packs.map((k) => (
              <span key={k.qty} className="pos-pill ok">
                {t('pos.sell.packLine', { qty: k.qty, count: k.times })}
              </span>
            ))}
            {r.saved > 0 && <span className="pos-pill ok">{t('pos.sell.lessBy', { v: da(r.saved) })}</span>}
            {r.left <= 2 && <span className="pos-pill warn">{r.left < 0 ? t('pos.sell.over', { count: -r.left }) : t('pos.sell.willLeave', { count: r.left })}</span>}
          </span>
        )}
      </span>
      <span className="pos-step" role="group" aria-label={t('pos.sell.qtyOf', { name })}>
        <button type="button" aria-label={t('pos.sell.less', { name })} onClick={() => onQty(r.qty - 1)}>
          <Icon name={r.qty === 1 ? 'trash' : 'minus'} />
        </button>
        <b className="ltr" aria-live="polite">
          {r.qty}
        </b>
        <button type="button" aria-label={t('pos.sell.more', { name })} onClick={() => onQty(r.qty + 1)}>
          <Icon name="plus" />
        </button>
      </span>
      <span className="pos-line-v">
        {r.saved > 0 && <s className="ltr">{da(r.before)}</s>}
        <b className="ltr">{da(r.total)}</b>
      </span>
    </li>
  );
}

function Done({ sale, st, onNew }: { sale: PosSale; st: PosState; onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="pos-done" role="status">
      <span className="pos-done-ic">
        <Icon name="check" />
      </span>
      <b>{t('pos.sell.done', { no: sale.no })}</b>
      <span className="pos-done-v ltr">{da(sale.total)}</span>
      <span className="muted">
        {t(`pos.method.${sale.method}`)} · {t('pos.sell.items', { count: sale.items })}
        {sale.customer && ` · ${sale.customer.name}`}
      </span>
      <div className="pos-row2">
        <button type="button" className="btn" onClick={() => printTicket(sale, st.ticket)}>
          <Icon name="printer" />
          {t('pos.sell.print')}
        </button>
        <button type="button" className="btn primary" onClick={onNew}>
          <Icon name="plus" />
          {t('pos.sell.newSale')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the customer
function CustomerAsk({ onPick, onClose }: { onPick: (c: PosCustomer) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState<{ phone: string; customer: PosCustomer | null } | null>(null);
  const find = useAction('pos.client', { onDone: (r) => setFound(r) });
  const make = useAction('pos.clientNew', { onDone: (c) => onPick(c) });
  return (
    <Modal sheet title={t('pos.client.title')} onClose={onClose} className="pos-modal">
      <form
        className="pos-client"
        onSubmit={(e) => {
          e.preventDefault();
          if (found && !found.customer) make.mutate({ name, phone });
          else find.mutate({ phone });
        }}
      >
        <label className="pos-field">
          <span>{t('pos.client.phone')}</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setFound(null);
            }}
            placeholder="0550 12 34 56"
            className="ltr"
          />
        </label>
        {!found && (
          <button type="submit" className="btn primary" disabled={phone.trim().length < 6 || find.isPending}>
            <Icon name="search" />
            {t('pos.client.find')}
          </button>
        )}
        {found?.customer && (
          <div className="pos-found">
            <span className="pos-found-t">
              <b>{found.customer.name}</b>
              <small className="muted ltr">{found.customer.phone}</small>
            </span>
            {found.customer.level && <ScoreChip s={{ score: found.customer.score ?? 0, level: found.customer.level }} />}
            <button type="button" className="btn primary" onClick={() => onPick(found.customer!)}>
              {t('pos.client.use')}
            </button>
          </div>
        )}
        {found && !found.customer && (
          <>
            <p className="pos-note">
              <Icon name="info" />
              <span>{t('pos.client.unknown')}</span>
            </p>
            <label className="pos-field">
              <span>{t('pos.client.name')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </label>
            <button type="submit" className="btn primary" disabled={name.trim().length < 2 || make.isPending}>
              <Icon name="userplus" />
              {t('pos.client.add')}
            </button>
          </>
        )}
      </form>
    </Modal>
  );
}
