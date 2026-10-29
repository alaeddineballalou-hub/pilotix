// « Sociétés de livraison » (admin): Sociétés & tarifs · Pilot Auto Assign · API Integration · Livreurs · Préférences.
// The people ticked « règles Pilot » in Utilisateurs (not admins) see only Pilot Auto Assign.
import { WILAYAS } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { wilaya } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, Empty, ErrorBox, Field, Loading, StageBar } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { LivreursCash } from '../caisse/LivreursCash';
import type { PageProps } from '../registry';
import { Company, CompanyDraft, CompanyForm, FeesModal, PreviewModal, StatusesModal, StopdesksModal, ZrModal, LiveModal } from './forms';
import { printRouteSheet } from './print';
import { useIsPhone } from '../../lib/useMedia';
import { PhoneLivraison } from './Phone';
import { Preferences } from './Preferences';
import { Pilot } from './Pilot';
import { useSession } from '../../lib/session';

type Dialog = { kind: 'form'; draft: CompanyDraft; keysSet?: string[] } | { kind: 'fees' | 'desks' | 'statuses' | 'preview' | 'zr' | 'live'; company: Company } | null;

export function Livraison(p: PageProps) {
  const { session } = useSession();
  if (session && !session.isAdmin) return <Pilot />;
  return <LivraisonAdmin {...p} />;
}

function LivraisonAdmin({ sub }: PageProps) {
  const { t } = useTranslation();
  const current = sub === 'api' || sub === 'livreurs' || sub === 'preferences' || sub === 'pilot' ? sub : 'societes';
  const q = useRpc('delivery.companies', {});
  const kinds = useRpc('delivery.kinds', {});
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const items = [
    { key: 'societes', label: t('livraison.tabs.societes'), href: '#/livraison/societes' },
    { key: 'pilot', label: t('livraison.tabs.pilot'), href: '#/livraison/pilot' },
    { key: 'api', label: t('livraison.tabs.api'), href: '#/livraison/api' },
    { key: 'livreurs', label: t('livraison.tabs.livreurs'), href: '#/livraison/livreurs' },
    { key: 'preferences', label: t('livraison.tabs.preferences'), href: '#/livraison/preferences' },
  ];

  const edit = (c: Company) => setDialog({ kind: 'form', draft: { id: c.id, name: c.name, kind: c.kind, active: c.active, phone: c.phone ?? '', settings: { ...(c.settings as Record<string, unknown>) } }, keysSet: c.keysSet });

  const phone = useIsPhone();
  const dialogs = (
    <>
      {dialog?.kind === 'form' && kinds.data && <CompanyForm initial={dialog.draft} kinds={kinds.data} keysSet={dialog.keysSet} onClose={close} />}
      {dialog?.kind === 'fees' && <FeesModal company={dialog.company} onClose={close} />}
      {dialog?.kind === 'desks' && <StopdesksModal company={dialog.company} onClose={close} />}
      {dialog?.kind === 'statuses' && <StatusesModal company={dialog.company} onClose={close} />}
      {dialog?.kind === 'preview' && <PreviewModal company={dialog.company} onClose={close} />}
      {dialog?.kind === 'zr' && <ZrModal company={dialog.company} onClose={close} />}
      {dialog?.kind === 'live' && <LiveModal company={dialog.company} onClose={close} />}
    </>
  );
  if (phone)
    return (
      <>
        <PhoneLivraison
          current={current}
          companies={q}
          kinds={kinds}
          onEdit={edit}
          onOpen={(kind, company) => setDialog({ kind, company })}
          onAdd={(draft) => setDialog({ kind: 'form', draft })}
          onSheet={async (by) => {
            try {
              printRouteSheet(await rpc('delivery.routeSheet', by));
            } catch (e: any) {
              toast(e.message, 'bad');
            }
          }}
        />
        {dialogs}
      </>
    );

  return (
    <>
      <StageBar items={items} current={current} flow={false} />
      {current === 'preferences' && <Preferences />}
      {current === 'pilot' && <Pilot />}
      {current === 'societes' && (
        <>
          <Card
            title={t('livraison.societes.title')}
            help={t('livraison.societes.help')}
            actions={
              <button className="btn primary" onClick={() => setDialog({ kind: 'form', draft: { name: '', kind: 'manual', active: true, phone: '', settings: {} } })}>
                {t('livraison.societes.addManual')}
              </button>
            }
          />
          <CompaniesCard q={q} withKind={false} onEdit={edit} onOpen={(kind, company) => setDialog({ kind, company })} />
        </>
      )}
      {current === 'api' && (
        <>
          <Card title={t('livraison.api.title')} help={t('livraison.api.help')} />
          {kinds.isLoading || q.isLoading ? (
            <Loading />
          ) : kinds.error || q.error ? (
            <ErrorBox error={kinds.error || q.error} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="carrier-grid">
                {kinds.data!.cards.map((card) => {
                  const host = (c: Company) => String((c.settings as any)?.base_url ?? '');
                  const n = (q.data ?? []).filter((c) => {
                    if (c.kind !== card.kind) return false;
                    if (!card.host) return true;
                    if (card.host.startsWith('!')) return card.host.slice(1).split(',').every((h) => !host(c).toLowerCase().includes(h));
                    return host(c).toLowerCase().includes(card.host);
                  }).length;
                  return (
                    <button
                      key={card.title}
                      type="button"
                      className="kpi carrier"
                      onClick={() => setDialog({ kind: 'form', draft: { name: card.kind === 'custom' || card.title.startsWith('Autre') ? '' : card.title, kind: card.kind, active: true, phone: '', settings: { ...(card.settings ?? {}) } } })}
                    >
                      <span className="v">{card.title}</span>
                      <span className="s">{card.sub}</span>
                      <span className={`badge t-${n ? 'ok' : 'info'}`}>{n ? t('livraison.api.connected', { count: n }) : t('livraison.api.connect')}</span>
                    </button>
                  );
                })}
              </div>
              <CompaniesCard q={q} withKind onlyApi title={t('livraison.api.accounts')} onEdit={edit} onOpen={(kind, company) => setDialog({ kind, company })} />
            </div>
          )}
        </>
      )}
      {current === 'livreurs' && <LivreursTab companies={q.data ?? []} />}

      {dialogs}
    </>
  );
}

function CompaniesCard({
  q,
  withKind,
  onlyApi,
  title,
  onEdit,
  onOpen,
}: {
  q: ReturnType<typeof useRpc<'delivery.companies'>>;
  withKind: boolean;
  onlyApi?: boolean;
  title?: string;
  onEdit: (c: Company) => void;
  onOpen: (k: 'fees' | 'desks' | 'statuses' | 'preview' | 'zr' | 'live', c: Company) => void;
}) {
  const { t } = useTranslation();
  const test = useAction('delivery.test', { silent: true, onDone: (r) => toast(r.message, r.ok ? 'ok' : 'bad', 6000) });
  const sheet = async (c: Company) => {
    try {
      printRouteSheet(await rpc('delivery.routeSheet', { companyId: c.id }));
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const list = (q.data ?? []).filter((c) => (onlyApi ? !['own', 'manual'].includes(c.kind) : true));
  const body = !list.length ? (
    <Empty>{onlyApi ? t('livraison.api.none') : t('livraison.societes.none')}</Empty>
  ) : (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('livraison.col.company')}</th>
            {withKind && <th>{t('livraison.col.name')}</th>}
            <th>{t('livraison.col.connection')}</th>
            <th className="num">{t('livraison.col.toShip')}</th>
            <th className="num">{t('livraison.col.onRoad')}</th>
            <th>{t('livraison.col.state')}</th>
            <th className="wide" />
          </tr>
        </thead>
        <tbody>
          {list.map((c) => {
            const api = !['own', 'manual'].includes(c.kind);
            return (
              <tr key={c.id} className="clickable" onClick={() => onEdit(c)}>
                <td data-l={t('livraison.col.company')}>
                  <b>{withKind ? t(`livraison.kinds.${c.kind}`) : c.name}</b>
                  <small>{t(`livraison.kindsLong.${c.kind}`)}</small>
                </td>
                {withKind && <td data-l={t('livraison.col.name')}>{c.name}</td>}
                <td data-l={t('livraison.col.connection')}>
                  {api ? <span className={`badge t-${c.hasKeys ? 'ok' : 'bad'}`}>{c.hasKeys ? t('livraison.keysOk') : t('livraison.keysMissing')}</span> : <span className="badge t-off">{t('livraison.noApi')}</span>}
                </td>
                <td className="num" data-l={t('livraison.col.toShip')}>
                  <span className="ltr">{c.toShip}</span>
                </td>
                <td className="num" data-l={t('livraison.col.onRoad')}>
                  <span className="ltr">{c.onRoad}</span>
                </td>
                <td data-l={t('livraison.col.state')}>
                  <span className={`badge t-${c.active ? 'ok' : 'off'}`}>{c.active ? t('livraison.active') : t('livraison.inactive')}</span>
                </td>
                <td className="wide px-cw" data-l="" onClick={(e) => e.stopPropagation()}>
                  <div className="row">
                    {withKind && (
                      <button className="btn small" onClick={() => onEdit(c)}>
                        {t('common.edit')}
                      </button>
                    )}
                    <button className="btn small" onClick={() => onOpen('fees', c)}>
                      {t('livraison.act.fees')}
                    </button>
                    <button className="btn small" onClick={() => sheet(c)}>
                      {t('livraison.act.sheet')}
                    </button>
                    {api && (
                      <button className="btn small" onClick={() => onOpen('desks', c)}>
                        {t('livraison.act.desks')}
                      </button>
                    )}
                    {api && (
                      <button className="btn small" onClick={() => onOpen('statuses', c)}>
                        {t('livraison.act.statuses')}
                      </button>
                    )}
                    {api && (
                      <button className="btn small" disabled={test.isPending} onClick={() => test.mutate({ companyId: c.id })}>
                        {t('livraison.act.test')}
                      </button>
                    )}
                    {api && (
                      <button className="btn small" onClick={() => onOpen('preview', c)}>
                        {t('livraison.act.preview')}
                      </button>
                    )}
                    {c.kind === 'zr' && (
                      <button className="btn small primary" onClick={() => onOpen('zr', c)}>
                        {t('livraison.act.zr', { name: c.name })}
                      </button>
                    )}
                    {api && c.kind !== 'zr' && c.kind !== 'custom' && (
                      <button className="btn small primary" onClick={() => onOpen('live', c)}>
                        {t('livraison.act.live', { name: c.name })}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return title ? (
    <div className="card">
      <h2>{title}</h2>
      {body}
    </div>
  ) : (
    <div className="card">{body}</div>
  );
}

function LivreursTab({ companies }: { companies: Company[] }) {
  const { t } = useTranslation();
  const q = useRpc('delivery.livreurs', {});
  const [edit, setEdit] = useState<NonNullable<typeof q.data>[number] | null>(null);
  const sheet = async (id: number) => {
    try {
      printRouteSheet(await rpc('delivery.routeSheet', { livreurId: id }));
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  return (
    <>
      <Card title={t('livraison.livreurs.title')} help={t('livraison.livreurs.help')} actions={<a className="btn" href="#/utilisateurs/agents">{t('livraison.livreurs.addAccount')}</a>} />
      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : !q.data?.length ? (
          <Empty>{t('livraison.livreurs.none')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('livraison.livreurs.col.livreur')}</th>
                  <th>{t('livraison.livreurs.col.account')}</th>
                  <th>{t('livraison.livreurs.col.end')}</th>
                  <th className="num">{t('livraison.col.toShip')}</th>
                  <th className="num">{t('livraison.col.onRoad')}</th>
                  <th className="wide" />
                </tr>
              </thead>
              <tbody>
                {q.data.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => setEdit(l)}>
                    <td data-l={t('livraison.livreurs.col.livreur')}>
                      <b>{l.name}</b>
                      {l.phone && <small className="ltr">{l.phone}</small>}
                    </td>
                    <td data-l={t('livraison.livreurs.col.account')}>{l.active ? <span className="badge t-ok">{l.email}</span> : <span className="muted">{t('livraison.livreurs.noAccount')}</span>}</td>
                    <td data-l={t('livraison.livreurs.col.end')}>{l.endWilayaId ? `${wilaya(l.endWilayaId)}${l.endCommune ? ` · ${l.endCommune}` : ''}` : '—'}</td>
                    <td className="num" data-l={t('livraison.col.toShip')}>
                      <span className="ltr">{l.toShip}</span>
                    </td>
                    <td className="num" data-l={t('livraison.col.onRoad')}>
                      <span className="ltr">{l.onRoad}</span>
                    </td>
                    <td className="wide" data-l="" onClick={(e) => e.stopPropagation()}>
                      <div className="row">
                        <button className="btn small" onClick={() => setEdit(l)}>
                          {t('common.edit')}
                        </button>
                        <button className="btn small" onClick={() => sheet(l.id)}>
                          {t('livraison.act.sheet')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <LivreursCash />
      {edit && <LivreurForm l={edit} companies={companies.filter((c) => c.kind === 'own')} onClose={() => setEdit(null)} />}
    </>
  );
}

function LivreurForm({ l, companies, onClose }: { l: { id: number; name: string; companyId: number | null; endWilayaId: number | null; endCommune: string | null }; companies: Company[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState({ companyId: l.companyId, endWilayaId: l.endWilayaId, endCommune: l.endCommune ?? '' });
  const save = useAction('delivery.saveLivreur', { success: t('livraison.saved'), onDone: onClose });
  return (
    <Modal
      title={l.name}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ profileId: l.id, companyId: d.companyId, endWilayaId: d.endWilayaId, endCommune: d.endCommune || null })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label={t('livraison.livreurs.company')}>
          <select value={d.companyId ?? ''} onChange={(e) => setD({ ...d, companyId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <span />
        <Field label={t('livraison.livreurs.endWilaya')}>
          <select value={d.endWilayaId ?? ''} onChange={(e) => setD({ ...d, endWilayaId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {WILAYAS.map((_, i) => (
              <option key={i} value={i + 1}>
                {wilaya(i + 1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('livraison.livreurs.endCommune')} hint={t('livraison.livreurs.endHint')}>
          <input value={d.endCommune} onChange={(e) => setD({ ...d, endCommune: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
