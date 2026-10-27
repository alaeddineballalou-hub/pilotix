// Landing pages: the public page of one product, as ONE small HTML file (no app bundle, no web font, no framework) so it
// opens fast on a 3G phone. The server sends it at /api/lp/<slug>; the Pilotix editor shows the very same HTML in its
// live preview. Communes load per wilaya when one is picked; images are WebP in four widths; the thumbnails load once the
// main photo has arrived (it gets the whole line first).
import { WILAYAS_AR } from './geo';
import { WILAYAS } from './index';

export interface LandingImage {
  /** main picture (480 px wide) and its srcset (480w, 720w, 960w); thumb = 160 px */
  src: string;
  srcset: string;
  thumb: string;
  w: number;
  h: number;
  /** a tiny blurred copy (data URL, a few hundred bytes), drawn at once behind the main picture until it arrives */
  lqip?: string;
}

export interface LandingView {
  slug: string;
  title: string;
  /** accent colour (#rrggbb) */
  color: string;
  price: number;
  oldPrice: number | null;
  /** simple text: "- " lines are bullets, "# " a heading, **bold**, a blank line between paragraphs */
  description: string;
  variantLabel: string;
  /** price: the variant's own price when it differs from the page's; out: sold out (shown, not orderable) */
  variants: { id: number; title: string; price?: number | null; out?: boolean }[];
  /** everything sold out: the page says so instead of taking orders */
  soldOut?: boolean;
  images: LandingImage[];
  /** home delivery price per wilaya code (missing: told at confirmation) */
  fees: Record<number, number>;
  shopName: string;
  /** Meta pixel (real pages only) and the product it reports */
  pixelId?: string;
  productId?: number;
  /** Cloudflare Turnstile's site key (real pages only, when the shop turned it on): invisible robot check */
  turnstileKey?: string;
  /** TikTok pixel code (real pages only) */
  tiktokId?: string;
  /** a « contact us on WhatsApp » button on the thank-you screen: the number (international, digits), its label, the message ({nom}, {produit}…) */
  whatsapp?: { number: string; label: string; message: string } | null;
}

/** the words of the WhatsApp message the customer can send from the thank-you screen */
export const WHATSAPP_VARS = ['nom', 'produit', 'quantite', 'total', 'telephone', 'wilaya', 'commune'] as const;
export const WHATSAPP_DEFAULT = {
  label: 'تواصل معنا على واتساب',
  message: 'السلام عليكم، أنا {nom}. طلبت {produit} (الكمية {quantite}) بمبلغ {total}. رقمي {telephone}، {wilaya} - {commune}.',
};
/** a WhatsApp number as wa.me wants it: international digits (0661… → 213661…) */
export function whatsappNumber(raw: string): string {
  let d = String(raw ?? '').replace(/\D/g, '').replace(/^00/, '');
  if (/^0[567]\d{8}$/.test(d)) d = `213${d.slice(1)}`;
  return /^\d{10,15}$/.test(d) ? d : '';
}

export interface LandingRender {
  /**
   * live: the real page (fetch to `post` and `geo`).
   * parent: inside Pilotix (demo), the page asks the window around it for communes and sends the order to it.
   * preview: the editor's preview; communes from the window around it, the order is not sent (thank-you screen only).
   */
  mode: 'live' | 'parent' | 'preview';
  post: string;
  geo: string;
  /** signed challenge for the proof-of-work, and its difficulty in bits */
  challenge: string;
  bits: number;
  /** where the page saves what the customer typed (abandoned orders); empty: not saved */
  lead?: string;
  /** this page view: the browser pixel's events and the server's carry the same id (Meta counts them once) */
  viewId?: string;
  /** the page's public address (site/<store>/<page>): its canonical address for search engines and shared links */
  url?: string;
  /** opened from a group page: a « back to all the products » bar at the top, to that group */
  group?: { slug: string; title: string };
}

/** TikTok's pixel loader (its official snippet, the script itself loaded later by the page) */
const TT_STUB = `!function(w,t){w.TiktokAnalyticsObject=t;var q=w[t]=w[t]||[];q.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie','holdConsent','revokeConsent','grantConsent'];q.setAndDefer=function(a,e){a[e]=function(){a.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<q.methods.length;i++)q.setAndDefer(q,q.methods[i]);q.instance=function(a){for(var e=q._i[a]||[],n=0;n<q.methods.length;n++)q.setAndDefer(e,q.methods[n]);return e};q.load=function(e,n){var r='https://analytics.tiktok.com/i18n/pixel/events.js';q._i=q._i||{};q._i[e]=[];q._i[e]._u=r;q._t=q._t||{};q._t[e]=+new Date;q._o=q._o||{};q._o[e]=n||{};var s=document.createElement('script');s.async=!0;s.src=r+'?sdkid='+e+'&lib='+t;var f=document.getElementsByTagName('script')[0];f.parentNode.insertBefore(s,f)}}(window,'ttq');`;

const META_PIXEL = /^\d{5,20}$/;
const TIKTOK_PIXEL = /^[A-Z0-9]{10,30}$/;
/** a page's pixel field: one id, or several separated by commas (a page that sends to several pixels) */
const pixelIds = (v: string | undefined, re: RegExp) => [...new Set(String(v ?? '').split(',').map((x) => x.trim()).filter((x) => re.test(x)))].slice(0, 10);

export const LANDING_DEFAULT_COLOR = '#0f766e';
export const LANDING_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#111827'];

/** a slug from a product name: lower case latin letters, digits and dashes */
export function landingSlug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'produit'
  );
}

export const isHexColor = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** mixes a colour with white (t > 0) or black (t < 0) */
function shade(hex: string, t: number): string {
  const c = isHexColor(hex) ? hex : LANDING_DEFAULT_COLOR;
  const n = parseInt(c.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t)));
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** The description as safe HTML: escaped first, then bullets, headings, bold and paragraphs. */
export function landingDescriptionHtml(text: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const out: string[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    let list: string[] = [];
    let para: string[] = [];
    const flush = () => {
      if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
      if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
      list = [];
      para = [];
    };
    for (const raw of lines) {
      const l = raw.trim();
      const h = l.match(/^#+\s+(.*)$/);
      const b = l.match(/^(?:[-•*·✓✔]|✅)\s*(.*)$/);
      if (h) {
        flush();
        out.push(`<h3>${inline(h[1])}</h3>`);
      } else if (b) {
        if (para.length) flush();
        list.push(inline(b[1]));
      } else {
        if (list.length) flush();
        para.push(inline(l));
      }
    }
    flush();
  }
  return out.join('');
}

export const landingPrice = (v: number) => `${Math.round(v)}.00 دج`;

const CSS = (c: string) => `:root{--c:${c};--cd:${shade(c, -0.25)};--cl:${shade(c, 0.9)};--b:#e5e7eb;--t:#111827;--m:#6b7280}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;color:var(--t);background:#f6f7f9}
.top{background:var(--c);color:#fff;text-align:center;padding:8px 12px;font-weight:600;font-size:14px}
.w{max-width:1080px;margin:0 auto;padding:12px}body{overflow-x:hidden}
.g{display:grid;gap:16px}@media(min-width:860px){.g{grid-template-columns:1fr 1fr;align-items:start}.gal{position:sticky;top:12px}}
.card{background:#fff;border:1px solid var(--b);border-radius:14px;padding:14px}
.main{display:block;width:100%;height:auto;aspect-ratio:var(--r,1);object-fit:cover;border-radius:10px;background:var(--cl) center/cover no-repeat}
.th{display:flex;gap:8px;margin-top:8px;overflow-x:auto;padding-bottom:2px}.th button{flex:0 0 auto;padding:0;border:2px solid transparent;border-radius:8px;background:none;cursor:pointer;line-height:0}
.th button.on{border-color:var(--c)}.th img{width:64px;height:64px;object-fit:cover;border-radius:6px;background:var(--cl)}
h1{font-size:22px;line-height:1.3;margin:0 0 4px}.pr{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;flex-wrap:wrap}
.pr b{color:var(--c);font-size:26px}.pr s{color:var(--m);font-size:16px}.pr.no s,.pr.no .off{display:none}.off{background:#fee2e2;color:#b91c1c;border-radius:99px;padding:1px 8px;font-size:13px;font-weight:700}
label{display:block;font-size:14px;font-weight:600;margin:10px 0 4px}
input,select{width:100%;font:inherit;padding:11px 12px;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:inherit;min-height:46px}
input:focus,select:focus{outline:2px solid var(--c);outline-offset:-1px;border-color:var(--c)}
.r2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ltr{direction:ltr;text-align:right}
.q{display:flex;align-items:center;gap:8px}.q button{width:46px;height:46px;border:1px solid #d1d5db;border-radius:10px;background:#fff;font-size:22px;cursor:pointer;color:var(--t)}.q input{text-align:center;width:70px;flex:0 0 70px}
.e{color:#dc2626;font-size:13px;min-height:0;margin-top:3px}.e:empty{display:none}.bad{border-color:#dc2626}
.sum{background:var(--cl);border-radius:10px;padding:10px 12px;margin-top:14px;font-size:15px}.sum div{display:flex;justify-content:space-between;gap:8px}.sum .tt{font-weight:800;font-size:17px;border-top:1px dashed #cbd5e1;margin-top:6px;padding-top:6px}
.go{display:block;width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:var(--c);color:#fff;font:inherit;font-size:19px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px ${shade(c, 0.55)}}
.go:active{background:var(--cd)}.go[disabled]{opacity:.7}
.hp{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;opacity:0;pointer-events:none}
.d{margin-top:16px}.d h2{font-size:18px;margin:0 0 6px}.d h3{font-size:17px;margin:12px 0 4px}.d ul{padding-inline-start:20px;margin:6px 0}.d li{margin:3px 0}.d p{margin:6px 0}
.ok{text-align:center;padding:26px 10px}.ok i{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--c);color:#fff;font-size:34px;font-style:normal}
.ok h2{margin:12px 0 6px}.ok p{color:var(--m);margin:4px 0}.ok .sum{text-align:start}
.trust{display:flex;justify-content:center;gap:14px;flex-wrap:wrap;color:var(--m);font-size:13px;margin-top:10px}
.so{margin-top:12px;padding:18px;border-radius:12px;background:#f3f4f6;text-align:center}.so b{display:block;font-size:19px;color:#b91c1c}.so p{margin:6px 0 0;color:var(--m)}
footer{text-align:center;color:var(--m);font-size:12px;padding:18px}
.wa{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:14px;padding:13px;border-radius:12px;background:#25d366;color:#fff;font-weight:800;font-size:17px;text-decoration:none}.wa:active{background:#1da851}
.bk{display:block;background:#fff;border-bottom:1px solid var(--b);padding:10px 14px;font-weight:700;color:var(--c);text-decoration:none;font-size:15px}`;

// The page's script, kept small and old-browser friendly (no build step on the page itself). Meta's pixel (~94 KB)
// loads after the page: 2.5 s after it, or at the first touch — but never before the photos (a touch while they load
// waits for them: on 2G / 3G the pixel would otherwise share the line with the main photo).
const JS = `(function(){var C=window.__LP,d=document,$=function(i){return d.getElementById(i)};
function ar2(s){return String(s||'').replace(/[\\u0660-\\u0669]/g,function(c){return c.charCodeAt(0)-1632}).replace(/[\\u06f0-\\u06f9]/g,function(c){return c.charCodeAt(0)-1776})}
function nph(v){var p=ar2(v).replace(/[^\\d+]/g,'').replace(/^(\\+|00)213/,'0');return /^[567]\\d{8}$/.test(p)?'0'+p:p}
var utm={};try{utm=JSON.parse(sessionStorage.getItem('pxu')||'{}')}catch(e){}
location.search.slice(1).split('&').forEach(function(kv){var p=kv.split('='),k=p.shift(),v=p.join('=').replace(/\\+/g,' ');if(!/^(utm_\\w+|fbclid|ttclid|gclid|ad_id|adset_id|campaign_id|placement|g)$/.test(k)||!v)return;try{v=decodeURIComponent(v)}catch(e){}utm[k]=v.slice(0,500)});try{sessionStorage.setItem('pxu',JSON.stringify(utm))}catch(e){}
function ck(n){try{var m=d.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?m[1]:''}catch(e){return''}}
var px=C.px,ic=0;if(px){var n=window.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!window._fbq)window._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];
(C.pxs&&C.pxs.length?C.pxs:[px]).forEach(function(i){fbq('init',i)});fbq('track','PageView');fbq('track','ViewContent',{content_ids:[String(C.pid)],content_type:'product',value:C.price,currency:'DZD'},{eventID:'vc-'+C.vid});
var lp=0,ld=0,lw=0,lpx=function(){if(lp)return;if(!ld){lw=1;return}lp=1;var t=d.createElement('script');t.async=1;t.src='https://connect.facebook.net/en_US/fbevents.js';d.head.appendChild(t)};
window.addEventListener('load',function(){ld=1;if(lw)lpx();else setTimeout(lpx,2500)});['touchstart','scroll','keydown','mousemove'].forEach(function(e){window.addEventListener(e,lpx,{once:true,passive:true})})}
var tic=0;if(C.tt){${TT_STUB}var tl=0,tlx=function(){if(tl)return;tl=1;(C.tts&&C.tts.length?C.tts:[C.tt]).forEach(function(i){ttq.load(i)});ttq.page();ttq.track('ViewContent',{contents:[{content_id:String(C.pid),content_type:'product',content_name:C.title}],value:C.price,currency:'DZD'},{event_id:'vc-'+C.vid})};
window.addEventListener('load',function(){setTimeout(tlx,2500)});['touchstart','scroll','keydown','mousemove'].forEach(function(e){window.addEventListener(e,tlx,{once:true,passive:true})})}
var bk=$('bk');if(bk){if(C.mode=='live'){var bq=location.search.replace(/([?&])g=[^&]*&?/,'$1').replace(/[?&]$/,'');bk.href=bk.getAttribute('href')+bq}else bk.onclick=function(e){e.preventDefault();parent.postMessage({lp:'nav',slug:C.g},'*')}}
var th=d.querySelectorAll('.th button'),mi=$('mi');for(var i=0;i<th.length;i++)th[i].onclick=function(){for(var j=0;j<th.length;j++)th[j].className='';this.className='on';mi.src=this.getAttribute('data-s');mi.srcset=this.getAttribute('data-ss')};
function tl(){var a=d.querySelectorAll('.th img[data-src]');for(var i=0;i<a.length;i++){a[i].src=a[i].getAttribute('data-src');a[i].removeAttribute('data-src')}}
if(mi&&mi.tagName=='IMG'&&!mi.complete){mi.addEventListener('load',tl);mi.addEventListener('error',tl);setTimeout(tl,10000)}else tl();
var f=$('f');if(!f)return;
var K=[],H0=[];(function(){var n=2,c=0;function f(x){return(x-Math.floor(x))*4294967296|0}while(c<64){for(var i=2;i*i<=n;i++)if(n%i==0)break;if(i*i>n){if(c<8)H0[c]=f(Math.pow(n,1/2));K[c++]=f(Math.pow(n,1/3))}n++}})();
function sha(s){var m=unescape(encodeURIComponent(s)),l=m.length,w=[],h=H0.slice(),i,j;for(i=0;i<l;i++)w[i>>2]|=m.charCodeAt(i)<<(24-i%4*8);w[l>>2]|=128<<(24-l%4*8);var n=((l+8)>>6)+1<<4;for(i=0;i<n;i++)w[i]|=0;w[n-1]=l*8;
for(j=0;j<n;j+=16){var W=w.slice(j,j+16),a=h[0],b=h[1],c=h[2],e=h[4],f=h[5],g=h[6],k=h[7],dd=h[3];for(i=0;i<64;i++){if(i>15){var x=W[i-15],y=W[i-2];W[i]=(W[i-16]+((x>>>7|x<<25)^(x>>>18|x<<14)^x>>>3)+W[i-7]+((y>>>17|y<<15)^(y>>>19|y<<13)^y>>>10))|0}
var t1=k+((e>>>6|e<<26)^(e>>>11|e<<21)^(e>>>25|e<<7))+(e&f^~e&g)+K[i]+(W[i]|0),t2=((a>>>2|a<<30)^(a>>>13|a<<19)^(a>>>22|a<<10))+(a&b^a&c^b&c);k=g;g=f;f=e;e=dd+t1|0;dd=c;c=b;b=a;a=t1+t2|0}
h[0]=h[0]+a|0;h[1]=h[1]+b|0;h[2]=h[2]+c|0;h[3]=h[3]+dd|0;h[4]=h[4]+e|0;h[5]=h[5]+f|0;h[6]=h[6]+g|0;h[7]=h[7]+k|0}
var o='';for(i=0;i<8;i++)o+=('0000000'+(h[i]>>>0).toString(16)).slice(-8);return o}
function zb(x){var n=0;for(var i=0;i<x.length;i++){var v=parseInt(x[i],16);if(!v){n+=4;continue}return n+(v<2?3:v<4?2:v<8?1:0)}return n}
var t0=Date.now(),ki=0,nonce=null,N=0;function pow(){for(var i=0;i<400;i++){if(zb(sha(C.ch+':'+N))>=C.bits){nonce=String(N);return}N++}setTimeout(pow,0)}setTimeout(pow,300);
var did='';try{did=localStorage.getItem('pxd')||'';if(!did){did=sha(Math.random()+':'+t0).slice(0,16);localStorage.setItem('pxd',did)}}catch(e){}
var nv=navigator,sc=screen||{},fp=sha([nv.userAgent,nv.language,sc.width+'x'+sc.height+'x'+sc.colorDepth,new Date().getTimezoneOffset(),(window.Intl&&Intl.DateTimeFormat().resolvedOptions().timeZone)||'',nv.hardwareConcurrency,nv.deviceMemory,nv.platform,nv.maxTouchPoints].join('|')).slice(0,24);
var sy=0,ps=false,tt='',de=d.documentElement;window.addEventListener('scroll',function(){var m=(de.scrollHeight-de.clientHeight)||1,v=Math.round(100*(window.pageYOffset||de.scrollTop)/m);if(v>sy)sy=Math.min(100,v)},{passive:true});
if(C.ts){var tsl=function(){if(window.turnstile){var z=d.createElement('div');z.style.marginTop='10px';f.appendChild(z);try{turnstile.render(z,{sitekey:C.ts,appearance:'interaction-only',callback:function(k){tt=k},'expired-callback':function(){tt=''}})}catch(e){}}};
window.__pxts=tsl;var tl2=function(){var t=d.createElement('script');t.async=1;t.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__pxts';d.head.appendChild(t)};if(d.readyState=='complete')setTimeout(tl2,1500);else window.addEventListener('load',function(){setTimeout(tl2,1500)})}
var cb={},seq=0;window.addEventListener('message',function(e){var m=e.data;if(m&&m.lp&&cb[m.id]){cb[m.id](m.r);delete cb[m.id]}});
function ask(kind,body,done,beacon){if(C.mode=='live'){var u=kind=='geo'?C.geo+body:kind=='lead'?C.lead:C.post;
if(beacon){var bd=JSON.stringify(body);try{if(nv.sendBeacon&&nv.sendBeacon(u,new Blob([bd],{type:'text/plain'})))return;if(window.fetch){fetch(u,{method:'POST',body:bd,keepalive:true,headers:{'Content-Type':'text/plain'}});return}}catch(e){}}
var x=new XMLHttpRequest();x.open(kind=='geo'?'GET':'POST',u);x.setRequestHeader('Content-Type','application/json');x.timeout=30000;
x.onload=function(){var r=null;try{r=JSON.parse(x.responseText)}catch(e){}done(x.status<300?r:null,x.status)};x.onerror=x.ontimeout=function(){done(null,0)};x.send(kind=='geo'?null:JSON.stringify(body));return}
if(C.mode=='preview'&&kind!='geo')return kind=='order'&&setTimeout(function(){done({ok:true},200)},400);var id=++seq;cb[id]=function(r){done(r,r?200:0)};parent.postMessage({lp:kind,id:id,body:body,slug:C.slug},'*')}
var w=$('w'),cm=$('cm'),qt=$('qt'),vr=$('vr');
function money(v){return Math.round(v)+'.00 \\u062f\\u062c'}
function qv(){return Math.max(1,Math.min(99,parseInt(ar2(qt.value))||1))}
function unit(){var p=vr&&C.vp[vr.value];return p!=null?p:C.price}
function sum(){var q=qv(),fee=C.fees[w.value],s=unit()*q,pr=d.querySelector('.pr');$('pp').textContent=money(unit());if(C.op&&pr)pr.className=unit()<C.op?'pr':'pr no';$('s1').textContent=money(s);
$('s2').textContent=!w.value?'\\u0627\\u062e\\u062a\\u0631 \\u0627\\u0644\\u0648\\u0644\\u0627\\u064a\\u0629':fee==null?'\\u064a\\u062d\\u062f\\u062f \\u0639\\u0646\\u062f \\u0627\\u0644\\u062a\\u0623\\u0643\\u064a\\u062f':fee?money(fee):'\\u0645\\u062c\\u0627\\u0646\\u064a';$('s3').textContent=money(s+(fee||0))}
w.onchange=function(){cm.innerHTML='<option value="">\\u2026</option>';cm.disabled=true;sum();if(!w.value)return;var v=w.value;ask('geo',v,function(r){if(w.value!=v)return;var h='<option value="">\\u0627\\u062e\\u062a\\u0631 \\u0627\\u0644\\u0628\\u0644\\u062f\\u064a\\u0629</option>';
(r||[]).forEach(function(c){h+='<option value="'+c[0].replace(/"/g,'&quot;')+'">'+(c[1]||c[0])+'</option>'});cm.innerHTML=h;cm.disabled=false})};
if(vr)vr.onchange=sum;
$('qm').onclick=function(){qt.value=Math.max(1,qv()-1);sum();lead()};$('qp').onclick=function(){qt.value=Math.min(99,qv()+1);sum();lead()};qt.oninput=sum;
var done=0,lt=null,last='';
function form(){return{name:f.nm.value.trim(),phone:nph(f.ph.value),wilaya:+w.value||0,commune:cm.value,variant:vr?+vr.value||null:null,qty:qv(),hp:f.web.value,ch:C.ch,fp:fp,did:did,vid:C.vid,utm:utm,fbp:ck('_fbp'),fbc:ck('_fbc'),ttp:ck('_ttp'),url:C.mode=='live'?location.href.slice(0,500):''}}
function lead(now){if(!C.lead||done||busy)return;var b=form();if(!/^0[567]\\d{8}$/.test(b.phone))return;var k=JSON.stringify([b.name,b.phone,b.wilaya,b.commune,b.variant,b.qty]);if(k==last)return;clearTimeout(lt);lt=null;
var go=function(){lt=null;last=k;if(px&&!ic){ic=1;fbq('track','InitiateCheckout',{content_ids:[String(C.pid)],content_type:'product',value:unit()*b.qty,currency:'DZD',num_items:b.qty},{eventID:'ic-'+C.vid})}if(C.tt&&!tic){tic=1;ttq.track('InitiateCheckout',{contents:[{content_id:String(C.pid),content_type:'product',quantity:b.qty}],value:unit()*b.qty,currency:'DZD'},{event_id:'ic-'+C.vid})}ask('lead',b,function(){},now)};if(now)go();else lt=setTimeout(go,1500)}
f.addEventListener('input',function(e){if(e.isTrusted!==false)ki++;lead()});f.ph.addEventListener('paste',function(){ps=true});f.addEventListener('change',function(){lead()});
function flush(){if(lt){clearTimeout(lt);lt=null;last='';lead(1)}}window.addEventListener('pagehide',flush);d.addEventListener('visibilitychange',function(){if(d.visibilityState=='hidden')flush()});
function fk(p){var x=p.slice(2);return/(\\d)\\1{5,}/.test(x)||'0123456789012345'.indexOf(x.slice(0,7))>=0||'9876543210987654'.indexOf(x.slice(0,7))>=0}
function err(id,msg){var el=$(id),e=$(id+'e');if(e)e.textContent=msg||'';if(el)el.className=msg?'bad':'';return!msg}
var busy=false;f.onsubmit=function(ev){ev.preventDefault();if(busy)return;var nm=f.nm.value.trim(),ph=nph(f.ph.value);
var ok=err('nm',nm.length<3?'\\u0623\\u062f\\u062e\\u0644 \\u0627\\u0633\\u0645\\u0643 \\u0627\\u0644\\u0643\\u0627\\u0645\\u0644':'');
ok=err('ph',/^0[567]\\d{8}$/.test(ph)&&!fk(ph)?'':fk(ph)?'\\u0623\\u062f\\u062e\\u0644 \\u0631\\u0642\\u0645\\u0643 \\u0627\\u0644\\u062d\\u0642\\u064a\\u0642\\u064a':'\\u0631\\u0642\\u0645 \\u0627\\u0644\\u0647\\u0627\\u062a\\u0641 \\u063a\\u064a\\u0631 \\u0635\\u062d\\u064a\\u062d (\\u0645\\u062b\\u0627\\u0644: 0555123456)')&&ok;
ok=err('w',w.value?'':'\\u0627\\u062e\\u062a\\u0631 \\u0627\\u0644\\u0648\\u0644\\u0627\\u064a\\u0629')&&ok;ok=err('cm',cm.value?'':'\\u0627\\u062e\\u062a\\u0631 \\u0627\\u0644\\u0628\\u0644\\u062f\\u064a\\u0629')&&ok;
if(vr)ok=err('vr',vr.value?'':'\\u0627\\u062e\\u062a\\u0631 '+C.vl)&&ok;if(!ok)return;busy=true;clearTimeout(lt);lt=null;var btn=$('go');btn.disabled=true;btn.textContent='\\u2026';
var q=qv(),wait=Date.now();
(function send(){if(nonce===null&&Date.now()-wait<4000)return setTimeout(send,150);var b=form();b.name=nm;b.phone=ph;b.ch=C.ch;b.pw=nonce;b.t=Date.now()-t0;b.ki=ki;b.wd=!!nv.webdriver;b.sc=de.scrollHeight-de.clientHeight<200?50:sy;b.ps=ps;b.mt=nv.maxTouchPoints==null?null:nv.maxTouchPoints;b.tt=tt;b.tk=C.ts;try{b.tz=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}
ask('order',b,function(r,st){
if(!r||!r.ok){busy=false;btn.disabled=false;btn.textContent=C.cta;$('fe').textContent='\\u062a\\u0639\\u0630\\u0631 \\u0627\\u0644\\u0625\\u0631\\u0633\\u0627\\u0644\\u060c \\u062a\\u062d\\u0642\\u0642 \\u0645\\u0646 \\u0627\\u0644\\u0627\\u062a\\u0635\\u0627\\u0644 \\u0648\\u0623\\u0639\\u062f \\u0627\\u0644\\u0645\\u062d\\u0627\\u0648\\u0644\\u0629';return}
done=1;var fee=C.fees[w.value];$('okn').textContent=nm;$('o1').textContent=C.title+(vr?' \\u2014 '+vr.options[vr.selectedIndex].text:'')+' \\u00d7 '+q;$('o2').textContent=money(unit()*q+(fee||0));
var wa=$('wa');if(wa&&C.wa){var V={nom:nm,produit:C.title+(vr?' \\u2014 '+vr.options[vr.selectedIndex].text:''),quantite:q,total:money(unit()*q+(fee||0)),telephone:nph(f.ph.value),wilaya:w.value?w.options[w.selectedIndex].text.replace(/^\\d+\\s*-\\s*/,''):'',commune:cm.value?cm.options[cm.selectedIndex].text:''};wa.href='https://wa.me/'+C.wa.n+'?text='+encodeURIComponent(C.wa.m.replace(/\\{(\\w+)\\}/g,function(x,k){return V[k]!=null?V[k]:x}))}
f.style.display='none';$('ok').style.display='block';window.scrollTo(0,0)})})()};sum()})();`;

/**
 * what the main photo's srcset is chosen for: its real width. On a computer, half of the 1080 px page minus the card's
 * padding and border (490 px); on a phone, the screen minus the page's and the card's padding and border (54 px).
 */
export const LANDING_SIZES = '(min-width:860px) 490px, calc(100vw - 54px)';

/**
 * The HTTP `Link` header that lets the phone ask for the main photo as soon as the answer's headers arrive, before the
 * page itself (with the very srcset / sizes the page uses: one download). Behind Cloudflare it also becomes an Early
 * Hint. Null when the photo is inside the page (data URL) or has an address that cannot go in a header.
 */
export function landingPreloadLink(v: LandingView): string | null {
  const img = v.images[0];
  if (!img || /^data:/.test(img.src) || /[<>"\r\n]/.test(img.src + img.srcset)) return null;
  return `<${img.src}>; rel=preload; as=image; fetchpriority=high; imagesrcset="${img.srcset}"; imagesizes="${LANDING_SIZES}"`;
}

/** The search and share snippet: the start of the description (no markup), else the title, the price and the delivery. */
export function landingMetaDescription(v: Pick<LandingView, 'title' | 'price' | 'description'>): string {
  const plain = String(v.description ?? '')
    .replace(/^\s*(#+|-)\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = plain || `${v.title} — ${landingPrice(v.price)}. التوصيل لجميع الولايات والدفع عند الاستلام.`;
  return text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, '')}…` : text;
}

/** The whole public page. */
export function renderLanding(v: LandingView, r: LandingRender): string {
  const c = isHexColor(v.color) ? v.color : LANDING_DEFAULT_COLOR;
  const img = v.images[0];
  const ratio = img ? `${img.w}/${img.h}` : '1';
  const sizes = LANDING_SIZES;
  const gallery = img
    ? `<img id="mi" class="main" style="--r:${ratio}${img.lqip && /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img.lqip) ? `;background-image:url(${img.lqip})` : ''}" src="${esc(img.src)}" srcset="${esc(img.srcset)}" sizes="${sizes}" width="${img.w}" height="${img.h}" alt="${esc(v.title)}" fetchpriority="high" decoding="async">` +
      (v.images.length > 1
        ? `<div class="th">${v.images
            .map((x, k) => `<button type="button" class="${k ? '' : 'on'}" data-s="${esc(x.src)}" data-ss="${esc(x.srcset)}" aria-label="${k + 1}"><img data-src="${esc(x.thumb)}" width="64" height="64" alt="" decoding="async"></button>`)
            .join('')}</div>`
        : '')
    : `<div class="main" style="--r:1"></div>`;
  const wil = Object.keys(WILAYAS_AR)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => `<option value="${k}">${String(k).padStart(2, '0')} - ${esc(WILAYAS_AR[k] ?? WILAYAS[k - 1])}</option>`)
    .join('');
  const variants = v.variants.length
    ? `<label for="vr">${esc(v.variantLabel)}</label><select id="vr" name="vr"><option value="">${esc(v.variantLabel)}…</option>${v.variants
        .map((x) => `<option value="${x.id}"${x.out ? ' disabled' : ''}>${esc(x.title)}${x.out ? ' — نفذت الكمية' : x.price != null ? ` — ${landingPrice(x.price)}` : ''}</option>`)
        .join('')}</select><div class="e" id="vre"></div>`
    : '';
  const off = v.oldPrice && v.oldPrice > v.price ? Math.round((1 - v.price / v.oldPrice) * 100) : 0;
  const cta = 'اطلب الآن';
  const vp: Record<number, number> = {};
  for (const x of v.variants) if (x.price != null) vp[x.id] = x.price;
  const cfg = {
    mode: r.mode, post: r.post, geo: r.geo, lead: r.lead ?? '', ch: r.challenge, bits: r.bits, slug: v.slug, price: v.price, vp, fees: v.fees, title: v.title, vl: v.variantLabel, cta,
    vid: r.viewId ?? '', px: r.mode === 'live' ? pixelIds(v.pixelId, META_PIXEL)[0] ?? '' : '', pxs: r.mode === 'live' ? pixelIds(v.pixelId, META_PIXEL) : [], pid: v.productId ?? 0, op: off ? v.oldPrice : 0,
    g: r.group?.slug ?? '',
    wa: v.whatsapp && whatsappNumber(v.whatsapp.number) ? { n: whatsappNumber(v.whatsapp.number), m: v.whatsapp.message || WHATSAPP_DEFAULT.message } : null,
    tt: r.mode === 'live' ? pixelIds(v.tiktokId, TIKTOK_PIXEL)[0] ?? '' : '',
    tts: r.mode === 'live' ? pixelIds(v.tiktokId, TIKTOK_PIXEL) : [],
    ts: r.mode === 'live' && v.turnstileKey && /^[0-9A-Za-z_-]{10,100}$/.test(v.turnstileKey) ? v.turnstileKey : '',
  };
  const desc = landingDescriptionHtml(v.description);
  // search engines and shared links (Facebook, WhatsApp): the real page only, at its own address (site/<store>/<page>; else the order address minus /order)
  const meta = esc(landingMetaDescription(v));
  const url = r.mode !== 'live' ? '' : r.url && /^https?:\/\/[^\s"<>]+$/.test(r.url) ? r.url : /^https?:\/\/[^\s"<>]+\/order$/.test(r.post) ? r.post.slice(0, -'/order'.length) : '';
  const head =
    `<meta name="description" content="${meta}">` +
    (r.mode === 'live'
      ? (url ? `<link rel="canonical" href="${esc(url)}"><meta property="og:url" content="${esc(url)}">` : '') +
        `<meta property="og:type" content="product"><meta property="og:title" content="${esc(v.title)}"><meta property="og:description" content="${meta}"><meta property="og:locale" content="ar_DZ">` +
        (v.shopName ? `<meta property="og:site_name" content="${esc(v.shopName)}">` : '') +
        (img && /^https?:\/\//.test(img.src) ? `<meta property="og:image" content="${esc(img.src)}"><meta name="twitter:card" content="summary_large_image">` : '')
      : '<meta name="robots" content="noindex">');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.title)}</title>
${head}<meta name="theme-color" content="${c}">${img ? `<link rel="preload" as="image" href="${esc(img.src)}" imagesrcset="${esc(img.srcset)}" imagesizes="${sizes}">` : ''}<style>${CSS(c)}</style></head><body>
<div class="top">🚚 التوصيل لجميع الولايات · الدفع عند الاستلام</div>${r.group ? `<a class="bk" id="bk" href="${esc(r.group.slug)}">→ ${esc(GROUP_BACK)}</a>` : ''}<main class="w"><div class="g">
<section class="gal card">${gallery}</section>
<section class="card">${v.soldOut ? `<h1>${esc(v.title)}</h1><div class="so"><b>نفذت الكمية مؤقتاً</b><p>هذا المنتج غير متوفر حالياً، عودوا قريباً.</p></div>` : `<form id="f" novalidate autocomplete="on"><h1>${esc(v.title)}</h1><div class="pr"><b id="pp">${landingPrice(v.price)}</b>${off ? `<s>${landingPrice(v.oldPrice!)}</s><span class="off" dir="ltr">-${off}%</span>` : ''}</div>
<label for="nm">الاسم الكامل</label><input id="nm" name="nm" autocomplete="name" maxlength="80" placeholder="الاسم واللقب"><div class="e" id="nme"></div>
<label for="ph">رقم الهاتف</label><input id="ph" name="ph" class="ltr" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="05XX XX XX XX"><div class="e" id="phe"></div>
<div class="r2"><div><label for="w">الولاية</label><select id="w" name="w"><option value="">اختر الولاية</option>${wil}</select><div class="e" id="we"></div></div>
<div><label for="cm">البلدية</label><select id="cm" name="cm" disabled><option value="">اختر الولاية أولاً</option></select><div class="e" id="cme"></div></div></div>
${variants}<label for="qt">الكمية</label><div class="q"><button type="button" id="qm" aria-label="-">−</button><input id="qt" name="qt" inputmode="numeric" value="1" maxlength="2"><button type="button" id="qp" aria-label="+">+</button></div>
<div class="hp" aria-hidden="true"><label for="web">Website</label><input id="web" name="web" tabindex="-1" autocomplete="off"></div>
<div class="sum"><div><span>سعر المنتج</span><b id="s1"></b></div><div><span>التوصيل</span><b id="s2"></b></div><div class="tt"><span>المجموع</span><b id="s3"></b></div></div>
<button class="go" id="go">${cta}</button><div class="e" id="fe" role="alert"></div><div class="trust"><span>✔ الدفع عند الاستلام</span><span>✔ معاينة المنتج قبل الدفع</span></div></form>
<div id="ok" class="ok" style="display:none" role="status"><i>✓</i><h2>شكراً <span id="okn"></span>!</h2><p>تم استلام طلبك بنجاح.</p><p>سيتصل بك فريقنا قريباً لتأكيد الطلب.</p>
<div class="sum"><div><span id="o1"></span></div><div class="tt"><span>المجموع</span><b id="o2"></b></div></div>${
  v.whatsapp && whatsappNumber(v.whatsapp.number)
    ? `<a id="wa" class="wa" href="https://wa.me/${whatsappNumber(v.whatsapp.number)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>${esc(v.whatsapp.label || WHATSAPP_DEFAULT.label)}</a>`
    : ''
}</div>`}</section></div>
${desc ? `<section class="card d"><h2>وصف المنتج</h2>${desc}</section>` : ''}</main><footer>${esc(v.shopName)}</footer>
<script>window.__LP=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script><script>${JS}</script></body></html>`;
}

// ---------------------------------------------------------------- group pages: several products on one page
// The customer picks a product; it opens that product's own landing page (the same page, the same order form), which
// shows a « back to all the products » bar at the top. Five looks: grid, big cards, best seller + grid, fast list,
// tabs + search. The ad's tracking (utm, fbclid) follows the customer to the product page.

export const GROUP_THEMES = ['grid', 'big', 'best', 'list', 'tabs'] as const;
export type GroupTheme = (typeof GROUP_THEMES)[number];
export const GROUP_BACK = 'رجوع إلى كل المنتجات';

export interface GroupItem {
  slug: string;
  title: string;
  price: number;
  oldPrice: number | null;
  image: LandingImage | null;
  soldOut?: boolean;
  /** design « tabs »: the tab it is in (empty: only in « all ») */
  tab?: string;
  /** a short line under the name (designs « big » and « best ») */
  note?: string;
}

export interface GroupView {
  slug: string;
  title: string;
  subtitle: string;
  color: string;
  theme: GroupTheme;
  items: GroupItem[];
  /** design « best »: the product shown big at the top (else the first one) */
  bestSlug?: string | null;
  shopName: string;
  pixelId?: string;
  tiktokId?: string;
}

export interface GroupRender {
  mode: 'live' | 'parent' | 'preview';
  url?: string;
}

const GROUP_CSS = (c: string) => `:root{--c:${c};--cd:${shade(c, -0.25)};--cl:${shade(c, 0.9)};--b:#e5e7eb;--t:#111827;--m:#6b7280}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;color:var(--t);background:#f6f7f9;overflow-x:hidden}
.top{background:var(--c);color:#fff;text-align:center;padding:8px 12px;font-weight:600;font-size:14px}
.hd{background:#fff;border-bottom:1px solid var(--b);padding:14px 16px}.hd h1{font-size:21px;line-height:1.3;margin:0}.hd p{margin:3px 0 0;color:var(--m);font-size:14px}
.w{max-width:1080px;margin:0 auto;padding:12px}
a.it{display:block;color:inherit;text-decoration:none;background:#fff;border:1px solid var(--b);border-radius:14px;padding:8px;position:relative;-webkit-tap-highlight-color:transparent}
a.it:active{transform:scale(.985)}.it.out{opacity:.55}
.im{display:block;width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:10px;background:var(--cl)}
.it h2{font-size:15px;line-height:1.35;margin:7px 2px 2px;font-weight:700}
.pr{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin:0 2px}.pr b{color:var(--c);font-size:17px}.pr s{color:var(--m);font-size:13px}
.off{position:absolute;top:12px;right:12px;background:#dc2626;color:#fff;border-radius:99px;padding:1px 8px;font-size:12px;font-weight:800;direction:ltr}
.so{position:absolute;top:12px;left:12px;background:#111827;color:#fff;border-radius:99px;padding:1px 8px;font-size:12px;font-weight:700}
.go{display:block;margin-top:8px;border-radius:10px;background:var(--c);color:#fff;font-weight:800;padding:9px;text-align:center;font-size:15px}
.out .go{background:#9ca3af}
.g2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}@media(min-width:700px){.g2{grid-template-columns:repeat(3,1fr)}}@media(min-width:980px){.g2{grid-template-columns:repeat(4,1fr)}}
.big{display:grid;gap:12px}@media(min-width:700px){.big{grid-template-columns:repeat(2,1fr)}}.big .im{aspect-ratio:16/11}.big h2{font-size:18px}
.nt{color:var(--m);font-size:14px;margin:2px 2px 0}.row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}.row .go{margin:0;padding:9px 20px}
.hero{border:2px solid var(--c);margin-bottom:14px}.hero .im{aspect-ratio:16/10}.hero h2{font-size:19px}
.star{display:inline-block;background:#fef3c7;color:#92400e;border-radius:99px;padding:1px 10px;font-size:12px;font-weight:800;margin:8px 2px 0}
.st{font-weight:800;font-size:16px;margin:2px 2px 10px}
.ls{display:grid;gap:8px}.ls a.it{display:flex;align-items:center;gap:10px}.ls .im{width:86px;flex:0 0 86px}.ls .tx{flex:1;min-width:0}.ls h2{margin:0 0 2px}.ls .go{margin:0;padding:9px 14px;flex:0 0 auto}
.ls .off{position:static;display:inline-block}.ok{color:#16a34a;font-weight:700;font-size:12px}
.sr{display:block;width:100%;font:inherit;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:inherit;margin-bottom:10px}
.tb{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:10px}.tb button{flex:0 0 auto;border:1px solid var(--b);background:#fff;border-radius:99px;padding:6px 14px;font:inherit;font-size:14px;font-weight:700;color:var(--t);cursor:pointer}
.tb button.on{background:var(--c);color:#fff;border-color:var(--c)}.no{display:none!important}.em{text-align:center;color:var(--m);padding:20px}
.trust{display:flex;justify-content:center;gap:14px;flex-wrap:wrap;color:var(--m);font-size:13px;margin:14px 0 4px}
footer{text-align:center;color:var(--m);font-size:12px;padding:18px}`;

const GROUP_JS = `(function(){var C=window.__LG,d=document,a=d.querySelectorAll('a.it[data-s]');
var q=location.search.replace(/([?&])g=[^&]*&?/,'$1').replace(/^\\?$/,'').replace(/&$/,'');
for(var i=0;i<a.length;i++){if(C.mode=='live'){if(q)a[i].href=a[i].getAttribute('href')+'&'+q.slice(1)}else a[i].onclick=function(e){e.preventDefault();parent.postMessage({lp:'nav',slug:this.getAttribute('data-s'),g:C.g},'*')}}
var sr=d.getElementById('sr'),tb=d.querySelectorAll('.tb button'),tab='',em=d.getElementById('em');
function f(){var t=sr?sr.value.trim().toLowerCase():'',n=0;for(var i=0;i<a.length;i++){var x=a[i],ok=(!tab||x.getAttribute('data-t')==tab)&&(!t||x.getAttribute('data-n').indexOf(t)>=0);x.className=x.className.replace(/ no/g,'')+(ok?'':' no');if(ok)n++}if(em)em.className=n?'em no':'em'}
if(sr)sr.oninput=f;for(var j=0;j<tb.length;j++)tb[j].onclick=function(){for(var k=0;k<tb.length;k++)tb[k].className='';this.className='on';tab=this.getAttribute('data-t');f()};
if(C.px){var n=window.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!window._fbq)window._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];(C.pxs&&C.pxs.length?C.pxs:[C.px]).forEach(function(i){fbq('init',i)});fbq('track','PageView');
var lp=0,lx=function(){if(lp)return;lp=1;var s=d.createElement('script');s.async=1;s.src='https://connect.facebook.net/en_US/fbevents.js';d.head.appendChild(s)};
window.addEventListener('load',function(){setTimeout(lx,2500)});['touchstart','scroll'].forEach(function(e){window.addEventListener(e,lx,{once:true,passive:true})})}
if(C.tt){${TT_STUB}var tl=0,tlx=function(){if(tl)return;tl=1;(C.tts&&C.tts.length?C.tts:[C.tt]).forEach(function(i){ttq.load(i)});ttq.page()};window.addEventListener('load',function(){setTimeout(tlx,2500)});['touchstart','scroll'].forEach(function(e){window.addEventListener(e,tlx,{once:true,passive:true})})}
})()`;

export function renderGroup(v: GroupView, r: GroupRender): string {
  const c = isHexColor(v.color) ? v.color : LANDING_DEFAULT_COLOR;
  const theme: GroupTheme = (GROUP_THEMES as readonly string[]).includes(v.theme) ? v.theme : 'grid';
  // sold-out products at the end
  const items = [...v.items.filter((x) => !x.soldOut), ...v.items.filter((x) => x.soldOut)];
  let k = 0;
  const img = (x: GroupItem, size: string) => {
    const eager = k++ < 4;
    return x.image
      ? `<img class="im" src="${esc(x.image.src)}" srcset="${esc(x.image.srcset)}" sizes="${size}" width="${x.image.w}" height="${x.image.h}" alt="${esc(x.title)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`
      : `<span class="im"></span>`;
  };
  const price = (x: GroupItem) => `<div class="pr"><b>${landingPrice(x.price)}</b>${x.oldPrice && x.oldPrice > x.price ? `<s>${landingPrice(x.oldPrice)}</s>` : ''}</div>`;
  const off = (x: GroupItem) => (x.oldPrice && x.oldPrice > x.price ? `<span class="off">-${Math.round((1 - x.price / x.oldPrice) * 100)}%</span>` : '');
  const so = (x: GroupItem) => (x.soldOut ? `<span class="so">نفذت الكمية</span>` : '');
  const open = (x: GroupItem, extra = '') =>
    `<a class="it${x.soldOut ? ' out' : ''}${extra}" href="${esc(x.slug)}?g=${esc(v.slug)}" data-s="${esc(x.slug)}" data-n="${esc(x.title.toLowerCase())}" data-t="${esc(x.tab ?? '')}">`;
  const go = (x: GroupItem, label = 'اطلب الآن') => `<span class="go">${x.soldOut ? 'نفذت الكمية' : label}</span>`;
  const card = (x: GroupItem, size = '(min-width:980px) 250px, (min-width:700px) 320px, 46vw') => `${open(x)}${img(x, size)}${off(x)}${so(x)}<h2>${esc(x.title)}</h2>${price(x)}${go(x)}</a>`;
  let body = '';
  if (theme === 'grid') body = `<div class="g2">${items.map((x) => card(x)).join('')}</div>`;
  else if (theme === 'big')
    body = `<div class="big">${items
      .map((x) => `${open(x)}${img(x, '(min-width:700px) 520px, 94vw')}${off(x)}${so(x)}<h2>${esc(x.title)}</h2>${x.note ? `<p class="nt">${esc(x.note)}</p>` : ''}<div class="row">${price(x)}${go(x, 'اطلب الآن ←')}</div></a>`)
      .join('')}</div>`;
  else if (theme === 'best') {
    const best = items.find((x) => x.slug === v.bestSlug && !x.soldOut) ?? items[0];
    const rest = items.filter((x) => x !== best);
    body = best
      ? `${open(best, ' hero')}${img(best, '(min-width:1080px) 1050px, 94vw')}${off(best)}<span class="star">⭐ الأكثر طلباً</span><h2>${esc(best.title)}</h2>${best.note ? `<p class="nt">${esc(best.note)}</p>` : ''}${price(best)}${go(best)}</a>` +
        (rest.length ? `<div class="st">منتجات أخرى</div><div class="g2">${rest.map((x) => card(x)).join('')}</div>` : '')
      : '';
  } else if (theme === 'list')
    body = `<div class="ls">${items.map((x) => `${open(x)}${img(x, '86px')}<span class="tx"><h2>${esc(x.title)}</h2><span class="pr"><b>${landingPrice(x.price)}</b>${off(x)}</span>${x.soldOut ? '' : '<span class="ok">✔ متوفر</span>'}</span>${go(x, 'اطلب')}</a>`).join('')}</div>`;
  else {
    const tabs = [...new Set(items.map((x) => (x.tab ?? '').trim()).filter(Boolean))];
    body =
      `<input id="sr" class="sr" type="search" placeholder="🔍 ابحث عن منتج..." aria-label="بحث">` +
      (tabs.length ? `<div class="tb"><button type="button" class="on" data-t="">الكل</button>${tabs.map((t) => `<button type="button" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : '') +
      `<div class="g2">${items.map((x) => card(x)).join('')}</div><p id="em" class="em no">لا يوجد منتج بهذا الاسم</p>`;
  }
  if (!items.length) body = `<p class="em">لا توجد منتجات حالياً</p>`;
  const cfg = {
    mode: r.mode,
    g: v.slug,
    px: r.mode === 'live' ? pixelIds(v.pixelId, META_PIXEL)[0] ?? '' : '',
    pxs: r.mode === 'live' ? pixelIds(v.pixelId, META_PIXEL) : [],
    tt: r.mode === 'live' ? pixelIds(v.tiktokId, TIKTOK_PIXEL)[0] ?? '' : '',
    tts: r.mode === 'live' ? pixelIds(v.tiktokId, TIKTOK_PIXEL) : [],
  };
  const url = r.mode === 'live' && r.url && /^https?:\/\/[^\s"<>]+$/.test(r.url) ? r.url : '';
  const desc = esc(v.subtitle || `${v.title} · التوصيل لجميع الولايات · الدفع عند الاستلام`);
  const first = items.find((x) => x.image)?.image;
  const head =
    `<meta name="description" content="${desc}">` +
    (r.mode === 'live'
      ? (url ? `<link rel="canonical" href="${esc(url)}"><meta property="og:url" content="${esc(url)}">` : '') +
        `<meta property="og:type" content="website"><meta property="og:title" content="${esc(v.title)}"><meta property="og:description" content="${desc}"><meta property="og:locale" content="ar_DZ">` +
        (v.shopName ? `<meta property="og:site_name" content="${esc(v.shopName)}">` : '') +
        (first && /^https?:\/\//.test(first.src) ? `<meta property="og:image" content="${esc(first.src)}">` : '')
      : '<meta name="robots" content="noindex">');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.title)}</title>
${head}<meta name="theme-color" content="${c}"><style>${GROUP_CSS(c)}</style></head><body>
<div class="top">🚚 التوصيل لجميع الولايات · الدفع عند الاستلام</div><header class="hd"><h1>${esc(v.title)}</h1>${v.subtitle ? `<p>${esc(v.subtitle)}</p>` : ''}</header>
<main class="w">${body}<div class="trust"><span>✔ الدفع عند الاستلام</span><span>✔ معاينة المنتج قبل الدفع</span></div></main><footer>${esc(v.shopName)}</footer>
<script>window.__LG=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script><script>${GROUP_JS}</script></body></html>`;
}
