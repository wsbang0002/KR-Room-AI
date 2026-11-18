import test from 'node:test';
import assert from 'node:assert/strict';
import {checkIntegrations} from '../lib/integrations.js';
import {analyze} from '../lib/gemini.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const env={
 ADMIN_API_KEY:'mock-admin-key-for-local-tests', GEMINI_API_KEY:'mock', GEMINI_MODEL:'gemini-3.8-flash',
 UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'mock'
};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
function completed(text){
 return {status:'completed',steps:[
  {type:'thought',content:[{type:'text',text:'ignore'}]},
  {type:'model_output',content:[{type:'text',text}]}
 ]};
}

test('stateless Interactions extracts validated rental conditions and caches the result',async()=>{
 const store=new FakeRedis();
 let calls=0;
 const fetcher=async(url,init)=>{
  calls++;
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(init.headers['Api-Revision'],'2026-05-20');
  const body=JSON.parse(init.body);
  assert.equal(body.store,false);
  assert.equal(body.model,env.GEMINI_MODEL);
  assert.equal(body.generation_config.thinking_level,'low');
  assert.equal(body.response_format.mime_type,'application/json');
  return Response.json(completed('{"location":"서울특별시 관악구","maxRent":40}'));
 };
 const options={env,req,store,fetcher};
 const r=await checkIntegrations({service:'gemini-interactions'},options);
 assert.equal(r.gemini.parser,'gemini');
 const fromCache=await analyze('서울 관악구 원룸 월세 40만원',{...options,env:{...env,GEMINI_API_METHOD:'interactions'}});
 assert.equal(fromCache.parser,'gemini-cache');
 assert.equal(fromCache.ai.maxRent,40);
 assert.equal(calls,1);
});

test('incomplete Interactions output never passes validation or triggers a second call',async()=>{
 let calls=0;
 const result=await checkIntegrations({service:'gemini-interactions'},{
  env,req,store:new FakeRedis(),fetcher:async()=>{
   calls++;
   return Response.json({...completed('{"location":"서울 관악구","maxRent":40}'),status:'incomplete'});
  }
 });
 assert.equal(result.gemini.reason,'interaction-incomplete');
 assert.equal(calls,1);
});

test('upstream capacity message is classified without copying provider details',async()=>{
 const r=await checkIntegrations({service:'gemini-interactions'},{env,req,store:new FakeRedis(),
  fetcher:async()=>Response.json({error:{message:'Experiencing high demand on project private-test-id'}},{status:503})});
 assert.equal(r.gemini.reason,'upstream-http-503');
 assert.equal(r.gemini.timings.google.providerReason,'model-capacity');
 assert.ok(!JSON.stringify(r).includes('private-test-id'));
});
