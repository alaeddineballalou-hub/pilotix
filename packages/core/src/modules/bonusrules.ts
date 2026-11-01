// Independent bonuses are not embedded in plan templates. Changes are effective-dated.
import { z } from 'zod';
import { proc, bad, forbidden, notFound } from '../rpc';
import { agencyAdmin } from './planledger';
import { num } from '../db';

const Id=z.number().int().positive();
const Amount=z.number().int().min(0).max(10000000);
const Kind=z.enum(['billing','agent']);
const Trigger=z.enum(['confirmed','delivered']);
const Target=z.enum(['seller','agent']);

export const bonusProcs={
  'management.bonuses':proc([],z.object({}),async ctx=>{
    agencyAdmin(ctx);
    const rules=await ctx.db.query('SELECT id,kind,name,trigger,threshold,amount,active FROM management_bonus_rules ORDER BY id DESC');
    const assignments=await ctx.db.query('SELECT target_kind,target_id,bonus_id,status FROM management_bonus_assignments ORDER BY target_kind,target_id');
    return {rules:rules.map(r=>({...r,id:num(r.id),threshold:num(r.threshold),amount:num(r.amount)})),
      assignments:assignments.map(r=>({targetKind:String(r.target_kind),targetId:num(r.target_id),bonusId:num(r.bonus_id),status:String(r.status)}))};
  }),
  'management.bonusSave':proc([],z.object({id:Id.optional(),kind:Kind,name:z.string().trim().min(1).max(100),trigger:Trigger,threshold:z.number().int().min(1).max(1000000),amount:Amount}),async(ctx,i)=>{
    agencyAdmin(ctx);
    if(i.id){
      await ctx.db.tx(async db=>{
        const rule=(await db.query('SELECT kind,active FROM management_bonus_rules WHERE id=$1 FOR UPDATE',[i.id]))[0];
        if(!rule||!rule.active)throw notFound('Bonus introuvable');
        if(rule.kind!==i.kind)throw bad('Le type de bonus ne peut pas changer');
        const linked=(await db.query('SELECT 1 FROM management_bonus_assignments WHERE bonus_id=$1 LIMIT 1',[i.id])).length>0;
        if(linked)throw bad('Bonus affecté : dupliquez-le avant modification');
        await db.query('UPDATE management_bonus_rules SET name=$2,trigger=$3,threshold=$4,amount=$5,updated_at=now() WHERE id=$1',[i.id,i.name,i.trigger,i.threshold,i.amount]);
      });
      return {id:i.id};
    }
    const r=(await ctx.db.query('INSERT INTO management_bonus_rules(kind,name,trigger,threshold,amount) VALUES($1,$2,$3,$4,$5) RETURNING id',[i.kind,i.name,i.trigger,i.threshold,i.amount]))[0];
    return {id:num(r.id)};
  }),
  'management.bonusClone':proc([],z.object({id:Id}),async(ctx,i)=>{
    agencyAdmin(ctx);
    const r=(await ctx.db.query("INSERT INTO management_bonus_rules(kind,name,trigger,threshold,amount) SELECT kind,name || ' — Copie',trigger,threshold,amount FROM management_bonus_rules WHERE id=$1 RETURNING id",[i.id]))[0];
    if(!r)throw notFound('Bonus introuvable');
    return {id:num(r.id)};
  }),
  'management.bonusDelete':proc([],z.object({id:Id}),async(ctx,i)=>{
    agencyAdmin(ctx);
    return ctx.db.tx(async db=>{
      const rule=(await db.query('SELECT id FROM management_bonus_rules WHERE id=$1 AND active FOR UPDATE',[i.id]))[0];
      if(!rule)throw notFound('Bonus introuvable');
      if((await db.query('SELECT 1 FROM management_bonus_assignments WHERE bonus_id=$1 LIMIT 1',[i.id])).length)throw bad('Retirez les affectations avant de supprimer');
      const history=(await db.query('SELECT 1 FROM management_bonus_terms WHERE bonus_id=$1 LIMIT 1',[i.id])).length>0;
      if(history)await db.query('UPDATE management_bonus_rules SET active=false,updated_at=now() WHERE id=$1',[i.id]);
      else await db.query('DELETE FROM management_bonus_rules WHERE id=$1',[i.id]);
      return {ok:true,archived:history};
    });
  }),
  'management.bonusAssign':proc([],z.object({targetKind:Target,targetId:Id,bonusId:Id,enabled:z.boolean()}),async(ctx,i)=>{
    const t=agencyAdmin(ctx);
    return ctx.db.tx(async db=>{
      const rule=(await db.query('SELECT * FROM management_bonus_rules WHERE id=$1 AND active FOR UPDATE',[i.bonusId]))[0];
      if(!rule)throw notFound('Bonus introuvable');
      if(rule.kind!==(i.targetKind==='seller'?'billing':'agent'))throw bad('Bonus incompatible');
      if(i.targetKind==='agent'){
        const agent=(await db.query('SELECT id,active,agency_id,roles FROM profiles WHERE id=$1',[i.targetId]))[0];
        if(!agent||!agent.active||agent.agency_id||!agent.roles.some((r:string)=>['confirmation','suivi','agent_manager'].includes(r)))throw bad('Agent actif introuvable');
      }else{
        const seller=(await t.platform.query("SELECT id FROM platform.agency_links WHERE id=$1 AND agency_id=$2 AND status='active'",[i.targetId,ctx.shop!.id]))[0];
        if(!seller)throw notFound('Contrat vendeur actif introuvable');
      }
      const current=(await db.query('SELECT status FROM management_bonus_assignments WHERE target_kind=$1 AND target_id=$2 AND bonus_id=$3 FOR UPDATE',[i.targetKind,i.targetId,i.bonusId]))[0];
      if(i.enabled){
        if(current)return {ok:true,status:current.status as string};
        const status=i.targetKind==='seller'?'pending':'accepted';
        await db.query('INSERT INTO management_bonus_assignments(target_kind,target_id,bonus_id,status) VALUES($1,$2,$3,$4)',[i.targetKind,i.targetId,i.bonusId,status]);
        if(status==='accepted')await db.query('INSERT INTO management_bonus_terms(target_kind,target_id,bonus_id,name,trigger,threshold,amount,enabled,effective_at) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8)',[i.targetKind,i.targetId,i.bonusId,rule.name,rule.trigger,rule.threshold,rule.amount,new Date(ctx.now()).toISOString()]);
        return {ok:true,status};
      }
      if(!current)return {ok:true,status:'removed'};
      await db.query('DELETE FROM management_bonus_assignments WHERE target_kind=$1 AND target_id=$2 AND bonus_id=$3',[i.targetKind,i.targetId,i.bonusId]);
      if(current.status==='accepted')await db.query('INSERT INTO management_bonus_terms(target_kind,target_id,bonus_id,name,trigger,threshold,amount,enabled,effective_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8)',[i.targetKind,i.targetId,i.bonusId,rule.name,rule.trigger,rule.threshold,rule.amount,new Date(ctx.now()).toISOString()]);
      return {ok:true,status:'removed'};
    });
  }),
  // Seller consent: the owner of this seller workspace decides on bonus proposals for their contract.
  'partners.decideBonus':proc([],z.object({linkId:Id,bonusId:Id,accept:z.boolean()}),async(ctx,i)=>{
    if(!ctx.session.isAdmin||ctx.shop?.kind!=='store'||!ctx.t)throw forbidden();
    const l=(await ctx.t.platform.query("SELECT agency_id FROM platform.agency_links WHERE id=$1 AND store_id=$2 AND status='active'",[i.linkId,ctx.shop.id]))[0];
    if(!l)throw notFound('Contrat actif introuvable');
    const a=(await ctx.t.platform.query('SELECT schema_name FROM platform.shops WHERE id=$1',[l.agency_id]))[0];
    if(!a)throw notFound('Agence introuvable');
    return ctx.t.shop(a.schema_name).tx(async db=>{
      const row=(await db.query("SELECT a.bonus_id,b.* FROM management_bonus_assignments a JOIN management_bonus_rules b ON b.id=a.bonus_id WHERE a.target_kind='seller' AND a.target_id=$1 AND a.bonus_id=$2 AND a.status='pending' FOR UPDATE OF a",[i.linkId,i.bonusId]))[0];
      if(!row)throw notFound('Proposition bonus en attente introuvable');
      if(i.accept){
        await db.query("UPDATE management_bonus_assignments SET status='accepted' WHERE target_kind='seller' AND target_id=$1 AND bonus_id=$2",[i.linkId,i.bonusId]);
        await db.query('INSERT INTO management_bonus_terms(target_kind,target_id,bonus_id,name,trigger,threshold,amount,enabled,effective_at) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8)',['seller',i.linkId,i.bonusId,row.name,row.trigger,row.threshold,row.amount,new Date(ctx.now()).toISOString()]);
      }else{
        await db.query("DELETE FROM management_bonus_assignments WHERE target_kind='seller' AND target_id=$1 AND bonus_id=$2",[i.linkId,i.bonusId]);
      }
      return {ok:true};
    });
  }),
};
