const n=v=>v===null||v===undefined||v===''?null:Number(v);
const first=(o,keys)=>keys.map(k=>o?.[k]).find(v=>v!==undefined&&v!==null&&v!=='');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const DEMO=[
{id:'demo-a',title:'데모 A · 조용한 원룸',deposit:300,rent:34,fee:6,walkMinutes:12,options:['에어컨','세탁기'],address:'가상 위치 A',source:'DEMO'},
{id:'demo-b',title:'데모 B · 학교 근처 원룸',deposit:500,rent:38,fee:4,walkMinutes:7,options:['에어컨','세탁기','냉장고'],address:'가상 위치 B',source:'DEMO'},
{id:'demo-c',title:'데모 C · 저렴한 원룸',deposit:200,rent:29,fee:9,walkMinutes:20,options:['세탁기'],address:'가상 위치 C',source:'DEMO'},
{id:'demo-d',title:'데모 D · 넓은 투룸',deposit:1000,rent:48,fee:null,walkMinutes:null,options:['에어컨','엘리베이터'],address:'가상 위치 D',source:'DEMO'},
];
function coordinate(value,limit){
 if(typeof value!=='number'&&(typeof value!=='string'||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())))return null;
 const number=Number(value);
 return Number.isFinite(number)&&Math.abs(number)<=limit?number:null;
}

export function normalize(raw){
 // Normalized local records explicitly store all monetary values in 만원.
 const isNormalized=raw.schemaVersion===2;
 const num=x=>{const v=n(x);return v!==null&&Number.isFinite(v)?v:null;};
 const rent=isNormalized?num(raw.rent):num(raw.rent_krw)!=null?num(raw.rent_krw)/10000:num(raw.rent);
 const deposit=isNormalized?num(raw.deposit):num(raw.deposit_krw)!=null?num(raw.deposit_krw)/10000:num(raw.deposit);
 // Apify maintenance_cost is KRW; normalized local fee is 만원.
 const fee=isNormalized?num(raw.fee):num(raw.maintenance_cost)!=null?num(raw.maintenance_cost)/10000:num(raw.fee);
 const lat=coordinate(first(raw,['latitude','lat']),90);
 const lng=coordinate(first(raw,['longitude','lng']),180);
 const options=Array.isArray(raw.options)?raw.options.map(x=>typeof x==='string'?x:String(x?.name||x?.title||'')).filter(Boolean):[];
 const name=first(raw,['propertyTitle','title','complex_name'])||'제목 미확인 매물';
 const rawUrl=first(raw,['url','listingUrl']);let url=null;
 try{const u=new URL(rawUrl);if(u.protocol==='https:'&&(['www.dabangapp.com','dabangapp.com'].includes(u.hostname))&&u.pathname.startsWith('/room/'))url=u.href;}catch{}
 const dong=String(first(raw,['dong_name','dong'])||'').trim();
 return {schemaVersion:2,id:String(first(raw,['id','gid'])||''),title:String(name).slice(0,150),
 deposit:deposit!=null&&deposit>=0?deposit:null,rent:rent!=null&&rent>=0?rent:null,fee:fee!=null&&fee>=0?fee:null,
 lat,lng,
 // The Actor's flag takes precedence even when legacy input claims an exact point.
 approximate:(Object.hasOwn(raw,'location_is_approximate')?raw.location_is_approximate:raw.approximate)!==false,
 walkMinutes:num(raw.walkMinutes),
 address:String(first(raw,['address','dong_name'])||'주소 미확인').slice(0,160),dong,
 roomType:String(first(raw,['room_type','roomType'])||'미확인'),areaM2:num(first(raw,['area_m2','areaM2'])),
 url,options,source:String(raw.source||'Apify'),collectedAt:raw.collectedAt||raw.metadata?.scrapedAt||null,
 region:String(raw.region||''),priceType:String(raw.price_type||raw.priceType||''),nearCampusVerified:raw.nearCampusVerified===true};
}
// 안전한 단위 변환은 실데이터 검증 후 적용해야 함; 불명확한 관리비는 null 처리.
export function parseConditions(text){
 const s=String(text||'').slice(0,1200);const result={maxDeposit:null,maxMonthly:null,maxRent:null,maxWalk:null,wants:[],costWeight:0.6};
 const parseMoney=str=>{const m=str.match(/(\d+(?:\.\d+)?)\s*(천|만)?\s*원?/);return m?Number(m[1])*(m[2]==='천'?0.1:1):null};
 for(const [type,regex] of [['maxDeposit',/보증금\s*(?:은|이|으로)?\s*(\d+(?:\.\d+)?\s*(?:천|만)?\s*원?)/],['maxMonthly',/(?:관리비\s*포함|총\s*(?:월세|비용|지출)|월\s*총\s*비용)\s*(\d+(?:\.\d+)?\s*(?:천|만)?\s*원?)/],['maxRent',/월세\s*(?:는|가|는)?\s*(\d+(?:\.\d+)?\s*(?:천|만)?\s*원?)/]]){
  const m=s.match(regex);if(m)result[type]=parseMoney(m[1]);
 }
 const walk=s.match(/(?:도보|걸어서|학교(?:에서|까지)?|통학)\s*(\d+)\s*분/);if(walk)result.maxWalk=Number(walk[1]);
 for(const opt of ['에어컨','세탁기','냉장고','엘리베이터','주차','반려동물'])if(s.includes(opt))result.wants.push(opt);
 if(/거리\s*(?:가|를)?\s*더\s*중요|가까운\s*곳이\s*좋|시간\s*우선/.test(s))result.costWeight=0.3;
 if(/저렴|가격\s*우선|생활비\s*우선/.test(s))result.costWeight=0.8;
 return result;
}
export function conditionsSafe(c){const d={};for(const k of ['maxDeposit','maxMonthly','maxRent','maxWalk']){const v=n(c?.[k]);d[k]=v!==null&&Number.isFinite(v)&&v>=0?clamp(v,0,k==='maxWalk'?240:100000):null;}d.wants=Array.isArray(c?.wants)?c.wants.filter(v=>typeof v==='string').slice(0,12):[];d.costWeight=clamp(Number.isFinite(Number(c?.costWeight))?Number(c.costWeight):0.6,0,1);return d;}
export function rank(rooms,conditions){const c=conditionsSafe(conditions);
 const results=[];for(const room of rooms){if(room.rent===null||room.rent===undefined)continue;
  const total=room.fee===null||room.fee===undefined?null:room.rent+room.fee;
  if(c.maxDeposit!==null&&(room.deposit===null||room.deposit>c.maxDeposit))continue;
  if(c.maxRent!==null&&room.rent>c.maxRent)continue;
  if(c.maxMonthly!==null&&(total===null||total>c.maxMonthly))continue;
  if(c.maxWalk!==null&&(room.walkMinutes===null||room.walkMinutes>c.maxWalk))continue;
  const missing=total===null||room.walkMinutes===null;
  const costScore=total===null?0:Math.max(0,1-total/80);
  const timeScore=room.walkMinutes===null?0:Math.max(0,1-room.walkMinutes/40);
  const opts=c.wants.filter(w=>room.options.some(o=>o.includes(w))).length;
  // Missing walking data must not be treated as a measured 0-minute walk.
  // With no walk measurements, rank by cost and matched options only.
  const effectiveCostWeight=room.walkMinutes===null?1:c.costWeight;
  const score=effectiveCostWeight*costScore+(1-effectiveCostWeight)*timeScore+opts*0.04-(total===null?0.12:0);
  results.push({...room,total,score:Number(score.toFixed(4)),matchedOptions:opts,missing});
 }
 return results.sort((a,b)=>b.score-a.score);
}
export function approximateWalkMinutes(){return null;}
