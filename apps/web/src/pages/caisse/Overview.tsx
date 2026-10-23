// Caisse on computers, « Vue d'ensemble »: the main caisse (Dépense / Entrée / Transfert) and the bank, then all the money
// still outside in three columns — delivery companies (with ZR's own payments: balance, demande de paiement, payments to
// put in a caisse), livreurs, employees (dépôt, confirmation, suivi… each with a caisse) — and « Journal » of any caisse.
// Same procedures as the phone Caisse (caisse.overview / caisse.view / caisse.pay…), laid out for a wide screen.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { dateOnly, dayLabel, da, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import './caisse.css';

const CATS = ['fuel', 'packing', 'salary', 'rent', 'ads', 'repair', 'other'] as const;
type Kind = 'expense' | 'income' | 'transfer';
type Move = { id: string; at: string; amount: number; kind: string; label: string; sub: string | null; category: string | null; note: string | null; byName: string | null; moveId: number | null };
const sgn = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${da(Math.abs(v))}`;
const days = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null);
const coShort = (name: string) => name.replace(/express|livraison/gi, '').trim().slice(0, 3).toUpperCase();

/** A select of the caisses money can go into / come from. */
function CaisseSelect({ value, onChange, label, me }: { value: string; onChange: (k: string) => void; label: string; me?: boolean }) {
  const { t } = useTranslation();
  const list = useRpc('caisse.list', {}).data ?? [];
  return (
    <label className="field">
      <span className="lab">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {list.map((c) => (
          <option key={c.key} value={c.key}>
            {c.key === 'main' ? (me ? t('caisse.ph.meMain') : t('caisse.ph.main')) : c.key === 'bank' ? t('caisse.ph.bank') : c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------- the page
export function CaisseOverview({ onOpenDue, onOpenLivreurs }: { onOpenDue: (key: string) => void; onOpenLivreurs: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.overview', {});
  const [move, setMove] = useState<{ kind: Kind; from: string; to?: string } | null>(null);
  const [caisse, setCaisse] = useState<string | null>(null);
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  const payCos = d.companies.filter((c) => c.kind === 'zr' && c.companyId);
  return (
    <>
      <div className="pxc-top">
        <section className="pxc-main">
          <div className="pxc-mh">
            <span>{t('caisse.ph.main')}</span>
            {d.main.today !== 0 && <small className="ltr">{t('caisse.ph.today', { v: sgn(d.main.today) })}</small>}
          </div>
          <button type="button" className="pxc-big ltr" onClick={() => setCaisse('main')} title={t('caisse.dk.openJournal')}>
            {da(d.main.balance)}
          </button>
          <div className="pxc-m3">
            <button type="button" onClick={() => setMove({ kind: 'expense', from: 'main' })}>
              − {t('caisse.ph.expense')}
            </button>
            <button type="button" onClick={() => setMove({ kind: 'income', from: 'main' })}>
              + {t('caisse.ph.income')}
            </button>
            <button type="button" onClick={() => setMove({ kind: 'transfer', from: 'main' })}>
              <Icon name="swap" /> {t('caisse.ph.transfer')}
            </button>
          </div>
        </section>
        <button type="button" className="card pxc-bank" onClick={() => setCaisse('bank')}>
          <span className="l">
            <Icon name="building" /> {t('caisse.ph.bank')}
          </span>
          <b className="ltr">{da(d.bank.balance)}</b>
          <small className="muted">{t('caisse.dk.openJournal')}</small>
        </button>
        <div className="card pxc-out">
          <span className="l">{t('caisse.ph.outside')}</span>
          <b className="ltr">{da(d.outside)}</b>
          <small className="muted">{t('caisse.dk.outsideSub')}</small>
        </div>
      </div>

      {payCos.map((c) => (
        <CourierPayCard key={c.key} companyId={c.companyId!} />
      ))}

      <div className="pxc-cols">
        <div className="card">
          <div className="card-head">
            <h2>{t('caisse.ph.companies')}</h2>
            <b className="ltr">{da(d.companies.reduce((s, c) => s + c.net, 0))}</b>
          </div>
          {d.companies.length ? (
            <ul className="pxc-list">
              {d.companies.map((c) => (
                <li key={c.key}>
                  <button type="button" onClick={() => onOpenDue(c.key)}>
                    <span className={`pxs-co k-${c.kind ?? 'other'} pxc-co`}>{coShort(c.name)}</span>
                    <span className="pxc-rm">
                      <b>{c.name}</b>
                      <small>
                        {t('caisse.ph.parcels', { count: c.count })}
                        {days(c.oldest) ? ` · ${t('caisse.ph.oldest', { n: days(c.oldest) })}` : ''}
                      </small>
                      {c.payWaiting > 0 && <em className="pxc-badge ltr">{t('caisse.pay.waitingBadge', { v: da(c.payWaiting) })}</em>}
                    </span>
                    <b className="ltr">{da(c.net)}</b>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('caisse.ph.noCompany')}</Empty>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('caisse.ph.livreurs')}</h2>
            <b className="ltr">{da(d.livreurs.reduce((s, l) => s + l.net, 0))}</b>
          </div>
          {d.livreurs.length ? (
            <ul className="pxc-list">
              {d.livreurs.map((l) => (
                <li key={l.id}>
                  <button type="button" onClick={onOpenLivreurs}>
                    <span className="pxc-av or">{l.name.slice(0, 1).toUpperCase()}</span>
                    <span className="pxc-rm">
                      <b>{l.name}</b>
                      <small>
                        {l.notCashed ? t('caisse.ph.notHanded', { count: l.notCashed }) : t('caisse.ph.nothingHeld')}
                        {l.last && l.notCashed ? ` · ${t('caisse.ph.lastHand', { n: days(l.last) })}` : ''}
                      </small>
                    </span>
                    <b className="ltr">{da(l.net)}</b>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('caisse.ph.nothingHeld')}</Empty>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('caisse.ph.employees')}</h2>
            <b className="ltr">{da(d.employees.reduce((s, e) => s + e.balance, 0))}</b>
          </div>
          <ul className="pxc-list">
            {d.employees.map((e) => (
              <li key={e.key}>
                <button type="button" onClick={() => setCaisse(e.key)}>
                  <span className="pxc-av">{e.name.slice(0, 1).toUpperCase()}</span>
                  <span className="pxc-rm">
                    <b>{e.name}</b>
                    <small>{e.role ? t(`roles.${e.role}`, { defaultValue: e.role }) : ''}</small>
                  </span>
                  <b className={`ltr${e.balance ? '' : ' muted'}`}>{da(e.balance)}</b>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {d.tickets.count > 0 && <p className="muted small">{t('caisse.ph.tickets', { count: d.tickets.count, v: da(d.tickets.total) })}</p>}

      {move && <MoveModal kind={move.kind} from={move.from} to={move.to} onClose={() => setMove(null)} />}
      {caisse && <CaisseModal caisse={caisse} onClose={() => setCaisse(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- a caisse: its journal (main, bank, an employee)
function CaisseModal({ caisse, onClose }: { caisse: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.view', { caisse: caisse as 'main' });
  const [move, setMove] = useState<Kind | null>(null);
  const emp = caisse.startsWith('u');
  const d = q.data;
  const name = d ? (caisse === 'main' ? t('caisse.ph.main') : caisse === 'bank' ? t('caisse.ph.bank') : d.name) : '…';
  return (
    <Modal
      wide
      title={
        <>
          {name} {d && <span className="ltr muted">· {da(d.balance)}</span>}
        </>
      }
      onClose={onClose}
    >
      <div className="pxc-acts">
        {emp ? (
          <>
            <button type="button" className="btn primary" onClick={() => setMove('transfer')}>
              <Icon name="swap" /> {t('caisse.ph.handToMain')}
            </button>
            <button type="button" className="btn" onClick={() => setMove('expense')}>
              − {t('caisse.ph.expense')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setMove('expense')}>
              − {t('caisse.ph.expense')}
            </button>
            <button type="button" className="btn" onClick={() => setMove('income')}>
              + {t('caisse.ph.income')}
            </button>
            <button type="button" className="btn primary" onClick={() => setMove('transfer')}>
              <Icon name="swap" /> {t('caisse.ph.transfer')}
            </button>
          </>
        )}
      </div>
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !d ? <Loading /> : <JournalTable data={d} />}
      {move && <MoveModal kind={move} from={caisse} to={emp && move === 'transfer' ? 'main' : undefined} onClose={() => setMove(null)} />}
    </Modal>
  );
}

/** « Journal » tab: the movements of the chosen caisse. */
export function CaisseJournal() {
  const { t } = useTranslation();
  const [caisse, setCaisse] = useState('main');
  const q = useRpc('caisse.view', { caisse: caisse as 'main' });
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('caisse.ph.journal')}</h2>
        <div style={{ minWidth: 240 }}>
          <CaisseSelect value={caisse} onChange={setCaisse} label={t('caisse.dk.whichCaisse')} />
        </div>
      </div>
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <Loading /> : <JournalTable data={q.data} />}
    </div>
  );
}

function JournalTable({ data: d }: { data: { moves: Move[]; monthIn: number; monthOut: number; balance: number } }) {
  const { t } = useTranslation();
  const [f, setF] = useState<'all' | 'in' | 'out' | 'transfer'>('all');
  const [pick, setPick] = useState<Move | null>(null);
  const moves = useMemo(
    () => d.moves.filter((m) => (f === 'all' ? true : f === 'transfer' ? m.kind === 'transfer' : f === 'in' ? m.amount > 0 && m.kind !== 'transfer' : m.amount < 0 && m.kind !== 'transfer')),
    [d.moves, f],
  );
  const label = (m: Move) =>
    m.kind === 'receipt' ? t('caisse.ph.mv.receipt', { name: m.label }) : m.kind === 'transfer' ? m.label : m.category ? t(`caisse.cat.${m.category}`) : m.label || t(`caisse.ph.mv.${m.kind}`);
  let lastDay = '';
  return (
    <>
      <div className="kpis">
        <div className="kpi t-ok">
          <span className="l">{t('caisse.ph.monthIn')}</span>
          <span className="v ltr">{sgn(d.monthIn)}</span>
        </div>
        <div className="kpi t-bad">
          <span className="l">{t('caisse.ph.monthOut')}</span>
          <span className="v ltr">{sgn(d.monthOut)}</span>
        </div>
        <div className="kpi">
          <span className="l">{t('caisse.ph.balance')}</span>
          <span className="v ltr">{da(d.balance)}</span>
        </div>
      </div>
      <div className="bjp-tabs" style={{ margin: '10px 0' }}>
        {(['all', 'in', 'out', 'transfer'] as const).map((k) => (
          <button key={k} type="button" className={`tab${f === k ? ' on' : ''}`} onClick={() => setF(k)}>
            {t(`caisse.ph.f.${k}`)}
          </button>
        ))}
      </div>
      {!moves.length ? (
        <Empty>{t('caisse.ph.noMove')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl pxc-tbl">
            <thead>
              <tr>
                <th>{t('caisse.dk.col.when')}</th>
                <th className="wide">{t('caisse.dk.col.what')}</th>
                <th>{t('caisse.dk.col.who')}</th>
                <th className="num">{t('caisse.dk.col.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => {
                const day = m.at.slice(0, 10);
                const head = day !== lastDay;
                lastDay = day;
                const tone = m.kind === 'transfer' ? 'tr' : m.amount > 0 ? 'ok' : 'bad';
                return [
                  head && (
                    <tr key={`d${day}`} className="pxc-day">
                      <td colSpan={4}>{dayLabel(m.at)}</td>
                    </tr>
                  ),
                  <tr key={m.id} className={m.moveId ? 'clickable' : undefined} onClick={() => m.moveId && setPick(m)}>
                    <td data-l={t('caisse.dk.col.when')}>{when(m.at)}</td>
                    <td className="wide" data-l={t('caisse.dk.col.what')}>
                      <b>{label(m)}</b>
                      {(m.sub || m.note) && <small>{[m.sub, m.note].filter(Boolean).join(' · ')}</small>}
                    </td>
                    <td data-l={t('caisse.dk.col.who')}>{m.byName ?? '—'}</td>
                    <td className={`num ltr pxc-amt ${tone}`} data-l={t('caisse.dk.col.amount')}>
                      {sgn(m.amount)}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {pick && <CancelMove m={pick} label={label(pick)} onClose={() => setPick(null)} />}
    </>
  );
}

function CancelMove({ m, label, onClose }: { m: Move; label: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const cancel = useAction('caisse.cancel', { success: t('caisse.ph.cancelled'), onDone: onClose });
  return (
    <Modal
      title={sgn(m.amount)}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          {session?.isAdmin && (
            <button className="btn danger" disabled={cancel.isPending || !m.moveId} onClick={() => m.moveId && cancel.mutate({ id: m.moveId })}>
              {t('caisse.ph.cancelMove')}
            </button>
          )}
        </>
      }
    >
      <p className="muted">
        {label} · {when(m.at)}
        {m.byName ? ` · ${m.byName}` : ''}
      </p>
      {m.note && <p>{m.note}</p>}
      {!session?.isAdmin && <p className="muted small">{t('caisse.ph.askOwner')}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- expense / entry / transfer
function MoveModal({ kind, from: from0, to: to0, onClose }: { kind: Kind; from: string; to?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState('');
  const [from, setFrom] = useState(from0);
  const [to, setTo] = useState(to0 ?? (from0 === 'main' ? 'bank' : 'main'));
  const [note, setNote] = useState('');
  const add = useAction('caisse.add', { success: kind === 'expense' ? t('caisse.ph.expenseSaved') : t('caisse.ph.incomeSaved'), onDone: onClose });
  const tr = useAction('caisse.transfer', { success: t('caisse.ph.transferSaved'), onDone: onClose });
  const v = Math.round(Number(amount.replace(/\s/g, '')) || 0);
  const ok = v > 0 && (kind !== 'expense' || !!cat) && (kind !== 'transfer' || from !== to);
  const save = () =>
    kind === 'transfer'
      ? tr.mutate({ from: from as 'main', to: to as 'main', amount: v, note: note.trim() || null })
      : add.mutate({ caisse: from as 'main', kind, amount: v, category: kind === 'expense' ? (cat as 'other') : null, note: note.trim() || null });
  return (
    <Modal
      title={t(`caisse.ph.new.${kind}`)}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!ok || add.isPending || tr.isPending} onClick={save}>
            {t(`caisse.ph.save.${kind}`, { v: v ? da(v) : '' })}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field">
          <span className="lab">{t('caisse.ph.amount')}</span>
          <input type="number" inputMode="numeric" min={1} autoFocus value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
        </label>
        {kind === 'expense' && (
          <label className="field">
            <span className="lab">{t('caisse.ph.category')}</span>
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">—</option>
              {CATS.map((c) => (
                <option key={c} value={c}>
                  {t(`caisse.cat.${c}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <CaisseSelect value={from} onChange={setFrom} label={kind === 'transfer' ? t('caisse.ph.from') : kind === 'expense' ? t('caisse.ph.paidFrom') : t('caisse.ph.into')} />
        {kind === 'transfer' && !to0 && <CaisseSelect value={to} onChange={setTo} label={t('caisse.ph.to')} />}
        <label className="field">
          <span className="lab">{t('caisse.dk.note')}</span>
          <input value={note} maxLength={300} placeholder={t('caisse.ph.notePh')} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- a company's money at the courier (ZR API)
type Pay = Extract<Out<'caisse.pay'>, { supported: true }>['payments'][number];
const DETAILS = ['parcelsDelivered', 'parcelsCancelled', 'refundsCredited', 'refundsDebited', 'labeling', 'officeHolding', 'storage'] as const;

export function CourierPayCard({ companyId }: { companyId: number }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.pay', { companyId });
  const sync = useAction('caisse.paySync', { success: (r) => (r.imported ? t('caisse.pay.imported', { count: r.imported }) : r.requested ? t('caisse.pay.requestedNow') : t('caisse.pay.upToDate')) });
  const ask = useAction('caisse.payRequest', { success: (r) => t('caisse.pay.requestSent', { d: r.date }) });
  const [askDate, setAskDate] = useState('');
  const [open, setOpen] = useState<Pay | null>(null);
  const [take, setTake] = useState<Pay | null>(null);
  const [cfg, setCfg] = useState(false);
  const d = q.data;
  if (!d || !d.supported) return null;
  const pending = d.requests.find((r) => r.approved === null);
  const waiting = d.payments.filter((p) => !p.inCaisse);
  const done = d.payments.filter((p) => p.inCaisse);
  const min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="card pxc-pay">
      <div className="card-head">
        <h2>{t('caisse.pay.title', { name: d.name })}</h2>
        <div className="pxc-acts">
          <button type="button" className="btn" disabled={sync.isPending} onClick={() => sync.mutate({ companyId })}>
            <Icon name="refresh" /> {t('caisse.pay.refresh')}
          </button>
          <button type="button" className="btn" onClick={() => setCfg(true)}>
            <Icon name="settings" /> {t('caisse.pay.settings')}
          </button>
        </div>
      </div>
      {d.balance?.error && <div className="warnbox">{d.balance.error}</div>}
      <div className="pxc-pay-grid">
        <div>
          {d.balance && (
            <div className="kpis">
              <div className="kpi t-ok">
                <span className="l">{t('caisse.pay.ready')}</span>
                <span className="v ltr">{da(d.balance.ready)}</span>
              </div>
              <div className="kpi">
                <span className="l">{t('caisse.pay.notReady')}</span>
                <span className="v ltr">{da(d.balance.notReady)}</span>
              </div>
              <div className="kpi">
                <span className="l">{t('caisse.pay.paid')}</span>
                <span className="v ltr">{da(d.balance.paid)}</span>
              </div>
            </div>
          )}
          {d.balance && <p className="muted small">{t('caisse.dk.balanceAt', { d: when(d.balance.at) })}</p>}
        </div>
        <div className="pxc-req">
          {pending ? (
            <>
              <div className="pxc-reqh">
                <Icon name="hourglass" />
                <span>
                  <b>{t('caisse.pay.pending', { d: pending.date ? dateOnly(pending.date) : '—' })}</b>
                  <small>{pending.auto ? t('caisse.pay.byPilotix') : t('caisse.pay.byHand')}</small>
                </span>
              </div>
              <ReqActions id={pending.id} date={pending.date} />
            </>
          ) : (
            <>
              <b>{t('caisse.pay.ask')}</b>
              <div className="pxc-reqa">
                <input type="date" value={askDate || min} min={min} onChange={(e) => setAskDate(e.target.value)} aria-label={t('caisse.pay.newDate')} />
                <button type="button" className="btn primary" disabled={ask.isPending} onClick={() => ask.mutate({ companyId, date: askDate || undefined })}>
                  <Icon name="coins" /> {t('caisse.pay.ask')}
                </button>
              </div>
            </>
          )}
          <p className="muted small">{d.cfg.auto ? t('caisse.pay.autoOn', { caisse: d.cfgName }) : t('caisse.pay.autoOff', { caisse: d.cfgName })}</p>
        </div>
      </div>

      {(waiting.length > 0 || done.length > 0) && (
        <div className="tbl-wrap">
          <table className="tbl pxc-tbl">
            <thead>
              <tr>
                <th>{t('caisse.pay.payment')}</th>
                <th>{t('caisse.dk.col.when')}</th>
                <th className="wide">{t('caisse.dk.col.state')}</th>
                <th className="num">{t('caisse.dk.col.amount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...waiting, ...done.slice(0, 8)].map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setOpen(p)}>
                  <td data-l={t('caisse.pay.payment')}>
                    <b className="ltr">{p.ref ?? t('caisse.pay.payment')}</b>
                  </td>
                  <td data-l={t('caisse.dk.col.when')}>{when(p.doneAt ?? p.at)}</td>
                  <td className="wide" data-l={t('caisse.dk.col.state')}>
                    {p.inCaisse ? (
                      <span>
                        {t('caisse.pay.intoCaisse', { caisse: p.caisse ?? '—' })} · {t('caisse.ph.parcels', { count: p.matched })}
                      </span>
                    ) : (
                      <span className="badge t-warn">{p.done ? t('caisse.pay.doneNotIn') : t('caisse.pay.waitingAt', { place: p.place ?? 'ZR' })}</span>
                    )}
                  </td>
                  <td className={`num ltr pxc-amt${p.inCaisse ? ' ok' : ''}`} data-l={t('caisse.dk.col.amount')}>
                    {p.inCaisse ? `+${da(p.amount)}` : da(p.amount)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {!p.inCaisse && (
                      <button type="button" className="btn small ok" onClick={() => setTake(p)}>
                        <Icon name="check" /> {t('caisse.pay.receivedBtn')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <PayDetail p={open} onClose={() => setOpen(null)} />}
      {take && <PayTake p={take} into={d.cfg.into} onClose={() => setTake(null)} />}
      {cfg && <PayConfig companyId={companyId} cfg={d.cfg} onClose={() => setCfg(false)} />}
    </div>
  );
}

/** A payment request still waiting: another date (from tomorrow), or withdraw it. */
function ReqActions({ id, date }: { id: number; date: string | null }) {
  const { t } = useTranslation();
  const min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [d, setD] = useState(date && date >= min ? date : min);
  const move = useAction('caisse.payRequestDate', { success: (r) => t('caisse.pay.dateMoved', { d: dateOnly(r.date) }) });
  const drop = useAction('caisse.payRequestCancel', { success: t('caisse.pay.requestCancelled') });
  return (
    <div className="pxc-reqa">
      <input type="date" value={d} min={min} onChange={(e) => setD(e.target.value)} aria-label={t('caisse.pay.newDate')} />
      <button type="button" className="btn" disabled={move.isPending || !d || d === date} onClick={() => move.mutate({ id, date: d })}>
        <Icon name="calendar" /> {t('caisse.pay.changeDate')}
      </button>
      <button type="button" className="btn ghost danger" disabled={drop.isPending} onClick={() => drop.mutate({ id })}>
        {t('caisse.pay.cancelRequest')}
      </button>
    </div>
  );
}

function PayDetail({ p, onClose }: { p: Pay; onClose: () => void }) {
  const { t } = useTranslation();
  const lines = useRpc('caisse.payLines', { id: p.id });
  return (
    <Modal wide title={`${p.ref ?? t('caisse.pay.payment')} · ${da(p.amount)}`} onClose={onClose}>
      <p className="muted">
        {when(p.at)}
        {p.place ? ` · ${p.place}` : ''} · {p.status || '—'}
        {p.inCaisse && p.caisse ? ` · ${t('caisse.pay.intoCaisse', { caisse: p.caisse })}` : ''}
      </p>
      <div className="kpis">
        {DETAILS.filter((k) => (p.details[k] ?? 0) !== 0).map((k) => (
          <div key={k} className="kpi">
            <span className="l">{t(`caisse.pay.d.${k}`)}</span>
            <span className="v ltr">{k.startsWith('parcels') ? p.details[k] : da(p.details[k])}</span>
          </div>
        ))}
      </div>
      <h3 style={{ margin: '14px 0 8px' }}>{t('caisse.pay.parcelsTitle')}</h3>
      {!lines.data ? (
        <Loading />
      ) : !lines.data.length ? (
        <Empty>{t('caisse.pay.noLines')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl pxc-tbl">
            <thead>
              <tr>
                <th>{t('caisse.dk.col.order')}</th>
                <th className="wide">{t('caisse.dk.col.customer')}</th>
                <th>{t('caisse.dk.col.type')}</th>
                <th className="num">{t('caisse.dk.col.costs')}</th>
                <th className="num">{t('caisse.dk.col.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.data.map((l, k) => (
                <tr key={k}>
                  <td data-l={t('caisse.dk.col.order')}>
                    <b className="ltr">{l.ref ?? l.tracking}</b>
                    {!l.ref && <small className="muted">{t('caisse.pay.unknown')}</small>}
                  </td>
                  <td className="wide" data-l={t('caisse.dk.col.customer')}>
                    {l.customer || '—'}
                  </td>
                  <td data-l={t('caisse.dk.col.type')}>{l.type}</td>
                  <td className="num ltr" data-l={t('caisse.dk.col.costs')}>
                    {l.costs ? `−${da(l.costs)}` : '—'}
                  </td>
                  <td className={`num ltr pxc-amt${l.amount < 0 ? ' bad' : ''}`} data-l={t('caisse.dk.col.amount')}>
                    {da(l.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function PayTake({ p, into: into0, onClose }: { p: Pay; into: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [into, setInto] = useState(into0);
  const take = useAction('caisse.payReceive', { success: (r) => t('caisse.pay.takenOk', { count: r.matched }), onDone: onClose });
  return (
    <Modal
      title={`${p.ref ?? t('caisse.pay.payment')} · ${da(p.amount)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={take.isPending} onClick={() => take.mutate({ id: p.id, into: into as 'main' })}>
            <Icon name="check" /> {t('caisse.ph.receiveBtn', { v: da(p.amount) })}
          </button>
        </>
      }
    >
      <p className="muted">{p.done ? t('caisse.pay.takeHelpDone') : t('caisse.pay.takeHelp')}</p>
      <CaisseSelect value={into} onChange={setInto} label={t('caisse.ph.receivedInto')} />
    </Modal>
  );
}

function PayConfig({ companyId, cfg, onClose }: { companyId: number; cfg: { auto: boolean; into: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const [auto, setAuto] = useState(cfg.auto);
  const [into, setInto] = useState(cfg.into);
  const save = useAction('caisse.payConfig', { success: t('common.saved', { defaultValue: 'OK' }), onDone: onClose });
  return (
    <Modal
      title={t('caisse.pay.settings')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ companyId, auto, into: into as 'main' })}>
            {t('caisse.pay.save')}
          </button>
        </>
      }
    >
      <label className="pxc-tog">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span>
          <b>{t('caisse.pay.autoLabel')}</b>
          <small className="muted">{t('caisse.pay.autoHelp')}</small>
        </span>
      </label>
      <CaisseSelect value={into} onChange={setInto} label={t('caisse.pay.intoLabel')} />
    </Modal>
  );
}
