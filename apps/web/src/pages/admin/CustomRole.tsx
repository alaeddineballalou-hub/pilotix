// Utilisateurs › Rôles › « + Nouveau rôle » (the owner's choice, 22 Nov 2026): a role made in the boutique, by an
// administrator or by someone who manages the team's accounts. A name, the role it starts from (one its maker has: its
// server rules, an agent sees only his orders…), and what it sees and does on top of it — never more than its maker
// has: what the maker does not have stays off here, and goes off by itself the day the maker loses it. A maker sees only
// the roles they made; an administrator sees them all. Saved with roles.custom.save, given from a person's card.
import { byDefault, type CustomBase, customSetFrom, type RightDef, RIGHTS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { ConfirmButton, Switch } from './bits';
import { ActRow, MenuPreview, roleMenu } from './RoleRights';
import './rolerights.css';

type Edit = { name: string; off: string[]; on: string[] };

/** One right switched in the draft: one its starting role has is taken away (or given back), another given (or taken back). */
function toggled(e: Edit, d: RightDef, on: boolean, baseHas: ReadonlySet<string>): Edit {
  if (baseHas.has(d.id)) return { ...e, off: on ? e.off.filter((x) => x !== d.id) : [...new Set([...e.off, d.id])] };
  return { ...e, on: on ? [...new Set([...e.on, d.id])] : e.on.filter((x) => x !== d.id) };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** « + Nouveau rôle »: its name and the role it starts from (one the person has); then its editor opens. */
export function NewRoleModal({ bases, onClose }: { bases: readonly CustomBase[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [base, setBase] = useState<CustomBase | ''>(bases.length === 1 ? bases[0] : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!base) return setErr(t('rights.custom.pickBase'));
    setBusy(true);
    setErr('');
    try {
      const r = await rpc('roles.custom.save', { name: name.trim(), base });
      await qc.invalidateQueries();
      toast(t('rights.custom.created', { name: name.trim() }), 'ok');
      onClose();
      location.hash = `#/utilisateurs/roles/${r.id}`;
    } catch (x: any) {
      setErr(String(x?.message ?? x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('rights.custom.newTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button type="submit" form="px-role-form" className="btn primary" disabled={busy}>
            {t('rights.custom.create')}
          </button>
        </>
      }
    >
      <form id="px-role-form" onSubmit={submit}>
        <Field label={t('rights.custom.name')} hint={t('rights.custom.nameHint')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} autoFocus autoComplete="off" placeholder={t('rights.custom.namePh')} />
        </Field>
        <Field label={t('rights.custom.base')} hint={t('rights.custom.baseHint')}>
          <div className="rr-bases" role="radiogroup" aria-label={t('rights.custom.base')}>
            {bases.map((b) => (
              <label key={b} className={`rr-base${base === b ? ' on' : ''}`}>
                <input type="radio" name="px-role-base" checked={base === b} onChange={() => setBase(b)} />
                <span>
                  <b>{t(`roles.${b}`)}</b>
                  <small>{b === 'admin' ? t('rights.adminAll') : t(`admin.users.desc.${b}`)}</small>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <p className="rr-capbox">
          <Icon name="info" />
          <span>{t('rights.custom.capHint')}</span>
        </p>
        {err && <p className="error">{err}</p>}
      </form>
    </Modal>
  );
}

/** Utilisateurs › Rôles › a role made here: its name, its switches (never beyond its maker), who has it. */
export function CustomRolePage({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useRpc('roles.custom.list', {});
  const role = q.data?.roles.find((r) => r.id === id) ?? null;
  const [draft, setDraft] = useState<Edit | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (role && !draft) setDraft({ name: role.name, off: role.off, on: role.on });
  }, [role, draft]);
  const changes = role && draft ? (draft.name.trim() !== role.name ? 1 : 0) + (sameSet(draft.off, role.off) ? 0 : 1) + (sameSet(draft.on, role.on) ? 0 : 1) : 0;
  // leaving the page with changes not saved: the browser asks first
  useEffect(() => {
    if (!changes) return;
    const stay = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [changes]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!role)
    return (
      <div className="card">
        <Empty>{t('rights.custom.gone')}</Empty>
        <a className="btn" href="#/utilisateurs/roles">
          {t('rights.custom.backList')}
        </a>
      </div>
    );
  if (!draft) return <Loading />;

  const base = role.base as CustomBase;
  const baseHas = new Set(role.baseHas);
  const canOn = new Set(role.canOn);
  const cap = role.cap ? new Set(role.cap) : null;
  const set = customSetFrom(baseHas, draft, canOn, cap);
  /** its maker does not have it: it stays off */
  const blocked = (d: RightDef) => !!cap && !d.locked && !cap.has(d.id);
  const can = (d: RightDef) => !d.locked && !blocked(d) && (baseHas.has(d.id) || canOn.has(d.id));
  const changed = (d: RightDef) => draft.off.includes(d.id) || draft.on.includes(d.id);
  const flip = (d: RightDef, v: boolean) => setDraft(toggled(draft, d, v, baseHas));
  const maker = role.mine ? t('rights.custom.you') : (role.byName ?? '—');
  const capNote = role.mine ? t('rights.custom.notYours') : t('rights.custom.notMaker', { name: role.byName ?? '—' });
  const { asRoles, lines, parts, partName, also } = base === 'admin'
    ? { asRoles: [], lines: [], parts: [], partName: () => '', also: () => [] }
    : roleMenu(base, t);
  const extras = RIGHTS.filter((d) => base !== 'admin' && !byDefault(base, d) && canOn.has(d.id));
  const opened = lines.find((l) => l.key === open && l.page) ?? null;
  const name = draft.name.trim().replace(/\s+/g, ' ');

  const save = async () => {
    setBusy(true);
    try {
      await rpc('roles.custom.save', { id: role.id, name, base, off: draft.off, on: draft.on });
      await qc.invalidateQueries();
      const fresh = (await q.refetch()).data?.roles.find((r) => r.id === id);
      setDraft(fresh ? { name: fresh.name, off: fresh.off, on: fresh.on } : null);
      toast(t('rights.custom.saved'), 'ok');
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await rpc('roles.custom.delete', { id: role.id });
      await qc.invalidateQueries();
      toast(t('rights.custom.deleted', { name: role.name }), 'ok');
      location.hash = '#/utilisateurs/roles';
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    }
  };

  return (
    <div className="rr">
      <div className="rr-head">
        <div>
          <a className="rr-backl" href="#/utilisateurs/roles">
            <Icon name="chevr" /> {t('rights.custom.backList')}
          </a>
          <label className="rr-namel">
            <span className="sr-only">{t('rights.custom.name')}</span>
            <input className="rr-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={40} aria-invalid={name.length < 2} />
          </label>
          <p>{t('rights.custom.sub', { base: t(`roles.${base}`), who: maker })}</p>
        </div>
        <ConfirmButton className="btn ghost" disabled={role.people.length > 0 || busy} question={t('rights.custom.deleteQ', { name: role.name })} onConfirm={remove}>
          <Icon name="trash" /> {t('rights.custom.delete')}
        </ConfirmButton>
      </div>

      <p className="rr-capbox">
        <Icon name="info" />
        <span>{base === 'admin' ? t('rights.adminAll') : !cap ? t('rights.custom.noCap') : role.mine ? t('rights.custom.capYou') : t('rights.custom.capOf', { name: role.byName ?? '—' })}</span>
      </p>

      <div className="rr-who">
        {role.people.length ? (
          <>
            <span>{t('rights.custom.givenTo')}</span>
            {role.people.map((p) => (
              <span key={p.id} className={`chip${p.active ? '' : ' dim'}`}>
                {p.name}
              </span>
            ))}
            <small>{t('rights.custom.deleteFirst')}</small>
          </>
        ) : (
          <span>{t('rights.custom.nobody')}</span>
        )}
      </div>

      <div className="rr-cols" style={base === 'admin' ? { display: 'none' } : undefined}>
        <div className="rr-l">
          <section className="rr-tree" aria-label={t('rights.menuOf', { role: name || role.name })}>
            <h2>{t('rights.menuOf', { role: name || role.name })}</h2>
            {parts.map((p) => (
              <section key={p.id} className="rr-part" aria-labelledby={`rr-part-${p.id}`}>
                <div className="rr-part-h">
                  <Icon name={p.icon} />
                  <b id={`rr-part-${p.id}`}>{partName(p.id)}</b>
                  <small>{p.id === 'none' ? t('rights.partNoneHint') : t('rights.nPages', { count: p.lines.filter((l) => l.page).length })}</small>
                </div>
                {p.lines.map((l, i) => {
                  const groupStart = l.group && l.group !== p.lines[i - 1]?.group;
                  const isOpen = open === l.key;
                  const on = !l.page || set.has(l.page.id);
                  const tabsOn = l.tabs.filter((x) => set.has(x.id)).length;
                  const actsOn = l.acts.filter((x) => set.has(x.id)).length;
                  const elsewhere = also(l);
                  const sub = [
                    l.tabs.length ? t('rights.tabsN', { count: tabsOn, of: l.tabs.length }) : '',
                    l.acts.length ? t('rights.actsN', { count: actsOn, of: l.acts.length }) : '',
                    elsewhere.length ? t('rights.alsoOn', { list: elsewhere.map((s) => t(`nav.screens.${s}`)).join(', ') }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const anyChange = (l.page && changed(l.page)) || l.tabs.some(changed) || l.acts.some(changed);
                  return (
                    <div key={l.key} className={`rr-line${l.group ? ' g' : ''}${isOpen ? ' open' : ''}${on ? '' : ' off'}`}>
                      {groupStart && <div className="rr-group">{t(`nav.${l.group}`)}</div>}
                      <div className="rr-it">
                        <Icon name={l.icon} className="rr-ic" />
                        <div className="rr-t">
                          <b>{l.label}</b>
                          {l.key === 'orders' && <small>{t('rights.ordersSub')}</small>}
                          {sub && <small>{sub}</small>}
                          {l.page && blocked(l.page) && <small className="rr-capnote">{capNote}</small>}
                        </div>
                        {anyChange && <span className="rr-mod">{t('rights.modified')}</span>}
                        {(l.tabs.length > 0 || l.acts.length > 0) && (
                          <button type="button" className="rr-exp" aria-expanded={isOpen} aria-label={t(isOpen ? 'rights.close' : 'rights.open', { name: l.label })} onClick={() => setOpen(isOpen ? null : l.key)}>
                            <Icon name={isOpen ? 'chevron' : 'chevr'} />
                          </button>
                        )}
                        {l.page?.locked ? (
                          <span className="rr-lock">
                            <Icon name="lock" />
                            {t('rights.always')}
                          </span>
                        ) : l.page ? (
                          <Switch checked={on} label={l.label} disabled={!can(l.page)} onChange={(v) => flip(l.page!, v)} />
                        ) : null}
                      </div>
                      {isOpen && (
                        <div className="rr-in">
                          {!on && <p className="rr-note">{t('rights.pageOff')}</p>}
                          {l.tabs.length > 0 && (
                            <>
                              <div className="rr-lab">{t('rights.tabs')}</div>
                              <div className="rr-chips">
                                {l.tabs.map((x) => {
                                  const v = set.has(x.id);
                                  return (
                                    <button key={x.id} type="button" className={`rr-chip${v ? ' on' : ''}`} aria-pressed={v} disabled={!on || !can(x)} title={blocked(x) ? capNote : undefined} onClick={() => flip(x, !v)}>
                                      {changed(x) && <i className="rr-dot" aria-hidden="true" />}
                                      {t(x.label)}
                                    </button>
                                  );
                                })}
                              </div>
                            </>
                          )}
                          {l.acts.length > 0 && (
                            <>
                              <div className="rr-lab">{t('rights.acts')}</div>
                              {l.acts.map((x) => (
                                <ActRow key={x.id} d={x} on={set.has(x.id)} changed={changed(x)} disabled={!can(x)} note={blocked(x) ? capNote : undefined} onChange={(v) => flip(x, v)} />
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            {extras.length > 0 && (
              <>
                <div className="rr-sep" />
                <h2>{t('rights.extra')}</h2>
                <p className="rr-hint">{t('rights.custom.extraSub')}</p>
                {extras.map((x) => (
                  <ActRow key={x.id} d={x} on={set.has(x.id)} changed={false} extra disabled={!can(x)} note={blocked(x) ? capNote : undefined} onChange={(v) => flip(x, v)} />
                ))}
              </>
            )}
          </section>
        </div>
        <MenuPreview caption={t('rights.previewRole', { role: name || role.name })} asRoles={asRoles} set={set} opened={opened} />
      </div>

      {changes > 0 && (
        <div className="rr-bar" role="region" aria-label={t('rights.custom.unsaved')}>
          <p>
            {t('rights.custom.unsaved')}
            <small>{name.length < 2 ? t('rights.custom.nameShort') : t('rights.custom.unsavedSub')}</small>
          </p>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft({ name: role.name, off: role.off, on: role.on })}>
            {t('rights.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || name.length < 2} onClick={save}>
            {t('rights.custom.save')}
          </button>
        </div>
      )}
    </div>
  );
}
