import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeRedis} from '../test-support/fake-redis.js';
import {walkingRoute,walkingSettings,walkingUsage,RESERVE_WALK,FINISH_WALK} from '../lib/walking.js';

class WalkingStore extends FakeRedis {
 constructor(){super();this.active=new Set();}
 eval(script,keys,args){
  if(script===RESERVE_WALK){
   const [cache,lock,day,user,diag]=keys;
   const [save,limit,userLimit,diagnostic,diagnosticLimit,token,concurrency]=args;
   if(save==='1'&&this.read(cache))return ['cached',this.read(cache)];
   if(this.read(lock))return [this.read(lock)==='cooldown'?'cooldown':'pending'];
   if(this.active.size>=concurrency)return ['concurrent-limit'];
   if(Number(this.read(day)||0)>=limit)return ['daily-limit'];
   if(Number(this.read(user)||0)>=userLimit)return ['user-rate-limit'];
   if(diagnostic==='1'&&Number(this.read(diag)||0)>=diagnosticLimit)return ['diagnostic-limit'];
   this.write(day,Number(this.read(day)||0)+1,172800);
   this.write(user,Number(this.read(user)||0)+1,60);
   if(diagnostic==='1')this.write(diag,Number(this.read(diag)||0)+1,172800);
   this.active.add(token);
   this.write(lock,token,30);
   return ['owner'];
  }
  if(script===FINISH_WALK){
   const [cache,lock]=keys;
   const [token,value,ttl]=args;
   if(this.read(lock)!==token)return 0;
   if(value){this.write(cache,value,ttl);this.data.delete(lock);}
   else this.write(lock,'cooldown',10);
   this.active.delete(token);
   return 1;
  }
  return super.eval(script,keys,args);
 }
}
const room={id:'room-12',lat:37.3,lng:127.8,approximate:true};
const dest={id:'office-34',name:'Example',verified:true,precision:'campus-reference',lat:37.31,lng:127.82};
const adminKey='mock-secret-of-at-least-24-characters';
const summary=(distance=830,seconds=661)=>({type:'FeatureCollection',features:[
 {type:'Feature',properties:{pointType:'SP',totalDistance:distance,totalTime:seconds}},
 {type:'Feature',geometry:{type:'LineString',coordinates:[[127.8,37.3],[127.82,37.31]]},properties:{distance:9900,time:1000}}
]});
function fixture(fetcher=async()=>Response.json(summary())){
 const store=new WalkingStore();
 return {
  store,now:()=>store.now,fetcher,req:{headers:{authorization:'Bearer '+adminKey}},
  env:{ENABLE_WALKING_ROUTES:'true',TMAP_APP_KEY:'mock-tmap',ADMIN_API_KEY:adminKey}
 };
}

test('walking sends only a verified WGS84 route to TMAP and normalizes its summary',async()=>{
 let call;
 const opts=fixture(async(url,init)=>{call={url,init};return Response.json(summary());});
 const route=await walkingRoute(room,dest,opts);
 assert.equal(call.url,'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1');
 assert.equal(call.init.method,'POST');
 assert.equal(call.init.redirect,'error');
 assert.equal(call.init.headers.appKey,'mock-tmap');
 assert.equal(call.init.headers.Accept,'application/json');
 assert.deepEqual(JSON.parse(call.init.body),{startX:room.lng,startY:room.lat,endX:dest.lng,endY:dest.lat,
  startName:'Origin',endName:'Destination',reqCoordType:'WGS84GEO',resCoordType:'WGS84GEO',searchOption:'0'});
 assert.equal(route.durationMinutes,12);
 assert.equal(route.durationSeconds,661);
 assert.equal(route.distanceMeters,830);
 assert.equal(route.originApproximate,true);
 assert.equal(route.confidence,'approximate-origin');
 assert.equal(route.destinationPrecision,'campus-reference');
 assert.equal(route.provider,'tmap');
 assert.equal(route.calculatedAt,new Date(opts.store.now).toISOString());
 assert.equal(await walkingUsage(opts.store,opts.store.now),1);
 assert.equal(route.status,'success');
 assert.ok(!JSON.stringify([route,[...opts.store.data.values()]]).includes('mock-tmap'));
 assert.ok(!JSON.stringify([...opts.store.data.values()]).includes('durationMinutes'));
});

test('walking requires opt-in, a configured key, valid coordinates and a verified destination',async()=>{
 let calls=0;
 const opts=fixture(async()=>{calls++;return Response.json(summary());});
 for(const [r,d,env,reason] of [
  [room,dest,{ENABLE_WALKING_ROUTES:undefined},'disabled'],
  [room,dest,{TMAP_APP_KEY:undefined,TMAP_API_KEY:'legacy'},'missing-key'],
  [{...room,lat:null},dest,{},'invalid-origin'],
  [{...room,lat:Infinity},dest,{},'invalid-origin'],
  [{...room,lng:182},dest,{},'invalid-origin'],
  [{...room,lng:0,lat:0},dest,{},'invalid-origin'],
  [room,{...dest,lng:NaN},{},'unverified-destination'],
  [room,{...dest,verified:false},{},'unverified-destination']
 ])assert.equal((await walkingRoute(r,d,{...opts,env:{...opts.env,...env}})).reason,reason);
 assert.equal(calls,0);
 assert.deepEqual(walkingSettings({}),{enabled:false,keyConfigured:false,dailyLimit:200,maxPerSearch:5,cacheAllowed:false,diagnosticEnabled:false,oneShotAllowed:true});
 assert.equal(walkingSettings({ENABLE_TMAP_DIAGNOSTICS:'false'}).oneShotAllowed,false);
 assert.equal(walkingSettings({TMAP_DAILY_APP_LIMIT:'5000'}).dailyLimit,200);
 assert.equal(walkingSettings({TMAP_DAILY_APP_LIMIT:'NaN'}).dailyLimit,0);
 assert.equal(walkingSettings({TMAP_MAX_ROUTES_PER_SEARCH:'7'}).maxPerSearch,5);
});

test('walking never converts segment data, empty feature lists or malformed summaries into route time',async()=>{
 for(const [data,reason] of [
  [{features:[]},'route-not-found'],[{},'invalid-response'],
  [{features:[{properties:{distance:500,time:640}}]},'invalid-response'],
  [summary(null,600),'invalid-response'],[summary(30,'600'),'invalid-response'],
  [summary(30,-1),'invalid-response'],[summary(0,0),'invalid-response']
 ]){
  const result=await walkingRoute(room,dest,fixture(async()=>Response.json(data)));
  assert.equal(result.status,'unconfirmed');assert.equal(result.reason,reason);
  assert.equal(result.durationMinutes,undefined);
 }
});

test('walking distinguishes HTTP errors, invalid JSON, timeout and transport failure without another TMAP attempt',async()=>{
 for(const [response,reason] of [
  [401,'authentication'],[403,'authentication'],[429,'upstream-rate-limit'],[503,'upstream-server'],
  [404,'upstream-request'],[204,'route-not-found'],[400,'upstream-request'],[new SyntaxError('JSON'),'invalid-response'],
  [new DOMException('timeout','TimeoutError'),'timeout'],[new Error('offline'),'network']
 ]){
  let calls=0;
  const opts=fixture(async()=>{calls++;if(response instanceof Error)throw response;return new Response(null,{status:response});});
  const result=await walkingRoute(room,dest,opts);
  assert.equal(result.reason,reason);
  assert.equal((await walkingRoute(room,dest,opts)).reason,'cooldown');
  assert.equal(calls,1);assert.equal(await walkingUsage(opts.store),1);
 }
});

test('permitted walking cache expires within 23 hours and coordinates/accuracy must match',async()=>{
 let calls=0;
 const opts=fixture(async()=>{calls++;return Response.json(summary());});
 opts.env.TMAP_ROUTE_CACHE_ALLOWED='true';
 const get=(r=room,d=dest)=>walkingRoute(r,d,opts);
 const first=await get();
 opts.store.now+=300000;
 const second=await get();
 assert.equal(second.cacheHit,true);
 assert.equal(first.calculatedAt,second.calculatedAt);
 assert.equal(calls,1);
 assert.equal((await get({...room,lng:room.lng+0.000001})).cacheHit,false);
 assert.equal((await get(room,{...dest,lat:dest.lat+0.000001})).cacheHit,false);
 const updatedPrecision=await get(room,{...dest,precision:'verified-entrance'});
 assert.equal(updatedPrecision.cacheHit,false);
 assert.notEqual(updatedPrecision.destinationVersion,first.destinationVersion);
 assert.equal(updatedPrecision.destinationPrecision,'verified-entrance');
 assert.equal((await get({...room,approximate:false})).originApproximate,false);
 opts.store.now+=23*3600000;
 assert.equal((await get()).cacheHit,false);
 assert.equal(calls,6);
 const datum=[...opts.store.data.values()].find(x=>typeof x==='string'&&x.includes('distanceMeters'));
 assert.ok(datum&&!datum.includes('coordinates":[['));
});

test('concurrent requests for the same walk share one in-flight result with no persistence',async()=>{
 let count=0,release;
 const wait=new Promise(resolve=>{release=resolve;});
 const opts=fixture(async()=>{count++;await wait;return Response.json(summary());});
 const first=walkingRoute(room,dest,opts),second=walkingRoute(room,dest,opts);
 release();
 assert.deepEqual(await first,await second);
 assert.equal(count,1);
 assert.equal(await walkingUsage(opts.store),1);
 assert.ok(!JSON.stringify(opts.store.calls).includes('durationMinutes'));
});

test('daily, per-client and concurrent route budgets reject before a new request and reset by KST day',async()=>{
 let calls=0;
 const opts=fixture(async()=>{calls++;return Response.json(summary());});
 const get=i=>walkingRoute({...room,id:'r'+i},dest,opts);
 opts.env.TMAP_DAILY_APP_LIMIT='1';
 opts.store.now=Date.parse('2026-11-19T14:59:59Z');
 await get(0);
 assert.equal((await get(1)).reason,'daily-limit');
 assert.equal(calls,1);
 opts.store.now+=1000;
 assert.equal((await get(1)).status,'success');
 opts.env.TMAP_DAILY_APP_LIMIT='200';
 for(let i=2;i<15;i++)await get(i);
 assert.equal((await get(15)).reason,'user-rate-limit');
 opts.store.now+=60000;
 opts.store.active=new Set(['1','2','3','4','5']);
 assert.equal((await get(16)).reason,'concurrent-limit');
 assert.equal(calls,15);
});

test('administrator may stage three checks after separate diagnostic opt-in, sharing the daily quota',async()=>{
 let calls=0;
 const opts=fixture(async()=>{calls++;return Response.json(summary());});
 opts.env.ENABLE_WALKING_ROUTES='false';opts.env.ENABLE_TMAP_DIAGNOSTICS='true';
 const get=(i,extra)=>walkingRoute({...room,id:'r'+i},dest,{...opts,...extra});
 assert.equal((await get(0)).reason,'disabled');
 assert.equal((await get(0,{req:{headers:{}},diagnostic:true})).reason,'unauthorized');
 for(let i=0;i<3;i++)assert.equal((await get(i,{diagnostic:true})).status,'success');
 assert.equal((await get(3,{diagnostic:true})).reason,'diagnostic-limit');
 assert.equal(calls,3);
 assert.equal(await walkingUsage(opts.store),3);
});

test('Redis reservation errors and malformed replies fail closed',async()=>{
 let calls=0;
 const opts=fixture(async()=>{calls++;return Response.json(summary());});
 for(const command of [async()=>{throw Error('Redis offline');},async()=>null]){
  assert.equal((await walkingRoute(room,dest,{...opts,store:{command}})).reason,'redis-unavailable');
 }
 assert.equal(calls,0);
});

test('concurrent Vercel instances reuse a permitted pending route through Redis',async()=>{
 const otherInstance=await import('../lib/walking.js?walking-worker=2');
 let upstream=0,start,release;
 const started=new Promise(resolve=>{start=resolve;});
 const wait=new Promise(resolve=>{release=resolve;});
 const opts=fixture(async()=>{upstream++;start();await wait;return Response.json(summary());});
 opts.env.TMAP_ROUTE_CACHE_ALLOWED='true';
 const leader=walkingRoute(room,dest,opts);
 await started;
 const follower=otherInstance.walkingRoute(room,dest,opts);
 release();
 const [a,b]=await Promise.all([leader,follower]);
 assert.equal(a.status,'success');
 assert.equal(b.cacheHit,true);assert.equal(b.calculatedAt,a.calculatedAt);
 assert.equal(upstream,1);
});

test('TMAP HTTP 400 with pedestrian error 3002 identifies an unsupported section',async()=>{
 const opts=fixture(async()=>Response.json({error:{code:'3002',message:'unused'}},{status:400}));
 assert.equal((await walkingRoute(room,dest,opts)).reason,'route-not-found');
});

test('one staged check requires explicit free-plan confirmation and admin auth; normal search cannot enable it',async()=>{
 let calls=0;
 const opts=fixture(async()=>{calls++;return Response.json(summary());});
 delete opts.env.ENABLE_WALKING_ROUTES;
 opts.env.DATA_RIGHTS_REVIEWED='true';
 const get=extra=>walkingRoute(room,dest,{...opts,...extra});
 assert.equal((await get({diagnostic:true})).reason,'disabled');
 assert.equal((await get({confirmFreePlan:true})).reason,'disabled');
 assert.equal((await get({diagnostic:true,confirmFreePlan:true,req:{headers:{}}})).reason,'unauthorized');
 assert.equal((await get({diagnostic:true,confirmFreePlan:true,env:{...opts.env,ENABLE_TMAP_DIAGNOSTICS:'false'}})).reason,'disabled');
 assert.equal((await get({diagnostic:true,confirmFreePlan:true})).status,'success');
 assert.equal(calls,1);
 assert.equal(await walkingUsage(opts.store),1);
});
