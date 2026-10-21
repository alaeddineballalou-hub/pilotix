// Management → Statuts: rename (fr / ar), recolour, enable, reorder per group; add statuses that behave like a base one.
// Also the "Appels de confirmation" card (call timing, setting calls).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Field, Help, Icon, Loading, Tabs } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { ConfirmButton, IconBtn, intOf, Switch } from './bits';

type Group = 'confirmation' | 'depot' | 'suivi' | 'livraison' | 'sav';
const GROUPS: Group[] = ['confirmation', 'depot', 'suivi', 'livraison', 'sav'];
const TONES = ['info', 'ok', 'mid', 'warn', 'bad', 'off'] as const;
type Tone = (typeof TONES)[number];
const SAV_FR: Record<string, string> = { open: 'En attente', progress: 'En traitement', resolved: 'Livré', closed: 'Annulé' };

interface Row {
  key: string;
  base: boolean;
  name: string;
  original: string;
  ar: string;
  tone: Tone;
  hidden: boolean;
  always: boolean;
  like: string;
}

export function Statuts() {
  const { t } = useTranslation();
  const [group, setGroup] = useState<Group>('confirmation');
  const q = useRpc('admin.statuses.get', {});
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const setLabel = useAction('admin.statuses.setLabel', { success: t('admin.status.saved') });
  const reorder = useAction('admin.statuses.reorder', { success: t('admin.status.reordered') });

  const baseName = (track: string, k: string) => (track === 'conf' ? t(`status.conf.${k}`) : track === 'follow' ? t(`status.follow.${k}`) : t(`sav.status.${k}`, { defaultValue: SAV_FR[k] ?? k }));
  const defTone = (track: string, k: string): Tone => {
    const conf: Record<string, Tone> = { to_check: 'warn', new: 'info', no_answer: 'mid', busy: 'mid', callback: 'mid', postponed: 'mid', no_stock: 'warn', confirmed: 'ok', cancelled: 'bad', duplicate: 'off', wrong_number: 'bad', fake: 'bad' };
    const follow: Record<string, Tone> = { to_prepare: 'info', prepared: 'info', shipped: 'mid', out_for_delivery: 'mid', failed: 'warn', alert: 'bad', in_exchange: 'mid', delivered: 'ok', returning: 'bad', returned: 'bad', exchanged: 'off', lost: 'bad', cancelled: 'off' };
    const sav: Record<string, Tone> = { open: 'bad', progress: 'mid', resolved: 'ok', closed: 'off' };
    return (track === 'conf' ? conf : track === 'follow' ? follow : sav)[k] ?? 'off';
  };

  const rows: Row[] = useMemo(() => {
    if (!q.data) return [];
    const g = q.data.groups[group];
    const L = q.data.labels as Record<string, { fr?: string; ar?: string; tone?: string; hidden?: boolean }>;
    const base: Row[] = g.base.map((k) => ({
      key: k,
      base: true,
      original: baseName(g.track, k),
      name: L[k]?.fr || baseName(g.track, k),
      ar: L[k]?.ar ?? '',
      tone: (L[k]?.tone as Tone) ?? defTone(g.track, k),
      hidden: !!L[k]?.hidden,
      always: g.always.includes(k),
      like: k,
    }));
    const custom: Row[] = q.data.custom
      .filter((c) => c.track === g.track && g.base.includes(c.behavesLike))
      .map((c) => ({ key: c.key, base: false, original: c.label, name: c.label, ar: c.ar ?? '', tone: c.tone as Tone, hidden: !!L[c.key]?.hidden, always: false, like: c.behavesLike }));
    const all = [...base, ...custom];
    const order = q.data.order[group];
    if (order?.length) all.sort((a, b) => (order.indexOf(a.key) + 1 || 999) - (order.indexOf(b.key) + 1 || 999));
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, group, t]);

  const [drag, setDrag] = useState<string | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    const keys = rows.map((r) => r.key);
    const [k] = keys.splice(from, 1);
    keys.splice(to, 0, k);
    reorder.mutate({ group, keys });
  };
  const nameOfKey = (k: string) => rows.find((r) => r.key === k)?.original ?? k;

  return (
    <>
      <div className="card">
        <div className="tabs bjp-tabs" role="tablist" aria-label="Service">
          {GROUPS.map((g) => (
            <button key={g} type="button" role="tab" className={`tab ${g === group ? 'on' : ''}`} aria-selected={g === group} onClick={() => setGroup(g)}>
              {t(`admin.status.groups.${g}`)}
            </button>
          ))}
        </div>
        <div className="card-head">
          <h2>
            {t(`admin.status.title.${group}`)}
            <Help text={`${t(`admin.status.help.${group}`)} ${t('admin.status.helpMore')}`} />
          </h2>
          <button type="button" className="btn primary" onClick={() => setEdit('new')}>
            {t('admin.status.add')}
          </button>
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl bjp-tbl">
              <thead>
                <tr>
                  <th />
                  <th>{t('admin.status.colName')}</th>
                  <th>{t('admin.status.colAr')}</th>
                  <th>{t('admin.status.colTone')}</th>
                  <th>{t('admin.status.colActive')}</th>
                  <th>{t('admin.status.colLike')}</th>
                  <th className="bjp-act">{t('admin.status.colAction')}</th>
                </tr>
              </thead>
              <tbody className="bjp-dnd">
                {rows.map((r, i) => (
                  <tr
                    key={r.key}
                    data-k={r.key}
                    draggable
                    onDragStart={() => setDrag(r.key)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (drag) move(rows.findIndex((x) => x.key === drag), i);
                      setDrag(null);
                    }}
                    className={drag === r.key ? 'bjp-lift' : r.hidden ? 'dim' : ''}
                  >
                    <td className="bjp-hc">
                      <span className="bjp-h" aria-hidden="true" style={{ cursor: 'grab' }}>
                        <Icon name="grip" />
                      </span>
                      <span className="sr-only">
                        <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0}>
                          {t('admin.status.up')}
                        </button>
                        <button type="button" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1}>
                          {t('admin.status.down')}
                        </button>
                      </span>
                    </td>
                    <td data-l={t('admin.status.colName')} className="bjp-nm">
                      {r.name}
                      {!r.base && <small className="muted"> · {t('admin.status.custom')}</small>}
                    </td>
                    <td data-l={t('admin.status.colAr')} className="bjp-arc" dir="rtl">
                      {r.ar || <span className="muted">—</span>}
                    </td>
                    <td data-l={t('admin.status.colTone')}>
                      <span className={`bjp-pill t-${r.tone}`} title={t(`admin.status.tones.${r.tone}`)} />
                    </td>
                    <td data-l={t('admin.status.colActive')}>
                      {r.always ? (
                        <small className="muted" title={t('admin.status.alwaysTip')}>
                          {t('admin.status.always')}
                        </small>
                      ) : (
                        <Switch checked={!r.hidden} label={t('admin.status.active', { name: r.name })} onChange={(v) => setLabel.mutate({ key: r.key, label: { hidden: !v } })} />
                      )}
                    </td>
                    <td data-l={t('admin.status.colLike')}>
                      <small>{nameOfKey(r.like)}</small>
                    </td>
                    <td className="bjp-act">
                      <IconBtn kind="e" title={t('admin.status.edit')} onClick={() => setEdit(r)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t('admin.status.note')}</p>
      </div>
      <CallsCard />
      {edit && q.data && (
        <StatusForm
          group={group}
          row={edit === 'new' ? null : edit}
          baseOptions={rows.filter((r) => r.base).map((r) => ({ key: r.key, name: r.original }))}
          track={q.data.groups[group].track}
          onClose={() => setEdit(null)}
        />
      )}
    </>
  );
}

function StatusForm({ group, row, baseOptions, track, onClose }: { group: Group; row: Row | null; baseOptions: { key: string; name: string }[]; track: 'conf' | 'follow' | 'sav'; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(row?.name ?? '');
  const [ar, setAr] = useState(row?.ar ?? '');
  const [tone, setTone] = useState<Tone>(row?.tone ?? 'mid');
  const [like, setLike] = useState(row?.like ?? baseOptions[0]?.key ?? '');
  const done = { success: t('admin.status.saved'), onDone: onClose };
  const setLabel = useAction('admin.statuses.setLabel', done);
  const add = useAction('admin.statuses.addCustom', done);
  const upd = useAction('admin.statuses.updateCustom', done);
  const del = useAction('admin.statuses.deleteCustom', { success: t('admin.status.deleted'), onDone: onClose });
  const save = () => {
    if (!row) add.mutate({ group, track, label: name.trim(), ar: ar.trim() || undefined, tone, behavesLike: like });
    else if (row.base) setLabel.mutate({ key: row.key, label: { fr: name.trim() === row.original ? '' : name.trim(), ar: ar.trim(), tone } });
    else upd.mutate({ key: row.key, track, label: name.trim(), ar: ar.trim() || undefined, tone, behavesLike: like });
  };
  return (
    <Modal
      title={row ? t('admin.status.formEdit', { name: row.name }) : t('admin.status.formNew', { group: t(`admin.status.groups.${group}`) })}
      onClose={onClose}
      footer={
        <>
          {row && !row.base && (
            <ConfirmButton className="btn ghost danger" question="?" onConfirm={() => del.mutate({ key: row.key })}>
              {t('admin.status.delete')}
            </ConfirmButton>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label={t('admin.status.name')} hint={row?.base && row.name !== row.original ? t('admin.status.original', { name: row.original }) : undefined}>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('admin.status.nameAr')}>
          <input value={ar} maxLength={60} dir="rtl" onChange={(e) => setAr(e.target.value)} />
        </Field>
      </div>
      <Field label={t('admin.status.tone')}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {TONES.map((x) => (
            <label key={x} className="row nowrap" style={{ gap: 6 }}>
              <input type="radio" name="tone" checked={tone === x} onChange={() => setTone(x)} />
              <span className={`badge t-${x}`}>{t(`admin.status.tones.${x}`)}</span>
            </label>
          ))}
        </div>
      </Field>
      {(!row || !row.base) && (
        <Field label={t('admin.status.like')} hint={t('admin.status.likeHint')}>
          <select value={like} onChange={(e) => setLike(e.target.value)}>
            {baseOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  );
}

function CallsCard() {
  const { t } = useTranslation();
  const q = useRpc('admin.pay.get', {});
  const save = useAction('admin.calls.save', { success: t('admin.calls.saved') });
  const [v, setV] = useState<{ first: string; pace: string; cancel: string; tries: string; slots: { key: string; from: string; to: string }[] } | null>(null);
  useEffect(() => {
    const c = q.data?.calls;
    if (c && !v) setV({ first: String(c.firstMinutes), pace: String(c.paceMinutes), cancel: String(c.cancelAfterNoAnswer), tries: String(c.tries), slots: c.slots.map((s) => ({ key: s.key, from: String(s.from), to: String(s.to) })) });
  }, [q.data, v]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!v) return <Loading />;
  const num = (label: string, value: string, set: (s: string) => void, opts: { min?: number; max?: number; help?: string } = {}) => (
    <label className="field">
      <span className="lab">
        {label}
        {opts.help && <Help text={opts.help} />}
      </span>
      <input type="number" min={opts.min ?? 0} max={opts.max} step={1} inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <Card title={t('admin.calls.title')} help={t('admin.calls.help')}>
      <div className="bjp-grid">
        {num(t('admin.calls.first'), v.first, (s) => setV({ ...v, first: s }), { min: 1 })}
        {num(t('admin.calls.pace'), v.pace, (s) => setV({ ...v, pace: s }))}
        {num(t('admin.calls.cancel'), v.cancel, (s) => setV({ ...v, cancel: s }), { max: 30, help: t('admin.calls.cancelHelp') })}
        {num(t('admin.calls.tries'), v.tries, (s) => setV({ ...v, tries: s }), { min: 1, max: 10 })}
      </div>
      <div className="bjp-grid">
        {v.slots.map((s, i) => {
          const name = t(`admin.calls.slots.${s.key}`, { defaultValue: s.key });
          const set = (k: 'from' | 'to', val: string) => setV({ ...v, slots: v.slots.map((x, j) => (j === i ? { ...x, [k]: val } : x)) });
          return (
            <div key={s.key} className="field">
              <span className="lab">{t('admin.calls.slot', { name })}</span>
              <div className="bjp-slot">
                <input type="number" min={0} max={24} step={1} inputMode="numeric" value={s.from} aria-label={t('admin.calls.start', { name })} onChange={(e) => set('from', e.target.value)} />
                <span>{t('admin.calls.to')}</span>
                <input type="number" min={0} max={24} step={1} inputMode="numeric" value={s.to} aria-label={t('admin.calls.end', { name })} onChange={(e) => set('to', e.target.value)} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="row end">
        <button
          className="btn primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              firstMinutes: Math.max(1, intOf(v.first)),
              paceMinutes: intOf(v.pace),
              cancelAfterNoAnswer: Math.min(30, intOf(v.cancel)),
              tries: Math.min(10, Math.max(1, intOf(v.tries))),
              slots: v.slots.map((s) => ({ key: s.key, from: Math.min(24, intOf(s.from)), to: Math.min(24, intOf(s.to)) })),
            })
          }
        >
          {t('admin.calls.save')}
        </button>
      </div>
    </Card>
  );
}
