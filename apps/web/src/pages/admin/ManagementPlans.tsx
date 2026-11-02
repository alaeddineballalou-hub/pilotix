// Templates are separate from their immutable assignments and accepted seller contracts.
import { useEffect, useState } from 'react';
import { agentPlanTask, DEFAULT_MANAGEMENT_PLAN, ManagementPlanConfig, simulateManagementPlan, planPriceBrackets } from '@pilotix/shared';
import { useAction, useRpc } from '../../lib/query';
import { PlanSummary } from './PlanSummary';
import { BillLines } from '../agency/parts';
import { AgencyPaymentPlans } from './AgencyPaymentPlans';

const money=(x:number)=>Math.round(x).toLocaleString('fr-FR')+' DA';
const number=(x:string)=>Math.max(0,Number(x)||0);
const FIELD={maxWidth:220};
type Plan={id:number;kind:'billing'|'agent';name:string;configuration:ManagementPlanConfig;active:boolean};
export function ManagementPlans({ agency = false, initialKind = 'billing' }: { agency?: boolean; initialKind?: 'billing'|'agent' } = {}){
  return agency?<AgencyPaymentPlans initialKind={initialKind}/>:<StoreManagementPlans agency={agency} initialKind={initialKind}/>;
}
function StoreManagementPlans({ agency = false, initialKind = 'billing' }: { agency?: boolean; initialKind?: 'billing'|'agent' } = {}){
  const [month,setMonth]=useState(()=>{const d=new Date(Date.now()+3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`});
  const q=useRpc('management.plans',{});
  const contracts=useRpc('management.billingTargets',{}, {enabled:agency&&initialKind==='billing'});
  const payroll=useRpc('management.payroll',{month},{enabled:agency&&initialKind==='agent'});
  const propose=useAction('management.billingPropose',{success:'Proposition envoyée au vendeur'});
  const closePay=useAction('management.payrollClose',{success:'Paie validée et conservée'});
  const products=useRpc('catalog.search',{q:'',limit:100},{enabled:!agency});
  const users=useRpc('users.list',{activeOnly:true});
  const save=useAction('management.planSave',{success:'Plan enregistré',onDone:(r)=>{setDirty(false);setEditing(p=>p?{...p,id:r.id}:p)}});
  const clone=useAction('management.planClone',{success:'Plan dupliqué'});
  const archive=useAction('management.planArchive',{success:'Plan archivé'});
  const assign=useAction('management.planAssign',{success:'Affectation enregistrée'});
  const [kind,setKind]=useState<'billing'|'agent'>(initialKind);
  const [editing,setEditing]=useState<Plan|null>(null);
  const [dirty,setDirty]=useState(false);
  const [price,setPrice]=useState(16950);
  const [count,setCount]=useState(100);
  const [upsells,setUpsells]=useState(10);
  const [incremental,setIncremental]=useState(3000);
  const plans=(q.data?.plans??[]).filter(x=>x.kind===kind&&x.active);
  const select=(p:Plan)=>{setEditing({...p,configuration:{...structuredClone(p.configuration),...(p.kind==='agent'?{agentTask:agentPlanTask(p.configuration)}:{})}});setDirty(false)};
  const change=(patch:Partial<ManagementPlanConfig>)=>{setEditing(e=>e?{...e,configuration:{...e.configuration,...patch}}:e);setDirty(true)};
  const start=()=>{setEditing({id:0,kind,name:'Nouveau plan',configuration:{...structuredClone(DEFAULT_MANAGEMENT_PLAN),...(kind==='agent'?{agentTask:'confirmation' as const}:{})},active:true});setDirty(true)};
  useEffect(()=>{setEditing(null);setDirty(false)},[kind]);
  const changeKind=(next:'billing'|'agent')=>{if(!dirty||confirm('Quitter les modifications non enregistrées ?'))setKind(next)};
  const p=editing?.configuration;
  const suiviPlan=kind==='agent'&&p&&agentPlanTask(p)==='suivi';
  let preview:ReturnType<typeof simulateManagementPlan>|null=null;
  let previewError='';
  try {if(p) preview=simulateManagementPlan(p,{productPrice:price,operations:count,upsells,incrementalValue:incremental})}catch(e){previewError=e instanceof Error?e.message:'Configuration invalide'}
  const brackets=p?planPriceBrackets(p):[];
  const invalid=!!p&&(p.upsell.enabled&&p.upsell.method==='double'&&(p.method==='none'||p.trigger!=='confirmed'));
  const targets=agency && kind==='billing'?[]:kind==='billing'?(products.data??[]).map(x=>({id:x.id,name:x.name})): (users.data??[]).filter(x=>x.roles.some(r=>r==='confirmation'||r==='suivi'||r==='agent_manager')).map(x=>({id:x.id,name:x.name}));
  const assignKind=kind==='billing'?'product':'agent';
  return <div className="agx-page" style={{display:'grid',gap:16}}>
    <section className="card">
      <h2>Plans de paiement</h2>
      <p className="muted">Créez un plan, puis affectez-le aux {kind==='billing'?(agency?'contrats vendeurs et à leurs produits':'produits'):'agents'}. Les montants facturés et les salaires restent séparés.</p>
      <div className="row agx-actions">
        {!agency && <button className={'btn '+(kind==='billing'?'primary':'')} onClick={()=>changeKind('billing')}>Facturation</button>}
        {!agency && <button className={'btn '+(kind==='agent'?'primary':'')} onClick={()=>changeKind('agent')}>Agent Pay</button>}
        <button className="btn" onClick={()=>{if(!dirty||confirm('Quitter les modifications non enregistrées ?'))start()}}>+ Créer un plan</button>
      </div>
      {q.isLoading?<p>Chargement…</p>:q.error?<p className="form-err">{q.error.message}</p>:<div className="agx-pe-grid">{plans.map(x=><button type="button" key={x.id} className="btn" onClick={()=>{if(!dirty||confirm('Quitter les modifications non enregistrées ?'))select(x)}} style={{textAlign:'left'}}>{x.name} · {x.configuration.method==='tier'?'Tranches':x.configuration.method==='percent'?'%':x.configuration.method==='fixed'?'Fixe':'Forfait'}</button>)}</div>}
    </section>
    {editing&&p&&<section className="card">
      <h2>{editing.id?'Modifier':'Nouveau plan'} — {editing.name}</h2>
      <div className="agx-pe-grid">
        <label className="field"><span className="lab">Nom du plan</span><input value={editing.name} maxLength={100} onChange={e=>{setEditing(x=>x?{...x,name:e.target.value}:x);setDirty(true)}} /></label>
        {kind==='agent'&&<label className="field"><span className="lab">Type de plan Agent Pay</span><select value={agentPlanTask(p)} onChange={e=>{
          const task=e.target.value as 'confirmation'|'suivi';
          change({agentTask:task,...(task==='suivi'?{trigger:'delivered',upsell:{...p.upsell,enabled:false,rate:0,trigger:'delivered',ruleVersion:2}}:{})});
        }}><option value="confirmation">Plan de confirmation</option><option value="suivi">Plan de suivi</option></select></label>}
        <label className="field"><span className="lab">Mode de calcul</span><select value={p.method} onChange={e=>change({method:e.target.value as ManagementPlanConfig['method']})}>
          <option value="fixed">Montant fixe par opération</option><option value="percent">Pourcentage du prix produit</option><option value="tier">Tranches de prix</option><option value="none">Forfait / salaire uniquement</option>
        </select></label>
        {p.method!=='none'&&!suiviPlan&&<label className="field"><span className="lab">Événement rémunéré</span><select value={p.trigger} onChange={e=>change({trigger:e.target.value as 'confirmed'|'delivered'})}><option value="confirmed">Commande confirmée</option><option value="delivered">Commande livrée</option></select></label>}
        {suiviPlan&&<p className="agx-note">Commande livrée · agent de suivi attribué à la commande uniquement.</p>}
        {(p.method==='fixed'||p.method==='percent')&&<label className="field"><span className="lab">{p.method==='fixed'?'Tarif (DA)':'Pourcentage (%)'}</span><input style={FIELD} type="number" min={0} max={p.method==='percent'?100:10000000} value={p.rate} onChange={e=>change({rate:number(e.target.value)})}/></label>}
        <label className="field"><span className="lab">{kind==='agent'?'Salaire mensuel (DA)':'Forfait mensuel client (DA)'}</span><input style={FIELD} type="number" min={0} value={p.monthly} onChange={e=>change({monthly:number(e.target.value)})}/></label>
      </div>
      {p.method==='tier'&&<fieldset className="agx-bonus"><legend>Tranches du prix produit</legend>
        <p className="muted small">Modifiez les limites et les tarifs. Les tranches se suivent sans chevauchement ni trou.</p>
        <div style={{display:'grid',gap:10}}>
          {brackets.map((t,i)=><div key={i} style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'end'}}>
            <label className="field" style={{flex:'1 1 100px'}}><span className="lab">De (DA)</span><input type="number" step={1} min={0} value={t.from} onChange={e=>change({ranges:brackets.map((x,j)=>j===i?{...x,from:number(e.target.value)}:x)})}/></label>
            <label className="field" style={{flex:'1 1 100px'}}><span className="lab">À (DA)</span><input type="number" step={1} min={t.from} placeholder="Sans limite" disabled={i===brackets.length-1} value={t.to??''} onChange={e=>change({ranges:brackets.map((x,j)=>j===i?{...x,to:e.target.value===''?null:number(e.target.value)}:x)})}/></label>
            <label className="field" style={{flex:'1 1 100px'}}><span className="lab">Tarif (DA)</span><input type="number" min={0} value={t.amount} onChange={e=>change({ranges:brackets.map((x,j)=>j===i?{...x,amount:number(e.target.value)}:x)})}/></label>
            <button type="button" className="btn" disabled={brackets.length===1} onClick={()=>change({ranges:brackets.filter((_,j)=>j!==i).map((x,j,a)=>j===a.length-1?{...x,to:null}:x)})}>Supprimer</button>
          </div>)}
        </div>
        <button type="button" className="btn" disabled={brackets.length>=100} onClick={()=>{const prev=brackets[brackets.length-1];const from=prev.from+10000;change({ranges:[...brackets.slice(0,-1),{...prev,to:from-1},{from,to:null,amount:0}]})}}>+ Ajouter une tranche</button>
      </fieldset>}
            <fieldset className="agx-bonus"><legend><label><input type="checkbox" checked={p.bonus.enabled} onChange={e=>change({bonus:{...p.bonus,enabled:e.target.checked}})}/> Bonus optionnel</label></legend>
        {p.bonus.enabled&&<div className="agx-pe-grid"><label className="field"><span className="lab">Objectif : nombre d'opérations</span><input type="number" min={0} value={p.bonus.threshold} onChange={e=>change({bonus:{...p.bonus,threshold:number(e.target.value)}})}/></label><label className="field"><span className="lab">Prime unique (DA)</span><input type="number" min={0} value={p.bonus.amount} onChange={e=>change({bonus:{...p.bonus,amount:number(e.target.value)}})}/></label></div>}
      </fieldset>
      {!suiviPlan&&<fieldset className="agx-bonus"><legend><label><input type="checkbox" checked={p.upsell.enabled} onChange={e=>change({upsell:{...p.upsell,enabled:e.target.checked}})}/> Upsell optionnel</label></legend>
        {p.upsell.enabled&&<div className="agx-pe-grid"><label className="field"><span className="lab">Plan upsell</span><select value={p.upsell.method} onChange={e=>change({upsell:{...p.upsell,method:e.target.value as ManagementPlanConfig['upsell']['method']}})}>
          <option value="double">Double confirmation (tarif confirmation une 2e fois)</option><option value="fixed">Montant fixe par upsell</option><option value="percent">Pourcentage de la vente ajoutée</option>
        </select></label>
        {p.upsell.method!=='double'&&<label className="field"><span className="lab">{p.upsell.method==='percent'?'Pourcentage (%)':'Montant par upsell (DA)'}</span><input type="number" min={0} value={p.upsell.rate} onChange={e=>change({upsell:{...p.upsell,rate:number(e.target.value)}})}/></label>}
        <label className="field"><span className="lab">Éligibilité upsell</span><select value={p.upsell.trigger} onChange={e=>change({upsell:{...p.upsell,trigger:e.target.value as 'confirmed'|'delivered'}})}><option value="delivered">Après livraison</option><option value="confirmed">À la confirmation</option></select></label></div>}
      </fieldset>}
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
        {([['Prix du produit',price,setPrice],[suiviPlan?'Commandes livrées attribuées':'Opérations éligibles',count,setCount],['Nombre d’upsells',upsells,setUpsells],['Valeur ajoutée / upsell',incremental,setIncremental]] as const).filter((_,i)=>!suiviPlan||i<2).map(([label,value,set],i)=><label className="field" key={i}><span className="lab">{label}</span><input type="number" min={0} value={value} onChange={e=>set(number(e.target.value))}/></label>)}
      </div>
      {previewError?<p className="form-err">{previewError}</p>:preview&&<div><p>Forfait/salaire : <b>{money(preview.monthly)}</b></p><p>Commissions : <b>{money(preview.main)}</b></p><p>Bonus : <b>{money(preview.bonus)}</b></p>{!suiviPlan&&<p>Upsell : <b>{money(preview.upsell)}</b></p>}<h2>Total : {money(preview.total)}</h2></div>}
    </section>}
    <section className="card"><h2>Affecter les plans</h2>
      <p className="muted">{agency&&kind==='billing'?'Le vendeur doit accepter chaque proposition dans Agences → son contrat. Les nouveaux tarifs commencent à son acceptation.':`Sélectionnez un plan par ${kind==='billing'?'produit':'agent'} et cliquez sur Appliquer.`} Une commande confirmée sous un plan conserve ce plan jusqu’à sa livraison. Les opérations antérieures conservent leurs règles. Modifier un modèle ne change pas ses affectations : réaffectez-le pour appliquer une nouvelle version.</p>
      {agency&&kind==='billing'?<>
        {contracts.isLoading?<p>Chargement des contrats…</p>:contracts.error?<p className="form-err">{contracts.error.message}</p>:!contracts.data?.length?<p>Aucun contrat actif. Ajoutez un vendeur depuis Vendeurs.</p>:contracts.data.map(c=><div key={c.id} className="card" style={{marginBlock:12}}><h3>{c.name}</h3>
          {[{id:0,name:'Plan général du contrat'},...c.products].map(product=>{
            const history=c.terms.filter(t=>t.productId===product.id);
            const accepted=history.find(t=>t.status==='accepted');
            const pending=history.find(t=>t.status==='pending');
            return <div key={product.id} style={{marginBlock:16}}>
              <Assignment label={product.name} plans={plans} current={pending?.planId??accepted?.planId??null} busy={propose.isPending} action="Proposer au vendeur" empty={product.id?'Plan général du contrat':'Tarif historique'} onApply={planId=>propose.mutate({linkId:c.id,productId:product.id,planId})}/>
              <p className="muted small">Actif : {accepted?.name??'Tarif historique / plan général'}{accepted?.effectiveAt?` · depuis ${new Date(accepted.effectiveAt).toLocaleString('fr-FR')}`:''}</p>
              {pending&&<div className="agx-note"><b>En attente du vendeur : {pending.name}</b><PlanSummary plan={pending.configuration}/></div>}
            </div>;
          })}
        </div>)}
      </>:users.error?<p className="form-err">{users.error.message}</p>:targets.length===0?<p>Aucun élément disponible.</p>:targets.map(target=>{
        const current=q.data?.assignments.find(a=>a.targetKind===assignKind&&a.targetId===target.id)?.planId??null;
        return <Assignment key={target.id} label={target.name} plans={plans} current={current} busy={assign.isPending} action="Appliquer" empty="Aucun plan" onApply={planId=>assign.mutate({targetKind:assignKind,targetId:target.id,planId})}/>;
      })}
    </section>
    {agency&&kind==='agent'&&<section className="card"><h2>Paie des agents</h2><p>Calculée sur leurs opérations chez les vendeurs, selon les plans affectés. Le salaire mensuel et la prime sont comptés une fois par agent.</p>
      <label className="field"><span className="lab">Mois</span><input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label>
      {payroll.isLoading?<p>Calcul en cours…</p>:payroll.error?<p className="form-err">{payroll.error.message}</p>:payroll.data&&<>
        {payroll.data.rows.map(r=><details key={r.id} className="card"><summary>{r.name} · {r.operations} opérations · {money(r.total)}</summary><BillLines lines={r.lines} total={r.total}/></details>)}
        {!payroll.data.rows.length&&<p>Aucun plan affecté pour ce mois.</p>}
        <h3>Total : {money(payroll.data.total)}</h3>
        {payroll.data.closedAt?<p>Paie validée le {new Date(payroll.data.closedAt).toLocaleString('fr-FR')}. Montants conservés.</p>:<button className="btn primary" disabled={closePay.isPending||month>=new Date(Date.now()+3600000).toISOString().slice(0,7)} onClick={()=>{if(confirm('Valider définitivement la paie de ce mois ?'))closePay.mutate({month})}}>Valider la paie du mois terminé</button>}
      </>}
    </section>}
    {!agency&&<p className="muted small">Les plans boutique sont enregistrés séparément des contrats agence. Ils ne remplacent pas encore le calcul existant dans Management → Paie.</p>}
  </div>;
}
function Assignment({label,plans,current,busy,action,empty,onApply}:{label:string;plans:Plan[];current:number|null;busy:boolean;action:string;empty:string;onApply:(id:number|null)=>void}) {
  const [value,setValue]=useState(current);
  useEffect(()=>setValue(current),[current]);
  return <div className="row agx-actions" style={{marginBlock:12}}><label className="field"><span className="lab">{label}</span><select value={value??''} disabled={busy} onChange={e=>setValue(e.target.value?Number(e.target.value):null)}><option value="">{empty}</option>{!plans.some(p=>p.id===value)&&value!==null&&<option value={value}>Plan archivé #{value}</option>}{plans.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="btn" disabled={busy} onClick={()=>onApply(value)}>{action}</button></div>;
}
