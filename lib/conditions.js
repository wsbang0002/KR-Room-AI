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
export function localConditions(text){
 const old=parseConditions(text);
 const money='((?:\\d+(?:\\.\\d+)?\\s*(?:억|천만|백만|십만|만|천)\\s*)+원?|\\d+(?:\\.\\d+)?\\s*원?)';
 const read=prefix=>{const match=text.match(new RegExp(prefix+'\\s*(?:은|는|이|가)?\\s*'+money));return match?moneyManwon(match[1]):null;};
 const deposit=read('보증금'),rent=read('월세'),total=read('(?:관리비\\s*포함\\s*(?:월\\s*)?|월\\s*총액|총\\s*(?:월세|비용|지출))');
 const amount=text.match(/(?:관리비\s*포함\s*(?:월\s*)?|월\s*총액\s*)(\d+(?:\.\d+)?)\s*만/);
 const commute=text.match(/(?:대중교통|자동차|차로|도보|걸어서|통학|학교까지)\s*(\d+)\s*분/);
 const required=optionNames.filter(o=>new RegExp(`${o}[^.,。]{0,8}필수`).test(text));
 const destination=Object.entries(destinations).find(([,d])=>d.aliases.some(a=>text.includes(a)))?.[0]||null;
 return {location:null,destination,maxDeposit:deposit??old.maxDeposit,maxRent:rent??old.maxRent,maxMonthlyTotal:total??(amount?Number(amount[1]):old.maxMonthly),maxCommuteMinutes:commute?Number(commute[1]):old.maxWalk,transportMode:/대중교통|버스|지하철/.test(text)?'transit':/자동차|차로/.test(text)?'car':'walk',roomTypes:roomTypes.filter((_,i)=>['원룸','투룸','쓰리룸','포룸','오피스텔','아파트'][i]&&text.includes(['원룸','투룸','쓰리룸','포룸','오피스텔','아파트'][i])),preferredOptions:old.wants,requiredOptions:required,weights:{cost:0.5,commute:0.35,options:0.15}};
}
export function buildConditions(text,ai,edits={}){
 let c={...localConditions(text),...Object.fromEntries(Object.entries(ai||{}).filter(([,v])=>v!=null))};
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
 if(c.destination&&!c.destinationVerified)c.warnings.push('목적지의 실제 명칭·좌표를 확인해 주세요. 기본 캠퍼스 명칭도 검증 전입니다.');
 if(/(?:학교|직장|회사|역).*?(?:근처|주변|까지)/.test(text)&&!c.destination)c.warnings.push('목적지를 구체적으로 입력해 주세요.');
 const sum=Object.values(c.weights).reduce((a,b)=>a+b,0);c.weights=Object.fromEntries(Object.entries(c.weights).map(([k,v])=>[k,v/sum]));
 // Retain legacy response fields for v0.4 clients.
 return {...c,maxMonthly:c.maxMonthlyTotal,maxWalk:c.transportMode==='walk'?c.maxCommuteMinutes:null,wants:c.preferredOptions,costWeight:c.weights.cost};
}
