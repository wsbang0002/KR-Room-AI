import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryOverview,loadRegionInventory,regionalSummary} from '../lib/inventory.js';
import {loadListings} from '../lib/apify.js';
import {FakeRedis} from '../test-support/fake-redis.js';
import {saveListings} from '../lib/listing-store.js';
import {handleSearch} from '../api/search.js';

const wonju='강원특별자치도 원주시';
const city=wonju+' 무실동';
const publicEnv={DATA_RIGHTS_REVIEWED:'true',AI_PROVIDER:'local'};
const req={headers:{}};
function upstreamEnv(id){return {...publicEnv,APIFY_DATASET_ID:id,APIFY_TOKEN:'test-only'};}
const sample=(id,address,extra={})=>({id,address,rent:40,deposit:300,fee:5,room_type:'원룸',collectedAt:'2026-01-02T10:00:00Z',...extra});

test('private regional discovery with no credentials discloses no data and makes zero provider calls',async()=>{
 const stop=()=>{throw Error('private reads must not happen');};
 const opts={env:{ADMIN_API_KEY:'a-fake-private-key-with-24-characters'},store:{command:stop},fetcher:stop};
 assert.deepEqual(await inventoryOverview(req,opts),{state:'private',regions:[]});
 await assert.rejects(inventoryOverview({headers:{authorization:'Bearer invalid'}},opts),{status:401});
 const store=new FakeRedis();
 await saveListings(store,[sample('inside',city)],city);
 const response=await inventoryOverview({headers:{authorization:'Bearer '+opts.env.ADMIN_API_KEY}},{...opts,store});
 assert.equal(response.regions[0].count,1);
 assert.deepEqual(await inventoryOverview(req,{...opts,store}),{state:'private',regions:[]});
});

test('region counts are deduplicated before price filtering, separate source observation from collection and vacancy',async()=>{
 const store=new FakeRedis();
 await saveListings(store,[sample('a',city),sample('b',city,{rent:60})],city,{now:'2026-02-01T01:10:00Z'});
 const opts={env:publicEnv,req,store,fetcher:()=>assert.fail('existing regional inventory should not start any provider')};
 const read=await handleSearch({query:'원주시 무실동 월세 10만원'},opts);
 assert.equal(read.data.coverage.count,2);
 assert.equal(read.data.coverage.state,'available');
 assert.equal(read.data.results.length+read.data.unverified.length,0);
 const priced=await handleSearch({query:'원주시 무실동 월세 45만원'},opts);
 assert.equal(priced.data.results.length,0);
 const [room]=priced.data.unverified;
 assert.equal(room.score,null);
 assert.equal(room.inventorySource,'redis');assert.equal(room.availabilityCheckedAt,null);
 assert.equal(room.availability,'unverified');assert.equal(room.syncStatus,'stale');
 assert.equal(priced.data.coverage.lastCollectedAt,'2026-01-02T10:00:00.000Z');
 assert.equal(priced.data.coverage.lastSeenAt,'2026-02-01T01:10:00.000Z');
});

test('coverage groups combine distinct evidence and never use the collection request region as a listing address',async()=>{
 const store=new FakeRedis();
 await saveListings(store,[sample('known',city),sample('wrong-index','서울특별시 관악구 봉천동'),sample('unknown','중앙동')],wonju);
 const opts={env:upstreamEnv('lodging-discovery'),store,fetcher:async()=>Response.json([sample('known','무실동'),sample('extra','단계동')])};
 const data=await inventoryOverview(req,opts);
 assert.equal(data.state,'available');
 assert.deepEqual(Object.fromEntries(data.regions.map(row=>[row.location,row.count])),{[city]:1,[wonju+' 단계동']:1,'서울특별시 관악구':1});
 assert.equal(data.unlocatedCount,1);assert.equal(JSON.stringify(data).includes('wrong-index'),false);
 const other=await loadRegionInventory('부산광역시 해운대구',opts);
 assert.equal(regionalSummary(other,'부산광역시 해운대구').state,'unknown-region');
 const actualRegion=await loadRegionInventory('서울특별시 관악구',opts);
 assert.ok(actualRegion.items.some(item=>item.id==='wrong-index'));
 assert.equal(regionalSummary(actualRegion,'서울특별시 관악구').count,1);
 const local=await loadRegionInventory(wonju,opts);
 assert.equal(regionalSummary(local,wonju).count,2);
});

test('real empty datasets, ambiguous evidence, provider outage and bounded partial pages remain distinct',async()=>{
 const check=async(id,res)=>{
  const loaded=await loadRegionInventory(city,{env:upstreamEnv(id),fetcher:async()=>res});
  return regionalSummary(loaded,city);
 };
 assert.equal((await check('zero-true',Response.json([]))).state,'empty');
 assert.equal((await check('only-unlocated',Response.json([sample('x','주소 미확인')]))).state,'unknown-region');
 const err=await check('unavailable',new Response(null,{status:502}));
 assert.equal(err.state,'unavailable');
 const short=await check('limited-page',Response.json([sample('q',city)],{headers:{'x-apify-pagination-total':'120'}}));
 assert.equal(short.count,1);assert.equal(short.state,'partial');
 const redisFailed=await loadRegionInventory(city,{env:upstreamEnv('redis-degraded'),store:{command:()=>{throw Error('offline');}},fetcher:async()=>Response.json([sample('s',city)])});
 assert.equal(regionalSummary(redisFailed,city).state,'partial');
});

test('inventory preserves a saved listing and takes a whole Dataset origin only when the stored point is missing',async()=>{
 const store=new FakeRedis();
 await saveListings(store,[
  sample('partial',city,{lat:37.34,approximate:false}),sample('complete',city,{lat:37.36,lng:127.93,approximate:false}),
  sample('no-match',city,{lng:127.93})
 ],city);
 const options={env:upstreamEnv('region-origin-fixture'),store,fetcher:async()=>Response.json([
  sample('partial',city,{rent:75,latitude:37.341,longitude:127.92,location_is_approximate:true}),
  sample('complete',city,{lat:37.39,lng:127.97,approximate:true})
 ])};
 const items=(await loadRegionInventory(city,options)).items;
 const origin=id=>{const {lat,lng,approximate,rent}=items.find(item=>item.id===id);return [lat,lng,approximate,rent];};
 assert.deepEqual(origin('partial'),[37.341,127.92,true,40]);
 assert.deepEqual(origin('complete'),[37.36,127.93,false,40]);
 assert.deepEqual(origin('no-match'),[null,127.93,true,40]);
});

test('expired Apify query cache is identified as a degraded fallback when refresh fails',async()=>{
 const env=upstreamEnv('cache-failure');
 const first=await loadListings({env,now:1,fetcher:async()=>Response.json([sample('old',city)])});
 assert.equal(first.source,'apify-api');
 const stale=await loadListings({env,now:600_001,fetcher:async()=>{throw Error('offline');}});
 assert.equal(stale.source,'apify-stale');assert.equal(stale.failed,true);assert.equal(stale.stale,true);
 assert.equal(stale.items[0].id,'old');
});
