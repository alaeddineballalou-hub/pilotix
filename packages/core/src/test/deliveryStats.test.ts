import assert from 'node:assert/strict';
import { before,test } from 'node:test';
import { call, Ctx, Db, setSetting } from '../index';
import { kfRange } from '@pilotix/shared';
import { EMAILS, setup } from './harness';
import { groupDeliveryRows, summarizeDeliveryRows } from '../modules/deliveryStats';
let db:Db;
let as:(email:string)=>Promise<Ctx>;
before(async()=>{({db,as}=await setup(300));});
const P={per:'30'} as const;
test('delivery statistics partition the dispatch cohort and preserve totals for every grouping',async()=>{
 const owner=await as(EMAILS.vendeur);
 const result=await call('suivi.stats',owner,P);
 const t=summarizeDeliveryRows(result.rows);
 const {a,b}=kfRange(owner.now(),P);
 const expected=await db.query('SELECT count(*)::int AS n FROM sales WHERE shipped_at >= $1 AND shipped_at < $2',[new Date(a).toISOString(),new Date(b).toISOString()]);
 assert.equal(t.sent,Number(expected[0].n));
 assert.equal(t.delivered,t.with+t.without);
 assert.equal(t.sent,t.delivered+t.returns+t.exchanges+t.active+t.other);
 for(const g of ['product','company','team'] as const){
   const list=groupDeliveryRows(result.rows,g);
   assert.equal(list.reduce((n,r)=>n+r.totals.sent,0),t.sent);
   assert.equal(list.reduce((n,r)=>n+r.totals.delayN,0),t.delayN);
   assert.equal(list.reduce((n,r)=>n+r.totals.attemptsN,0),t.attemptsN);
 }
});
test('ordinary agents cannot retrieve delivery statistics; manager is limited to their own assigned team',async()=>{
 const agent=await as(EMAILS.suivi);
 await assert.rejects(call('suivi.stats',agent,P));
 const manager=await as(EMAILS.manager);
 const m=manager.session.profile.id;
 const a=agent.session.profile.id;
 await setSetting(db,'teams',[{id:'test-team',name:'Test team',managerId:m,agentIds:[a]}]);
 const result=await call('suivi.stats',manager,P);
 const range=kfRange(manager.now(),P);
 const expected=await db.query('SELECT count(*)::int AS n FROM sales WHERE shipped_at >= $1 AND shipped_at < $2 AND follow_agent_id=ANY($3::bigint[])',[new Date(range.a).toISOString(),new Date(range.b).toISOString(),[m,a]]);
 assert.equal(summarizeDeliveryRows(result.rows).sent,Number(expected[0].n));
});
