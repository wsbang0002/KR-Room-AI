import assert from 'node:assert/strict';
import test from 'node:test';
import status from '../api/status.js';
import {readCollectionBudget,startCollection} from '../lib/collection.js';
import {buildConditions} from '../lib/conditions.js';
import {admin} from '../lib/security.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env={
 ADMIN_API_KEY:'diagnostics-only-admin-credential',
 APIFY_TOKEN:'diagnostics-only-provider-credential',
 UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'diagnostics-redis-secret',
 ENABLE_LIVE_COLLECTION:'true',APIFY_MAX_COST_USD:'0.51',APIFY_DAILY_BUDGET_USD:'1',COLLECTION_DAILY_LIMIT:'2',
 APIFY_MONTHLY_BUDGET_USD:'10',APIFY_SOFT_STOP_USD:'9'
};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
const limitsUrl='https://api.apify.com/v2/users/me/limits';
const owner='private-active-reservation-id';

function fixture({count=0,daily=0,reserved=0,observed=0,active=false,spent=.152325265}={}){
 const now=Date.now();
 const cycle={startAt:new Date(now-86400_000).toISOString(),endAt:new Date(now+86400_000).toISOString()};
 const day=new Date(now).toISOString().slice(0,10);
 const user=admin(req,env),store=new FakeRedis(now);
 const entries=[
  [`knuroom:collect:count:${day}:${user}`,count],
  [`knuroom:collect:budget:${day}`,daily],
  [`knuroom:budget:${cycle.startAt}:reserved`,reserved],
  [`knuroom:budget:${cycle.startAt}:observed`,observed],
 ];
 for(const [key,value] of entries)if(value)store.write(key,String(value),3600);
 if(active)store.write('knuroom:apify:active',owner,3600);
 const calls=[];
 const fetcher=async(url,init={})=>{
  calls.push([url,init.method||'GET']);
  assert.equal(url,limitsUrl);
  assert.equal(init.method||'GET','GET');
  return Response.json({data:{limits:{maxMonthlyUsageUsd:10},current:{monthlyUsageUsd:spent},monthlyUsageCycle:cycle}});
 };
 return {opts:{req,env,fetcher,store,now},calls};
}

const cases=[
 ['AVAILABLE',{}],
 ['AVAILABLE',{count:1,daily:490000}],
 ['DAILY_BUDGET_LIMIT',{count:1,daily:500000}],
 ['DAILY_BUDGET_LIMIT',{count:1,daily:510000}],
 ['DAILY_COUNT_LIMIT',{count:2}],
 ['MONTHLY_BUDGET_LIMIT',{reserved:100000,observed:8400000}],
 ['MONTHLY_BUDGET_LIMIT',{spent:8.50}],
 ['ACTIVE',{active:true}]
];

test('a per-run reservation larger than the daily cap needs a settings change even on a fresh day',async()=>{
 const {opts}=fixture();
 const result=await readCollectionBudget({...opts,env:{...env,APIFY_DAILY_BUDGET_USD:'0.40'}});
 assert.equal(result.code,'DAILY_BUDGET_LIMIT');
 assert.match(result.message,/\$0\.51.*\$0\.40.*설정/);
 assert.doesNotMatch(result.message,/09:00/);
});

test('collection budget diagnosis identifies the limiting counter without starting an Actor or changing Redis data or TTLs',async()=>{
 for(const [code,seed] of cases){
  const {opts,calls}=fixture(seed);
  const dataBefore=new Map(opts.store.data),expiryBefore=new Map(opts.store.expires);
  const result=await readCollectionBudget(opts);
  assert.equal(result.code,code,JSON.stringify(seed));
  assert.equal(result.allowed,code==='AVAILABLE');
  assert.equal(typeof result.message,'string');assert.ok(result.message.trim().length);
  assert.deepEqual(calls,[[limitsUrl,'GET']]);
  // Inspect the actual Lua sent to Redis as well as the mock's resulting state.
  for(const [verb,script] of opts.store.calls){
   if(verb==='EVAL'){
    const commands=[...script.matchAll(/redis\.call\('([A-Z]+)'/g)].map(match=>match[1]);
    assert.ok(commands.length&&commands.every(command=>['GET','EXISTS'].includes(command)));
   }else assert.ok(['GET','EXISTS','MGET','TTL'].includes(verb),verb);
  }
  assert.deepEqual(opts.store.data,dataBefore);
  assert.deepEqual(opts.store.expires,expiryBefore);
  for(const secret of [env.APIFY_TOKEN,env.ADMIN_API_KEY,env.UPSTASH_REDIS_REST_TOKEN,owner]){
   assert.ok(!JSON.stringify(result).includes(secret));
  }
 }
});

test('the actual reservation still blocks the specific daily or monthly limit after an advisory read',async()=>{
 const regions=buildConditions('서울 관악구 원룸',null);
 for(const [code,seed,reason] of [
  ['DAILY_COUNT_LIMIT',{count:2},/DAILY_COUNT_LIMIT|횟수|건수|2회/],
  ['DAILY_BUDGET_LIMIT',{count:1,daily:500000},/DAILY_BUDGET_LIMIT|(?:일일|일별|하루|당일|오늘).*?(?:금액|비용|예산|\$0\.5)/],
  ['MONTHLY_BUDGET_LIMIT',{reserved:100000,observed:8400000},/MONTHLY_BUDGET_LIMIT|월간|월 관측|월 예산|월 한도/]
 ]){
  const {opts,calls}=fixture(seed);
  assert.equal((await readCollectionBudget(opts)).code,code);
  await assert.rejects(startCollection(regions,opts),error=>{
   assert.equal(error.status,429);
   assert.match(error.message,/BUDGET_EXHAUSTED/);
   assert.match(error.message,reason);
   return true;
  });
  assert.deepEqual(calls,[[limitsUrl,'GET'],[limitsUrl,'GET']]);
 }
});

test('an available diagnosis grants no reservation if a different collection starts before submission',async()=>{
 const {opts,calls}=fixture();
 assert.equal((await readCollectionBudget(opts)).code,'AVAILABLE');
 opts.store.write('knuroom:apify:active',owner,3600);
 await assert.rejects(startCollection(buildConditions('서울 관악구 원룸',null),opts),{status:409});
 assert.equal(opts.store.read('knuroom:apify:active'),owner);
 assert.deepEqual(calls,[[limitsUrl,'GET'],[limitsUrl,'GET']]);
});

test('the HTTP collection-budget scope authenticates before looking up usage and redacts the stored reservation owner',async t=>{
 for(const [key,value] of Object.entries(env)){
  const previous=process.env[key];process.env[key]=value;
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
 }
 const {opts,calls}=fixture({active:true});
 let redisReads=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  if(url!==env.UPSTASH_REDIS_REST_URL)return opts.fetcher(url,init);
  redisReads++;
  const command=JSON.parse(init.body);
  return Response.json({result:await opts.store.command(command)});
 });
 async function get(authorization){
  const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};
  await status({method:'GET',query:{scope:'collection-budget'},headers:{authorization}},response);
  return response;
 }
 for(const authorization of [undefined,'Bearer invalid']){
  assert.equal((await get(authorization)).code,401);
 }
 assert.equal(calls.length,0);assert.equal(redisReads,0);
 const response=await get(req.headers.authorization);
 assert.equal(response.code,200);assert.equal(response.body.code,'ACTIVE');
 assert.equal(response.body.allowed,false);
 assert.ok(redisReads>0);
 assert.deepEqual(calls,[[limitsUrl,'GET']]);
 assert.ok(!JSON.stringify(response.body).includes(owner));
});
