import test from 'node:test';
import assert from 'node:assert/strict';
import {handleSearch} from '../api/search.js';
import {saveListings} from '../lib/listing-store.js';
import {DEFAULT_DESTINATION_ID} from '../lib/destinations.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const region='강원특별자치도 원주시';
const query='원주시 원룸 관리비 포함 월 45만원 이하 도보 15분 이내';
const env={
 ADMIN_API_KEY:'mock-admin-key-for-walking-search', ENABLE_WALKING_ROUTES:'true', TMAP_APP_KEY:'mock',
 UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'mock',
};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
function room(id,fields={}){
 return {id,rent:30,maintenance_cost:50000,room_type:'원룸',address:region+' 단계동',
  latitude:37.34,longitude:127.96,location_is_approximate:true,...fields};
}
async function search(rooms,body,calculateRoute,settings=env){
 const store=new FakeRedis();
 await saveListings(store,rooms,region);
 return handleSearch(body,{req,env:settings,store,calculateRoute,
  fetcher:async()=>{throw Error('Unexpected external API access');}});
}
const tmap=(room,minutes)=>({
 status:'success',provider:'tmap',mode:'walking',originApproximate:room.approximate,
 durationMinutes:minutes,distanceMeters:800,calculatedAt:'2026-11-19T00:00:00Z'
});

test('search applies non-commute filters before selecting five routes, including approximate origins', async()=>{
 const listings=[
  room('expensive',{rent:55}),room('two-rooms',{room_type:'투룸'}),room('no-totals',{maintenance_cost:null}),
  room('no-coordinates',{latitude:null}),...Array.from({length:7},(_,i)=>room('room-'+i)),
 ];
 const called=[];
 const result=await search(listings,{query,destinationId:DEFAULT_DESTINATION_ID},async(room,destination)=>{
  called.push(room.id);
  assert.equal(destination.verified,true);
  if(room.id==='room-2')throw Error('unavailable');
  return tmap(room,room.id==='room-1'?16:15);
 },{...env,TMAP_MAX_ROUTES_PER_SEARCH:'99'});
 assert.equal(result.status,200);
 assert.deepEqual(called.sort(),['room-0','room-1','room-2','room-3','room-4']);
 const {results,unverified,walking}=result.data;
 assert.equal(walking.selectedCount,5);
 assert.equal(walking.successCount,4);
 assert.deepEqual(results.map(r=>r.id),['room-0','room-3','room-4']);
 assert.ok(results.every(r=>r.walkingRoute.originApproximate&&r.commuteMinutes===15));
 assert.deepEqual(new Set(unverified.map(r=>r.id)),new Set(['room-2','room-5','room-6','no-coordinates','no-totals']));
 assert.ok(unverified.every(r=>r.missingConditions.includes('이동시간')));
});

test('search re-ranks walking estimates with the actual user weights',async()=>{
 const rooms=[room('cheap',{rent:20}),room('near',{rent:32})];
 const calculate=(room)=>tmap(room,room.id==='cheap'?15:1);
 const withWeights=weights=>search(rooms,{query,destinationId:DEFAULT_DESTINATION_ID,edits:{weights}},calculate);
 const cost=await withWeights({cost:.85,commute:0,options:.15});
 const walk=await withWeights({cost:0,commute:.85,options:.15});
 assert.equal(cost.data.results[0].id,'cheap');
 assert.equal(walk.data.results[0].id,'near');
});

test('automatic walking skips outdated and undated records and uses a fresh duplicate as a whole',async()=>{
 const store=new FakeRedis(),old='2020-01-01T00:00:00Z';
 await saveListings(store,[room('old',{rent:1}),room('refreshed',{rent:2})],region,{now:old});
 const called=[];
 const response=await handleSearch({query,destinationId:DEFAULT_DESTINATION_ID},{
  req,store,env:{...env,APIFY_DATASET_ID:'fresh-dataset',APIFY_TOKEN:'mock',TMAP_MAX_ROUTES_PER_SEARCH:'1'},
  fetcher:async url=>{
   assert.equal(new URL(url).hostname,'api.apify.com');
   return Response.json([room('undated',{rent:1}),room('refreshed',{rent:34,latitude:37.35,lastSeenAt:new Date().toISOString()})]);
  },
  calculateRoute:async item=>{called.push([item.id,item.rent,item.lat]);return tmap(item,14);}
 });
 assert.deepEqual(called,[['refreshed',34,37.35]]);
 assert.deepEqual(response.data.results.map(item=>item.id),['refreshed']);
 assert.ok(response.data.unverified.every(item=>item.score===null&&item.walkingRoute===null));
 assert.deepEqual(response.data.unverified.map(item=>item.id),['old','undated']);
 assert.equal(response.data.coverage.count,3);
});

test('outdated inventory is counted without spending a walking request or awaiting a route',async()=>{
 const store=new FakeRedis();
 await saveListings(store,[room('expired')],region,{now:'2020-01-01T00:00:00Z'});
 const stop=()=>assert.fail('outdated listings should not start an upstream request');
 const {data}=await handleSearch({query,destinationId:DEFAULT_DESTINATION_ID},{
  req,env,store,fetcher:stop,calculateRoute:stop
 });
 assert.equal(data.coverage.count,1);
 assert.equal(data.results.length,0);
 assert.equal(data.unverified[0].score,null);
 assert.deepEqual(data.walking,{status:'no-eligible-listings',selectedCount:0,successCount:0});
 assert.equal(data.collectionNeeded,true);
});

test('a selected walking destination without a time cap calculates eligible routes within the search budget',async()=>{
 const rooms=[room('cheap',{rent:20}),room('later',{rent:21}),room('too-expensive',{rent:60})];
 const origin='원주시 원룸 관리비 포함 월 50만원 이하';
 const called=[];
 const result=await search(rooms,{
  query:origin,
  confirmedConditions:{location:region,roomTypes:['ONE_ROOM'],maxMonthlyTotal:50,transportMode:'walk',destination:'강원대학교 원주캠퍼스'}
 },async (listing,destination)=>{
  called.push([listing.id,destination.id]);
  return tmap(listing,64);
 },{...env,TMAP_MAX_ROUTES_PER_SEARCH:'1'});
 assert.equal(result.status,200);
 assert.equal(result.data.conditions.maxCommuteMinutes,null);
 assert.deepEqual(result.data.walking,{status:'calculated',selectedCount:1,successCount:1});
 assert.deepEqual(called,[['cheap',DEFAULT_DESTINATION_ID]]);
 assert.deepEqual(result.data.results.map(r=>[r.id,r.commuteMinutes]),[['cheap',64]]);
 assert.deepEqual(result.data.unverified.map(r=>[r.id,r.commuteMinutes]),[['later',null]]);
});

test('when no time cap was set, route failure reports its reason without claiming the inventory needs collecting',async()=>{
 const result=await search([room('r')],{query:'원주시 원룸',destinationId:DEFAULT_DESTINATION_ID},
  async()=>({status:'unconfirmed',mode:'walking',provider:'tmap',reason:'route-not-found'}));
 assert.equal(result.data.walking.status,'unconfirmed');
 assert.equal(result.data.unverified[0].walkingRoute.reason,'route-not-found');
 assert.equal(result.data.unverified[0].commuteMinutes,null);
 assert.equal(result.data.collectionNeeded,false);
});

test('skip walking when time is unrequested, transit requested, or routes disabled',async()=>{
 const rooms=[room('r')];
 let calls=0;
 const unavailable=()=>{calls++;throw Error('unexpected');};
 const cases=[
  [{query:'원주시 월세 40만원'},env,'not-requested'],
  [{query:'원주시 대중교통 15분',destinationId:DEFAULT_DESTINATION_ID},env,'not-requested'],
  [{query,destinationId:DEFAULT_DESTINATION_ID},{...env,ENABLE_WALKING_ROUTES:'false'},'disabled']
 ];
 for(const [body,settings,status] of cases){
  const result=await search(rooms,body,unavailable,settings);
  assert.equal(result.status,200);
  assert.equal(result.data.walking.status,status);
 }
 assert.equal(calls,0);
});

test('an unknown workplace or ambiguous campus asks for an address before looking at any inventory',async()=>{
 for(const [query,expected] of [['원주시 삼성전자까지 도보 15분','삼성전자'],['원주시 강원대에서 도보 15분','강원대학교']]){
  const result=await search([room('candidate')],{query},()=>assert.fail('unexpected route lookup'));
  assert.equal(result.status,422);assert.equal(result.data.kind,'destination');assert.equal(result.data.lookupQuery,expected);
  assert.equal(result.data.results,undefined);assert.equal(result.data.unverified,undefined);
  assert.equal(result.data.collectionNeeded,undefined);
 }
 await assert.rejects(search([],{query,destinationId:'unknown-place'},()=>assert.fail('unexpected route lookup')),{status:422});
});

test('a duration question or an ambiguous destination without a time cap requests clarification before using providers',async()=>{
 const stop=()=>assert.fail('no model, inventory or routing calls until destination is confirmed');
 for(const query of ['원주시 무실동 원룸 도보 시간 알려줘','원주시 무실동에서 강원대까지 얼마나 걸려?']){
  const response=await handleSearch({query},{req,env,store:{get:stop,command:stop,reserve:stop},fetcher:stop,calculateRoute:stop});
  assert.equal(response.status,422);assert.equal(response.data.state,'clarify');
  assert.equal(response.data.kind,'destination');assert.equal(response.data.conditions.maxCommuteMinutes,null);
 }
});

test('confirmed removal of a walking condition takes precedence over the original question',async()=>{
 const result=await search([room('r')],{
  query:'원주시에서 학교까지 도보로 얼마나 걸려?',
  confirmedConditions:{location:region,destination:null,maxCommuteMinutes:null,maxMonthlyTotal:50}
 },()=>assert.fail('removed route must not be calculated'));
 assert.equal(result.status,200);
 assert.equal(result.data.walking.status,'not-requested');
 assert.deepEqual(result.data.results.map(item=>item.id),['r']);
});

test('a travel-time cap in Wonju or Seoul asks where to travel; no model, inventory, job or routing work starts',async()=>{
 let calls=0;
 const unexpected=async()=>{calls++;throw Error('unexpected external access');};
 const options={req,env:{...env,GEMINI_API_KEY:'fake'},store:{get:unexpected,command:unexpected,reserve:unexpected},fetcher:unexpected,calculateRoute:unexpected};
 for(const body of [
  {query:'원주시에서 월세 40만원까지 도보 15분'},
  {query:'서울 관악구에서 도보 15분 이내의 원룸'},
  {query:'서울 관악구 학교까지 도보 15분',jobId:'future-job'},
  {query:'원주시요',confirmedConditions:{location:region,maxCommuteMinutes:15}}
 ]){
  const result=await handleSearch(body,options);
  assert.equal(result.status,422);assert.equal(result.data.kind,'destination');assert.equal(result.data.conditions.destination,null);
  assert.equal(result.data.conditions.maxCommuteMinutes,15);assert.equal(result.data.results,undefined);
 }
 assert.equal(calls,0);
});
