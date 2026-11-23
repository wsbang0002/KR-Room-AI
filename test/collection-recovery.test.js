import test from 'node:test';
import assert from 'node:assert/strict';
import {activeCollectionStatus,collectionStatus,ACTOR_ID} from '../lib/collection.js';
import {reserveMonthly,SETTLE} from '../lib/monthly-budget.js';
import {listingKey} from '../lib/listing-store.js';
import {admin} from '../lib/security.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env={ADMIN_API_KEY:'fake-local-admin-key-over-24-characters',APIFY_TOKEN:'unused-local-token'};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
const id='12'.repeat(32),key='knuroom:collect:'+id,lock='knuroom:apify:active';
const rows=[{id:'test-listing',rent:25,maintenance_cost:50000}];
const response=body=>({ok:true,json:async()=>body});
const offline=()=>{throw new Error('upstream unavailable');};
const run=(status='SUCCEEDED',usageTotalUsd=.13)=>({
 id:'testRun',actId:ACTOR_ID,status,defaultDatasetId:'testDataset',usageTotalUsd
});

async function fixture(extra={}){
 const store=new FakeRedis(),requestId='test-request';
 const job={id,requestId,user:admin(req,env),state:'RUNNING',runId:'testRun',
  createdAt:new Date(store.now).toISOString(),conditions:{location:'서울특별시 관악구'},input:{maxResults:20},...extra};
 const budget={cycle:{startAt:new Date(store.now-60_000).toISOString(),endAt:new Date(store.now+86_400_000).toISOString()},
  spentUsd:0,appStopUsd:4.5};
 const {job:saved}=await reserveMonthly(store,{key,job,budget,cfg:{max:.51},now:store.now});
 const status=(fetcher,options={})=>collectionStatus(id,{req,env,store,fetcher,includeItems:true,...options});
 return {store,job:saved,status};
}

test('stale active lookups never contact Apify for a missing, changed, or foreign collection receipt',async()=>{
 for(const change of ['missing','replaced','foreign','new-lock']){
  const {store,job,status}=await fixture();
  if(change==='missing')store.data.delete(key);
  if(change==='replaced')await store.set(key,{...job,requestId:'other'},3600);
  if(change==='foreign')await store.set(key,{...job,user:'other'},3600);
  if(change==='new-lock')store.write(lock,'other');
  const result=await status(()=>assert.fail('unexpected upstream request'),{expectedRequestId:job.requestId});
  assert.deepEqual(result,{state:'UNIDENTIFIED'});
 }
});

test('an uncertain start uses only the recorded reverse index and verifies the Actor before recovering its ID',async()=>{
 const {store,job,status}=await fixture({runId:null,state:'START_UNCONFIRMED'});
 const forbidden=()=>assert.fail('no known run');
 const ordinary=await status(forbidden);
 assert.equal(ordinary.createdAt,job.createdAt);
 assert.equal(ordinary.costSettled,false);
 assert.ok(!store.calls.some(c=>c[0]==='SCAN'));
 const context={req,env,store};
 const unknown=await activeCollectionStatus({...context,fetcher:forbidden});
 assert.equal(unknown.state,'START_UNCONFIRMED');
 assert.equal(unknown.createdAt,job.createdAt);
 store.write('knuroom:apify:run:testRun',JSON.stringify({jobId:id,requestId:job.requestId}),86400);
 await assert.rejects(activeCollectionStatus({...context,fetcher:()=>response({data:{...run(),actId:'differentActor'}})}),{status:502});
 assert.equal((await store.get(key)).runId,null);
 const calls=[];
 const result=await activeCollectionStatus({...context,fetcher:(url,init)=>{
  calls.push([new URL(url).pathname,init.method||'GET']);
  return response(url.includes('/datasets/')?rows:{data:run()});
 }});
 assert.deepEqual(calls,[['/v2/actor-runs/testRun','GET'],['/v2/datasets/testDataset/items','GET']]);
 assert.equal(result.runId,'testRun');
 assert.equal(result.costSettled,true);
 assert.equal((await store.get(listingKey(rows[0].id))).runId,'testRun');
});

test('unavailable Dataset or interrupted write retains lock; staged data finishes offline before settlement',async()=>{
 const {store,job,status}=await fixture();
 await assert.rejects(status(url=>url.includes('/datasets/')?offline():response({data:run()})));
 assert.equal(store.read(lock),job.requestId);
 assert.equal((await store.get(key)).items,undefined);
 const command=store.command.bind(store);
 let interrupt=true;
 store.command=async args=>{
  if(interrupt&&args[0]==='EVAL'&&args[1].includes('item.firstCollectedAt')){
   interrupt=false;
   await command(args);
   throw Error('lost acknowledgement after first listing upsert');
  }
  if(args[1]===SETTLE){
   assert.deepEqual((await store.get(key)).items.map(r=>r.id),['test-listing']);
   assert.equal((await store.get(listingKey('test-listing'))).runId,'testRun');
  }
  return command(args);
 };
 await assert.rejects(status(url=>{
  assert.ok(url.includes('/datasets/'));return response(rows);
 },{includeItems:false}),/lost acknowledgement/);
 assert.equal(store.read(lock),job.requestId);
 assert.equal((await store.get(key)).pendingItems.length,1);
 const complete=await status(()=>assert.fail('staged payload and cost are already known'));
 assert.equal(complete.costSettled,true);
 assert.equal(complete.items.length,1);
 assert.equal(await store.command(['TTL',listingKey('test-listing')]),-1);
 assert.equal(store.read(lock),undefined);
});

test('a lost settlement response is idempotent and retry serves saved items without external access',async()=>{
 const {store,job,status}=await fixture();
 const command=store.command.bind(store);
 let interrupted=false;
 store.command=async args=>{
  const reply=await command(args);
  if(args[1]===SETTLE&&!interrupted){interrupted=true;throw Error('lost settlement acknowledgement');}
  return reply;
 };
 await assert.rejects(status(url=>response(url.includes('/datasets/')?rows:{data:run()})),/lost settlement acknowledgement/);
 assert.equal(store.read(lock),undefined);
 assert.equal((await store.get(key)).costSettled,true);
 const recovered=await status(()=>assert.fail('no upstream request'));
 assert.equal(recovered.costSettled,true);
 assert.equal(recovered.items.length,1);
 assert.equal(Number(store.read(job.reservation.ledger)),130000);
});

test('terminal results remain available through missing and excessive charges, including an upstream outage',async()=>{
 for(const cost of [null,.52]){
  const {store,job,status}=await fixture();
  const initial=await status(url=>response(url.includes('/datasets/')?rows:{data:run('SUCCEEDED',cost)}));
  assert.equal(initial.costSettled,false);
  assert.deepEqual(initial.items.map(r=>r.id),['test-listing']);
  const cached=await status(offline);
  assert.deepEqual(cached.items,initial.items);
  assert.equal(store.read(lock),job.requestId);
  if(cost===null){
   const settled=await status(url=>{
    assert.ok(url.includes('/actor-runs/'));return response({data:run()});
   });
   assert.equal(settled.costSettled,true);
   assert.equal(store.read(lock),undefined);
  }else assert.equal(cached.settlementIssue,'COST_EXCEEDS_RESERVATION');
 }
});

function deferred(){
 let resolve;
 const promise=new Promise(done=>{resolve=done;});
 return {promise,resolve};
}

test('a late running response cannot regress the terminal job, its stored listings, or run index',async()=>{
 const {store,job,status}=await fixture();
 const waiting=deferred(),resume=deferred();
 const slow=status(async()=>{waiting.resolve();await resume.promise;return response({data:run('RUNNING',null)});});
 await waiting.promise;
 const finished=await status(url=>response(url.includes('/datasets/')?rows:{data:run()}));
 resume.resolve();
 assert.deepEqual(await slow,finished);
 assert.equal((await store.get('knuroom:apify:run:testRun')).state,'SUCCEEDED');
 assert.equal(Number(store.read(job.reservation.ledger)),130000);
});

test('a stale Dataset write cannot recreate an expired job or write into another receipt',async()=>{
 for(const replace of [false,true]){
  const {store,job,status}=await fixture();
  const waiting=deferred(),resume=deferred(),command=store.command.bind(store);
  store.command=async args=>{
   if(args[0]==='EVAL'&&args[1].includes('item.firstCollectedAt')){waiting.resolve();await resume.promise;}
   return command(args);
  };
  const pending=status(url=>response(url.includes('/datasets/')?rows:{data:run()}));
  await waiting.promise;
  store.data.delete(key);
  if(replace)await store.set(key,{...job,requestId:'other',state:'READY'},3600);
  resume.resolve();
  await assert.rejects(pending,{status:409});
  assert.equal(store.read(lock),job.requestId);
  assert.equal(await store.get(listingKey('test-listing')),null);
  assert.deepEqual((await store.get(key))?.requestId,replace?'other':undefined);
 }
});

test('damaged or undersized ledgers preserve imported listings and retain the reservation and lock',async()=>{
 for(const balance of [null,'0','400000','broken','9007199254740992']){
  const {store,job,status}=await fixture();
  if(balance===null)store.data.delete(job.reservation.ledger);
  else store.write(job.reservation.ledger,balance);
  const result=await status(url=>response(url.includes('/datasets/')?rows:{data:run()}));
  assert.equal(result.settlementIssue,'INVALID_LEDGER');
  assert.equal(result.items.length,1);
  assert.equal(result.costSettled,false);
  assert.equal((await store.get(job.reservationKey)).settled,false);
  assert.equal(store.read(job.reservation.ledger),balance??undefined);
  assert.equal(store.read(lock),job.requestId);
 }
});
