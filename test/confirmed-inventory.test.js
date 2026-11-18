import assert from 'node:assert/strict';
import test from 'node:test';
import {handleSearch} from '../api/search.js';
import {handleConditions} from '../api/conditions.js';
import {searchTurn} from '../lib/search-turn.js';
import {searchDestinations} from '../lib/destinations.js';
import {saveListings} from '../lib/listing-store.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const city='강원특별자치도 원주시';
const publicEnv={
 DATA_RIGHTS_REVIEWED:'true',AI_PROVIDER:'openrouter-free',OPENROUTER_API_KEY:'mock',
 UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'mock'
};
const req={headers:{},socket:{remoteAddress:'127.0.0.1'}};

test('a confirmed neighborhood reply searches the new neighborhood once with its previous filters',async()=>{
 const store=new FakeRedis();
 const listing=(id,area,rent)=>({id,rent,fee:4,maintenance_cost:40000,room_type:'원룸',address:city+' '+area,dong_name:area,options:['세탁기']});
 await saveListings(store,[listing('ok','중앙동',40),listing('too-much','중앙동',60),listing('old','무실동',30)],city);
 const first=searchTurn({query:'원주시 무실동, 관리비 포함 월 50만 원 이하, 세탁기 필수 원룸'});
 const clarify=searchTurn({query:'중앙동으로 바꿔줘',previous:first.conditions});
 assert.equal(clarify.state,'clarify');
 const ready=searchTurn({query:'원주시요',previous:first.conditions,pending:clarify.pending});
 const result=await handleSearch({query:'원주시요',confirmedConditions:ready.conditions},{
  env:publicEnv,req,store,fetcher:()=>assert.fail('confirmed searches must not re-run AI or contact providers')
 });
 assert.equal(result.data.conditions.location,city+' 중앙동');
 assert.equal(result.data.conditions.maxMonthlyTotal,50);
 assert.deepEqual(result.data.conditions.requiredOptions,['세탁기']);
 assert.deepEqual(result.data.results.map(room=>room.id),['ok']);
 assert.equal(result.data.unverified.length,0);
});

test('prepared conditions never grant inventory access or select an unknown region',async()=>{
 const request={query:'중앙동',confirmedConditions:{location:city}};
 const offline={req,fetcher:()=>assert.fail('unauthorized or malformed requests must stay offline')};
 await assert.rejects(handleSearch(request,{...offline,env:{}}),{status:401});
 for(const extra of [{location:'중앙동'},{verified:true},{maxMonthlyTotal:-1}]){
  await assert.rejects(handleSearch({...request,confirmedConditions:{location:city,...extra}},{...offline,env:publicEnv}),{status:400});
 }
 await assert.rejects(handleSearch({...request,edits:{location:city}},{...offline,env:publicEnv}),{status:400});
});

test('published initial search uses only the budgeted free model and confirmed turns skip generation',async()=>{
 let generated=0;
 const options={req,env:publicEnv,store:new FakeRedis(),fetcher:async(url,init)=>{
  if(url==='https://openrouter.ai/api/v1/key')return Response.json({data:{is_free_tier:true}});
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
  const payload=JSON.parse(init.body);
  assert.ok(payload.model.endsWith(':free'));
  assert.deepEqual(payload.provider.max_price,{prompt:'0',completion:'0',request:'0'});
  generated++;
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({maxRent:45})}}]});
 }};
 const budget=await handleConditions({query:'원주시 무실동, 월세 사십오만 원 이하'},options);
 assert.equal(budget.conditions.maxRent,45);
 const edit=await handleConditions({query:'중앙동으로',previous:budget.conditions},options);
 const answer=await handleConditions({query:'원주시요',pending:edit.pending,previous:budget.conditions},options);
 assert.equal(answer.conditions.maxRent,45);assert.equal(generated,1);
 await handleConditions({query:'서울 관악구',previous:null},{...options,env:{...publicEnv,DATA_RIGHTS_REVIEWED:'false'}});
 assert.equal(generated,1);
});

test('destination lookup opens with data publication and remains protected before it',async()=>{
 const body={query:'강원대 원주캠퍼스'};
 const opts={req,fetcher:()=>assert.fail('curated place needs no external calls')};
 assert.equal((await searchDestinations(body,{...opts,env:publicEnv})).destinations[0].id,'knu-wonju');
 await assert.rejects(searchDestinations(body,{...opts,env:{}}),{status:401});
});
