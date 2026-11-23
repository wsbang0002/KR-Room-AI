import {HttpError} from './security.js';
// Deliberately conservative: finalized actual charges remain reserved this cycle,
// even when also included in the observed account usage. Never underestimate lag.
// Shared checks use the monthly ledger, active lock and observed spend.
const capacityCheck=`
if redis.call('EXISTS',KEYS[2])==1 then return {'ACTIVE'} end
local function counter(key)
 local raw=redis.call('GET',key)
 if not raw or raw=='0' then return 0 end
 if not string.match(raw,'^[1-9]%d*$') then return nil end
 local n=tonumber(raw)
 if not n or n>9007199254740991 then return nil end
 return n
end
local reserved=counter(KEYS[1])
local observed=counter(KEYS[3])
if not reserved or not observed then return {'INVALID_COUNTER'} end
observed=math.max(observed,tonumber(ARGV[2]))
if observed+reserved+tonumber(ARGV[1])>tonumber(ARGV[3]) then return {'MONTHLY_BUDGET_LIMIT',observed,reserved} end
`;
export const INSPECT_MONTHLY=capacityCheck+"return {'AVAILABLE',observed,reserved}";
export const MONTHLY_RESERVE=`
local old=redis.call('GET',KEYS[4]);if old then return old end
${capacityCheck}
redis.call('SET',KEYS[4],ARGV[4],'EX',ARGV[5]);redis.call('SET',KEYS[2],ARGV[6],'EX',ARGV[5])
redis.call('INCRBY',KEYS[1],ARGV[1]);redis.call('EXPIRE',KEYS[1],ARGV[5])
redis.call('SET',KEYS[3],observed,'EX',ARGV[5]);redis.call('SET',KEYS[5],ARGV[7],'EX',ARGV[5])
return 'RESERVED'`;
export const SETTLE=`
local raw=redis.call('GET',KEYS[1]);if not raw then return 'MISSING' end
local r=cjson.decode(raw);if r.settled then return 'SETTLED' end
local actual=tonumber(ARGV[1]);local refund=math.max(0,r.costMicros-actual)
redis.call('DECRBY',KEYS[2],refund);r.actualMicros=actual;r.settled=true;r.finishedAt=ARGV[2]
redis.call('SET',KEYS[1],cjson.encode(r),'KEEPTTL')
if redis.call('GET',KEYS[3])==r.requestId then redis.call('DEL',KEYS[3]) end
return 'SETTLED'`;
function capacityInputs(budget,cfg,now){
 const cycle=budget.cycle?.startAt;
 const start=Date.parse(cycle),end=Date.parse(budget.cycle?.endAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(now)||now<start||now>=end||end<=start)
  throw new HttpError(402,'과금 주기를 검증할 수 없어 신규 수집을 차단합니다.');
 const ledger=`knuroom:budget:${cycle}:reserved`;
 const cost=Math.ceil(cfg.max*1e6);
 const spent=Math.ceil(budget.spentUsd*1e6),stop=Math.floor(budget.appStopUsd*1e6);
 if(![cfg.max,budget.appStopUsd,budget.spentUsd].every(Number.isFinite)||budget.spentUsd<0||
    ![cost,stop].every(v=>Number.isSafeInteger(v)&&v>0)
    ||!Number.isSafeInteger(spent)||spent<0)throw new HttpError(503,'비용 제한 수치를 확인할 수 없습니다.');
 const keys=[ledger,'knuroom:apify:active',`knuroom:budget:${cycle}:observed`];
 return {keys,args:[cost,spent,stop],cost,stop,end,ledger,cycle};
}

const dollars=micros=>'$'+(micros/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6});
const koreaTime=ms=>new Date(ms+9*3600000).toISOString().slice(0,16).replace('T',' ');

function capacityReport(reply,settings){
 const invalid=()=>new HttpError(503,'Redis 예산 집계값을 확인할 수 없습니다.');
 if(!Array.isArray(reply)||!reply.length)throw invalid();
 const [code,...values]=reply;
 if(!values.every(v=>Number.isSafeInteger(v)&&v>=0))throw invalid();
 const {cost,stop,end}=settings;
 let message;
 switch(code){
  case 'AVAILABLE':
   if(values.length!==2||values[0]+values[1]+cost>stop)throw invalid();
   message=`월 관측 사용액 ${dollars(values[0])}, 앱의 월 누적 예약·정산액 ${dollars(values[1])}, 중단선 ${dollars(stop)}입니다. 현재 집계 기준으로 이번 수집 ${dollars(cost)}을 예약할 수 있습니다.`;
   break;
  case 'ACTIVE':
   if(values.length)throw invalid();
   message='다른 수집이 실행 중이거나 시작 여부가 미확인입니다.';
   break;
  case 'MONTHLY_BUDGET_LIMIT':
   if(values.length!==2)throw invalid();
   message=`월 관측 사용액 ${dollars(values[0])}, 앱의 월 누적 예약·정산액 ${dollars(values[1])}, 이번 예약 ${dollars(cost)}의 합계가 중단선 ${dollars(stop)}을 초과합니다. 정산 후 또는 과금 주기 종료(한국 시간 ${koreaTime(end)}) 후에 잔여 예산을 다시 확인하세요.`;
   break;
  default: throw invalid();
 }
 return {allowed:code==='AVAILABLE',code,message};
}

export async function inspectMonthlyBudget(db,{budget,cfg,now=Date.now()}){
 const settings=capacityInputs(budget,cfg,now);
 const reply=await db.command(['EVAL',INSPECT_MONTHLY,3,...settings.keys,...settings.args]);
 return capacityReport(reply,settings);
}

export async function reserveMonthly(db,{key,job,budget,cfg,now=Date.now()}){
 const settings=capacityInputs(budget,cfg,now);
 const ttl=Math.ceil((settings.end-now)/1000)+7*86400;
 const reservationKey=`knuroom:budget:reservation:${job.requestId}`;
 const reservation={requestId:job.requestId,costMicros:settings.cost,cycle:settings.cycle,ledger:settings.ledger,settled:false};
 const value={...job,reservationKey,reservation,reservationTtl:ttl};
 const result=await db.command(['EVAL',MONTHLY_RESERVE,5,...settings.keys,key,reservationKey,...settings.args,
  JSON.stringify(value),ttl,job.requestId,JSON.stringify(reservation)]);
 if(result==='RESERVED')return {job:value,previous:null};
 if(Array.isArray(result)){
  const {code,message}=capacityReport(result,settings);
  if(code==='ACTIVE')throw new HttpError(409,message);
  if(code==='AVAILABLE')throw new HttpError(503,'비용 예약 결과를 확인할 수 없습니다.');
  const error=new HttpError(429,`BUDGET_EXHAUSTED: ${message}`);
  error.code=code;
  throw error;
 }
 const previous=typeof result==='string'?JSON.parse(result):null;
 if(!previous||previous.id!==job.id||!previous.requestId)throw new HttpError(503,'비용 예약 결과를 확인할 수 없습니다.');
 return {job:null,previous};
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
