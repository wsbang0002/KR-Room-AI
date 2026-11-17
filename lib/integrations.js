import {admin,HttpError,jsonFetch} from './security.js';
import {redis} from './store.js';
import {inspectRedis} from './listing-store.js';
import {analyze} from './gemini.js';
import {smokeGemini} from './gemini-smoke.js';
const missing=(variables)=>({status:'missing',variables});
const failure=()=>({status:'failed',message:'연결 실패. 키·권한·할당량과 서버 설정을 확인하세요.'});
export async function checkIntegrations(body,{req,env=process.env,fetcher=fetch,store}={}){
 admin(req,env);
 const service=body?.service||'storage';
 if(!['storage','gemini','gemini-model','gemini-smoke'].includes(service))throw new HttpError(400,'검사 종류를 확인해 주세요.');
 if(service==='gemini-smoke')return {geminiSmoke:await smokeGemini({req,env,fetcher,store}),actorStarted:false};
 if(service==='gemini-model'){
  const model=env.GEMINI_MODEL||'gemini-2.5-flash';
  if(!env.GEMINI_API_KEY)return {geminiModel:missing(['GEMINI_API_KEY'])};
  try{
   const db=store||redis(env,fetcher),user=admin(req,env);
   const prior=await db.reserve({key:'knuroom:gemini-model:'+encodeURIComponent(model),user,kind:'gemini-model',limit:10,cost:1,budget:10,ttl:300,value:{pending:true}});
   if(prior)return {geminiModel:prior.result||{status:'blocked',model,message:'모델 접근 검사가 이미 진행 중입니다.'},actorStarted:false};
   let result;
   try{
    const data=await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,{fetcher,timeoutMs:15000,headers:{'x-goog-api-key':env.GEMINI_API_KEY}});
    const supported=Array.isArray(data.supportedGenerationMethods)&&data.supportedGenerationMethods.includes('generateContent');
    result={status:supported?'verified':'failed',model,generateContentSupported:supported,message:supported?'설정한 키로 모델 접근과 generateContent 지원을 확인했습니다.':'모델의 generateContent 지원을 확인할 수 없습니다.'};
   }catch(e){result={status:'failed',model,reason:Number.isInteger(e.upstreamStatus)?'upstream-http-'+e.upstreamStatus:['TimeoutError','AbortError'].includes(e.name)?'upstream-timeout':'unavailable',message:'모델 접근 검사 실패. 생성 요청은 실행하지 않았습니다.'};}
   await db.set('knuroom:gemini-model:'+encodeURIComponent(model),{result},result.status==='verified'?300:30);
   return {geminiModel:result,actorStarted:false};
  }catch{return {geminiModel:{status:'failed',model,message:'모델 접근 검사 제한 또는 Redis 오류'},actorStarted:false};}
 }
 if(service==='gemini'){
  if(!env.GEMINI_API_KEY)return {gemini:missing(['GEMINI_API_KEY'])};
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return {gemini:{status:'blocked',message:'먼저 Redis를 연결해야 호출 횟수를 제한할 수 있습니다.'}};
  const result=await analyze('서울 관악구 원룸 월세 40만원',{req,env,fetcher,store});
  return {gemini:{status:['gemini','gemini-cache'].includes(result.parser)?'verified':'failed',parser:result.parser,reason:result.parserReason,timings:result.timings,model:env.GEMINI_MODEL||'gemini-2.5-flash',message:result.parser==='gemini'?'Gemini 실제 응답과 JSON 검증 성공':result.parser==='gemini-cache'?'이전에 검증된 응답 캐시입니다. 신규 호출은 하지 않았습니다.':'검증 실패 또는 호출 제한. 기본 파서로 대체합니다.'},actorStarted:false};
 }
 const checks=await Promise.all([
  (async()=>{if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return missing(['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN']);try{const result=await inspectRedis(store||redis(env,fetcher));return {status:'verified',ping:'PONG',scan:true,keyCount:result.keyCount,knuKeyCount:result.knuKeys,message:'PING/SCAN 성공. 기존 키는 변경하지 않았습니다.'};}catch{return failure();}})(),
  (async()=>{if(!env.APIFY_TOKEN)return missing(['APIFY_TOKEN']);try{const data=(await jsonFetch('https://api.apify.com/v2/users/me/limits',{fetcher,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`}})).data;const hard=data?.limits?.maxMonthlyUsageUsd,spent=data?.current?.monthlyUsageUsd;const cycle=data?.monthlyUsageCycle;const now=Date.now();const validCycle=Number.isFinite(Date.parse(cycle?.startAt))&&Date.parse(cycle.startAt)<=now&&Date.parse(cycle.endAt)>=now;
   if(typeof hard!=='number'||!Number.isFinite(hard)||typeof spent!=='number'||!Number.isFinite(spent)||spent<0)return {status:'failed',message:'계정 사용량 응답을 검증하지 못했습니다.'};
   const hardLimitVerified=hard>0&&hard<=5;
   return {status:'verified',spentUsd:spent,hardLimitUsd:hard,hardLimitVerified,billingCycleVerified:validCycle,belowSoftStop:spent<4.5,message:hardLimitVerified&&validCycle?'계정 인증·한도 확인 성공. Actor는 실행하지 않았습니다.':'계정 인증 성공. $5 이하 한도 또는 과금 주기를 확인해야 신규 실행이 가능합니다.'};
  }catch{return failure();}})(),
  (async()=>{if(!env.APIFY_TOKEN||!env.APIFY_DATASET_ID)return missing(['APIFY_TOKEN','APIFY_DATASET_ID']);try{const data=await jsonFetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(env.APIFY_DATASET_ID)}/items?format=json&clean=true&limit=1`,{fetcher,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`}});return Array.isArray(data)?{status:'verified',sampleCount:data.length,message:'기존 Dataset 조회 성공. 빈 Dataset일 수도 있으며 신규 수집은 하지 않았습니다.'}:failure();}catch{return failure();}})()
 ]);
 return {redis:checks[0],apifyAccount:checks[1],apifyDataset:checks[2],route:{status:'partial',message:'지도는 OSM 사용. TMAP 도보/자동차는 어댑터만 구현되어 있으며 실경로 검색 연결은 아직 준비 전입니다.'},actorStarted:false,liveCollectionEnabled:env.ENABLE_LIVE_COLLECTION==='true',checkedAt:new Date().toISOString()};
}
