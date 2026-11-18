import assert from 'node:assert/strict';
import test from 'node:test';
import {handleSearch} from '../api/search.js';
import {checkIntegrations} from '../lib/integrations.js';
import {statusData} from '../api/status.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env={
 AI_PROVIDER:'openrouter-free',OPENROUTER_API_KEY:'free-account-test-key',GEMINI_API_KEY:'different-provider-key',
 ADMIN_API_KEY:'local-only-admin-test-password',UPSTASH_REDIS_REST_URL:'https://redis.invalid',
 UPSTASH_REDIS_REST_TOKEN:'mock'
};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
const query='서울 관악구 원룸 월세 40만원';
const completion=ai=>Response.json({
 choices:[{finish_reason:'stop',message:{content:JSON.stringify(ai)}}]
});
const keyUrl='https://openrouter.ai/api/v1/key';
function options(generate,account=()=>Response.json({data:{is_free_tier:true}})){
 return {env,req,store:new FakeRedis(),fetcher:(url,init)=>url===keyUrl?account(url,init):generate(url,init)};
}

test('free search and admin check use only the zero-price route, ignore client overrides and reuse validated conditions',async()=>{
 const calls=[];
 const opts=options(async(url,init)=>{
  calls.push({url,init});
  return completion({location:'서울 관악구',maxRent:40,roomTypes:['ONE_ROOM']});
 });
 const result=await handleSearch({query,model:'paid-model',provider:'gemini'},opts);
 assert.equal(result.data.parser,'openrouter');
 assert.equal(result.data.conditions.maxRent,40);
 const check=await checkIntegrations({service:'openrouter'},opts);
 assert.equal(check.openrouter.parser,'openrouter-cache');
 assert.equal(check.openrouter.status,'verified');
 assert.equal(calls.length,1);
 const [{url,init}]=calls;
 assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
 assert.equal(init.redirect,'error');
 const body=JSON.parse(init.body);
 assert.equal(body.model,'openrouter/free');
 assert.equal(body.reasoning.effort,'none');
 assert.equal(body.provider.max_price.prompt,'0');
 assert.equal(body.provider.max_price.completion,'0');
 assert.equal(body.provider.max_price.request,'0');
 assert.equal(body.models,undefined);
 assert.equal(body.tools,undefined);
 assert.ok(!JSON.stringify(init).includes(env.GEMINI_API_KEY));
});

test('free provider quota failure results in local search with no second provider call',async()=>{
 let calls=0;
 const opts=options(async()=>{calls++;return Response.json({}, {status:429});});
 const result=await handleSearch({query},opts);
 assert.equal(result.data.parser,'local');
 assert.equal(result.data.conditions.maxRent,40);
 assert.equal(calls,1);
});

test('free mode fails closed with missing key or Redis and blocks Gemini diagnostics',async()=>{
 let calls=0;
 const opts=options(async()=>{calls++;throw Error('unexpected request');});
 const missingKey={...opts,env:{...env,OPENROUTER_API_KEY:''}};
 const missing=await checkIntegrations({service:'openrouter'},missingKey);
 assert.equal(missing.openrouter.status,'missing');
 assert.equal((await handleSearch({query},missingKey)).data.parser,'local');
 opts.store.reserve=async()=>{throw Error('Redis offline');};
 assert.equal((await checkIntegrations({service:'openrouter'},opts)).openrouter.status,'failed');
 assert.equal((await checkIntegrations({service:'gemini-interactions'},opts)).gemini.status,'blocked');
 assert.equal(calls,0);
});

test('diagnostic requires a real match to the control location and price',async()=>{
 const opts=options(async()=>completion({location:'서울 관악구',maxRent:70}));
 const check=await checkIntegrations({service:'openrouter'},opts);
 assert.equal(check.openrouter.status,'failed');
 assert.equal(check.openrouter.reason,'unexpected-conditions');
 const cfg=statusData(env);
 assert.equal(cfg.analysisProvider,'openrouter-free');
 assert.equal(cfg.openrouterConfigured,true);
 assert.ok(!JSON.stringify(cfg).includes(env.OPENROUTER_API_KEY));
});

test('paid, unspecified and unavailable account status block generation before the query is sent',async()=>{
 for(const response of [{data:{is_free_tier:false}},{data:{}},null]){
  let generated=0,inspected=0;
  const opts=options(async()=>{generated++;return completion({maxRent:40});},(url,init)=>{
   inspected++;
   assert.equal(init.body,undefined);
   assert.equal(init.redirect,'error');
   return response?Response.json(response):Response.json({}, {status:503});
  });
  const r=await handleSearch({query},opts);
  assert.equal(r.data.parser,'local');
  assert.equal(inspected,1);
  assert.equal(generated,0);
 }
});
