import {createHash,randomUUID} from 'node:crypto';
import {requireCollector,HttpError,jsonFetch} from './security.js';
import {redis} from './store.js';
import {resolveLocation} from './regions.js';
import {normalize} from './core.js';
import {apifyRunBudgetUsd,checkApifyBudget} from './apify-budget.js';
import {inspectMonthlyBudget,reserveMonthly,settleMonthly} from './monthly-budget.js';
import {findActiveCollection,findRecordedRunId} from './active-collection.js';
import {saveListings} from './listing-store.js';
export const ACTOR='sian.agency~dabang-property-scraper';
export const ACTOR_ID='UyPwsTVMZiuXdTS6T';
export const MAX_COLLECTION_RESULTS=20;
export function actorInput(c){
 const r=resolveLocation(c.location);if(r.status!=='resolved')throw new HttpError(422,'지역 선택이 필요합니다.');
 const types=c.roomTypes?.length?c.roomTypes:['ONE_ROOM','TWO_ROOM'];
 if(types.some(x=>!['ONE_ROOM','TWO_ROOM','THREE_ROOM','FOUR_ROOM'].includes(x)))throw new HttpError(422,'현재 신규 수집은 원룸·투룸·다룸만 지원합니다.');
 const input={scrapeMode:'detail',category:'one-two',place:r.location,sellingTypes:['MONTHLY_RENT'],roomTypes:types,maxResults:MAX_COLLECTION_RESULTS,maxPages:1};
 if(c.maxDeposit!=null)input.depositMax=Math.floor(c.maxDeposit);
 if(c.maxRent!=null||c.maxMonthlyTotal!=null)input.rentMax=Math.floor(Math.min(c.maxRent??Infinity,c.maxMonthlyTotal??Infinity));
 return input;
}
export function collectionReady(env=process.env){return env.ENABLE_LIVE_COLLECTION==='true'&&Boolean(env.APIFY_TOKEN&&env.ADMIN_API_KEY?.length>=24&&env.UPSTASH_REDIS_REST_URL&&env.UPSTASH_REDIS_REST_TOKEN);}
function config(env){
 if(!collectionReady(env))throw new HttpError(403,'신규 유료 수집이 잠겨 있습니다. 관리자·영속 제한 설정이 필요합니다.');
 const max=apifyRunBudgetUsd(env),ttl=Number(env.CACHE_TTL_SECONDS||3600);
 if(max===null||!Number.isInteger(ttl)||ttl<600||ttl>86400)throw new HttpError(503,'비용 제한 설정이 유효하지 않습니다.');
 return {max,ttl};
}

export async function readCollectionBudget({req,env=process.env,fetcher=fetch,store,now}={}){
 requireCollector(req,env);
 const cfg=config(env);
 const budget=await checkApifyBudget({env,fetcher,estimatedRunUsd:cfg.max});
 if(!budget.allowed){
  const code=budget.code==='BUDGET_EXHAUSTED'?'MONTHLY_BUDGET_LIMIT':budget.code;
  return {allowed:false,code,message:budget.reason};
 }
 return inspectMonthlyBudget(store||redis(env,fetcher),{budget,cfg,now});
}

export async function startCollection(c,{req,env=process.env,fetcher=fetch,store}={}){
 const user=requireCollector(req,env),cfg=config(env),input=actorInput(c),db=store||redis(env,fetcher);
 const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');const key=`knuroom:collect:${hash}`;
 const job={id:hash,user,conditions:c,input,requestId:randomUUID(),createdAt:new Date().toISOString(),state:'RESERVED'};
 const cached=await db.get(key);
 if(cached){if(cached.user!==user)throw new HttpError(403,'이전 관리자 수집 캐시입니다.');return {jobId:cached.id,runId:cached.runId||null,state:cached.state,cached:true,requestId:cached.requestId};}
 const budget=await checkApifyBudget({env,fetcher,estimatedRunUsd:cfg.max});
 if(!budget.allowed)throw new HttpError(402,`${budget.code}: ${budget.reason}`);
 const reserved=await reserveMonthly(db,{key,job,budget,cfg});
 const old=reserved.previous;
 if(old){if(old.user!==user)throw new HttpError(403,'이전 관리자 수집 캐시입니다.');return {jobId:old.id,runId:old.runId||null,state:old.state,cached:true,requestId:old.requestId};}
 Object.assign(job,reserved.job);
 // Only the Actor POST can leave the remote outcome uncertain. Never repeat it.
 let run;
 try{
  run=(await jsonFetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?build=1.0.12&waitForFinish=0&timeout=180&memory=1024&maxTotalChargeUsd=${cfg.max}`,{fetcher,method:'POST',headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(input)})).data;
  if(!run?.id||run.actId!==ACTOR_ID)throw Error('Invalid run');
 }catch{
  await updateCollection(db,key,job,current=>current.runId?current:{...current,state:'START_UNCONFIRMED'});
  throw new HttpError(502,'수집 시작 결과 미확인. 자동 재시도하지 않습니다. Apify 실행 이력을 확인하세요.');
 }
 const recordStart=()=>updateCollection(db,key,job,current=>current.runId?current:{...current,runId:run.id,state:run.status||'READY'});
 let saved;
 try{saved=await recordStart();}catch{saved=await recordStart();}
 if(saved?.runId!==run.id)throw new HttpError(503,'실행 ID를 저장하지 못했습니다. 기존 수집 상태를 확인하세요.');
 return {jobId:hash,runId:run.id,state:saved.state,cached:false,requestId:job.requestId};
}
export async function activeCollectionStatus({req,env=process.env,fetcher=fetch,store}={}){
 const user=requireCollector(req,env);
 const db=store||redis(env,fetcher);
 const active=await findActiveCollection(db,user);
 if(!active.jobId)return active;
 return collectionStatus(active.jobId,{req,env,fetcher,store:db,includeItems:true,expectedRequestId:active.requestId});
}

// Compare the exact stored JSON. This preserves arrays in legacy jobs and prevents
// an expired or replaced receipt from being resurrected by an in-flight poll.
export const COMMIT_COLLECTION=`
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL')
if KEYS[2] then redis.call('SET',KEYS[2],ARGV[3],'EX',86400) end
return 1`;

const terminal=state=>['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(state);
const confirmedCost=run=>typeof run?.usageTotalUsd==='number'&&Number.isFinite(run.usageTotalUsd)&&run.usageTotalUsd>=0;
function receiptChanged(recovering){
 if(recovering)return {state:'UNIDENTIFIED'};
 throw new HttpError(409,'조회 중 수집 작업이 바뀌었습니다. 이전 수집 상태를 확인하세요.');
}

function sameJob(current,job){
 return current?.id===job.id&&current.user===job.user&&current.requestId===job.requestId&&
  (!job.runId||current.runId===job.runId);
}

async function updateCollection(db,key,identity,update){
 for(let attempt=0;attempt<8;attempt++){
  const raw=await db.command(['GET',key]);
  const current=raw&&JSON.parse(raw);
  if(!sameJob(current,identity))return null;
  const next=update(current);
  if(next===current||!next)return next;
  const keys=[key],values=[raw,JSON.stringify(next)];
  if(next.runId&&(current.runId!==next.runId||current.state!==next.state)){
   keys.push('knuroom:apify:run:'+next.runId);
   values.push(JSON.stringify({requestId:next.requestId,jobId:next.id,state:next.state,createdAt:next.createdAt,updatedAt:new Date().toISOString()}));
  }
  if(await db.command(['EVAL',COMMIT_COLLECTION,keys.length,...keys,...values])===1)return next;
 }
 throw new HttpError(503,'수집 상태가 변경 중입니다. 다시 확인하세요.');
}

function mergeRun(job,run){
 if(job.runId&&job.runId!==run.id)return null;
 if(job.costSettled&&job.run)return job;
 if(terminal(job.state)&&job.state!==run.status)return job;
 if(job.state==='RUNNING'&&run.status==='READY')return job;
 if(terminal(job.run?.status)){
  // Final status is monotonic. A later receipt may fill in a missing cost or Dataset.
  const merged={...job.run};
  if(!confirmedCost(merged)&&confirmedCost(run))merged.usageTotalUsd=run.usageTotalUsd;
  if(!merged.defaultDatasetId&&run.defaultDatasetId)merged.defaultDatasetId=run.defaultDatasetId;
  if(!merged.finishedAt&&run.finishedAt)merged.finishedAt=run.finishedAt;
  if(JSON.stringify(merged)===JSON.stringify(job.run))return job;
  return {...job,run:merged};
 }
 return {...job,runId:run.id,state:run.status,run};
}

function resultLimit(job){return Math.min(job.input?.maxResults??MAX_COLLECTION_RESULTS,MAX_COLLECTION_RESULTS);}

function oversizedCharge(job){
 return Number.isSafeInteger(job.reservation?.costMicros)&&confirmedCost(job.run)&&
  Math.ceil(job.run.usageTotalUsd*1e6)>job.reservation.costMicros;
}

function statusResponse(job,includeItems){
 return {jobId:job.id,...(job.createdAt?{createdAt:job.createdAt}:{}),...(job.runId?{runId:job.runId,source:'apify-run',collectedAt:job.run?.finishedAt||null}:{}),
  state:job.state,conditions:job.conditions,maxResults:resultLimit(job),costSettled:job.costSettled===true,
  ...(!job.costSettled&&terminal(job.state)&&oversizedCharge(job)?{settlementIssue:'COST_EXCEEDS_RESERVATION'}:{}),
  ...(includeItems||!job.runId?{items:job.items||[]}:{})};
}

async function readExpectedJob(db,key,id,user,requestId){
 const [active,raw]=await db.command(['MGET','knuroom:apify:active',key]);
 if(active!==requestId||!raw)return null;
 let job;
 try{job=JSON.parse(raw);}catch{return null;}
 return job?.id===id&&job.user===user&&job.requestId===requestId?job:null;
}

export async function collectionStatus(id,{req,env=process.env,fetcher=fetch,store,includeItems=false,expectedRequestId}={}){
 const user=requireCollector(req,env);
 if(!/^[a-f0-9]{64}$/.test(id||''))throw new HttpError(400,'잘못된 작업 ID');
 const db=store||redis(env,fetcher),key='knuroom:collect:'+id;
 const recovering=expectedRequestId!==undefined;
 let job;
 if(recovering){
  job=await readExpectedJob(db,key,id,user,expectedRequestId);
  if(!job)return receiptChanged(recovering);
 }else{
  job=await db.get(key);
  if(!job||job.id!==id||job.user!==user)throw new HttpError(404,'수집 작업이 없거나 캐시가 만료되었습니다.');
 }
 let runId=job.runId;
 if(!runId&&recovering){
  const recorded=await findRecordedRunId(db,job);
  // Traversing older run indexes can overlap settlement or a new receipt.
  job=await readExpectedJob(db,key,id,user,expectedRequestId);
  if(!job)return receiptChanged(recovering);
  runId=job.runId||recorded;
 }
 if(!runId)return statusResponse(job,includeItems);
 const headers={Authorization:`Bearer ${env.APIFY_TOKEN}`};
 const needsReceipt=!job.runId||!terminal(job.run?.status)||(!job.costSettled&&!confirmedCost(job.run))||
    (job.state==='SUCCEEDED'&&!job.run.defaultDatasetId&&!job.items&&!job.pendingItems);
 if(needsReceipt){
  let run;
  try{
   if(!env.APIFY_TOKEN)throw new HttpError(503,'Apify 인증이 필요합니다.');
   run=(await jsonFetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`,{fetcher,headers})).data;
   if(run?.actId!==ACTOR_ID||run.id!==runId||typeof run.status!=='string')throw new HttpError(502,'수집 실행 검증 실패');
  }catch(error){
   if(!job.runId||!terminal(job.run?.status))throw error;
   if(Array.isArray(job.items))return statusResponse(job,includeItems);
   if(!Array.isArray(job.pendingItems))throw error;
   run=null;
  }
  if(run){
   job=await updateCollection(db,key,job,current=>mergeRun(current,run));
   if(!job)return receiptChanged(recovering);
  }
 }
 // Save the bounded Dataset even on a status-only poll. Staging the payload on
 // its receipt lets another worker resume if listing persistence is interrupted.
 if(job.state==='SUCCEEDED'&&!Array.isArray(job.items)&&!Array.isArray(job.pendingItems)){
  const dataset=job.run?.defaultDatasetId;
  if(!/^[a-zA-Z0-9]+$/.test(dataset||''))throw new HttpError(502,'Dataset 검증 실패');
  if(!env.APIFY_TOKEN)throw new HttpError(503,'Apify 인증이 필요합니다.');
  const maxResults=resultLimit(job);
  const raw=await jsonFetch(`https://api.apify.com/v2/datasets/${dataset}/items?format=json&clean=true&limit=${maxResults}`,{fetcher,headers});
  if(!Array.isArray(raw))throw new HttpError(502,'Dataset 형식 오류');
  const items=[...new Map(raw.slice(0,maxResults).map(normalize).filter(r=>r.id&&r.rent!=null).map(r=>[r.id,r])).values()];
  job=await updateCollection(db,key,job,current=>current.items||current.pendingItems?current:
   {...current,pendingItems:items,datasetCollectedAt:current.run.finishedAt||new Date().toISOString()});
  if(!job)return receiptChanged(recovering);
 }
 if(Array.isArray(job.pendingItems)&&!Array.isArray(job.items)){
  const saved=await saveListings(db,job.pendingItems,job.conditions.location,{
   now:job.datasetCollectedAt,runId:job.runId,cacheTtl:Math.max(60,Math.min(86400,Number(env.SEARCH_CACHE_TTL_SECONDS)||86400)),
   receipt:{key,raw:JSON.stringify(job)}
  });
  job=await updateCollection(db,key,job,current=>{
   if(saved===false||current.items)return current;
   const {pendingItems,...rest}=current;
   return {...rest,items:pendingItems};
  });
  if(!job)return receiptChanged(recovering);
  if(!Array.isArray(job.items))throw new HttpError(503,'수집 결과를 저장 중입니다. 다시 확인하세요.');
 }
 if(terminal(job.state)&&!job.costSettled&&confirmedCost(job.run)&&!oversizedCharge(job)){
  try{
   await settleMonthly(db,job,job.run);
  }catch(error){
   if(error.code!=='INVALID_LEDGER')throw error;
   return {...statusResponse(job,includeItems),settlementIssue:'INVALID_LEDGER'};
  }
  const current=await db.get(key);
  if(!sameJob(current,job))return receiptChanged(recovering);
  job=current;
 }
 return statusResponse(job,includeItems);
}
