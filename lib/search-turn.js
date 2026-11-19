import {applyOptionEdits,buildConditions,localConditions,numericKeys,optionEdits,priorityWeights,validateAI} from './conditions.js';
import {identifyDestination,curatedCampusChoices} from './destinations.js';
import {addressContains,regions,regionTerms,resolveLocation} from './regions.js';
import {HttpError} from './security.js';

const fields=Object.keys(localConditions(''));
const addresses=new Set(regions);
const budgetLabels={
 maxDeposit:'보증금',
 maxRent:'월세',
 maxMonthlyTotal:'(?:관리비\\s*포함|월\\s*총(?:액|비용)|총\\s*(?:비용|월세))',
 maxCommuteMinutes:'(?:통학\\s*시간|도보\\s*시간|이동\\s*시간|출퇴근\\s*시간|통근\\s*시간)'
};
const fresh=/^(?:새(?:로운)?\s*검색|새로\s*(?:검색|찾)|처음부터|(?:조건|검색)\s*(?:전체\s*)?초기화)/;
export const isFreshTurn=query=>typeof query==='string'&&fresh.test(query.trim());
const clearWords='(?:빼|제외|없애|해제|무관|삭제|없음|없이|상관\\s*없|필요\\s*없)';
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const cleanText=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function invalid(){throw new HttpError(400,'검색 조건을 확인해 주세요.');}

export function conditionFields(value){
 return Object.fromEntries(fields.filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,value[key]]));
}
export function validateTurnConditions(value){
 return validateAI(value)&&addresses.has(value.location);
}

export function buildConfirmedConditions(confirmed){
 if(!validateTurnConditions(confirmed))invalid();
 return buildConditions('',confirmed,{location:confirmed.location},{resolveDestinationLater:true});
}

function placeName(value){
 const name=String(value||'').trim().replace(/[.!?]+$/,'').replace(/(?:이에요|예요|이요|입니다|이야|까지요?|요)$/,'').trim();
 if(!name||name.length>100||/^(?:학교|회사|직장|대학|대학교|집|사무실|역|병원|캠퍼스|목적지|학원|이곳|여기|그곳|거기)(?:\s*(?:앞|근처))?$/.test(name))return null;
 return name;
}

export function mentionedDestination(text,local={}){
 const identified=identifyDestination(text);
 if(identified.destination)return identified.destination.name;
 if(local.destination)return placeName(local.destination);
 const campus=curatedCampusChoices(text)[0];
 if(campus)return campus.name.split(' ')[0];
 for(const [,term] of text.matchAll(/([가-힣A-Za-z0-9·]+?)(?:까지|에서|근처|주변|인근)/g)){
  if(regionTerms(term).length||/\d+(?:만|만원|원|분|시간)?$/.test(term)||/^(?:만원|만|원|분|집|방|원룸|매물|이하|시|군|구|동)$/.test(term))continue;
  const name=placeName(term);
  if(name)return name;
 }
 const named=text.match(/([가-힣A-Za-z0-9·]+(?:대학교|병원|캠퍼스|역))(?:으로|\s|$)/);
 return placeName(named?.[1]);
}

function updatedConditions(text,previous,ai){
 // Make particles following a filter label transparent to the existing Korean parser.
 const phrase=text.replace(/(월세|보증금|도보|대중교통|통학시간|월\s*총액)(?:만|를|을|은|는)(?=\s*\d)/g,'$1 ')
  .replace(/관리비\s*포함(?:해서|한|해)?\s*(?:월세|월)?/g,'관리비 포함 월 ');
 const options=optionEdits(phrase);
 const local=localConditions(phrase,options);
 const conditions=previous?{...previous}:{...local};
 for(const key of numericKeys){
  if(local[key]!=null)conditions[key]=local[key];
  else if(new RegExp(budgetLabels[key]+'(?:은|는|을|를|만)?\\s*(?:(?:상한|조건|제한)\\s*)?'+clearWords).test(text))conditions[key]=null;
  else if(!previous&&ai?.[key]!=null)conditions[key]=ai[key];
 }
 if(/대중교통|버스|지하철|자동차|차로|걸어서|도보/.test(text))conditions.transportMode=local.transportMode;
 else if(!previous&&ai?.transportMode)conditions.transportMode=ai.transportMode;
 const dest=mentionedDestination(text,local);
 if(dest)conditions.destination=dest;
 else if(/목적지\s*(?:삭제|해제|빼|없이)/.test(text))conditions.destination=null;
 else if(!previous&&ai?.destination)conditions.destination=ai.destination;
 if(local.roomTypes.length)conditions.roomTypes=local.roomTypes;
 else if(/방\s*(?:유형|종류).{0,4}(?:무관|상관없|해제)/.test(text))conditions.roomTypes=[];
 else if(!previous&&ai?.roomTypes?.length)conditions.roomTypes=ai.roomTypes;
 // Fresh AI output and saved filters remain subject to this turn’s explicit option modifiers.
 if(!previous){
  conditions.preferredOptions=ai?.preferredOptions||local.preferredOptions;
  conditions.requiredOptions=ai?.requiredOptions||local.requiredOptions;
 }
 conditions.weights=priorityWeights(text)||(!previous&&ai?.weights)||conditions.weights;
 const result=applyOptionEdits(conditions,options);
 if(!validateAI(result))invalid();
 return result;
}

function priorScope(address,level){
 const [province,area]=address.split(' ');
 if(level==='시'&&province.endsWith('시'))return [province];
 const city=area?.match(/^(.+시).+구$/)?.[1];
 if(level==='시'&&city)return [province,city];
 return [province,area].filter(Boolean);
}
function scopeRank(address,previous){
 if(!previous)return 0;
 return previous.location.split(' ').reduce((n,part)=>n+Number(addressContains(address,[part])),0);
}

function clarify(query,terms,candidates,previous,scope=[]){
 const currentFirst=[...candidates].sort((a,b)=>scopeRank(b,previous)-scopeRank(a,previous));
 const neighborhood=terms.at(-1);
 const question=currentFirst.length?
  (neighborhood?`어느 지역의 ‘${neighborhood}’인가요? 시·군·구를 알려 주세요.`:'어느 지역을 찾으세요?'):
  (neighborhood?'지역명을 확인하기 어려워요. 시·군·구와 동 이름을 함께 입력해 주세요.':'어느 지역에서 방을 찾으세요? 시·군·구나 동 이름을 알려 주세요.');
 return {state:'clarify',kind:'region',question,candidates:currentFirst,pending:{query,...(scope.length?{scope}:{})}};
}
const removeCommute=/(?:이동|통학|통근|도보|출퇴근|시간)\s*(?:시간)?\s*(?:조건|제한|상한)?(?:은|는|을|를)?\s*(?:없애|제거|해제|삭제|빼|없이|무관|상관\s*없)/;
const asksTravelTime=/(?:도보|보행|통학|통근|이동|출퇴근)\s*(?:소요\s*)?시간|(?:걸어서|걸으면|걸어가면|도보(?:로)?|까지)\s*(?:얼마나|몇\s*분)|얼마나\s*걸(?:려|리|릴|리는)/;

export function needsWalkingDestination(query,conditions){
 if(conditions.maxCommuteMinutes!=null)return true;
 return conditions.transportMode==='walk'&&
  (Boolean(conditions.destination)||(!removeCommute.test(query)&&asksTravelTime.test(query)));
}

// A nearby campus is never enough evidence to choose a walking destination.
export function destinationTurn(query,conditions,{name=conditions.destination,knownSelection=false,awaitingDestination=false}={}){
 const entered=placeName(name);
 const campus=entered?identifyDestination(entered).destination:null;
 const draft={...conditions,destination:campus?.name||entered};
 if(campus||(knownSelection&&entered)||(!awaitingDestination&&!needsWalkingDestination(query,draft)))return {state:'ready',conditions:draft};
 const places=entered?curatedCampusChoices(entered):[];
 const mode={walk:'도보',car:'자동차',transit:'대중교통'}[draft.transportMode]||'이동';
 const question=entered?`‘${entered}’의 주소를 확인해 주세요. 어느 장소까지 이동하시나요?`:
  draft.maxCommuteMinutes==null?'어디까지 걸어가는 시간을 확인할까요? 학교·직장·역 이름을 알려 주세요.':
  `${mode} ${draft.maxCommuteMinutes}분 이내로 갈 곳은 어디인가요? 학교·직장·역 이름을 알려 주세요.`;
 return {state:'clarify',kind:'destination',question,conditions:draft,candidates:places.map(place=>place.name),places,
  ...(entered?{lookupQuery:entered}:{}),pending:{kind:'destination',query,conditions:draft}};
}

function destinationReply(answer,pending){
 if(removeCommute.test(answer))return {state:'ready',conditions:{...pending.conditions,destination:null,maxCommuteMinutes:null}};
 const reply=answer.replace(/^(?:목적지|도착지)(?:는|로|를)?\s+/, '').trim();
 const editing=/(?:보증금|월세|관리비|도보|대중교통|통학)\s*(?:만|는|은|최대|상한|포함|월)?\s*\d+|\d+\s*분\s*(?:이내|으로|이하)|(?:조건|상한)\s*(?:해제|삭제|없애)/.test(reply);
 // Place names can contain filter words (서울역 버스환승센터, 공영주차장).
 // Keep the entire typed label and the existing conditions for a POI answer.
 if(!editing)return destinationTurn(pending.query,pending.conditions,{name:placeName(reply),awaitingDestination:true});
 const draft=updatedConditions(reply,pending.conditions,null);
 return destinationTurn(pending.query,draft,{name:mentionedDestination(reply)||pending.conditions.destination,awaitingDestination:true});
}

function validatePending(pending){
 if(!record(pending)||!cleanText(pending.query,1200))invalid();
 if(pending.kind==='destination'){
  if(Object.keys(pending).some(key=>!['kind','query','conditions'].includes(key))||!validateTurnConditions(pending.conditions))invalid();
  return;
 }
 if(Object.keys(pending).some(key=>!['query','scope'].includes(key)))invalid();
 if(pending.scope!=null&&(!Array.isArray(pending.scope)||pending.scope.length>4||!pending.scope.every(term=>cleanText(term,40))))invalid();
}

// A pending turn is replayed from the original text. Client-supplied candidate arrays
// cannot select an address outside the original neighborhood.
export function searchTurn(body,{ai}={}){
 if(!record(body)||Object.keys(body).some(key=>!['query','previous','pending','destinationId'].includes(key))||!cleanText(body.query,1200))invalid();
 if(body.previous!=null&&!validateTurnConditions(body.previous))invalid();
 if(body.destinationId!=null&&!cleanText(body.destinationId,180))invalid();
 if(body.pending!=null)validatePending(body.pending);
 const pending=isFreshTurn(body.query)?null:body.pending;
 if(pending?.kind==='destination')return destinationReply(body.query.trim(),pending);
 const query=(pending?.query||body.query).trim();
 const previous=isFreshTurn(query)?null:body.previous;
 const conditions=updatedConditions(query,previous,validateAI(ai)?ai:null);
 // A provider may normalize a name from the request. Do not accept an inferred
 // campus just because a region or travel duration was mentioned.
 if(!previous?.destination&&ai?.destination&&conditions.destination===ai.destination&&
   !query.replaceAll(' ','').includes(ai.destination.replaceAll(' ',''))&&!mentionedDestination(query)){
  conditions.destination=null;
 }
 // Keep a spaced campus qualifier (“원주 캠퍼스”) out of the housing region.
 let terms=regionTerms(query.replace(/([가-힣]+(?:대학교|대))\s+([가-힣]+)\s+캠퍼스/g,'$1 $2캠퍼스'));
 const same=query.match(/(?:같은|동일한?)\s*(시|군|구)(?:에서|내|의|에|\s|$)/);
 if(same&&previous)terms=[...new Set([...priorScope(previous.location,same[1]),...terms])];
 let region=resolveLocation(terms.join(' '),{limit:regions.length});
 if(!terms.length){
  const campus=identifyDestination(query).destination;
  const fallback=previous?.location||campus?.region;
  if(fallback)region=resolveLocation(fallback);
 }
 if(pending&&region.status!=='resolved'){
  const answer=regionTerms(body.query);
  // A first answer can introduce the missing neighborhood ("원룸" → "중앙동").
  // Keep that neighborhood as the scope for later answers ("원주시요").
  if(!region.candidates?.length&&pending.scope?.length){
   terms=pending.scope;
   region=resolveLocation(terms.join(' '),{limit:regions.length});
  }
  if(region.candidates?.length){
   const pool=region.candidates.filter(address=>addressContains(address,pending.scope||[]));
   const matchesInScope=answer.length?pool.filter(address=>addressContains(address,answer)):[];
   // A typed city can correct an earlier province choice, but still has to
   // match the originally requested neighborhood.
   const matches=matchesInScope.length?matchesInScope:
    answer.length?region.candidates.filter(address=>addressContains(address,answer)):[];
   if(matches.length===1)region={status:'resolved',location:matches[0]};
   else if(matches.length){
    const scope=[...new Set([...(matchesInScope.length?pending.scope||[]:[]),...answer])];
    return clarify(query,terms,matches,previous,scope);
   }else return clarify(query,terms,pool,previous,pending.scope);
  }else if(answer.length){
   const replacement=resolveLocation(answer.join(' '),{limit:regions.length});
   if(replacement.status==='resolved')region=replacement;
   else if(replacement.status==='ambiguous')return clarify(query,answer,replacement.candidates,previous,answer);
  }
 }
 if(region.status!=='resolved')return clarify(query,terms,region.candidates||[],previous);
 const knownSelection=Boolean(body.destinationId&&previous?.destination&&conditions.destination===previous.destination);
 return destinationTurn(query,{...conditions,location:region.location},{knownSelection});
}
