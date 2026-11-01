// Seller-initiated bonus offers. The agency decides, then independently offers a defined agent amount.
import { z } from 'zod';
import { proc, bad, forbidden, notFound } from '../rpc';
import { agencyAdmin } from './planledger';
import { num } from '../db';

const Id=z.number().int().positive();
const Amount=z.number().int().min(0).max(10000000);
const PositiveAmount=z.number().int().min(1).max(10000000);
const Kind=z.enum(['billing','agent']);
const Trigger=z.enum(['confirmed','delivered']);
const Target=z.enum(['seller','agent']);

const isAgent=(r:any)=>!!r&&!!r.active&&!r.agency_id&&Array.isArray(r.roles)&&r.roles.some((x:string)=>['confirmation','suivi','agent_manager'].includes(x));
const now=(ctx:any)=>new Date(ctx.now()).toISOString();

/** The seller sees only requests for its OWN contract, and their current status. */
export async function sellerBonusTerms(t:{shop:(schema:string)=>{query:(sql:string,params?:unknown[])=>Promise<any[]>}},agencySchema:string,linkId:number){
  const rows=await t.shop(agencySchema).query(`
    SELECT b.id,b.name,b.trigger,b.threshold,b.amount,a.status
    FROM management_bonus_assignments a JOIN management_bonus_rules b ON b.id=a.bonus_id
    WHERE a.target_kind='seller' AND a.target_id=$1 ORDER BY b.id DESC`,[linkId]);
  return rows.map(b=>({id:num(b.id),name:String(b.name),trigger:b.trigger as 'confirmed'|'delivered',
    threshold:num(b.threshold),amount:num(b.amount),status:String(b.status)}));
}

export const bonusProcs={
  'management.bonuses':proc([],z.object({}),async ctx=>{
    agencyAdmin(ctx);
    const rules=await ctx.db.query('SELECT id,kind,name,trigger,threshold,amount,active,source_link_id,source_bonus_id FROM management_bonus_rules ORDER BY id DESC');
    const assignments=await ctx.db.query('SELECT target_kind,target_id,bonus_id,status FROM management_bonus_assignments ORDER BY target_kind,target_id');
    const requests=await ctx.db.query(`
      SELECT b.id,b.name,b.trigger,b.threshold,b.amount,a.status,b.source_link_id AS link_id,
        COALESCE(s.name,'Ancien vendeur') AS seller_name, l.status AS contract_status
      FROM management_bonus_rules b
      JOIN management_bonus_assignments a ON a.bonus_id=b.id AND a.target_kind='seller' AND a.target_id=b.source_link_id
      LEFT JOIN platform.agency_links l ON l.id=b.source_link_id AND l.agency_id=$1
      LEFT JOIN platform.shops s ON s.id=l.store_id
      WHERE b.source_link_id IS NOT NULL AND b.kind='billing'
      ORDER BY b.id DESC`,[ctx.shop!.id]);
    const offers=await ctx.db.query(`
      SELECT o.seller_bonus_id,o.agent_id,o.agent_bonus_id,b.amount,b.name,
        p.name AS agent_name FROM management_bonus_offers o
      JOIN management_bonus_rules b ON b.id=o.agent_bonus_id
      JOIN profiles p ON p.id=o.agent_id ORDER BY o.created_at DESC`);
    return {rules:rules.map(r=>({...r,id:num(r.id),threshold:num(r.threshold),amount:num(r.amount)})),
      assignments:assignments.map(r=>({targetKind:String(r.target_kind),targetId:num(r.target_id),bonusId:num(r.bonus_id),status:String(r.status)})),
      requests:requests.map(r=>({id:num(r.id),linkId:num(r.link_id),name:String(r.name),sellerName:String(r.seller_name),
        trigger:r.trigger as 'confirmed'|'delivered',threshold:num(r.threshold),amount:num(r.amount),
        status:String(r.status),contractStatus:String(r.contract_status??'ended')})),
      offers:offers.map(r=>({sellerBonusId:num(r.seller_bonus_id),agentId:num(r.agent_id),agentBonusId:num(r.agent_bonus_id),
        agentName:String(r.agent_name),name:String(r.name),amount:num(r.amount)}))};
  }),
  /** Seller creates a proposal, not the agency. Nothing is billable until the agency accepts. */
  'partners.requestBonus':proc([],z.object({linkId:Id,name:z.string().trim().min(1).max(100),
    trigger:Trigger,threshold:z.number().int().min(1).max(1000000),amount:PositiveAmount}),async(ctx,i)=>{
    if(!ctx.session.isAdmin||ctx.shop?.kind!=='store'||!ctx.t)throw forbidden('Réservé au vendeur du contrat');
    const t=ctx.t;
    const l=(await t.platform.query("SELECT l.id,s.schema_name FROM platform.agency_links l JOIN platform.shops s ON s.id=l.agency_id WHERE l.id=$1 AND l.store_id=$2 AND l.status='active' AND s.kind='agency'",[i.linkId,ctx.shop.id]))[0];
    if(!l)throw notFound('Contrat actif avec cette agence introuvable');
    return t.shop(l.schema_name).tx(async db=>{
      // Hold the contract row while creating its pending request.
      const active=(await db.query("SELECT 1 FROM platform.agency_links WHERE id=$1 AND store_id=$2 AND status='active' FOR UPDATE",[i.linkId,ctx.shop!.id]))[0];
      if(!active)throw bad('Ce contrat est terminé');
      const r=(await db.query("INSERT INTO management_bonus_rules(kind,name,trigger,threshold,amount,source_link_id) VALUES('billing',$1,$2,$3,$4,$5) RETURNING id",
        [i.name,i.trigger,i.threshold,i.amount,i.linkId]))[0];
      const id=num(r.id);
      await db.query("INSERT INTO management_bonus_assignments(target_kind,target_id,bonus_id,status) VALUES('seller',$1,$2,'pending')",[i.linkId,id]);
      return {id,status:'pending' as const};
    });
  }),
  /** Agency can accept or refuse only a SELLER-created request for an active contract. */
  'management.bonusRespond':proc([],z.object({linkId:Id,bonusId:Id,accept:z.boolean()}),async(ctx,i)=>{
    agencyAdmin(ctx);
    return ctx.db.tx(async db=>{
      const l=(await db.query("SELECT id FROM platform.agency_links WHERE id=$1 AND agency_id=$2 AND status='active' FOR UPDATE",[i.linkId,ctx.shop!.id]))[0];
      if(!l)throw notFound('Contrat vendeur actif introuvable');
      const r=(await db.query(`
        SELECT b.* FROM management_bonus_rules b
        JOIN management_bonus_assignments a ON a.bonus_id=b.id
        WHERE b.id=$1 AND b.kind='billing' AND b.source_link_id=$2 AND b.active
          AND a.target_kind='seller' AND a.target_id=$2 AND a.status='pending'
        FOR UPDATE OF a`,[i.bonusId,i.linkId]))[0];
      if(!r)throw notFound('Demande bonus en attente introuvable');
      const status=i.accept?'accepted':'rejected';
      await db.query("UPDATE management_bonus_assignments SET status=$3 WHERE target_kind='seller' AND target_id=$1 AND bonus_id=$2",
        [i.linkId,i.bonusId,status]);
      if(i.accept)await db.query(`
        INSERT INTO management_bonus_terms(target_kind,target_id,bonus_id,name,trigger,threshold,amount,enabled,effective_at)
        VALUES('seller',$1,$2,$3,$4,$5,$6,true,$7)`,
        [i.linkId,i.bonusId,r.name,r.trigger,r.threshold,r.amount,now(ctx)]);
      return {ok:true,status};
    });
  }),
  /** Agency chooses the agent and the amount. The seller amount is never silently reused as the salary bonus. */
  'management.bonusOfferAgent':proc([],z.object({linkId:Id,bonusId:Id,agentId:Id,amount:PositiveAmount}),async(ctx,i)=>{
    agencyAdmin(ctx);
    return ctx.db.tx(async db=>{
      const l=(await db.query("SELECT id FROM platform.agency_links WHERE id=$1 AND agency_id=$2 AND status='active' FOR UPDATE",[i.linkId,ctx.shop!.id]))[0];
      if(!l)throw notFound('Contrat actif introuvable');
      const request=(await db.query(`
        SELECT b.* FROM management_bonus_rules b JOIN management_bonus_assignments a
          ON a.bonus_id=b.id AND a.target_kind='seller' AND a.target_id=$2
        WHERE b.id=$1 AND b.kind='billing' AND b.source_link_id=$2 AND b.active AND a.status='accepted'
        FOR UPDATE OF a`,[i.bonusId,i.linkId]))[0];
      if(!request)throw bad("L'agence doit d'abord accepter la demande du vendeur");
      const agent=(await db.query('SELECT id,name,active,agency_id,roles FROM profiles WHERE id=$1 FOR UPDATE',[i.agentId]))[0];
      if(!isAgent(agent))throw bad('Agent actif de cette agence requis');
      if((await db.query('SELECT 1 FROM management_bonus_offers WHERE seller_bonus_id=$1 AND agent_id=$2',[i.bonusId,i.agentId])).length)
        throw bad('Ce bonus a déjà été proposé à cet agent');
      const name=String(request.name).slice(0,100);
      const b=(await db.query(`
        INSERT INTO management_bonus_rules(kind,name,trigger,threshold,amount,source_link_id,source_bonus_id)
        VALUES('agent',$1,$2,$3,$4,$5,$6) RETURNING id`,
        [name,request.trigger,request.threshold,i.amount,i.linkId,i.bonusId]))[0];
      const id=num(b.id);
      await db.query("INSERT INTO management_bonus_assignments(target_kind,target_id,bonus_id,status) VALUES('agent',$1,$2,'accepted')",[i.agentId,id]);
      await db.query(`
        INSERT INTO management_bonus_terms(target_kind,target_id,bonus_id,name,trigger,threshold,amount,enabled,effective_at)
        VALUES('agent',$1,$2,$3,$4,$5,$6,true,$7)`,
        [i.agentId,id,name,request.trigger,request.threshold,i.amount,now(ctx)]);
      await db.query('INSERT INTO management_bonus_offers(seller_bonus_id,agent_id,agent_bonus_id) VALUES($1,$2,$3)',
        [i.bonusId,i.agentId,id]);
      return {ok:true,id};
    });
  }),
  /** Read-only, per-agent visibility. Neither seller billing nor another agent's bonus leaks to this response. */
  'management.myBonuses':proc([],z.object({}),async ctx=>{
    if(ctx.shop?.kind!=='agency'||!ctx.session.profile.id)throw forbidden();
    const rows=await ctx.db.query(`
      SELECT b.id,b.name,b.trigger,b.threshold,b.amount,a.status
      FROM management_bonus_assignments a JOIN management_bonus_rules b ON b.id=a.bonus_id
      LEFT JOIN platform.agency_links l ON l.id=b.source_link_id AND l.agency_id=$2
      WHERE a.target_kind='agent' AND a.target_id=$1 AND a.status='accepted' AND b.active
        AND (b.source_link_id IS NULL OR l.status='active')
      ORDER BY b.id DESC`,[ctx.session.profile.id,ctx.shop!.id]);
    return {bonuses:rows.map(b=>({id:num(b.id),name:String(b.name),trigger:b.trigger as 'confirmed'|'delivered',
      threshold:num(b.threshold),amount:num(b.amount)}))};
  }),
  // Legacy CRUD is limited to already existing bonuses. New proposals MUST originate from sellers.
  'management.bonusSave':proc([],z.object({id:Id.optional(),kind:Kind,name:z.string().trim().min(1).max(100),
    trigger:Trigger,threshold:z.number().int().min(1).max(1000000),amount:Amount}),async(ctx,i)=>{
    agencyAdmin(ctx);
    throw bad('Les nouveaux bonus sont demandés par le vendeur; affectez ensuite une prime aux agents');
  }),
  'management.bonusClone':proc([],z.object({id:Id}),async ctx=>{
    agencyAdmin(ctx);
    throw bad('Les nouveaux bonus sont demandés par le vendeur');
  }),
  'management.bonusDelete':proc([],z.object({id:Id}),async(ctx,i)=>{
    agencyAdmin(ctx);
    return ctx.db.tx(async db=>{
      const rule=(await db.query('SELECT id,source_link_id FROM management_bonus_rules WHERE id=$1 AND active FOR UPDATE',[i.id]))[0];
      if(!rule)throw notFound('Bonus introuvable');
      if(rule.source_link_id!==null)throw bad('Les demandes vendeur et primes agent associées conservent leur historique');
      if((await db.query('SELECT 1 FROM management_bonus_assignments WHERE bonus_id=$1 LIMIT 1',[i.id])).length)
        throw bad('Retirez les affectations avant de supprimer');
      const history=(await db.query('SELECT 1 FROM management_bonus_terms WHERE bonus_id=$1 LIMIT 1',[i.id])).length>0;
      if(history)await db.query('UPDATE management_bonus_rules SET active=false,updated_at=now() WHERE id=$1',[i.id]);
      else await db.query('DELETE FROM management_bonus_rules WHERE id=$1',[i.id]);
      return {ok:true,archived:history};
    });
  }),
  /** Legacy bonus removal only: new seller requests cannot be sent from the agency. */
  'management.bonusAssign':proc([],z.object({targetKind:Target,targetId:Id,bonusId:Id,enabled:z.boolean()}),async(ctx,i)=>{
    agencyAdmin(ctx);
    if(i.enabled)throw bad("Les bonus proviennent du vendeur. Utilisez Offrir à l'agent après acceptation.");
    if(i.targetKind==='seller')throw bad('Une demande vendeur ne peut pas être retirée par une ancienne affectation');
    return ctx.db.tx(async db=>{
      const row=(await db.query(`
        SELECT b.* FROM management_bonus_assignments a JOIN management_bonus_rules b ON b.id=a.bonus_id
        WHERE a.target_kind='agent' AND a.target_id=$1 AND a.bonus_id=$2 AND a.status='accepted' FOR UPDATE OF a`,
        [i.targetId,i.bonusId]))[0];
      if(!row)return {ok:true,status:'removed'};
      await db.query("DELETE FROM management_bonus_assignments WHERE target_kind='agent' AND target_id=$1 AND bonus_id=$2",
        [i.targetId,i.bonusId]);
      await db.query(`
        INSERT INTO management_bonus_terms(target_kind,target_id,bonus_id,name,trigger,threshold,amount,enabled,effective_at)
        VALUES('agent',$1,$2,$3,$4,$5,$6,false,$7)`,
        [i.targetId,i.bonusId,row.name,row.trigger,row.threshold,row.amount,now(ctx)]);
      return {ok:true,status:'removed'};
    });
  }),
  /** Former reverse flow is explicitly disabled: sellers cannot approve agency-created bonus proposals. */
  'partners.decideBonus':proc([],z.object({linkId:Id,bonusId:Id,accept:z.boolean()}),async ctx=>{
    if(!ctx.session.isAdmin||ctx.shop?.kind!=='store')throw forbidden();
    throw bad('Le vendeur demande le bonus; seule son agence peut accepter ou refuser');
  }),
};
