// Payment plans workspace for the Confirmation Agency. Templates, bonuses and assignments are separate.
import { useEffect, useState } from 'react';
import { agentPlanTask, DEFAULT_MANAGEMENT_PLAN, expandRoles, planPriceBrackets, simulateManagementPlan, type ManagementPlanConfig, type Role, validatePriceBrackets } from '@pilotix/shared';
import { useAction, useRpc } from '../../lib/query';
import { BillLines } from '../agency/parts';
import { PlanSummary } from './PlanSummary';
import pilotixLogo from '../../assets/logo-dark.svg';

type Kind='billing'|'agent';
type Tab=Kind|'bonus'|'assignment';
type Plan={id:number;kind:Kind;name:string;configuration:ManagementPlanConfig;active:boolean};
type TargetKind='seller'|'agent';
const currency=(n:number)=>Math.round(n).toLocaleString('fr-FR')+' DA';
const nn=(v:string)=>Math.max(0,Number(v)||0);
const int=(v:string)=>Math.floor(nn(v));
const copy=<T,>(x:T):T=>structuredClone(x);
const MODES=[['fixed','Salaire + Prime fixe'],['percent','Salaire + Prime en pourcentage'],['tier','Système de paliers de prix'],['none','Salaire fixe']] as const;
const UPS=[['double','Double confirmation'],['qty','QTY — Quantité supplémentaire'],['percent','Pourcentage du prix unitaire'],['fixed','Montant fixe']] as const;
const blankPlan=(kind:Kind):ManagementPlanConfig=>({...copy(DEFAULT_MANAGEMENT_PLAN),...(kind==='agent'?{agentTask:'confirmation' as const}:{}),bonus:{enabled:false,threshold:100,amount:0},upsell:{enabled:false,method:'double',rate:0,trigger:'delivered',ruleVersion:2}});
const editable=(p:ManagementPlanConfig):ManagementPlanConfig=>({...copy(p),ranges:copy(planPriceBrackets(p)),bonus:{...p.bonus,enabled:false},upsell:{...p.upsell,method:p.upsell.method==='qty'?'qty':p.upsell.method,trigger:'delivered',ruleVersion:2}});
const ym=()=>{const d=new Date(Date.now()+3600000);return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')};

/**
 * `only`: the tabs shown (Utilisateurs › Affectations: the agents' assignments; Facturation › Plans: the plans, the
 * bonuses and the sellers' plans); `bare`: no big header (inside another page); `noPayroll`: the agents' pay is in
 * Facturation › Agents; `assign`: which assignments (agents or sellers).
 */
export function AgencyPaymentPlans({initialKind='billing',only,bare=false,noPayroll=false,assign:assignOnly}:{initialKind?:Tab;only?:Tab[];bare?:boolean;noPayroll?:boolean;assign?:TargetKind}) {
  const [tab,setTab]=useState<Tab>(initialKind);
  const q=useRpc('management.plans',{});
  const bq=useRpc('management.bonuses',{});
  const contracts=useRpc('management.billingTargets',{});
  const users=useRpc('users.list',{activeOnly:true});
  const [month,setMonth]=useState(ym);
  const payroll=useRpc('management.payroll',{month},{enabled:!noPayroll&&(!only||only.includes('agent'))});
  const save=useAction('management.planSave',{success:'Plan enregistré'});
  const clone=useAction('management.planClone',{success:'Plan dupliqué'});
  const remove=useAction('management.planDelete',{success:r=>r.archived?'Plan archivé pour conserver les historiques':'Plan supprimé'});
  const assign=useAction('management.planAssign',{success:'Plan agent affecté'});
  const propose=useAction('management.billingPropose',{success:'Proposition envoyée au vendeur'});
  const close=useAction('management.payrollClose',{success:'Paie clôturée'});
  const respondBonus=useAction('management.bonusRespond',{success:'Réponse envoyée au vendeur'});
  const offerBonus=useAction('management.bonusOfferAgent',{success:'Prime proposée à l’agent : visible dans Mes bonus'});
  const [editing,setEditing]=useState<{id:number|null;kind:Kind;name:string;configuration:ManagementPlanConfig}|null>(null);
  const [bonusOfferValues,setBonusOfferValues]=useState<Record<number,{agentId:string;amount:string}>>({});
  const [assignmentKind,setAssignmentKind]=useState<TargetKind>(assignOnly??'seller');
  const [error,setError]=useState('');
  const plans=(q.data?.plans??[]).filter(p=>p.active) as Plan[];
  const selectedPlan=editing?plans.find(p=>p.id===editing.id):undefined;
  const planLinked=!!selectedPlan && (q.data?.blockedPlanIds??[]).includes(selectedPlan.id);
  const planHistorical=!!selectedPlan && (q.data?.historicPlanIds??[]).includes(selectedPlan.id);
  const requests=bq.data?.requests??[];
  const offers=bq.data?.offers??[];
  const planError=editing?getPlanError(editing.configuration,editing.name):'';
  const canEdit=!!editing&&!planLinked;
  const suiviPlan=editing?.kind==='agent'&&agentPlanTask(editing.configuration)==='suivi';
  const legacyReadOnly=!!planLinked&&!!selectedPlan&&selectedPlan.configuration.upsell.ruleVersion!==2;
  const patch=(change:Partial<ManagementPlanConfig>)=>{
    setEditing(p=>p?{...p,configuration:{...p.configuration,...change}}:p);setError('');
  };
  const selectPlan=(p:Plan)=>{const linked=(q.data?.blockedPlanIds??[]).includes(p.id);const config=p.kind==='agent'?{...p.configuration,agentTask:agentPlanTask(p.configuration)}:p.configuration;setEditing({id:p.id,kind:p.kind,name:p.name,configuration:linked?copy(config):editable(config)});setError('')};
  const newPlan=(kind:Kind)=>{setEditing({id:null,kind,name:'Nouveau plan',configuration:blankPlan(kind)});setError('')};
  const saveCurrent=()=>{if(!editing||planError||planLinked)return;save.mutate({...(editing.id?{id:editing.id}:{}),kind:editing.kind,name:editing.name,configuration:editing.configuration},{onSuccess:r=>setEditing(p=>p?{...p,id:r.id}:p)})};
  const removeCurrent=()=>{if(!editing?.id||planLinked)return;if(!confirm(planHistorical?'Archiver cette tarification de l’ancien contrat ? L’historique sera conservé.':'Supprimer cette tarification non affectée ?'))return;remove.mutate({id:editing.id},{onSuccess:()=>setEditing(null)})};
  useEffect(()=>{setEditing(null);setError('')},[tab]);
  const agentRows=(users.data??[]).filter(u=>u.roles.some(r=>['confirmation','suivi','agent_manager'].includes(r)));
  return <div className="ppm agx-page">
    {!bare&&<header className="ppm-head">
      <div className="ppm-brand"><img src={pilotixLogo} alt="Pilotix" className="ppm-real-logo"/><div><b>Plans de paiement</b><small>Confirmation Agency · Management</small></div></div>
      <span className="ppm-live">Pilotix</span>
    </header>}
    {(!only||only.length>1)&&<nav className="ppm-tabs" aria-label="Plans de paiement">
      {([['billing','Facturation Seller'],['agent','Agent Pay'],['bonus','Bonus'],['assignment',assignOnly==='seller'?'Affectations vendeurs':'Affectations']] as const).filter(([id])=>!only||only.includes(id)).map(([id,label])=>
        <button key={id} type="button" className={'ppm-tab '+(tab===id?'on':'')} onClick={()=>setTab(id)}>{label}</button>)}
    </nav>}
    {(tab==='billing'||tab==='agent')&&<>
      <section className="card ppm-panel">
        <div className="ppm-row"><div><h2>{tab==='billing'?'Plans Facturation Seller':'Plans Agent Pay'}</h2><p className="muted">{tab==='billing'?'Tarifs facturés aux contrats vendeurs':'Salaire et primes de votre équipe'}</p></div>
          <button type="button" className="btn primary" onClick={()=>newPlan(tab)}>+ Nouveau plan</button></div>
        {q.isLoading?<p>Chargement…</p>:q.error?<p className="form-err">{q.error.message}</p>:
          <div className="ppm-cards">{plans.filter(p=>p.kind===tab).map(p=>
            <button key={p.id} type="button" className={'ppm-plan-card '+(editing?.id===p.id?'on':'')} onClick={()=>selectPlan(p)}>
              <b>{p.name}</b>{p.kind==='agent'&&<small>{agentPlanTask(p.configuration)==='suivi'?'Plan de suivi':'Plan de confirmation'}</small>}<small>{MODES.find(m=>m[0]===p.configuration.method)?.[1]}</small>
              {(q.data?.blockedPlanIds??[]).includes(p.id)?
                <span className="ppm-pill">Affecté</span>:(q.data?.historicPlanIds??[]).includes(p.id)?
                <span className="ppm-pill clear">Ancien contrat</span>:<span className="ppm-pill clear">Libre</span>}
            </button>)}</div>}
      </section>
      {editing&&editing.kind===tab&&<section className="card ppm-panel">
        <div className="ppm-row"><h2>{editing.id?'Configuration du plan':'Nouveau plan'}</h2>{planLinked&&<span className="ppm-pill">🔒 Plan affecté</span>}</div>
        {planLinked&&<p className="agx-note">Ce plan est lié à un vendeur actif ou à un agent. Dupliquez-le pour modifier les tarifs.</p>}
        {!planLinked&&planHistorical&&<p className="agx-note">Ancien contrat : la tarification peut être archivée ; les factures passées restent intactes.</p>}
        {legacyReadOnly&&selectedPlan&&<div className="agx-note"><b>Conditions historiques acceptées (non modifiables)</b><PlanSummary plan={selectedPlan.configuration}/></div>}
        <div className="ppm-grid">
          <label className="field"><span className="lab">Nom du plan</span><input disabled={!canEdit} maxLength={100} value={editing.name} onChange={e=>setEditing(p=>p?{...p,name:e.target.value}:p)}/></label>
          {tab==='agent'&&<label className="field"><span className="lab">Type de plan Agent Pay</span><select disabled={!canEdit} value={agentPlanTask(editing.configuration)} onChange={e=>{
            const task=e.target.value as 'confirmation'|'suivi';
            patch({agentTask:task,...(task==='suivi'?{trigger:'delivered',upsell:{...editing.configuration.upsell,enabled:false,rate:0,trigger:'delivered',ruleVersion:2}}:{})});
          }}><option value="confirmation">Plan de confirmation</option><option value="suivi">Plan de suivi</option></select></label>}
          <label className="field"><span className="lab">Mode de calcul</span><select disabled={!canEdit} value={editing.configuration.method} onChange={e=>patch({method:e.target.value as ManagementPlanConfig['method']})}>
            {MODES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          {editing.configuration.method!=='none'&&!suiviPlan&&<label className="field"><span className="lab">Commission principale déclenchée</span><select disabled={!canEdit} value={editing.configuration.trigger} onChange={e=>patch({trigger:e.target.value as 'confirmed'|'delivered'})}>
            <option value="confirmed">Commande confirmée</option><option value="delivered">Commande livrée</option></select></label>}
          {suiviPlan&&<p className="agx-note">Une commission par commande livrée attribuée à cet agent en suivi.</p>}
          {(editing.configuration.method==='fixed'||editing.configuration.method==='percent')&&<label className="field"><span className="lab">{editing.configuration.method==='fixed'?(suiviPlan?'Prime fixe / commande livrée (DA)':'Prime fixe / opération (DA)'):'Prime (% du prix unitaire produit)'}</span>
            <input disabled={!canEdit} type="number" min={0} max={editing.configuration.method==='percent'?100:10000000} value={editing.configuration.rate} onChange={e=>patch({rate:nn(e.target.value)})}/></label>}
          <label className="field"><span className="lab">{tab==='agent'?'Salaire fixe mensuel (DA)':'Forfait mensuel vendeur (DA)'}</span>
            <input disabled={!canEdit} type="number" min={0} value={editing.configuration.monthly} onChange={e=>patch({monthly:nn(e.target.value)})}/></label>
        </div>
        {editing.configuration.method==='tier'&&<div className="ppm-section">
          <div className="ppm-row"><h3>Système de paliers de prix</h3><small>{planPriceBrackets(editing.configuration).length} paliers</small></div>
          <p className="muted">Limites modifiables · aucun trou ni chevauchement · dernier palier illimité. Le calcul utilise le prix unitaire du produit, jamais le total de la commande.</p>
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
        {!suiviPlan&&<div className="ppm-section">
          <div className="ppm-row"><h3>Prime Upsell</h3><span className="ppm-pill">{legacyReadOnly?'Conditions historiques':'Livrée uniquement'}</span></div>
          <label className="ppm-toggle"><input type="checkbox" disabled={!canEdit} checked={editing.configuration.upsell.enabled} onChange={e=>patch({upsell:{...editing.configuration.upsell,enabled:e.target.checked,trigger:'delivered',ruleVersion:2}})}/> Activer la prime Upsell</label>
          {editing.configuration.upsell.enabled&&<>
            <div className="ppm-up-modes">{UPS.map(([value,label])=>
              <label key={value} className={'ppm-up-mode '+(editing.configuration.upsell.method===value?'on':'')}>
                <input type="radio" name="ppm-upsell" disabled={!canEdit} checked={editing.configuration.upsell.method===value} onChange={()=>patch({upsell:{...editing.configuration.upsell,method:value,trigger:'delivered',ruleVersion:2}})}/><span>{legacyReadOnly&&value==='percent'?'Pourcentage de la valeur ajoutée (ancien)':label}</span>
              </label>)}</div>
            {(editing.configuration.upsell.method==='percent'||editing.configuration.upsell.method==='fixed')&&
              <label className="field ppm-input"><span className="lab">{editing.configuration.upsell.method==='percent'?'Pourcentage du prix unitaire (%)':'Montant fixe upsell (DA)'}</span>
                <input type="number" disabled={!canEdit} min={0} max={editing.configuration.upsell.method==='percent'?100:10000000} value={editing.configuration.upsell.rate} onChange={e=>patch({upsell:{...editing.configuration.upsell,rate:nn(e.target.value)}})}/></label>}
            <p className="agx-note">{editing.configuration.upsell.method==='double'?'Double : si QTY livrée > QTY initiale, total = 2 × commission normale.':' '}
              {editing.configuration.upsell.method==='qty'?'QTY : prime supplémentaire = (QTY livrée − QTY initiale) × commission normale.':''}
              {editing.configuration.upsell.method==='percent'?'Pourcentage : prime supplémentaire = prix UNITAIRE produit × taux / 100. Jamais sur le total de commande.':''}
              {editing.configuration.upsell.method==='fixed'?'Fixe : une prime fixe par ligne produit avec quantité augmentée.':''}
              {' '}Prime générée uniquement après livraison, sur la ligne produit concernée. Une confirmation déjà payée est conservée et n'est pas payée une deuxième fois.</p>
          </>}
        </div>}
        {tab==='agent'&&!suiviPlan&&<p className="agx-note">Commissions uniquement sur les commandes attribuées à cet agent en confirmation.</p>}
        {planError&&<p className="form-err" role="alert">{planError}</p>}
        {error&&<p className="form-err" role="alert">{error}</p>}
        <div className="row agx-actions">
          <button type="button" className="btn primary" disabled={!canEdit||!!planError||save.isPending} onClick={saveCurrent}>Enregistrer</button>
          <button type="button" className="btn" disabled={!editing.id||clone.isPending} onClick={()=>clone.mutate({id:editing.id!},{onSuccess:()=>setEditing(null)})}>Dupliquer</button>
          <button type="button" className="btn" disabled={!editing.id||planLinked||remove.isPending} onClick={removeCurrent}>{planHistorical?'Archiver':'Supprimer'}</button>
        </div>
      </section>}
      {tab==='agent'&&!noPayroll&&<section className="card ppm-panel">
        <div className="ppm-row"><h2>Paie des agents</h2><label className="field"><span className="lab">Mois</span><input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label></div>
        <p className="muted">Chaque plan rémunère uniquement les commandes attribuées à l’agent pour la confirmation ou le suivi.</p>
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
        <div className="ppm-row"><div>
          <h2>Demandes de bonus des vendeurs</h2>
          <p className="muted">Seul le vendeur crée la demande. L'agence peut l'accepter ou la refuser, puis définir la prime à proposer à un agent.</p>
        </div><span className="ppm-pill">{requests.filter(r=>r.status==='pending').length} en attente</span></div>
        {bq.isLoading&&<p>Chargement…</p>}
        {bq.error&&<p role="alert" className="form-err">{bq.error.message}</p>}
        {!bq.isLoading&&!requests.length&&<p className="agx-note">Aucune demande. Le vendeur peut envoyer sa proposition depuis Agences → son contrat.</p>}
      </section>
      {requests.map(r=><section className="card ppm-panel" key={r.id}>
        <div className="ppm-row">
          <div><h3>{r.name}</h3><p className="muted">{r.sellerName} · Objectif {r.threshold} commandes {r.trigger==='confirmed'?'confirmées':'livrées'} · Offre vendeur {currency(r.amount)}</p></div>
          <span className={'ppm-pill '+(r.status==='accepted'?'clear':'')}>{r.status==='pending'?'À décider':r.status==='accepted'?'Acceptée':'Refusée'}</span>
        </div>
        {r.status==='pending'&&r.contractStatus==='active'&&
          <div className="row agx-actions">
            <button className="btn" type="button" disabled={respondBonus.isPending} onClick={()=>respondBonus.mutate({linkId:r.linkId,bonusId:r.id,accept:false})}>Refuser</button>
            <button className="btn primary" type="button" disabled={respondBonus.isPending} onClick={()=>respondBonus.mutate({linkId:r.linkId,bonusId:r.id,accept:true})}>Accepter la demande</button>
          </div>}
        {r.status==='pending'&&r.contractStatus!=='active'&&<p className="agx-note">Contrat terminé : cette demande ne peut plus être acceptée.</p>}
        {r.status==='accepted'&&r.contractStatus==='active'&&<div className="ppm-section">
          <h4>Offrir un bonus à l'agent</h4>
          <p className="muted small">Le montant agent est indépendant de l'offre vendeur. Il est visible immédiatement dans son espace « Mes bonus » et calculé sur les opérations futures.</p>
          <div className="ppm-grid">
            <label className="field"><span className="lab">Agent</span>
              <select value={bonusOfferValues[r.id]?.agentId??''} onChange={e=>setBonusOfferValues(v=>({...v,[r.id]:{...v[r.id],agentId:e.target.value,amount:v[r.id]?.amount??''}}))}>
                <option value="">Sélectionner l'agent</option>
                {agentRows.filter(u=>!offers.some(o=>o.sellerBonusId===r.id&&o.agentId===u.id)).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
              </select></label>
            <label className="field"><span className="lab">Prime pour cet agent (DA)</span>
              <input type="number" min={1} max={10000000} value={bonusOfferValues[r.id]?.amount??''}
                onChange={e=>setBonusOfferValues(v=>({...v,[r.id]:{...v[r.id],agentId:v[r.id]?.agentId??'',amount:e.target.value}}))}/></label>
          </div>
          <button className="btn primary" type="button"
            disabled={offerBonus.isPending||!bonusOfferValues[r.id]?.agentId||!Number.isSafeInteger(Number(bonusOfferValues[r.id]?.amount))||Number(bonusOfferValues[r.id]?.amount)<1||Number(bonusOfferValues[r.id]?.amount)>10000000}
            onClick={()=>offerBonus.mutate({linkId:r.linkId,bonusId:r.id,agentId:Number(bonusOfferValues[r.id].agentId),amount:Number(bonusOfferValues[r.id].amount)})}>
            Offrir ce bonus à l'agent
          </button>
        </div>}
        {offers.filter(o=>o.sellerBonusId===r.id).map(o=><div key={o.agentBonusId} className="ppm-bonus-active">
          <span>{o.agentName} · {currency(o.amount)} · Bonus agent affecté</span><span className="ppm-pill clear">Visible par l'agent</span>
        </div>)}
      </section>)}
    </>}
    {tab==='assignment'&&<>
      <section className="card ppm-panel">
        <h2>{assignOnly==='agent'?'Affectations des agents':assignOnly==='seller'?'Affectations des vendeurs':'Affectations'}</h2>
        <p className="muted">{assignOnly==='agent'?'Le plan de paie et les bonus de chaque agent.':assignOnly==='seller'?'Le plan de chaque vendeur et de ses produits : il reste en attente jusqu’à son acceptation.':'Associez les plans et bonus aux vendeurs et aux agents. Une proposition tarifaire vendeur reste en attente d\'acceptation.'}</p>
        {!assignOnly&&<div className="ppm-tabs sub">
          <button className={'ppm-tab '+(assignmentKind==='seller'?'on':'')} onClick={()=>setAssignmentKind('seller')}>Vendeurs</button>
          <button className={'ppm-tab '+(assignmentKind==='agent'?'on':'')} onClick={()=>setAssignmentKind('agent')}>Agents</button>
        </div>}
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
            <div className="ppm-section"><h4>Bonus demandés par ce vendeur</h4>
              {requests.filter(r=>r.linkId===c.id).map(r=><p key={r.id} className="small">{r.name} · {currency(r.amount)} · {r.status==='accepted'?'Acceptée':r.status==='pending'?'En attente':'Refusée'}</p>)}
              {!requests.some(r=>r.linkId===c.id)&&<p className="muted small">Aucune demande de bonus.</p>}
            </div>
          </section>)}
      </>:<>
        {users.error&&<p className="form-err">{users.error.message}</p>}
        {!agentRows.length&&<section className="card ppm-panel">Aucun agent actif disponible.</section>}
        {agentRows.map(u=><section key={u.id} className="card ppm-panel">
          <h3>{u.name}</h3>
          <PlanAssignment label="Plan de rémunération" plans={plans.filter(p=>p.kind==='agent')} agentRoles={u.roles}
            current={q.data?.assignments.find(a=>a.targetKind==='agent'&&a.targetId===u.id)?.planId??null}
            busy={assign.isPending} action="Affecter" onApply={id=>assign.mutate({targetKind:'agent',targetId:u.id,planId:id})}/>
          <div className="ppm-section"><h4>Bonus visibles par l'agent</h4>
            {offers.filter(o=>o.agentId===u.id).map(o=><div className="ppm-bonus-active" key={o.agentBonusId}>
              <span>{o.name} · {currency(o.amount)}</span><span className="ppm-pill clear">Affecté</span>
            </div>)}
            {!offers.some(o=>o.agentId===u.id)&&<p className="muted small">Aucun bonus offert par l'agence.</p>}
          </div>
        </section>)}
      </>}
    </>}
  </div>;
}
function getPlanError(p:ManagementPlanConfig,name:string) {
  if(p.agentTask==='suivi'&&p.trigger!=='delivered')return 'Un plan de suivi est rémunéré à la livraison';
  if(p.agentTask==='suivi'&&p.upsell.enabled)return 'Les plans de suivi ne comptent pas les upsells';
  if(!name.trim()||name.length>100)return 'Nom obligatoire (maximum 100 caractères)';
  if([p.rate,p.monthly,p.upsell.rate,...planPriceBrackets(p).map(t=>t.amount)].some(v=>!Number.isFinite(v)||v<0||v>10000000))return 'Montant invalide (0 à 10 000 000 DA)';
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
function PlanAssignment({label,plans,current,onApply,busy,action,agentRoles}:{label:string;plans:Plan[];current:number|null;onApply:(id:number|null)=>void;busy:boolean;action:string;agentRoles?:Role[]}){
  const [value,setValue]=useState(current===null?'':String(current));
  useEffect(()=>setValue(current===null?'':String(current)),[current]);
  const incompatible=(p:Plan)=>p.kind==='agent'&&!!agentRoles&&!expandRoles(agentRoles).includes(agentPlanTask(p.configuration));
  return <div className="ppm-assignment"><label className="field"><span className="lab">{label}</span><select value={value} disabled={busy} onChange={e=>setValue(e.target.value)}>
    <option value="">Aucun plan / retirer</option>{plans.map(p=><option key={p.id} value={p.id} disabled={incompatible(p)}>{p.name}{p.kind==='agent'?' · '+(agentPlanTask(p.configuration)==='suivi'?'Suivi':'Confirmation'):''}{incompatible(p)?' (rôle incompatible)':''}</option>)}
  </select></label><button className="btn" disabled={busy||plans.some(p=>String(p.id)===value&&incompatible(p))} onClick={()=>onApply(value?Number(value):null)}>{action}</button></div>;
}
