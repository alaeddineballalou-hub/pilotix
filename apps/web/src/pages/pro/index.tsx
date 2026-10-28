// Pro marketers in the app:
// - « Trouver un marketer Pro » (a store's administrator, #/marketers/pro): the cards, a word / niche / platform to
//   filter, « Inviter dans mon équipe » (its prices, the products given: the usual request, the marketer accepts);
// - « Compte Pro » (a marketer's chief, #/pro in its space): where its Pro stands, « Passer Pro » and how to pay
//   Pilotix, its profile (niches, platforms, city, a few lines), its card as the stores see it (#/comptepro);
// - the public page (#/pro, #/pro/MK-7K2Q): the same cards, open to everyone, no invite (sign in first);
// - in a store, its own marketer: « Passer Pro » opens a marketer space of their own (banner.tsx).
import { NO_PRO_PROFILE, PRO_NICHES, PRO_PLATFORMS, ProCard, ProNiche, ProPlatform, ProProfile } from '@pilotix/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandBig } from '../../layout/PxWordmark';
import { Out, publicPro, publicPros } from '../../lib/backend';
import { da, dateOnly } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Card, Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { ProductPicker, takenBy } from '../agences';
import { Lead, PriceList } from '../agency/parts';
import type { PageProps } from '../registry';
import { ProBizCard, useProWords } from './card';
import '../agency/agency.css';
import './pro.css';

type Found = Out<'partners.pro.search'>['pros'][number];

/** The filters over the cards: a word, a niche, a platform. */
function Filters({ q, setQ, niche, setNiche, platform, setPlatform }: { q: string; setQ: (v: string) => void; niche: ProNiche | ''; setNiche: (v: ProNiche | '') => void; platform: ProPlatform | ''; setPlatform: (v: ProPlatform | '') => void }) {
  const { t } = useTranslation();
  const w = useProWords();
  return (
    <div className="prx-tools">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pro.search.ph')} aria-label={t('pro.search.ph')} />
      <div className="prx-chips" role="group" aria-label={t('pro.card.platforms')}>
        <button type="button" className={!platform ? 'on' : ''} aria-pressed={!platform} onClick={() => setPlatform('')}>
          {t('pro.search.allPlatforms')}
        </button>
        {PRO_PLATFORMS.map((k) => (
          <button key={k} type="button" className={platform === k ? 'on' : ''} aria-pressed={platform === k} onClick={() => setPlatform(platform === k ? '' : k)}>
            {w.platform(k)}
          </button>
        ))}
      </div>
      <div className="prx-chips" role="group" aria-label={t('pro.card.niche')}>
        <button type="button" className={!niche ? 'on' : ''} aria-pressed={!niche} onClick={() => setNiche('')}>
          {t('pro.search.allNiches')}
        </button>
        {PRO_NICHES.map((k) => (
          <button key={k} type="button" className={niche === k ? 'on' : ''} aria-pressed={niche === k} onClick={() => setNiche(niche === k ? '' : k)}>
            {w.niche(k)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Typed words wait a moment before the server is asked. */
function useSlow(v: string, ms = 300) {
  const [x, setX] = useState(v);
  useEffect(() => {
    const id = window.setTimeout(() => setX(v), ms);
    return () => window.clearTimeout(id);
  }, [v, ms]);
  return x;
}

/** On the store's Marketers page: the way to the search. */
export function ProFindCard() {
  const { t } = useTranslation();
  return (
    <section className="prx-banner">
      <span className="prx-medal">
        <Icon name="search" />
      </span>
      <div className="grow">
        <b>{t('pro.find.title')}</b>
        <p>{t('pro.find.text')}</p>
      </div>
      <a className="btn primary" href="#/marketers/pro">
        <Icon name="medal" /> {t('pro.find.open')}
      </a>
    </section>
  );
}

// ---------------------------------------------------------------- the store: « Trouver un marketer Pro »
export function ProSearch() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [niche, setNiche] = useState<ProNiche | ''>('');
  const [platform, setPlatform] = useState<ProPlatform | ''>('');
  const word = useSlow(q);
  const input = { ...(word.trim() ? { q: word.trim() } : {}), ...(niche ? { niche } : {}), ...(platform ? { platform } : {}) };
  const s = useRpc('partners.pro.search', input, { refetchInterval: 120_000 });
  const home = useRpc('partners.home', {});
  const [invite, setInvite] = useState<Found | null>(null);
  return (
    <div className="agx-page prx-page">
      <div className="prx-head">
        <div>
          <a className="small" href="#/marketers">
            ← {t('pro.search.back')}
          </a>
          <h1>{t('pro.search.title')}</h1>
          <p>{t('pro.search.sub')}</p>
        </div>
      </div>
      <Filters q={q} setQ={setQ} niche={niche} setNiche={setNiche} platform={platform} setPlatform={setPlatform} />
      {s.isLoading ? (
        <Loading />
      ) : s.error ? (
        <ErrorBox error={s.error} onRetry={() => s.refetch()} />
      ) : !s.data!.pros.length ? (
        <Empty>{q || niche || platform ? t('pro.search.noneFound') : t('pro.search.none')}</Empty>
      ) : (
        <div className="prx-grid">
          {s.data!.pros.map((c, i) => (
            <ProBizCard
              key={c.id}
              c={c}
              i={i}
              action={
                c.link?.status === 'active' ? (
                  <a className="prx-state" href={`#/marketers/${c.link.id}`}>
                    <Icon name="check" /> {t('pro.search.works')}
                  </a>
                ) : c.link ? (
                  <span className="prx-state wait">
                    <Icon name="hourglass" /> {t('pro.search.waiting')}
                  </span>
                ) : (
                  <button type="button" className="btn primary" onClick={() => setInvite(c)}>
                    <Icon name="userplus" /> {t('pro.invite.button')}
                  </button>
                )
              }
            />
          ))}
        </div>
      )}
      <p className="prx-note">{t('pro.search.rule')}</p>
      {invite && home.data && <InviteModal c={invite} home={home.data} onClose={() => setInvite(null)} />}
    </div>
  );
}

/** « Inviter dans mon équipe »: its prices (its own), the products the store gives; the marketer then accepts. */
function InviteModal({ c, home, onClose }: { c: Found; home: Out<'partners.home'>; onClose: () => void }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<number[] | null>(null);
  const ask = useAction('partners.request', { success: t('pro.invite.sent', { name: c.name }), onDone: onClose });
  return (
    <Modal
      sheet
      wide
      className="prx-invite"
      title={t('pro.invite.title', { name: c.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={(chosen !== null && !chosen.length) || ask.isPending} onClick={() => ask.mutate({ agencyId: c.id, tasks: ['marketing'], products: chosen })}>
            <Icon name="send" /> {t('pro.invite.send')}
          </button>
        </>
      }
    >
      <div className="agx-sub">
        <b>{t('agency.store.theirPrices')}</b>
        <Lead>{t('agency.mk.store.theirPricesText')}</Lead>
        <PriceList p={c.prices} kind="marketer" />
      </div>
      <Field label={t('agency.store.productsGiven')}>
        <ProductPicker products={home.products} value={chosen} onChange={setChosen} taken={takenBy(home.links, null, ['marketing'], 'marketer')} kind="marketer" />
      </Field>
      <p className="small muted">{t('pro.invite.rule')}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- the marketer: « Compte Pro »
export function MarketerPro(_: PageProps) {
  const me = useRpc('agency.pro.me', {}, { refetchInterval: 120_000 });
  if (me.isLoading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} onRetry={() => me.refetch()} />;
  return <ProMe key={me.data!.card.id} d={me.data!} />;
}

function ProMe({ d }: { d: Out<'agency.pro.me'> }) {
  const { t } = useTranslation();
  const w = useProWords();
  const [f, setF] = useState<ProProfile>({ ...NO_PRO_PROFILE, ...d.card.profile });
  const save = useAction('agency.pro.save', { success: t('pro.me.saved') });
  const ask = useAction('agency.pro.ask', { success: t('pro.me.askedOk') });
  const cancel = useAction('agency.pro.ask', { success: t('pro.me.cancelled') });
  const dirty = JSON.stringify(f) !== JSON.stringify(d.card.profile);
  const preview: ProCard = useMemo(() => ({ ...d.card, profile: f }), [d.card, f]);
  const toggle = <T extends string>(list: T[], k: T, max: number) => (list.includes(k) ? list.filter((x) => x !== k) : list.length >= max ? list : [...list, k]);
  const state0 = d.active ? t('pro.me.activeUntil', { d: dateOnly(d.until) }) : d.askedAt ? t('pro.me.asked', { d: dateOnly(d.askedAt) }) : d.until ? t('pro.me.ended', { d: dateOnly(d.until) }) : t('pro.me.notYet');
  return (
    <div className="agx-page prx-page">
      <section className="prx-hero">
        <span className="prx-medal">
          <Icon name="medal" />
        </span>
        <div className="grow">
          <h2>{d.active ? t('pro.me.titleOn') : t('pro.me.title')}</h2>
          <p>{state0}</p>
          {d.on && <p>{t('pro.me.price', { price: da(d.price) })}</p>}
        </div>
        {d.on &&
          (d.askedAt ? (
            <button type="button" className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate({ cancel: true })}>
              {t('pro.me.cancel')}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={ask.isPending || dirty} title={dirty ? t('pro.me.saveFirst') : undefined} onClick={() => ask.mutate({ cancel: false })}>
              <Icon name="medal" /> {d.active ? t('pro.me.prolong') : t('pro.me.ask')}
            </button>
          ))}
      </section>
      {!d.on && <p className="agx-note warn">{t('pro.me.off')}</p>}
      {!d.verified && <p className="agx-note warn">{t('pro.me.notVerified')}</p>}
      {d.active && !d.listed && d.verified && <p className="agx-note warn">{t('pro.me.hidden')}</p>}
      {d.askedAt && (
        <Card title={t('pro.me.howPay')}>
          <Lead>{t('pro.me.howPayText', { price: da(d.price) })}</Lead>
          {d.payment.text && <div className="prx-pay">{d.payment.text}</div>}
          {(d.payment.phone || d.payment.whatsapp) && (
            <p className="small">
              {d.payment.phone && (
                <>
                  <Icon name="phone" /> <span className="ltr">{d.payment.phone}</span>{' '}
                </>
              )}
              {d.payment.whatsapp && (
                <a href={`https://wa.me/${d.payment.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
                  <Icon name="whatsapp" /> WhatsApp
                </a>
              )}
            </p>
          )}
        </Card>
      )}
      <div className="prx-me">
        <Card title={t('pro.me.profile')} help={t('pro.me.profileHelp')}>
          <Field label={t('pro.me.niches')} hint={t('pro.me.nichesHint')}>
            <span className="prx-pick">
              {PRO_NICHES.map((k) => (
                <button key={k} type="button" className={f.niches.includes(k) ? 'on' : ''} aria-pressed={f.niches.includes(k)} onClick={() => setF({ ...f, niches: toggle(f.niches, k, 4) })}>
                  {w.niche(k)}
                </button>
              ))}
            </span>
          </Field>
          <Field label={t('pro.card.platforms')}>
            <span className="prx-pick">
              {PRO_PLATFORMS.map((k) => (
                <button key={k} type="button" className={f.platforms.includes(k) ? 'on' : ''} aria-pressed={f.platforms.includes(k)} onClick={() => setF({ ...f, platforms: toggle(f.platforms, k, 5) })}>
                  {w.platform(k)}
                </button>
              ))}
            </span>
          </Field>
          <Field label={t('pro.card.city')}>
            <input value={f.city} maxLength={60} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder={t('pro.me.cityPh')} />
          </Field>
          <Field label={t('pro.me.bio')} hint={t('pro.me.bioHint', { n: 300 - f.bio.length })}>
            <textarea rows={3} maxLength={300} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} placeholder={t('pro.me.bioPh')} />
          </Field>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={f.visible} onChange={(e) => setF({ ...f, visible: e.target.checked })} /> {t('pro.me.visible')}
          </label>
          <div className="row agx-actions">
            <button type="button" className="btn primary" disabled={!dirty || !f.platforms.length || save.isPending} onClick={() => save.mutate(f)}>
              {t('common.save')}
            </button>
            {!f.platforms.length && <small className="muted">{t('pro.me.needPlatform')}</small>}
          </div>
        </Card>
        <div className="prx-sticky">
          <ProBizCard c={preview} action={<span className="prx-state">{t('pro.me.previewAction')}</span>} />
          <small>{t('pro.me.preview')}</small>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the public page
export function PublicPros({ code }: { code?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [niche, setNiche] = useState<ProNiche | ''>('');
  const [platform, setPlatform] = useState<ProPlatform | ''>('');
  const [list, setList] = useState<ProCard[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setList(null);
    setErr('');
    (code ? publicPro(code).then((c) => [c]) : publicPros().then((r) => r.pros)).then(setList, (e) => setErr(e?.message ?? t('common.error')));
  }, [code, t]);
  const shown = (list ?? []).filter(
    (c) =>
      (!q.trim() || [c.name, c.code, c.profile.city, c.profile.bio].some((v) => v.toLowerCase().includes(q.trim().toLowerCase()))) &&
      (!niche || c.profile.niches.includes(niche)) &&
      (!platform || c.profile.platforms.includes(platform)),
  );
  const invite = <a className="btn primary" href="#/accueil">{t('pro.public.invite')}</a>;
  return (
    <div className="prx-public">
      <header className="prx-pub-top">
        <div>
          <div>
            <BrandBig />
            <h1>{t('pro.public.title')}</h1>
            <p>{t('pro.public.sub')}</p>
          </div>
          <a className="btn" href="#/inscription-marketer">
            <Icon name="medal" /> {t('pro.public.join')}
          </a>
        </div>
      </header>
      <main className="prx-pub-body">
        {err ? (
          <Empty>{err}</Empty>
        ) : !list ? (
          <Loading />
        ) : code ? (
          <div className="prx-pub-one">
            <ProBizCard c={list[0]!} action={invite} />
            <p className="prx-note">
              <a href="#/pro">← {t('pro.public.all')}</a>
            </p>
          </div>
        ) : (
          <>
            <Filters q={q} setQ={setQ} niche={niche} setNiche={setNiche} platform={platform} setPlatform={setPlatform} />
            {shown.length ? (
              <div className="prx-grid">
                {shown.map((c, i) => (
                  <ProBizCard key={c.id} c={c} i={i} action={invite} />
                ))}
              </div>
            ) : (
              <Empty>{list.length ? t('pro.search.noneFound') : t('pro.search.none')}</Empty>
            )}
          </>
        )}
        <p className="prx-note">{t('pro.search.rule')}</p>
      </main>
    </div>
  );
}
