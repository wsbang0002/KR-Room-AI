import assert from 'node:assert/strict';
import test from 'node:test';
import {syncExistingDataset,IMPORT_DATASET_LISTING} from '../lib/dataset-sync.js';
import {listingKey,regionKey,saveListings} from '../lib/listing-store.js';
import {FakeRedis} from '../test-support/fake-redis.js';

const now=Date.parse('2026-11-23T00:00:00Z');
const env={APIFY_TOKEN:'fake-read-token',APIFY_DATASET_ID:'existingDataset'};
const location='강원특별자치도 원주시 무실동';
const dated=(id,extra={})=>({id,rent:40,maintenance_cost:50000,dong_name:'무실동',metadata:{scrapedAt:'2026-11-10T00:00:00Z'},...extra});
const dateOf=day=>'2026-11-'+day+'T00:00:00.000Z';

function provider(rows,onPage=()=>{}){
 return async(url,init)=>{
  const target=new URL(url);
  assert.equal(target.origin,'https://api.apify.com');
  assert.equal(target.pathname,'/v2/datasets/existingDataset/items');
  assert.equal(init.method,'GET');
  assert.equal(init.redirect,'error');
  assert.equal(init.headers.Authorization,'Bearer '+env.APIFY_TOKEN);
  const offset=Number(target.searchParams.get('offset')),limit=Number(target.searchParams.get('limit'));
  await onPage(offset);
  return {ok:true,headers:new Headers({'x-apify-pagination-total':String(rows.length),'x-apify-pagination-offset':String(offset)}),
   json:async()=>rows.slice(offset,offset+limit)};
 };
}

test('sync uses only existing Dataset GETs, groups mixed regions, deduplicates and verifies durable rows',async()=>{
 const store=new FakeRedis(now);
 const rows=[dated('A'),dated('A',{rent:35,metadata:{scrapedAt:dateOf('12')}}),
  dated('B',{dong_name:'단계동',metadata:{}}),dated('C',{dong_name:'중앙동'}),dated(''),null,
  dated('lease',{price_type:'전세'}),dated('invalid',{rent:-1})];
 const options={env,store,now,fetcher:provider(rows)};
 const result=await syncExistingDataset(options);
 assert.equal(result.sourceRows,8);assert.equal(result.skippedRows,5);assert.equal(result.duplicateRows,1);
 assert.equal(result.uniqueListings,2);assert.equal(result.verifiedPresent,2);assert.equal(result.verifiedMissing,0);
 assert.equal(result.verified,true);assert.equal(result.inserted,2);
 assert.deepEqual(result.regions.map(r=>r.location),['강원특별자치도 원주시 단계동',location]);
 const a=await store.get(listingKey('A')),b=await store.get(listingKey('B'));
 assert.equal(a.rent,35);assert.equal(a.monthlyTotal,40);assert.equal(a.lastSeenAt,dateOf('12'));assert.equal(a.syncStatus,'stale');
 assert.equal(b.lastSeenAt,null);assert.equal(b.collectedAt,null);assert.equal(b.syncStatus,'unknown');
 assert.deepEqual(await store.command(['SMEMBERS',regionKey(location)]),[listingKey('A')]);
 assert.equal(await store.command(['TTL',listingKey('A')]),-1);
 assert.equal(JSON.stringify(result).includes(env.APIFY_DATASET_ID),false);
 const repeated=await syncExistingDataset(options);
 assert.equal(repeated.inserted,0);assert.equal(repeated.updated,0);assert.equal(repeated.unchanged,2);
 assert.equal(repeated.verifiedPresent,2);
});

test('existing fresher or richer Redis records survive; only demonstrably newer observations update prices',async()=>{
 const store=new FakeRedis(now);
 const older=dated('older'),richer=dated('richer',{latitude:37.3,longitude:127.93,location_is_approximate:false}),recent=dated('current');
 await saveListings(store,[older,richer],location,{now:dateOf('03'),runId:'old'});
 // The fixtures emulate Actor metadata at the date that each run finished.
 await saveListings(store,[recent],location,{now:dateOf('16'),runId:'current'});
 const before=await store.get(listingKey('current'));
 const result=await syncExistingDataset({env,store,now,fetcher:provider(['older','richer','current'].map(id=>dated(id,{rent:33,metadata:{scrapedAt:dateOf('12')}})))});
 assert.equal(result.updated,1);assert.equal(result.unchanged,2);
 assert.deepEqual(await store.get(listingKey('current')),before);
 const updated=await store.get(listingKey('older'));
 assert.equal(updated.rent,33);assert.equal(updated.lastSeenAt,dateOf('12'));
 assert.equal(updated.firstCollectedAt,'2026-11-10T00:00:00Z');
 assert.equal((await store.get(listingKey('richer'))).approximate,false);
});

test('concurrent live collection and Dataset import preserve the more recent observation in both orders',async()=>{
 const store=new FakeRedis(now),command=store.command.bind(store);
 const original=dated('room',{rent:39,metadata:{scrapedAt:dateOf('10')}});
 let intercepted=false;
 store.command=async args=>{
  if(!intercepted&&args[1]===IMPORT_DATASET_LISTING){
   intercepted=true;
   await saveListings(store,[dated('room',{rent:51})],location,{now:dateOf('17'),runId:'concurrent'});
  }
  return command(args);
 };
 const options={env,store,now,fetcher:provider([original])};
 const result=await syncExistingDataset(options);
 assert.equal(result.inserted,0);assert.equal(result.unchanged,1);assert.equal(result.verifiedPresent,1);
 assert.equal((await store.get(listingKey('room'))).rent,51);
 const later=await syncExistingDataset({...options,fetcher:provider([dated('room',{rent:37,metadata:{scrapedAt:dateOf('20')}})])});
 assert.equal(later.updated,1);
 await saveListings(store,[dated('room',{rent:99})],location,{now:dateOf('18'),runId:'delayed-recovery'});
 let saved=await store.get(listingKey('room'));
 assert.equal(saved.rent,37);assert.equal(saved.lastSeenAt,dateOf('20'));
 await saveListings(store,[dated('room',{rent:36})],location,{now:dateOf('22'),runId:'newer-recovery'});
 saved=await store.get(listingKey('room'));
 assert.equal(saved.rent,36);assert.equal(saved.runId,'newer-recovery');
});

test('all pages are fetched before writing; incomplete or unavailable Dataset never imports a fallback',async()=>{
 const store=new FakeRedis(now),rows=Array.from({length:103},(_,i)=>dated(String(i+1)));
 const offsets=[];
 const result=await syncExistingDataset({store,env,now,fetcher:provider(rows,offset=>offsets.push(offset))});
 assert.deepEqual(offsets,[0,100]);assert.equal(result.verifiedPresent,103);
 for(const fetcher of [provider(rows,offset=>{if(offset)throw Error('page failed');}),async()=>({ok:false}),
  async()=>({ok:true,headers:new Headers({'x-apify-pagination-total':'10'}),json:async()=>[]})]){
  const fresh=new FakeRedis(now);
  await assert.rejects(syncExistingDataset({store:fresh,env,now,fetcher}));
  assert.equal(fresh.data.size,0);
 }
});

test('missing readback is reflected in verification counts and future timestamps never establish freshness',async()=>{
 const store=new FakeRedis(now),command=store.command.bind(store);
 store.command=args=>args[0]==='MGET'?[null]:command(args);
 const result=await syncExistingDataset({env,store,now,fetcher:provider([dated('future',{metadata:{scrapedAt:'2030-01-01T00:00:00Z'}})])});
 assert.equal(result.verified,false);assert.equal(result.verifiedMissing,1);assert.equal(result.verifiedPresent,0);
 assert.equal((await store.get(listingKey('future'))).lastSeenAt,null);
});
