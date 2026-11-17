import {jsonFetch,HttpError} from './security.js';
// All spending reservations and duplicate locks live in Redis, shared by Vercel instances.
export const RESERVE=`
local old=redis.call('GET',KEYS[1]); if old then return old end
local count=tonumber(redis.call('GET',KEYS[2]) or '0')
local spent=tonumber(redis.call('GET',KEYS[3]) or '0')
if count>=tonumber(ARGV[2]) or spent+tonumber(ARGV[3])>tonumber(ARGV[4]) then return 'LIMIT' end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[5])
redis.call('INCR',KEYS[2]);redis.call('EXPIRE',KEYS[2],172800)
redis.call('INCRBY',KEYS[3],ARGV[3]);redis.call('EXPIRE',KEYS[3],172800)
return 'RESERVED'`;
export function redis(env=process.env,fetcher=fetch){
 if(!env.UPSTASH_REDIS_REST_URL?.startsWith('https://')||!env.UPSTASH_REDIS_REST_TOKEN)throw new HttpError(503,'영속 비용 제한 저장소가 필요합니다.');
 const command=async args=>{const j=await jsonFetch(env.UPSTASH_REDIS_REST_URL,{fetcher,method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(args)});if(j.error)throw new HttpError(503,'비용 제한 저장소 오류');return j.result;};
 return {command,get:async key=>{const x=await command(['GET',key]);return x?JSON.parse(x):null;},set:async(key,value,ttl)=>command(['SET',key,JSON.stringify(value),'EX',ttl]),
 reserve:async({key,user,kind,limit,cost,budget,ttl,value,day=new Date().toISOString().slice(0,10)})=>{
  const r=await command(['EVAL',RESERVE,3,key,`knuroom:${kind}:count:${day}:${user}`,`knuroom:${kind}:budget:${day}`,JSON.stringify(value),limit,cost,budget,ttl]);
  if(r==='LIMIT')throw new HttpError(429,'일일 호출 또는 예산 상한에 도달했습니다.');return r==='RESERVED'?null:JSON.parse(r);
 }};
}
