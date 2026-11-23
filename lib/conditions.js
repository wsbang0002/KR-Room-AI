import {parseConditions} from './core.js';
import {extractRegion,destinations} from './regions.js';
export const optionNames=['에어컨','세탁기','냉장고','엘리베이터','주차','반려동물'];
export const roomTypes=['ONE_ROOM','TWO_ROOM','THREE_ROOM','FOUR_ROOM','OFFICETEL','APT'];
export const numericKeys=['maxDeposit','maxRent','maxMonthlyTotal','maxCommuteMinutes'];
export function validateAI(x){
 if(!x||typeof x!=='object'||Array.isArray(x))return false;
 const allowed=['location','destination',...numericKeys,'transportMode','roomTypes','preferredOptions','requiredOptions','weights'];
 if(Object.keys(x).some(k=>!allowed.includes(k)))return false;
 if(numericKeys.some(k=>x[k]!=null&&(typeof x[k]!=='number'||!Number.isFinite(x[k])||x[k]<0||x[k]>(k==='maxCommuteMinutes'?240:100000))))return false;
 if(['location','destination'].some(k=>x[k]!=null&&(typeof x[k]!=='string'||x[k].length>120)))return false;
 if(x.transportMode!=null&&!['walk','transit','car'].includes(x.transportMode))return false;
 for(const [k,list] of [['roomTypes',roomTypes],['preferredOptions',optionNames],['requiredOptions',optionNames]])if(x[k]!=null&&(!Array.isArray(x[k])||x[k].length>12||x[k].some(v=>!list.includes(v))))return false;
 if(x.weights!=null&&(!x.weights||Array.isArray(x.weights)||Object.keys(x.weights).some(k=>!['cost','commute','options'].includes(k))||['cost','commute','options'].some(k=>typeof x.weights[k]!=='number'||!Number.isFinite(x.weights[k])||x.weights[k]<0||x.weights[k]>1)||Object.values(x.weights).reduce((a,b)=>a+b,0)<=0))return false;
 return true;
}
export function moneyManwon(value){
 const text=String(value).replace(/\s/g,'');
 const factors={'억':10000,'천만':1000,'백만':100,'십만':10,'만':1,'천':.1};
 const parts=[...text.matchAll(/(\d+(?:\.\d+)?)(억|천만|백만|십만|만|천)/g)];
 if(parts.length)return parts.reduce((sum,m)=>sum+Number(m[1])*factors[m[2]],0);
 const number=Number(text.replace(/원$/,''));return text.endsWith('원')?number/10000:number;
}
const optionToken=optionNames.join('|');
const optionMatcher=new RegExp(optionToken,'g');
// Connected option names share their modifier ("에어컨과 세탁기 없어도 돼").
const optionGroup=new RegExp('(?:'+optionToken+')(?:(?:\\s*(?:와|과|랑|이랑|및|하고|,|·)\\s*)(?:'+optionToken+'))*','g');

export function optionEdits(text){
 const edits=new Map();
 const groups=[...text.matchAll(optionGroup)];
 groups.forEach((group,i)=>{
  const after=group.index+group[0].length;
  const tail=text.slice(after,groups[i+1]?.index).split(/[,.!?。\n]/u)[0]
   .replace(/^(?:이|가|은|는|을|를|도|만)?\s*/u,'');
  let intent='mention';
  if(/^(?:(?:옵션|조건|공간)\s*)?(?:필수\s*)?(?:빼|제외|해제|삭제|없애|말고)|^(?:있든\s*없든|있어도\s*(?:괜찮|상관없)|없어도|필요\s*없|상관\s*없|무관|필수(?:가|는|까지는|까진)?\s*아니)/.test(tail))intent='clear';
  else if(/^(?:없으면\s*안|없는\s*(?:방|곳|집|매물)[은는]?\s*(?:제외|싫|빼))/.test(tail))intent='required';
  else if(/^(?:없(?:는|어야)|있(?:는|으면)\s*(?:(?:방|집|곳|매물)[은는]?\s*)?(?:제외|빼|싫))/.test(tail))intent='exclude';
  else if(/^(?:꼭\s*있|반드시|필수|있어야|필요해|필요한)/.test(tail))intent='required';
  else if(/^(?:선호|있으면\s*(?:좋|편)|있는\s*편을\s*선호)/.test(tail))intent='preferred';
  for(const name of group[0].match(optionMatcher))edits.set(name,intent);
 });
 return edits;
}

export function applyOptionEdits(conditions,edits){
 const preferred=new Set(conditions.preferredOptions||[]);
 const required=new Set(conditions.requiredOptions||[]);
 for(const [name,intent] of edits){
  if(intent==='clear'||intent==='exclude'){
   required.delete(name);preferred.delete(name);
   continue;
  }
  preferred.add(name);
  if(intent==='required')required.add(name);
  if(intent==='preferred')required.delete(name);
 }
 return {...conditions,preferredOptions:[...preferred],requiredOptions:[...required]};
}

export function priorityWeights(text){
 const compared=text.match(/보다\s*([^,.!?。\n]{1,50})/u)?.[1];
 const cost=/월세|가격|비용|생활비|저렴/;
 const commute=/거리|통학|통근|이동\s*시간|가까[운워]|가깝/;
 const priority=/중요|우선|중심|선호|먼저/;
 let target;
 if(compared&&priority.test(compared)){
  if(commute.test(compared))target='commute';
  else if(cost.test(compared))target='cost';
 }
 if(!target){
  if(/(?:거리|시간|통학|통근)\s*(?:우선|중심)|가까운\s*순/.test(text))target='commute';
  else if(/(?:월세|가격|비용|생활비)\s*(?:우선|중심)|저렴한\s*(?:순|곳)/.test(text))target='cost';
 }
 if(target==='commute')return {cost:.3,commute:.55,options:.15};
 if(target==='cost')return {cost:.7,commute:.15,options:.15};
 return null;
}

export function unsupportedConditions(text){
 const labels=[];
 if(/채광|일조(?:권|량)?|햇[빛살]|해가\s*잘\s*드|볕이?\s*(?:좋|잘)/.test(text))labels.push('채광');
 if(/소음|방음|조용|시끄럽|시끄러/.test(text))labels.push('소음');
 for(const [name,intent] of optionEdits(text)){
  if(intent==='exclude')labels.push(name+' 없는 매물만');
 }
 return labels;
}

export function localConditions(text,options=optionEdits(text)){
 const old=parseConditions(text);
 const money='((?:\\d+(?:\\.\\d+)?\\s*(?:억|천만|백만|십만|만|천)\\s*)+원?|\\d+(?:\\.\\d+)?\\s*원?)';
 const read=prefix=>{const match=text.match(new RegExp(prefix+'\\s*(?:은|는|이|가)?\\s*'+money));return match?moneyManwon(match[1]):null;};
 const deposit=read('보증금'),rent=read('월세'),total=read('(?:관리비\\s*포함\\s*(?:월\\s*)?|월\\s*총액|총\\s*(?:월세|비용|지출))');
 const amount=text.match(/(?:관리비\s*포함\s*(?:월\s*)?|월\s*총액\s*)(\d+(?:\.\d+)?)\s*만/);
 const commute=text.match(/(?:대중교통|버스|자동차|자가용|차로|도보|걸어서|통학|통근|출퇴근|이동\s*시간|학교까지)(?:으로|로)?\s*(?:시간[은는]?\s*)?(?:최대\s*)?(\d+)\s*분/);
 const destination=Object.entries(destinations).find(([,d])=>d.aliases.some(a=>text.includes(a)))?.[0]||null;
 return applyOptionEdits({location:null,destination,maxDeposit:deposit??old.maxDeposit,maxRent:rent??old.maxRent,maxMonthlyTotal:total??(amount?Number(amount[1]):old.maxMonthly),maxCommuteMinutes:commute?Number(commute[1]):old.maxWalk,transportMode:/대중교통|버스|지하철/.test(text)?'transit':/자동차|자가용|차로/.test(text)?'car':'walk',roomTypes:roomTypes.filter((_,i)=>['원룸','투룸','쓰리룸','포룸','오피스텔','아파트'][i]&&text.includes(['원룸','투룸','쓰리룸','포룸','오피스텔','아파트'][i])),preferredOptions:[],requiredOptions:[],weights:priorityWeights(text)||{cost:0.5,commute:0.35,options:0.15}},options);
}
export function buildConditions(text,ai,edits={}, {resolveDestinationLater=false}={}){
 const options=optionEdits(text);
 const local=localConditions(text,options);
 let c=applyOptionEdits({...local,...Object.fromEntries(Object.entries(ai||{}).filter(([,v])=>v!=null))},options);
 c.weights=priorityWeights(text)||c.weights;
 for(const k of numericKeys)if(Object.hasOwn(edits,k)&&edits[k]!==''&&edits[k]!==null)c[k]=Number(edits[k]);
 if(edits.transportMode)c.transportMode=edits.transportMode;
 if(edits.destination)c.destination=edits.destination;
 if(edits.weights)c.weights=edits.weights;
 if(!validateAI(c))throw new Error('Invalid conditions');
 const region=extractRegion(text,edits.location||c.location);
 c.location=region.location||null;c.region=region;
 c.destination=c.destination||(region.isDefault?'강원대학교 원주캠퍼스':null);
 c.destinationVerified=Boolean(destinations[c.destination]?.verified);
 c.warnings=[];
 if(!resolveDestinationLater&&c.destination&&!c.destinationVerified)c.warnings.push('목적지의 실제 명칭·좌표를 확인해 주세요. 기본 캠퍼스 명칭도 검증 전입니다.');
 if(!resolveDestinationLater&&/(?:학교|직장|회사|역).*?(?:근처|주변|까지)/.test(text)&&!c.destination)c.warnings.push('목적지를 구체적으로 입력해 주세요.');
 const sum=Object.values(c.weights).reduce((a,b)=>a+b,0);c.weights=Object.fromEntries(Object.entries(c.weights).map(([k,v])=>[k,v/sum]));
 // Retain legacy response fields for v0.4 clients.
 return {...c,maxMonthly:c.maxMonthlyTotal,maxWalk:c.transportMode==='walk'?c.maxCommuteMinutes:null,wants:c.preferredOptions,costWeight:c.weights.cost};
}
