// Payment plans workspace for the Confirmation Agency. Templates, bonuses and assignments are separate.
import { useEffect, useState } from 'react';
import { DEFAULT_MANAGEMENT_PLAN, planPriceBrackets, simulateManagementPlan, type ManagementPlanConfig, validatePriceBrackets } from '@pilotix/shared';
import { useAction, useRpc } from '../../lib/query';
import { BillLines } from '../agency/parts';

type Kind='billing'|'agent';
type Tab=Kind|'bonus'|'assignment';
type Plan={id:number;kind:Kind;name:string;configuration:ManagementPlanConfig;active:boolean};
type Bonus={id:number;kind:Kind;name:string;trigger:'confirmed'|'delivered';threshold:number;amount:number;active:boolean};
type TargetKind='seller'|'agent';
const currency=(n:number)=>Math.round(n).toLocaleString('fr-FR')+' DA';
const nn=(v:string)=>Math.max(0,Number(v)||0);
const int=(v:string)=>Math.floor(nn(v));
const copy=<T,>(x:T):T=>structuredClone(x);
const MODES=[['fixed','Salaire + Prime fixe'],['percent','Salaire + Prime en pourcentage'],['tier','Système de paliers de prix'],['none','Salaire fixe']] as const;
const UPS=[['double','Double confirmation'],['qty','QTY — Quantité supplémentaire'],['percent','Pourcentage du prix unitaire'],['fixed','Montant fixe']] as const;
const blankPlan=():ManagementPlanConfig=>({...copy(DEFAULT_MANAGEMENT_PLAN),bonus:{enabled:false,threshold:100,amount:0},upsell:{enabled:false,method:'double',rate:0,trigger:'delivered',ruleVersion:2}});
const editable=(p:ManagementPlanConfig):ManagementPlanConfig=>({...copy(p),ranges:copy(planPriceBrackets(p)),bonus:{...p.bonus,enabled:false},upsell:{...p.upsell,method:p.upsell.method==='qty'?'qty':p.upsell.method,trigger:'delivered',ruleVersion:2}});
const ym=()=>{const d=new Date(Date.now()+3600000);return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')};

export function AgencyPaymentPlans({initialKind='billing'}:{initialKind?:Kind}) {
  const [tab,setTab]=useState<Tab>(initialKind);
  const q=useRpc('management.plans',{});
  const bq=useRpc('management.bonuses',{});
  const contracts=useRpc('management.billingTargets',{});
  const users=useRpc('users.list',{activeOnly:true});
  const [month,setMonth]=useState(ym);
  const payroll=useRpc('management.payroll',{month});
  const save=useAction('management.planSave',{success:'Plan enregistré'});
  const clone=useAction('management.planClone',{success:'Plan dupliqué'});
  const remove=useAction('management.planDelete',{success:r=>r.archived?'Plan archivé pour conserver les historiques':'Plan supprimé'});
  const assign=useAction('management.planAssign',{success:'Plan agent affecté'});
  const propose=useAction('management.billingPropose',{success:'Proposition envoyée au vendeur'});
  const close=useAction('management.payrollClose',{success:'Paie clôturée'});
  const saveBonus=useAction('management.bonusSave',{success:'Bonus enregistré'});
  const cloneBonus=useAction('management.bonusClone',{success:'Bonus dupliqué'});
  const deleteBonus=useAction('management.bonusDelete',{success:r=>r.archived?'Bonus archivé (historique conservé)':'Bonus supprimé'});
  const assignBonus=useAction('management.bonusAssign',{success:'Affectation bonus enregistrée'});
  const [editing,setEditing]=useState<{id:number|null;kind:Kind;name:string;configuration:ManagementPlanConfig}|null>(null);
  const [bonusEditing,setBonusEditing]=useState<{id:number|null;kind:Kind;name:string;trigger:'confirmed'|'delivered';threshold:number;amount:number}|null>(null);
  const [assignmentKind,setAssignmentKind]=useState<TargetKind>('seller');
  const [error,setError]=useState('');
  const plans=(q.data?.plans??[]).filter(p=>p.active) as Plan[];
  const bonuses=(bq.data?.rules??[]).filter(b=>b.active) as Bonus[];
  const selectedPlan=editing?plans.find(p=>p.id===editing.id):undefined;
  const planLinked=!!selectedPlan && (
    (q.data?.assignments??[]).some(a=>a.planId===selectedPlan.id) ||
    (contracts.data??[]).some(c=>c.terms.some(t=>t.planId===selectedPlan.id && t.status!=='rejected'))
  );
  const bonusLinked=!!bonusEditing?.id && (bq.data?.assignments??[]).some(a=>a.bonusId===bonusEditing.id);
  const planError=editing?getPlanError(editing.configuration,editing.name):'';
  const canEdit=!!editing&&!planLinked;
  const patch=(change:Partial<ManagementPlanConfig>)=>{
    setEditing(p=>p?{...p,configuration:{...p.configuration,...change}}:p);setError('');
  };
  const selectPlan=(p:Plan)=>{setEditing({id:p.id,kind:p.kind,name:p.name,configuration:editable(p.configuration)});setError('')};
  const newPlan=(kind:Kind)=>{setEditing({id:null,kind,name:'Nouveau plan',configuration:blankPlan()});setError('')};
  const selectBonus=(b:Bonus)=>{setBonusEditing({id:b.id,kind:b.kind,name:b.name,trigger:b.trigger,threshold:b.threshold,amount:b.amount});setError('')};
  const newBonus=()=>{setBonusEditing({id:null,kind:'agent',name:'Nouveau bonus',trigger:'confirmed',threshold:100,amount:0});setError('')};
  const saveCurrent=()=>{if(!editing||planError||planLinked)return;save.mutate({...(editing.id?{id:editing.id}:{}),kind:editing.kind,name:editing.name,configuration:editing.configuration},{onSuccess:r=>setEditing(p=>p?{...p,id:r.id}:p)})};
  const removeCurrent=()=>{if(!editing?.id||planLinked)return;if(!confirm('Supprimer ce plan non affecté ? Les historiques seront conservés.'))return;remove.mutate({id:editing.id},{onSuccess:()=>setEditing(null)})};
  const saveB=()=>{if(!bonusEditing||bonusLinked||!bonusEditing.name.trim()||bonusEditing.threshold<1)return;saveBonus.mutate({...(bonusEditing.id?{id:bonusEditing.id}:{}),...bonusEditing,id:bonusEditing.id??undefined},{onSuccess:r=>setBonusEditing(p=>p?{...p,id:r.id}:p)})};
  useEffect(()=>{setEditing(null);setBonusEditing(null);setError('')},[tab]);
  const agentRows=(users.data??[]).filter(u=>u.roles.some(r=>['confirmation','suivi','agent_manager'].includes(r)));
  return <div className="ppm agx-page">
    <header className="ppm-head">
      <div className="ppm-brand"><span className="ppm-mark">✦</span><div><b>Plans de paiement</b><small>Confirmation Agency · Management</small></div></div>
      <span className="ppm-live">Pilotix</span>
    </header>
    <nav className="ppm-tabs" aria-label="Plans de paiement">
      {([['billing','Facturation Seller'],['agent','Agent Pay'],['bonus','Bonus'],['assignment','Affectations']] as const).map(([id,label])=>
        <button key={id} type="button" className={'ppm-tab '+(tab===id?'on':'')} onClick={()=>setTab(id)}>{label}</button>)}
    </nav>
    {(tab==='billing'||tab==='agent')&&<>
      <section className="card ppm-panel">
        <div className="ppm-row"><div><h2>{tab==='billing'?'Plans Facturation Seller':'Plans Agent Pay'}</h2><p className="muted">{tab==='billing'?'Tarifs facturés aux contrats vendeurs':'Salaire et primes de votre équipe'}</p></div>
          <button type="button" className="btn primary" onClick={()=>newPlan(tab)}>+ Nouveau plan</button></div>
        {q.isLoading?<p>Chargement…</p>:q.error?<p className="form-err">{q.error.message}</p>:
          <div className="ppm-cards">{plans.filter(p=>p.kind===tab).map(p=>
            <button key={p.id} type="button" className={'ppm-plan-card '+(editing?.id===p.id?'on':'')} onClick={()=>selectPlan(p)}>
              <b>{p.name}</b><small>{MODES.find(m=>m[0]===p.configuration.method)?.[1]}</small>
              {(q.data?.assignments??[]).some(a=>a.planId===p.id)||(contracts.data??[]).some(c=>c.terms.some(t=>t.planId===p.id&&t.status!=='rejected'))?
                <span className="ppm-pill">Affecté</span>:<span className="ppm-pill clear">Libre</span>}
            </button>)}</div>}
      </section>
      {editing&&editing.kind===tab&&<section className="card ppm-panel">
        <div className="ppm-row"><h2>{editing.id?'Configuration du plan':'Nouveau plan'}</h2>{planLinked&&<span className="ppm-pill">🔒 Plan affecté</span>}</div>
        {planLinked&&<p className="agx-note">Ce plan est déjà associé. Dupliquez-le pour changer les prix : les contrats et opérations antérieurs gardent leurs montants.</p>}
        <div className="ppm-grid">
          <label className="field"><span className="lab">Nom du plan</span><input disabled={!canEdit} value={editing.name} onChange={e=>setEditing(p=>p?{...p,name:e.target.value}:p)}/></label>
          <label className="field"><span className="lab">Mode de calcul</span><select disabled={!canEdit} value={editing.configuration.method} onChange={e=>patch({method:e.target.value as ManagementPlanConfig['method']})}>
            {MODES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          {editing.configuration.method!=='none'&&<label className="field"><span className="lab">Commission principale déclenchée</span><select disabled={!canEdit} value={editing.configuration.trigger} onChange={e=>patch({trigger:e.target.value as 'confirmed'|'delivered'})}>
            <option value="confirmed">Commande confirmée</option><option value="delivered">Commande livrée</option></select></label>}
          {(editing.configuration.method==='fixed'||editing.configuration.method==='percent')&&<label className="field"><span className="lab">{editing.configuration.method==='fixed'?'Prime fixe / opération (DA)':'Prime (% du prix unitaire produit)'}</span>
            <input disabled={!canEdit} type="number" min={0} max={editing.configuration.method==='percent'?100:10000000} value={editing.configuration.rate} onChange={e=>patch({rate:nn(e.target.value)})}/></label>}
          <label className="field"><span className="lab">{tab==='agent'?'Salaire fixe mensuel (DA)':'Forfait mensuel vendeur (DA)'}</span>
            <input disabled={!canEdit} type="number" min={0} value={editing.configuration.monthly} onChange={e=>patch({monthly:nn(e.target.value)})}/></label>
        </div>
        {editing.configuration.method==='tier'&&<div className="ppm-section">
          <div className="ppm-row"><h3>Système de paliers de prix</h3><small>{planPriceBrackets(editing.configuration).length} paliers</small></div>
          <p className="muted">Limites modifiables · aucun trou ni chevauchement · dernier palier illimité.</p>
          {planPriceBrackets(editing.configuration).map((t,i,all)=><div key={i} className="ppm-tier">
            <div className="ppm-row"><b>Palier {i+1}</b><button className="btn small" type="button" disabled={!canEdit||all.length===1} onClick={()=>patch({ranges:removeRange(all,i)})}>Supprimer</button></div>
            <div className="ppm-tier-grid">
              <label className="field"><span className="lab">De (DA)</span><input type="number" min={0} step={1} disabled={!canEdit||i===0} value={t.from} onChange={e=>patch({ranges:changeBound(all,i,'from',int(e.target.value))})}/></label>
              <label className="field"><span className="lab">À (DA)</span>{i===all.length-1?<span className="ppm-infinity">∞</span>:<input type="number" min={t.from} step={1} disabled={!canEdit} value={t.to??''} onChange={e=>patch({ranges:changeBound(all,i,'to',int(e.target.value))})}/>}</label>
              <label className="field"><span className="lab">Prime (DA)</span><input type="number" min={0} disabled={!canEdit} value={t.amount} onChange={e=>patch({ranges:all.map((x,j)=>j===i?{...x,amount:nn(e.target.value)}:x)})}/></label>
            </div>
          </div>)}
          <button type="button" className="btn ppm-add" disabled={!canEdit||planPriceBrackets(editing.configuration).length>=100} onClick={()=>patch({ranges:addRange(planPriceBrackets(editing.configuration))})}>+ Ajouter un palier</button>
        </div>}
        <div className="ppm-section">
          <div className="ppm-row"><h3>Prime Upsell</h3><span className="ppm-pill">Livrée uniquement</span></div>
          <label className="ppm-toggle"><input type="checkbox" disabled={!canEdit} checked={editing.configuration.upsell.enabled} onChange={e=>patch({upsell:{...editing.configuration.upsell,enabled:e.target.checked,trigger:'delivered',ruleVersion:2}})}/> Activer la prime Upsell</label>
          {editing.configuration.upsell.enabled&&<>
            <div className="ppm-up-modes">{UPS.map(([value,label])=>
              <label key={value} className={'ppm-up-mode '+(editing.configuration.upsell.method===value?'on':'')}>
                <input type="radio" name="ppm-upsell" disabled={!canEdit} checked={editing.configuration.upsell.method===value} onChange={()=>patch({upsell:{...editing.configuration.upsell,method:value,trigger:'delivered',ruleVersion:2}})}/><span>{label}</span>
              </label>)}</div>
            {(editing.configuration.upsell.method==='percent'||editing.configuration.upsell.method==='fixed')&&
              <label className="field ppm-input"><span className="lab">{editing.configuration.upsell.method==='percent'?'Pourcentage du prix unitaire (%)':'Montant fixe upsell (DA)'}</span>
                <input type="number" disabled={!canEdit} min={0} max={editing.configuration.upsell.method==='percent'?100:10000000} value={editing.configuration.upsell.rate} onChange={e=>patch({upsell:{...editing.configuration.upsell,rate:nn(e.target.value)}})}/></label>}
            <p className="agx-note">{editing.configuration.upsell.method==='double'?'Double : si QTY livrée > QTY initiale, total = 2 × commission normale.':' '}
              {editing.configuration.upsell.method==='qty'?'QTY : prime supplémentaire = (QTY livrée − QTY initiale) × commission normale.':''}
              {editing.configuration.upsell.method==='percent'?'Pourcentage : prime supplémentaire = prix UNITAIRE produit × taux / 100. Jamais sur le total de commande.':''}
              {editing.configuration.upsell.method==='fixed'?'Fixe : une prime fixe par ligne produit avec quantité augmentée.':''}
              {' '}Prime générée uniquement après livraison, sans double paiement de la commission principale.</p>
          </>}
        </div>
        {planError&&<p className="form-err" role="alert">{planError}</p>}
        {error&&<p className="form-err" role="alert">{error}</p>}
        <div className="row agx-actions">
          <button type="button" className="btn primary" disabled={!canEdit||!!planError||save.isPending} onClick={saveCurrent}>Enregistrer</button>
          <button type="button" className="btn" disabled={!editing.id||clone.isPending} onClick={()=>clone.mutate({id:editing.id!},{onSuccess:()=>setEditing(null)})}>Dupliquer</button>
          <button type="button" className="btn" disabled={!editing.id||planLinked||remove.isPending} onClick={removeCurrent}>Supprimer</button>
        </div>
      </section>}
      {tab==='agent'&&<section className="card ppm-panel">
        <div className="ppm-row"><h2>Paie des agents</h2><label className="field"><span className="lab">Mois</span><input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label></div>
        {payroll.isLoading?<p>Chargement…</p>:payroll.error?<p className="form-err">{payroll.error.message}</p>:payroll.data&&<>
          {payroll.data.rows.map(row=><details key={row.id} className="ppm-payrow"><summary>{row.name} · {row.operations} opérations · <b>{currency(row.total)}</b></summary><BillLines lines={row.lines} total={row.total}/></details>)}
          {!payroll.data.rows.length&&<p>Aucune rémunération enregistrée pour ce mois.</p>}
          <h3>Total : {currency(payroll.data.total)}</h3>
          {payroll.data.closedAt?<p className="agx-note">Mois clôturé · {new Date(payroll.data.closedAt).toLocaleDateString('fr-FR')}</p>:
            <button className="btn" disabled={close.isPending||month>=ym()} onClick={()=>{if(confirm('Clôturer définitivement la paie de ce mois ?'))close.mutate({month})}}>Valider la paie</button>}
        </>}
      </section>}
    </>}
    {tab==='bonus'&&<>
      <section className="card ppm-panel">
        <div className="ppm-row"><div><h2>Bonus indépendants</h2><p className="muted">Créez des primes d'objectif, puis affectez-les dans Affectations.</p></div><button className="btn primary" onClick={newBonus}>+ Nouveau bonus</button></div>
        {bq.error&&<p className="form-err">{bq.error.message}</p>}
        <div className="ppm-cards">{bonuses.map(b=><button type="button" key={b.id} className={'ppm-plan-card '+(bonusEditing?.id===b.id?'on':'')} onClick={()=>selectBonus(b)}>
          <b>{b.name}</b><small>{b.kind==='billing'?'Facturation Seller':'Agent Pay'} · {currency(b.amount)}</small>
          {(bq.data?.assignments??[]).some(a=>a.bonusId===b.id)?<span className="ppm-pill">Affecté</span>:<span className="ppm-pill clear">Libre</span>}
        </button>)}</div>
      </section>
      {bonusEditing&&<section className="card ppm-panel">
        <div className="ppm-row"><h2>{bonusEditing.id?'Modifier le bonus':'Créer un bonus'}</h2>{bonusLinked&&<span className="ppm-pill">🔒 Affecté</span>}</div>
        {bonusLinked&&<p className="agx-note">Bonus affecté : dupliquez-le pour modifier les règles sans changer les objectifs historiques.</p>}
        <div className="ppm-grid">
          <label className="field"><span className="lab">Nom du bonus</span><input disabled={bonusLinked} value={bonusEditing.name} onChange={e=>setBonusEditing(b=>b?{...b,name:e.target.value}:b)}/></label>
          <label className="field"><span className="lab">Destinataire</span><select disabled={bonusLinked} value={bonusEditing.kind} onChange={e=>setBonusEditing(b=>b?{...b,kind:e.target.value as Kind}:b)}>
            <option value="billing">Facturation Seller</option><option value="agent">Agent Pay</option></select></label>
          <label className="field"><span className="lab">Opérations comptabilisées</span><select disabled={bonusLinked} value={bonusEditing.trigger} onChange={e=>setBonusEditing(b=>b?{...b,trigger:e.target.value as 'confirmed'|'delivered'}:b)}>
            <option value="confirmed">Confirmées</option><option value="delivered">Livrées</option></select></label>
          <label className="field"><span className="lab">Objectif (opérations)</span><input type="number" min={1} disabled={bonusLinked} value={bonusEditing.threshold} onChange={e=>setBonusEditing(b=>b?{...b,threshold:int(e.target.value)}:b)}/></label>
          <label className="field"><span className="lab">Montant du bonus (DA)</span><input type="number" min={0} disabled={bonusLinked} value={bonusEditing.amount} onChange={e=>setBonusEditing(b=>b?{...b,amount:nn(e.target.value)}:b)}/></label>
        </div>
        <p className="muted">Le bonus est compté une seule fois par destinataire et par mois dès que le seuil est atteint. Un bonus Facturation Seller doit être accepté par le vendeur.</p>
        <div className="row agx-actions">
          <button className="btn primary" disabled={bonusLinked||saveBonus.isPending||!bonusEditing.name.trim()||bonusEditing.threshold<1} onClick={saveB}>Enregistrer</button>
          <button className="btn" disabled={!bonusEditing.id||cloneBonus.isPending} onClick={()=>cloneBonus.mutate({id:bonusEditing.id!},{onSuccess:()=>setBonusEditing(null)})}>Dupliquer</button>
          <button className="btn" disabled={!bonusEditing.id||bonusLinked||deleteBonus.isPending} onClick={()=>{if(confirm('Supprimer ce bonus non affecté ?'))deleteBonus.mutate({id:bonusEditing.id!},{onSuccess:()=>setBonusEditing(null)})}}>Supprimer</button>
        </div>
      </section>}
    </>}
    {tab==='assignment'&&<>
      <section className="card ppm-panel">
        <h2>Affectations</h2>
        <p className="muted">Associez les plans et bonus aux vendeurs et aux agents. Une proposition tarifaire vendeur reste en attente d'acceptation.</p>
        <div className="ppm-tabs sub">
          <button className={'ppm-tab '+(assignmentKind==='seller'?'on':'')} onClick={()=>setAssignmentKind('seller')}>Vendeurs</button>
          <button className={'ppm-tab '+(assignmentKind==='agent'?'on':'')} onClick={()=>setAssignmentKind('agent')}>Agents</button>
        </div>
      </section>
      {assignmentKind==='seller'?<>
        {contracts.isLoading?<p>Chargement vendeurs…</p>:contracts.error?<p className="form-err">{contracts.error.message}</p>:
          !(contracts.data??[]).length?<section className="card ppm-panel">Aucun contrat vendeur actif.</section>:
          contracts.data?.map(c=><section className="card ppm-panel" key={c.id}>
            <h3>{c.name}</h3>
            {[{id:0,name:'Plan général du contrat'},...c.products].map(prod=><div className="ppm-slot" key={prod.id}>
              <PlanAssignment label={prod.name} plans={plans.filter(p=>p.kind==='billing')} current={c.terms.find(t=>t.productId===prod.id&&t.status==='pending')?.planId??c.terms.find(t=>t.productId===prod.id&&t.status==='accepted')?.planId??null}
                onApply={id=>propose.mutate({linkId:c.id,productId:prod.id,planId:id})} busy={propose.isPending} action="Proposer au vendeur"/>
              {c.terms.filter(t=>t.productId===prod.id&&t.status==='pending').map(t=><small key={t.id} className="ppm-pending">En attente vendeur : {t.name}</small>)}
            </div>)}
            <BonusAssignments kind="seller" targetId={c.id} bonuses={bonuses.filter(b=>b.kind==='billing')} assignments={bq.data?.assignments??[]} onApply={(bonusId,enabled)=>assignBonus.mutate({targetKind:'seller',targetId:c.id,bonusId,enabled})} busy={assignBonus.isPending}/>
          </section>)}
      </>:<>
        {users.error&&<p className="form-err">{users.error.message}</p>}
        {!agentRows.length&&<section className="card ppm-panel">Aucun agent actif disponible.</section>}
        {agentRows.map(u=><section key={u.id} className="card ppm-panel">
          <h3>{u.name}</h3>
          <PlanAssignment label="Plan de rémunération" plans={plans.filter(p=>p.kind==='agent')}
            current={q.data?.assignments.find(a=>a.targetKind==='agent'&&a.targetId===u.id)?.planId??null}
            busy={assign.isPending} action="Affecter" onApply={id=>assign.mutate({targetKind:'agent',targetId:u.id,planId:id})}/>
          <BonusAssignments kind="agent" targetId={u.id} bonuses={bonuses.filter(b=>b.kind==='agent')} assignments={bq.data?.assignments??[]} onApply={(bonusId,enabled)=>assignBonus.mutate({targetKind:'agent',targetId:u.id,bonusId,enabled})} busy={assignBonus.isPending}/>
        </section>)}
      </>}
    </>}
  </div>;
}
function getPlanError(p:ManagementPlanConfig,name:string) {
  if(!name.trim())return 'Nom obligatoire';
  if(p.method==='percent'&&p.rate>100)return 'Pourcentage supérieur à 100 %';
  if(p.method==='tier'){const err=validatePriceBrackets(planPriceBrackets(p));if(err)return err}
  if(p.upsell.enabled&&['double','qty'].includes(p.upsell.method)&&p.method==='none')return 'Double / QTY nécessite une commission principale';
  if(p.upsell.enabled&&p.upsell.method==='percent'&&p.upsell.rate>100)return 'Pourcentage upsell supérieur à 100 %';
  if(p.upsell.enabled&&p.upsell.trigger!=='delivered')return 'Upsell toujours à la livraison';
  try{simulateManagementPlan(p,{productPrice:16950,operations:1,upsells:1,incrementalValue:1000,originalQty:1,deliveredQty:2})}catch(e){return e instanceof Error?e.message:'Configuration invalide'}
  return '';
}
function changeBound(all:{from:number;to:number|null;amount:number}[],i:number,field:'from'|'to',value:number){
  return all.map((t,j)=>j===i?{...t,[field]:value}:field==='from'&&j===i-1?{...t,to:value-1}:field==='to'&&j===i+1?{...t,from:value+1}:t);
}
function addRange(all:{from:number;to:number|null;amount:number}[]) {
  const prev=all[all.length-1],from=prev.from+10000;
  return [...all.slice(0,-1),{...prev,to:from-1},{from,to:null,amount:0}];
}
function removeRange(all:{from:number;to:number|null;amount:number}[],i:number){
  const next=all.filter((_,j)=>j!==i).map(x=>({...x}));
  if(i===0)next[0].from=0;else if(i===all.length-1)next[next.length-1].to=null;else next[i-1].to=all[i].to;
  return next;
}
function PlanAssignment({label,plans,current,onApply,busy,action}:{label:string;plans:Plan[];current:number|null;onApply:(id:number|null)=>void;busy:boolean;action:string}){
  const [value,setValue]=useState(current===null?'':String(current));
  useEffect(()=>setValue(current===null?'':String(current)),[current]);
  return <div className="ppm-assignment"><label className="field"><span className="lab">{label}</span><select value={value} disabled={busy} onChange={e=>setValue(e.target.value)}>
    <option value="">Aucun plan / retirer</option>{plans.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
  </select></label><button className="btn" disabled={busy} onClick={()=>onApply(value?Number(value):null)}>{action}</button></div>;
}
function BonusAssignments({kind,targetId,bonuses,assignments,onApply,busy}:{kind:TargetKind;targetId:number;bonuses:Bonus[];assignments:{targetKind:string;targetId:number;bonusId:number;status:string}[];onApply:(id:number,enabled:boolean)=>void;busy:boolean}){
  const active=assignments.filter(a=>a.targetKind===kind&&a.targetId===targetId);
  const [selected,setSelected]=useState('');
  return <div className="ppm-section">
    <h4>Bonus indépendants</h4>
    {active.map(a=><div className="ppm-bonus-active" key={a.bonusId}><span>{bonuses.find(b=>b.id===a.bonusId)?.name??'Bonus #'+a.bonusId} · {a.status==='pending'?'En attente vendeur':'Actif'}</span>
      <button className="btn small" disabled={busy} onClick={()=>onApply(a.bonusId,false)}>Retirer</button></div>)}
    <div className="ppm-assignment"><label className="field"><span className="lab">Ajouter un bonus</span><select value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">Sélectionner un bonus</option>{bonuses.filter(b=>!active.some(a=>a.bonusId===b.id)).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
    </select></label><button className="btn" disabled={busy||!selected} onClick={()=>{onApply(Number(selected),true);setSelected('')}}>Affecter</button></div>
  </div>;
}
