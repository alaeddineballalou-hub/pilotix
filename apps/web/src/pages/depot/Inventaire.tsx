// Inventaire: count a whole depot, phone in hand, and validate everything in one go.
// - each product: what the stock says, the counted quantity (number pad or − / +), « ✓ » when it is right;
// - the count is kept on this device while it goes on (a reload or a call does not lose it);
// - « Comptage à l'aveugle » hides what the stock says, so people really count;
// - validating writes one inventory (INV-…): only the counted products change, each difference is a movement.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { store } from '../../lib/store';
import { da, dateTime, n, shortWhen } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { Filters, SearchBox } from '../ai/agent';
import { bidi, Delta, DepotSelect, matches, nameOf, signedDa, Stepper, StockRowT, Toolbar, useDepots } from './stockui';

type Draft = { at: string; counts: Record<number, number> };
type InvFilter = 'all' | 'todo' | 'done' | 'diff';

const KEY = (wid: number) => `inv.${wid}`;
function loadDraft(wid: number): Draft | null {
  const d = store.json<Draft | null>(KEY(wid), null);
  return d && typeof d === 'object' && d.counts ? d : null;
}
const saveDraft = (wid: number, d: Draft | null) => store.set(KEY(wid), d && Object.keys(d.counts).length ? JSON.stringify(d) : null);

export function Inventaire() {
  const { depots } = useDepots();
  const [wid, setWid] = useState<number | null>(null);
  useEffect(() => {
    if (wid === null && depots.length) setWid(depots[0].id);
  }, [depots, wid]);
  if (wid === null) return <Loading />;
  return (
    <>
      <Count key={wid} wid={wid} onDepot={setWid} />
      <History />
    </>
  );
}

function Count({ wid, onDepot }: { wid: number; onDepot: (id: number) => void }) {
  const { t } = useTranslation();
  const { depots, many } = useDepots();
  const depot = depots.find((d) => d.id === wid);
  const st = useRpc('catalog.stock', { warehouseId: wid });
  const [draft, setDraft] = useState<Draft | null>(() => loadDraft(wid));
  const counts = draft?.counts ?? {};
  const [q, setQ] = useState('');
  const [f, setF] = useState<InvFilter>('all');
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [blind, setBlind] = useState<boolean>(() => store.get('inv.blind') === '1');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ ref: string; changed: number; found: number; missing: number; value: number; counted: number } | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  useEffect(() => saveDraft(wid, draft), [wid, draft]);
  useEffect(() => setKeep(new Set()), [f, q]);

  const rows = useMemo(() => (st.data ?? []).filter((r) => r.qty !== 0 || r.productActive), [st.data]);
  const isDone = (r: StockRowT) => counts[r.variantId] !== undefined;
  const isDiff = (r: StockRowT) => isDone(r) && counts[r.variantId] !== r.qty;
  const found = rows.filter((r) => !q.trim() || matches(q, nameOf(r), r.sku));
  const test: Record<InvFilter, (r: StockRowT) => boolean> = { all: () => true, todo: (r) => !isDone(r), done: isDone, diff: isDiff };
  const list = found.filter((r) => test[f](r) || keep.has(r.variantId));

  const done = rows.filter(isDone);
  const diffs = rows.filter(isDiff);
  const delta = diffs.reduce((s, r) => s + (counts[r.variantId] - r.qty), 0);
  const value = diffs.reduce((s, r) => s + (counts[r.variantId] - r.qty) * r.cost, 0);

  const setCount = (r: StockRowT, v: number | '') => {
    setKeep((k) => (k.has(r.variantId) ? k : new Set(k).add(r.variantId)));
    setDraft((d) => {
      const c = { ...(d?.counts ?? {}) };
      if (v === '') delete c[r.variantId];
      else c[r.variantId] = v;
      return { at: d?.at ?? new Date().toISOString(), counts: c };
    });
  };
  const next = (i: number) => {
    const r = list[i + 1];
    if (r) inputs.current.get(r.variantId)?.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };
  const toggleBlind = () => {
    setBlind(!blind);
    store.set('inv.blind', blind ? null : '1');
  };

  return (
    <>
      {result && (
        <div className="pd-done" role="status">
          <Icon name="checkcircle" />
          <span>
            <b>{t('produits.inv.doneTitle', { ref: result.ref })}</b>
            <small>{result.changed ? t('produits.inv.doneSome', { changed: result.changed, found: result.found, missing: result.missing, value: signedDa(result.value), count: result.counted }) : t('produits.inv.doneNone', { count: result.counted })}</small>
          </span>
          <a className="btn small" href={`#/produits/mouvements/${result.ref}`}>
            {t('produits.inv.seeMoves')}
          </a>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={() => setResult(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      <section className="card pd-card pd-inv-card">
        <Toolbar
          action={
            <label className="pd-switch">
              <input type="checkbox" checked={blind} onChange={toggleBlind} />
              <span>
                <b>{t('produits.inv.blind')}</b>
                <small>{t('produits.inv.blindHint')}</small>
              </span>
            </label>
          }
        >
          {many && (
            <div className="pd-sels">
              <DepotSelect value={String(wid)} onChange={(v) => onDepot(Number(v))} label={t('produits.inv.depot')} />
            </div>
          )}
          <SearchBox value={q} onChange={setQ} placeholder={t('produits.inv.searchPh')} />
          <Filters<InvFilter>
            value={f}
            onChange={setF}
            label={t('produits.inv.filters')}
            items={[
              { value: 'all', label: t('produits.inv.fAll'), count: found.length },
              { value: 'todo', label: t('produits.inv.fTodo'), count: found.filter(test.todo).length },
              { value: 'done', label: t('produits.inv.fDone'), count: found.filter(isDone).length },
              { value: 'diff', label: t('produits.inv.fDiff'), count: found.filter(isDiff).length, alert: true },
            ]}
          />
        </Toolbar>
        {draft && done.length > 0 && (
          <p className="pd-draft">
            <Icon name="clock" />
            <span>{t('produits.inv.draft', { when: bidi(shortWhen(draft.at)), depot: bidi(depot?.name) })}</span>
          </p>
        )}
        {st.isLoading ? (
          <Loading />
        ) : st.error ? (
          <ErrorBox error={st.error} onRetry={() => st.refetch()} />
        ) : !list.length ? (
          <Empty>{q.trim() ? t('produits.ui.noMatch') : t(`produits.inv.empty_${f}`)}</Empty>
        ) : (
          <div className={`pd-list ${blind ? 'blind' : ''}`}>
            <div className="pd-row pd-head pd-inv" aria-hidden="true">
              <span>{t('produits.inv.product')}</span>
              {!blind && <span className="num">{t('produits.inv.expected')}</span>}
              <span className="pd-cnt-h">{t('produits.inv.counted')}</span>
              {!blind && <span className="num">{t('produits.inv.diff')}</span>}
            </div>
            {list.map((r, i) => {
              const c = counts[r.variantId];
              const d = c === undefined ? null : c - r.qty;
              return (
                <div key={r.variantId} className={`pd-row pd-inv ${c !== undefined ? 'counted' : ''} ${d ? 'off' : ''}`}>
                  <span className="pd-name">
                    <b>{nameOf(r)}</b>
                    <small>
                      <span className="ltr">{r.sku}</span>
                      {r.reserved > 0 && <span>{t('produits.inv.reserved', { n: r.reserved })}</span>}
                    </small>
                  </span>
                  {!blind && (
                    <span className="pd-exp" data-l={t('produits.inv.expected')}>
                      <b className="ltr">{n(r.qty)}</b>
                    </span>
                  )}
                  <span className="pd-cnt">
                    <Stepper
                      value={c ?? ''}
                      onChange={(v) => setCount(r, v)}
                      label={t('produits.inv.countOf', { name: nameOf(r) })}
                      inputRef={(el) => (el ? inputs.current.set(r.variantId, el) : inputs.current.delete(r.variantId))}
                      onEnter={() => next(i)}
                    />
                    {!blind && (
                      <button type="button" className={`pd-ok ${c === r.qty ? 'on' : ''}`} title={t('produits.inv.sameHint', { n: r.qty })} aria-label={t('produits.inv.sameHint', { n: r.qty })} onClick={() => setCount(r, r.qty)}>
                        <Icon name="check" />
                      </button>
                    )}
                  </span>
                  {!blind && <span className="pd-diff">{d === null ? <span className="muted">—</span> : <Delta v={d} zero="✓" />}</span>}
                </div>
              );
            })}
          </div>
        )}
        <p className="pd-note">{t('produits.inv.help')}</p>
      </section>

      <div className={`pd-invbar ${done.length ? 'live' : ''}`}>
        <div className="pd-invbar-t">
          <b>{t('produits.inv.progress', { done: done.length, total: rows.length })}</b>
          <span className="pd-prog" aria-hidden="true">
            <i style={{ width: `${rows.length ? (done.length / rows.length) * 100 : 0}%` }} />
          </span>
          <small>{diffs.length ? t('produits.inv.diffSum', { count: diffs.length, pieces: delta > 0 ? `+${n(delta)}` : delta < 0 ? `−${n(-delta)}` : '0', value: signedDa(value) }) : done.length ? t('produits.inv.noDiff') : t('produits.inv.start')}</small>
        </div>
        {done.length > 0 && (
          <button type="button" className="btn ghost" onClick={() => window.confirm(t('produits.inv.clearAsk')) && setDraft(null)}>
            {t('produits.inv.clear')}
          </button>
        )}
        <button type="button" className="btn pd-go" disabled={!done.length} onClick={() => setConfirm(true)}>
          <Icon name="check" />
          {t('produits.inv.validate')}
        </button>
      </div>

      {confirm && depot && (
        <ConfirmInventory
          depot={depot}
          lines={done.map((r) => ({ r, counted: counts[r.variantId] }))}
          untouched={rows.length - done.length}
          onClose={() => setConfirm(false)}
          onDone={(res) => {
            setConfirm(false);
            setDraft(null);
            setResult(res);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </>
  );
}

function ConfirmInventory({ depot, lines, untouched, onClose, onDone }: {
  depot: { id: number; name: string };
  lines: { r: StockRowT; counted: number }[];
  untouched: number;
  onClose: () => void;
  onDone: (r: { ref: string; changed: number; found: number; missing: number; value: number; counted: number }) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const go = useAction('catalog.inventory', { success: (r) => t('produits.inv.saved', { ref: r.ref }), onDone });
  const changes = lines.filter((l) => l.counted !== l.r.qty);
  const value = changes.reduce((s, l) => s + (l.counted - l.r.qty) * l.r.cost, 0);
  return (
    <Modal
      title={t('produits.inv.confirmTitle', { depot: bidi(depot.name) })}
      onClose={onClose}
      className="pd-sheet"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('produits.inv.keepCounting')}
          </button>
          <button className="btn pd-go" disabled={go.isPending} onClick={() => go.mutate({ warehouseId: depot.id, lines: lines.map((l) => ({ variantId: l.r.variantId, counted: l.counted })), note: note.trim() })}>
            <Icon name="check" />
            {t('produits.inv.validateN', { count: lines.length })}
          </button>
        </>
      }
    >
      <div className="pd-sum">
        <span>
          <b className="ltr">{n(lines.length)}</b>
          <small>{t('produits.inv.sumCounted')}</small>
        </span>
        <span>
          <b className="ltr">{n(changes.length)}</b>
          <small>{t('produits.inv.sumChanged')}</small>
        </span>
        <span className={value < 0 ? 'down' : value > 0 ? 'up' : ''}>
          <b className="ltr">{signedDa(value)}</b>
          <small>{t('produits.inv.sumValue')}</small>
        </span>
      </div>
      {changes.length ? (
        <ul className="pd-changes">
          {changes.map(({ r, counted }) => (
            <li key={r.variantId}>
              <span>
                <b>{nameOf(r)}</b>
                <small className="ltr">{r.sku}</small>
              </span>
              <span className="pd-was ltr">
                {n(r.qty)} <Icon name="arrow" className="pd-arrow" /> <b>{n(counted)}</b>
              </span>
              <Delta v={counted - r.qty} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="pd-after">{t('produits.inv.allRight')}</p>
      )}
      {untouched > 0 && <p className="pd-note">{t('produits.inv.untouched', { count: untouched })}</p>}
      <Field label={t('produits.inv.note')}>
        <input value={note} maxLength={300} placeholder={t('produits.inv.notePh')} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function History() {
  const { t } = useTranslation();
  const h = useRpc('catalog.inventories', { limit: 10 });
  if (!h.data?.length) return null;
  return (
    <section className="card pd-card">
      <div className="card-head">
        <h2>{t('produits.inv.history')}</h2>
      </div>
      <ul className="pd-hist">
        {h.data.map((x) => (
          <li key={x.id}>
            <a href={`#/produits/mouvements/${x.ref}`}>
              <span className="pd-hist-id">
                <b className="ltr">{x.ref}</b>
                <small>
                  {dateTime(x.at)} · {x.warehouseName}
                  {x.userName ? ` · ${x.userName}` : ''}
                </small>
                {x.note && <small className="pd-hist-note">{x.note}</small>}
              </span>
              <span className="pd-hist-n">
                <small>{t('produits.inv.hCounted', { count: x.counted })}</small>
                <small>{t('produits.inv.hChanged', { count: x.changed })}</small>
              </span>
              <span className="pd-hist-d">
                {x.found > 0 && <Delta v={x.found} />}
                {x.missing > 0 && <Delta v={-x.missing} />}
                {!x.found && !x.missing && <b className="pd-delta eq">✓</b>}
                <small className={`ltr ${x.value < 0 ? 'down' : ''}`}>{signedDa(x.value)}</small>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
