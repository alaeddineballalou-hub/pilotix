import{au as X,av as Y,p as Q,aw as U,y as F,k as Z,an as ee,u as S,r as j,j as a,M as te,I as v,e as G,J as le,l as I,t as $,ao as q,b as ne}from"./index-DPCduJtA.js";import{p as K,e as A}from"./files-CBat0WiC.js";function ae(e,t){return e.companyId?!e.tracking&&(t===void 0||ee.includes(t))?{ok:!1,why:"waiting"}:{ok:!0,code:e.tracking||e.ownTracking||e.ref}:{ok:!1,why:"noCompany"}}const se=e=>e&&X.includes(e)?"company":"pilotix",ie="212222222122222221121223121322131222122213122312132212221213221312231212112232122132122231113222123122123221223211221132221231213212223112312131311222321122321221312212322112322211212123212321232121111323131123131321112313132113132311211313231113231311112133112331132131113123113321133121313121211331231131213113213311213131311123311321331121312113312311332111314111221411431111111224111422121124121421141122141221112214112412122114122411142112142211241211221114413111241112134111111242121142121241114212124112124211411212421112421211212141214121412121111143111341131141114113114311411113411311113141114131311141411131211412211214211232",oe="2331112";function J(e){const n=[104,...[...e].map(r=>r.charCodeAt(0)-32).filter(r=>r>=0&&r<=95)],o=n.reduce((r,c,u)=>r+c*Math.max(u,1),0)%103,s=[...n,o].map(r=>ie.slice(r*6,r*6+6)).join("")+oe;let i=10;const l=[];return[...s].forEach((r,c)=>{c%2===0&&l.push(`<rect x="${i}" y="0" width="${r}" height="1"/>`),i+=Number(r)}),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${i+10} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${A(e)}">${l.join("")}</svg>`}let re=null;const E=()=>re??=Y(()=>import("./index-BdPPiznZ.js"),[],import.meta.url);function V(e,t){const n=e.QRCodeEncoder.encode(t,e.QRCodeDecoderErrorCorrectionLevel.Q).getMatrix(),o=n.getWidth(),s=3;let i="";for(let l=0;l<o;l++)for(let r=0;r<o;r++)n.get(r,l)===1&&(i+=`M${r+s} ${l+s}h1v1h-1z`);return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o+2*s} ${o+2*s}" shape-rendering="crispEdges" role="img" aria-label="${A(t)}"><path d="${i}"/></svg>`}const B=e=>{const t=e.replace(/\D/g,"");return t.length===10?`${t.slice(0,4)} ${t.slice(4,6)} ${t.slice(6,8)} ${t.slice(8)}`:e},de=`@page{size:100mm 150mm;margin:0}
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
.lbl-demo{margin:-1mm 0 2mm;border:.5mm dashed #000;border-radius:1.4mm;padding:1mm 2mm;font-size:8pt;font-weight:800;text-align:center}`;function ce(e,t,{o:n,code:o,demo:s},i){const l=A,r=n.items.map(p=>`${p.qty} × ${p.name}${p.variantTitle?` ${p.variantTitle}`:""}`).join(" + "),c=n.items.reduce((p,k)=>p+k.qty,0),u=[n.phone,n.phone2].filter(p=>!!p).map(B).join(" · ");return`<section class="lbl" dir="${Q.dir()}">
${s?`<div class="lbl-demo">${l(e("depot.labels.demoStandIn",{name:n.companyName??""}))}</div>`:""}
<div class="lbl-top"><div class="lbl-id">
<div class="lbl-co">${l(n.companyName??"")}${n.livreurName?`<small>${l(e("depot.labels.livreur",{name:n.livreurName}))}</small>`:""}</div>
<div class="lbl-k">${l(e("depot.labels.tracking"))}</div>
<div class="lbl-trk">${l(o)}</div>
<div class="lbl-ref">${l(e("depot.labels.order"))} <b>${l(n.ref)}</b> · ${l(U(n.createdAt))}</div>
</div><div class="lbl-qr">${V(t,o)}</div></div>
${n.savRef?`<div class="lbl-ex"><b>${l(e("depot.labels.exchange",{ref:n.savRef}))}</b><span>${l(e("depot.labels.exchangeHint"))}</span></div>`:""}
<div class="lbl-to"><div class="lbl-wil"><b>${String(n.wilayaId).padStart(2,"0")}</b><span>${l(F(n.wilayaId))}</span></div>
<div class="lbl-who"><div class="lbl-k">${l(e("depot.labels.to"))}</div>
<div class="lbl-name">${l(n.customerName)}</div>
<div class="lbl-ph"><bdi dir="ltr">${l(u)}</bdi></div>
${n.commune?`<div class="lbl-com">${l(n.commune)}</div>`:""}
${n.address?`<div class="lbl-adr">${l(n.address)}</div>`:""}
<span class="lbl-mode${n.isStopdesk?" desk":""}">${l(n.isStopdesk?e("depot.labels.desk"):e("depot.labels.home"))}</span></div></div>
<div class="lbl-s"><div class="lbl-k">${l(e("depot.labels.itemsN",{count:c}))}</div><div class="lbl-it">${l(r||"—")}</div>
${n.deliveryNote?`<div class="lbl-note">${l(e("depot.labels.note"))} : ${l(n.deliveryNote)}</div>`:""}</div>
<div class="lbl-cod"><span>${l(e("depot.labels.collect"))}</span><b>${l(Z(n.total))}</b></div>
<div class="lbl-bc">${J(o)}</div>
<div class="lbl-code">${l(o)}</div>
<div class="lbl-f"><span>${l(e("depot.labels.fromShort"))} <b>${l(i.name)}</b></span>${i.sav?`<span class="lbl-sav">${l(e("depot.labels.savPhone"))} <b><bdi dir="ltr">${l(B(i.sav))}</bdi></b></span>`:""}</div>
</section>`}async function H(e,t,n){if(!t.length)return;const o=await E(),s=[...t].sort((i,l)=>(i.o.companyName??"").localeCompare(l.o.companyName??"")||i.o.ref.localeCompare(l.o.ref,void 0,{numeric:!0}));K(e("depot.labels.docTitle",{n:s.length}),`<style>${de}</style>${s.map(i=>ce(e,o,i,n)).join("")}`)}const me=`@page{size:A4;margin:12mm}
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
.bag td.trk{font-family:"Courier New",Courier,monospace;font-weight:800;direction:ltr}`;async function fe(e,t,n){const o=await E(),s=A,i=t.parcels.map((l,r)=>`<tr><td class="num">${r+1}</td><td class="trk">${s(l.tracking??"")}</td><td>${s(l.ref)}</td><td>${s(l.customer)}</td><td>${l.wilayaId?`${String(l.wilayaId).padStart(2,"0")} ${s(F(l.wilayaId))}`:""}${l.commune?` · ${s(l.commune)}`:""}</td></tr>`).join("");K(e("depot.bags.sheetTitle"),`<style>${me}</style><section class="bag" dir="${Q.dir()}">
${`<div class="bag-demo">${s(e("depot.bags.sheetDemo",{name:t.company}))}</div>`}
<div class="bag-top"><div class="bag-id"><div class="bag-k">${s(e("depot.bags.sheetTitle"))}</div><div class="bag-co">${s(t.company)}</div>
<div class="bag-trk">${s(t.tracking)}</div><div class="bag-n">${s(e("depot.bags.parcelsN",{count:t.parcels.length}))} · ${s(U(t.createdAt))}</div></div>
<div class="bag-qr">${V(o,t.tracking)}</div></div>
<div class="bag-bc">${J(t.tracking)}</div><div class="bag-code">${s(t.tracking)}</div>
<table><thead><tr><th class="num">#</th><th>${s(e("depot.labels.tracking"))}</th><th>${s(e("depot.labels.order"))}</th><th>${s(e("depot.bags.customer"))}</th><th>${s(e("depot.bags.wilaya"))}</th></tr></thead><tbody>${i}</tbody></table>
</section>`)}function M(e){if(e?.url)return e.url;if(!e?.pdf)return null;const t=atob(e.pdf),n=new Uint8Array(t.length);for(let o=0;o<t.length;o++)n[o]=t.charCodeAt(o);return URL.createObjectURL(new Blob([n],{type:e.type||"application/pdf"}))}function L(){const e=G("orders.lookups",{},{staleTime:3e5});if(!e.data)return null;const t=new Map(e.data.companies.map(n=>[n.id,n.kind]));return{kindOf:n=>t.get(n),shop:{name:e.data.shopName,sav:e.data.savPhone??""}}}const z=(e,t)=>ae(e,e.companyId?t.kindOf(e.companyId):void 0),N=(e,t)=>se(e.companyId?t.kindOf(e.companyId):void 0),D=e=>e.tracking||e.ownTracking||e.ref;function W(){const{t:e}=S(),t=ne(),[n,o]=j.useState(!1);return{send:async i=>{if(i.length){o(!0);try{const l=await I("delivery.send",{ids:i}),r=l.results.filter(c=>!c.ok);l.sent&&$(e("depot.labels.sent",{count:l.sent}),"ok"),r.length&&$(`${e("depot.labels.notSent",{count:r.length})} : ${r.map(c=>`${c.ref} ${c.error??""}`).join(" · ")}`,"bad",8e3)}catch(l){$(l.message,"bad")}finally{o(!1),t.invalidateQueries()}}},busy:n}}function R(){const{t:e}=S(),t=L(),[n,o]=j.useState(!1),[s,i]=j.useState(null),[l,r]=j.useState(new Set),c=d=>$(d?.message||String(d),"bad"),u=d=>({o:d,code:D(d)}),p=async d=>{if(t){o(!0);try{const b=d.filter(f=>z(f,t).ok);b.length<d.length&&$(e("depot.labels.skipped",{count:d.length-b.length}),"bad",6e3);const m=b.filter(f=>N(f,t)==="pilotix"),y=b.filter(f=>N(f,t)==="company"),w=[],_=[],O=[];let T=0;if(y.length){const f=new Map(y.map(h=>[h.id,h]));for(const h of await I("delivery.labels",{ids:y.map(x=>x.id)})){const x=h.ids.map(C=>f.get(C)).filter(C=>!!C);if(!x.length)continue;const P=M(h.label);P?_.push({os:x,href:P}):h.label?.demo?w.push(...x):h.error?(T+=x.length,O.push(`${x.map(C=>C.ref).join(", ")} ${h.error}`)):m.push(...x)}}if(await H(e,[...m.map(u),...w.map(f=>({o:f,code:D(f),demo:!0}))],t.shop),O.length&&$(`${e("depot.labels.notGot",{count:T})} : ${O.join(" · ")}`,"bad",9e3),_.length){r(new Set);const f=h=>h.os[0];i(_.sort((h,x)=>(f(h).companyName??"").localeCompare(f(x).companyName??"")||f(h).ref.localeCompare(f(x).ref,void 0,{numeric:!0})))}}catch(b){c(b)}finally{o(!1)}}},k=async d=>{if(!t)return;if(N(d,t)==="pilotix"||le.kind==="demo")return p([d]);const b=window.open("","_blank");o(!0);try{const m=M(await I("delivery.label",{orderId:d.id}));m?b?b.location.href=m:window.open(m,"_blank"):(b?.close(),await H(e,[u(d)],t.shop))}catch(m){b?.close(),c(m)}finally{o(!1)}},g=s&&a.jsxs(te,{sheet:!0,title:e("depot.labels.companyTitle",{count:s.reduce((d,b)=>d+b.os.length,0)}),onClose:()=>i(null),footer:a.jsx("button",{type:"button",className:"btn primary",onClick:()=>i(null),children:e("common.close")}),children:[a.jsx("p",{className:"muted small",children:e("depot.labels.companyHelp")}),a.jsx("ul",{className:"pxl-list",children:s.map(({os:d,href:b})=>{const m=d[0],y=l.has(m.id);return a.jsxs("li",{children:[d.length>1?a.jsxs("span",{children:[a.jsxs("span",{children:[a.jsx("b",{children:m.companyName})," · ",e("depot.labels.fileN",{count:d.length})]}),a.jsx("small",{className:"ltr",children:d.length>4?`${d.slice(0,4).map(w=>w.ref).join(", ")} +${d.length-4}`:d.map(w=>w.ref).join(", ")})]}):a.jsxs("span",{children:[a.jsxs("span",{children:[a.jsx("b",{className:"ltr",children:m.ref})," · ",m.companyName]}),a.jsx("small",{className:"ltr",children:m.tracking})]}),a.jsxs("button",{type:"button",className:`btn small ${y?"":"primary"}`,onClick:()=>{window.open(b,"_blank"),r(w=>new Set(w).add(m.id))},children:[a.jsx(v,{name:y?"check":"printer"})," ",e(y?"depot.labels.opened":"depot.labels.open")]})]},m.id)})})]});return{ready:!!t,busy:n,print:p,printOne:k,modal:g}}function ge({phone:e}){const{t}=S(),n=L(),o=G("orders.list",{follow:["prepared"],conf:["confirmed"],sort:"updated_at",dir:"asc",page:1,pageSize:1e3,tickets:"include"}),s=W(),i=R();if(j.useEffect(()=>void E(),[]),!n||!o.data)return null;const l=o.data.rows,r=l.filter(g=>z(g,n).ok),c=r.filter(g=>N(g,n)==="pilotix"),u=r.filter(g=>N(g,n)==="company"),p=l.filter(g=>{const d=z(g,n);return!d.ok&&d.why==="waiting"}),k=l.filter(g=>{const d=z(g,n);return!d.ok&&d.why==="noCompany"}).length;return a.jsxs("section",{className:`pxl-bar ${e?"pxl-phone":""}`,"aria-label":t("depot.labels.title"),children:[e&&a.jsxs("div",{className:"pxl-head",children:[a.jsx("b",{children:t("depot.labels.title")}),a.jsx(q,{text:t("depot.labels.help"),label:t("depot.labels.title")})]}),a.jsxs("div",{className:"pxl-btns",children:[u.length>0&&a.jsxs("button",{type:"button",className:"btn primary pxl-print",disabled:i.busy,onClick:()=>i.print(u),children:[a.jsx(v,{name:"printer"})," ",t("depot.labels.printCompanies",{n:u.length})]}),c.length>0&&a.jsxs("button",{type:"button",className:`btn ${u.length?"":"primary"} pxl-print`,disabled:i.busy,onClick:()=>i.print(c),children:[a.jsx(v,{name:"printer"})," ",t("depot.labels.printPilotix",{n:c.length})]}),!r.length&&a.jsxs("button",{type:"button",className:"btn primary pxl-print",disabled:!0,children:[a.jsx(v,{name:"printer"})," ",t("depot.labels.printAll",{n:0})]}),!e&&a.jsx(q,{text:t("depot.labels.help"),label:t("depot.labels.title")})]}),p.length>0&&a.jsxs("div",{className:"pxl-warn",children:[a.jsx(v,{name:"clock"}),a.jsx("span",{className:"pxl-wt",children:t("depot.labels.waitingN",{count:p.length})}),a.jsxs("button",{type:"button",className:"btn small",disabled:s.busy,onClick:()=>s.send(p.map(g=>g.id)),children:[a.jsx(v,{name:"send"})," ",t("depot.labels.sendAll")]})]}),k>0&&a.jsx("span",{className:"pxl-none",children:t("depot.labels.noneN",{count:k})}),i.modal]})}function he({o:e,phone:t}){const{t:n}=S(),o=L(),s=W(),i=R();if(!o)return null;const l=z(e,o),r=t?"pxl-act":"btn small";return l.ok?a.jsxs(a.Fragment,{children:[a.jsxs("button",{type:"button",className:r,disabled:i.busy,onClick:c=>(c.stopPropagation(),i.printOne(e)),children:[a.jsx(v,{name:"printer"})," ",N(e,o)==="company"?n("depot.labels.oneOf",{name:e.companyName??""}):n("depot.labels.one")]}),i.modal]}):l.why==="waiting"?a.jsxs("button",{type:"button",className:`${r} pxl-send`,disabled:s.busy,onClick:c=>(c.stopPropagation(),s.send([e.id])),children:[a.jsx(v,{name:"send"})," ",n("depot.labels.sendTo",{name:e.companyName??""})]}):a.jsx("span",{className:"muted small",children:n("depot.labels.noCompany")})}function ue({ids:e}){const{t}=S(),n=R(),[o,s]=j.useState(!1);return a.jsxs(a.Fragment,{children:[a.jsxs("button",{type:"button",className:"btn small",disabled:!n.ready||o||n.busy,onClick:async()=>{s(!0);try{const i=await I("orders.list",{ids:e,page:1,pageSize:Math.min(3e3,e.length),tickets:"include"});await n.print(i.rows)}catch(i){$(i.message,"bad")}finally{s(!1)}},children:[a.jsx(v,{name:"printer"})," ",t("depot.labels.printSel")]}),n.modal]})}export{ge as L,ue as P,L as a,M as b,he as c,E as l,fe as p,z as s,R as u};
