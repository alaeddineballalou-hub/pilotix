import { useState } from 'react';
import { useRpc } from '../../lib/query';
import { n, pct } from '../../lib/format';
import { ErrorBox, Help, Loading } from '../../ui/kit';
import { DateRange, algToday } from '../confirmation/DateRange';
import type { Kf } from '../confirmation/shared';
import '../confirmation/confirmation.css';
import './deliveryStats.css';

type Totals = {sent:number;delivered:number;without:number;with:number;returns:number;exchanges:number;active:number;other:number;damage:number;delayMs:number;delayN:number;attempts:number;attemptsN:number};
type Group = 'product'|'company'|'team';
type Choice = {key:string;name:string};
type Row = Record<Group,Choice> & {totals:Totals};
const zero=():Totals=>({sent:0,delivered:0,without:0,with:0,returns:0,exchanges:0,active:0,other:0,damage:0,delayMs:0,delayN:0,attempts:0,attemptsN:0});
function sum(rows:Row[]):Totals {
  const out=zero();for(const row of rows)for(const k of Object.keys(out) as (keyof Totals)[])out[k]+=row.totals[k];return out;
}
const ratio=(a:number,b:number)=>b?a/b:null;
const decimal=(v:number|null,suffix='')=>v===null?'N/D':new Intl.NumberFormat('fr-DZ',{maximumFractionDigits:1,minimumFractionDigits:1}).format(v)+suffix;
const percent=(a:number,b:number)=>b?pct(a/b,1):'—';
function Tile({label,help,value,sub,main=false}:{label:string;help:string;value:string;sub:string;main?:boolean}){
  return <div className={`px-sx-tile${main?' main':''}`}><div className="lb">{label}<Help text={help} label={label}/></div><div className="v ltr">{value}</div><div className="gl">{sub}</div></div>;
}
const columns=[
  {k:'sent',label:'Dispatchées',v:(t:Totals)=>t.sent,fmt:(t:Totals)=>n(t.sent)},
  {k:'delivered',label:'Livrées',v:(t:Totals)=>t.delivered,fmt:(t:Totals)=>n(t.delivered)},
  {k:'rate',label:'Taux livraison',v:(t:Totals)=>ratio(t.delivered,t.sent),fmt:(t:Totals)=>percent(t.delivered,t.sent)},
  {k:'returns',label:'Retours',v:(t:Totals)=>ratio(t.returns,t.sent),fmt:(t:Totals)=>percent(t.returns,t.sent)},
  {k:'active',label:'En cours',v:(t:Totals)=>ratio(t.active,t.sent),fmt:(t:Totals)=>percent(t.active,t.sent)},
  {k:'exchange',label:'Échanges',v:(t:Totals)=>ratio(t.exchanges,t.sent),fmt:(t:Totals)=>percent(t.exchanges,t.sent)},
  {k:'without',label:'Sans intervention',v:(t:Totals)=>ratio(t.without,t.sent),fmt:(t:Totals)=>percent(t.without,t.sent)},
  {k:'with',label:'Avec intervention',v:(t:Totals)=>ratio(t.with,t.sent),fmt:(t:Totals)=>percent(t.with,t.sent)},
  {k:'delay',label:'Délai moyen',v:(t:Totals)=>ratio(t.delayMs,t.delayN),fmt:(t:Totals)=>decimal(t.delayN?t.delayMs/t.delayN/86400000:null,' j')},
  {k:'damage',label:'Endommagés signalés',v:(t:Totals)=>ratio(t.damage,t.sent),fmt:(t:Totals)=>percent(t.damage,t.sent)},
  {k:'attempts',label:'Tentatives moy.',v:(t:Totals)=>ratio(t.attempts,t.attemptsN),fmt:(t:Totals)=>decimal(ratio(t.attempts,t.attemptsN))},
];
const labels:Record<Group,string>={product:'Produit',company:'Société',team:'Équipe'};
const groups:Group[]=['product','company','team'];
export function DeliveryStats(){
  const [kf,setKf]=useState<Kf>({per:'30',basis:'created',from:algToday(),to:algToday(),view:'deliv'});
  const [group,setGroup]=useState<Group>('product');
  const [filters,setFilters]=useState<Record<Group,string>>({product:'',company:'',team:''});
  const [sort,setSort]=useState('sent');
  const [asc,setAsc]=useState(false);
  const q=useRpc('suivi.stats',{per:kf.per,from:kf.from,to:kf.to},{refetchInterval:120000,placeholderData:undefined});
  const raw:Row[]=q.data?.rows??[];
  const choices=(g:Group)=>[...new Map(raw.map(r=>[r[g].key,r[g]])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  const rows=raw.filter(r=>groups.every(g=>!filters[g]||filters[g]===r[g].key));
  const t=sum(rows);
  const by=new Map<string,{name:string;key:string;rows:Row[]}>();
  for(const r of rows){const x=r[group];const old=by.get(x.key);if(old)old.rows.push(r);else by.set(x.key,{...x,rows:[r]});}
  const col=columns.find(x=>x.k===sort)??columns[0];
  const table=[...by.values()].map(r=>({...r,totals:sum(r.rows)})).sort((a,b)=>{
    const x=col.v(a.totals),y=col.v(b.totals);if(x===null)return y===null?0:1;if(y===null)return -1;
    return (x-y)*(asc?1:-1)||a.name.localeCompare(b.name);
  });
  const parts=[['Sans intervention',t.without,'var(--ok)'],['Avec intervention',t.with,'#3779D6'],['Retours',t.returns,'var(--coral)'],['Échanges',t.exchanges,'#8B5CC7'],['En livraison',t.active,'#9AA3B5'],['Autres',t.other,'var(--muted)']] as const;
  const count=(v:number,label='commandes')=>n(v)+' '+label;
  const rate=(v:number)=>percent(v,t.sent);
  const setPeriod=(p:Pick<Kf,'per'|'from'|'to'>)=>{setKf(v=>({...v,...p}));setFilters({product:'',company:'',team:''});};
  return <section className="card px-st px-cf px-ds"><div className="px-sx">
    <div className="px-sx-fb"><DateRange custom kf={kf} onChange={setPeriod}/>
      {groups.map(g=><select key={g} className="px-sx-pill" aria-label={labels[g]} value={filters[g]} onChange={e=>setFilters(x=>({...x,[g]:e.target.value}))}><option value="">{g==='product'?'Tous les produits':g==='company'?'Toutes les sociétés':'Toutes les équipes'}</option>{choices(g).map(x=><option key={x.key} value={x.key}>{x.name}</option>)}</select>)}
    </div>
    {q.error?<ErrorBox error={q.error} onRetry={()=>q.refetch()}/>:!q.data?<Loading/>:<>
      <div className="px-sx-sec first">Performance générale · {n(t.sent)} commandes dispatchées</div>
      <div className="px-liv-grid four">
        <Tile main label="Taux de livraison global" help="Commandes livrées ÷ toutes les commandes dispatchées sur la période." value={rate(t.delivered)} sub={count(t.delivered,'livrées')}/>
        <Tile label="Retours" help="Commandes en retour ou retournées ÷ dispatchées." value={rate(t.returns)} sub={count(t.returns)}/>
        <Tile label="En cours de livraison" help="Commandes encore sur le circuit de livraison ÷ dispatchées." value={rate(t.active)} sub={count(t.active)}/>
        <Tile label="Échanges" help="Commandes en échange ou swappées ÷ dispatchées." value={rate(t.exchanges)} sub={count(t.exchanges)}/>
      </div>
      <div className="px-liv-grid two">
        <Tile label="Sans intervention" help="Livrées sans intervention humaine enregistrée après dispatch ÷ dispatchées." value={rate(t.without)} sub={count(t.without,'livrées')}/>
        <Tile label="Avec intervention" help="Livrées après intervention humaine enregistrée ÷ dispatchées. Ne prouve pas la causalité." value={rate(t.with)} sub={count(t.with,'livrées')}/>
      </div>
      <div className="px-liv-grid three">
        <Tile label="Délai moyen de livraison" help="Moyenne du délai dispatch → livraison, pour les dates disponibles." value={decimal(t.delayN?t.delayMs/t.delayN/86400000:null,' j')} sub="Dispatch → Livraison"/>
        <Tile label="Colis endommagés" help="Dommages signalés dans les réclamations, erreurs ou statuts du transporteur ÷ dispatchées. Les dommages non signalés ne sont pas connus." value={rate(t.damage)} sub={count(t.damage,'colis signalés')}/>
        <Tile label="Nombre moyen de tentatives" help="Tentatives échouées enregistrées + livraison réussie, sur les commandes avec tentative connue. Les données non renseignées peuvent être partielles." value={decimal(ratio(t.attempts,t.attemptsN))} sub={n(t.attemptsN)+' commandes renseignées'}/>
      </div>
      {t.sent>0&&<><div className="px-liv-bar" aria-label="Répartition des commandes">{parts.filter(p=>p[1]>0).map(p=><div key={p[0]} title={p[0]+' : '+rate(p[1])} style={{width:(p[1]/t.sent*100)+'%',background:p[2]}}/>)}</div>
      <div className="px-liv-legend">{parts.filter(p=>p[1]>0||p[0]!=='Autres').map(p=><span key={p[0]}><i style={{background:p[2]}}/>{p[0]} {rate(p[1])}</span>)}</div></>}
      <div className="px-sx-sec row"><span>Statistiques de livraison</span></div>
      <div className="px-sx-fb"><span className="muted small">Regrouper par</span><div className="px-sx-seg">{groups.map(g=><button type="button" key={g} className={group===g?'on':''} onClick={()=>setGroup(g)}>{labels[g]}</button>)}</div>
      <span className="muted small">Trier par</span><select className="px-sx-pill" value={sort} aria-label="Trier par" onChange={e=>setSort(e.target.value)}>{columns.map(c=><option key={c.k} value={c.k}>{c.label}</option>)}</select><button className="btn small" type="button" aria-label={asc?'Tri croissant':'Tri décroissant'} onClick={()=>setAsc(!asc)}>{asc?'↑':'↓'}</button></div>
      <div className="tbl-wrap"><table className="tbl px-ov-tbl px-sx-tbl px-liv-table"><thead><tr><th>{labels[group]}</th>{columns.map(c=><th key={c.k} className="num">{c.label}</th>)}</tr></thead>
      <tbody>{[...table,{key:'total',name:'Total',totals:t}].map(r=><tr key={r.key} className={r.key==='total'?'tot':''}><td data-l={labels[group]}>{r.name}</td>{columns.map(c=><td key={c.k} className="num ltr" data-l={c.label}>{c.fmt(r.totals)}</td>)}</tr>)}</tbody></table></div>
    </>}
  </div></section>;
}
