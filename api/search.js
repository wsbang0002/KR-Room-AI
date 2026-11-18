import {buildConfirmedConditions,conditionFields,destinationTurn,mentionedDestination,searchTurn} from '../lib/search-turn.js';
import {jobInventory,loadRegionInventory,regionalSummary} from '../lib/inventory.js';
import {buildConditions} from '../lib/conditions.js';
import {analyzeSearch} from '../lib/gemini.js';
import {recommend} from '../lib/recommend.js';
import {curatedCampusChoices,getDestination,identifyDestination} from '../lib/destinations.js';
import {resolveLocation} from '../lib/regions.js';
import {walkingRoute,walkingSettings,validWalkingPoint} from '../lib/walking.js';
import {collectionStatus} from '../lib/collection.js';
import {endpoint,privateData,HttpError} from '../lib/security.js';
async function searchDestination(id,name,options){
 if(id!=null){
  if(typeof id!=='string'||!id.trim()||id.length>180)throw new HttpError(400,'목적지 선택 값을 확인해 주세요.');
  const place=await getDestination(id,options);
  if(!place?.verified)throw new HttpError(422,'선택한 목적지 주소를 다시 확인해 주세요.');
  if(name&&name!==place.name){
   const identified=identifyDestination(name);
   const matching=identified.destination?.id===id||
    (identified.status==='ambiguous'&&curatedCampusChoices(name).some(choice=>choice.id===id));
   if(!matching)throw new HttpError(422,'입력한 목적지와 선택한 장소가 다릅니다. 주소를 다시 확인해 주세요.');
  }
  return {destination:place,status:'resolved',explicit:true};
 }
 if(!name)return {destination:null,status:'not-requested',explicit:false};
 const identified=identifyDestination(name);
 return {...identified,status:identified.status==='missing'?'unresolved':identified.status,explicit:true};
}

function clarification(turn,region){
 return {status:422,data:{...turn,error:turn.question,...(region?{region}:{})}};
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
 const options={req,env,fetcher,store};
 const build=ai=>{
  try{return fromTurn||buildConditions(text,ai,body.edits,{resolveDestinationLater:true});}
  catch{throw new HttpError(400,'검색 조건의 값과 범위를 확인해 주세요.');}
 };
 let conditions=build(null);
 const name=hasConfirmed?confirmed.destination:body.edits?.destination||mentionedDestination(text);
 const selection=await searchDestination(body.destinationId,name,options);
 const place=selection.destination;
 // Resolve required inputs before AI reservations, inventory reads or route work.
 if(!hasConfirmed&&!body.edits?.location&&!place){
  const local=searchTurn({query:text});
  if(local.state==='clarify'&&local.kind==='region')return clarification(local,conditions.region);
 }
 const needsDestination=()=>conditions.maxCommuteMinutes!=null&&!place?.verified;
 if(needsDestination())return clarification(destinationTurn(text,conditionFields(conditions),{name:name||null}));
 // An ordinary location/price query can overlap its inventory read with AI.
 // Timing or destination language must finish clarification first.
 const initialLocation=conditions.location;
 const mayPrefetch=!hasConfirmed&&!body.jobId&&!selection.explicit&&conditions.maxCommuteMinutes==null&&
  conditions.region.status==='resolved'&&!/(?:도보|걸어|통근|통학|출퇴근|직장|학교|캠퍼스|대중교통|자동차|시간|목적지|도착|까지|분)/.test(text);
 const pendingInventory=mayPrefetch?loadRegionInventory(initialLocation,options).catch(()=>null):null;
 const parsed=hasConfirmed
  ? {ai:null,parser:'confirmed',parserReason:'confirmed-search-conditions'}
  : await analyzeSearch(text,options);
 if(parsed.ai)conditions=build(parsed.ai);
 if(needsDestination())return clarification(destinationTurn(text,conditionFields(conditions),{name:name||null}));
 conditions.destination=place?.name||name||null;
 conditions.destinationPlace=place;
 conditions.destinationStatus=selection.status;
 conditions.destinationVerified=Boolean(place?.verified);
 if(place&&(conditions.region.isDefault||conditions.region.status==='unsupported')&&place.region&&!hasConfirmed&&!body.edits?.location&&!parsed.ai?.location){
  const region=resolveLocation(place.region);
  if(region.status==='resolved'){conditions.region=region;conditions.location=region.location;}
 }
 if(!place&&selection.explicit)conditions.warnings.push('목적지 좌표를 확인할 수 없습니다. 주소를 선택해 주세요.');
 if(conditions.region.status!=='resolved')return {status:422,data:{error:'검색할 시·군·구와 동 이름을 확인해 주세요.',region:conditions.region}};
 let loaded;
 if(body.jobId){const job=await collectionStatus(body.jobId,{req,env,fetcher,store,includeItems:true});if(job.state!=='SUCCEEDED')throw new HttpError(409,`수집 상태: ${job.state}`);loaded=jobInventory(job.items);}
 else {
  if(pendingInventory&&initialLocation===conditions.location)loaded=await pendingInventory;
  if(!loaded)loaded=await loadRegionInventory(conditions.location,options);
 }
 const coverage=regionalSummary(loaded,conditions.location);
 const ranked=await rankWithWalking(loaded.items,conditions,selection,options,
  {snapshot:false},calculateRoute);
 const pendingRoute=conditions.maxCommuteMinutes!=null&&ranked.unverified.some(item=>item.commuteMinutes==null);
 return {status:200,data:{mode:'real',...parsed,ai:undefined,dataSource:loaded.source,coverage,conditions,count:loaded.items.length,nearCampusVerifiedCount:loaded.items.filter(x=>x.nearCampusVerified).length,...ranked,collectionNeeded:!ranked.results.length&&!pendingRoute&&['available','empty'].includes(coverage.state),notice:loaded.notice}};
}
export default endpoint('POST',req=>handleSearch(req.body,{req}));
