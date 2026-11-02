import { planPriceBrackets, type ManagementPlanConfig } from '@pilotix/shared';
const da=(n:number)=>n.toLocaleString('fr-FR')+' DA';
export function PlanSummary({plan:p}:{plan:ManagementPlanConfig|null}) {
  if(!p)return <p>Tarif historique du contrat. Si un produit n'a pas de tarif particulier, le plan général s'applique.</p>;
  const brackets=planPriceBrackets(p);
  const main=p.method==='fixed'?da(p.rate):p.method==='percent'?p.rate+' % du prix unitaire produit':
    p.method==='tier'?brackets.map(b=>da(b.from)+' – '+(b.to===null?'∞':da(b.to))+' : '+da(b.amount)).join(' · '):'Sans prime par opération';
  const extra=p.agentTask==='suivi'||!p.upsell.enabled?'':p.upsell.method==='double'?'Double confirmation (une prime supplémentaire)':
    p.upsell.method==='qty'?'QTY (une prime par quantité supplémentaire livrée)':
    p.upsell.method==='percent'?p.upsell.rate+(p.upsell.ruleVersion===2?' % du prix unitaire du produit':' % de la valeur ajoutée (ancien)'):
    'Montant fixe '+da(p.upsell.rate);
  return <div className="small">
    {p.agentTask&&<p><b>{p.agentTask==='suivi'?'Plan de suivi':'Plan de confirmation'}</b> · Commandes attribuées à cet agent uniquement.</p>}
    <p><b>{p.method==='none'?'Salaire / forfait fixe':p.method==='tier'?'Système de paliers de prix':p.method==='fixed'?'Salaire + Prime fixe':'Salaire + Prime en pourcentage'}</b>
      {p.method!=='none'?' · '+(p.trigger==='confirmed'?'Confirmation':'Livraison'):''} : {main}</p>
    <p>Montant mensuel : {da(p.monthly)}{p.bonus.enabled?' · Bonus historique : '+da(p.bonus.amount)+' dès '+p.bonus.threshold+' opérations':''}</p>
    {p.agentTask!=='suivi'&&p.upsell.enabled&&<p><b>Upsell :</b> {extra} · {p.upsell.ruleVersion===2?'Uniquement à la livraison':'Selon les anciennes conditions acceptées'}</p>}
  </div>;
}
