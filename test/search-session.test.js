import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import test from 'node:test';
import session from '../api/session.js';
import status from '../api/status.js';
import collect from '../api/collect.js';
import collectStatus from '../api/collect-status.js';
import listings from '../api/listings.js';
import integrations from '../api/integrations.js';
import inspectRedis from '../api/redis-inspect.js';
import {ACTOR_ID} from '../lib/collection.js';
import {handleConditions} from '../api/conditions.js';
import {handleSearch} from '../api/search.js';
import {handleWalking} from '../api/routes/walking.js';
import {searchDestinations} from '../lib/destinations.js';
import {inventoryOverview} from '../lib/inventory.js';
import {saveListings} from '../lib/listing-store.js';
import {issueSearchSession,searchSessionExpiry} from '../lib/search-session.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const secret=()=>randomBytes(24).toString('base64url');
const cookieHeader=cookie=>cookie.split(';')[0];
const host='kr-room-ai.vercel.app';

async function call(handler,method,headers={},extra={}){
 const response={
  headers:{},setHeader(key,value){this.headers[key]=value;},
  status(code){this.code=code;return this;},json(value){this.body=value;}
 };
 await handler({method,headers:{host,...headers},...extra},response);
 return response;
}

test('session login authenticates once and gives the browser a private one-hour cookie, cleared on logout',async t=>{
 const key=secret();
 const before={ADMIN_API_KEY:process.env.ADMIN_API_KEY,VERCEL:process.env.VERCEL};
 Object.assign(process.env,{ADMIN_API_KEY:key,VERCEL:'1'});
 t.after(()=>{for(const [name,value] of Object.entries(before)){
  if(value===undefined)delete process.env[name];else process.env[name]=value;
 }});
 const sameOrigin={origin:'https://'+host,'sec-fetch-site':'same-origin'};
 const credentials={...sameOrigin,authorization:'Bearer '+key};
 assert.deepEqual((await call(session,'GET')).body,{authenticated:false});
 for(const authorization of ['Bearer '+secret(),key,undefined]){
  const rejected=await call(session,'POST',{...sameOrigin,authorization});
  assert.equal(rejected.code,401);
  assert.equal(rejected.headers['Set-Cookie'],undefined);
 }
 const foreign={origin:'https://another.vercel.app','sec-fetch-site':'same-site'};
 assert.equal((await call(session,'POST',{...credentials,...foreign})).code,403);
 const login=await call(session,'POST',credentials);
 assert.equal(login.code,200);
 assert.equal(login.headers['Cache-Control'],'no-store');
 assert.equal(login.body.authenticated,true);
 assert.ok(login.body.expiresAt<=Date.now()+3600_000&&login.body.expiresAt>Date.now()+3590_000);
 const issued=login.headers['Set-Cookie'];
 for(const attribute of ['__Host-knu_search=','; Path=/','; HttpOnly','; Secure','; SameSite=Strict','; Max-Age=3600']){
  assert.ok(issued.includes(attribute));
 }
 assert.ok(!JSON.stringify(login).includes(key));
 const headers={...sameOrigin,cookie:cookieHeader(issued)};
 assert.deepEqual((await call(session,'GET',headers)).body,login.body);
 assert.equal((await call(status,'GET',headers,{query:{scope:'admin'}})).code,401);
 assert.equal((await call(integrations,'POST',headers,{body:{service:'storage'}})).code,401);
 assert.equal((await call(inspectRedis,'GET',headers)).code,401);
 assert.equal((await call(collect,'POST',headers,{body:{}})).code,400);
 assert.equal((await call(session,'DELETE',{...headers,...foreign})).code,403);
 const logout=await call(session,'DELETE',headers);
 assert.equal(logout.code,200);
 assert.equal(logout.headers['Cache-Control'],'no-store');
 assert.deepEqual(logout.body,{authenticated:false});
 assert.ok(logout.headers['Set-Cookie'].includes('Max-Age=0'));
 assert.deepEqual((await call(session,'GET',{cookie:cookieHeader(logout.headers['Set-Cookie'])})).body,{authenticated:false});
 assert.equal((await call(collect,'POST',{...sameOrigin,cookie:cookieHeader(logout.headers['Set-Cookie'])},{body:{}})).code,401);
});

test('inventories, confirmed searches, conditions, and destinations accept a homepage session',async()=>{
 const env={ADMIN_API_KEY:secret(),AI_PROVIDER:'openrouter-free',OPENROUTER_API_KEY:'mock-only',DATA_RIGHTS_REVIEWED:'false'};
 const req={headers:{cookie:cookieHeader(issueSearchSession(env).cookie)}};
 const region='강원특별자치도 원주시 무실동',query='원주시 무실동 원룸';
 const store=new FakeRedis();
 await saveListings(store,[{id:'private-sample',rent:30,deposit:500,fee:4,room_type:'원룸',address:region}],region);
 const options={req,env,store,fetcher:()=>assert.fail('private inventory test must stay offline')};
 let generations=0;
 const conditions=await handleConditions({query},{...options,fetcher:async(url,init)=>{
  if(url==='https://openrouter.ai/api/v1/key')return Response.json({data:{is_free_tier:true}});
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(JSON.parse(init.body).model.endsWith(':free'));
  generations++;
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({maxRent:40})}}]});
 }});
 assert.equal(conditions.interpretation.mode,'ai');
 assert.equal(generations,1);
 const result=await handleSearch({query,confirmedConditions:conditions.conditions},options);
 assert.deepEqual(result.data.results.map(room=>room.id),['private-sample']);
 assert.equal((await inventoryOverview(req,options)).regions[0].count,1);
 assert.equal((await searchDestinations({query:'강원대 원주캠퍼스'},options)).destinations[0].id,'knu-wonju');
 assert.equal((await handleWalking({listingId:'private-sample',destinationId:'knu-wonju'},options)).reason,'disabled');
 await assert.rejects(handleWalking({listingId:'private-sample',destinationId:'knu-wonju',diagnostic:true},options),{status:401});
 const anonymous={headers:{}};
 assert.deepEqual(await inventoryOverview(anonymous,options),{state:'private',regions:[]});
 await assert.rejects(handleSearch({query,confirmedConditions:conditions.conditions},{...options,req:anonymous}),{status:401});
});

test('only signed same-origin sessions or admin bearer credentials can start and resume a shared collection',async t=>{
 const env={ADMIN_API_KEY:secret(),VERCEL:'1',PUBLIC_SAVED_LISTINGS:'true',DATA_RIGHTS_REVIEWED:'true',
  ENABLE_LIVE_COLLECTION:'true',APIFY_TOKEN:'mock-apify',APIFY_MONTHLY_BUDGET_USD:'10',APIFY_SOFT_STOP_USD:'9',APIFY_MAX_COST_USD:'0.51',
  UPSTASH_REDIS_REST_URL:'https://collection-session.invalid',UPSTASH_REDIS_REST_TOKEN:'mock-redis'};
 for(const [name,value] of Object.entries(env)){
  const before=process.env[name];process.env[name]=value;
  t.after(()=>{if(before===undefined)delete process.env[name];else process.env[name]=before;});
 }
 const now=Date.now(),store=new FakeRedis(now);
 const cycle={startAt:new Date(now-86_400_000),endAt:new Date(now+86_400_000)};
 const calls=[];
 const run={id:'mockCollection',actId:ACTOR_ID,defaultDatasetId:'mockDataset',usageTotalUsd:.12};
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const path=new URL(url).pathname;
  calls.push({url,path,method:init.method||'GET'});
  if(url===env.UPSTASH_REDIS_REST_URL)return Response.json({result:await store.command(JSON.parse(init.body))});
  if(path==='/v2/users/me/limits')return Response.json({data:{
   limits:{maxMonthlyUsageUsd:10},current:{monthlyUsageUsd:0},monthlyUsageCycle:cycle}});
  if(path.includes('/acts/')&&init.method==='POST')return Response.json({data:{...run,status:'RUNNING'}});
  if(path==='/v2/actor-runs/mockCollection')return Response.json({data:{...run,status:'SUCCEEDED'}});
  if(path==='/v2/datasets/mockDataset/items')return Response.json([{id:'listing1',rent:32,address:'서울특별시 관악구 봉천동'}]);
  assert.fail('unexpected external service in mock: '+path);
 });
 const sameOrigin={origin:'https://'+host,'sec-fetch-site':'same-origin'};
 const cookie=cookieHeader(issueSearchSession(env).cookie);
 const signed={...sameOrigin,cookie};
 const expired=cookieHeader(issueSearchSession(env,now-7200_000).cookie);
 const rotated=cookieHeader(issueSearchSession({...env,ADMIN_API_KEY:secret()}).cookie);
 const invalid=cookie.slice(0,-1)+(cookie.endsWith('x')?'y':'x');
 for(const denied of [{},{cookie:expired},{cookie:invalid},{cookie:rotated},
   {...signed,origin:'https://unrelated.test'},{...signed,'sec-fetch-site':'same-site'},
   {...signed,'sec-fetch-site':'cross-site'},{...signed,authorization:'Bearer invalid'},
   {...signed,authorization:env.ADMIN_API_KEY}]){
  assert.equal((await call(collect,'POST',denied,{body:{}})).code,401);
  assert.equal((await call(collectStatus,'GET',denied)).code,401);
  assert.equal((await call(collectStatus,'GET',denied,{query:{active:'1'}})).code,401);
  assert.equal((await call(listings,'GET',denied)).code,401);
  assert.equal((await call(status,'GET',denied,{query:{scope:'collection-budget'}})).code,401);
 }
 assert.equal(calls.length,0);
 const budget=await call(status,'GET',signed,{query:{scope:'collection-budget'}});
 assert.equal(budget.code,200);assert.equal(budget.body.code,'AVAILABLE');
 const adminHeaders={authorization:'Bearer '+env.ADMIN_API_KEY};
 const query={body:{query:'서울 관악구 원룸'}};
 const started=await Promise.all([call(collect,'POST',adminHeaders,query),call(collect,'POST',signed,query)]);
 for(const reply of started)assert.equal(reply.code,202,JSON.stringify(reply.body));
 const {jobId,requestId}=started[0].body;
 assert.equal(started[1].body.jobId,jobId);assert.equal(started[1].body.requestId,requestId);
 assert.equal(started.filter(reply=>reply.body.cached).length,1);
 const legacyOwner=createHash('sha256').update(env.ADMIN_API_KEY).digest('hex').slice(0,20);
 assert.equal((await store.get('knuroom:collect:'+jobId)).user,legacyOwner);
 const active=await call(status,'GET',signed,{query:{scope:'collection-budget'}});
 assert.equal(active.body.code,'ACTIVE');
 // A fresh page only has its login cookie. Resume the old run without a receipt or search.
 const progress=await call(collectStatus,'GET',signed,{query:{active:'1'}});
 assert.equal(progress.code,200);assert.equal(progress.body.persistedCount,1);
 assert.equal(progress.body.jobId,jobId);
 assert.equal(progress.body.costSettled,true);
 assert.deepEqual((await call(collectStatus,'GET',adminHeaders,{query:{active:'1'}})).body,{state:'IDLE'});
 for(const access of [adminHeaders,signed]){
  const result=await call(listings,'GET',access,{query:{jobId}});
  assert.equal(result.code,200);
  assert.deepEqual(result.body.items.map(item=>item.id),['listing1']);
 }
 assert.equal(calls.filter(call=>call.path.includes('/acts/')&&call.method==='POST').length,1);
 assert.equal(calls.filter(call=>call.path.includes('/datasets/')).length,1);
});

test('expired, altered, cross-origin, or key-rotated session cookies cannot unlock searches',()=>{
 const now=Date.now(),env={ADMIN_API_KEY:secret(),VERCEL:'1'};
 const session=issueSearchSession(env,now);
 const cookie=cookieHeader(session.cookie);
 const req={headers:{cookie,host,origin:'https://'+host}};
 assert.equal(searchSessionExpiry(req,env,now),session.expiresAt);
 assert.equal(searchSessionExpiry(req,env,session.expiresAt),null);
 assert.equal(searchSessionExpiry(req,{...env,ADMIN_API_KEY:secret()},now),null);
 const altered=cookie.slice(0,-1)+(cookie.endsWith('a')?'b':'a');
 for(const headers of [{cookie:altered},{origin:'https://unrelated.test'},{'sec-fetch-site':'cross-site'}]){
  assert.equal(searchSessionExpiry({headers:{...req.headers,...headers}},env,now),null);
 }
});
