// Landing pages › Réglages › « Team et fournisseurs » (the owner only): a switch for each list, and its numbers.
//  - Team: their orders on the pages are tests (never blocked, nothing sent to Meta, counted nowhere: Protection ›
//    « Tests de l'équipe »), and they still see the ads.
//  - Fournisseurs: their orders are blocked without them knowing, and they are left out of the ads.
// The numbers of the team's Pilotix accounts and of Stock › Fournisseurs count by themselves; others are added here.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Out } from '../../lib/backend';
import { da, dateTime, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Empty, Icon, RemovableChip } from '../../ui/kit';

type Data = Out<'landing.lists.get'>;
type Kind = 'team' | 'supplier';
type Num = { phone: string; name: string };

const chip = (x: Num) => (x.name ? `${x.name} · ${x.phone}` : x.phone);

export function TeamLists() {
  const { t } = useTranslation();
  const q = useRpc('landing.lists.get', {}, { refetchOnWindowFocus: false });
  const d = q.data;
  if (!d) return null;
  return (
    <section className="card lp-tm">
      <h2>
        <Icon name="users" /> {t('landing.tm.title')}
      </h2>
      <p className="muted">{t('landing.tm.sub')}</p>
      <List kind="team" d={d} onChange={() => q.refetch()} />
      <List kind="supplier" d={d} onChange={() => q.refetch()} />
      <p className="pd-note">{t('landing.tm.both')}</p>
    </section>
  );
}

function List({ kind, d, onChange }: { kind: Kind; d: Data; onChange: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const team = kind === 'team';
  const on = team ? d.team.on : d.suppliers.on;
  const auto: Num[] = team ? d.team.accounts : d.suppliers.stock;
  const added = team ? d.team.added : d.suppliers.added;
  const toggle = useAction('landing.lists.save', { success: t('landing.tm.saved'), onDone: onChange });
  const add = useAction('landing.lists.add', {
    success: t('landing.tm.addedOk'),
    onDone: () => {
      setName('');
      setPhone('');
      onChange();
    },
  });
  const remove = useAction('landing.lists.remove', { success: t('landing.tm.removed'), onDone: onChange });
  return (
    <div className={`lp-tm-list ${on ? 'on' : ''}`}>
      <label className="lp-switch">
        <input type="checkbox" checked={on} disabled={toggle.isPending} onChange={(e) => toggle.mutate(team ? { team: e.target.checked } : { suppliers: e.target.checked })} />
        <span>
          <b>
            <Icon name={team ? 'users' : 'truck'} /> {team ? t('landing.tm.team') : t('landing.tm.suppliers')}
            <span className={`chip ${on ? 'lp-on' : ''}`}>{on ? t('landing.tm.on') : t('landing.tm.off')}</span>
          </b>
          <small>{team ? t('landing.tm.teamHelp') : t('landing.tm.suppliersHelp')}</small>
        </span>
      </label>
      {!team && on && !d.adsList && <p className="lp-warn-note">{t('landing.tm.adsOff')}</p>}
      <div className="lp-tm-groups">
        <div>
          <h3>{team ? t('landing.tm.accounts', { count: auto.length }) : t('landing.tm.stock', { count: auto.length })}</h3>
          {auto.length ? (
            <div className="lp-tm-chips">
              {auto.map((x) => (
                <RemovableChip key={x.phone} name={chip(x)} />
              ))}
            </div>
          ) : (
            <p className="muted small">{team ? t('landing.tm.accountsNone') : t('landing.tm.stockNone')}</p>
          )}
        </div>
        <div>
          <h3>{t('landing.tm.added', { count: added.length })}</h3>
          {added.length ? (
            <div className="lp-tm-chips">
              {added.map((x) => (
                <RemovableChip key={x.phone} name={chip(x)} disabled={remove.isPending} onRemove={() => remove.mutate({ kind, phone: x.phone })} />
              ))}
            </div>
          ) : (
            <p className="muted small">{t('landing.tm.addedNone')}</p>
          )}
        </div>
      </div>
      <form
        className="lp-tm-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (phone.trim()) add.mutate({ kind, phone: phone.trim(), name: name.trim() });
        }}
      >
        <input dir="auto" value={name} maxLength={80} placeholder={t('landing.tm.name')} aria-label={t('landing.tm.name')} onChange={(e) => setName(e.target.value)} />
        <input className="ltr" type="tel" inputMode="tel" maxLength={20} value={phone} placeholder="0661 23 45 67" aria-label={t('landing.tm.phone')} onChange={(e) => setPhone(e.target.value)} />
        <button type="submit" className="btn" disabled={!phone.trim() || add.isPending}>
          <Icon name="check" /> {t('landing.tm.add')}
        </button>
      </form>
    </div>
  );
}

/** Landing pages › Protection › « Tests de l'équipe »: the Team's orders on the pages (never real orders). Hidden while
 *  Team is off and nothing was ever tested. */
export function TeamTests() {
  const { t } = useTranslation();
  const q = useRpc('landing.tests', { limit: 50 });
  const d = q.data;
  if (!d || (!d.on && !d.total)) return null;
  return (
    <section className="card pd-card">
      <h2 className="lp-h2">
        <Icon name="beaker" /> {t('landing.tm.tests')} {d.total > 0 && <span className="chip">{n(d.total)}</span>}
      </h2>
      <p className="pd-note">{d.on ? t('landing.tm.testsHelp') : t('landing.tm.testsOff')}</p>
      {!d.tests.length ? (
        <Empty>{t('landing.tm.testsNone')}</Empty>
      ) : (
        <div className="pd-list">
          {d.tests.map((x) => (
            <div key={x.id} className="pd-row lp-mk">
              <span className="chip lp-on">{t('landing.tm.test')}</span>
              <span className="pd-name">
                <b>
                  {x.name || '—'} <span className="ltr">{x.phone}</span>
                </b>
                <small>
                  <span>
                    {x.title ?? '—'}
                    {x.variant ? ` · ${x.variant}` : ''}
                  </span>
                  <span className="ltr">
                    ×{x.qty} · {da(x.total)}
                  </span>
                  {x.fromAd && <span>{t('landing.tm.fromAd')}</span>}
                </small>
              </span>
              <span className="muted small">{dateTime(x.at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
