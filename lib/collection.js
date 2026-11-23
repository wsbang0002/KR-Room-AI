import {createHash,randomUUID} from 'node:crypto';
import {admin,HttpError,jsonFetch} from './security.js';
import {redis} from './store.js';
import {resolveLocation} from './regions.js';
import {normalize} from './core.js';
import {apifyRunBudgetUsd,checkApifyBudget} from './apify-budget.js';
import {inspectMonthlyBudget,reserveMonthly,settleMonthly} from './monthly-budget.js';
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
 const max=apifyRunBudgetUsd(env),daily=Number(env.APIFY_DAILY_BUDGET_USD||1),limit=Number(env.COLLECTION_DAILY_LIMIT||2),ttl=Number(env.CACHE_TTL_SECONDS||3600);
 if(max===null||!Number.isFinite(daily)||daily<=0||daily>5||!Number.isInteger(limit)||limit<1||limit>10||!Number.isInteger(ttl)||ttl<600||ttl>86400)throw new HttpError(503,'비용 제한 설정이 유효하지 않습니다.');
 return {max,daily,limit,ttl};
}

export async function readCollectionBudget({req,env=process.env,fetcher=fetch,store,now}={}){
 const user=admin(req,env);
 const cfg=config(env);
 const budget=await checkApifyBudget({env,fetcher,estimatedRunUsd:cfg.max});
 if(!budget.allowed){
  const code=budget.code==='BUDGET_EXHAUSTED'?'MONTHLY_BUDGET_LIMIT':budget.code;
  return {allowed:false,code,message:budget.reason};
 }
 return inspectMonthlyBudget(store||redis(env,fetcher),{user,budget,cfg,now});
}

export async function startCollection(c,{req,env=process.env,fetcher=fetch,store}={}){
 const user=admin(req,env),cfg=config(env),input=actorInput(c),db=store||redis(env,fetcher);
 const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');const key=`knuroom:collect:${hash}`;
 const job={id:hash,user,conditions:c,input,requestId:randomUUID(),createdAt:new Date().toISOString(),state:'RESERVED'};
 const cached=await db.get(key);
 if(cached){if(cached.user!==user)throw new HttpError(403,'이전 관리자 수집 캐시입니다.');return {jobId:cached.id,runId:cached.runId||null,state:cached.state,cached:true,requestId:cached.requestId};}
 const budget=await checkApifyBudget({env,fetcher,estimatedRunUsd:cfg.max});
 if(!budget.allowed)throw new HttpError(402,`${budget.code}: ${budget.reason}`);
 const reserved=await reserveMonthly(db,{key,user,job,budget,cfg});
 const old=reserved.previous;
 if(old){if(old.user!==user)throw new HttpError(403,'이전 관리자 수집 캐시입니다.');return {jobId:old.id,runId:old.runId||null,state:old.state,cached:true,requestId:old.requestId};}
 Object.assign(job,reserved.job);
 // Never retry a timed-out POST automatically: the remote Actor may already be running.
 try{
 const run=(await jsonFetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?build=1.0.12&waitForFinish=0&timeout=180&memory=1024&maxTotalChargeUsd=${cfg.max}`,{fetcher,method:'POST',headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(input)})).data;
 if(!run?.id||run.actId!==ACTOR_ID)throw Error('Invalid run');
 Object.assign(job,{runId:run.id,state:run.status||'READY'});await db.set(`knuroom:apify:run:${run.id}`,{requestId:job.requestId,jobId:hash,state:job.state,createdAt:job.createdAt},86400);await db.set(key,job,job.reservationTtl||cfg.ttl);
 return {jobId:hash,runId:run.id,state:job.state,cached:false,requestId:job.requestId};
 }catch{job.state='START_UNCONFIRMED';await db.set(key,job,job.reservationTtl||cfg.ttl);throw new HttpError(502,'수집 시작 결과 미확인. 자동 재시도하지 않습니다. Apify 실행 이력을 확인하세요.');}
}
export async function collectionStatus(id,{req,env=process.env,fetcher=fetch,store,includeItems=false}={}){
 const user=admin(req,env);if(!/^[a-f0-9]{64}$/.test(id||''))throw new HttpError(400,'잘못된 작업 ID');
 const db=store||redis(env,fetcher),key=`knuroom:collect:${id}`,job=await db.get(key);
 if(!job||job.user!==user)throw new HttpError(404,'수집 작업이 없거나 캐시가 만료되었습니다.');
 const maxResults=Math.min(job.input?.maxResults??MAX_COLLECTION_RESULTS,MAX_COLLECTION_RESULTS);
 if(!job.runId)return {jobId:id,state:job.state,items:[],conditions:job.conditions,maxResults};
 if(!env.APIFY_TOKEN)throw new HttpError(503,'Apify 인증이 필요합니다.');
 let run=job.run;
 if(!run||!['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(run.status)||!job.costSettled){
  run=(await jsonFetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(job.runId)}`,{fetcher,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`}})).data;
  if(run?.actId!==ACTOR_ID||run?.id!==job.runId)throw new HttpError(502,'수집 실행 검증 실패');
  job.run=run;job.state=run.status;await db.set(`knuroom:apify:run:${job.runId}`,{requestId:job.requestId,jobId:id,state:run.status,updatedAt:new Date().toISOString()},86400);await db.set(key,job,job.costSettled?3600:(job.reservationTtl||3600));
 }
 if(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(run.status)&&!job.costSettled){job.costSettled=await settleMonthly(db,job,run);await db.set(key,job,job.costSettled?3600:(job.reservationTtl||3600));}
 let items=job.items;
 if(includeItems&&run.status==='SUCCEEDED'&&!items){
  if(!/^[a-zA-Z0-9]+$/.test(run.defaultDatasetId||''))throw new HttpError(502,'Dataset 검증 실패');
  const raw=await jsonFetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=${maxResults}`,{fetcher,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`}});
  if(!Array.isArray(raw))throw new HttpError(502,'Dataset 형식 오류');
  items=[...new Map(raw.slice(0,maxResults).map(normalize).filter(r=>r.id&&r.rent!=null).map(r=>[r.id,r])).values()];
  // The search region is provenance, never proof of an individual listing's location.
  await saveListings(db,items,job.conditions.location,{now:run.finishedAt||new Date().toISOString(),runId:run.id,cacheTtl:Math.max(60,Math.min(86400,Number(env.SEARCH_CACHE_TTL_SECONDS)||86400))});
  job.items=items;await db.set(key,job,job.costSettled?3600:(job.reservationTtl||3600));
 }
 return {jobId:id,runId:job.runId,state:run.status,conditions:job.conditions,maxResults,...(includeItems?{items:items||[]}:{}),source:'apify-run',collectedAt:run.finishedAt||null};
}
