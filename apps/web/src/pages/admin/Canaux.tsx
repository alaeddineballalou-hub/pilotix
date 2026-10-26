// Management → Canaux de vente: channel tiles, the channels table (search, switches, edit, delete, pager),
// and each channel's webhook URL (server address + /api/hooks/orders/<id>?key=<webhook_key>) with a sample JSON.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, serverUrl } from '../../lib/backend';
import { when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Field, Help, Icon, Loading, copyText } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { ConfirmButton, IconBtn, Switch } from './bits';
import { SheetSync } from './SheetSync';
import { TestOrders } from './TestOrders';

type Kind = 'sheets' | 'woocommerce' | 'shopify' | 'youcan' | 'lightfunnels' | 'api' | 'connector';
const TILES: { kind: Kind | 'tiktok'; color: string; solid?: boolean; flag?: 'recommended' | 'soon' }[] = [
  { kind: 'sheets', color: '#188038', flag: 'recommended' },
  { kind: 'woocommerce', color: '#7f54b3' },
  { kind: 'shopify', color: '#4b7a2b' },
  { kind: 'youcan', color: '#b0306b', solid: true },
  { kind: 'lightfunnels', color: '#2563eb' },
  { kind: 'api', color: '#6d28d9' },
  { kind: 'connector', color: '#4338ca' },
  { kind: 'tiktok', color: '#111', solid: true, flag: 'soon' },
];
const COLOR = Object.fromEntries(TILES.map((x) => [x.kind, x.color])) as Record<string, string>;
const ICON: Record<string, string> = { sheets: 'list', woocommerce: 'package', shopify: 'package', youcan: 'home', lightfunnels: 'sparkles', api: 'sliders', connector: 'route', tiktok: 'megaphone' };

/** Public server address; the demo shows an invented one (nothing can reach a browser). */
export const publicBase = () => (backend.kind === 'demo' ? 'https://demo.pilotix.local' : serverUrl() || window.location.origin);
export const hookUrl = (channel: string | number, key: string) => `${publicBase()}/api/hooks/orders/${channel}?key=${encodeURIComponent(key)}`;
export const SAMPLE_ORDER = {
  customer_name: 'Amina B.',
  phone: '0555 12 34 56',
  phone2: null,
  wilaya: 16,
  commune: 'Rouiba',
  address: 'Cité 200 logements',
  stopdesk: false,
  items: [
    { sku: 'PX-POU-1', qty: 1 },
    { sku: 'PX-BIB', qty: 2, price: 1400 },
  ],
  note: 'Appeler après 17 h',
  channel: 'site',
  utm: { utm_source: 'facebook', utm_campaign: 'poussette-octobre' },
};

interface Channel {
  id: number;
  kind: string;
  name: string;
  creatorId: number | null;
  creatorName: string | null;
  skuRequired: boolean;
  active: boolean;
  url: string;
  webhookKey: string;
  lastSyncAt: string | null;
}

export function Canaux() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(15);
  const list = useRpc('admin.channels.list', { q: q || undefined, page, pageSize: size });
  const [form, setForm] = useState<{ kind: Kind; ch: Channel | null } | null>(null);
  const [syncing, setSyncing] = useState<Channel | null>(null);
  const toggle = useAction('admin.channels.toggle', { success: t('admin.channels.saved') });
  const del = useAction('admin.channels.delete', { success: t('admin.channels.deleted') });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <>
      <TestOrders />
      <div className="card">
        <div className="card-head">
          <h2>
            {t('admin.channels.addTitle')}
            <Help text={t('admin.channels.addHelp')} />
          </h2>
        </div>
        <div className="bjch-tiles">
          {TILES.map((x) => {
            const label = t(`admin.channels.kinds.${x.kind}`);
            const soon = x.flag === 'soon';
            return (
              <button
                key={x.kind}
                type="button"
                className={`bjch-tile ${x.solid ? 'solid' : ''} ${soon ? 'soon' : ''}`}
                style={{ ['--tc' as string]: x.color }}
                title={soon ? t('admin.channels.soonTip') : t('admin.channels.addTip', { name: label })}
                aria-disabled={soon || undefined}
                onClick={() => !soon && setForm({ kind: x.kind as Kind, ch: null })}
              >
                {x.flag && (
                  <span className={`bjch-flag ${soon ? 'soon' : ''}`}>
                    {!soon && <Icon name="sparkles" />}
                    {soon ? t('admin.channels.soon') : t('admin.channels.recommended')}
                  </span>
                )}
                <span className="bjch-badge">
                  <span className="bjch-i" aria-hidden="true">
                    <Icon name={ICON[x.kind]} />
                  </span>
                </span>
                <b>{label}</b>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {t('admin.channels.listTitle')}
            <Help text={t('admin.channels.listHelp')} />
          </h2>
          <div className="bjch-search">
            <span className="bjch-i" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              type="search"
              placeholder={t('admin.channels.search')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data?.rows.length ? (
          <Empty>{t('admin.channels.empty')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl bjch-tbl">
              <thead>
                <tr>
                  <th>{t('admin.channels.colCreator')}</th>
                  <th>{t('admin.channels.colName')}</th>
                  <th>{t('admin.channels.colType')}</th>
                  <th>{t('admin.channels.colUrl')}</th>
                  <th>{t('admin.channels.colSku')}</th>
                  <th>{t('admin.channels.colActive')}</th>
                  <th>{t('admin.channels.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((c) => (
                  <tr key={c.id} className={c.active ? '' : 'dim'}>
                    <td data-l={t('admin.channels.colCreator')}>
                      <b>{c.creatorName ?? '—'}</b>
                    </td>
                    <td data-l={t('admin.channels.colName')} className="bjch-nm">
                      <b>{c.name}</b>
                      {!c.active ? <small>{t('admin.channels.paused')}</small> : !c.lastSyncAt ? <small>{t('admin.channels.neverRead')}</small> : <small>{t('admin.channels.lastAt', { when: when(c.lastSyncAt) })}</small>}
                    </td>
                    <td data-l={t('admin.channels.colType')}>
                      <span className="bjch-type" style={{ ['--tc' as string]: COLOR[c.kind] ?? '#6d28d9' }}>
                        <span className="bjch-i" aria-hidden="true">
                          <Icon name={ICON[c.kind] ?? 'sliders'} />
                        </span>
                        {t(`admin.channels.kinds.${c.kind}`, { defaultValue: c.kind })}
                      </span>
                    </td>
                    <td data-l={t('admin.channels.colUrl')} className="bjch-url" title={c.kind === 'sheets' ? c.url : hookUrl(c.id, c.webhookKey)}>
                      {c.kind === 'sheets' ? (
                        <span className="ltr">{c.url}</span>
                      ) : (
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={async () => {
                            await copyText(hookUrl(c.id, c.webhookKey));
                            toast(t('admin.channels.copied'), 'ok');
                          }}
                        >
                          {t('admin.channels.webhook')} · {t('admin.channels.copy')}
                        </button>
                      )}
                    </td>
                    <td data-l={t('admin.channels.colSku')}>
                      <Switch checked={c.skuRequired} label={`${t('admin.channels.colSku')} — ${c.name}`} onChange={(v) => toggle.mutate({ id: c.id, field: 'skuRequired', value: v })} />
                    </td>
                    <td data-l={t('admin.channels.colActive')}>
                      <Switch checked={c.active} label={`${t('admin.channels.colActive')} — ${c.name}`} onChange={(v) => toggle.mutate({ id: c.id, field: 'active', value: v })} />
                    </td>
                    <td className="bjch-act">
                      {c.kind === 'sheets' && (
                        <button type="button" className="btn small primary" title={t('admin.channels.sheet.syncTip')} onClick={() => setSyncing(c)}>
                          ⟳ {t('admin.channels.sheet.sync')}
                        </button>
                      )}
                      <IconBtn kind="e" title={t('admin.channels.edit')} onClick={() => setForm({ kind: c.kind as Kind, ch: c })} />
                      <ConfirmButton className="bjp-ib bjp-ib-d" question={t('admin.channels.deleteConfirm', { name: c.name })} onConfirm={() => del.mutate({ id: c.id })}>
                        <span className="sr-only">{t('admin.channels.delete')}</span>
                        <span aria-hidden="true">✕</span>
                      </ConfirmButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="bjch-pager">
          <span className="muted">
            {t('common.total')} <span className="ltr">{total}</span>
          </span>
          <button type="button" className="bjch-pg" aria-label={t('common.prev')} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹
          </button>
          <button type="button" className="bjch-pg on">
            {page}
          </button>
          <button type="button" className="bjch-pg" aria-label={t('common.next')} disabled={page >= pages} onClick={() => setPage(page + 1)}>
            ›
          </button>
          <select
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
            aria-label={t('common.perPage')}
          >
            {[15, 30, 50].map((n) => (
              <option key={n} value={n}>
                {t('admin.channels.perPage', { n })}
              </option>
            ))}
          </select>
          <span className="muted">{t('common.goTo')}</span>
          <input type="number" min={1} max={pages} value={page} onChange={(e) => setPage(Math.min(pages, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 64, height: 36 }} />
        </div>
        {backend.kind === 'demo' && <div className="warnbox">{t('admin.channels.demoWarn')}</div>}
      </div>
      {form && (
        <ChannelForm
          kind={form.kind}
          ch={form.ch}
          onClose={() => setForm(null)}
          onSheetSaved={(c) => {
            // a new sheet: straight to « which column is what »
            setForm(null);
            setSyncing(c);
          }}
        />
      )}
      {syncing && <SheetSync channel={syncing} onClose={() => setSyncing(null)} />}
    </>
  );
}

function ChannelForm({ kind, ch, onClose, onSheetSaved }: { kind: Kind; ch: Channel | null; onClose: () => void; onSheetSaved: (c: Channel) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(ch?.name ?? '');
  const [url, setUrl] = useState(ch?.url ?? '');
  const [creator, setCreator] = useState<number | null>(ch?.creatorId ?? null);
  const [sku, setSku] = useState(ch?.skuRequired ?? false);
  const [active, setActive] = useState(ch?.active ?? true);
  const [saved, setSaved] = useState<Channel | null>(ch);
  const users = useRpc('users.list', { activeOnly: true });
  const save = useAction('admin.channels.save', { success: t('admin.channels.saved'), onDone: (r) => (kind === 'sheets' ? (ch ? onClose() : onSheetSaved(r as Channel)) : setSaved(r)) });
  const rotate = useAction('admin.channels.rotateKey', { success: t('admin.channels.rotated'), onDone: (r) => setSaved(r) });
  const kindName = t(`admin.channels.kinds.${kind}`);
  const url_ = saved ? hookUrl(saved.id, saved.webhookKey) : '';
  return (
    <Modal
      wide
      title={ch ? t('admin.channels.formEdit', { name: ch.name }) : t('admin.channels.formNew', { kind: kindName })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button
            className="btn primary"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate({ id: saved?.id, kind, name: name.trim(), creatorId: creator, skuRequired: sku, active, url: kind === 'sheets' ? url.trim() : undefined })}
          >
            {t('admin.channels.save')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label={t('admin.channels.name')}>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('admin.channels.creator')}>
          <select value={creator ?? ''} onChange={(e) => setCreator(e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {kind === 'sheets' && (
        <Field label={t('admin.channels.sheetUrl')} hint={t('admin.channels.sheetHint')}>
          <input value={url} className="ltr" placeholder="https://docs.google.com/spreadsheets/d/…/edit?usp=sharing" onChange={(e) => setUrl(e.target.value)} />
        </Field>
      )}
      <div className="row" style={{ gap: 18, flexWrap: 'wrap', margin: '8px 0' }}>
        <label className="row nowrap" style={{ gap: 8 }}>
          <Switch checked={sku} onChange={setSku} label={t('admin.channels.skuRequired')} />
          {t('admin.channels.skuRequired')}
        </label>
        <label className="row nowrap" style={{ gap: 8 }}>
          <Switch checked={active} onChange={setActive} label={t('admin.channels.active')} />
          {t('admin.channels.active')}
        </label>
      </div>
      {kind !== 'sheets' && (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 8 }}>
          <h3 style={{ margin: '0 0 6px' }}>{t('admin.channels.hookTitle', { kind: kindName })}</h3>
          {!saved ? (
            <p className="muted small">{t('admin.channels.afterSave')}</p>
          ) : (
            <>
              <p className="muted small">{t('admin.channels.hookHelp')}</p>
              <div className="secret-box">
                <code className="ltr">{url_}</code>
                <button
                  className="btn small"
                  onClick={async () => {
                    await copyText(url_);
                    toast(t('admin.channels.copied'), 'ok');
                  }}
                >
                  {t('admin.channels.copy')}
                </button>
                <ConfirmButton className="btn small danger" question={t('admin.channels.rotateConfirm')} onConfirm={() => rotate.mutate({ id: saved.id })}>
                  {t('admin.channels.rotate')}
                </ConfirmButton>
              </div>
              <details style={{ marginTop: 8 }}>
                <summary>{t('admin.channels.sample')}</summary>
                <pre className="code ltr">{JSON.stringify(SAMPLE_ORDER, null, 2)}</pre>
                <p className="muted small">{t('admin.channels.sampleNote')}</p>
              </details>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
