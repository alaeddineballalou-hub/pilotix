// Point de vente › Réglages (the owner): the dépôt the counter sells from, the caisse each payment's money goes into,
// and the ticket (its title, phone, address, last line, printed after each sale or not), with its preview on 80 mm.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { TICKET_CSS, ticketHtml } from './ticket';
import { caisseName, POS_METHODS, PosMethod, PosSale, PosState, priced, variantsOf } from './shared';

export function PosSettingsPage() {
  const q = useRpc('pos.state', {});
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  return <SettingsForm st={q.data} />;
}

type Form = { warehouseId: number; into: Record<PosMethod, string>; title: string; phone: string; address: string; footer: string; autoPrint: boolean };

function SettingsForm({ st }: { st: PosState }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const own = st.caisse.key;
  const [f, setF] = useState<Form>(() => ({
    warehouseId: st.depot.id,
    into: Object.fromEntries(POS_METHODS.map((m) => [m, st.into[m].key && st.into[m].key !== own ? st.into[m].key! : ''])) as Record<PosMethod, string>,
    title: st.ticket.title,
    phone: st.ticket.phone,
    address: st.ticket.address,
    footer: st.ticket.footer,
    autoPrint: st.ticket.autoPrint,
  }));
  const save = useAction('pos.settings', { success: t('pos.set.saved') });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const caisses = st.caisses.filter((c) => c.key !== own);
  // the preview: a pack and a plain product of the catalogue, as the ticket of the next sale
  const sample = useMemo<PosSale>(() => {
    const withPack = st.products.find((p) => p.packs.length);
    const plain = st.products.find((p) => !p.packs.length);
    const lines = [...(withPack ? [{ variantId: withPack.variants[0].id, qty: withPack.packs[0].qty }] : []), ...(plain ? [{ variantId: plain.variants[0].id, qty: 1 }] : [])];
    const c = priced(lines, variantsOf(st.products));
    return {
      id: 0,
      ticket: 0,
      no: st.next,
      at: new Date().toISOString(),
      method: 'cash',
      total: c.total,
      saved: c.saved,
      items: c.items,
      seller: session?.profile.name ?? null,
      customer: null,
      caisse: { key: own ?? '', name: st.caisse.name },
      sessionId: 0,
      cancelledAt: null,
      lines: c.rows.map((r) => ({ productId: r.p.id, variantId: r.v.id, name: r.p.name, variant: r.v.title, sku: r.v.sku, qty: r.qty, unit: r.unit, total: r.total })),
    };
  }, [st, own, session]);
  const html = ticketHtml(sample, { ...st.ticket, title: f.title.trim(), phone: f.phone.trim(), address: f.address.trim(), footer: f.footer.trim(), autoPrint: f.autoPrint });
  const send = () =>
    save.mutate({
      warehouseId: f.warehouseId,
      into: Object.fromEntries(POS_METHODS.map((m) => [m, f.into[m] || null])) as Record<PosMethod, string | null>,
      title: f.title.trim(),
      phone: f.phone.trim(),
      address: f.address.trim(),
      footer: f.footer.trim(),
      autoPrint: f.autoPrint,
    });
  return (
    <div className="pos-set">
      <div className="pos-set-cols">
        <div className="pos-set-main">
          <section className="card">
            <h2>
              <Icon name="package" />
              {t('pos.set.stock')}
            </h2>
            <label className="pos-field">
              <span>{t('pos.set.depot')}</span>
              <select value={f.warehouseId} onChange={(e) => set('warehouseId', Number(e.target.value))}>
                {st.depots.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted pos-help">{t('pos.set.depotHelp')}</p>
          </section>
          <section className="card">
            <h2>
              <Icon name="wallet" />
              {t('pos.set.money')}
            </h2>
            {POS_METHODS.map((m) => (
              <label key={m} className="pos-field">
                <span>{t(`pos.set.into.${m}`)}</span>
                <select value={f.into[m]} onChange={(e) => set('into', { ...f.into, [m]: e.target.value })}>
                  <option value="">{t('pos.set.shopCaisse', { name: caisseName(t, st.caisse, own) })}</option>
                  {caisses.map((c) => (
                    <option key={c.key} value={c.key}>
                      {caisseName(t, c)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <p className="muted pos-help">{t('pos.set.moneyHelp')}</p>
          </section>
          <section className="card">
            <h2>
              <Icon name="receipt" />
              {t('pos.set.ticket')}
            </h2>
            <label className="pos-field">
              <span>{t('pos.set.title')}</span>
              <input value={f.title} maxLength={60} placeholder={st.ticket.shopName} onChange={(e) => set('title', e.target.value)} />
            </label>
            <div className="pos-two">
              <label className="pos-field">
                <span>{t('pos.set.phone')}</span>
                <input value={f.phone} maxLength={30} placeholder={st.ticket.shopPhone || '0550 12 34 56'} className="ltr" onChange={(e) => set('phone', e.target.value)} />
              </label>
              <label className="pos-field">
                <span>{t('pos.set.address')}</span>
                <input value={f.address} maxLength={120} placeholder={t('pos.set.addressPh')} onChange={(e) => set('address', e.target.value)} />
              </label>
            </div>
            <label className="pos-field">
              <span>{t('pos.set.footer')}</span>
              <input value={f.footer} maxLength={120} placeholder={t('pos.ticket.thanks')} onChange={(e) => set('footer', e.target.value)} />
            </label>
            <label className="pos-check">
              <input type="checkbox" checked={f.autoPrint} onChange={(e) => set('autoPrint', e.target.checked)} />
              <span>
                <b>{t('pos.set.autoPrint')}</b>
                <small className="muted">{t('pos.set.autoPrintHelp')}</small>
              </span>
            </label>
          </section>
          <div className="pos-save">
            <button type="button" className="btn primary" disabled={save.isPending} onClick={send}>
              <Icon name="check" />
              {t('pos.set.save')}
            </button>
          </div>
        </div>
        <aside className="card pos-preview" aria-label={t('pos.set.preview')}>
          <h2>{t('pos.set.preview')}</h2>
          <p className="muted pos-help">{t('pos.set.previewHelp')}</p>
          <div className="pos-paper">
            <style>{TICKET_CSS}</style>
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </aside>
      </div>
    </div>
  );
}
