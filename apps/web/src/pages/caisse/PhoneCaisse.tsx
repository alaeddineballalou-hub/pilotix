// Caisse on phones: the owner's main caisse on top (Dépense / Entrée / Transfert), then all the money still outside —
// what each delivery company owes, the cash each livreur holds, each employee's caisse. A tap opens one of them:
// a company (tick parcels, « Argent reçu » into the caisse of your choice), a livreur (« Encaisser » into the caisse of
// whoever takes the cash), a caisse (its movements, hand it to the main caisse, an expense). « Journal »: the main
// caisse's movements. Employees get « Ma caisse » (their own caisse only).
import { ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { dateOnly, dayLabel, da, when } from '../../lib/format';
import { useFullScreen } from '../../lib/fullScreen';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import '../confirmation/phone.css';
import '../suivi/phone.css';
import '../sav/phone.css';
import './phone.css';

const CATS = ['fuel', 'packing', 'salary', 'rent', 'ads', 'repair', 'other'] as const;
type Kind = 'expense' | 'income' | 'transfer';
type Move = { id: string; at: string; amount: number; kind: string; label: string; sub: string | null; category: string | null; note: string | null; byName: string | null; moveId: number | null };
const sgn = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${da(Math.abs(v))}`;
const days = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null);
const initials = (s: string) => s.trim().slice(0, 1).toUpperCase();
const coShort = (name: string) => name.replace(/express|livraison/gi, '').trim().slice(0, 3).toUpperCase();

function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="pxv-sheet" role="dialog" aria-modal="true">
      <button type="button" className="pxv-dim" aria-label={t('common.close')} onClick={onClose} />
      <div className="pxv-sh">
        <span className="pxv-grab" aria-hidden="true" />
        <div className="pxv-shh">
          <b>{title}</b>
          <button type="button" className="pxp-back" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Page({ title, sub, right, onClose, children, bar }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onClose: () => void; children: ReactNode; bar?: ReactNode }) {
  const { t } = useTranslation();
  useFullScreen(onClose);
  return (
    <div className="pxp-order pxk-page" role="dialog" aria-modal="true">
      <header className="pxp-oh">
        <button type="button" className="pxp-back" aria-label={t('common.back')} onClick={onClose}>
          <Icon name="chevl" />
        </button>
        <div className="pxp-ot">
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </div>
        {right}
      </header>
      <div className={`pxp-ob pxk-ob${bar ? ' bar' : ''}`}>{children}</div>
      {bar && <div className="pxs-bar">{bar}</div>}
    </div>
  );
}

/** The caisses money can go into, as chips. */
function IntoChips({ value, onChange, me }: { value: string; onChange: (k: string) => void; me?: boolean }) {
  const { t } = useTranslation();
  const list = useRpc('caisse.list', {}).data ?? [];
  return (
    <div className="pxv-chips pxk-into">
      {list.map((c) => (
        <button key={c.key} type="button" className={`pxv-chip${value === c.key ? ' on' : ''}`} aria-pressed={value === c.key} onClick={() => onChange(c.key)}>
          {c.key === 'main' ? (me ? t('caisse.ph.meMain') : t('caisse.ph.main')) : c.key === 'bank' ? t('caisse.ph.bank') : c.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the page (owner)
export function PhoneCaisse({ sub }: { sub?: string }) {
  const { t } = useTranslation();
  const tab = sub === 'done' || sub === 'journal' ? 'journal' : 'view';
  const q = useRpc('caisse.overview', {});
  const [sheet, setSheet] = useState<Kind | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [livreur, setLivreur] = useState<number | null>(null);
  const [caisse, setCaisse] = useState<string | null>(null);
  const d = q.data;
  return (
    <div className="pxk">
      <div className="pxv-own" role="tablist">
        <a role="tab" aria-selected={tab === 'view'} className={tab === 'view' ? 'on' : ''} href="#/caisse/due">
          {t('caisse.ph.view')}
        </a>
        <a role="tab" aria-selected={tab === 'journal'} className={tab === 'journal' ? 'on' : ''} href="#/caisse/done">
          {t('caisse.ph.journal')}
        </a>
      </div>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          <section className="pxk-main">
            <div className="pxk-mh">
              <span>{t('caisse.ph.main')}</span>
              {d.main.today !== 0 && <small className="ltr">{t('caisse.ph.today', { v: sgn(d.main.today) })}</small>}
            </div>
            <button type="button" className="pxk-big ltr" onClick={() => setCaisse('main')}>
              {da(d.main.balance)}
            </button>
            <div className="pxk-m3">
              <button type="button" onClick={() => setSheet('expense')}>
                − {t('caisse.ph.expense')}
              </button>
              <button type="button" onClick={() => setSheet('income')}>
                + {t('caisse.ph.income')}
              </button>
              <button type="button" onClick={() => setSheet('transfer')}>
                <Icon name="swap" /> {t('caisse.ph.transfer')}
              </button>
            </div>
          </section>

          {tab === 'journal' ? (
            <Journal caisse="main" />
          ) : (
            <>
              <button type="button" className="pxk-bank" onClick={() => setCaisse('bank')}>
                <Icon name="building" />
                <b>{t('caisse.ph.bank')}</b>
                <span className="ltr">{da(d.bank.balance)}</span>
                <Icon name="chevr" />
              </button>
              <div className="pxk-sect">
                {t('caisse.ph.outside')} <b className="ltr">{da(d.outside)}</b>
              </div>

              <div className="pxk-sect sm">
                {t('caisse.ph.companies')} <b className="ltr">{da(d.companies.reduce((s, c) => s + c.net, 0))}</b>
              </div>
              {d.companies.length ? (
                <ul className="pxk-grp">
                  {d.companies.map((c) => (
                    <li key={c.key}>
                      <button type="button" onClick={() => setCompany(c.key)}>
                        <span className={`pxs-co k-${c.kind ?? 'other'} pxk-co`}>{coShort(c.name)}</span>
                        <span className="pxk-rm">
                          <b>{c.name}</b>
                          <small>
                            {t('caisse.ph.parcels', { count: c.count })}
                            {days(c.oldest) ? ` · ${t('caisse.ph.oldest', { n: days(c.oldest) })}` : ''}
                          </small>
                          {c.payWaiting > 0 && <em className="pxk-paybadge ltr">{t('caisse.pay.waitingBadge', { v: da(c.payWaiting) })}</em>}
                        </span>
                        <b className="ltr pxk-amt">{da(c.net)}</b>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pxv-help">{t('caisse.ph.noCompany')}</p>
              )}

              <div className="pxk-sect sm">
                {t('caisse.ph.livreurs')} <b className="ltr">{da(d.livreurs.reduce((s, l) => s + l.net, 0))}</b>
              </div>
              <ul className="pxk-grp">
                {d.livreurs.map((l) => (
                  <li key={l.id}>
                    <button type="button" onClick={() => setLivreur(l.id)}>
                      <span className="pxk-av or">{initials(l.name)}</span>
                      <span className="pxk-rm">
                        <b>{l.name}</b>
                        <small>
                          {l.notCashed ? t('caisse.ph.notHanded', { count: l.notCashed }) : t('caisse.ph.nothingHeld')}
                          {l.last && l.notCashed ? ` · ${t('caisse.ph.lastHand', { n: days(l.last) })}` : ''}
                        </small>
                      </span>
                      <b className="ltr pxk-amt">{da(l.net)}</b>
                    </button>
                  </li>
                ))}
              </ul>

              <div className="pxk-sect sm">
                {t('caisse.ph.employees')} <b className="ltr">{da(d.employees.reduce((s, e) => s + e.balance, 0))}</b>
              </div>
              <ul className="pxk-grp">
                {d.employees.map((e) => (
                  <li key={e.key}>
                    <button type="button" onClick={() => setCaisse(e.key)}>
                      <span className="pxk-av">{initials(e.name)}</span>
                      <span className="pxk-rm">
                        <b>{e.name}</b>
                        <small>{e.role ? t(`roles.${e.role}`, { defaultValue: e.role }) : ''}</small>
                      </span>
                      <b className={`ltr pxk-amt${e.balance ? '' : ' z'}`}>{da(e.balance)}</b>
                    </button>
                  </li>
                ))}
              </ul>
              {d.tickets.count > 0 && <p className="pxv-help">{t('caisse.ph.tickets', { count: d.tickets.count, v: da(d.tickets.total) })}</p>}
            </>
          )}
        </>
      )}
      {sheet && <MoveSheet kind={sheet} from="main" onClose={() => setSheet(null)} />}
      {company && <CompanyPage gkey={company} onClose={() => setCompany(null)} />}
      {livreur && <LivreurPage id={livreur} onClose={() => setLivreur(null)} />}
      {caisse && <CaissePage caisse={caisse} onClose={() => setCaisse(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- a company: tick parcels, « Argent reçu »
function CompanyPage({ gkey, onClose }: { gkey: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('cash.due', {});
  const g = q.data?.groups.find((x) => x.key === gkey) ?? null;
  const [off, setOff] = useState<Set<number>>(new Set());
  const [into, setInto] = useState('main');
  const recv = useAction('cash.receive', { success: t('caisse.ph.received'), onDone: onClose });
  const orders = g?.orders ?? [];
  const chosen = orders.filter((o) => !off.has(o.id));
  const net = chosen.reduce((s, o) => s + o.net, 0);
  const collected = chosen.reduce((s, o) => s + o.total, 0);
  const toggle = (id: number) => setOff((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <Page
      title={g?.name ?? '…'}
      sub={g ? t('caisse.ph.dueSub', { count: g.count }) : undefined}
      right={g && <b className="ltr">{da(g.net)}</b>}
      onClose={onClose}
      bar={
        g && (
          <>
            <div className="pxv-lbl">{t('caisse.ph.receivedInto')}</div>
            <IntoChips value={into} onChange={setInto} />
            <button type="button" className="pxv-btn gr big" disabled={!chosen.length || recv.isPending} onClick={() => recv.mutate({ ids: chosen.map((o) => o.id), into: into as 'main' })}>
              <Icon name="check" /> {t('caisse.ph.receiveBtn', { v: da(net) })}
            </button>
          </>
        )
      }
    >
      {g?.companyId ? <CourierPay companyId={g.companyId} /> : null}
      {!g ? (
        q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />
      ) : (
        <>
          <div className="pxk-k3">
            <div>
              <small>{t('caisse.ph.collectedBy', { name: g.name })}</small>
              <b className="ltr">{da(collected)}</b>
            </div>
            <div>
              <small>{t('caisse.ph.fees')}</small>
              <b className="ltr bad">−{da(collected - net)}</b>
            </div>
            <div>
              <small>{t('caisse.ph.netToGet')}</small>
              <b className="ltr">{da(net)}</b>
            </div>
          </div>
          <button type="button" className="pxk-all" onClick={() => setOff(off.size ? new Set() : new Set(orders.map((o) => o.id)))}>
            <span className={`pxv-ck${!off.size ? ' on' : ''}`}>{!off.size && <Icon name="check" />}</span>
            <b>{t('caisse.ph.all', { n: orders.length })}</b>
            <small>{t('caisse.ph.oldestFirst')}</small>
          </button>
          <ul className="pxk-grp">
            {orders.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => toggle(o.id)}>
                  <span className={`pxv-ck${!off.has(o.id) ? ' on' : ''}`}>{!off.has(o.id) && <Icon name="check" />}</span>
                  <span className="pxk-rm">
                    <b>{o.customerName}</b>
                    <small>
                      <span className="ltr">{o.ref}</span> · {t('caisse.ph.deliveredAgo', { d: o.deliveredAt ? when(o.deliveredAt) : '—' })}
                      {days(o.deliveredAt) && days(o.deliveredAt)! >= 15 ? ` · ${days(o.deliveredAt)} j` : ''}
                    </small>
                  </span>
                  <b className="ltr pxk-amt">{n0(o.net)}</b>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
const n0 = (v: number) => da(v).replace(/\s?(DA|د\.ج)$/, '');

// ---------------------------------------------------------------- a livreur: « Encaisser »
function LivreurPage({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('cash.livreurs', { livreurId: id });
  const [into, setInto] = useState('main');
  const [off, setOff] = useState<Set<number>>(new Set());
  const take = useAction('cash.livreurCollect', { success: t('caisse.ph.collected'), onDone: onClose });
  const l = q.data?.livreurs.find((x) => x.id === id) ?? null;
  const list = (q.data?.delivered ?? []).filter((o) => o.livreurId === id && !o.cashed);
  const chosen = list.filter((o) => !off.has(o.id));
  const due = chosen.reduce((s, o) => s + o.total - o.share, 0);
  const toggle = (oid: number) => setOff((s) => (s.has(oid) ? new Set([...s].filter((x) => x !== oid)) : new Set([...s, oid])));
  return (
    <Page
      title={l?.name ?? '…'}
      sub={t('caisse.ph.livreur')}
      right={
        l?.phone ? (
          <a className="pxp-call big" href={`tel:${l.phone}`} aria-label={t('caisse.ph.call')}>
            <Icon name="phone" />
          </a>
        ) : undefined
      }
      onClose={onClose}
      bar={
        l && list.length > 0 && (
          <>
            <div className="pxv-lbl">{t('caisse.ph.takenBy')}</div>
            <IntoChips value={into} onChange={setInto} me />
            <button type="button" className="pxv-btn gr big" disabled={!chosen.length || take.isPending} onClick={() => take.mutate({ livreurId: id, ids: chosen.map((o) => o.id), into: into as 'main' })}>
              <Icon name="check" /> {t('caisse.ph.collectBtn', { v: da(due) })}
            </button>
          </>
        )
      }
    >
      {!l ? (
        q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />
      ) : (
        <>
          <section className="pxk-due">
            <span>{t('caisse.ph.mustHand')}</span>
            <b className="ltr">{da(l.net)}</b>
            <small>{t('caisse.ph.mustHandSub', { a: da(l.notCashedAmount), s: da(l.share) })}</small>
          </section>
          <div className="pxk-k3">
            <div>
              <small>{t('caisse.ph.inHand')}</small>
              <b>{l.inHand}</b>
            </div>
            <div>
              <small>{t('caisse.ph.notHandedK')}</small>
              <b>{l.notCashed}</b>
            </div>
            <div>
              <small>{t('caisse.ph.returns')}</small>
              <b>{l.returning}</b>
            </div>
          </div>
          {list.length ? (
            <ul className="pxk-grp">
              {list.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => toggle(o.id)}>
                    <span className={`pxv-ck${!off.has(o.id) ? ' on' : ''}`}>{!off.has(o.id) && <Icon name="check" />}</span>
                    <span className="pxk-rm">
                      <b>{o.customerName}</b>
                      <small>
                        <span className="ltr">{o.ref}</span> · {t('caisse.ph.share', { v: n0(o.share) })}
                      </small>
                    </span>
                    <b className="ltr pxk-amt">{n0(o.total)}</b>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pxv-help">{t('caisse.ph.nothingHeld')}</p>
          )}
        </>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- a caisse (main, bank, employee)
function CaissePage({ caisse, onClose }: { caisse: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.view', { caisse: caisse as 'main' });
  const [sheet, setSheet] = useState<Kind | null>(null);
  const emp = caisse.startsWith('u');
  const d = q.data;
  return (
    <Page title={d ? (caisse === 'main' ? t('caisse.ph.main') : caisse === 'bank' ? t('caisse.ph.bank') : d.name) : '…'} sub={emp ? t('caisse.ph.empCaisse') : undefined} right={d && <b className="ltr">{da(d.balance)}</b>} onClose={onClose}>
      <div className="pxk-acts">
        {emp ? (
          <>
            <button type="button" className="nv" onClick={() => setSheet('transfer')}>
              <Icon name="swap" /> {t('caisse.ph.handToMain')}
            </button>
            <button type="button" onClick={() => setSheet('expense')}>
              − {t('caisse.ph.expense')}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setSheet('expense')}>
              − {t('caisse.ph.expense')}
            </button>
            <button type="button" onClick={() => setSheet('income')}>
              + {t('caisse.ph.income')}
            </button>
            <button type="button" className="nv" onClick={() => setSheet('transfer')}>
              <Icon name="swap" /> {t('caisse.ph.transfer')}
            </button>
          </>
        )}
      </div>
      <Journal caisse={caisse} data={d} />
      {sheet && <MoveSheet kind={sheet} from={caisse} to={emp && sheet === 'transfer' ? 'main' : undefined} onClose={() => setSheet(null)} />}
    </Page>
  );
}

/** The movements of a caisse, by day; a tap on a move offers to cancel it (owner). */
function Journal({ caisse, data, mine }: { caisse: string; data?: { moves: Move[]; monthIn: number; monthOut: number; balance: number }; mine?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.view', { caisse: caisse as 'main' }, { enabled: !data && !mine });
  const d = data ?? q.data;
  const [f, setF] = useState<'all' | 'in' | 'out' | 'transfer'>('all');
  const [pick, setPick] = useState<Move | null>(null);
  const moves = (d?.moves ?? []).filter((m) => (f === 'all' ? true : f === 'transfer' ? m.kind === 'transfer' : f === 'in' ? m.amount > 0 && m.kind !== 'transfer' : m.amount < 0 && m.kind !== 'transfer'));
  const byDay = useMemo(() => {
    const out: [string, Move[]][] = [];
    for (const m of moves) {
      const k = m.at.slice(0, 10);
      const last = out[out.length - 1];
      if (last && last[0] === k) last[1].push(m);
      else out.push([k, [m]]);
    }
    return out;
  }, [moves]);
  if (!d) return <Loading />;
  return (
    <>
      <div className="pxk-k3">
        <div>
          <small>{t('caisse.ph.monthIn')}</small>
          <b className="ltr ok">{sgn(d.monthIn)}</b>
        </div>
        <div>
          <small>{t('caisse.ph.monthOut')}</small>
          <b className="ltr bad">{sgn(d.monthOut)}</b>
        </div>
        <div>
          <small>{t('caisse.ph.balance')}</small>
          <b className="ltr">{da(d.balance)}</b>
        </div>
      </div>
      <div className="pxv-road">
        {(['all', 'in', 'out', 'transfer'] as const).map((k) => (
          <button key={k} type="button" className={f === k ? 'on' : ''} onClick={() => setF(k)}>
            {t(`caisse.ph.f.${k}`)}
          </button>
        ))}
      </div>
      {!moves.length ? (
        <p className="pxv-help">{t('caisse.ph.noMove')}</p>
      ) : (
        byDay.map(([day, ms]) => (
          <div key={day} className="pxk-day">
            <div className="pxk-dh">{dayLabel(ms[0].at)}</div>
            <ul className="pxk-grp">
              {ms.map((m) => {
                const tone = m.kind === 'transfer' ? 'tr' : m.amount > 0 ? 'in' : 'out';
                return (
                  <li key={m.id}>
                    <button type="button" onClick={() => m.moveId && setPick(m)} className={m.moveId ? '' : 'static'}>
                      <span className={`pxk-mi ${tone}`}>{tone === 'tr' ? <Icon name="swap" /> : tone === 'in' ? '+' : '−'}</span>
                      <span className="pxk-rm">
                        <b>
                          {m.kind === 'receipt'
                            ? t('caisse.ph.mv.receipt', { name: m.label })
                            : m.kind === 'transfer'
                              ? m.label
                              : m.category
                                ? t(`caisse.cat.${m.category}`)
                                : m.label || t(`caisse.ph.mv.${m.kind}`)}
                        </b>
                        <small>
                          {[m.sub, m.kind !== 'receipt' && m.kind !== 'transfer' && m.category ? m.note : m.kind === 'transfer' ? m.note : null, m.byName].filter(Boolean).join(' · ')}
                        </small>
                      </span>
                      <b className={`ltr pxk-amt ${tone === 'tr' ? 'tr' : tone === 'in' ? 'ok' : 'bad'}`}>{sgn(m.amount)}</b>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      {pick && <CancelMove m={pick} onClose={() => setPick(null)} />}
    </>
  );
}

function CancelMove({ m, onClose }: { m: Move; onClose: () => void }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const cancel = useAction('caisse.cancel', { success: t('caisse.ph.cancelled'), onDone: onClose });
  return (
    <Sheet title={sgn(m.amount)} onClose={onClose}>
      <p className="pxv-help">
        {m.label || (m.category ? t(`caisse.cat.${m.category}`) : '')} · {when(m.at)}
        {m.byName ? ` · ${m.byName}` : ''}
      </p>
      {m.note && <p className="pxk-note">{m.note}</p>}
      {session?.isAdmin ? (
        <button type="button" className="pxv-btn bad big" disabled={cancel.isPending || !m.moveId} onClick={() => m.moveId && cancel.mutate({ id: m.moveId })}>
          {t('caisse.ph.cancelMove')}
        </button>
      ) : (
        <p className="pxv-help">{t('caisse.ph.askOwner')}</p>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- expense / entry / transfer
function MoveSheet({ kind: kind0, from: from0, to: to0, mine, onClose }: { kind: Kind; from: string; to?: string; mine?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [kind] = useState(kind0);
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState<string>('');
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
    <Sheet title={t(`caisse.ph.new.${kind}`)} onClose={onClose}>
      <label className="pxk-amount">
        <input type="number" inputMode="numeric" min={1} autoFocus value={amount} placeholder="0" aria-label={t('caisse.ph.amount')} onChange={(e) => setAmount(e.target.value)} />
        <span>DA</span>
      </label>
      {kind === 'expense' && (
        <>
          <div className="pxv-lbl">{t('caisse.ph.category')}</div>
          <div className="pxv-chips">
            {CATS.map((c) => (
              <button key={c} type="button" className={`pxv-chip${cat === c ? ' on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>
                {t(`caisse.cat.${c}`)}
              </button>
            ))}
          </div>
        </>
      )}
      {!mine && (
        <>
          <div className="pxv-lbl">{kind === 'transfer' ? t('caisse.ph.from') : kind === 'expense' ? t('caisse.ph.paidFrom') : t('caisse.ph.into')}</div>
          <IntoChips value={from} onChange={setFrom} />
        </>
      )}
      {kind === 'transfer' && !to0 && (
        <>
          <div className="pxv-lbl">{t('caisse.ph.to')}</div>
          <IntoChips value={to} onChange={setTo} />
        </>
      )}
      <input className="pxv-in" value={note} maxLength={300} placeholder={t('caisse.ph.notePh')} onChange={(e) => setNote(e.target.value)} />
      <button type="button" className={`pxv-btn big ${kind === 'expense' ? 'or' : kind === 'income' ? 'gr' : 'nv'}`} disabled={!ok || add.isPending || tr.isPending} onClick={save}>
        {t(`caisse.ph.save.${kind}`, { v: v ? da(v) : '' })}
      </button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- « Ma caisse » (employees)
export function MaCaisse() {
  const { t } = useTranslation();
  const q = useRpc('caisse.mine', {});
  const [sheet, setSheet] = useState<Kind | null>(null);
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Loading />;
  return (
    <div className="pxk">
      <section className="pxk-main">
        <div className="pxk-mh">
          <span>{t('caisse.ph.myCaisse')}</span>
        </div>
        <b className="pxk-big ltr">{da(d.balance)}</b>
        <div className="pxk-m3">
          <button type="button" onClick={() => setSheet('expense')}>
            − {t('caisse.ph.expense')}
          </button>
          <button type="button" onClick={() => setSheet('income')}>
            + {t('caisse.ph.income')}
          </button>
          <button type="button" onClick={() => setSheet('transfer')}>
            <Icon name="swap" /> {t('caisse.ph.handShort')}
          </button>
        </div>
      </section>
      <p className="pxv-help">{t('caisse.ph.myHelp')}</p>
      <Journal caisse={d.key} data={d} mine />
      {sheet && <MoveSheet kind={sheet} from={d.key} to={sheet === 'transfer' ? 'main' : undefined} mine onClose={() => setSheet(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- a company's payments through its API (ZR)
/** A payment request still waiting: another date (from tomorrow), or withdraw it. */
function ReqActions({ id, date }: { id: number; date: string | null }) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState(false);
  const min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [d, setD] = useState(date && date >= min ? date : min);
  const move = useAction('caisse.payRequestDate', { success: (r) => t('caisse.pay.dateMoved', { d: dateOnly(r.date) }), onDone: () => setEdit(false) });
  const drop = useAction('caisse.payRequestCancel', { success: t('caisse.pay.requestCancelled') });
  if (edit)
    return (
      <div className="pxk-reqa">
        <input type="date" value={d} min={min} onChange={(e) => setD(e.target.value)} aria-label={t('caisse.pay.newDate')} />
        <button type="button" className="btn small primary" disabled={move.isPending || !d} onClick={() => move.mutate({ id, date: d })}>
          {t('common.save')}
        </button>
        <button type="button" className="btn small ghost" onClick={() => setEdit(false)}>
          {t('common.cancel')}
        </button>
      </div>
    );
  return (
    <div className="pxk-reqa">
      <button type="button" className="btn small" onClick={() => setEdit(true)}>
        <Icon name="calendar" /> {t('caisse.pay.changeDate')}
      </button>
      <button type="button" className="btn small ghost" disabled={drop.isPending} onClick={() => drop.mutate({ id })}>
        {t('caisse.pay.cancelRequest')}
      </button>
    </div>
  );
}

type Pay = Extract<Out<'caisse.pay'>, { supported: true }>['payments'][number];
const DETAILS = ['parcelsDelivered', 'parcelsCancelled', 'refundsCredited', 'refundsDebited', 'labeling', 'officeHolding', 'storage'] as const;

function CourierPay({ companyId }: { companyId: number }) {
  const { t } = useTranslation();
  const q = useRpc('caisse.pay', { companyId });
  const sync = useAction('caisse.paySync', { success: (r) => (r.imported ? t('caisse.pay.imported', { count: r.imported }) : r.requested ? t('caisse.pay.requestedNow') : t('caisse.pay.upToDate')) });
  const ask = useAction('caisse.payRequest', { success: (r) => t('caisse.pay.requestSent', { d: r.date }) });
  const [open, setOpen] = useState<Pay | null>(null);
  const [take, setTake] = useState<Pay | null>(null);
  const [cfg, setCfg] = useState(false);
  const d = q.data;
  if (!d || !d.supported) return null;
  const pending = d.requests.find((r) => r.approved === null);
  const waiting = d.payments.filter((p) => !p.inCaisse);
  const done = d.payments.filter((p) => p.inCaisse);
  return (
    <section className="pxk-pay">
      <div className="pxk-payh">
        <b>{t('caisse.pay.title', { name: d.name })}</b>
        <button type="button" className="pxp-back" aria-label={t('caisse.pay.refresh')} disabled={sync.isPending} onClick={() => sync.mutate({ companyId })}>
          <Icon name="refresh" />
        </button>
        <button type="button" className="pxp-back" aria-label={t('caisse.pay.settings')} onClick={() => setCfg(true)}>
          <Icon name="settings" />
        </button>
      </div>
      {d.balance?.error && <p className="pxk-payerr">{d.balance.error}</p>}
      {d.balance && (
        <div className="pxk-k3">
          <div>
            <small>{t('caisse.pay.ready')}</small>
            <b className="ltr ok">{da(d.balance.ready)}</b>
          </div>
          <div>
            <small>{t('caisse.pay.notReady')}</small>
            <b className="ltr">{da(d.balance.notReady)}</b>
          </div>
          <div>
            <small>{t('caisse.pay.paid')}</small>
            <b className="ltr">{da(d.balance.paid)}</b>
          </div>
        </div>
      )}
      {pending ? (
        <div className="pxk-req">
          <Icon name="hourglass" />
          <span>
            <b>{t('caisse.pay.pending', { d: pending.date ? dateOnly(pending.date) : '—' })}</b>
            <small>{pending.auto ? t('caisse.pay.byPilotix') : t('caisse.pay.byHand')}</small>
          </span>
          <ReqActions id={pending.id} date={pending.date} />
        </div>
      ) : (
        <button type="button" className="pxv-btn nv" disabled={ask.isPending} onClick={() => ask.mutate({ companyId })}>
          <Icon name="coins" /> {t('caisse.pay.ask')}
        </button>
      )}
      <p className="pxv-help">{d.cfg.auto ? t('caisse.pay.autoOn', { caisse: d.cfgName }) : t('caisse.pay.autoOff', { caisse: d.cfgName })}</p>
      {waiting.map((p) => (
        <div key={p.id} className="pxk-paywait">
          <button type="button" className="pxk-payrow" onClick={() => setOpen(p)}>
            <span className="pxk-mi tr">
              <Icon name="coins" />
            </span>
            <span className="pxk-rm">
              <b>
                {p.ref ?? t('caisse.pay.payment')} · <span className="ltr">{da(p.amount)}</span>
              </b>
              <small>{p.done ? t('caisse.pay.doneNotIn') : t('caisse.pay.waitingAt', { place: p.place ?? 'ZR' })}</small>
            </span>
          </button>
          <button type="button" className="pxv-btn gr" onClick={() => setTake(p)}>
            <Icon name="check" /> {t('caisse.pay.receivedBtn')}
          </button>
        </div>
      ))}
      {done.length > 0 && (
        <ul className="pxk-grp">
          {done.slice(0, 6).map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setOpen(p)}>
                <span className="pxk-mi in">
                  <Icon name="check" />
                </span>
                <span className="pxk-rm">
                  <b>{p.ref ?? t('caisse.pay.payment')}</b>
                  <small>
                    {when(p.doneAt ?? p.at)} · {t('caisse.pay.intoCaisse', { caisse: p.caisse ?? '—' })} · {t('caisse.ph.parcels', { count: p.matched })}
                  </small>
                </span>
                <b className="ltr pxk-amt ok">+{da(p.amount)}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <PayDetail p={open} onClose={() => setOpen(null)} />}
      {take && <PayTake p={take} into={d.cfg.into} onClose={() => setTake(null)} />}
      {cfg && <PayConfig companyId={companyId} cfg={d.cfg} onClose={() => setCfg(false)} />}
    </section>
  );
}

function PayDetail({ p, onClose }: { p: Pay; onClose: () => void }) {
  const { t } = useTranslation();
  const lines = useRpc('caisse.payLines', { id: p.id });
  return (
    <Sheet title={`${p.ref ?? t('caisse.pay.payment')} · ${da(p.amount)}`} onClose={onClose}>
      <p className="pxv-help">
        {when(p.at)}
        {p.place ? ` · ${p.place}` : ''} · {p.status || '—'}
        {p.inCaisse && p.caisse ? ` · ${t('caisse.pay.intoCaisse', { caisse: p.caisse })}` : ''}
      </p>
      <div className="pxk-det">
        {DETAILS.filter((k) => (p.details[k] ?? 0) !== 0).map((k) => (
          <div key={k}>
            <small>{t(`caisse.pay.d.${k}`)}</small>
            <b className="ltr">{k.startsWith('parcels') ? p.details[k] : da(p.details[k])}</b>
          </div>
        ))}
      </div>
      <div className="pxv-lbl">{t('caisse.pay.parcelsTitle')}</div>
      {!lines.data ? (
        <Loading />
      ) : !lines.data.length ? (
        <p className="pxv-help">{t('caisse.pay.noLines')}</p>
      ) : (
        <ul className="pxk-grp pxk-lines">
          {lines.data.map((l, k) => (
            <li key={k}>
              <span className="pxk-line">
                <span className="pxk-rm">
                  <b>{l.customer || l.tracking}</b>
                  <small>
                    <span className="ltr">{l.ref ?? l.tracking}</span> · {l.type}
                    {l.costs ? ` · −${n0(l.costs)}` : ''}
                    {!l.ref ? ` · ${t('caisse.pay.unknown')}` : ''}
                  </small>
                </span>
                <b className={`ltr pxk-amt ${l.amount < 0 ? 'bad' : ''}`}>{n0(l.amount)}</b>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function PayTake({ p, into: into0, onClose }: { p: Pay; into: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [into, setInto] = useState(into0);
  const take = useAction('caisse.payReceive', { success: (r) => t('caisse.pay.takenOk', { count: r.matched }), onDone: onClose });
  return (
    <Sheet title={`${p.ref ?? t('caisse.pay.payment')} · ${da(p.amount)}`} onClose={onClose}>
      <p className="pxv-help">{p.done ? t('caisse.pay.takeHelpDone') : t('caisse.pay.takeHelp')}</p>
      <div className="pxv-lbl">{t('caisse.ph.receivedInto')}</div>
      <IntoChips value={into} onChange={setInto} />
      <button type="button" className="pxv-btn gr big" disabled={take.isPending} onClick={() => take.mutate({ id: p.id, into: into as 'main' })}>
        <Icon name="check" /> {t('caisse.ph.receiveBtn', { v: da(p.amount) })}
      </button>
    </Sheet>
  );
}

function PayConfig({ companyId, cfg, onClose }: { companyId: number; cfg: { auto: boolean; into: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const [auto, setAuto] = useState(cfg.auto);
  const [into, setInto] = useState(cfg.into);
  const save = useAction('caisse.payConfig', { success: t('common.saved', { defaultValue: 'OK' }), onDone: onClose });
  return (
    <Sheet title={t('caisse.pay.settings')} onClose={onClose}>
      <label className="pxk-tog">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span>
          <b>{t('caisse.pay.autoLabel')}</b>
          <small>{t('caisse.pay.autoHelp')}</small>
        </span>
      </label>
      <div className="pxv-lbl">{t('caisse.pay.intoLabel')}</div>
      <IntoChips value={into} onChange={setInto} />
      <button type="button" className="pxv-btn nv big" disabled={save.isPending} onClick={() => save.mutate({ companyId, auto, into: into as 'main' })}>
        {t('caisse.pay.save')}
      </button>
    </Sheet>
  );
}
