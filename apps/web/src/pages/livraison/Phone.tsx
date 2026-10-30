// « Sociétés de livraison » on phones: one row per company (its logo, the connection in one word, what waits to ship and
// what is on the road); a tap opens the company — its numbers and every action as a clear list (Tarifs, Stop desks,
// Statuts, Feuille de route, Tester, Aperçu, ZR depuis Pilotix, Modifier). « + Ajouter » picks the company type first.
// Livreurs: one row each (where the tournée ends, parcels to ship / on the road), a tap opens call / edit / route sheet.
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AskCall } from '../confirmation/History';
import { Preferences } from './Preferences';
import { Pilot } from './Pilot';
import type { Out } from '../../lib/backend';
import { wilaya } from '../../lib/format';
import { useFullScreen } from '../../lib/fullScreen';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { LivreursCash } from '../caisse/LivreursCash';
import type { Company, CompanyDraft } from './forms';
import { cardSub, cardTitle, countOf, draftOf, searchCards } from './carriers';
import { CompanyLogo, CourierLogo } from './CourierLogo';
import { courierCardOf } from '@pilotix/shared';
import '../confirmation/phone.css';
import '../suivi/phone.css';
import '../sav/phone.css';
import '../caisse/phone.css';
import './phone.css';

type Kinds = Out<'delivery.kinds'>;
type Open = 'fees' | 'desks' | 'statuses' | 'preview' | 'zr' | 'live';
type Livreur = Out<'delivery.livreurs'>[number];
const isApi = (c: Company) => !['own', 'manual'].includes(c.kind);
const short = (name: string) => name.replace(/express|livraison|coursier/gi, '').trim().slice(0, 3).toUpperCase() || name.slice(0, 2).toUpperCase();

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

function Page({ title, sub, right, onClose, children }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  useFullScreen(onClose);
  return (
    <div className="pxp-order" role="dialog" aria-modal="true">
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
      <div className="pxp-ob pxl-ob">{children}</div>
    </div>
  );
}

/** The connection in one word: keys OK / keys missing / without API; off when inactive. */
function Conn({ c }: { c: Company }) {
  const { t } = useTranslation();
  if (!c.active) return <span className="pxl-st off">{t('livraison.inactive')}</span>;
  if (!isApi(c)) return <span className="pxl-st na">{t('livraison.noApi')}</span>;
  return <span className={`pxl-st ${c.hasKeys ? 'ok' : 'bad'}`}>{c.hasKeys ? t('livraison.keysOk') : t('livraison.keysMissing')}</span>;
}

export function PhoneLivraison({
  current,
  companies,
  kinds,
  onEdit,
  onOpen,
  onAdd,
  onSheet,
}: {
  current: 'societes' | 'pilot' | 'api' | 'livreurs' | 'preferences';
  companies: ReturnType<typeof useRpc<'delivery.companies'>>;
  kinds: ReturnType<typeof useRpc<'delivery.kinds'>>;
  onEdit: (c: Company) => void;
  onOpen: (k: Open, c: Company) => void;
  onAdd: (d: CompanyDraft) => void;
  onSheet: (by: { companyId?: number; livreurId?: number }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="pxl">
      <div className="pxv-own pxl-tabs" role="tablist">
        {(['societes', 'pilot', 'api', 'livreurs', 'preferences'] as const).map((k) => (
          <a key={k} role="tab" aria-selected={current === k} className={current === k ? 'on' : ''} href={`#/livraison/${k}`}>
            {t(`livraison.ph.tab.${k}`)}
          </a>
        ))}
      </div>
      {current === 'preferences' ? (
        <Preferences />
      ) : current === 'pilot' ? (
        <Pilot />
      ) : current === 'livreurs' ? (
        <Livreurs companies={companies.data ?? []} onSheet={onSheet} />
      ) : companies.error ? (
        <ErrorBox error={companies.error} onRetry={() => companies.refetch()} />
      ) : !companies.data || !kinds.data ? (
        <Loading />
      ) : current === 'api' ? (
        <Carriers list={companies.data} kinds={kinds.data} onAdd={onAdd} onOpen={(c) => onEdit(c)} />
      ) : (
        <Companies list={companies.data} kinds={kinds.data} onEdit={onEdit} onOpen={onOpen} onAdd={onAdd} onSheet={onSheet} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- companies
function Companies({ list, kinds, onEdit, onOpen, onAdd, onSheet }: { list: Company[]; kinds: Kinds; onEdit: (c: Company) => void; onOpen: (k: Open, c: Company) => void; onAdd: (d: CompanyDraft) => void; onSheet: (by: { companyId?: number }) => void }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState<number | null>(null);
  const [add, setAdd] = useState(false);
  const active = list.filter((c) => c.active);
  const toShip = active.reduce((s, c) => s + c.toShip, 0);
  const onRoad = active.reduce((s, c) => s + c.onRoad, 0);
  const missing = active.filter((c) => isApi(c) && !c.hasKeys).length;
  const sorted = [...list].sort((a, b) => Number(b.active) - Number(a.active) || b.onRoad + b.toShip - (a.onRoad + a.toShip));
  const c = list.find((x) => x.id === cur) ?? null;
  return (
    <>
      <section className="pxl-sum">
        <div>
          <small>{t('livraison.ph.companies')}</small>
          <b>{active.length}</b>
        </div>
        <div>
          <small>{t('livraison.col.toShip')}</small>
          <b className="or">{toShip}</b>
        </div>
        <div>
          <small>{t('livraison.col.onRoad')}</small>
          <b className="nv">{onRoad}</b>
        </div>
      </section>
      {missing > 0 && (
        <p className="pxl-warn">
          <Icon name="alert" /> {t('livraison.ph.missing', { count: missing })}
        </p>
      )}
      {!list.length ? (
        <Empty>{t('livraison.societes.none')}</Empty>
      ) : (
        <ul className="pxk-grp pxl-list">
          {sorted.map((x) => (
            <li key={x.id} className={x.active ? '' : 'off'}>
              <button type="button" onClick={() => setCur(x.id)}>
                {isApi(x) ? <CompanyLogo cards={kinds.cards} company={x} /> : <span className={`pxs-co k-${x.kind} pxl-co`}>{x.kind === 'own' ? <Icon name="bike" /> : short(x.name)}</span>}
                <span className="pxk-rm">
                  <b>{x.name}</b>
                  <small>
                    <Conn c={x} />
                  </small>
                </span>
                <span className="pxl-nums">
                  <span title={t('livraison.col.toShip')} className={x.toShip ? 'or' : ''}>
                    <Icon name="package" />
                    {x.toShip}
                  </span>
                  <span title={t('livraison.col.onRoad')} className={x.onRoad ? 'nv' : ''}>
                    <Icon name="truck" />
                    {x.onRoad}
                  </span>
                </span>
                <Icon name="chevr" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="pxv-help pxl-legend">
        <Icon name="package" /> {t('livraison.col.toShip')} · <Icon name="truck" /> {t('livraison.col.onRoad')}
      </p>
      <button type="button" className="pxv-btn or big pxl-add" onClick={() => setAdd(true)}>
        <Icon name="plus" /> {t('livraison.ph.add')}
      </button>
      {add && <AddSheet kinds={kinds} list={list} onClose={() => setAdd(false)} onPick={(d) => (setAdd(false), onAdd(d))} />}
      {c && <CompanyPage c={c} cards={kinds.cards} onClose={() => setCur(null)} onEdit={onEdit} onOpen={onOpen} onSheet={onSheet} />}
    </>
  );
}

function CompanyPage({ c, cards, onClose, onEdit, onOpen, onSheet }: { c: Company; cards: Kinds['cards']; onClose: () => void; onEdit: (c: Company) => void; onOpen: (k: Open, c: Company) => void; onSheet: (by: { companyId?: number }) => void }) {
  const { t } = useTranslation();
  const api = isApi(c);
  // an API company is shown as itself (DHD, Guepex…), never by its platform (« EcoTrack », « Yalidine »)
  const card = api ? courierCardOf(cards, c) : null;
  const test = useAction('delivery.test', { silent: true, onDone: (r) => toast(r.message, r.ok ? 'ok' : 'bad', 6000) });
  const row = (icon: string, label: string, sub: string | null, onClick: () => void, tone = '') => (
    <li>
      <button type="button" onClick={onClick}>
        <span className={`pxl-ai ${tone}`}>
          <Icon name={icon} />
        </span>
        <span className="pxk-rm">
          <b>{label}</b>
          {sub && <small>{sub}</small>}
        </span>
        <Icon name="chevr" />
      </button>
    </li>
  );
  return (
    <Page title={c.name} sub={api ? (card?.sub ? cardSub(t, card) : undefined) : t(`livraison.kindsLong.${c.kind}`)} right={<Conn c={c} />} onClose={onClose}>
      <section className="pxl-sum">
        <div>
          <small>{t('livraison.col.toShip')}</small>
          <b className="or">{c.toShip}</b>
        </div>
        <div>
          <small>{t('livraison.col.onRoad')}</small>
          <b className="nv">{c.onRoad}</b>
        </div>
      </section>
      {api && !c.hasKeys && (
        <button type="button" className="pxl-warn btn-like" onClick={() => onEdit(c)}>
          <Icon name="alert" /> {t('livraison.ph.addKeys')}
        </button>
      )}
      {c.kind === 'zr' && (
        <button type="button" className="pxv-btn nv big" onClick={() => onOpen('zr', c)}>
          <Icon name="sparkles" /> {t('livraison.act.zr', { name: c.name })}
        </button>
      )}
      {api && c.kind !== 'zr' && c.kind !== 'custom' && (
        <button type="button" className="pxv-btn nv big" onClick={() => onOpen('live', c)}>
          <Icon name="sparkles" /> {t('livraison.act.live', { name: c.name })}
        </button>
      )}
      <div className="pxv-lbl">{t('livraison.ph.daily')}</div>
      <ul className="pxk-grp pxl-acts">
        {row('printer', t('livraison.act.sheet'), t('livraison.ph.sheetSub'), () => onSheet({ companyId: c.id }))}
        {row('coins', t('livraison.act.fees'), t('livraison.ph.feesSub'), () => onOpen('fees', c))}
        {api && row('home', t('livraison.act.desks'), t('livraison.ph.desksSub'), () => onOpen('desks', c))}
      </ul>
      {api && (
        <>
          <div className="pxv-lbl">{t('livraison.ph.connection')}</div>
          <ul className="pxk-grp pxl-acts">
            {row('refresh', t('livraison.act.test'), test.isPending ? t('livraison.ph.testing') : t('livraison.ph.testSub'), () => !test.isPending && test.mutate({ companyId: c.id }), 'gr')}
            {row('route', t('livraison.act.statuses'), t('livraison.ph.statusesSub'), () => onOpen('statuses', c))}
            {row('search', t('livraison.act.preview'), t('livraison.ph.previewSub'), () => onOpen('preview', c))}
          </ul>
        </>
      )}
      <div className="pxv-lbl">{t('livraison.ph.settings')}</div>
      <ul className="pxk-grp pxl-acts">{row('pencil', t('livraison.ph.edit'), api ? t('livraison.ph.editSubApi') : t('livraison.ph.editSub'), () => onEdit(c))}</ul>
    </Page>
  );
}

/** « + Ajouter »: the company type first (API ones connect with keys; « sans API » / own livreurs need none). */
function AddSheet({ kinds, list, onClose, onPick }: { kinds: Kinds; list: Company[]; onClose: () => void; onPick: (d: CompanyDraft) => void }) {
  const { t } = useTranslation();
  return (
    <Sheet title={t('livraison.ph.addTitle')} onClose={onClose}>
      <div className="pxv-lbl">{t('livraison.ph.withApi')}</div>
      <CarrierRows list={list} kinds={kinds} onPick={onPick} />
      <div className="pxv-lbl">{t('livraison.ph.withoutApi')}</div>
      <ul className="pxk-grp">
        <li>
          <button type="button" onClick={() => onPick({ name: '', kind: 'manual', active: true, phone: '', settings: {} })}>
            <span className="pxl-ai">
              <Icon name="truck" />
            </span>
            <span className="pxk-rm">
              <b>{t('livraison.kinds.manual')}</b>
              <small>{t('livraison.ph.manualSub')}</small>
            </span>
            <Icon name="chevr" />
          </button>
        </li>
      </ul>
    </Sheet>
  );
}

/** Every delivery company, one row each with its own logo (a search above: the list is long). */
function CarrierRows({ list, kinds, onPick }: { list: Company[]; kinds: Kinds; onPick: (d: CompanyDraft) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const found = searchCards(kinds.cards, q);
  const shown = found.length ? found : kinds.cards.filter((c) => c.kind === 'custom');
  return (
    <>
      <input
        className="pxv-search pxl-csearch"
        type="search"
        value={q}
        placeholder={t('livraison.api.searchPh')}
        aria-label={t('livraison.api.search')}
        enterKeyHint="search"
        onChange={(e) => setQ(e.target.value)}
      />
      {!found.length && <p className="pxv-help">{t('livraison.api.noMatch', { q: q.trim() })}</p>}
      <ul className="pxk-grp">
        {shown.map((card) => {
          const n = countOf(card, kinds.cards, list);
          return (
            <li key={card.id}>
              <button type="button" onClick={() => onPick(draftOf(card))}>
                <CourierLogo card={card} size="sm" />
                <span className="pxk-rm">
                  <b>{cardTitle(t, card)}</b>
                  {card.sub && <small>{cardSub(t, card)}</small>}
                </span>
                {n ? <span className="pxl-st ok">{t('livraison.api.connected', { count: n })}</span> : <span className="pxl-plus">{t('livraison.ph.connect')}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- API (the accounts connected, then every carrier)
function Carriers({ list, kinds, onAdd, onOpen }: { list: Company[]; kinds: Kinds; onAdd: (d: CompanyDraft) => void; onOpen: (c: Company) => void }) {
  const { t } = useTranslation();
  const mine = list.filter(isApi);
  return (
    <>
      <p className="pxv-help">{t('livraison.ph.apiHelp')}</p>
      {mine.length > 0 && (
        <>
          <div className="pxv-lbl">{t('livraison.api.accounts')}</div>
          <ul className="pxk-grp pxl-list">
            {mine.map((c) => (
              <li key={c.id} className={c.active ? '' : 'off'}>
                <button type="button" onClick={() => onOpen(c)}>
                  <CompanyLogo cards={kinds.cards} company={c} />
                  <span className="pxk-rm">
                    <b>{c.name}</b>
                    {courierCardOf(kinds.cards, c)?.sub && <small>{cardSub(t, courierCardOf(kinds.cards, c)!)}</small>}
                  </span>
                  <Conn c={c} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="pxv-lbl">{t('livraison.ph.allCarriers')}</div>
      <CarrierRows list={list} kinds={kinds} onPick={onAdd} />
    </>
  );
}

// ---------------------------------------------------------------- livreurs
function Livreurs({ companies, onSheet }: { companies: Company[]; onSheet: (by: { livreurId?: number }) => void }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.livreurs', {});
  const [cur, setCur] = useState<number | null>(null);
  const l = q.data?.find((x) => x.id === cur) ?? null;
  return (
    <>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Loading />
      ) : !q.data.length ? (
        <Empty>{t('livraison.livreurs.none')}</Empty>
      ) : (
        <ul className="pxk-grp pxl-list">
          {q.data.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => setCur(x.id)}>
                <span className="pxk-av or">{x.name.trim().slice(0, 1).toUpperCase()}</span>
                <span className="pxk-rm">
                  <b>{x.name}</b>
                  <small>{x.endWilayaId ? `${t('livraison.ph.endsAt')} ${wilaya(x.endWilayaId)}${x.endCommune ? ` · ${x.endCommune}` : ''}` : t('livraison.ph.noEnd')}</small>
                </span>
                <span className="pxl-nums">
                  <span className={x.toShip ? 'or' : ''}>
                    <Icon name="package" />
                    {x.toShip}
                  </span>
                  <span className={x.onRoad ? 'nv' : ''}>
                    <Icon name="truck" />
                    {x.onRoad}
                  </span>
                </span>
                <Icon name="chevr" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <a className="pxv-btn big pxl-addl" href="#/utilisateurs/agents">
        {t('livraison.livreurs.addAccount')}
      </a>
      <div className="pxl-cash">
        <LivreursCash />
      </div>
      {l && <LivreurPage l={l} companies={companies.filter((c) => c.kind === 'own')} onClose={() => setCur(null)} onSheet={onSheet} />}
    </>
  );
}

function LivreurPage({ l, companies, onClose, onSheet }: { l: Livreur; companies: Company[]; onClose: () => void; onSheet: (by: { livreurId?: number }) => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState({ companyId: l.companyId, endWilayaId: l.endWilayaId, endCommune: l.endCommune ?? '' });
  const save = useAction('delivery.saveLivreur', { success: t('livraison.saved'), onDone: onClose });
  return (
    <Page
      title={l.name}
      sub={l.active ? l.email : t('livraison.livreurs.noAccount')}
      right={
        l.phone ? (
          <AskCall phone={l.phone} className="pxp-call" label={t('livraison.ph.call')}>
            <Icon name="phone" />
          </AskCall>
        ) : undefined
      }
      onClose={onClose}
    >
      <section className="pxl-sum">
        <div>
          <small>{t('livraison.col.toShip')}</small>
          <b className="or">{l.toShip}</b>
        </div>
        <div>
          <small>{t('livraison.col.onRoad')}</small>
          <b className="nv">{l.onRoad}</b>
        </div>
      </section>
      <button type="button" className="pxv-btn nv big" onClick={() => onSheet({ livreurId: l.id })}>
        <Icon name="printer" /> {t('livraison.act.sheet')}
      </button>
      <div className="pxv-lbl">{t('livraison.ph.tourEnd')}</div>
      <div className="pxl-form">
        <label>
          <span>{t('livraison.livreurs.endWilaya')}</span>
          <select value={d.endWilayaId ?? ''} onChange={(e) => setD({ ...d, endWilayaId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {Array.from({ length: 69 }, (_, i) => (
              <option key={i} value={i + 1}>
                {wilaya(i + 1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('livraison.livreurs.endCommune')}</span>
          <input value={d.endCommune} onChange={(e) => setD({ ...d, endCommune: e.target.value })} />
          <small>{t('livraison.livreurs.endHint')}</small>
        </label>
        {companies.length > 0 && (
          <label>
            <span>{t('livraison.livreurs.company')}</span>
            <select value={d.companyId ?? ''} onChange={(e) => setD({ ...d, companyId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button type="button" className="pxv-btn or big" disabled={save.isPending} onClick={() => save.mutate({ profileId: l.id, companyId: d.companyId, endWilayaId: d.endWilayaId, endCommune: d.endCommune || null })}>
        {t('common.save')}
      </button>
    </Page>
  );
}
