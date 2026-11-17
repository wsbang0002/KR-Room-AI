import {locationMatch} from './regions.js';
const types={'원룸':'ONE_ROOM','투룸':'TWO_ROOM','쓰리룸':'THREE_ROOM','오피스텔':'OFFICETEL','아파트':'APT'};
export function recommend(rooms,c,{snapshot=false,demo=false}={}){
 const results=[],unverified=[];
 for(const r of rooms){
  if(r.priceType&&!['월세','MONTHLY_RENT'].includes(r.priceType))continue;
  const missing=[],failed=[];
  const total=r.rent==null||r.fee==null?null:r.rent+r.fee;
  const loc=demo?'match':locationMatch(r,c.location,{snapshot});
  if(loc==='mismatch')continue;if(loc==='unknown')missing.push('지역');
  const time=demo&&c.transportMode==='walk'?r.walkMinutes:
   r.route?.verified===true&&r.route.destination===c.destination&&r.route.mode===c.transportMode&&r.approximate===false&&Number.isFinite(r.route.minutes)&&r.route.minutes>=0?r.route.minutes:null;
  for(const [label,value,max] of [['보증금',r.deposit,c.maxDeposit],['월세',r.rent,c.maxRent],['월 총비용',total,c.maxMonthlyTotal],['이동시간',time,c.maxCommuteMinutes]])if(max!=null){if(value==null)missing.push(label);else if(value>max)failed.push(label);}
  if(c.roomTypes.length){if(!r.roomType||r.roomType==='미확인')missing.push('방 유형');else if(!c.roomTypes.includes(types[r.roomType]||r.roomType))failed.push('방 유형');}
  for(const opt of c.requiredOptions)if(!r.options?.length)missing.push(`필수 ${opt}`);else if(!r.options.includes(opt))failed.push(`필수 ${opt}`);
  if(failed.length)continue;
  const opts=c.preferredOptions.filter(o=>r.options?.includes(o)).length;
  const components={cost:total==null?null:Math.max(0,1-total/100),commute:time==null?null:Math.max(0,1-time/120),options:c.preferredOptions.length&&r.options?.length?opts/c.preferredOptions.length:null};
  // A missing component keeps its contribution unavailable; never redistribute it.
  const score=Object.entries(components).reduce((sum,[k,v])=>sum+(v==null?0:c.weights[k]*v),0);
  const reasons=[total==null?'관리비 포함 총액 미확인':`월 총비용 ${total}만 원`,time==null?'이동시간 미확인':`${c.transportMode} ${time}분`,`${opts}개 선호 옵션 확인`,r.approximate?'대략적 위치':'위치 정확도 제공됨'];
  const item={...r,total,commuteMinutes:time,score:Number(score.toFixed(4)),scoreCoverage:Object.entries(components).reduce((a,[k,v])=>a+(v==null?0:c.weights[k]),0),matchedOptions:opts,missing:missing.length>0||total==null||time==null,missingConditions:missing,reasons};
  (missing.length?unverified:results).push(item);
 }
 const sort=(a,b)=>b.score-a.score;return {results:results.sort(sort),unverified:unverified.sort(sort)};
}
