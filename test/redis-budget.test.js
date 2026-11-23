import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeRedis} from '../test-support/fake-redis.js';
import {redis} from '../lib/store.js';
import {admin} from '../lib/security.js';
import {saveListings,storedListings,inspectRedis,backupListings,restoreListings,listingKey,regionKey} from '../lib/listing-store.js';
import {checkApifyBudget} from '../lib/apify-budget.js';
import {startCollection,collectionStatus,ACTOR_ID} from '../lib/collection.js';
import {buildConditions} from '../lib/conditions.js';
import {handleSearch} from '../api/search.js';
const env={ADMIN_API_KEY:'fake-administrator-key-long-enough',APIFY_TOKEN:'fake',ENABLE_LIVE_COLLECTION:'true',UPSTASH_REDIS_REST_URL:'https://redis.example',UPSTASH_REDIS_REST_TOKEN:'fake'};
const req={headers:{authorization:`Bearer ${env.ADMIN_API_KEY}`}};
const c=(location='서울 관악구')=>buildConditions(`${location} 원룸`,null);
const cycle={startAt:new Date(Date.now()-86400000).toISOString(),endAt:new Date(Date.now()+86400000*30).toISOString()};
const limits=(spent=0,hard=5)=>({data:{monthlyUsageCycle:cycle,limits:{maxMonthlyUsageUsd:hard},current:{monthlyUsageUsd:spent}}});
const ok=data=>({ok:true,json:async()=>data});
const row=(extra={})=>({id:'real-id',rent:30,deposit:300,maintenance_cost:50000,address:'서울특별시 관악구 봉천동',room_type:'원룸',metadata:{scrapedAt:'2026-11-01T00:00:00Z'},...extra});
const mockedFetcher=({spent=0,hard=5,state='RUNNING',cost=.1,items=[row()],onStart=()=>{}}={})=>async(url,init)=>{
 if(url.endsWith('/users/me/limits'))return ok(limits(spent,hard));
 if(init?.method==='POST'){onStart();return ok({data:{id:'run123',actId:ACTOR_ID,status:'RUNNING'}});}
 if(url.includes('/actor-runs/'))return ok({data:{id:'run123',actId:ACTOR_ID,status:state,defaultDatasetId:'ds123',usageTotalUsd:cost,finishedAt:new Date().toISOString()}});
 if(url.includes('/datasets/'))return ok(items);
 throw Error('Unexpected request');
};
test('PING and SCAN report foreign keys without reading or deleting their values',async()=>{const db=new FakeRedis();db.write('foreign:key','private',null);const report=await inspectRedis(db);assert.equal(report.connected,true);assert.deepEqual(report.existingKeys,['foreign:key']);assert.equal(db.read('foreign:key'),'private');assert.deepEqual(db.calls.map(x=>x[0]),['PING','SCAN']);});
test('Redis authentication/network failures fail closed',async()=>{const db=redis(env,async()=>({ok:false,status:401}));await assert.rejects(db.command(['PING']));let calls=0;await assert.rejects(startCollection(c(),{req,env,store:{get:async()=>{throw Error('redis unavailable');}},fetcher:async()=>{calls++;}}));assert.equal(calls,0);});
test('listings persist without TTL and duplicates update prices but preserve first date',async()=>{const db=new FakeRedis();await saveListings(db,[row()],'서울특별시 관악구',{now:'2026-11-01T00:00:00Z'});await saveListings(db,[row({rent:40})],'서울특별시 관악구',{now:'2026-11-17T00:00:00Z'});const saved=await db.get(listingKey('real-id'));assert.equal(saved.rent,40);assert.equal(saved.fee,5);assert.equal(saved.monthlyTotal,45);assert.equal(saved.firstCollectedAt,'2026-11-01T00:00:00Z');assert.equal(saved.lastSeenAt,'2026-11-17T00:00:00Z');assert.equal(await db.command(['TTL',listingKey('real-id')]),-1);assert.equal(await db.command(['TTL',regionKey('서울특별시 관악구')]),-1);});
test('region search cache expires independently while listings and indexes remain',async()=>{const db=new FakeRedis();await saveListings(db,[row()],'서울특별시 관악구',{cacheTtl:60});db.now+=61000;assert.equal(await db.get('knuroom:cache:region:'+encodeURIComponent('서울특별시 관악구')),null);assert.equal((await storedListings(db,'서울특별시 관악구')).length,1);});
test('unseen listings are retained and marked stale',async()=>{const db=new FakeRedis();await saveListings(db,[row()],'서울특별시 관악구',{now:'2026-10-01T00:00:00Z'});await saveListings(db,[],'서울특별시 관악구');const items=await storedListings(db,'서울특별시 관악구',{now:Date.parse('2026-11-17T00:00:00Z')});assert.equal(items.length,1);assert.equal(items[0].syncStatus,'stale');});
test('broad/narrow region searches use persistent indexes without wrong-region matches',async()=>{const db=new FakeRedis();await saveListings(db,[row()],'서울특별시 관악구');assert.equal((await storedListings(db,'서울특별시')).length,1);assert.equal((await storedListings(db,'부산광역시')).length,0);});
test('JSON backup and restore only upsert KNU listings, keeping unrelated keys',async()=>{const db=new FakeRedis();await saveListings(db,[row()],'서울특별시 관악구',{now:'2026-11-02T00:00:00Z'});const backup=await backupListings(db);const other=new FakeRedis();other.write('other:data','untouched');assert.equal((await restoreListings(other,backup)).restored,1);assert.equal(other.read('other:data'),'untouched');assert.equal((await other.get(listingKey('real-id'))).fee,5);assert.equal(await other.command(['TTL',listingKey('real-id')]),-1);});
test('invalid entire backup is rejected before any writes',async()=>{const db=new FakeRedis();await assert.rejects(restoreListings(db,{format:'knuroom-listings-v1',listings:[{...row(),searchRegion:'서울 관악구'},{id:'bad',searchRegion:'없는시'}]}));assert.equal(db.data.size,0);});
for(const [spent,hard] of [[4.5,5],[4.2,5],[9,10],[8.490001,10],[0,10.01],[0,0]])test(`account usage ${spent}, hard limit ${hard} block Actor`,async()=>{let starts=0;await assert.rejects(startCollection(c(),{req,env,store:new FakeRedis(),fetcher:mockedFetcher({spent,hard,onStart:()=>starts++})}),e=>e.status===402);assert.equal(starts,0);});
test('bad usage response or absent billing cycle cannot execute Actor',async()=>{for(const data of [{},{data:{limits:{maxMonthlyUsageUsd:5},current:{monthlyUsageUsd:0}}}]){let calls=0;await assert.rejects(startCollection(c(),{req,env,store:new FakeRedis(),fetcher:async(url,init)=>{if(init?.method==='POST')calls++;return ok(data);}}));assert.equal(calls,0);}});
test('monthly reservations survive workers and block another concurrent region',async()=>{const db=new FakeRedis();let starts=0;const fetcher=mockedFetcher({spent:3.5,onStart:()=>starts++});const jobs=await Promise.allSettled([startCollection(c(),{req,env,store:db,fetcher}),startCollection(c('부산 금정구'),{req,env,store:db,fetcher})]);assert.equal(starts,1);assert.equal(jobs.filter(x=>x.status==='fulfilled').length,1);assert.equal(jobs.find(x=>x.status==='rejected').reason.status,409);});
test('settlement keeps the actual charge and respects a smaller explicit per-run cap',async()=>{
 const store=new FakeRedis();
 const config={...env,APIFY_MAX_COST_USD:'0.50'};
 let starts=0;
 const provider=mockedFetcher({spent:3.5,state:'SUCCEEDED',cost:.1,onStart:()=>starts++});
 const fetcher=(url,init)=>{
  if(init?.method==='POST')assert.equal(new URL(url).searchParams.get('maxTotalChargeUsd'),'0.5');
  return provider(url,init);
 };
 const options={req,env:config,store,fetcher};
 const job=await startCollection(c(),options);
 const saved=await store.get(`knuroom:collect:${job.jobId}`);
 assert.equal(Number(store.read(saved.reservation.ledger)),500000);
 await collectionStatus(job.jobId,options);
 assert.equal(Number(store.read(saved.reservation.ledger)),100000);
 assert.equal(store.read('knuroom:apify:active'),undefined);
 await startCollection(c('부산 금정구'),options);
 assert.equal(starts,2);
});
test('terminal Actor failure with confirmed zero cost releases reservation exactly once',async()=>{const db=new FakeRedis(),fetcher=mockedFetcher({state:'FAILED',cost:0});const job=await startCollection(c(),{req,env,store:db,fetcher});const stored=await db.get(`knuroom:collect:${job.jobId}`);await collectionStatus(job.jobId,{req,env,store:db,fetcher});await collectionStatus(job.jobId,{req,env,store:db,fetcher});assert.equal(Number(db.read(stored.reservation.ledger)),0);assert.equal(db.read('knuroom:apify:active'),undefined);});
test('unknown final charge or oversized charge retains active lock',async()=>{for(const cost of [null,1]){const db=new FakeRedis(),fetcher=mockedFetcher({state:'SUCCEEDED',cost});const job=await startCollection(c(),{req,env,store:db,fetcher});try{await collectionStatus(job.jobId,{req,env,store:db,fetcher});}catch(e){assert.equal(e.status,402);}assert.ok(db.read('knuroom:apify:active'));await assert.rejects(startCollection(c('부산 금정구'),{req,env,store:db,fetcher}),e=>e.status===409);}});
test('lost Actor start response stays locked beyond ordinary cache expiry',async()=>{const db=new FakeRedis();await assert.rejects(startCollection(c(),{req,env,store:db,fetcher:async(url,init)=>{if(init?.method==='POST')throw Error('lost response');return ok(limits());}}));db.now+=7200000;assert.ok(db.read('knuroom:apify:active'));await assert.rejects(startCollection(c('부산 금정구'),{req,env,store:db,fetcher:mockedFetcher()}),e=>e.status===409);});
test('completed Dataset is persisted and redis search works when collection budget exhausted',async()=>{const db=new FakeRedis(),fetcher=mockedFetcher({state:'SUCCEEDED'});const job=await startCollection(c(),{req,env,store:db,fetcher});await collectionStatus(job.jobId,{req,env,store:db,fetcher,includeItems:true});assert.ok(await db.get(listingKey('real-id')));let calls=0;const search=await handleSearch({query:'서울 관악구 원룸'},{req,env:{...env,ENABLE_LIVE_COLLECTION:'false'},store:db,fetcher:async()=>{calls++;throw Error('offline');}});assert.equal(search.data.dataSource,'redis');assert.equal(search.data.results.length,1);assert.equal(calls,0);});
test('every KNU-created key uses knuroom prefix and no destructive command exists',async()=>{const db=new FakeRedis();await saveListings(db,[row()],'서울특별시 관악구');await startCollection(c(),{req,env,store:db,fetcher:mockedFetcher()});assert.ok([...db.data.keys()].every(k=>k.startsWith('knuroom:')));assert.ok(!db.calls.some(a=>['FLUSHDB','FLUSHALL','KEYS'].includes(a[0])));});
test('unsafe policy environment settings fail closed',async()=>{
 for(const [monthly,stop] of [[10.01,9],[10,9.01],[0,1],[10,0],['NaN',2],[10,'NaN'],[5,6]]){
  const config={...env,APIFY_MONTHLY_BUDGET_USD:String(monthly),APIFY_SOFT_STOP_USD:String(stop)};
  assert.equal((await checkApifyBudget({env:config,fetcher:async()=>ok(limits(0,10))})).allowed,false);
 }
});

test('$9 stop includes outstanding Redis charges even when current account usage permits one more run', async()=>{
 const store=new FakeRedis();
 store.write(`knuroom:budget:${cycle.startAt}:reserved`,100000);
 let starts=0;
 const fetcher=mockedFetcher({hard:10,spent:8.49,onStart:()=>starts++});
 await assert.rejects(startCollection(c(),{req,env,store,fetcher}),{status:429});
 assert.equal(starts,0);
});


test('the default $1 daily cap blocks a second $0.51 reservation after the first finishes',async()=>{
 const store=new FakeRedis();
 let starts=0;
 const fetcher=mockedFetcher({spent:0,hard:10,state:'SUCCEEDED',cost:.51,onStart:()=>starts++});
 const options={req,env,store,fetcher};
 const job=await startCollection(c(),options);
 const saved=await store.get(`knuroom:collect:${job.jobId}`);
 assert.equal(Number(store.read(saved.reservation.ledger)),510000);
 await collectionStatus(job.jobId,options);
 assert.equal(store.read('knuroom:apify:active'),undefined);
 await assert.rejects(startCollection(c('부산 금정구'),options),{status:429});
 assert.equal(starts,1);
});

test('a new Actor requests 20 listings and its Dataset, job cache and Redis preserve all 20', async()=>{
 const store=new FakeRedis();
 const source=Array.from({length:24},(_,i)=>row({id:'room-'+(i+1)}));
 const provider=mockedFetcher({state:'SUCCEEDED',cost:.26,hard:10});
 let datasetReads=0,starts=0;
 const fetcher=async(url,init)=>{
  if(init?.method==='POST'){
   starts++;
   assert.equal(JSON.parse(init.body).maxResults,20);
   assert.equal(new URL(url).searchParams.get('maxTotalChargeUsd'),'0.51');
  }
  if(url.includes('/datasets/')){
   datasetReads++;
   const size=Number(new URL(url).searchParams.get('limit'));
   assert.equal(size,20);
   return ok(source.slice(0,size));
  }
  return provider(url,init);
 };
 const options={req,env,store,fetcher};
 const job=await startCollection(c(),options);
 const result=await collectionStatus(job.jobId,{...options,includeItems:true});
 const expected=source.slice(0,20).map(listing=>listing.id);
 assert.deepEqual(result.items.map(listing=>listing.id),expected);
 const saved=await storedListings(store,c().location);
 assert.deepEqual(saved.map(listing=>listing.id).sort(),[...expected].sort());
 const repeated=await collectionStatus(job.jobId,{...options,includeItems:true});
 assert.deepEqual(repeated.items.map(listing=>listing.id),expected);
 assert.equal(datasetReads,1);
 assert.equal(starts,1);
});


test('an existing ten-item job uses its original Dataset cap without starting a new Actor',async()=>{
 const store=new FakeRedis();
 const id='a'.repeat(64),conditions=c();
 const job={
  id,user:admin(req,env),runId:'oldRun',state:'SUCCEEDED',conditions,
  input:{maxResults:10},costSettled:true,
  run:{id:'oldRun',actId:ACTOR_ID,status:'SUCCEEDED',defaultDatasetId:'oldDataset'}
 };
 await store.set('knuroom:collect:'+id,job,3600);
 let reads=0;
 const source=Array.from({length:15},(_,i)=>row({id:'legacy-'+i}));
 const result=await collectionStatus(id,{req,env,store,includeItems:true,fetcher:async(url,init)=>{
  reads++;
  assert.equal(new URL(url).pathname,'/v2/datasets/oldDataset/items');
  assert.equal(new URL(url).searchParams.get('limit'),'10');
  assert.equal(init?.method||'GET','GET');
  // Retain the historical limit even if an upstream reply contains surplus rows.
  return ok(source);
 }});
 assert.equal(reads,1);
 assert.equal(result.maxResults,10);
 assert.equal(result.items.length,10);
 assert.equal((await storedListings(store,conditions.location)).length,10);
});
