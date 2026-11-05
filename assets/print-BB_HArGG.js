import{Z as $,m as p,e as o,$ as i}from"./index-BSyTSOtk.js";import{e as t,p as _}from"./files-DtL9gooq.js";import{t as d}from"./items-rEh_HywU.js";import{l}from"./labelPrint-DA6Aj8S0.js";const m=s=>s.items.map(e=>`${e.qty} × ${e.name}${e.variantTitle?` (${e.variantTitle})`:""}`).join(" + ");function g(s){const e=(a,r)=>i.t(`livraison.sheet.${a}`,r),n=s.orders.map((a,r)=>`<tr>
  <td class="num">${r+1}</td>
  <td><b>${t(a.ref)}</b>${d(a)?`<br><span class="muted">${t(d(a))}</span>`:""}</td>
  <td><b>${t(a.customerName)}</b><br>${t(a.phone)}${a.phone2?` / ${t(a.phone2)}`:""}</td>
  <td>${t($(a.wilayaId))} · ${t(a.commune)}<br>${t(a.address)}${a.isStopdesk?`<br><b>${t(e("stopdesk"))}</b>`:""}</td>
  <td>${t(m(a))}${a.deliveryNote?`<br><i>${t(a.deliveryNote)}</i>`:""}</td>
  <td class="num big">${t(p(a.total))}</td>
  <td style="width:90px"></td>
</tr>`).join("");_(s.title,`<h1 style="display:flex;align-items:center;gap:12px">${l(s.logo,"rs-logo","width:44px;height:44px;object-fit:contain;border-radius:9px")}<span>${t(s.title)}</span></h1>
<p class="muted">${t(s.shop)} · ${t(o(s.date))}${s.phone?` · ${t(s.phone)}`:""}</p>
<p><b>${t(e("count",{count:s.orders.length}))}</b> · ${t(e("total"))} <b>${t(p(s.total))}</b></p>
<table><thead><tr><th>#</th><th>${t(e("order"))}</th><th>${t(e("customer"))}</th><th>${t(e("address"))}</th><th>${t(e("products"))}</th><th class="num">${t(e("amount"))}</th><th>${t(e("sign"))}</th></tr></thead>
<tbody>${n||`<tr><td colspan="7">${t(e("empty"))}</td></tr>`}</tbody></table>
<p style="margin-top:24px">${t(e("signLivreur"))} : ____________________ &nbsp; ${t(e("signDepot"))} : ____________________</p>`)}export{g as p};
