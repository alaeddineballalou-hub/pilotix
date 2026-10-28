import{T as n,k as d,d as p,U as i}from"./index-CkQjrFdT.js";import{e as t,p as o}from"./files-CBat0WiC.js";import{t as _}from"./items-rEh_HywU.js";const h=s=>s.items.map(e=>`${e.qty} × ${e.name}${e.variantTitle?` (${e.variantTitle})`:""}`).join(" + ");function c(s){const e=(a,r)=>i.t(`livraison.sheet.${a}`,r),$=s.orders.map((a,r)=>`<tr>
  <td class="num">${r+1}</td>
  <td><b>${t(a.ref)}</b>${_(a)?`<br><span class="muted">${t(_(a))}</span>`:""}</td>
  <td><b>${t(a.customerName)}</b><br>${t(a.phone)}${a.phone2?` / ${t(a.phone2)}`:""}</td>
  <td>${t(n(a.wilayaId))} · ${t(a.commune)}<br>${t(a.address)}${a.isStopdesk?`<br><b>${t(e("stopdesk"))}</b>`:""}</td>
  <td>${t(h(a))}${a.deliveryNote?`<br><i>${t(a.deliveryNote)}</i>`:""}</td>
  <td class="num big">${t(d(a.total))}</td>
  <td style="width:90px"></td>
</tr>`).join("");o(s.title,`<h1>${t(s.title)}</h1>
<p class="muted">${t(s.shop)} · ${t(p(s.date))}${s.phone?` · ${t(s.phone)}`:""}</p>
<p><b>${t(e("count",{count:s.orders.length}))}</b> · ${t(e("total"))} <b>${t(d(s.total))}</b></p>
<table><thead><tr><th>#</th><th>${t(e("order"))}</th><th>${t(e("customer"))}</th><th>${t(e("address"))}</th><th>${t(e("products"))}</th><th class="num">${t(e("amount"))}</th><th>${t(e("sign"))}</th></tr></thead>
<tbody>${$||`<tr><td colspan="7">${t(e("empty"))}</td></tr>`}</tbody></table>
<p style="margin-top:24px">${t(e("signLivreur"))} : ____________________ &nbsp; ${t(e("signDepot"))} : ____________________</p>`)}export{c as p};
