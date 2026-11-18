import {buildConfirmedConditions} from '../lib/search-turn.js';
import {loadListings} from '../lib/apify.js';
import {buildConditions} from '../lib/conditions.js';
import {analyzeSearch} from '../lib/gemini.js';
import {recommend} from '../lib/recommend.js';
import {DEFAULT_DESTINATION_ID,getDestination,identifyDestination} from '../lib/destinations.js';
import {resolveLocation} from '../lib/regions.js';
import {walkingRoute,walkingSettings,validWalkingPoint} from '../lib/walking.js';
import {redis} from '../lib/store.js';
import {storedListings} from '../lib/listing-store.js';
import {collectionStatus} from '../lib/collection.js';
import {endpoint,privateData,HttpError} from '../lib/security.js';
// Prefer explicit user selections and names over AI suggestions. An ambiguous campus
// must never turn into a route to the implicit default.
async function searchDestination(body,text,ai,conditions,options){
 if(body.destinationId!=null){
  if(typeof body.destinationId!=='string'||!body.destinationId.trim()||body.destinationId.length>512){
   throw new HttpError(400,'목적지 선택 값을 확인해 주세요.');
  }
  const place=await getDestination(body.destinationId,options);
  return {destination:place,status:place?'resolved':'unresolved',explicit:true};
 }
 const specified=typeof body.edits?.destination==='string'?body.edits.destination.trim():'';
 const fromText=identifyDestination(specified||text);
 if(specified||fromText.status!=='missing'){
  return {...fromText,status:fromText.status==='missing'?'unresolved':fromText.status,explicit:true};
 }
 if(ai?.destination?.trim()){
  const fromAI=identifyDestination(ai.destination);
  return {...fromAI,status:fromAI.status==='missing'?'unresolved':fromAI.status,explicit:true};
 }
 // A location particle can name a workplace absent from the campus catalog.
 // An administrative search area or a budget such as "40만원까지" is not a workplace.
 const mentions=text.matchAll(/([가-힣A-Za-z0-9·]+?)\s*(까지|에서|근처|주변|인근|로부터|으로부터)/g);
 for(const [,name] of mentions){
  if(/^(?:집|방|원룸|매물|여기|기본값|원|만원|분)$/.test(name)||/\d(?:[.,\d]*)(?:만|만원|원|분|시간)?$/.test(name))continue;
  if(resolveLocation(name).status==='resolved')continue;
  return {destination:null,status:'unresolved',explicit:true};
 }
 if(!conditions.region.isDefault&&conditions.maxCommuteMinutes==null){
  return {destination:null,status:'not-requested',explicit:false};
 }
 const place=await getDestination(DEFAULT_DESTINATION_ID,options);
 return {destination:place,status:place?'default':'unresolved',explicit:false};
}

async function rankWithWalking(items,conditions,selection,options,{snapshot},calculateRoute){
 const settings=walkingSettings(options.env);
 const walkingRoutes=new Map();
 const walking={status:'not-requested',selectedCount:0,successCount:0};
 const requireDestinationTime=conditions.transportMode==='walk'&&selection.explicit;
 const rank=()=>recommend(items,conditions,{snapshot,walkingRoutes,requireDestinationTime});
 if(conditions.transportMode!=='walk'||conditions.maxCommuteMinutes==null){
  return {...rank(),walking};
 }
 if(!selection.destination?.verified){
  walking.status=selection.status==='ambiguous'?'destination-ambiguous':'destination-unverified';
  return {...rank(),walking};
 }
 if(!settings.enabled){
  walking.status='disabled';
  return {...rank(),walking};
 }
 // Rank on cost and options first. Only candidates with confirmed non-commute
 // filters can spend a route slot. No inferred straight-line times participate.
 const shortlist=recommend(items,{...conditions,maxCommuteMinutes:null},{snapshot,walkingRoutes}).results
  .filter(item=>item.id&&validWalkingPoint(item)).slice(0,settings.maxPerSearch);
 await Promise.all(shortlist.map(async item=>{
  try{
   const route=await calculateRoute(item,selection.destination,options);
   walkingRoutes.set(item.id,route);
  }catch{
   walkingRoutes.set(item.id,{status:'unconfirmed',mode:'walking',provider:'tmap',reason:'unavailable'});
  }
 }));
 walking.selectedCount=shortlist.length;
 walking.successCount=[...walkingRoutes.values()].filter(route=>route.status==='success').length;
 walking.status=shortlist.length===0?'no-eligible-listings':walking.successCount?'calculated':'unconfirmed';
 return {...rank(),walking};
}

export async function handleSearch(body,{req,env=process.env,fetcher=fetch,store,calculateRoute=walkingRoute}={}){
 const text=typeof body?.query==='string'?body.query.trim():'';
 if(!text||text.length>1200)return {status:400,data:{error:'검색 조건은 1~1200자로 입력해 주세요.'}};
 if(body.demo===true)throw new HttpError(410,'가상 매물 검색은 종료되었습니다.');
 privateData(req,env);
 const hasConfirmed=Object.hasOwn(body,'confirmedConditions');
 const confirmed=body.confirmedConditions;
 if(hasConfirmed&&body.edits!=null){
  throw new HttpError(400,'확정한 검색 조건을 확인해 주세요.');
 }
 const fromTurn=hasConfirmed?buildConfirmedConditions(confirmed):null;
 const loadAvailable=async location=>{
  if(location&&env.UPSTASH_REDIS_REST_URL&&env.UPSTASH_REDIS_REST_TOKEN){try{const items=await storedListings(store||redis(env,fetcher),location);if(items.length)return {items,source:'redis',notice:'영속 저장 매물입니다. 마지막 확인일·stale 표시를 확인하세요. 공실 미검증.'};}catch{}}
  return loadListings({env,fetcher});
 };
 let initialLocation=fromTurn?.location||null;
 if(!hasConfirmed){try{initialLocation=buildConditions(text,null,body.edits).location;}catch{}}
 const earlyLoad=!body.jobId&&initialLocation?loadAvailable(initialLocation).catch(()=>null):null;
 const parsed=hasConfirmed
  ? {ai:null,parser:'confirmed',parserReason:'confirmed-search-conditions'}
  : await analyzeSearch(text,{req,env,fetcher,store});
 let conditions;
 try{
  conditions=fromTurn||buildConditions(text,parsed.ai,body.edits,{resolveDestinationLater:true});
 }catch{throw new HttpError(400,'검색 조건의 값과 범위를 확인해 주세요.');}
 const options={req,env,fetcher,store};
 const destinationInput=hasConfirmed?{destinationId:body.destinationId,edits:{destination:confirmed.destination,location:confirmed.location}}:body;
 const selection=await searchDestination(destinationInput,hasConfirmed?'':text,parsed.ai,conditions,options);
 const place=selection.destination;
 conditions.destinationPlace=place;
 conditions.destinationStatus=selection.status;
 conditions.destinationVerified=Boolean(place?.verified);
 if(place){
  conditions.destination=place.name;
  if(selection.explicit&&(conditions.region.isDefault||conditions.region.status==='unsupported')&&place.region&&!destinationInput.edits?.location&&!parsed.ai?.location){
   const region=resolveLocation(place.region);
   if(region.status==='resolved'){conditions.region=region;conditions.location=region.location;}
  }
 }else{
  conditions.destination=destinationInput.edits?.destination||parsed.ai?.destination||null;
  if(selection.status!=='not-requested')conditions.warnings.push(selection.status==='ambiguous'?'목적지 이름이 여러 곳과 일치합니다. 주소로 선택해 주세요.':'목적지 좌표를 확인할 수 없습니다. 목적지를 검색해 선택해 주세요.');
 }
 if(conditions.region.status!=='resolved')return {status:422,data:{error:conditions.region.status==='ambiguous'?'동명이인 지역입니다. 시도·시군구를 선택해 주세요.':'지역을 확인할 수 없습니다. 행정구역 전체 이름을 입력해 주세요.',region:conditions.region}};
 let loaded;
 if(body.jobId){const job=await collectionStatus(body.jobId,{req,env,fetcher,store,includeItems:true});if(job.state!=='SUCCEEDED')throw new HttpError(409,`수집 상태: ${job.state}`);loaded={items:job.items,source:'apify-run',notice:'신규 Dataset. 공실·권리·정확한 경로는 미검증입니다.'};}
 else {
  loaded=earlyLoad&&initialLocation===conditions.location?await earlyLoad:null;
  if(!loaded)loaded=await loadAvailable(conditions.location);
 }
 const ranked=await rankWithWalking(loaded.items,conditions,selection,options,
  {snapshot:loaded.source.startsWith('snapshot')},calculateRoute);
 const pendingRoute=conditions.maxCommuteMinutes!=null&&ranked.unverified.some(item=>item.commuteMinutes==null);
 return {status:200,data:{mode:'real',...parsed,ai:undefined,dataSource:loaded.source,conditions,count:loaded.items.length,nearCampusVerifiedCount:loaded.items.filter(x=>x.nearCampusVerified).length,...ranked,collectionNeeded:!ranked.results.length&&!pendingRoute,notice:loaded.notice}};
}
export default endpoint('POST',req=>handleSearch(req.body,{req}));
