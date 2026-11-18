import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import session from '../api/session.js';
import status from '../api/status.js';
import collect from '../api/collect.js';
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
 assert.equal((await call(collect,'POST',headers,{body:{query:'원주시 원룸'}})).code,401);
 assert.equal((await call(session,'DELETE',{...headers,...foreign})).code,403);
 const logout=await call(session,'DELETE',headers);
 assert.equal(logout.code,200);
 assert.equal(logout.headers['Cache-Control'],'no-store');
 assert.deepEqual(logout.body,{authenticated:false});
 assert.ok(logout.headers['Set-Cookie'].includes('Max-Age=0'));
 assert.deepEqual((await call(session,'GET',{cookie:cookieHeader(logout.headers['Set-Cookie'])})).body,{authenticated:false});
});

test('inventories, confirmed searches, conditions, and destinations accept a read-only session',async()=>{
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
