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

test('skip walking when time is unrequested, transit requested, routes disabled or destination is unverified',async()=>{
 const rooms=[room('r')];
 let calls=0;
 const unavailable=()=>{calls++;throw Error('unexpected');};
 const cases=[
  [{query:'원주시 월세 40만원'},env,'not-requested'],
  [{query:'원주시 대중교통 15분',destinationId:DEFAULT_DESTINATION_ID},env,'not-requested'],
  [{query,destinationId:DEFAULT_DESTINATION_ID},{...env,ENABLE_WALKING_ROUTES:'false'},'disabled'],
  [{query,destinationId:'unknown-place'},env,'destination-unverified'],
  [{query:'원주시 강원대에서 도보 15분'},env,'destination-ambiguous']
 ];
 for(const [body,settings,status] of cases){
  const result=await search(rooms,body,unavailable,settings);
  assert.equal(result.status,200);
  assert.equal(result.data.walking.status,status);
 }
 assert.equal(calls,0);
});

test('unknown workplace waits for destination selection and never suggests paid collection for an unverified route',async()=>{
 let calls=0;
 const result=await search([room('candidate')],{query:'원주시 삼성전자까지 도보 15분'},()=>{
  calls++;
  throw Error('Should not route to the implicit campus');
 });
 assert.equal(result.data.conditions.destinationPlace,null);
 assert.equal(result.data.walking.status,'destination-unverified');
 assert.equal(result.data.unverified.length,1);
 assert.equal(result.data.collectionNeeded,false);
 assert.equal(calls,0);
});

test('ordinary city and budget phrases still allow the default campus',async()=>{
 const result=await search([room('candidate')],{query:'원주시에서 월세 40만원까지 도보 15분'},(r,destination)=>{
  assert.equal(destination.id,DEFAULT_DESTINATION_ID);
  return tmap(r,12);
 });
 assert.equal(result.data.walking.successCount,1);
 assert.equal(result.data.conditions.destinationStatus,'default');
});
