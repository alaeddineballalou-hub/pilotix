// « Copier des réglages » (Mes boutiques): the owner takes what another of their boutiques is set up with into the one
// chosen above — its delivery companies (with the same keys or not), its customers' prices, its statuses, its work
// rules, its messages, its landing pages' settings, its AI agents' way of talking. What the other boutique never set is
// shown and left unticked; a short question before anything is replaced (boutiques.copyPreview, boutiques.copy).
import type { Boutique } from '@pilotix/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpcFor } from '../../lib/query';
import { BoutiqueLogo } from '../../layout/Boutiques';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';

const PARTS = [
  { key: 'couriers', icon: 'truck' },
  { key: 'fees', icon: 'coins' },
  { key: 'statuses', icon: 'tag' },
  { key: 'work', icon: 'users' },
  { key: 'messages', icon: 'message' },
  { key: 'pages', icon: 'globe' },
  { key: 'ai', icon: 'sparkles' },
] as const;
type Part = (typeof PARTS)[number]['key'];

export function CopyCard({ to, others }: { to: Boutique; others: Boutique[] }) {
  const { t } = useTranslation();
  const [fromId, setFromId] = useState(others[0].id);
  const from = others.find((b) => b.id === fromId) ?? others[0];
  const pre = useRpcFor(null, 'boutiques.copyPreview', { from: from.id, to: to.id }, { staleTime: 0 });
  const [parts, setParts] = useState<Set<Part>>(new Set());
  const [keys, setKeys] = useState(true);
  const [ask, setAsk] = useState(false);
  const data = pre.data && !pre.isPlaceholderData ? pre.data : null;
  // what the other boutique set is ticked; what it never set stays unticked (it would change nothing)
  useEffect(() => {
    if (data) setParts(new Set(PARTS.map((p) => p.key).filter((k) => data.set[k])));
  }, [data]);
  const copy = useAction('boutiques.copy', { success: t('boutiques.copy.done', { name: to.name }), onDone: () => setAsk(false) });
  const done = copy.data && copy.variables?.from === from.id ? copy.data : null;
  const toggle = (k: Part) => setParts((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const chosen = PARTS.filter((p) => parts.has(p.key));
  const names = useMemo(() => chosen.map((p) => t(`boutiques.copy.parts.${p.key}`)), [chosen, t]);

  return (
    <section className="card bqp-copy" aria-labelledby="bqp-copy-h">
      <div className="bqp-copy-top">
        <div>
          <h2 id="bqp-copy-h">{t('boutiques.copy.title')}</h2>
          <p className="bqp-sub">{t('boutiques.copy.sub')}</p>
        </div>
        <div className="bqp-copy-flow">
          <label className="bqp-copy-end">
            <span className="lab">{t('boutiques.copy.from')}</span>
            <span className="bqp-copy-pick">
              <BoutiqueLogo name={from.name} logo={from.logo} size={28} />
              <select value={from.id} onChange={(e) => (setFromId(Number(e.target.value)), copy.reset())}>
                {others.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <span className="bqp-copy-arrow" aria-hidden="true">
            <Icon name="arrow" />
          </span>
          <div className="bqp-copy-end">
            <span className="lab">{t('boutiques.copy.to')}</span>
            <span className="bqp-copy-pick is-to">
              <BoutiqueLogo name={to.name} logo={to.logo} size={28} />
              <b>{to.name}</b>
            </span>
          </div>
        </div>
      </div>

      <div className="bqp-parts" aria-busy={!data}>
        {PARTS.map((p) => {
          const set = data ? data.set[p.key] : true;
          return (
            <div key={p.key} className={`bqp-part${parts.has(p.key) ? ' on' : ''}${data && !set ? ' empty' : ''}`}>
              <label className="bqp-part-row">
                <input type="checkbox" checked={parts.has(p.key)} disabled={!data || !set} onChange={() => toggle(p.key)} />
                <span className="bqp-part-ic" aria-hidden="true">
                  <Icon name={p.icon} />
                </span>
                <span className="bqp-part-t">
                  <b>{t(`boutiques.copy.parts.${p.key}`)}</b>
                  <small>{t(`boutiques.copy.parts.${p.key}Text`)}</small>
                  {data && !set && <em>{t('boutiques.copy.nothing', { name: from.name })}</em>}
                </span>
              </label>
              {p.key === 'couriers' && data && data.companies.length > 0 && (
                <div className="bqp-part-more">
                  <div className="bqp-cos">
                    {data.companies.map((c) => (
                      <span key={`${c.kind}-${c.name}`} className="bqp-co" title={c.there ? t('boutiques.copy.there') : undefined}>
                        {c.name}
                        {c.keys && (
                          <span className="bqp-co-key" title={t('boutiques.copy.keysOn')}>
                            <Icon name="key" />
                          </span>
                        )}
                        {c.there && <small>{t('boutiques.copy.there')}</small>}
                      </span>
                    ))}
                  </div>
                  {parts.has('couriers') && data.companies.some((c) => c.keys) && (
                    <label className="bqp-keys">
                      <input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} />
                      <span>{t('boutiques.copy.keys')}</span>
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="bqp-copy-note">
        <Icon name="info" />
        <span>{t('boutiques.copy.note', { name: to.name })}</span>
      </p>

      {done && (
        <div className="bqp-copy-done" role="status">
          <Icon name="checkcircle" />
          <div>
            <b>{t('boutiques.copy.done', { name: to.name })}</b>
            <span>{t('boutiques.copy.doneParts', { list: done.parts.map((p) => t(`boutiques.copy.parts.${p}`)).join(' · ') })}</span>
            {done.added.length > 0 && <span>{t('boutiques.copy.added', { list: done.added.join(', ') })}</span>}
            {done.updated.length > 0 && <span>{t('boutiques.copy.updated', { list: done.updated.join(', ') })}</span>}
          </div>
        </div>
      )}

      <div className="bqp-actions bqp-copy-actions">
        <span className="bqp-hint">{parts.size ? names.join(' · ') : t('boutiques.copy.none')}</span>
        <button type="button" className="btn primary" disabled={!data || !parts.size || copy.isPending} onClick={() => setAsk(true)}>
          <Icon name="copy" /> {t('boutiques.copy.go', { name: to.name })}
        </button>
      </div>

      {ask && (
        <Modal
          title={t('boutiques.copy.askTitle', { name: to.name })}
          onClose={() => setAsk(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsk(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn primary" disabled={copy.isPending} onClick={() => copy.mutate({ from: from.id, to: to.id, parts: chosen.map((p) => p.key), keys })}>
                {copy.isPending ? '…' : t('boutiques.copy.ok')}
              </button>
            </>
          }
        >
          <p>{t('boutiques.copy.askText', { from: from.name, to: to.name })}</p>
          <ul className="bqp-ask">
            {chosen.map((p) => (
              <li key={p.key}>
                <Icon name={p.icon} /> {t(`boutiques.copy.parts.${p.key}`)}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  );
}
