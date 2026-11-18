import {buildConditions,localConditions,numericKeys,optionNames,validateAI} from './conditions.js';
import {identifyDestination} from './destinations.js';
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

function mentionedDestination(text,local){
 const identified=identifyDestination(text);
 if(identified.destination)return identified.destination.name;
 if(local.destination)return local.destination;
 // Capture a named workplace/station in e.g. "삼성전자까지 도보 15분".
 const mention=text.match(/([가-힣A-Za-z0-9·]+?)\s*까지/);
 if(mention&&!regionTerms(mention[1]).length&&!/[0-9원분]$/.test(mention[1]))return mention[1];
 const named=text.match(/([가-힣A-Za-z0-9·]+(?:대학교|병원|캠퍼스|역))(?:에서|으로|까지|\s|$)/);
 return named?.[1]||null;
}

function updatedConditions(text,previous,ai){
 // Make particles following a filter label transparent to the existing Korean parser.
 const phrase=text.replace(/(월세|보증금|도보|대중교통|통학시간|월\s*총액)(?:만|를|을|은|는)(?=\s*\d)/g,'$1 ')
  .replace(/관리비\s*포함(?:해서|한|해)?\s*(?:월세|월)?/g,'관리비 포함 월 ');
 const local=localConditions(phrase);
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
 for(const key of ['requiredOptions','preferredOptions']){
  const options=new Set(conditions[key]||[]);
  for(const name of local[key])options.add(name);
  if(!previous&&!local[key].length)for(const name of ai?.[key]||[])options.add(name);
  for(const name of optionNames)if(new RegExp(name+'(?:은|는|을|를)?\\s*(?:(?:필수|조건)\\s*)?'+clearWords).test(text))options.delete(name);
  conditions[key]=[...options];
 }
 if(/(?:월세|가격|비용|생활비)\s*(?:우선|중심)|저렴한\s*(?:순|곳)/.test(text))conditions.weights={cost:.7,commute:.15,options:.15};
 else if(/(?:거리|시간|통학|통근)\s*(?:우선|중심)|가까운\s*순/.test(text))conditions.weights={cost:.3,commute:.55,options:.15};
 else if(!previous&&ai?.weights)conditions.weights=ai.weights;
 if(!validateAI(conditions))invalid();
 return conditions;
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
 return {state:'clarify',question,candidates:currentFirst,pending:{query,...(scope.length?{scope}:{})}};
}
function validatePending(pending){
 if(!record(pending)||Object.keys(pending).some(key=>!['query','scope'].includes(key))||!cleanText(pending.query,1200))invalid();
 if(pending.scope!=null&&(!Array.isArray(pending.scope)||pending.scope.length>4||!pending.scope.every(term=>cleanText(term,40))))invalid();
}

// A pending turn is replayed from the original text. Client-supplied candidate arrays
// cannot select an address outside the original neighborhood.
export function searchTurn(body,{ai}={}){
 if(!record(body)||Object.keys(body).some(key=>!['query','previous','pending'].includes(key))||!cleanText(body.query,1200))invalid();
 if(body.previous!=null&&!validateTurnConditions(body.previous))invalid();
 if(body.pending!=null)validatePending(body.pending);
 const pending=fresh.test(body.query.trim())?null:body.pending;
 const query=(pending?.query||body.query).trim();
 const previous=fresh.test(query)?null:body.previous;
 const conditions=updatedConditions(query,previous,validateAI(ai)?ai:null);
 let terms=regionTerms(query);
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
 return {state:'ready',conditions:{...conditions,location:region.location}};
}
