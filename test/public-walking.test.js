import assert from 'node:assert/strict';
import test from 'node:test';
import {handleWalking} from '../api/routes/walking.js';
import {publicWalkingPlaces} from '../lib/public-walking.js';
import {searchDestinations} from '../lib/destinations.js';
import {statusData} from '../api/status.js';
import {FINISH_WALK,RESERVE_WALK,walkingSettings} from '../lib/walking.js';

const env={TMAP_APP_KEY:'mock-key',ENABLE_WALKING_ROUTES:'true',DATA_RIGHTS_REVIEWED:'false'};
const req={headers:{},socket:{remoteAddress:'192.0.2.1'}};
const trip={publicOriginId:'station-wonju',destinationId:'knu-wonju'};
const unexpected=()=>assert.fail('this request must stay offline');

test('the repository deployment opts in the named production site to guest inventory',()=>{
 const config={PUBLIC_SAVED_LISTINGS:'true',PUBLIC_SAVED_LISTINGS_PRODUCTION_HOST:'kr-room-ai.vercel.app',
  VERCEL_ENV:'production',VERCEL_PROJECT_PRODUCTION_URL:'kr-room-ai.vercel.app'};
 assert.equal(statusData(config).publicSavedListings,true);
 for(const change of [{VERCEL_ENV:'preview'},{VERCEL_PROJECT_PRODUCTION_URL:'another-site.vercel.app'}]){
  assert.equal(statusData({...config,...change}).publicSavedListings,false);
 }
});

test('guests in saved-listings mode can see inventory status but cannot request live routes or places',async()=>{
 for(const reviewed of ['true','false']){
  const config={...env,PUBLIC_SAVED_LISTINGS:'true',DATA_RIGHTS_REVIEWED:reviewed};
  const settings=statusData(config);
  assert.equal(settings.publicSavedListings,true);
  assert.equal(settings.privateData,false);
  const options={req,env:config,fetcher:unexpected};
  for(const body of [trip,{listingId:'example',destinationId:'knu-wonju'}]){
   await assert.rejects(handleWalking(body,options),{status:401});
  }
  await assert.rejects(searchDestinations({query:'원주역'},options),{status:401});
 }
});

test('production walking approval applies only to the named Vercel production project and respects the off switch',()=>{
 const production={VERCEL:'1',VERCEL_ENV:'production',VERCEL_PROJECT_PRODUCTION_URL:'kr-room-ai.vercel.app',WALKING_ROUTES_PRODUCTION_HOST:'kr-room-ai.vercel.app'};
 assert.equal(walkingSettings(production).enabled,true);
 for(const changes of [{VERCEL_ENV:'preview'},{VERCEL_PROJECT_PRODUCTION_URL:'other.vercel.app'},{VERCEL_PROJECT_PRODUCTION_URL:undefined},{VERCEL:undefined},{ENABLE_WALKING_ROUTES:'false'}]){
  assert.equal(walkingSettings({...production,...changes}).enabled,false);
 }
 assert.equal(walkingSettings({}).enabled,false);
});

test('listed transit stations route anonymously to nearby public campuses while the actual listing API stays private',async()=>{
 const catalog=await publicWalkingPlaces();
 assert.equal(catalog.origins.length,5);
 assert.equal(catalog.destinations.length,6);
 for(const from of catalog.origins){
  assert.ok(from.destinationIds.every(id=>catalog.destinations.some(to=>to.id===id)));
  assert.ok(from.sourceUrl.startsWith('https://ko.wikipedia.org/'));
 }
 let billed=0;const scripts=[];
 const store={get:unexpected,command:async args=>{
  scripts.push(args[1]);
  if(args[1]===RESERVE_WALK){
   assert.ok(args.some(k=>typeof k==='string'&&k.startsWith('knuroom:route:walking:user:reader-')));
   assert.ok(args.includes(200));
   return ['owner'];
  }
  assert.equal(args[1],FINISH_WALK);
  return 1;
 }};
 const result=await handleWalking(trip,{req,env,store,fetcher:async(url,options)=>{
  assert.equal(url,'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1');
  const {startX,startY,endX,endY}=JSON.parse(options.body);
  assert.deepEqual([startX,startY,endX,endY],[127.92167,37.31611,127.9228972,37.3052056]);
  billed++;
  return Response.json({features:[{properties:{pointType:'SP',totalTime:603,totalDistance:700}}]});
 }});
 assert.equal(billed,1);
 assert.deepEqual(scripts,[RESERVE_WALK,FINISH_WALK]);
 assert.equal(result.publicOriginId,trip.publicOriginId);
 assert.equal(result.listingId,undefined);
 assert.equal(result.durationMinutes,11);
 await assert.rejects(handleWalking({listingId:'example',destinationId:'knu-wonju'},{req,env,store,fetcher:unexpected}),{status:401});
});

test('public routes reject mixed IDs, user coordinates, distant pairs, diagnostics and untrusted origins',async()=>{
 for(const change of [{listingId:'private'},{diagnostic:true},{confirmFreePlan:true},{lat:37.3},{publicOriginId:'private-id'},{destinationId:'snu-gwanak'},{destinationId:'osm-N-1'}]){
  await assert.rejects(handleWalking({...trip,...change},{req,env,fetcher:unexpected}),{status:400});
 }
 const limited=await handleWalking(trip,{req,env,store:{command:async()=>['daily-limit']},fetcher:unexpected});
 assert.equal(limited.reason,'daily-limit');
 const unavailable=await handleWalking(trip,{req,env,store:{command:async()=>{throw Error('offline');}},fetcher:unexpected});
 assert.equal(unavailable.reason,'redis-unavailable');
 const off=await handleWalking(trip,{req,env:{...env,ENABLE_WALKING_ROUTES:'false'},fetcher:unexpected});
 assert.equal(off.reason,'disabled');
});
