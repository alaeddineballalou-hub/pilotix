// Management > Plans (seller account only). Stored on the server, never browser-local.
import { useEffect, useState } from 'react';
import { DEFAULT_MANAGEMENT_PLAN, ManagementPlanConfig, simulateManagementPlan } from '@pilotix/shared';
import { useAction, useRpc } from '../../lib/query';

const money=(x:number)=>Math.round(x).toLocaleString('fr-FR')+' DA';
const number=(x:string)=>Math.max(0,Number(x)||0);
const FIELD={maxWidth:220};
type Plan={id:number;kind:'billing'|'agent';name:string;configuration:ManagementPlanConfig;active:boolean};
export function ManagementPlans(){
  const q=useRpc('management.plans',{});
  const products=useRpc('catalog.search',{q:'',limit:100});
  const users=useRpc('users.list',{activeOnly:true});
  const save=useAction('management.planSave',{success:'Plan enregistré',onDone:()=>setDirty(false)});
  const clone=useAction('management.planClone',{success:'Plan dupliqué'});
  const archive=useAction('management.planArchive',{success:'Plan archivé'});
  const assign=useAction('management.planAssign',{success:'Affectation enregistrée'});
  const [kind,setKind]=useState<'billing'|'agent'>('billing');
  const [editing,setEditing]=useState<Plan|null>(null);
  const [dirty,setDirty]=useState(false);
  const [price,setPrice]=useState(16950);
  const [count,setCount]=useState(100);
  const [upsells,setUpsells]=useState(10);
  const [incremental,setIncremental]=useState(3000);
  const plans=(q.data?.plans??[]).filter(x=>x.kind===kind&&x.active);
  const select=(p:Plan)=>{setEditing({...p,configuration:structuredClone(p.configuration)});setDirty(false)};
  const change=(patch:Partial<ManagementPlanConfig>)=>{setEditing(e=>e?{...e,configuration:{...e.configuration,...patch}}:e);setDirty(true)};
  const start=()=>{setEditing({id:0,kind,name:'Nouveau plan',configuration:structuredClone(DEFAULT_MANAGEMENT_PLAN),active:true});setDirty(true)};
  useEffect(()=>{setEditing(null);setDirty(false)},[kind]);
  const p=editing?.configuration;
  let preview:ReturnType<typeof simulateManagementPlan>|null=null;
  let previewError='';
  try {if(p) preview=simulateManagementPlan(p,{productPrice:price,operations:count,upsells,incrementalValue:incremental})}catch(e){previewError=e instanceof Error?e.message:'Configuration invalide'}
  const invalid=!!p&&(p.upsell.enabled&&p.upsell.method==='double'&&(p.method==='none'||p.trigger!=='confirmed'));
  const targets=kind==='billing'?(products.data??[]).map(x=>({id:x.id,name:x.name})): (users.data??[]).filter(x=>x.roles.some(r=>r==='confirmation'||r==='suivi'||r==='agent_manager')).map(x=>({id:x.id,name:x.name}));
  const assignKind=kind==='billing'?'product':'agent';
  return <div className="agx-page" style={{display:'grid',gap:16}}>
    <section className="card">
      <h2>Plans de paiement</h2>
      <p className="muted">Créez un plan, définissez ses règles, puis affectez-le aux {kind==='billing'?'produits':'agents'}. Les montants facturés et les salaires restent séparés.</p>
      <div className="row agx-actions">
        <button className={'btn '+(kind==='billing'?'primary':'')} onClick={()=>setKind('billing')}>Facturation</button>
        <button className={'btn '+(kind==='agent'?'primary':'')} onClick={()=>setKind('agent')}>Agent Pay</button>
        <button className="btn" onClick={start}>+ Créer un plan</button>
      </div>
      {q.isLoading?<p>Chargement…</p>:q.error?<p className="form-err">{q.error.message}</p>:<div className="agx-pe-grid">{plans.map(x=><button type="button" key={x.id} className="btn" onClick={()=>select(x)} style={{textAlign:'left'}}>{x.name} · {x.configuration.method==='tier'?'Tranches':x.configuration.method==='percent'?'%':x.configuration.method==='fixed'?'Fixe':'Forfait'}</button>)}</div>}
    </section>
    {editing&&p&&<section className="card">
      <h2>{editing.id?'Modifier':'Nouveau plan'} — {editing.name}</h2>
      <div className="agx-pe-grid">
        <label className="field"><span className="lab">Nom du plan</span><input value={editing.name} maxLength={100} onChange={e=>{setEditing(x=>x?{...x,name:e.target.value}:x);setDirty(true)}} /></label>
        <label className="field"><span className="lab">Mode de calcul</span><select value={p.method} onChange={e=>change({method:e.target.value as ManagementPlanConfig['method']})}>
          <option value="fixed">Montant fixe par opération</option><option value="percent">Pourcentage du prix produit</option><option value="tier">Tranches de prix</option><option value="none">Forfait / salaire uniquement</option>
        </select></label>
        {p.method!=='none'&&<label className="field"><span className="lab">Événement rémunéré</span><select value={p.trigger} onChange={e=>change({trigger:e.target.value as 'confirmed'|'delivered'})}><option value="confirmed">Commande confirmée</option><option value="delivered">Commande livrée</option></select></label>}
        {(p.method==='fixed'||p.method==='percent')&&<label className="field"><span className="lab">{p.method==='fixed'?'Tarif (DA)':'Pourcentage (%)'}</span><input style={FIELD} type="number" min={0} max={p.method==='percent'?100:10000000} value={p.rate} onChange={e=>change({rate:number(e.target.value)})}/></label>}
        <label className="field"><span className="lab">{kind==='agent'?'Salaire mensuel (DA)':'Forfait mensuel client (DA)'}</span><input style={FIELD} type="number" min={0} value={p.monthly} onChange={e=>change({monthly:number(e.target.value)})}/></label>
      </div>
      {p.method==='tier'&&<fieldset className="agx-bonus"><legend>Tranches du prix produit</legend><div className="agx-pe-grid">{['0–9 999 DA','10 000–19 999 DA','20 000+ DA'].map((title,i)=><label key={i} className="field"><span className="lab">{title}</span><input style={FIELD} type="number" min={0} value={p.tiers[i]} onChange={e=>change({tiers:p.tiers.map((x,j)=>j===i?number(e.target.value):x) as [number,number,number]})}/></label>)}</div></fieldset>}
      <fieldset className="agx-bonus"><legend><label><input type="checkbox" checked={p.bonus.enabled} onChange={e=>change({bonus:{...p.bonus,enabled:e.target.checked}})}/> Bonus optionnel</label></legend>
        {p.bonus.enabled&&<div className="agx-pe-grid"><label className="field"><span className="lab">Objectif : nombre d'opérations</span><input type="number" min={0} value={p.bonus.threshold} onChange={e=>change({bonus:{...p.bonus,threshold:number(e.target.value)}})}/></label><label className="field"><span className="lab">Prime unique (DA)</span><input type="number" min={0} value={p.bonus.amount} onChange={e=>change({bonus:{...p.bonus,amount:number(e.target.value)}})}/></label></div>}
      </fieldset>
      <fieldset className="agx-bonus"><legend><label><input type="checkbox" checked={p.upsell.enabled} onChange={e=>change({upsell:{...p.upsell,enabled:e.target.checked}})}/> Upsell optionnel</label></legend>
        {p.upsell.enabled&&<div className="agx-pe-grid"><label className="field"><span className="lab">Plan upsell</span><select value={p.upsell.method} onChange={e=>change({upsell:{...p.upsell,method:e.target.value as ManagementPlanConfig['upsell']['method']}})}>
          <option value="double">Double confirmation (tarif confirmation une 2e fois)</option><option value="fixed">Montant fixe par upsell</option><option value="percent">Pourcentage de la vente ajoutée</option>
        </select></label>
        {p.upsell.method!=='double'&&<label className="field"><span className="lab">{p.upsell.method==='percent'?'Pourcentage (%)':'Montant par upsell (DA)'}</span><input type="number" min={0} value={p.upsell.rate} onChange={e=>change({upsell:{...p.upsell,rate:number(e.target.value)}})}/></label>}
        <label className="field"><span className="lab">Éligibilité upsell</span><select value={p.upsell.trigger} onChange={e=>change({upsell:{...p.upsell,trigger:e.target.value as 'confirmed'|'delivered'}})}><option value="delivered">Après livraison</option><option value="confirmed">À la confirmation</option></select></label></div>}
      </fieldset>
      {invalid&&<p className="form-err">Double confirmation nécessite une commission de confirmation active.</p>}
      <div className="row agx-actions">
        <button className="btn primary" disabled={save.isPending||!dirty||!editing.name.trim()||!!previewError||invalid} onClick={()=>save.mutate({...(editing.id?{id:editing.id}:{}),kind,name:editing.name,configuration:p})}>Enregistrer le plan</button>
        {editing.id>0&&<button className="btn" disabled={clone.isPending} onClick={()=>clone.mutate({id:editing.id})}>Dupliquer</button>}
        {editing.id>0&&<button className="btn" disabled={archive.isPending} onClick={()=>{if(confirm('Archiver ce plan ?')){archive.mutate({id:editing.id});setEditing(null)}}}>Archiver</button>}
      </div>
    </section>}
    {p&&<section className="card">
      <h2>Simulation (sans modifier les factures)</h2>
      <div className="agx-pe-grid">
        {([['Prix du produit',price,setPrice],['Opérations éligibles',count,setCount],['Nombre d’upsells',upsells,setUpsells],['Valeur ajoutée / upsell',incremental,setIncremental]] as const).map(([label,value,set],i)=><label className="field" key={i}><span className="lab">{label}</span><input type="number" min={0} value={value} onChange={e=>set(number(e.target.value))}/></label>)}
      </div>
      {previewError?<p className="form-err">{previewError}</p>:preview&&<div><p>Forfait/salaire : <b>{money(preview.monthly)}</b></p><p>Commissions : <b>{money(preview.main)}</b></p><p>Bonus : <b>{money(preview.bonus)}</b></p><p>Upsell : <b>{money(preview.upsell)}</b></p><h2>Total : {money(preview.total)}</h2></div>}
    </section>}
    <section className="card"><h2>Affecter les plans</h2><p className="muted">{kind==='billing'?'Sélectionnez un plan par produit.':'Sélectionnez un plan par agent.'} Une affectation ne modifie pas les opérations historiques.</p>
      {targets.length===0?<p className="muted">Aucun élément disponible.</p>:<div style={{display:'grid',gap:12}}>{targets.map(target=>{
        const current=q.data?.assignments.find(a=>a.targetKind===assignKind&&a.targetId===target.id)?.planId;
        return <label className="field" key={target.id}><span className="lab">{target.name}</span><select value={current??''} disabled={assign.isPending} onChange={e=>assign.mutate({targetKind:assignKind,targetId:target.id,planId:e.target.value?Number(e.target.value):null})}>
          <option value="">Aucun plan</option>{plans.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select></label>
      })}</div>}
    </section>
    <p className="muted small">Configuration enregistrée dans Pilotix. L'intégration aux factures et au calcul réel de la paie doit être validée séparément avant activation.</p>
  </div>;
}
