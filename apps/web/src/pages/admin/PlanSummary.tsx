import type { ManagementPlanConfig } from '@pilotix/shared';
const da=(n:number)=>n.toLocaleString('fr-FR')+' DA';
export function PlanSummary({plan:p}:{plan:ManagementPlanConfig|null}) {
  if(!p)return <p>Tarif historique du contrat. Pour un produit, le plan général du contrat s’applique s’il existe.</p>;
  const b=p.thresholds??[10000,20000];
  return <div className="small">
    <p>{p.method==='none'?'Forfait uniquement':`${p.trigger==='confirmed'?'À la confirmation':'À la livraison'} : `}{p.method==='fixed'?da(p.rate):p.method==='percent'?`${p.rate} % du prix produit`:p.method==='tier'?`Prix < ${da(b[0])} : ${da(p.tiers[0])} · Prix < ${da(b[1])} : ${da(p.tiers[1])} · Au-delà : ${da(p.tiers[2])}`:''}</p>
    <p>Forfait mensuel : {da(p.monthly)}{p.bonus.enabled?` · Prime : ${da(p.bonus.amount)} dès ${p.bonus.threshold} opérations`:''}</p>
    {p.upsell.enabled&&<p>Upsell {p.upsell.trigger==='confirmed'?'à la confirmation':'à la livraison'} : {p.upsell.method==='double'?'une commission de confirmation supplémentaire':p.upsell.method==='percent'?`${p.upsell.rate} % de la valeur ajoutée`:da(p.upsell.rate)}</p>}
  </div>;
}
