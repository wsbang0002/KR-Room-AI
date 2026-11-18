import {DEMO} from '../lib/core.js';
import {loadListings} from '../lib/apify.js';
import {buildConditions} from '../lib/conditions.js';
import {analyzeSearch} from '../lib/gemini.js';
import {recommend} from '../lib/recommend.js';
import {redis} from '../lib/store.js';
import {storedListings} from '../lib/listing-store.js';
import {collectionStatus} from '../lib/collection.js';
import {endpoint,privateData,HttpError} from '../lib/security.js';
export async function handleSearch(body,{req,env=process.env,fetcher=fetch,store}={}){
 const text=typeof body?.query==='string'?body.query.trim():'';
 if(!text||text.length>1200)return {status:400,data:{error:'검색 조건은 1~1200자로 입력해 주세요.'}};
 const demo=body.demo===true;
 if(!demo)privateData(req,env);
 const loadAvailable=async location=>{
  if(location&&env.UPSTASH_REDIS_REST_URL&&env.UPSTASH_REDIS_REST_TOKEN){try{const items=await storedListings(store||redis(env,fetcher),location);if(items.length)return {items,source:'redis',notice:'영속 저장 매물입니다. 마지막 확인일·stale 표시를 확인하세요. 공실 미검증.'};}catch{}}
  return loadListings({env,fetcher});
 };
 let initialLocation=null;try{initialLocation=buildConditions(text,null,body.edits).location;}catch{}
 const earlyLoad=!demo&&!body.jobId&&initialLocation?loadAvailable(initialLocation).catch(()=>null):null;
 const parsed=demo?{ai:null,parser:'local',parserReason:'demo-no-api'}:await analyzeSearch(text,{req,env,fetcher,store});
 let conditions;try{conditions=buildConditions(text,parsed.ai,body.edits);}catch{throw new HttpError(400,'검색 조건의 값과 범위를 확인해 주세요.');}
 if(conditions.region.status!=='resolved')return {status:422,data:{error:conditions.region.status==='ambiguous'?'동명이인 지역입니다. 시도·시군구를 선택해 주세요.':'지역을 확인할 수 없습니다. 행정구역 전체 이름을 입력해 주세요.',region:conditions.region}};
 let loaded;
 if(demo)loaded={items:DEMO.map(x=>({...x,roomType:x.id==='demo-d'?'TWO_ROOM':'ONE_ROOM',approximate:true})),source:'demo',notice:'모든 매물과 이동시간은 가상 데모입니다.'};
 else if(body.jobId){const job=await collectionStatus(body.jobId,{req,env,fetcher,store,includeItems:true});if(job.state!=='SUCCEEDED')throw new HttpError(409,`수집 상태: ${job.state}`);loaded={items:job.items,source:'apify-run',notice:'신규 Dataset. 공실·권리·정확한 경로는 미검증입니다.'};}
 else {
  loaded=earlyLoad&&initialLocation===conditions.location?await earlyLoad:null;
  if(!loaded)loaded=await loadAvailable(conditions.location);
 }
 const ranked=recommend(loaded.items,conditions,{snapshot:loaded.source.startsWith('snapshot'),demo});
 return {status:200,data:{mode:demo?'demo':'real',...parsed,ai:undefined,dataSource:loaded.source,conditions,count:loaded.items.length,nearCampusVerifiedCount:demo?null:loaded.items.filter(x=>x.nearCampusVerified).length,...ranked,collectionNeeded:!demo&&!ranked.results.length,notice:loaded.notice}};
}
export default endpoint('POST',req=>handleSearch(req.body,{req}));
