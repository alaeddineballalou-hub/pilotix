import{a7 as y,_ as k,a8 as p,Y as h,A as g,m as z,a9 as C}from"./index-CGcVSvDH.js";import{w as N}from"./safeHref-BFEd5UcN.js";import{p as $,e as m}from"./files-6apwC85t.js";function P(e,i){return e.companyId?!e.tracking&&(i===void 0||C.includes(i))?{ok:!1,why:"waiting"}:{ok:!0,code:e.tracking||e.ownTracking||e.ref}:{ok:!1,why:"noCompany"}}const D=e=>e&&y.includes(e)?"company":"pilotix",S="212222222122222221121223121322131222122213122312132212221213221312231212112232122132122231113222123122123221223211221132221231213212223112312131311222321122321221312212322112322211212123212321232121111323131123131321112313132113132311211313231113231311112133112331132131113123113321133121313121211331231131213113213311213131311123311321331121312113312311332111314111221411431111111224111422121124121421141122141221112214112412122114122411142112142211241211221114413111241112134111111242121142121241114212124112124211411212421112421211212141214121412121111143111341131141114113114311411113411311113141114131311141411131211412211214211232",j="2331112";function f(e){const t=[104,...[...e].map(o=>o.charCodeAt(0)-32).filter(o=>o>=0&&o<=95)],r=t.reduce((o,n,c)=>o+n*Math.max(c,1),0)%103,s=[...t,r].map(o=>S.slice(o*6,o*6+6)).join("")+j;let a=10;const l=[];return[...s].forEach((o,n)=>{n%2===0&&l.push(`<rect x="${a}" y="0" width="${o}" height="1"/>`),a+=Number(o)}),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${a+10} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${m(e)}">${l.join("")}</svg>`}let A=null;const w=()=>A??=k(()=>import("./index-BdPPiznZ.js"),[],import.meta.url);function v(e,i){const t=e.QRCodeEncoder.encode(i,e.QRCodeDecoderErrorCorrectionLevel.Q).getMatrix(),r=t.getWidth(),s=3;let a="";for(let l=0;l<r;l++)for(let o=0;o<r;o++)t.get(o,l)===1&&(a+=`M${o+s} ${l+s}h1v1h-1z`);return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r+2*s} ${r+2*s}" shape-rendering="crispEdges" role="img" aria-label="${m(i)}"><path d="${a}"/></svg>`}const u=(e,i,t)=>e&&/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(e)?`<img class="${i}" src="${e}" alt=""${t?` style="${t}"`:""}>`:"",b=e=>{const i=e.replace(/\D/g,"");return i.length===10?`${i.slice(0,4)} ${i.slice(4,6)} ${i.slice(6,8)} ${i.slice(8)}`:e},I=`@page{size:100mm 150mm;margin:0}
html,body{margin:0!important;padding:0;background:#fff}
.lbl{width:100mm;height:150mm;box-sizing:border-box;padding:3.6mm 4mm;display:flex;flex-direction:column;overflow:hidden;break-after:page;page-break-after:always;font-family:Arial,"Helvetica Neue",Helvetica,sans-serif;color:#000;line-height:1.2}
.lbl:last-child{break-after:auto;page-break-after:auto}
.lbl *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.lbl-k{font-size:7.5pt;font-weight:800;letter-spacing:.02em}
.lbl-top{display:flex;gap:3mm;direction:ltr}
.lbl-id{flex:1;min-width:0;display:flex;flex-direction:column}
[dir="rtl"] .lbl-id{direction:rtl}
.lbl-co{background:#000;color:#fff;border-radius:1.8mm;padding:2mm 3mm;font-size:15pt;font-weight:900;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lbl-co small{display:block;margin-top:.3mm;font-size:9pt;font-weight:700;letter-spacing:0;text-transform:none;overflow:hidden;text-overflow:ellipsis}
.lbl-id .lbl-k{margin-top:2mm}
.lbl-trk{font:900 18pt/1.05 "Courier New",Courier,monospace;letter-spacing:.02em;direction:ltr;overflow-wrap:anywhere}
[dir="rtl"] .lbl-trk{text-align:right}
.lbl-ref{margin-top:1.4mm;font-size:10pt}
.lbl-ref b{font-size:12pt;direction:ltr;unicode-bidi:isolate}
.lbl-qr{flex:none;width:30mm;height:30mm;border:.5mm solid #000;border-radius:1.8mm;padding:.5mm}
.lbl-qr svg{display:block;width:100%;height:100%}
.lbl-ex{margin-top:2.4mm;display:flex;align-items:center;gap:2.4mm;border:.7mm solid #000;border-radius:1.8mm;padding:1.4mm 2.4mm;font-size:9pt}
.lbl-ex b{flex:none;background:#000;color:#fff;border-radius:1mm;padding:.6mm 1.8mm;font-size:9.5pt;font-weight:900}
.lbl-to{display:flex;gap:3mm;margin-top:2.6mm;padding-top:2.6mm;border-top:.5mm solid #000;direction:ltr}
.lbl-wil{flex:none;width:23mm;align-self:flex-start;background:#000;color:#fff;border-radius:1.8mm;padding:2mm 1mm 1.8mm;display:flex;flex-direction:column;align-items:center;text-align:center}
.lbl-wil b{font-size:29pt;font-weight:900;line-height:1;direction:ltr}
.lbl-wil span{margin-top:.8mm;font-size:7.5pt;font-weight:800;text-transform:uppercase;line-height:1.15;overflow-wrap:anywhere}
.lbl-who{flex:1;min-width:0;display:flex;flex-direction:column;gap:.5mm}
[dir="rtl"] .lbl-who{direction:rtl}
.lbl-name{font-size:16pt;font-weight:900;line-height:1.1}
.lbl-ph{font-size:14.5pt;font-weight:800}
.lbl-com{font-size:12pt;font-weight:800}
.lbl-adr{font-size:10pt;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lbl-mode{align-self:flex-start;margin-top:.8mm;border:.5mm solid #000;border-radius:1mm;padding:.3mm 1.8mm;font-size:8.5pt;font-weight:900;letter-spacing:.04em}
.lbl-mode.desk{background:#000;color:#fff}
.lbl-s{margin-top:2.4mm;padding-top:2mm;border-top:.5mm solid #000}
.lbl-it{margin-top:.6mm;font-size:10.5pt;line-height:1.3;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.lbl-note{margin-top:1.2mm;font-size:10pt;font-weight:800}
.lbl-cod{margin-top:auto;display:flex;align-items:stretch;border:.7mm solid #000;border-radius:1.8mm;overflow:hidden}
.lbl-cod span{flex:none;display:flex;align-items:center;background:#000;color:#fff;padding:0 3mm;font-size:9.5pt;font-weight:900;letter-spacing:.03em;text-transform:uppercase}
.lbl-cod b{flex:1;padding:1mm 3mm;text-align:end;font-size:21pt;font-weight:900;white-space:nowrap;direction:ltr;unicode-bidi:isolate}
[dir="rtl"] .lbl-cod b{text-align:left}
.lbl-bc{margin:2.4mm -1mm 1mm;direction:ltr}
.lbl-bc svg{display:block;width:100%;height:16mm}
.lbl-code{text-align:center;font:800 11pt/1 "Courier New",Courier,monospace;letter-spacing:.1em;direction:ltr}
.lbl-f{display:flex;align-items:center;justify-content:space-between;gap:2mm;margin-top:2mm;padding-top:1.4mm;border-top:.3mm solid #000;font-size:8pt}
.lbl-from{display:inline-flex;align-items:center;gap:1.4mm;min-width:0}
.lbl-logo{width:7mm;height:7mm;object-fit:contain;flex:none}
.lbl-f span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbl-f b{font-size:9.5pt}
.lbl-f .lbl-sav{flex:none}
.lbl-demo{margin:-1mm 0 2mm;border:.5mm dashed #000;border-radius:1.4mm;padding:1mm 2mm;font-size:8pt;font-weight:800;text-align:center}
.lbl-retb{margin:-1mm 0 2.4mm;background:#000;color:#fff;border-radius:1.8mm;padding:2.4mm 2mm;text-align:center;font-size:20pt;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
.lbl-retb small{display:block;margin-top:.6mm;font-size:9pt;font-weight:700;letter-spacing:0;text-transform:none}
.lbl.ret .lbl-co{background:#fff;color:#000;border:.6mm solid #000}
.lbl-cod.ret span{background:#fff;color:#000;border-inline-end:.7mm solid #000}
.lbl-cod.ret b{font-size:13pt;display:flex;align-items:center;justify-content:flex-end}`;function E(e,i,{o:t,code:r,demo:s},a){const l=m,o=t.items.map(d=>`${d.qty} × ${d.name}${d.variantTitle?` ${d.variantTitle}`:""}`).join(" + "),n=t.items.reduce((d,x)=>d+x.qty,0),c=[t.phone,t.phone2].filter(d=>!!d).map(b).join(" · ");return`<section class="lbl" dir="${p.dir()}">
${s?`<div class="lbl-demo">${l(e("depot.labels.demoStandIn",{name:t.companyName??""}))}</div>`:""}
<div class="lbl-top"><div class="lbl-id">
<div class="lbl-co">${l(t.companyName??"")}${t.livreurName?`<small>${l(e("depot.labels.livreur",{name:t.livreurName}))}</small>`:""}</div>
<div class="lbl-k">${l(e("depot.labels.tracking"))}</div>
<div class="lbl-trk">${l(r)}</div>
<div class="lbl-ref">${l(e("depot.labels.order"))} <b>${l(t.ref)}</b> · ${l(h(t.createdAt))}</div>
</div><div class="lbl-qr">${v(i,r)}</div></div>
${t.savRef?`<div class="lbl-ex"><b>${l(e("depot.labels.exchange",{ref:t.savRef}))}</b><span>${l(e("depot.labels.exchangeHint"))}</span></div>`:""}
<div class="lbl-to"><div class="lbl-wil"><b>${String(t.wilayaId).padStart(2,"0")}</b><span>${l(g(t.wilayaId))}</span></div>
<div class="lbl-who"><div class="lbl-k">${l(e("depot.labels.to"))}</div>
<div class="lbl-name">${l(t.customerName)}</div>
<div class="lbl-ph"><bdi dir="ltr">${l(c)}</bdi></div>
${t.commune?`<div class="lbl-com">${l(t.commune)}</div>`:""}
${t.address?`<div class="lbl-adr">${l(t.address)}</div>`:""}
<span class="lbl-mode${t.isStopdesk?" desk":""}">${l(t.isStopdesk?e("depot.labels.desk"):e("depot.labels.home"))}</span></div></div>
<div class="lbl-s"><div class="lbl-k">${l(e("depot.labels.itemsN",{count:n}))}</div><div class="lbl-it">${l(o||"—")}</div>
${t.deliveryNote?`<div class="lbl-note">${l(e("depot.labels.note"))} : ${l(t.deliveryNote)}</div>`:""}</div>
<div class="lbl-cod"><span>${l(e("depot.labels.collect"))}</span><b>${l(z(t.total))}</b></div>
<div class="lbl-bc">${f(r)}</div>
<div class="lbl-code">${l(r)}</div>
<div class="lbl-f"><span class="lbl-from">${u(a.logo,"lbl-logo")}<span>${l(e("depot.labels.fromShort"))} <b>${l(a.name)}</b></span></span>${a.sav?`<span class="lbl-sav">${l(e("depot.labels.savPhone"))} <b><bdi dir="ltr">${l(b(a.sav))}</bdi></b></span>`:""}</div>
</section>`}function R(e,i,{o:t,code:r},s){const a=m,l=t.items.map(n=>`${n.qty} × ${n.name}${n.variantTitle?` ${n.variantTitle}`:""}`).join(" + "),o=[t.phone,t.phone2].filter(n=>!!n).map(b).join(" · ");return`<section class="lbl ret" dir="${p.dir()}">
<div class="lbl-retb">${a(e("depot.labels.retTitle"))}<small>${a(e("depot.labels.retSub"))}</small></div>
<div class="lbl-top"><div class="lbl-id">
<div class="lbl-co">${u(s.logo,"lbl-logo","margin-inline-end:1.5mm;vertical-align:middle;background:#fff;border-radius:1mm")}${a(s.name)}<small>${a(e("depot.labels.retTo"))}</small></div>
<div class="lbl-k">${a(e("depot.labels.order"))}</div>
<div class="lbl-trk">${a(t.ref)}</div>
${t.savRef?`<div class="lbl-ref">${a(e("depot.labels.exchange",{ref:t.savRef}))}</div>`:""}
</div><div class="lbl-qr">${v(i,r)}</div></div>
<div class="lbl-to"><div class="lbl-wil"><b>${String(t.wilayaId).padStart(2,"0")}</b><span>${a(g(t.wilayaId))}</span></div>
<div class="lbl-who"><div class="lbl-k">${a(e("depot.labels.retFrom"))}</div>
<div class="lbl-name">${a(t.customerName)}</div>
<div class="lbl-ph"><bdi dir="ltr">${a(o)}</bdi></div>
${t.commune?`<div class="lbl-com">${a(t.commune)}</div>`:""}</div></div>
<div class="lbl-s"><div class="lbl-k">${a(e("depot.labels.retWhat"))}</div><div class="lbl-it">${a(e("depot.labels.retWhatText",{items:l||"—"}))}</div></div>
<div class="lbl-cod ret"><span>${a(e("depot.labels.retNoCash"))}</span><b>${a(e("depot.labels.retNoCashB"))}</b></div>
<div class="lbl-bc">${f(r)}</div>
<div class="lbl-code">${a(r)}</div>
<div class="lbl-f"><span>${a(e("depot.labels.retScan"))}</span></div>
</section>`}const _=e=>!!(e.isExchange||e.savRef);async function O(e,i,t){if(!i.length)return;const r=await w(),a=[...i].sort((l,o)=>(l.o.companyName??"").localeCompare(o.o.companyName??"")||l.o.ref.localeCompare(o.o.ref,void 0,{numeric:!0})).flatMap(l=>[E(e,r,l,t),..._(l.o)?[R(e,r,l,t)]:[]]);$(e("depot.labels.docTitle",{n:a.length}),`<style>${I}</style>${a.join("")}`)}const T=`@page{size:A4;margin:12mm}
.bag{font-family:Arial,"Helvetica Neue",Helvetica,sans-serif;color:#000}
.bag *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.bag-demo{border:.5mm dashed #000;border-radius:1.4mm;padding:1.5mm 3mm;margin-bottom:5mm;font-size:9pt;font-weight:800;text-align:center}
.bag-top{display:flex;gap:6mm;align-items:flex-start;direction:ltr}
.bag-id{flex:1;min-width:0;display:flex;flex-direction:column;gap:1.5mm}
[dir="rtl"] .bag-id{direction:rtl}
.bag-k{font-size:9pt;font-weight:800;letter-spacing:.02em}
.bag-co{align-self:flex-start;background:#000;color:#fff;border-radius:2mm;padding:2mm 4mm;font-size:18pt;font-weight:900;text-transform:uppercase}
.bag-trk{font:900 30pt/1.05 "Courier New",Courier,monospace;direction:ltr}
[dir="rtl"] .bag-trk{text-align:right}
.bag-n{font-size:13pt;font-weight:800}
.bag-qr{flex:none;width:42mm;height:42mm;border:.6mm solid #000;border-radius:2mm;padding:.6mm}
.bag-qr svg,.bag-bc svg{display:block;width:100%;height:100%}
.bag-bc{height:20mm;margin:5mm -1mm 1mm;direction:ltr}
.bag-code{text-align:center;font:800 13pt/1 "Courier New",Courier,monospace;letter-spacing:.12em;direction:ltr}
.bag table{margin-top:6mm;font-size:10pt}
.bag th{font-size:8.5pt}
.bag td.trk{font-family:"Courier New",Courier,monospace;font-weight:800;direction:ltr}`;async function U(e,i,t){const r=await w(),s=m,a=i.parcels.map((l,o)=>`<tr><td class="num">${o+1}</td><td class="trk">${s(l.tracking??"")}</td><td>${s(l.ref)}</td><td>${s(l.customer)}</td><td>${l.wilayaId?`${String(l.wilayaId).padStart(2,"0")} ${s(g(l.wilayaId))}`:""}${l.commune?` · ${s(l.commune)}`:""}</td></tr>`).join("");$(e("depot.bags.sheetTitle"),`<style>${T}</style><section class="bag" dir="${p.dir()}">
${`<div class="bag-demo">${s(e("depot.bags.sheetDemo",{name:i.company}))}</div>`}
<div class="bag-top"><div class="bag-id"><div class="bag-k">${s(e("depot.bags.sheetTitle"))}</div><div class="bag-co">${s(i.company)}</div>
<div class="bag-trk">${s(i.tracking)}</div><div class="bag-n">${s(e("depot.bags.parcelsN",{count:i.parcels.length}))} · ${s(h(i.createdAt))}</div></div>
<div class="bag-qr">${v(r,i.tracking)}</div></div>
<div class="bag-bc">${f(i.tracking)}</div><div class="bag-code">${s(i.tracking)}</div>
<table><thead><tr><th class="num">#</th><th>${s(e("depot.labels.tracking"))}</th><th>${s(e("depot.labels.order"))}</th><th>${s(e("depot.bags.customer"))}</th><th>${s(e("depot.bags.wilaya"))}</th></tr></thead><tbody>${a}</tbody></table>
</section>`)}const L=["application/pdf","image/png","image/jpeg","image/gif","image/webp"];function M(e){if(e?.url)return N(e.url);if(!e?.pdf)return null;const i=atob(e.pdf),t=new Uint8Array(i.length);for(let s=0;s<i.length;s++)t[s]=i.charCodeAt(s);const r=String(e.type||"").split(";")[0].trim().toLowerCase();return URL.createObjectURL(new Blob([t],{type:L.includes(r)?r:"application/pdf"}))}export{M as a,D as b,P as c,w as d,U as e,u as l,O as p};
