// Clients: search, "Liste noire seulement", order history and blacklist — as in the original app; « Importer des clients »
// brings customers from another app with their history there (ImportClients.tsx), shown beside Pilotix's own orders.
import { CONF_TONE, type ClientLevel } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, n, when, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorBox, Field, Icon, Loading, Pager, StatusBadge } from '../../ui/kit';
import { PhoneOf } from '../../ui/PhoneOf';
import { LevelPicker, ScoreCard, ScoreChip } from '../../ui/clientScore';
import { Modal } from '../../ui/modal';
import type { PageProps } from '../registry';
import { ImportClients } from './ImportClients';
import './import.css';

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

type Imported = { orders: number; delivered: number; returned: number; lastOrderAt: string | null } | null;
/** a customer's counts in the list: Pilotix's orders + the history imported from another app */
const withImported = (c: { orders: number; delivered: number; returned: number; lastOrderAt: string | null; imported: Imported }) => ({
  orders: c.orders + (c.imported?.orders ?? 0),
  delivered: c.delivered + (c.imported?.delivered ?? 0),
  returned: c.returned + (c.imported?.returned ?? 0),
  last: [c.lastOrderAt, c.imported?.lastOrderAt].filter((x): x is string => !!x).sort().pop() ?? null,
});

export function Clients(_: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [black, setBlack] = useState(false);
  const [level, setLevel] = useState<ClientLevel | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(60);
  const [open, setOpen] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const { session } = useSession();
  const canImport = !!session?.isAdmin && !session.profile.agencyId;
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, black, level]);
  const list = useRpc('customers.list', { q: dq || undefined, blacklisted: black || undefined, level, page, pageSize: size });
  const rows = list.data?.rows;

  return (
    <>
      <Card title={t('clients.title')}>
        <div className="row">
          <div className="grow">
            <input type="search" placeholder={t('clients.search')} aria-label={t('clients.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="cl-head-act">
            <label className="check">
              <input type="checkbox" checked={black} onChange={(e) => setBlack(e.target.checked)} />
              {t('clients.onlyBlack')}
            </label>
            {canImport && (
              <button type="button" className="btn small" onClick={() => setImporting(true)}>
                <Icon name="upload" />
                {t('clients.import.open')}
              </button>
            )}
          </div>
        </div>
        <LevelPicker value={level} onChange={setLevel} className="cl-levels" />
        <SharedNote />
        {list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{level ? t('clients.score.emptyLevel', { level: t(`clients.score.level.${level}`) }) : t('clients.empty')}</Empty>
        ) : (
          <div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('clients.col.client')}</th>
                    <th title={t('clients.score.help')}>{t('clients.score.col')}</th>
                    <th>{t('clients.col.phone')}</th>
                    <th>{t('clients.col.wilaya')}</th>
                    <th className="num">{t('clients.col.orders')}</th>
                    <th className="num">{t('clients.col.delivered')}</th>
                    <th className="num">{t('clients.col.returned')}</th>
                    <th>{t('clients.col.last')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const all = withImported(c);
                    return (
                    <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                      <td data-l={t('clients.col.client')}>
                        <b>{c.name || '—'}</b>
                        {c.blacklisted && <span className="flag">{t('clients.black')}</span>}
                        {c.imported && (
                          <span className="cl-imp" title={t('clients.import.tag', { date: dateOnly(c.imported.at) })}>
                            {t('clients.import.oldBase')}
                          </span>
                        )}
                      </td>
                      <td data-l={t('clients.score.col')}>
                        <ScoreChip s={c.score} showNew />
                      </td>
                      <td data-l={t('clients.col.phone')}>
                        <PhoneOf o={c} />
                      </td>
                      <td data-l={t('clients.col.wilaya')}>{c.wilayaId ? wilayaName(c.wilayaId) : '—'}</td>
                      <td className="num" data-l={t('clients.col.orders')}>
                        {n(all.orders)}
                      </td>
                      <td className="num" data-l={t('clients.col.delivered')}>
                        {n(all.delivered)}
                      </td>
                      <td className="num" data-l={t('clients.col.returned')}>
                        <span className={all.returned ? 'stock-low' : undefined}>{n(all.returned)}</span>
                      </td>
                      <td data-l={t('clients.col.last')}>{all.last ? when(all.last).replace(/\s\d{1,2}:\d{2}(\s?(?:[صم]|[AaPp]\.?[Mm]\.?))?$/, '') : '—'}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              page={page}
              pageSize={size}
              total={list.data!.total}
              onPage={setPage}
              onSize={(s) => {
                setSize(s);
                setPage(1);
              }}
              sizes={[60, 100, 200]}
            />
          </div>
        )}
      </Card>
      {open !== null && <History id={open} onClose={() => setOpen(null)} />}
      {importing && <ImportClients onClose={() => setImporting(false)} />}
    </>
  );
}

/**
 * « Liste noire partagée »: the owner's other boutiques block (and unblock) the numbers blocked here by a person; an
 * administrator can also send the ones blocked before.
 */
function SharedNote() {
  const { t } = useTranslation();
  const { session } = useSession();
  const agency = !!session?.profile.agencyId;
  const info = useRpc('customers.shareInfo', {}, { enabled: !agency, retry: false });
  const [asking, setAsking] = useState(false);
  const all = useAction('customers.shareAll', { success: (r) => t('clients.shared.done', { count: r.numbers, list: r.shops.join(', ') }), onDone: () => setAsking(false) });
  const d = info.data;
  if (agency || !d || !d.shops.length) return null;
  const list = d.shops.join(', ');
  return (
    <div className="cl-shared" role="note">
      <Icon name="link" />
      <div className="cl-shared-t">
        <b>{t('clients.shared.text', { list })}</b>
        <small>{t('clients.shared.more')}</small>
      </div>
      {session?.isAdmin && d.own > 0 && (
        <div className="cl-shared-act">
          {asking ? (
            <>
              <span>{t('clients.shared.ask', { count: d.own, list })}</span>
              <button type="button" className="btn small" onClick={() => setAsking(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn small primary" disabled={all.isPending} onClick={() => all.mutate({})}>
                {all.isPending ? '…' : t('clients.shared.yes')}
              </button>
            </>
          ) : (
            <button type="button" className="btn small" onClick={() => setAsking(true)}>
              {t('clients.shared.all', { count: d.own })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function History({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const h = useRpc('customers.history', { id }, { placeholderData: undefined });
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const c = h.data?.customer;
  const set = useAction('customers.setBlacklist', {
    success: (r) => (r.shared?.length ? `${t('clients.updated')} · ${t('clients.alsoIn', { list: r.shared.join(', ') })}` : t('clients.updated')),
    onDone: () => {
      setAsking(false);
      setReason('');
    },
  });
  const footer = c && (
    <>
      <button className="btn" onClick={onClose}>
        {t('common.close')}
      </button>
      {c.blacklisted ? (
        <button className="btn" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, on: false })}>
          {t('clients.unblack')}
        </button>
      ) : asking ? (
        <button className="btn danger" disabled={set.isPending} onClick={() => set.mutate({ id: c.id, on: true, reason: reason.trim() || null })}>
          {t('clients.confirmBlack')}
        </button>
      ) : (
        <button className="btn danger" onClick={() => setAsking(true)}>
          {t('clients.toBlack')}
        </button>
      )}
    </>
  );
  return (
    <Modal title={c ? (c.phone ? `${c.name} · ${c.phone}` : c.name) : t('common.loading')} onClose={onClose} wide footer={footer}>
      {h.error ? (
        <ErrorBox error={h.error} />
      ) : !h.data ? (
        <Loading />
      ) : (
        <>
          {c!.blacklisted && <div className="badbox">{c!.blacklistReason ? t('clients.inBlackReason', { reason: c!.blacklistReason }) : t('clients.inBlack')}</div>}
          <ScoreCard s={c!.score} />
          <p className="muted small">{t(c!.imported ? 'clients.summaryHere' : 'clients.summary', { orders: c!.orders, delivered: c!.delivered, returned: c!.returned, cancelled: c!.cancelled })}</p>
          {c!.imported && (
            <p className="cl-imp-line">
              <span className="cl-imp">{t('clients.import.oldBase')}</span>
              {t('clients.import.history', {
                date: dateOnly(c!.imported.at),
                orders: c!.imported.orders,
                delivered: c!.imported.delivered,
                returned: c!.imported.returned,
                fake: c!.imported.fake,
                cancelled: c!.imported.cancelled,
              })}
            </p>
          )}
          {asking && !c!.blacklisted && (
            <Field label={t('clients.reason')}>
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('clients.reasonPh')} />
            </Field>
          )}
          {h.data.orders.length === 0 ? (
            <Empty>{t(c!.imported ? 'clients.noOrdersHere' : 'clients.noOrders')}</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('clients.col.order')}</th>
                    <th className="wide">{t('clients.col.products')}</th>
                    <th>{t('clients.col.variant')}</th>
                    <th className="num">{t('clients.col.total')}</th>
                    <th>{t('clients.col.conf')}</th>
                    <th>{t('clients.col.follow')}</th>
                  </tr>
                </thead>
                <tbody>
                  {h.data.orders.map((o) => (
                    <tr
                      key={o.id}
                      className="clickable"
                      onClick={() => {
                        onClose();
                        openOrder(o.id);
                      }}
                    >
                      <td data-l={t('clients.col.order')}>
                        <b className="ltr">{o.ref}</b>
                        <small>{when(o.createdAt)}</small>
                      </td>
                      <td className="wide" data-l={t('clients.col.products')}>
                        {o.itemsText}
                      </td>
                      <td data-l={t('clients.col.variant')}>{o.variantsText || '—'}</td>
                      <td className="num ltr" data-l={t('clients.col.total')}>
                        {da(o.total)}
                      </td>
                      <td data-l={t('clients.col.conf')}>
                        {o.confStatus === 'no_answer' ? (
                          <span className={`badge t-${CONF_TONE.no_answer}`}>{t('orders.attemptN', { n: String(Math.max(1, o.attempts)).padStart(2, '0') })}</span>
                        ) : (
                          <StatusBadge kind="conf" status={o.confStatus} />
                        )}
                      </td>
                      <td data-l={t('clients.col.follow')}>
                        <StatusBadge kind="follow" status={o.followStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
