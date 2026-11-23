import {fallbackReason} from './analysis-status.js';
import {walkingSettings,walkingUsage} from './walking.js';
import {admin,HttpError,jsonFetch} from './security.js';
import {redis} from './store.js';
import {inspectRedis} from './listing-store.js';
import {openRouterModel} from './openrouter.js';
import {analyze,analyzeSearch,selectedProvider} from './gemini.js';
import {resolveLocation} from './regions.js';
import {smokeGemini} from './gemini-smoke.js';
import {diagnoseGoogleNetwork} from './google-network.js';
const missing=(variables)=>({status:'missing',variables});
const failure=()=>({status:'failed',message:'연결 실패. 키·권한·할당량과 서버 설정을 확인하세요.'});
const matchesExample=ai=>ai.maxRent===40&&resolveLocation(ai.location).location==='서울특별시 관악구';
export async function checkIntegrations(body,{req,env=process.env,fetcher=fetch,store}={}){
 admin(req,env);
 const service=body?.service||'storage';
 if(!['storage','openrouter','gemini','gemini-model','gemini-interactions','gemini-smoke','gemini-network'].includes(service))throw new HttpError(400,'검사 종류를 확인해 주세요.');
 const analysisProvider=selectedProvider(env);
 if(service.startsWith('gemini')&&analysisProvider!=='gemini'){
  return {gemini:{status:'blocked',message:'현재 선택한 분석 서비스에서 Gemini 검사를 사용할 수 없습니다.'},actorStarted:false};
 }
 if(service==='openrouter'){
  if(analysisProvider!=='openrouter-free'){
   return {openrouter:{status:'blocked',message:'AI_PROVIDER에 openrouter-free를 설정하세요.'},actorStarted:false};
  }
  if(!env.OPENROUTER_API_KEY)return {openrouter:missing(['OPENROUTER_API_KEY']),actorStarted:false};
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN){
   return {openrouter:missing(['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'].filter(key=>!env[key])),actorStarted:false};
  }
  let conditions;
  const result=await analyzeSearch('서울 관악구 원룸 월세 40만원',{
   req,env,fetcher,store,diagnostic:true,matchesExpectedConditions:ai=>{
    conditions={district:resolveLocation(ai.location).location==='서울특별시 관악구',rent:ai.maxRent===40};
    return conditions.district&&conditions.rent;
   }
  });
  const live=result.parser==='openrouter';
  const cached=result.parser==='openrouter-cache';
  const message=live?'OpenRouter 무료 모델이 서울 관악구와 월세 40만원을 추출했습니다.':
   cached?'이전에 검증한 OpenRouter 무료 모델의 응답입니다.':'검색 예문의 지역·월세 추출을 확인하지 못했습니다.';
  return {openrouter:{status:live||cached?'verified':'failed',model:openRouterModel,parser:result.parser,
   reason:result.parserReason,timings:result.timings,conditions,message},actorStarted:false};
 }
 if(service==='gemini-network')return {googleNetwork:await diagnoseGoogleNetwork({req,env,fetcher,store}),actorStarted:false};
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
 if(service==='gemini'||service==='gemini-interactions'){
  const configuredModel=env.GEMINI_MODEL||'gemini-2.5-flash';
  const model=body.model??configuredModel;
  if(model!==configuredModel&&model!=='gemini-3.6-flash'){
   throw new HttpError(400,'허용되지 않은 진단 모델입니다.');
  }
  const method=service==='gemini-interactions'?'interactions':env.GEMINI_API_METHOD;
  if(!env.GEMINI_API_KEY)return {gemini:missing(['GEMINI_API_KEY'])};
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return {gemini:{status:'blocked',message:'먼저 Redis를 연결해야 호출 횟수를 제한할 수 있습니다.'}};
  const result=await analyze('서울 관악구 원룸 월세 40만원',{
   req,env:{...env,GEMINI_MODEL:model},fetcher,store,method,diagnostic:true,
   matchesExpectedConditions:matchesExample
  });
  const live=result.parser==='gemini', cached=result.parser==='gemini-cache';
  const failures={
   capacity:'Gemini 서비스 장애 · 모델 서버가 혼잡합니다.',
   'service-unavailable':'Gemini 서비스 장애 · 공급자가 일시적으로 요청을 처리하지 못했습니다.',
   timeout:'Gemini 응답 지연 · 제한 시간 안에 응답을 받지 못했습니다.',
   'provider-limit':'Gemini 공급자의 호출 한도에 도달했습니다.',
   'daily-limit':'앱의 일일 생성 한도에 도달했습니다.',
   'usage-check':'앱에서 호출 가능 횟수를 확인하지 못했습니다.',
   'response-format':'응답 형식 오류 · 검색 조건 JSON을 검증하지 못했습니다.',
   'provider-resource':'설정된 Gemini 모델 또는 API 경로를 확인해 주세요.',
   access:'Gemini 접근 권한을 확인해 주세요.'
  };
  const message=live?'Gemini 응답에서 서울 관악구와 월세 40만원 조건을 확인했습니다.':
   cached?'이전에 검증된 응답 캐시입니다. 신규 호출은 하지 않았습니다.':
   failures[fallbackReason(result,'gemini')]||'검색 예문의 지역·월세 추출을 확인하지 못했습니다.';
  return {gemini:{apiMethod:method==='interactions'?'interactions':'generateContent',status:live||cached?'verified':'failed',
   parser:result.parser,reason:result.parserReason,timings:result.timings,model,message},actorStarted:false};
 }
 const settings=walkingSettings(env);
 const routeCheck=async()=>{
  let usedToday=null;
  try{usedToday=await walkingUsage(store||redis(env,fetcher));}catch{}
  const message=settings.enabled?'실제 보행 시간은 매물별 경로 조회에서 확인합니다.':'보행 경로 실시간 조회가 꺼져 있습니다.';
  return {...settings,usedToday,status:'partial',liveTest:'not-run',message};
 };
 const checks=await Promise.all([

  (async()=>{if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return missing(['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN']);try{const result=await inspectRedis(store||redis(env,fetcher));return {status:'verified',ping:'PONG',scan:true,keyCount:result.keyCount,knuKeyCount:result.knuKeys,message:'PING/SCAN 성공. 기존 키는 변경하지 않았습니다.'};}catch{return failure();}})(),
  (async()=>{if(!env.APIFY_TOKEN)return missing(['APIFY_TOKEN']);try{const data=(await jsonFetch('https://api.apify.com/v2/users/me/limits',{fetcher,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`}})).data;const hard=data?.limits?.maxMonthlyUsageUsd,spent=data?.current?.monthlyUsageUsd;const cycle=data?.monthlyUsageCycle;const now=Date.now();const validCycle=Number.isFinite(Date.parse(cycle?.startAt))&&Date.parse(cycle.startAt)<=now&&Date.parse(cycle.endAt)>=now;
   if(typeof hard!=='number'||!Number.isFinite(hard)||typeof spent!=='number'||!Number.isFinite(spent)||spent<0)return {status:'failed',message:'계정 사용량 응답을 검증하지 못했습니다.'};
   const hardLimitVerified=hard>0&&hard<=5;
   return {status:'verified',spentUsd:spent,hardLimitUsd:hard,hardLimitVerified,billingCycleVerified:validCycle,belowSoftStop:spent<4.5,message:hardLimitVerified&&validCycle?'계정 인증·한도 확인 성공. Actor는 실행하지 않았습니다.':'계정 인증 성공. $5 이하 한도 또는 과금 주기를 확인해야 신규 실행이 가능합니다.'};
  }catch{return failure();}})(),
  (async()=>{if(!env.APIFY_TOKEN||!env.APIFY_DATASET_ID)return missing(['APIFY_TOKEN','APIFY_DATASET_ID']);try{const data=await jsonFetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(env.APIFY_DATASET_ID)}/items?format=json&clean=true&limit=1`,{fetcher,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`}});return Array.isArray(data)?{status:'verified',sampleCount:data.length,message:'기존 Dataset 조회 성공. 빈 Dataset일 수도 있으며 신규 수집은 하지 않았습니다.'}:failure();}catch{return failure();}})(),
  routeCheck(),
 ]);
 return {analysisProvider,redis:checks[0],apifyAccount:checks[1],apifyDataset:checks[2],route:checks[3],actorStarted:false,liveCollectionEnabled:env.ENABLE_LIVE_COLLECTION==='true',checkedAt:new Date().toISOString()};
}
