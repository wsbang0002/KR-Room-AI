import {HttpError} from './security.js';
// Deliberately conservative: finalized actual charges remain reserved this cycle,
// even when also included in the observed account usage. Never underestimate lag.
export const MONTHLY_RESERVE=`
local old=redis.call('GET',KEYS[1]);if old then return old end
if redis.call('EXISTS',KEYS[5])==1 then return 'ACTIVE' end
local count=tonumber(redis.call('GET',KEYS[2]) or '0')
local daily=tonumber(redis.call('GET',KEYS[3]) or '0')
local reserved=tonumber(redis.call('GET',KEYS[4]) or '0')
local observed=tonumber(redis.call('GET',KEYS[7]) or '0')
observed=math.max(observed,tonumber(ARGV[6]))
if count>=tonumber(ARGV[2]) or daily+tonumber(ARGV[3])>tonumber(ARGV[4]) or observed+reserved+tonumber(ARGV[3])>tonumber(ARGV[7]) then return 'LIMIT' end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[5]);redis.call('SET',KEYS[5],ARGV[8],'EX',ARGV[9])
redis.call('INCR',KEYS[2]);redis.call('EXPIRE',KEYS[2],172800)
redis.call('INCRBY',KEYS[3],ARGV[3]);redis.call('EXPIRE',KEYS[3],172800)
redis.call('INCRBY',KEYS[4],ARGV[3]);redis.call('EXPIRE',KEYS[4],ARGV[9])
redis.call('SET',KEYS[7],observed,'EX',ARGV[9]);redis.call('SET',KEYS[6],ARGV[10],'EX',ARGV[9])
return 'RESERVED'`;
export const SETTLE=`
local raw=redis.call('GET',KEYS[1]);if not raw then return 'MISSING' end
local r=cjson.decode(raw);if r.settled then return 'SETTLED' end
local actual=tonumber(ARGV[1]);local refund=math.max(0,r.costMicros-actual)
redis.call('DECRBY',KEYS[2],refund);r.actualMicros=actual;r.settled=true;r.finishedAt=ARGV[2]
redis.call('SET',KEYS[1],cjson.encode(r),'KEEPTTL')
if redis.call('GET',KEYS[3])==r.requestId then redis.call('DEL',KEYS[3]) end
return 'SETTLED'`;
export async function reserveMonthly(db,{key,user,job,budget,cfg,now=Date.now()}){
 const start=Date.parse(budget.cycle?.startAt),end=Date.parse(budget.cycle?.endAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||now<start||now>end||end<=start)throw new HttpError(402,'과금 주기를 검증할 수 없어 신규 수집을 차단합니다.');
 const cycle=budget.cycle.startAt,day=new Date(now).toISOString().slice(0,10),costMicros=Math.ceil(cfg.max*1e6),ttl=Math.ceil((end-now)/1000)+7*86400;
 const ledger=`knuroom:budget:${cycle}:reserved`,reservationKey=`knuroom:budget:reservation:${job.requestId}`;
 const reservation={requestId:job.requestId,costMicros,cycle,ledger,settled:false};
 const value={...job,reservationKey,reservation,reservationTtl:ttl};
 const result=await db.command(['EVAL',MONTHLY_RESERVE,7,key,`knuroom:collect:count:${day}:${user}`,`knuroom:collect:budget:${day}`,ledger,'knuroom:apify:active',reservationKey,`knuroom:budget:${cycle}:observed`,JSON.stringify(value),cfg.limit,costMicros,Math.floor(cfg.daily*1e6),ttl,Math.ceil(budget.spentUsd*1e6),Math.floor(budget.appStopUsd*1e6),job.requestId,ttl,JSON.stringify(reservation)]);
 if(result==='ACTIVE')throw new HttpError(409,'다른 수집이 실행 중이거나 시작 여부가 미확인입니다.');
 if(result==='LIMIT')throw new HttpError(429,'BUDGET_EXHAUSTED: 신규 수집 예산 또는 호출 한도에 도달했습니다. 저장된 매물은 검색할 수 있습니다.');
 return result==='RESERVED'?{job:value,previous:null}:{job:null,previous:JSON.parse(result)};
}
export async function settleMonthly(db,job,run){
 if(!job.reservationKey||!job.reservation)return false;
 const cost=run.usageTotalUsd;
 if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0)return false; // Unconfirmed charges keep reservation + global lock.
 const actual=Math.ceil(cost*1e6);
 if(actual>job.reservation.costMicros)throw new HttpError(402,'실제 실행 비용이 예약액을 초과했습니다. 신규 실행을 중지하고 계정을 확인하세요.');
 const result=await db.command(['EVAL',SETTLE,3,job.reservationKey,job.reservation.ledger,'knuroom:apify:active',actual,new Date().toISOString()]);
 return result==='SETTLED';
}
