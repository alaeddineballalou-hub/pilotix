// Sociétés de livraison › « Pilot Auto Assign »: who delivers each order.
//  - « Manuel »: the team chooses (the default company first, see Préférences).
//  - « Pilot Auto Assign »: the seller's rules — wilayas (or « toutes sauf… »), communes and/or products → a company or
//    « Livraison privée », strict or soft. A rule crossing another shows it while it is written; when saving, Pilot
//    asks who wins each clash (or « À attribuer ») and remembers it, then offers to move the waiting orders.
//  - « Tester une commande »: who gets an order, and why, with the rules on screen (saved or not).
// Admins and the people ticked in Utilisateurs change the rules; others see them.
import { ALL_WILAYAS, type Clash, CLASH_ASSIGN, clashesOf, communesOf, newRuleId, normCommune, type PilotRule, REGIONS, ruleNumber } from '@pilotix/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../lib/i18n';
import { type Out, rpc } from '../../lib/backend';
import { wilaya, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import './pilot.css';
import { ToFix } from './ToFix';

type Data = Out<'pilot.get'>;
type Co = Data['companies'][number];
type Answer = { a: string; b: string; win: string };
type Cfg = { mode: 'auto' | 'manual'; rules: PilotRule[]; clashes: Answer[]; def: number | null };
type Sample = Out<'pilot.preview'>['sample'];
const REGION_KEYS = ['ouest', 'centre', 'est', 'sud'] as const;
const blank = (rules: PilotRule[], to: number): PilotRule => ({ id: newRuleId(rules), wilayas: [], except: false, communes: [], products: [], to, strict: false, on: true });

/** A commune's name in the language on screen (rules keep the French name). */
function communeLabel(w: number, c: string): string {
  if (i18n.language !== 'ar') return c;
  const n = normCommune(c);
  return communesOf(w).find((x) => normCommune(x[1]) === n)?.[2] || c;
}

export function Pilot() {
  const { t } = useTranslation();
  const q = useRpc('pilot.get', {});
  const [draft, setDraft] = useState<Cfg | null>(null);
  const [edit, setEdit] = useState<{ rule: PilotRule; index: number | null } | null>(null);
  const [ask, setAsk] = useState<Clash[] | null>(null);
  const [move, setMove] = useState<{ waiting: number; sample: Sample } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = useAction('pilot.save', {
    success: (r) => (r.moved ? t('livraison.pilot.savedMoved', { count: r.moved }) : t('livraison.pilot.saved')),
    onDone: () => {
      setDraft(null);
      setMove(null);
      setAsk(null);
    },
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const saved: Cfg = { mode: d.mode, rules: d.rules, clashes: d.clashes, def: d.defaultCompanyId };
  const v = draft ?? saved;
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const set = (p: Partial<Cfg>) => setDraft({ ...v, ...p });
  const cos = new Map(d.companies.map((c) => [c.id, c]));
  const canEdit = d.canEdit;
  const clashes = clashesOf(v);
  const coName = (id: number) => {
    const c = cos.get(id);
    return c?.own ? t('livraison.pilot.private') : (c?.name ?? '?');
  };
  const send = (moveToo: boolean) => save.mutate({ mode: v.mode, rules: v.rules, clashes: v.clashes, defaultCompanyId: v.def, move: moveToo });

  /** « Enregistrer »: every clash answered first, then « Déplacer les N commandes en attente aussi ? ». */
  const trySave = async (cfg: Cfg = v) => {
    setBusy(true);
    try {
      const p = await rpc('pilot.preview', { mode: cfg.mode, rules: cfg.rules, clashes: cfg.clashes });
      // only the clashes without an answer yet (the others are listed on the page, where they can be changed)
      const open = p.clashes.filter((c) => c.kind === 'ask' && !c.win);
      if (open.length) return setAsk(open);
      if (p.waiting > 0) return setMove({ waiting: p.waiting, sample: p.sample });
      save.mutate({ mode: cfg.mode, rules: cfg.rules, clashes: cfg.clashes, defaultCompanyId: cfg.def, move: false });
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const putRule = (r: PilotRule, index: number | null, extra?: PilotRule) => {
    const add = extra ? [r, extra] : [r];
    const rules = index === null ? [...v.rules, ...add] : v.rules.flatMap((x, k) => (k === index ? add : [x]));
    set({ rules });
    setEdit(null);
  };
  const swap = (k: number, dir: -1 | 1) => {
    const rules = [...v.rules];
    const j = k + dir;
    if (j < 0 || j >= rules.length) return;
    [rules[k], rules[j]] = [rules[j], rules[k]];
    set({ rules });
  };
  const firstCompany = d.companies.find((c) => c.active && !c.own)?.id ?? d.companies[0]?.id ?? 0;

  return (
    <div className="pl">
      <div className="pl-head">
        <div className="pl-title">
          <h2>{t('livraison.pilot.title')}</h2>
          <p className="muted">{t('livraison.pilot.help')}</p>
        </div>
        <div className="pl-mode" role="radiogroup" aria-label={t('livraison.pilot.mode')}>
          {(['auto', 'manual'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={v.mode === m} className={v.mode === m ? 'on' : ''} disabled={!canEdit} onClick={() => set({ mode: m })}>
              <Icon name={m === 'auto' ? 'sparkles' : 'usercog'} />
              {t(`livraison.pilot.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="pl-hint">
        <Icon name="info" />
        {t(v.mode === 'auto' ? 'livraison.pilot.autoHint' : 'livraison.pilot.manualHint')}
      </p>
      {!canEdit && (
        <p className="pl-hint ro">
          <Icon name="lock" />
          {t('livraison.pilot.readOnly')}
        </p>
      )}

      {v.mode === 'auto' && (
        <section className="pl-card" aria-labelledby="pl-rules-h">
          <div className="pl-card-h">
            <b id="pl-rules-h">{t('livraison.pilot.rules')}</b>
            <small>{t('livraison.pilot.rulesHint')}</small>
          </div>
          {!v.rules.length && <p className="pl-empty muted">{t('livraison.pilot.empty')}</p>}
          <ol className="pl-rules">
            {v.rules.map((r, k) => (
              <RuleRow
                key={r.id}
                n={k + 1}
                r={r}
                co={cos.get(r.to)}
                data={d}
                canEdit={canEdit}
                first={k === 0}
                last={k === v.rules.length - 1}
                onEdit={() => setEdit({ rule: r, index: k })}
                onToggle={() => set({ rules: v.rules.map((x) => (x.id === r.id ? { ...x, on: !x.on } : x)) })}
                onDelete={() => window.confirm(t('livraison.pilot.delAsk', { n: k + 1 })) && set({ rules: v.rules.filter((x) => x.id !== r.id) })}
                onMove={(dir) => swap(k, dir)}
              />
            ))}
            <li className="pl-rule other">
              <span className="pl-n" aria-hidden="true">
                <Icon name="more" />
              </span>
              <div className="pl-what">
                <span className="pl-chip">{t('livraison.pilot.others')}</span>
              </div>
              <Icon name="arrow" className="pl-arrow" />
              <label className="pl-def">
                <span className="sr-only">{t('livraison.pilot.default')}</span>
                <select value={v.def ?? ''} disabled={!canEdit} onChange={(e) => set({ def: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('livraison.pilot.noDefault')}</option>
                  {d.companies
                    .filter((c) => c.active && !c.own)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <span className="pl-force def">{t('livraison.pilot.default')}</span>
            </li>
          </ol>
          {canEdit && (
            <button type="button" className="btn pl-add" onClick={() => setEdit({ rule: blank(v.rules, firstCompany), index: null })}>
              <Icon name="plus" /> {t('livraison.pilot.add')}
            </button>
          )}
        </section>
      )}

      {v.mode === 'auto' && clashes.length > 0 && (
        <section className="pl-card" aria-labelledby="pl-clash-h">
          <div className="pl-card-h">
            <b id="pl-clash-h">{t('livraison.pilot.clashesT')}</b>
            <small>{t('livraison.pilot.clashesHint')}</small>
          </div>
          <ul className="pl-clashes">
            {clashes
              .filter((c) => c.kind === 'ask')
              .map((c) => {
                const ra = v.rules.find((r) => r.id === c.a)!;
                const rb = v.rules.find((r) => r.id === c.b)!;
                const na = ruleNumber(v.rules, c.a);
                const nb = ruleNumber(v.rules, c.b);
                return (
                  <li key={`${c.a}|${c.b}`} className={!c.win ? 'open' : ''}>
                    <span className="pl-pair">
                      <b>{t('livraison.pilot.ruleN', { n: na })}</b> · <b>{t('livraison.pilot.ruleN', { n: nb })}</b>
                    </span>
                    <span className="pl-ex">{exampleText(t, c.example, d)}</span>
                    <label className="pl-ans">
                      <span className="sr-only">{t('livraison.pilot.askQ', { a: na, b: nb })}</span>
                      <select
                        value={c.win ?? ''}
                        disabled={!canEdit}
                        onChange={(e) => set({ clashes: [...v.clashes.filter((x) => !samePair(x, c)), ...(e.target.value ? [{ a: c.a, b: c.b, win: e.target.value }] : [])] })}
                      >
                        <option value="">{t('livraison.pilot.notAnswered')}</option>
                        <option value={c.a}>{t('livraison.pilot.winsOpt', { co: coName(ra.to), n: na })}</option>
                        <option value={c.b}>{t('livraison.pilot.winsOpt', { co: coName(rb.to), n: nb })}</option>
                        <option value={CLASH_ASSIGN}>{t('livraison.pilot.toAssign')}</option>
                      </select>
                    </label>
                  </li>
                );
              })}
            {strictGroups(v.rules, clashes).map(([sid, others]) => {
              const n = ruleNumber(v.rules, sid);
              return (
                <li key={`s-${sid}`} className="strict">
                  <span className="pl-pair">
                    <b>{t('livraison.pilot.ruleN', { n })}</b>
                  </span>
                  <span className="pl-ex">{t('livraison.pilot.strictOver', { count: others.length, list: others.join(', ') })}</span>
                  <span className="pl-ans strict">
                    <Icon name="lock" /> {t('livraison.pilot.strictWins', { n })}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {v.mode === 'auto' && canEdit && <ToFix />}

      {v.mode === 'auto' && <Tester cfg={v} data={d} />}

      {dirty && canEdit && (
        <div className="pl-foot" role="region" aria-label={t('livraison.pilot.unsaved')}>
          <span className="pl-state">{t('livraison.pilot.unsaved')}</span>
          <button type="button" className="btn" disabled={busy || save.isPending} onClick={() => setDraft(null)}>
            {t('livraison.pilot.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || save.isPending} onClick={() => trySave()}>
            {t('livraison.pilot.save')}
          </button>
        </div>
      )}

      {edit && (
        <RuleEditor
          initial={edit.rule}
          index={edit.index}
          cfg={v}
          data={d}
          onClose={() => setEdit(null)}
          onKeep={(r, extra) => putRule(r, edit.index, extra)}
        />
      )}
      {ask && (
        <AskDialog
          clashes={ask}
          cfg={v}
          data={d}
          onClose={() => setAsk(null)}
          onDone={(answers) => {
            const next = { ...v, clashes: [...v.clashes.filter((x) => !answers.some((a) => samePair(x, a))), ...answers] };
            setDraft(next);
            setAsk(null);
            void trySave(next);
          }}
        />
      )}
      {move && (
        <Modal
          sheet
          title={t('livraison.pilot.moveT', { count: move.waiting })}
          onClose={() => setMove(null)}
          footer={
            <>
              <button type="button" className="btn" disabled={save.isPending} onClick={() => send(false)}>
                {t('livraison.pilot.moveNo')}
              </button>
              <button type="button" className="btn primary" disabled={save.isPending} onClick={() => send(true)}>
                {t('livraison.pilot.moveYes', { count: move.waiting })}
              </button>
            </>
          }
        >
          <div className="pl-move">
            <p>{t('livraison.pilot.moveHelp')}</p>
            <ul className="pl-moves">
              {move.sample.map((s) => (
                <li key={s.id}>
                  <b className="ltr">{s.ref}</b>
                  <span>{s.from}</span>
                  <Icon name="arrow" className="pl-arrow" />
                  <b>{s.to}</b>
                </li>
              ))}
            </ul>
            {move.waiting > move.sample.length && <p className="muted">{t('livraison.pilot.moveMore', { count: move.waiting - move.sample.length })}</p>}
            <p className="pl-never">
              <Icon name="lock" />
              {t('livraison.pilot.moveNever')}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Strict rules that cross soft ones: one line per strict rule (« croise les règles 3, 4, 5 »), it wins by itself. */
function strictGroups(rules: PilotRule[], clashes: Clash[]): [string, number[]][] {
  const by = new Map<string, number[]>();
  for (const c of clashes.filter((x) => x.kind === 'strict')) {
    const a = rules.find((r) => r.id === c.a);
    const sid = a?.strict ? c.a : c.b;
    const other = sid === c.a ? c.b : c.a;
    by.set(sid, [...(by.get(sid) ?? []), ruleNumber(rules, other)].sort((x, y) => x - y));
  }
  return [...by.entries()].sort((x, y) => ruleNumber(rules, x[0]) - ruleNumber(rules, y[0]));
}

const samePair = (x: Answer, c: { a: string; b: string }) => (x.a === c.a && x.b === c.b) || (x.a === c.b && x.b === c.a);

/** « Une commande « Lit parapluie » à Bab Ezzouar (16 Alger) » */
function exampleText(t: (k: string, o?: any) => string, ex: Clash['example'], d: Data): string {
  const where = ex.commune ? `${communeLabel(ex.wilayaId, ex.commune)} (${wilaya(ex.wilayaId)})` : wilaya(ex.wilayaId);
  const pn = (id: number) => d.products.find((p) => p.id === id)?.name ?? `#${id}`;
  if (ex.products.length > 1) return t('livraison.pilot.exTwo', { p1: pn(ex.products[0]), p2: pn(ex.products[1]), where });
  if (ex.products.length) return t('livraison.pilot.exOne', { p: pn(ex.products[0]), where });
  return t('livraison.pilot.exPlace', { where });
}

/** What a rule covers, as short chips. */
function placeChips(t: (k: string, o?: any) => string, r: PilotRule): { key: string; text: string; tone?: string }[] {
  if (r.except) return [{ key: 'but', text: t('livraison.pilot.allBut'), tone: 'but' }, ...r.wilayas.map((w) => ({ key: `w${w}`, text: wilaya(w), tone: 'out' }))];
  if (!r.wilayas.length) return [{ key: 'all', text: t('livraison.pilot.allW') }];
  const regions = REGION_KEYS.filter((k) => REGIONS[k].every((w) => r.wilayas.includes(w)) && !r.communes.some((c) => REGIONS[k].includes(c.w)));
  const inRegion = new Set(regions.flatMap((k) => REGIONS[k]));
  const chips: { key: string; text: string; tone?: string }[] = regions.map((k) => ({ key: k, text: t(`livraison.pilot.regions.${k}`), tone: 'region' }));
  for (const w of r.wilayas) {
    if (inRegion.has(w)) continue;
    const cs = r.communes.filter((c) => c.w === w);
    if (!cs.length) chips.push({ key: `w${w}`, text: wilaya(w) });
    else chips.push({ key: `w${w}`, text: `${wilayaName(w)} › ${cs.slice(0, 3).map((c) => communeLabel(w, c.c)).join(', ')}${cs.length > 3 ? ` +${cs.length - 3}` : ''}` });
  }
  return chips;
}

function RuleRow(p: {
  n: number;
  r: PilotRule;
  co: Co | undefined;
  data: Data;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const { r, co, data } = p;
  const chips = placeChips(t, r);
  const covered = r.except ? ALL_WILAYAS.filter((w) => !r.wilayas.includes(w)) : r.wilayas.length ? r.wilayas : ALL_WILAYAS;
  const serves = new Set(co?.serves ?? []);
  const miss = covered.filter((w) => !serves.has(w));
  const missing = miss.length;
  return (
    <li className={`pl-rule${r.on ? '' : ' off'}`}>
      <span className="pl-n">{p.n}</span>
      <div className="pl-what">
        {chips.map((c) => (
          <span key={c.key} className={`pl-chip place ${c.tone ?? ''}`}>
            {c.tone === 'but' ? <Icon name="ban" /> : <Icon name="flag" />}
            {c.text}
          </span>
        ))}
        {r.products.map((id) => (
          <span key={id} className="pl-chip prod">
            <Icon name="package" />
            {data.products.find((x) => x.id === id)?.name ?? `#${id}`}
          </span>
        ))}
      </div>
      <Icon name="arrow" className="pl-arrow" />
      <span className={`pl-to${co?.own ? ' own' : ''}`}>
        <Icon name={co?.own ? 'bike' : 'truck'} />
        {co?.own ? t('livraison.pilot.private') : (co?.name ?? '?')}
      </span>
      <span className={`pl-force ${r.strict ? 'strict' : 'soft'}`}>
        {r.strict && <Icon name="lock" />}
        {t(r.strict ? 'livraison.pilot.strict' : 'livraison.pilot.soft')}
      </span>
      {p.canEdit && (
        <div className="pl-acts">
          <label className="pl-sw" title={t(r.on ? 'livraison.pilot.isOn' : 'livraison.pilot.isOff')}>
            <input type="checkbox" checked={r.on} onChange={p.onToggle} aria-label={t('livraison.pilot.onOff', { n: p.n })} />
          </label>
          <button type="button" className="pl-ib" disabled={p.first} aria-label={t('livraison.pilot.up', { n: p.n })} onClick={() => p.onMove(-1)}>
            <Icon name="chevron" className="up" />
          </button>
          <button type="button" className="pl-ib" disabled={p.last} aria-label={t('livraison.pilot.down', { n: p.n })} onClick={() => p.onMove(1)}>
            <Icon name="chevron" />
          </button>
          <button type="button" className="pl-ib" aria-label={t('livraison.pilot.edit', { n: p.n })} onClick={p.onEdit}>
            <Icon name="pencil" />
          </button>
          <button type="button" className="pl-ib bad" aria-label={t('livraison.pilot.del', { n: p.n })} onClick={p.onDelete}>
            <Icon name="trash" />
          </button>
        </div>
      )}
      {co && !co.active && (
        <p className="pl-warn">
          <Icon name="alert" /> {t('livraison.pilot.warnOff', { co: co.name })}
        </p>
      )}
      {co && co.active && missing > 0 && (
        <p className="pl-warn soft">
          <Icon name="info" /> {t('livraison.pilot.warnServeNames', { co: co.name, list: namesOf(miss) })}
        </p>
      )}
    </li>
  );
}

/** « Tamanrasset, Illizi, Djanet +4 » */
const namesOf = (ws: number[], max = 5) => `${ws.slice(0, max).map((w) => wilayaName(w)).join(', ')}${ws.length > max ? ` +${ws.length - max}` : ''}`;

/** In the rule editor: the wilayas its company does not deliver to (no price there), by name, and « send them to another company ». */
function MissingBox({ co, missing, data, onSplit }: { co: Co; missing: number[]; data: Data; onSplit: (alt: number) => void }) {
  const { t } = useTranslation();
  const others = data.companies.filter((c) => c.active && c.id !== co.id && !c.own);
  const full = (c: Co) => missing.every((w) => c.serves.includes(w));
  const [alt, setAlt] = useState<number | ''>(others.find(full)?.id ?? '');
  return (
    <div className="pl-miss" role="note">
      <p>
        <Icon name="alert" /> <b>{t('livraison.pilot.missT', { co: co.own ? t('livraison.pilot.private') : co.name, count: missing.length })}</b>
      </p>
      <p className="pl-miss-list">{namesOf(missing, 12)}</p>
      <p className="pl-miss-why">{t('livraison.pilot.missWhy')}</p>
      <div className="pl-miss-act">
        <label>
          <span>{t('livraison.pilot.missSend')}</span>
          <select value={alt} onChange={(e) => setAlt(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('livraison.pilot.missPick')}</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {full(c) ? t('livraison.pilot.missAll') : t('livraison.pilot.missSome', { count: missing.filter((w) => c.serves.includes(w)).length, all: missing.length })}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn small primary" disabled={!alt} onClick={() => alt && onSplit(alt)}>
          {t('livraison.pilot.missBtn')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the rule editor
function RuleEditor({ initial, index, cfg, data, onClose, onKeep }: { initial: PilotRule; index: number | null; cfg: Cfg; data: Data; onClose: () => void; onKeep: (r: PilotRule, extra?: PilotRule) => void }) {
  const { t } = useTranslation();
  const [r, setR] = useState<PilotRule>(initial);
  const [open, setOpen] = useState<number | null>(null);
  const [cq, setCq] = useState('');
  const co = data.companies.find((c) => c.id === r.to);
  const serves = new Set(co?.serves ?? ALL_WILAYAS);
  const n = index === null ? cfg.rules.length + 1 : index + 1;
  const list = index === null ? [...cfg.rules, r] : cfg.rules.map((x, k) => (k === index ? r : x));
  const mine = useMemo(() => clashesOf({ rules: list, clashes: cfg.clashes }).filter((c) => c.a === r.id || c.b === r.id), [JSON.stringify(list), cfg.clashes]);
  const coName = (id: number) => {
    const c = data.companies.find((x) => x.id === id);
    return c?.own ? t('livraison.pilot.private') : (c?.name ?? '?');
  };
  const addW = (w: number) => setR({ ...r, wilayas: [...new Set([...r.wilayas, w])].sort((a, b) => a - b) });
  const dropW = (w: number) => setR({ ...r, wilayas: r.wilayas.filter((x) => x !== w), communes: r.communes.filter((c) => c.w !== w) });
  const region = (ids: number[]) => setR({ ...r, except: false, wilayas: [...new Set([...(r.except ? [] : r.wilayas), ...ids.filter((w) => serves.has(w))])].sort((a, b) => a - b) });
  const toggleC = (w: number, c: string) => {
    const has = r.communes.some((x) => x.w === w && normCommune(x.c) === normCommune(c));
    setR({ ...r, communes: has ? r.communes.filter((x) => !(x.w === w && normCommune(x.c) === normCommune(c))) : [...r.communes, { w, c }] });
  };
  const missing = (r.except ? ALL_WILAYAS.filter((w) => !r.wilayas.includes(w)) : r.wilayas.length ? r.wilayas : ALL_WILAYAS).filter((w) => !serves.has(w));
  const companies = [...data.companies.filter((c) => c.active && c.own), ...data.companies.filter((c) => c.active && !c.own)];
  const unserved = (w: number) => !serves.has(w);

  return (
    <Modal
      sheet
      wide
      className="pl-ed"
      title={index === null ? t('livraison.pilot.newRule') : t('livraison.pilot.ruleTitle', { n })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('livraison.pilot.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!co || (r.except && !r.wilayas.length)} onClick={() => onKeep(r)}>
            {t('livraison.pilot.keepRule')}
          </button>
        </>
      }
    >
      <div className="pl-edb">
        {/* Où */}
        <section className="pl-sec">
          <div className="pl-sec-h">
            <b>{t('livraison.pilot.where')}</b>
            <small>{t('livraison.pilot.whereHint')}</small>
          </div>
          <div className="pl-quick" role="group" aria-label={t('livraison.pilot.quick')}>
            {REGION_KEYS.map((k) => (
              <button key={k} type="button" className="pl-qb" onClick={() => region(REGIONS[k])}>
                {t(`livraison.pilot.regions.${k}`)}
              </button>
            ))}
            <button type="button" className={`pl-qb${!r.except && !r.wilayas.length ? ' on' : ''}`} onClick={() => setR({ ...r, except: false, wilayas: [], communes: [] })}>
              {t('livraison.pilot.all')}
            </button>
            <button type="button" className={`pl-qb${r.except ? ' on' : ''}`} onClick={() => setR({ ...r, except: true, wilayas: [], communes: [] })}>
              {t('livraison.pilot.allButBtn')}
            </button>
          </div>
          <div className="pl-box">
            {r.except && <span className="pl-lead">{t('livraison.pilot.exceptLead')}</span>}
            {!r.except && !r.wilayas.length && <span className="pl-chip all">{t('livraison.pilot.allW')}</span>}
            {r.wilayas.map((w) => (
              <span key={w} className={`pl-chip rm${r.except ? ' out' : ''}${unserved(w) && !r.except ? ' warn' : ''}`}>
                {wilaya(w)}
                <button type="button" aria-label={t('livraison.pilot.removeW', { w: wilayaName(w) })} onClick={() => dropW(w)}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <label className="pl-addsel">
              <span className="sr-only">{t('livraison.pilot.addW')}</span>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addW(Number(e.target.value));
                }}
              >
                <option value="">{r.except ? t('livraison.pilot.addOut') : t('livraison.pilot.addW')}</option>
                {ALL_WILAYAS.filter((w) => !r.wilayas.includes(w)).map((w) => (
                  <option key={w} value={w} disabled={!r.except && unserved(w)}>
                    {wilaya(w)}
                    {!r.except && unserved(w) ? ` — ${t('livraison.pilot.noPrice')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {missing.length > 0 && co && (
            <MissingBox
              co={co}
              missing={missing}
              data={data}
              onSplit={(alt) => {
                // the rule keeps the wilayas its company delivers to; the others go to « alt » in a rule of their own
                const main: PilotRule = r.except || !r.wilayas.length ? { ...r, except: true, wilayas: [...new Set([...(r.except ? r.wilayas : []), ...missing])].sort((a, b) => a - b), communes: [] } : { ...r, wilayas: r.wilayas.filter((w) => !missing.includes(w)), communes: r.communes.filter((c) => !missing.includes(c.w)) };
                const ids = [...cfg.rules, main];
                const extra: PilotRule = { id: newRuleId(ids), wilayas: missing, except: false, communes: [], products: r.products, to: alt, strict: r.strict, on: true };
                onKeep(main, extra);
              }}
            />
          )}
        </section>

        {/* Communes */}
        {!r.except && r.wilayas.length > 0 && (
          <section className="pl-sec">
            <div className="pl-sec-h">
              <b>{t('livraison.pilot.communes')}</b>
              <small>{t('livraison.pilot.communesHint')}</small>
            </div>
            <ul className="pl-wcs">
              {r.wilayas.slice(0, 12).map((w) => {
                const cs = r.communes.filter((c) => c.w === w);
                const all = communesOf(w);
                const shown = open === w ? all.filter((x) => !cq.trim() || normCommune(`${x[1]} ${x[2]}`).includes(normCommune(cq))) : [];
                return (
                  <li key={w}>
                    <button type="button" className="pl-wc" aria-expanded={open === w} onClick={() => (setOpen(open === w ? null : w), setCq(''))}>
                      <b>{wilaya(w)}</b>
                      <span className={cs.length ? 'some' : ''}>{cs.length ? `${t('livraison.pilot.someC', { count: cs.length })} : ${cs.slice(0, 4).map((c) => communeLabel(w, c.c)).join(', ')}${cs.length > 4 ? '…' : ''}` : t('livraison.pilot.wholeW')}</span>
                      <Icon name="chevron" className={open === w ? 'up' : ''} />
                    </button>
                    {open === w && (
                      <div className="pl-cpick">
                        <input type="search" value={cq} placeholder={t('livraison.pilot.searchC')} aria-label={t('livraison.pilot.searchC')} onChange={(e) => setCq(e.target.value)} />
                        <div className="pl-clist">
                          {shown.map((x) => {
                            const on = cs.some((c) => normCommune(c.c) === normCommune(x[1]));
                            return (
                              <label key={x[1]} className={`pl-cc${on ? ' on' : ''}`}>
                                <input type="checkbox" checked={on} onChange={() => toggleC(w, x[1])} />
                                {i18n.language === 'ar' && x[2] ? x[2] : x[1]}
                              </label>
                            );
                          })}
                          {!shown.length && <span className="muted">{t('livraison.pilot.noC')}</span>}
                        </div>
                        {cs.length > 0 && (
                          <button type="button" className="btn small" onClick={() => setR({ ...r, communes: r.communes.filter((c) => c.w !== w) })}>
                            {t('livraison.pilot.wholeAgain')}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {r.wilayas.length > 12 && <p className="pl-note muted">{t('livraison.pilot.manyW')}</p>}
          </section>
        )}

        {/* Produits */}
        <section className="pl-sec">
          <div className="pl-sec-h">
            <b>{t('livraison.pilot.products')}</b>
            <small>{t('livraison.pilot.productsHint')}</small>
          </div>
          <div className="pl-box">
            {!r.products.length && <span className="pl-chip all">{t('livraison.pilot.allP')}</span>}
            {r.products.map((id) => (
              <span key={id} className="pl-chip rm prod">
                {data.products.find((x) => x.id === id)?.name ?? `#${id}`}
                <button type="button" aria-label={t('livraison.pilot.removeP', { p: data.products.find((x) => x.id === id)?.name ?? '' })} onClick={() => setR({ ...r, products: r.products.filter((x) => x !== id) })}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <label className="pl-addsel">
              <span className="sr-only">{t('livraison.pilot.addP')}</span>
              <select value="" onChange={(e) => e.target.value && setR({ ...r, products: [...new Set([...r.products, Number(e.target.value)])] })}>
                <option value="">{t('livraison.pilot.addP')}</option>
                {data.products
                  .filter((p) => !r.products.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </section>

        {/* Livré par */}
        <section className="pl-sec">
          <div className="pl-sec-h">
            <b>{t('livraison.pilot.to')}</b>
          </div>
          <div className="pl-cos" role="radiogroup" aria-label={t('livraison.pilot.to')}>
            {companies.map((c) => (
              <label key={c.id} className={`pl-co${r.to === c.id ? ' on' : ''}${c.own ? ' own' : ''}`}>
                <input type="radio" name="pl-to" checked={r.to === c.id} onChange={() => setR({ ...r, to: c.id })} />
                <Icon name={c.own ? 'bike' : 'truck'} />
                <span>
                  <b>{c.own ? t('livraison.pilot.private') : c.name}</b>
                  {c.own && <small>{t('livraison.pilot.privateHint')}</small>}
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Force */}
        <section className="pl-sec">
          <div className="pl-sec-h">
            <b>{t('livraison.pilot.force')}</b>
          </div>
          <div className="pl-forces" role="radiogroup" aria-label={t('livraison.pilot.force')}>
            {[false, true].map((s) => (
              <label key={String(s)} className={`pl-fo${r.strict === s ? ' on' : ''}`}>
                <input type="radio" name="pl-force" checked={r.strict === s} onChange={() => setR({ ...r, strict: s })} />
                {s && <Icon name="lock" />}
                <span>
                  <b>{t(s ? 'livraison.pilot.strict' : 'livraison.pilot.soft')}</b>
                  <small>{t(s ? 'livraison.pilot.strictHint' : 'livraison.pilot.softHint')}</small>
                </span>
              </label>
            ))}
          </div>
        </section>

        {mine.length > 0 && (
          <ul className="pl-live" aria-live="polite">
            {mine.map((c) => {
              const other = c.a === r.id ? c.b : c.a;
              const o = list.find((x) => x.id === other)!;
              const no = ruleNumber(list, other);
              return (
                <li key={other} className={c.kind}>
                  <Icon name={c.kind === 'ask' ? 'alert' : 'lock'} />
                  {c.kind === 'ask'
                    ? t('livraison.pilot.liveAsk', { n: no, co: coName(o.to), ex: exampleText(t, c.example, data) })
                    : t('livraison.pilot.liveStrict', { n: no, co: coName(o.to), w: o.strict ? no : n })}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- « Qui gagne ? »
function AskDialog({ clashes, cfg, data, onClose, onDone }: { clashes: Clash[]; cfg: Cfg; data: Data; onClose: () => void; onDone: (answers: Answer[]) => void }) {
  const { t } = useTranslation();
  const [win, setWin] = useState<Record<string, string>>(() => Object.fromEntries(clashes.map((c) => [`${c.a}|${c.b}`, c.win ?? ''])));
  const coName = (id: number) => {
    const c = data.companies.find((x) => x.id === id);
    return c?.own ? t('livraison.pilot.private') : (c?.name ?? '?');
  };
  const done = clashes.every((c) => win[`${c.a}|${c.b}`]);
  return (
    <Modal
      sheet
      title={t('livraison.pilot.askT')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('livraison.pilot.back')}
          </button>
          <button type="button" className="btn primary" disabled={!done} onClick={() => onDone(clashes.map((c) => ({ a: c.a, b: c.b, win: win[`${c.a}|${c.b}`] })))}>
            {t('livraison.pilot.continue')}
          </button>
        </>
      }
    >
      <div className="pl-ask">
        <p>{t('livraison.pilot.askHelp')}</p>
        {clashes.map((c) => {
          const k = `${c.a}|${c.b}`;
          const ra = cfg.rules.find((r) => r.id === c.a)!;
          const rb = cfg.rules.find((r) => r.id === c.b)!;
          const na = ruleNumber(cfg.rules, c.a);
          const nb = ruleNumber(cfg.rules, c.b);
          const opt = (value: string, label: string, sub: string) => (
            <label className={`pl-opt${win[k] === value ? ' on' : ''}`}>
              <input type="radio" name={`ask-${k}`} checked={win[k] === value} onChange={() => setWin({ ...win, [k]: value })} />
              <span>
                <b>{label}</b>
                <small>{sub}</small>
              </span>
            </label>
          );
          return (
            <fieldset key={k} className="pl-q">
              <legend>{t('livraison.pilot.askQ', { a: na, b: nb })}</legend>
              <p className="pl-ex">
                <Icon name="package" /> {exampleText(t, c.example, data)}
              </p>
              {opt(c.a, t('livraison.pilot.winsLabel', { co: coName(ra.to) }), t('livraison.pilot.ruleN', { n: na }))}
              {opt(c.b, t('livraison.pilot.winsLabel', { co: coName(rb.to) }), t('livraison.pilot.ruleN', { n: nb }))}
              {opt(CLASH_ASSIGN, t('livraison.pilot.toAssign'), t('livraison.pilot.toAssignHint'))}
            </fieldset>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- « Tester une commande »
function Tester({ cfg, data }: { cfg: Cfg; data: Data }) {
  const { t } = useTranslation();
  const [w, setW] = useState(16);
  const [c, setC] = useState('');
  const [p, setP] = useState<number | ''>('');
  const [desk, setDesk] = useState(false);
  const q = useRpc('pilot.test', { mode: cfg.mode, rules: cfg.rules, clashes: cfg.clashes, defaultCompanyId: cfg.def, wilayaId: w, commune: desk ? null : c || null, isStopdesk: desk, productIds: p ? [p] : [] }, { staleTime: 5_000 });
  const r = q.data;
  const why = (() => {
    if (!r) return '';
    if (r.by === 'rule' || r.by === 'strict') return t(r.by === 'strict' ? 'livraison.pilot.whyStrict' : 'livraison.pilot.whyRule', { n: r.ruleNo });
    if (r.by === 'default') return t('livraison.pilot.whyDefault');
    if (r.why?.startsWith('conflict:')) {
      const [a, b] = r.why.slice(9).split(',');
      return t('livraison.pilot.whyConflict', { a, b });
    }
    return t(r.why === 'manual' ? 'livraison.pilot.whyManual' : 'livraison.pilot.whyNobody');
  })();
  return (
    <section className="pl-card pl-test" aria-labelledby="pl-test-h">
      <div className="pl-card-h">
        <b id="pl-test-h">
          <Icon name="search" /> {t('livraison.pilot.testT')}
        </b>
        <small>{t('livraison.pilot.testHint')}</small>
      </div>
      <div className="pl-tform">
        <label>
          <span>{t('livraison.pilot.tW')}</span>
          <select value={w} onChange={(e) => (setW(Number(e.target.value)), setC(''))}>
            {ALL_WILAYAS.map((x) => (
              <option key={x} value={x}>
                {wilaya(x)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('livraison.pilot.tC')}</span>
          <select value={c} disabled={desk} onChange={(e) => setC(e.target.value)}>
            <option value="">{t('livraison.pilot.anyC')}</option>
            {communesOf(w).map((x) => (
              <option key={x[1]} value={x[1]}>
                {i18n.language === 'ar' && x[2] ? x[2] : x[1]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('livraison.pilot.tP')}</span>
          <select value={p} onChange={(e) => setP(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('livraison.pilot.anyP')}</option>
            {data.products.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <div className="pl-seg" role="radiogroup" aria-label={t('livraison.pilot.tMode')}>
          {[false, true].map((x) => (
            <button key={String(x)} type="button" role="radio" aria-checked={desk === x} className={desk === x ? 'on' : ''} onClick={() => setDesk(x)}>
              {t(x ? 'livraison.pilot.desk' : 'livraison.pilot.home')}
            </button>
          ))}
        </div>
      </div>
      <div className={`pl-result${r && !r.companyId ? ' none' : ''}`} aria-live="polite">
        {q.error ? (
          <span className="bad">{q.error.message}</span>
        ) : r ? (
          <>
            <Icon name={r.companyId ? 'truck' : 'usercog'} />
            <span className="pl-rt">
              <small>{t('livraison.pilot.result')}</small>
              <b>{r.companyId ? (data.companies.find((x) => x.id === r.companyId)?.own ? t('livraison.pilot.private') : r.companyName) : t('livraison.pilot.toAssign')}</b>
            </span>
            <span className="pl-why">{why}</span>
          </>
        ) : (
          <Loading />
        )}
      </div>
    </section>
  );
}
