import{aG as Z,_ as X,Z as E,a9 as W,y as O,k as Y,ay as ee,u as S,r as $,j as i,M as te,I as x,e as K,J as le,m as T,t as k,ae as Q,b as se}from"./index-B22q9eTf.js";import{p as J,e as I}from"./files-CBat0WiC.js";function ae(e,l){return e.companyId?!e.tracking&&(l===void 0||ee.includes(l))?{ok:!1,why:"waiting"}:{ok:!0,code:e.tracking||e.ownTracking||e.ref}:{ok:!1,why:"noCompany"}}const ne=e=>e&&Z.includes(e)?"company":"pilotix",ie="212222222122222221121223121322131222122213122312132212221213221312231212112232122132122231113222123122123221223211221132221231213212223112312131311222321122321221312212322112322211212123212321232121111323131123131321112313132113132311211313231113231311112133112331132131113123113321133121313121211331231131213113213311213131311123311321331121312113312311332111314111221411431111111224111422121124121421141122141221112214112412122114122411142112142211241211221114413111241112134111111242121142121241114212124112124211411212421112421211212141214121412121111143111341131141114113114311411113411311113141114131311141411131211412211214211232",oe="2331112";function L(e){const t=[104,...[...e].map(r=>r.charCodeAt(0)-32).filter(r=>r>=0&&r<=95)],o=t.reduce((r,c,m)=>r+c*Math.max(m,1),0)%103,n=[...t,o].map(r=>ie.slice(r*6,r*6+6)).join("")+oe;let a=10;const s=[];return[...n].forEach((r,c)=>{c%2===0&&s.push(`<rect x="${a}" y="0" width="${r}" height="1"/>`),a+=Number(r)}),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${a+10} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${I(e)}">${s.join("")}</svg>`}let re=null;const q=()=>re??=X(()=>import("./index-BdPPiznZ.js"),[],import.meta.url);function B(e,l){const t=e.QRCodeEncoder.encode(l,e.QRCodeDecoderErrorCorrectionLevel.Q).getMatrix(),o=t.getWidth(),n=3;let a="";for(let s=0;s<o;s++)for(let r=0;r<o;r++)t.get(r,s)===1&&(a+=`M${r+n} ${s+n}h1v1h-1z`);return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o+2*n} ${o+2*n}" shape-rendering="crispEdges" role="img" aria-label="${I(l)}"><path d="${a}"/></svg>`}const A=e=>{const l=e.replace(/\D/g,"");return l.length===10?`${l.slice(0,4)} ${l.slice(4,6)} ${l.slice(6,8)} ${l.slice(8)}`:e},de=`@page{size:100mm 150mm;margin:0}
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
.lbl-f span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbl-f b{font-size:9.5pt}
.lbl-f .lbl-sav{flex:none}
.lbl-demo{margin:-1mm 0 2mm;border:.5mm dashed #000;border-radius:1.4mm;padding:1mm 2mm;font-size:8pt;font-weight:800;text-align:center}
.lbl-retb{margin:-1mm 0 2.4mm;background:#000;color:#fff;border-radius:1.8mm;padding:2.4mm 2mm;text-align:center;font-size:20pt;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
.lbl-retb small{display:block;margin-top:.6mm;font-size:9pt;font-weight:700;letter-spacing:0;text-transform:none}
.lbl.ret .lbl-co{background:#fff;color:#000;border:.6mm solid #000}
.lbl-cod.ret span{background:#fff;color:#000;border-inline-end:.7mm solid #000}
.lbl-cod.ret b{font-size:13pt;display:flex;align-items:center;justify-content:flex-end}`;function ce(e,l,{o:t,code:o,demo:n},a){const s=I,r=t.items.map(b=>`${b.qty} × ${b.name}${b.variantTitle?` ${b.variantTitle}`:""}`).join(" + "),c=t.items.reduce((b,j)=>b+j.qty,0),m=[t.phone,t.phone2].filter(b=>!!b).map(A).join(" · ");return`<section class="lbl" dir="${E.dir()}">
${n?`<div class="lbl-demo">${s(e("depot.labels.demoStandIn",{name:t.companyName??""}))}</div>`:""}
<div class="lbl-top"><div class="lbl-id">
<div class="lbl-co">${s(t.companyName??"")}${t.livreurName?`<small>${s(e("depot.labels.livreur",{name:t.livreurName}))}</small>`:""}</div>
<div class="lbl-k">${s(e("depot.labels.tracking"))}</div>
<div class="lbl-trk">${s(o)}</div>
<div class="lbl-ref">${s(e("depot.labels.order"))} <b>${s(t.ref)}</b> · ${s(W(t.createdAt))}</div>
</div><div class="lbl-qr">${B(l,o)}</div></div>
${t.savRef?`<div class="lbl-ex"><b>${s(e("depot.labels.exchange",{ref:t.savRef}))}</b><span>${s(e("depot.labels.exchangeHint"))}</span></div>`:""}
<div class="lbl-to"><div class="lbl-wil"><b>${String(t.wilayaId).padStart(2,"0")}</b><span>${s(O(t.wilayaId))}</span></div>
<div class="lbl-who"><div class="lbl-k">${s(e("depot.labels.to"))}</div>
<div class="lbl-name">${s(t.customerName)}</div>
<div class="lbl-ph"><bdi dir="ltr">${s(m)}</bdi></div>
${t.commune?`<div class="lbl-com">${s(t.commune)}</div>`:""}
${t.address?`<div class="lbl-adr">${s(t.address)}</div>`:""}
<span class="lbl-mode${t.isStopdesk?" desk":""}">${s(t.isStopdesk?e("depot.labels.desk"):e("depot.labels.home"))}</span></div></div>
<div class="lbl-s"><div class="lbl-k">${s(e("depot.labels.itemsN",{count:c}))}</div><div class="lbl-it">${s(r||"—")}</div>
${t.deliveryNote?`<div class="lbl-note">${s(e("depot.labels.note"))} : ${s(t.deliveryNote)}</div>`:""}</div>
<div class="lbl-cod"><span>${s(e("depot.labels.collect"))}</span><b>${s(Y(t.total))}</b></div>
<div class="lbl-bc">${L(o)}</div>
<div class="lbl-code">${s(o)}</div>
<div class="lbl-f"><span>${s(e("depot.labels.fromShort"))} <b>${s(a.name)}</b></span>${a.sav?`<span class="lbl-sav">${s(e("depot.labels.savPhone"))} <b><bdi dir="ltr">${s(A(a.sav))}</bdi></b></span>`:""}</div>
</section>`}function me(e,l,{o:t,code:o},n){const a=I,s=t.items.map(c=>`${c.qty} × ${c.name}${c.variantTitle?` ${c.variantTitle}`:""}`).join(" + "),r=[t.phone,t.phone2].filter(c=>!!c).map(A).join(" · ");return`<section class="lbl ret" dir="${E.dir()}">
<div class="lbl-retb">${a(e("depot.labels.retTitle"))}<small>${a(e("depot.labels.retSub"))}</small></div>
<div class="lbl-top"><div class="lbl-id">
<div class="lbl-co">${a(n.name)}<small>${a(e("depot.labels.retTo"))}</small></div>
<div class="lbl-k">${a(e("depot.labels.order"))}</div>
<div class="lbl-trk">${a(t.ref)}</div>
${t.savRef?`<div class="lbl-ref">${a(e("depot.labels.exchange",{ref:t.savRef}))}</div>`:""}
</div><div class="lbl-qr">${B(l,o)}</div></div>
<div class="lbl-to"><div class="lbl-wil"><b>${String(t.wilayaId).padStart(2,"0")}</b><span>${a(O(t.wilayaId))}</span></div>
<div class="lbl-who"><div class="lbl-k">${a(e("depot.labels.retFrom"))}</div>
<div class="lbl-name">${a(t.customerName)}</div>
<div class="lbl-ph"><bdi dir="ltr">${a(r)}</bdi></div>
${t.commune?`<div class="lbl-com">${a(t.commune)}</div>`:""}</div></div>
<div class="lbl-s"><div class="lbl-k">${a(e("depot.labels.retWhat"))}</div><div class="lbl-it">${a(e("depot.labels.retWhatText",{items:s||"—"}))}</div></div>
<div class="lbl-cod ret"><span>${a(e("depot.labels.retNoCash"))}</span><b>${a(e("depot.labels.retNoCashB"))}</b></div>
<div class="lbl-bc">${L(o)}</div>
<div class="lbl-code">${a(o)}</div>
<div class="lbl-f"><span>${a(e("depot.labels.retScan"))}</span></div>
</section>`}const pe=e=>!!(e.isExchange||e.savRef);async function U(e,l,t){if(!l.length)return;const o=await q(),a=[...l].sort((s,r)=>(s.o.companyName??"").localeCompare(r.o.companyName??"")||s.o.ref.localeCompare(r.o.ref,void 0,{numeric:!0})).flatMap(s=>[ce(e,o,s,t),...pe(s.o)?[me(e,o,s,t)]:[]]);J(e("depot.labels.docTitle",{n:a.length}),`<style>${de}</style>${a.join("")}`)}const be=`@page{size:A4;margin:12mm}
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
.bag td.trk{font-family:"Courier New",Courier,monospace;font-weight:800;direction:ltr}`;async function he(e,l,t){const o=await q(),n=I,a=l.parcels.map((s,r)=>`<tr><td class="num">${r+1}</td><td class="trk">${n(s.tracking??"")}</td><td>${n(s.ref)}</td><td>${n(s.customer)}</td><td>${s.wilayaId?`${String(s.wilayaId).padStart(2,"0")} ${n(O(s.wilayaId))}`:""}${s.commune?` · ${n(s.commune)}`:""}</td></tr>`).join("");J(e("depot.bags.sheetTitle"),`<style>${be}</style><section class="bag" dir="${E.dir()}">
${`<div class="bag-demo">${n(e("depot.bags.sheetDemo",{name:l.company}))}</div>`}
<div class="bag-top"><div class="bag-id"><div class="bag-k">${n(e("depot.bags.sheetTitle"))}</div><div class="bag-co">${n(l.company)}</div>
<div class="bag-trk">${n(l.tracking)}</div><div class="bag-n">${n(e("depot.bags.parcelsN",{count:l.parcels.length}))} · ${n(W(l.createdAt))}</div></div>
<div class="bag-qr">${B(o,l.tracking)}</div></div>
<div class="bag-bc">${L(l.tracking)}</div><div class="bag-code">${n(l.tracking)}</div>
<table><thead><tr><th class="num">#</th><th>${n(e("depot.labels.tracking"))}</th><th>${n(e("depot.labels.order"))}</th><th>${n(e("depot.bags.customer"))}</th><th>${n(e("depot.bags.wilaya"))}</th></tr></thead><tbody>${a}</tbody></table>
</section>`)}function F(e){if(e?.url)return e.url;if(!e?.pdf)return null;const l=atob(e.pdf),t=new Uint8Array(l.length);for(let o=0;o<l.length;o++)t[o]=l.charCodeAt(o);return URL.createObjectURL(new Blob([t],{type:e.type||"application/pdf"}))}function P(){const e=K("orders.lookups",{},{staleTime:3e5});if(!e.data)return null;const l=new Map(e.data.companies.map(t=>[t.id,t.kind]));return{kindOf:t=>l.get(t),shop:{name:e.data.shopName,sav:e.data.savPhone??""}}}const z=(e,l)=>ae(e,e.companyId?l.kindOf(e.companyId):void 0),N=(e,l)=>ne(e.companyId?l.kindOf(e.companyId):void 0),G=e=>e.tracking||e.ownTracking||e.ref;function V(){const{t:e}=S(),l=se(),[t,o]=$.useState(!1),n=$.useRef(!1);return{send:async s=>{if(!(!s.length||n.current)){n.current=!0,o(!0);try{const r=await T("delivery.send",{ids:s}),c=r.results.filter(m=>!m.ok);r.sent&&k(e("depot.labels.sent",{count:r.sent}),"ok"),c.length&&k(`${e("depot.labels.notSent",{count:c.length})} : ${c.map(m=>`${m.ref} ${m.error??""}`).join(" · ")}`,"bad",8e3)}catch(r){k(r.message,"bad")}finally{n.current=!1,o(!1),l.invalidateQueries()}}},busy:t}}function H(){const{t:e}=S(),l=P(),[t,o]=$.useState(!1),[n,a]=$.useState(null),[s,r]=$.useState(new Set),c=d=>k(d?.message||String(d),"bad"),m=d=>({o:d,code:G(d)}),b=async d=>{if(l){o(!0);try{const f=d.filter(g=>z(g,l).ok);f.length<d.length&&k(e("depot.labels.skipped",{count:d.length-f.length}),"bad",6e3);const p=f.filter(g=>N(g,l)==="pilotix"),w=f.filter(g=>N(g,l)==="company"),y=[],R=[],_=[];let M=0;if(w.length){const g=new Map(w.map(u=>[u.id,u]));for(const u of await T("delivery.labels",{ids:w.map(v=>v.id)})){const v=u.ids.map(C=>g.get(C)).filter(C=>!!C);if(!v.length)continue;const D=F(u.label);D?R.push({os:v,href:D}):u.label?.demo?y.push(...v):u.error?(M+=v.length,_.push(`${v.map(C=>C.ref).join(", ")} ${u.error}`)):p.push(...v)}}if(await U(e,[...p.map(m),...y.map(g=>({o:g,code:G(g),demo:!0}))],l.shop),_.length&&k(`${e("depot.labels.notGot",{count:M})} : ${_.join(" · ")}`,"bad",9e3),R.length){r(new Set);const g=u=>u.os[0];a(R.sort((u,v)=>(g(u).companyName??"").localeCompare(g(v).companyName??"")||g(u).ref.localeCompare(g(v).ref,void 0,{numeric:!0})))}}catch(f){c(f)}finally{o(!1)}}},j=async d=>{if(!l)return;if(N(d,l)==="pilotix"||le.kind==="demo")return b([d]);const f=window.open("","_blank");o(!0);try{const p=F(await T("delivery.label",{orderId:d.id}));p?f?f.location.href=p:window.open(p,"_blank"):(f?.close(),await U(e,[m(d)],l.shop))}catch(p){f?.close(),c(p)}finally{o(!1)}},h=n&&i.jsxs(te,{sheet:!0,title:e("depot.labels.companyTitle",{count:n.reduce((d,f)=>d+f.os.length,0)}),onClose:()=>a(null),footer:i.jsx("button",{type:"button",className:"btn primary",onClick:()=>a(null),children:e("common.close")}),children:[i.jsx("p",{className:"muted small",children:e("depot.labels.companyHelp")}),i.jsx("ul",{className:"pxl-list",children:n.map(({os:d,href:f})=>{const p=d[0],w=s.has(p.id);return i.jsxs("li",{children:[d.length>1?i.jsxs("span",{children:[i.jsxs("span",{children:[i.jsx("b",{children:p.companyName})," · ",e("depot.labels.fileN",{count:d.length})]}),i.jsx("small",{className:"ltr",children:d.length>4?`${d.slice(0,4).map(y=>y.ref).join(", ")} +${d.length-4}`:d.map(y=>y.ref).join(", ")})]}):i.jsxs("span",{children:[i.jsxs("span",{children:[i.jsx("b",{className:"ltr",children:p.ref})," · ",p.companyName]}),i.jsx("small",{className:"ltr",children:p.tracking})]}),i.jsxs("button",{type:"button",className:`btn small ${w?"":"primary"}`,onClick:()=>{window.open(f,"_blank"),r(y=>new Set(y).add(p.id))},children:[i.jsx(x,{name:w?"check":"printer"})," ",e(w?"depot.labels.opened":"depot.labels.open")]})]},p.id)})})]});return{ready:!!l,busy:t,print:b,printOne:j,modal:h}}function ue({phone:e}){const{t:l}=S(),t=P(),o=K("orders.list",{follow:["prepared"],conf:["confirmed"],sort:"updated_at",dir:"asc",page:1,pageSize:1e3,tickets:"include"}),n=V(),a=H();if($.useEffect(()=>void q(),[]),!t||!o.data)return null;const s=o.data.rows,r=s.filter(h=>z(h,t).ok),c=r.filter(h=>N(h,t)==="pilotix"),m=r.filter(h=>N(h,t)==="company"),b=s.filter(h=>{const d=z(h,t);return!d.ok&&d.why==="waiting"}),j=s.filter(h=>{const d=z(h,t);return!d.ok&&d.why==="noCompany"}).length;return i.jsxs("section",{className:`pxl-bar ${e?"pxl-phone":""}`,"aria-label":l("depot.labels.title"),children:[e&&i.jsxs("div",{className:"pxl-head",children:[i.jsx("b",{children:l("depot.labels.title")}),i.jsx(Q,{text:l("depot.labels.help"),label:l("depot.labels.title")})]}),i.jsxs("div",{className:"pxl-btns",children:[m.length>0&&i.jsxs("button",{type:"button",className:"btn primary pxl-print",disabled:a.busy,onClick:()=>a.print(m),children:[i.jsx(x,{name:"printer"})," ",l("depot.labels.printCompanies",{n:m.length})]}),c.length>0&&i.jsxs("button",{type:"button",className:`btn ${m.length?"":"primary"} pxl-print`,disabled:a.busy,onClick:()=>a.print(c),children:[i.jsx(x,{name:"printer"})," ",l("depot.labels.printPilotix",{n:c.length})]}),!r.length&&i.jsxs("button",{type:"button",className:"btn primary pxl-print",disabled:!0,children:[i.jsx(x,{name:"printer"})," ",l("depot.labels.printAll",{n:0})]}),!e&&i.jsx(Q,{text:l("depot.labels.help"),label:l("depot.labels.title")})]}),b.length>0&&i.jsxs("div",{className:"pxl-warn",children:[i.jsx(x,{name:"clock"}),i.jsx("span",{className:"pxl-wt",children:l("depot.labels.waitingN",{count:b.length})}),i.jsxs("button",{type:"button",className:"btn small",disabled:n.busy,onClick:()=>n.send(b.map(h=>h.id)),children:[i.jsx(x,{name:"send"})," ",l("depot.labels.sendAll")]})]}),j>0&&i.jsx("span",{className:"pxl-none",children:l("depot.labels.noneN",{count:j})}),a.modal]})}function ve({o:e,phone:l}){const{t}=S(),o=P(),n=V(),a=H();if(!o)return null;const s=z(e,o),r=l?"pxl-act":"btn small";return s.ok?i.jsxs(i.Fragment,{children:[i.jsxs("button",{type:"button",className:r,disabled:a.busy,onClick:c=>(c.stopPropagation(),a.printOne(e)),children:[i.jsx(x,{name:"printer"})," ",N(e,o)==="company"?t("depot.labels.oneOf",{name:e.companyName??""}):t("depot.labels.one")]}),a.modal]}):s.why==="waiting"?i.jsxs("button",{type:"button",className:`${r} pxl-send`,disabled:n.busy,onClick:c=>(c.stopPropagation(),n.send([e.id])),children:[i.jsx(x,{name:"send"})," ",t("depot.labels.sendTo",{name:e.companyName??""})]}):i.jsx("span",{className:"muted small",children:t("depot.labels.noCompany")})}function xe({ids:e}){const{t:l}=S(),t=H(),[o,n]=$.useState(!1);return i.jsxs(i.Fragment,{children:[i.jsxs("button",{type:"button",className:"btn small",disabled:!t.ready||o||t.busy,onClick:async()=>{n(!0);try{const a=await T("orders.list",{ids:e,page:1,pageSize:Math.min(3e3,e.length),tickets:"include"});await t.print(a.rows)}catch(a){k(a.message,"bad")}finally{n(!1)}},children:[i.jsx(x,{name:"printer"})," ",l("depot.labels.printSel")]}),t.modal]})}export{ue as L,xe as P,H as a,he as b,F as c,ve as d,q as l,U as p,z as s,P as u};
