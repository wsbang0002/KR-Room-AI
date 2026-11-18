import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeRedis} from '../test-support/fake-redis.js';
import {DEFAULT_DESTINATION_ID,getDestination,identifyDestination,searchDestinations} from '../lib/destinations.js';

const env={ADMIN_API_KEY:'only-for-destination-tests-000000'};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
const office={
 geometry:{type:'Point',coordinates:[127.1,37.5]},
 properties:{osm_key:'office',osm_value:'company',osm_id:123,osm_type:'N',
  countrycode:'KR',state:'서울특별시',city:'송파구',district:'가락동',street:'예시로',housenumber:'1',name:'예시회사'}
};

test('campus ambiguity requires an address choice, and an explicit campus is searchable offline',async()=>{
 for(const name of ['강원대','서울대','연세대'])assert.equal(identifyDestination(name).status,'ambiguous');
 const options={req,env,fetcher:()=>assert.fail('campus lookup must work offline')};
 const r=await searchDestinations({query:'강원대 원주캠퍼스'},options);
 const [place]=r.destinations;
 assert.equal(place.id,DEFAULT_DESTINATION_ID);
 assert.match(place.address,/원주시/);
 assert.equal(place.precision,'campus-reference');
 assert.ok(place.verified&&Number.isFinite(place.lat)&&Number.isFinite(place.lng));
 assert.deepEqual(await getDestination(place.id,options),place);
 assert.equal(identifyDestination('춘천시에서 강원대 도보 10분').status,'ambiguous');
 assert.equal(identifyDestination('서울대입구역까지').status,'unresolved');
 assert.equal(identifyDestination('서울대 관악캠퍼스와 연세대까지').status,'ambiguous');
 assert.equal(identifyDestination('중앙병원까지 걸어서').status,'unresolved');
});

test('unknown or client-forged coordinates do not resolve to trusted points',async()=>{
 let reads=0;
 const options={store:{get:async()=>{reads++;return {...office,id:'osm-N-1',verified:true,lat:95,lng:127};}}};
 assert.equal(await getDestination('37.5,127',options),null);
 assert.equal(await getDestination({id:'knu-wonju',lat:37.5,lng:127},options),null);
 assert.equal(reads,0);
 assert.equal(await getDestination('osm-N-1',options),null);
});

test('Korean workplace results keep independent addresses and IDs, discard inappropriate records and reuse Redis',async()=>{
 let calls=0;
 const features=[office,{...office,properties:{...office.properties,city:'금정구',state:'부산광역시',osm_id:456}},
  {...office,properties:{...office.properties,countrycode:'CN'}},
  {...office,geometry:{type:'Point',coordinates:[37.1,127.7]}},
  {...office,properties:{...office.properties,osm_key:'highway'}},
  {...office,properties:{...office.properties,osm_id:'client-supplied'}},office];
 const options={store:new FakeRedis(),env,req,fetcher:async(url,init)=>{
  calls++;const u=new URL(url);
  assert.equal(u.hostname,'photon.komoot.io');
  assert.equal(u.searchParams.get('countrycode'),'kr');
  assert.equal(u.searchParams.get('q'),'예시회사');
  assert.equal(init.headers.authorization,undefined);
  return Response.json({features});
 }};
 const result=await searchDestinations({query:'예시회사',lat:1,lng:2},options);
 assert.deepEqual(result.destinations.map(p=>p.id),['osm-N-123','osm-N-456']);
 assert.match(result.destinations[0].address,/서울특별시/);
 assert.match(result.destinations[1].address,/부산광역시/);
 assert.equal((await getDestination('osm-N-123',options)).lat,37.5);
 assert.deepEqual((await searchDestinations({query:'예시회사'},options)).destinations,result.destinations);
 assert.equal(calls,1);
});

test('unauthorized users, Redis failures and cross-instance throttle prevent geocoding requests',async()=>{
 const blocked=()=>{throw Error('should not be reached');};
 const options={store:{get:async()=>null,command:async()=>null},env,req,fetcher:blocked};
 await assert.rejects(searchDestinations({query:'직장'},{...options,req:{}}),e=>e.status===401);
 await assert.rejects(searchDestinations({query:'직장'},options),e=>e.status===429);
 await assert.rejects(searchDestinations({query:'직장'},{...options,store:{get:async()=>{throw Error();}}}),e=>e.status===503);
});
