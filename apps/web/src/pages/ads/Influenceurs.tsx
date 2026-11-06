// Marketing › Influenceurs: ads in the shop's name and a creator's (Meta's partnership ads). On top, what their ads
// brought (spend, orders, delivered, ad money per delivered order); then the creators, each with where their « yes »
// is, their numbers and « Lancer une pub avec lui » (Publicité › Lancer, the creator as second name); beside them,
// their posts that tag the shop, each boosted in one click (« Booster »: Publicité › Lancer with the post). « Ajouter un
// influenceur » sends the request to their Instagram (they say yes once in the Instagram app), adds their Facebook
// Page, or finds one post by the creator's ad code. Everything is counted and decided in core (partners.*).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n, since } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import './formulaires.css';
import './influenceurs.css';

type Board = Out<'partners.board'>;
type Partner = Board['partners'][number];
type Post = Board['content'][number];
type Days = 0 | 7 | 30 | 90;
type How = 'ig' | 'page' | 'code';

const LAUNCH = '#/marketing/publicite/lancer';
const usd = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : `${v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);
const kn = (v: number) => (v >= 10_000 ? `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k` : n(v));
const TONE: Record<string, string> = { approved: 'ok', pending: 'warn', page: 'info', code: 'info', refused: 'bad', revoked: 'mute' };
const ELIG_TONE: Record<string, string> = { AD_READY: 'ok', NEEDS_ATTENTION: 'warn', INELIGIBLE: 'bad', EXCLUDED: 'mute' };

export function Influenceurs() {
  const { t } = useTranslation();
  const [days, setDays] = useState<Days>(30);
  const [add, setAdd] = useState<{ how: How; ig?: string; page?: string } | null>(null);
  const q = useRpc('partners.board', { days }, { refetchInterval: 120_000 });
  const refresh = useAction('partners.refresh', { success: (r) => (r.error ? t('partners.syncError', { msg: r.error }) : t('partners.refreshed')) });
  const b = q.data;
  if (q.error && !b) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!b) return <Loading />;
  const tt = b.totals;
  return (
    <div className="lf if">
      <div className="if-main">
        <div className="lf-head if-head">
          <div className="if-title">
            <h2>{t('partners.title')}</h2>
            <p className="lf-muted">{t('partners.sub')}</p>
          </div>
          <div className="if-head-acts">
            <span className="lf-muted if-checked">{b.checkedAt ? t('partners.checked', { d: t('pilotads.ago', { d: since(b.checkedAt) }) }) : t('partners.never')}</span>
            <button type="button" className="lf-btn" disabled={refresh.isPending} onClick={() => refresh.mutate({})}>
              <Icon name="refresh" /> {t('partners.refresh')}
            </button>
            {b.manage && (
              <button type="button" className="lf-btn primary" onClick={() => setAdd({ how: 'ig' })}>
                <Icon name="userplus" /> {t('partners.add')}
              </button>
            )}
          </div>
        </div>
        {b.demo && <p className="lf-note if-demo">{t('partners.demo')}</p>}
        {!b.brand && (
          <div className="if-warn" role="status">
            <Icon name="alert" /> <span>{t('partners.noBrand')}</span>
          </div>
        )}
        {b.syncError && (
          <div className="if-warn" role="status">
            <Icon name="alert" /> <span>{t('partners.syncError', { msg: b.syncError })}</span>
          </div>
        )}

        <div className="if-period" role="radiogroup" aria-label={t('partners.period.label')}>
          {([7, 30, 90, 0] as Days[]).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d ? t(`partners.period.d${d}`) : t('partners.period.all')}
            </button>
          ))}
        </div>
        <div className="if-tiles">
          <Tile icon="handshake" label={t('partners.tile.partners')} value={n(b.partners.length)} sub={t('partners.tile.partnersSub', { ok: tt.approved, wait: tt.waiting })} />
          <Tile icon="coins" label={t('partners.tile.spend')} value={usd(tt.spendUsd)} sub={t('partners.tile.spendSub', { count: tt.launches })} />
          <Tile icon="cart" label={t('partners.tile.orders')} value={n(tt.orders)} sub={t('partners.tile.ordersSub')} />
          <Tile
            icon="truck"
            label={t('partners.tile.delivered')}
            value={n(tt.delivered)}
            sub={tt.perDeliveredUsd === null ? t('partners.tile.deliveredNone') : t('partners.tile.deliveredSub', { cost: usd(tt.perDeliveredUsd) })}
            ok={tt.delivered > 0}
          />
        </div>

        <section className="if-card" aria-labelledby="if-list-title">
          <div className="if-card-head">
            <h3 id="if-list-title">{t('partners.list.title')}</h3>
            <span className="if-count ltr">{b.partners.length}</span>
          </div>
          {!b.partners.length ? (
            <div className="if-empty">
              <Icon name="handshake" />
              <b>{t('partners.list.empty')}</b>
              <p className="lf-muted">{t('partners.list.emptySub')}</p>
              {b.manage && (
                <button type="button" className="lf-btn primary" onClick={() => setAdd({ how: 'ig' })}>
                  <Icon name="userplus" /> {t('partners.add')}
                </button>
              )}
            </div>
          ) : (
            <ul className="if-list">
              {b.partners.map((p) => (
                <PartnerRow key={p.id} p={p} manage={b.manage} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="if-side">
        <Posts b={b} onAdd={(how, ig, page) => setAdd({ how, ig, page })} />
        <Steps />
      </aside>
      {add && <AddModal start={add} onClose={() => setAdd(null)} />}
    </div>
  );
}

function Tile({ icon, label, value, sub, ok }: { icon: string; label: string; value: string; sub: string; ok?: boolean }) {
  return (
    <div className="if-tile">
      <span className="if-tile-l">
        <Icon name={icon} /> {label}
      </span>
      <b className={`if-tile-v ltr ${ok ? 'ok' : ''}`}>{value}</b>
      <span className="if-tile-s">{sub}</span>
    </div>
  );
}

/** a creator's round picture, or the first letter of their name on a soft colour */
function Avatar({ name, picture, size = 44 }: { name: string; picture: string | null; size?: number }) {
  const letter = name.replace(/^@/, '').slice(0, 1).toUpperCase() || '?';
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
  return picture ? (
    <img className="if-av" src={picture} alt="" width={size} height={size} loading="lazy" />
  ) : (
    <span className="if-av" aria-hidden="true" style={{ width: size, height: size, background: `hsl(${hue} 70% 90%)`, color: `hsl(${hue} 45% 32%)` }}>
      {letter}
    </span>
  );
}

function Platforms({ ig, page }: { ig: boolean; page: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="if-plats">
      {ig && (
        <span className="if-plat ig" title="Instagram">
          <Icon name="camera" />
          <span className="sr-only">Instagram</span>
        </span>
      )}
      {page && (
        <span className="if-plat fb" title={t('partners.st.page')}>
          <b aria-hidden="true">f</b>
          <span className="sr-only">Facebook</span>
        </span>
      )}
    </span>
  );
}

function PartnerRow({ p, manage }: { p: Partner; manage: boolean }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const ask = useAction('partners.ask', { success: t('partners.asked', { name: p.igUsername ?? p.name }) });
  const saveNote = useAction('partners.note', { success: t('partners.noteSaved'), onDone: () => setNote(null) });
  const revoke = useAction('partners.revoke', { success: t('partners.removed', { name: p.name }), onDone: () => setDrop(false) });
  const handle = p.igUsername ? `@${p.igUsername}` : '';
  return (
    <li className={`if-row ${p.usable ? '' : 'off'}`}>
      <div className="if-who">
        <Avatar name={p.name} picture={p.picture} />
        <div className="if-who-txt">
          <b>{p.name}</b>
          <span className="lf-muted">
            {handle && handle !== p.name && <span className="ltr">{handle}</span>}
            <Platforms ig={!!p.igUsername} page={!!p.pageId} />
          </span>
        </div>
        <span className={`lf-tag ${TONE[p.status] ?? 'mute'}`} title={t(`partners.stHelp.${p.status}`)}>
          {t(`partners.st.${p.status}`)}
        </span>
      </div>
      <p className="if-help">{t(`partners.stHelp.${p.status}`)}</p>
      {p.note && (
        <p className="if-note">
          <Icon name="pencil" /> <span dir="auto">{p.note}</span>
        </p>
      )}
      <dl className="if-nums">
        <div>
          <dt>{t('partners.num.ads')}</dt>
          <dd className="ltr">{n(p.launches)}</dd>
        </div>
        <div>
          <dt>{t('partners.num.spend')}</dt>
          <dd className="ltr">{usd(p.spendUsd)}</dd>
        </div>
        <div>
          <dt>{t('partners.num.orders')}</dt>
          <dd className="ltr">{n(p.orders)}</dd>
        </div>
        <div>
          <dt>{t('partners.num.delivered')}</dt>
          <dd className="ltr ok">{n(p.delivered)}</dd>
        </div>
        <div>
          <dt>{t('partners.num.perDelivered')}</dt>
          <dd className="ltr">{usd(p.perDeliveredUsd)}</dd>
        </div>
        <div>
          <dt>{t('partners.num.cash')}</dt>
          <dd className="ltr">{p.cash ? da(p.cash) : '—'}</dd>
        </div>
      </dl>
      <div className="if-acts">
        {p.usable ? (
          <a className="lf-btn primary" href={`${LAUNCH}/avec/${p.id}`}>
            <Icon name="megaphone" /> {t('partners.launch')}
          </a>
        ) : (
          manage &&
          p.igUsername && (
            <button type="button" className="lf-btn" disabled={ask.isPending} onClick={() => ask.mutate({ id: p.id })}>
              <Icon name="send" /> {t('partners.askAgain')}
            </button>
          )
        )}
        {manage && (
          <div className="if-more">
            <button type="button" className="lf-btn if-more-btn" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((v) => !v)}>
              <Icon name="more" /> <span className="sr-only">{t('partners.more')}</span>
            </button>
            {menu && (
              <div className="if-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" role="menuitem" onClick={() => (setNote(p.note), setMenu(false))}>
                  <Icon name="pencil" /> {t('partners.note')}
                </button>
                {p.igUsername && p.status !== 'approved' && (
                  <button type="button" role="menuitem" disabled={ask.isPending} onClick={() => (ask.mutate({ id: p.id }), setMenu(false))}>
                    <Icon name="send" /> {t('partners.askAgain')}
                  </button>
                )}
                {p.status !== 'revoked' && (
                  <button type="button" role="menuitem" className="bad" onClick={() => (setDrop(true), setMenu(false))}>
                    <Icon name="userminus" /> {t('partners.remove')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {note !== null && (
        <Modal
          title={t('partners.note')}
          onClose={() => setNote(null)}
          sheet
          footer={
            <button type="button" className="lf-btn primary" disabled={saveNote.isPending} onClick={() => saveNote.mutate({ id: p.id, note })}>
              {t('partners.noteSave')}
            </button>
          }
        >
          <label className="if-field">
            <span>{p.name}</span>
            <textarea rows={3} maxLength={300} value={note} placeholder={t('partners.notePh')} onChange={(e) => setNote(e.target.value)} />
          </label>
        </Modal>
      )}
      {drop && (
        <Modal
          title={t('partners.removeQ', { name: p.name })}
          onClose={() => setDrop(false)}
          sheet
          footer={
            <>
              <button type="button" className="lf-btn" onClick={() => setDrop(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="lf-btn warn" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: p.id, remove: true })}>
                <Icon name="userminus" /> {t('partners.remove')}
              </button>
            </>
          }
        >
          <p className="if-modal-p">{t('partners.removeSub')}</p>
        </Modal>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- their posts that tag the shop
type Filter = 'all' | 'ready' | 'INSTAGRAM' | 'FACEBOOK';
function Posts({ b, onAdd }: { b: Board; onAdd: (how: How, ig?: string, page?: string) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<Filter>('all');
  const known = useMemo(() => new Map(b.partners.map((p) => [p.id, p])), [b.partners]);
  const mine = b.content.filter((c) => c.partnerId !== null);
  const others = b.content.filter((c) => c.partnerId === null);
  const shown = mine.filter((c) => (f === 'all' ? true : f === 'ready' ? c.boostable && c.eligibility === 'AD_READY' : c.platform === f));
  return (
    <section className="if-card if-posts" aria-labelledby="if-posts-title">
      <div className="if-card-head">
        <h3 id="if-posts-title">{t('partners.posts.title')}</h3>
      </div>
      <p className="lf-muted if-small">{t('partners.posts.sub')}</p>
      <div className="lf-chips if-chips">
        {(['all', 'ready', 'INSTAGRAM', 'FACEBOOK'] as Filter[]).map((k) => (
          <button key={k} type="button" className="lf-chip" aria-pressed={f === k} onClick={() => setF(k)}>
            {t(`partners.posts.f.${k}`)}
          </button>
        ))}
      </div>
      {!shown.length ? (
        <p className="lf-muted if-small">{t('partners.posts.empty')}</p>
      ) : (
        <ul className="if-grid">
          {shown.slice(0, 12).map((c) => (
            <PostCard key={c.id} c={c} partner={c.partnerId ? (known.get(c.partnerId) ?? null) : null} />
          ))}
        </ul>
      )}
      {!!others.length && b.manage && (
        <div className="if-others">
          <h4>{t('partners.posts.others')}</h4>
          <ul>
            {others.slice(0, 5).map((c) => (
              <li key={c.id}>
                <Avatar name={c.author.name || '?'} picture={c.author.picture} size={32} />
                <span className="if-others-txt">
                  <b className="ltr">{c.platform === 'INSTAGRAM' ? `@${c.author.name}` : c.author.name}</b>
                  <small className="lf-muted">{c.caption.slice(0, 70)}</small>
                </span>
                <button type="button" className="lf-btn" onClick={() => (c.platform === 'INSTAGRAM' ? onAdd('ig', c.author.name) : onAdd('page', undefined, c.author.pageId ?? undefined))}>
                  <Icon name="userplus" /> {t('partners.posts.addHim')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PostCard({ c, partner }: { c: Post; partner: Partner | null }) {
  const { t } = useTranslation();
  const name = partner?.name ?? c.author.name;
  const ok = c.boostable && partner?.usable !== false;
  const seen = c.insights.views ?? c.insights.reach;
  return (
    <li className="if-post">
      <div className="if-post-pic">
        {c.thumb ? (
          <img src={c.thumb} alt="" loading="lazy" />
        ) : (
          <span className="if-post-none">
            <Avatar name={name} picture={c.author.picture} size={40} />
          </span>
        )}
        <span className={`if-post-net ${c.platform === 'INSTAGRAM' ? 'ig' : 'fb'}`}>{c.platform === 'INSTAGRAM' ? <Icon name="camera" /> : <b>f</b>}</span>
        {c.mediaType === 'VIDEO' && (
          <span className="if-post-play">
            <Icon name="play" />
          </span>
        )}
      </div>
      <div className="if-post-body">
        <b className="if-post-who">{name}</b>
        <p className="if-post-cap" dir="auto">
          {c.caption || '—'}
        </p>
        <span className="if-post-facts lf-muted">
          {seen !== null && <span className="ltr">{t('partners.posts.views', { n: kn(seen) })}</span>}
          {c.insights.likes !== null && (
            <span className="ltr">
              <Icon name="heart" /> {kn(c.insights.likes)}
            </span>
          )}
        </span>
        <span className="if-post-tags">
          {c.eligibility && <span className={`lf-tag ${ELIG_TONE[c.eligibility] ?? 'mute'}`}>{t(`partners.posts.elig.${c.eligibility}`)}</span>}
          {c.usage === 'ACTIVE' && <span className="lf-tag mute">{t('partners.posts.used')}</span>}
        </span>
        {!!c.errors.length && <small className={`if-post-err ${c.errors[0].severity === 'error' ? 'bad' : 'warn'}`}>{c.errors[0].message}</small>}
        <span className="if-post-acts">
          {ok && (
            <a className="lf-btn primary" href={`${LAUNCH}/booster/${encodeURIComponent(c.id)}`}>
              <Icon name="zap" /> {t('partners.posts.boost')}
            </a>
          )}
          {c.permalink && (
            <a className="lf-link" href={c.permalink} target="_blank" rel="noreferrer noopener">
              <Icon name="external" /> {t('partners.posts.open')}
            </a>
          )}
        </span>
      </div>
    </li>
  );
}

function Steps() {
  const { t } = useTranslation();
  return (
    <section className="if-card if-steps" aria-labelledby="if-steps-title">
      <h3 id="if-steps-title">{t('partners.steps.title')}</h3>
      <ol>
        {(['s1', 's2', 's3', 's4'] as const).map((k, i) => (
          <li key={k}>
            <b className="ltr">{i + 1}</b>
            <span>{t(`partners.steps.${k}`)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- « Ajouter un influenceur »
function AddModal({ start, onClose }: { start: { how: How; ig?: string; page?: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const [how, setHow] = useState<How>(start.how);
  const [ig, setIg] = useState(start.ig ? `@${start.ig}` : '');
  const [page, setPage] = useState(start.page ?? '');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const add = useAction('partners.add', { success: (r) => (r.status === 'pending' ? t('partners.sent') : t('partners.added')), onDone: onClose });
  const find = useAction('partners.lookup', { success: t('partners.found'), onDone: onClose });
  const busy = add.isPending || find.isPending;
  const go = () => {
    if (how === 'code') {
      const v = code.trim();
      find.mutate(/^https:\/\//i.test(v) ? { link: v, code: null } : { code: v, link: null });
    } else add.mutate({ ig: how === 'ig' ? ig : null, page: how === 'page' ? page : null, name: name.trim(), note: note.trim() });
  };
  const ready = how === 'ig' ? ig.replace(/[@\s]/g, '').length > 0 : how === 'page' ? page.trim().length > 4 : code.trim().length >= 6;
  return (
    <Modal
      title={t('partners.addTitle')}
      onClose={onClose}
      sheet
      footer={
        <>
          <button type="button" className="lf-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="lf-btn primary" disabled={!ready || busy} onClick={go}>
            <Icon name={how === 'code' ? 'search' : how === 'ig' ? 'send' : 'userplus'} /> {t(how === 'ig' ? 'partners.send' : how === 'page' ? 'partners.addPage' : 'partners.find')}
          </button>
        </>
      }
    >
      <div className="if-add">
        <div className="if-how" role="radiogroup" aria-label={t('partners.addTitle')}>
          {(['ig', 'page', 'code'] as How[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={how === k} className={how === k ? 'on' : ''} onClick={() => setHow(k)}>
              {k === 'ig' ? <Icon name="camera" /> : k === 'page' ? <b className="if-f">f</b> : <Icon name="key" />}
              {t(`partners.how.${k}`)}
            </button>
          ))}
        </div>
        {how === 'ig' && (
          <label className="if-field">
            <span>{t('partners.igLabel')}</span>
            <input
              className="ltr"
              value={ig}
              placeholder={t('partners.igPh')}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setIg(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ready && go()}
            />
            <small className="lf-muted">{t('partners.igHelp')}</small>
          </label>
        )}
        {how === 'page' && (
          <label className="if-field">
            <span>{t('partners.pageLabel')}</span>
            <input className="ltr" inputMode="numeric" value={page} placeholder={t('partners.pagePh')} autoComplete="off" onChange={(e) => setPage(e.target.value)} />
            <small className="lf-muted">{t('partners.pageHelp')}</small>
          </label>
        )}
        {how === 'code' && (
          <label className="if-field">
            <span>{t('partners.codeLabel')}</span>
            <input className="ltr" value={code} placeholder={t('partners.codePh')} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
            <small className="lf-muted">{t('partners.codeHelp')}</small>
          </label>
        )}
        {how !== 'code' && (
          <div className="if-two">
            <label className="if-field">
              <span>{t('partners.nameLabel')}</span>
              <input value={name} maxLength={120} placeholder={how === 'ig' ? 'Amina Style' : 'Lina Maman DZ'} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="if-field">
              <span>{t('partners.noteLabel')}</span>
              <input value={note} maxLength={300} placeholder={t('partners.notePh')} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
