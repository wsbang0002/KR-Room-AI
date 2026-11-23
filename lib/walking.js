import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {admin,inventoryReader,visitorRateKey} from './security.js';
import {redis} from './store.js';
import {requestMotorSummary} from './motor-routes.js';
import {requestKakaoBus} from './kakao-transit.js';

const PREFIX='knuroom:route:walking:';
function routePrefix(mode,provider='tmap'){
 return provider==='kakao'?'knuroom:route:kakao:bus:':'knuroom:route:'+mode+':';
}
const CACHE_SECONDS=23*3600;
const TIMEOUT_MS=4500;
const MAX_ACTIVE=5;
const USER_PER_MINUTE=15;
const DIAGNOSTICS_PER_DAY=3;
const inFlight=new Map();
const hash=value=>createHash('sha256').update(value).digest('hex');

// The lease, all quota checks and all increments succeed in a single Redis operation.
// Counts are attempts. An ambiguous transport outcome never refunds an attempt.
export const RESERVE_WALK=`
if ARGV[1]=='1' then
 local cached=redis.call('GET',KEYS[1]); if cached then return {'cached',cached} end
end
local lock=redis.call('GET',KEYS[2])
if lock then return {lock=='cooldown' and 'cooldown' or 'pending'} end
local now=tonumber(redis.call('TIME')[1])
redis.call('ZREMRANGEBYSCORE',KEYS[6],'-inf',now)
if redis.call('ZCARD',KEYS[6])>=tonumber(ARGV[7]) then return {'concurrent-limit'} end
if tonumber(redis.call('GET',KEYS[3]) or '0')>=tonumber(ARGV[2]) then return {'daily-limit'} end
if tonumber(redis.call('GET',KEYS[4]) or '0')>=tonumber(ARGV[3]) then return {'user-rate-limit'} end
if ARGV[4]=='1' and tonumber(redis.call('GET',KEYS[5]) or '0')>=tonumber(ARGV[5]) then return {'diagnostic-limit'} end
redis.call('SET',KEYS[2],ARGV[6],'EX',30)
redis.call('ZADD',KEYS[6],now+30,ARGV[6]); redis.call('EXPIRE',KEYS[6],60)
redis.call('INCR',KEYS[3]); redis.call('EXPIRE',KEYS[3],172800)
if redis.call('INCR',KEYS[4])==1 then redis.call('EXPIRE',KEYS[4],60) end
if ARGV[4]=='1' then redis.call('INCR',KEYS[5]); redis.call('EXPIRE',KEYS[5],172800) end
return {'owner'}`;

export const FINISH_WALK=`
if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
if ARGV[2]~='' then
 redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); redis.call('DEL',KEYS[2])
else
 redis.call('SET',KEYS[2],'cooldown','EX',10)
end
redis.call('ZREM',KEYS[3],ARGV[1])
return 1`;

function boundedLimit(value,max){
 if(value===undefined||value==='')return max;
 const n=Number(value);
 return Number.isSafeInteger(n)&&n>=0?Math.min(n,max):0;
}

export function walkingSettings(env=process.env){
 const approvedProduction=Boolean(env.WALKING_ROUTES_PRODUCTION_HOST)&&env.VERCEL==='1'&&
  env.VERCEL_ENV==='production'&&env.VERCEL_PROJECT_PRODUCTION_URL===env.WALKING_ROUTES_PRODUCTION_HOST;
 const enabled=env.ENABLE_WALKING_ROUTES===undefined?approvedProduction:env.ENABLE_WALKING_ROUTES==='true';
 return {
  keyConfigured:Boolean(env.TMAP_APP_KEY),
  enabled,
  oneShotAllowed:env.ENABLE_TMAP_DIAGNOSTICS!=='false',
  diagnosticEnabled:env.ENABLE_TMAP_DIAGNOSTICS==='true'||(enabled&&env.ENABLE_TMAP_DIAGNOSTICS!=='false'),
  cacheAllowed:env.TMAP_ROUTE_CACHE_ALLOWED==='true',
  dailyLimit:boundedLimit(env.TMAP_DAILY_APP_LIMIT,200),
  maxPerSearch:boundedLimit(env.TMAP_MAX_ROUTES_PER_SEARCH,5)
 };
}

export function listingRouteSettings(mode,env=process.env){
 const settings=walkingSettings(env);
 if(mode==='walking')return {...settings,provider:'tmap'};
 let provider='tmap',keyConfigured=settings.keyConfigured,dailyLimit=settings.dailyLimit;
 if(mode==='bus'){
  if(env.KAKAO_REST_API_KEY){
   provider='kakao';
   dailyLimit=boundedLimit(env.KAKAO_TRANSIT_DAILY_APP_LIMIT,100);
  }else{
   provider=env.TMAP_TRANSIT_APP_KEY?'tmap':null;
   dailyLimit=boundedLimit(env.TMAP_TRANSIT_DAILY_APP_LIMIT,10);
  }
  keyConfigured=provider!==null;
 }else if(mode!=='car'){
  provider=null;
  keyConfigured=false;
 }
 return {
  ...settings,provider,keyConfigured,enabled:settings.enabled&&keyConfigured,
  oneShotAllowed:false,diagnosticEnabled:false,cacheAllowed:false,maxPerSearch:1,dailyLimit
 };
}

function dayKey(now,mode='walking',provider='tmap'){
 const kstDate=new Date(Number(now)+9*3600*1000).toISOString().slice(0,10);
 // SK's Free automobile and pedestrian routes share a quota. Keep the original
 // counter across deployments; public-transit requests have a separate product.
 return (mode==='bus'?routePrefix('bus',provider):PREFIX)+'count:'+kstDate;
}

export async function walkingUsage(db,now=Date.now()){
 const value=await db.command(['GET',dayKey(now)]);
 const count=Number(value??0);
 if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid walking usage counter');
 return count;
}

export function validWalkingPoint(point){
 // TMAP pedestrian routing is a South Korea service, including Jeju and outlying islands.
 return Number.isFinite(point?.lat)&&point.lat>=32&&point.lat<=39&&
  Number.isFinite(point?.lng)&&point.lng>=124&&point.lng<=132;
}

export const unconfirmedRoute=(reason,mode='walking',provider='tmap')=>({status:'unconfirmed',mode,provider,reason,cacheHit:false});

function httpReason(status){
 if(status===401||status===403)return 'authentication';
 if(status===429)return 'upstream-rate-limit';
 if(status>=500)return 'upstream-server';
 return 'upstream-request';
}

function transportReason(error){
 if(error.name==='AbortError'||error.name==='TimeoutError')return 'timeout';
 if(error instanceof SyntaxError)return 'invalid-response';
 return 'network';
}

async function requestWalkingSummary(listing,destination,{env,fetcher,signal}){
  const response=await fetcher('https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1',{
   signal,method:'POST',redirect:'error',
   headers:{Accept:'application/json','Content-Type':'application/json',appKey:env.TMAP_APP_KEY},
   body:JSON.stringify({
    startX:listing.lng,startY:listing.lat,endX:destination.lng,endY:destination.lat,
    startName:'Origin',endName:'Destination',reqCoordType:'WGS84GEO',resCoordType:'WGS84GEO',searchOption:'0'
   })
  });
  if(response.status===204)return {reason:'route-not-found'};
  if(!response.ok){
   if(response.status===400){
    // Official pedestrian error 3002 means this section is not routable.
    const body=await response.json().catch(()=>null);
    if(String(body?.error?.code)==='3002')return {reason:'route-not-found'};
   }
   return {reason:httpReason(response.status)};
  }
  const data=await response.json();
  if(!Array.isArray(data?.features))return {reason:'invalid-response'};
  if(!data.features.length)return {reason:'route-not-found'};
  // totalDistance and totalTime occur together on the route's departure feature.
  const summary=data.features.find(feature=>feature?.properties?.pointType==='SP')?.properties;
  return {distanceMeters:summary?.totalDistance,durationSeconds:summary?.totalTime};
}

async function requestSummary(listing,destination,context){
 const {mode,env,fetcher}=context;
 const {provider}=context.settings;
 try{
  const options={env,fetcher,signal:AbortSignal.timeout(TIMEOUT_MS)};
  let summary;
  if(provider==='kakao')summary=await requestKakaoBus(listing,destination,options);
  else if(mode==='walking')summary=await requestWalkingSummary(listing,destination,options);
  else summary=await requestMotorSummary(mode,listing,destination,options);
  if(summary.reason)return unconfirmedRoute(summary.reason,mode,provider);
  const {distanceMeters,durationSeconds}=summary;
  if(!validTotals(distanceMeters,durationSeconds)||
   (distanceMeters===0&&(listing.lat!==destination.lat||listing.lng!==destination.lng)))return unconfirmedRoute('invalid-response',mode,provider);
  return {...context.descriptor,status:'success',mode,provider,
   distanceMeters,durationSeconds,durationMinutes:Math.ceil(durationSeconds/60),
   confidence:context.descriptor.originApproximate?'approximate-origin':'coordinates',
   calculatedAt:new Date(context.now()).toISOString(),validation:'verified',cacheHit:false};
 }catch(error){return unconfirmedRoute(transportReason(error),mode,provider);}
}

function validTotals(distance,seconds){
 return Number.isSafeInteger(distance)&&distance>=0&&Number.isSafeInteger(seconds)&&seconds>=0&&
  (distance===0)===(seconds===0);
}

function readCached(value,descriptor,now){
 const result=typeof value==='string'?JSON.parse(value):value;
 const age=now-Date.parse(result?.calculatedAt);
 if(!result||result.status!=='success'||result.mode!=='walking'||result.provider!=='tmap'||
  result.validation!=='verified'||!validTotals(result.distanceMeters,result.durationSeconds)||
  result.durationMinutes!==Math.ceil(result.durationSeconds/60)||!(age>=0&&age<CACHE_SECONDS*1000)||
  !Object.entries(descriptor).every(([k,v])=>result[k]===v))return unconfirmedRoute('invalid-cache');
 return {...result,cacheHit:true};
}

async function run(listing,destination,context){
 const {db,cacheKey,descriptor,settings,user,diagnostic,now,mode}=context;
 const unavailable=reason=>unconfirmedRoute(reason,mode,settings.provider);
 const lock=cacheKey+':lock';
 const active=PREFIX+'active';
 const counter=dayKey(now(),mode,settings.provider);
 const token=randomUUID();
 try{
  const reply=await db.command(['EVAL',RESERVE_WALK,6,cacheKey,lock,counter,PREFIX+'user:'+user,
   counter+':diagnostic',active,settings.cacheAllowed?'1':'0',settings.dailyLimit,USER_PER_MINUTE,
   diagnostic?'1':'0',DIAGNOSTICS_PER_DAY,token,MAX_ACTIVE]);
  if(!Array.isArray(reply))return unavailable('redis-unavailable');
  const [state,stored]=reply;
  if(state==='cached')return settings.cacheAllowed?readCached(stored,descriptor,now()):unavailable('invalid-cache');
  if(state==='pending'&&settings.cacheAllowed){
   // Only a permitted cached summary may cross instance boundaries.
   for(const wait of [150,400,900,1400,1600,2000]){
    await delay(wait);
    const [value,owner]=await db.command(['MGET',cacheKey,lock]);
    if(value)return readCached(value,descriptor,now());
    if(!owner||owner==='cooldown')break;
   }
  }
  if(state!=='owner')return unavailable(state);
  const result=await requestSummary(listing,destination,context);
  const persisted=settings.cacheAllowed&&result.status==='success'?JSON.stringify(result):'';
  try{await db.command(['EVAL',FINISH_WALK,3,cacheKey,lock,active,token,persisted,CACHE_SECONDS]);}catch{
   // The reservation remains charged and the exclusive lease expires by itself.
  }
  return result;
 }catch{return unavailable('redis-unavailable');}
}

export async function walkingRoute(listing,destination,{
 req,env=process.env,store,fetcher=fetch,diagnostic=false,confirmFreePlan=false,now=Date.now,publicLandmark=false,mode='walking'
}={}){
 if(!['walking','car','bus'].includes(mode))return unconfirmedRoute('unsupported-mode');
 const settings=listingRouteSettings(mode,env);
 const unavailable=reason=>unconfirmedRoute(reason,mode,settings.provider);
 if(mode!=='walking'&&(diagnostic||publicLandmark))return unavailable('disabled');
 const oneShot=diagnostic===true&&confirmFreePlan===true&&settings.oneShotAllowed;
 if(!(diagnostic?settings.diagnosticEnabled||oneShot:settings.enabled))return unavailable('disabled');
 if(!settings.keyConfigured)return unavailable('missing-key');
 if(!listing?.id||!validWalkingPoint(listing))return unavailable('invalid-origin');
 if(!destination?.id||destination.verified!==true||!validWalkingPoint(destination))return unavailable('unverified-destination');
 let user;
 try{
  if(diagnostic)user=admin(req,env);
  else user=publicLandmark?visitorRateKey(req,env):inventoryReader(req,env);
 }catch{return unavailable('unauthorized');}
 const originApproximate=listing.approximate!==false;
 const destinationPrecision=destination.precision??destination.accuracy??null;
 const descriptor={
  ...(publicLandmark?{publicOriginId:listing.id}:{listingId:String(listing.id)}),
  destinationId:String(destination.id),originApproximate,destinationPrecision,
  originVersion:hash(JSON.stringify([listing.lat,listing.lng,originApproximate])),
  destinationVersion:hash(JSON.stringify([destination.lat,destination.lng,destinationPrecision]))
 };
 const cacheKey=routePrefix(mode,settings.provider)+(publicLandmark?'public-station:':'')+encodeURIComponent(listing.id)+':'+encodeURIComponent(descriptor.destinationId)+':'+
  hash(descriptor.originVersion+descriptor.destinationVersion);
 // Do not share a Promise across Redis namespaces or cache permission settings.
 const localKey=JSON.stringify([env.UPSTASH_REDIS_REST_URL||'',settings.cacheAllowed,cacheKey]);
 if(inFlight.has(localKey))return inFlight.get(localKey);
 let db;
 try{db=store||redis(env,fetcher);}catch{return unavailable('redis-unavailable');}
 const work=run(listing,destination,{env,fetcher,db,descriptor,settings,user,diagnostic,now,cacheKey,mode});
 inFlight.set(localKey,work);
 try{return await work;}finally{inFlight.delete(localKey);}
}
