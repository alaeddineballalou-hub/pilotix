// Commandes › Annulé › Retours: « Qui est responsable » (design 2 « Classement », the owner's choice, 25 Nov 2026) —
// the teams from the most returns to the least, a bar each (one colour; the customer, nobody's fault, in grey apart),
// one team opened: what happened, who (names of the viewer's own team only), the money lost. The « Pas moi » waiting.
// And on each order of the list: its responsible team (a name only where the viewer may see it), « Préciser » when
// nobody said what happened yet.
import type { FaultTeam } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n, pct } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Icon } from '../../ui/kit';
import { FaultSheet } from './FaultSheet';
import { DecideSheet, TEAM_ICON, TeamChip } from './parts';
import './faults.css';

type Sum = Extract<Out<'faults.summary'>, { scope: 'all' | 'manager' }>;

export function Responsible({ range, label }: { range: { from: string; to: string }; label: string | null }) {
  const q = useRpc('faults.summary', range);
  const d = q.data;
  if (!d || d.scope === 'mine') return null;
  return <Card d={d as Sum} label={label} />;
}

function Card({ d, label }: { d: Sum; label: string | null }) {
  const { t } = useTranslation();
  const all = [...d.teams].sort((a, b) => b.n - a.n);
  // the teams with returns, ranked; those with none in one quiet line under them
  const teams = all.filter((x) => x.n > 0);
  const zero = all.filter((x) => !x.n);
  const [open, setOpen] = useState<string | null>(() => (d.scope === 'all' ? teams[0]?.team ?? null : null));
  const [deciding, setDeciding] = useState(false);
  const max = Math.max(1, d.client.n, ...teams.map((x) => x.n));
  const share = (v: number) => pct(d.returns ? v / d.returns : null);
  return (
    <section className="pxn-card pxfa-card" aria-labelledby="pxfa-h">
      <header className="pxn-h">
        <h3 id="pxfa-h">{t('faults.card.title')}</h3>
        <span>{[label, t('faults.card.sub', { count: d.returns })].filter(Boolean).join(' · ')}</span>
      </header>
      {d.returns === 0 ? (
        <p className="pxn-empty">{t('faults.card.none')}</p>
      ) : (
        <>
          <p className="pxfa-sub">{t('faults.card.bars')}</p>
          <div className="pxfa-rows">
            {teams.map((x) => {
              const on = open === x.team;
              return (
                <div key={x.team}>
                  <button type="button" className={`pxfa-r ${on ? 'open' : ''}`} aria-expanded={on} onClick={() => setOpen(on ? null : x.team)}>
                    <span className="pxfa-n">
                      <Icon name={TEAM_ICON[x.team as FaultTeam]} />
                      {t(`faults.team.${x.team}`)}
                    </span>
                    <span className="pxfa-t" aria-hidden="true">
                      <i style={{ width: `${x.n ? Math.max(3, (x.n / max) * 100) : 0}%` }} />
                    </span>
                    <b className="ltr">{n(x.n)}</b>
                    <small className="ltr">{share(x.n)}</small>
                  </button>
                  {on && x.n > 0 && (
                    <div className="pxfa-x">
                      <div>
                        <h5>{t('faults.card.what')}</h5>
                        {x.reasons.map((r) => (
                          <div key={r.reason} className="pxfa-kv">
                            <span>{t(`faults.reason.${r.reason}`)}</span>
                            <b className="ltr">{n(r.n)}</b>
                          </div>
                        ))}
                      </div>
                      {x.people ? (
                        x.people.length > 0 && (
                          <div>
                            <h5>{t('faults.card.who')}</h5>
                            {x.people.map((p) => {
                              const top = Math.max(1, ...x.people!.map((y) => y.n));
                              return (
                                <div key={p.name} className="pxfa-p">
                                  <span>{p.name}</span>
                                  <span className="pxfa-t" aria-hidden="true">
                                    <i style={{ width: `${Math.max(4, (p.n / top) * 100)}%` }} />
                                  </span>
                                  <span className="ltr">{p.of ? `${n(p.n)} · ${pct(p.n / p.of, 1)}` : n(p.n)}</span>
                                </div>
                              );
                            })}
                          </div>
                        )
                      ) : (
                        <p className="pxfa-hide">
                          <Icon name="lock" /> {t('faults.card.hidden')}
                        </p>
                      )}
                      <div className="pxfa-kv">
                        <span>{t('faults.card.lost')}</span>
                        <b className="ltr">{da(x.cost)}</b>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {zero.length > 0 && <p className="pxfa-zero">{t('faults.card.zero', { list: zero.map((x) => t(`faults.team.${x.team}`)).join(' · ') })}</p>}
            <p className="pxfa-sep">{t('faults.card.notOurs')}</p>
            <div className="pxfa-r static">
              <span className="pxfa-n">
                <Icon name="user" />
                {t('faults.team.client')}
              </span>
              <span className="pxfa-t" aria-hidden="true">
                <i className="c" style={{ width: `${d.client.n ? Math.max(3, (d.client.n / max) * 100) : 0}%` }} />
              </span>
              <b className="ltr">{n(d.client.n)}</b>
              <small className="ltr">{share(d.client.n)}</small>
            </div>
            {d.unknown > 0 && (
              <div className="pxfa-r static">
                <span className="pxfa-n">
                  <Icon name="help" />
                  {t('faults.team.unknown')}
                </span>
                <small style={{ textAlign: 'start' }}>{t('faults.card.unknownSub')}</small>
                <b className="ltr">{n(d.unknown)}</b>
                <small className="ltr">{share(d.unknown)}</small>
              </div>
            )}
          </div>
          {d.waiting.length > 0 && (
            <button type="button" className="pxfa-dec" onClick={() => setDeciding(true)}>
              <Icon name="flag" />
              {d.canDecide ? t('faults.card.waiting') : t('faults.card.waitingTeam')}
              <small className="ltr">{n(d.waiting.length)} ›</small>
            </button>
          )}
          <p className="pxfa-note">
            <Icon name={d.scope === 'all' ? 'settings' : 'lock'} /> {d.scope === 'all' ? t('faults.card.noteAll') : t('faults.card.noteManager')}
          </p>
        </>
      )}
      {deciding && <DecideSheet list={d.waiting} canDecide={d.canDecide} onClose={() => setDeciding(false)} />}
    </section>
  );
}

export type Shown = Out<'faults.forOrders'>[string];

/** The responsible of each order of a list (one ask for the whole page). */
export function useFaults(ids: number[], on: boolean): (id: number) => Shown | undefined {
  const q = useRpc('faults.forOrders', { ids }, { enabled: on && ids.length > 0, staleTime: 30_000 });
  return (id) => q.data?.[String(id)];
}

/** « Responsable : Dépôt · Karim » on an order's card, « Préciser » when nobody said what happened. */
export function RespLine({ s, orderId }: { s: Shown; orderId: number }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const [open, setOpen] = useState(false);
  const can = has('suivi', 'sav', 'agent_manager', 'depot');
  return (
    <span className="pxfa-resp" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {t('faults.resp')}
      <TeamChip team={s.team} who={s.who} mine={s.mine} />
      {s.contested && (
        <span className="pxfa-flag">
          <Icon name="flag" /> {t('faults.contest.button')}
        </span>
      )}
      {s.team === 'unknown' && can && (
        <button type="button" className="pxfa-mini" onClick={() => setOpen(true)}>
          <Icon name="pencil" /> {t('faults.precise')}
        </button>
      )}
      {open && <FaultSheet orderId={orderId} moment={s.moment === 'sav' ? 'sav' : 'return'} onClose={() => setOpen(false)} />}
    </span>
  );
}
