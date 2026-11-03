import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n } from '../../lib/format';
import { pageIsOn } from '../../lib/features';
import { useRpc } from '../../lib/query';
import { SellerScope, useSeller } from '../../lib/seller';
import { AgentView } from '../../lib/session';
import { Empty, ErrorBox, Icon, Loading, Pager } from '../../ui/kit';
import { SectionHeader } from '../ai/agent';
import type { PageProps } from '../registry';
import './assigned-catalog.css';
import { GuideButton } from './guide';
import { Guides } from './Guides';

export function AgencyProducts(props: PageProps) {
  const seller = useSeller();
  return <SellerScope seller={seller}><AgentView><AssignedCatalog key={seller} {...props} /></AgentView></SellerScope>;
}

/** Both tabs use the same minimal, server-scoped response. There are no inventory-management calls here. */
export function AssignedCatalog({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const tab = sub === 'produits' || sub === 'guides' ? sub : 'stock';
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { setQ(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useRpc('catalog.assigned', { q, page, pageSize: 50 }, { refetchInterval: 60_000, placeholderData: undefined, enabled: tab !== 'guides' });
  const tabs = (['produits', 'guides', 'stock'] as const).filter((key) => pageIsOn('produits', key)).map((key) => ({ key, label: t(`produits.tabs.${key}`), icon: key === 'stock' ? 'package' : key === 'guides' ? 'book' : 'tag', href: `#/produits/${key}` }));
  // the products' sales guides, read only (Produits & stock › Guide de vente)
  if (tab === 'guides') return <div className="pd assigned-catalog">
    <SectionHeader icon="layers" title={t('produits.title')} about={t('produits.about.guidesAgent')} tabs={tabs} current={tab} />
    <Guides manager={false} initial={rest?.[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined} />
  </div>;
  return <div className="pd assigned-catalog">
    <SectionHeader icon="layers" title={t('produits.title')} about={t('produits.assigned.about')} tabs={tabs} current={tab} />
    <label className="assigned-search"><Icon name="search" /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('produits.assigned.search')} aria-label={t('produits.assigned.search')} /></label>
    {query.error ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : !query.data ? <Loading /> : !query.data.rows.length ? <Empty>{t('produits.assigned.empty')}</Empty> : <>
      <div className="assigned-grid">{query.data.rows.map((p) => <article className="card assigned-product" key={`${p.seller?.id ?? 0}:${p.id}`}>
        <div className="assigned-product-head">
          {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="assigned-product-icon"><Icon name="package" /></span>}
          <div>{p.seller && <span className="chip">{p.seller.name}</span>}<h3>{p.name}</h3><small className="muted ltr">{p.sku}</small></div>
          {!p.active && <span className="badge t-warn">{t('produits.assigned.off')}</span>}
        </div>
        {p.hasGuide && <div className="assigned-guide">{p.seller ? <SellerScope seller={p.seller.id}><GuideButton productId={p.id} label={t('produits.guide.openFull')} /></SellerScope> : <GuideButton productId={p.id} label={t('produits.guide.openFull')} />}</div>}
        {tab === 'produits' && p.description && <p className="assigned-description">{p.description}</p>}
        <div className="assigned-variants">{p.variants.length ? p.variants.map((v) => <div className="assigned-variant" key={v.id}>
          <div className="assigned-variant-name">{v.photo && <img src={v.photo} alt="" loading="lazy" />}<span><b>{v.title || p.name}</b><small className="muted ltr">{v.sku}</small></span></div>
          <b className="ltr">{da(v.price)}</b>
          {v.available !== null && <span className={`badge ${v.available > 0 ? 't-ok' : 't-bad'}`}>{t('produits.assigned.available')}: <b className="ltr">{n(v.available)}</b></span>}
          {!v.active && <small className="muted">{t('produits.assigned.off')}</small>}
        </div>) : <b className="ltr">{da(p.price)}</b>}</div>
      </article>)}</div>
      <Pager page={page} pageSize={50} total={query.data.total} onPage={setPage} />
    </>}
  </div>;
}
