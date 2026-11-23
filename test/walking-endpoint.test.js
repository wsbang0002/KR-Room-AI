import assert from 'node:assert/strict';
import test from 'node:test';
import {handleWalking} from '../api/routes/walking.js';
import {DEFAULT_DESTINATION_ID} from '../lib/destinations.js';
import {statusData} from '../api/status.js';
import {RESERVE_WALK} from '../lib/walking.js';

const env={ADMIN_API_KEY:'unit-test-admin-secret-for-routes',TMAP_APP_KEY:'test-only'};
const req={headers:{authorization:'Bearer '+env.ADMIN_API_KEY}};
const ids={listingId:'listing-1',destinationId:DEFAULT_DESTINATION_ID};
const unexpected=()=>assert.fail('Unexpected upstream request');

test('walking endpoint accepts only IDs and authenticates a diagnostic in public mode',async()=>{
 for(const extra of [{lat:37},{destination:{lat:37}},{diagnostic:'true'},{confirmFreePlan:true}]){
  await assert.rejects(handleWalking({...ids,...extra},{req,env,fetcher:unexpected}),{status:400});
 }
 await assert.rejects(handleWalking({...ids,diagnostic:true,confirmFreePlan:true},{
  req:{headers:{}},env:{...env,DATA_RIGHTS_REVIEWED:'true'},fetcher:unexpected
 }),{status:401});
 const off=await handleWalking(ids,{req,env,fetcher:unexpected});
 assert.equal(off.reason,'disabled');
 const missingRedis=await handleWalking(ids,{req,env:{...env,ENABLE_WALKING_ROUTES:'true'},fetcher:unexpected});
 assert.equal(missingRedis.reason,'redis-unavailable');
});

test('public status reports settings and never includes key material',()=>{
 const info=statusData(env);
 assert.equal(info.walking.keyConfigured,true);
 assert.equal(info.walking.dailyLimit,200);
 assert.equal(info.walking.maxPerSearch,5);
 assert.equal(info.walking.enabled,false);
 assert.ok(!JSON.stringify(info).includes(env.TMAP_APP_KEY));
});

test('route API looks up a stored origin and trusted campus on the server',async()=>{
 let networkCalls=0;
 const data=await handleWalking(ids,{
  req,env:{...env,ENABLE_WALKING_ROUTES:'true'},
  store:{
   get:async key=>{assert.equal(key,'knuroom:listing:listing-1');return {id:'listing-1',lat:37.312,lng:127.921,approximate:true};},
   command:async args=>args[1]===RESERVE_WALK?['owner']:1
  },
  fetcher:async(url,init)=>{
   assert.match(url,/routes\/pedestrian/);
   const body=JSON.parse(init.body);
   assert.equal(body.startX,127.921);assert.equal(body.startY,37.312);
   networkCalls++;
   return Response.json({features:[{type:'Feature',geometry:{type:'Point'},properties:{pointType:'SP',totalTime:901,totalDistance:950}}]});
  }
 });
 assert.equal(networkCalls,1);assert.equal(data.status,'success');
 assert.equal(data.durationMinutes,16);assert.equal(data.originApproximate,true);
});

test('a stored listing missing either coordinate uses the matching Dataset origin and its accuracy',async()=>{
 const upstream=[];
 const data=await handleWalking(ids,{
  req,env:{...env,ENABLE_WALKING_ROUTES:'true',APIFY_DATASET_ID:'single-route-origin-fixture',APIFY_TOKEN:'mock'},
  store:{
   get:async()=>({id:ids.listingId,lat:37.33,lng:null,approximate:false}),
   command:async args=>args[1]===RESERVE_WALK?['owner']:1
  },
  fetcher:async(url,init)=>{
   const host=new URL(url).hostname;
   upstream.push(host);
   if(host==='api.apify.com')return Response.json([
    {id:'different',rent:30,lat:37.91,lng:127.8},
    {id:ids.listingId,rent:45,latitude:37.331,longitude:127.923,location_is_approximate:true}
   ]);
   assert.equal(host,'apis.openapi.sk.com');
   const body=JSON.parse(init.body);
   assert.deepEqual([body.startY,body.startX],[37.331,127.923]);
   return Response.json({features:[{type:'Feature',geometry:{type:'Point'},properties:{pointType:'SP',totalTime:360,totalDistance:400}}]});
  }
 });
 assert.equal(data.durationMinutes,6);
 assert.equal(data.originApproximate,true);
 assert.deepEqual(upstream,['api.apify.com','apis.openapi.sk.com']);
});

test('listing car and bus lookups require listing access, reject coordinate overrides, and cannot use public or diagnostic routing',async()=>{
 const options={req,env:{...env,ENABLE_WALKING_ROUTES:'true',TMAP_TRANSIT_APP_KEY:'mock'},fetcher:unexpected};
 for(const mode of ['car','bus']){
  await assert.rejects(handleWalking({...ids,mode},{...options,req:{headers:{}}}),{status:401});
  await assert.rejects(handleWalking({...ids,mode,startX:127},options),{status:400});
  await assert.rejects(handleWalking({publicOriginId:'station-wonju',destinationId:ids.destinationId,mode},options),{status:400});
  await assert.rejects(handleWalking({...ids,mode,diagnostic:true,confirmFreePlan:true},options),{status:400});
 }
 await assert.rejects(handleWalking({...ids,mode:'unknown'},options),{status:400});
 const missingKey=await handleWalking({...ids,mode:'bus'},{...options,env:{...options.env,TMAP_TRANSIT_APP_KEY:''}});
 assert.equal(missingKey.status,'unconfirmed');assert.equal(missingKey.reason,'disabled');
 const disabled=await handleWalking({...ids,mode:'car'},{...options,env:{...options.env,ENABLE_WALKING_ROUTES:'false'}});
 assert.equal(disabled.reason,'disabled');
});

test('public bus status exposes the active provider and hard free cap without credential contents',()=>{
 const options={...env,ENABLE_WALKING_ROUTES:'true',KAKAO_REST_API_KEY:'private-kakao-mock',TMAP_TRANSIT_APP_KEY:'private-tmap-mock'};
 const status=statusData(options);
 assert.equal(status.listingRoutes.bus.provider,'kakao');
 assert.equal(status.listingRoutes.bus.dailyLimit,100);
 assert.equal(statusData({...options,KAKAO_TRANSIT_DAILY_APP_LIMIT:'101'}).listingRoutes.bus.dailyLimit,100);
 assert.equal(statusData({...options,KAKAO_TRANSIT_DAILY_APP_LIMIT:'NaN'}).listingRoutes.bus.dailyLimit,0);
 assert.equal(statusData({...options,KAKAO_REST_API_KEY:''}).listingRoutes.bus.provider,'tmap');
 assert.equal(statusData({...options,KAKAO_REST_API_KEY:'',TMAP_TRANSIT_APP_KEY:''}).listingRoutes.bus.enabled,false);
 assert.ok(!JSON.stringify(status).includes('private-'));
});
