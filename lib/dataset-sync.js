import {normalize} from './core.js';
import {canonicalAddress,sourceDate} from './inventory.js';
import {listingKey,regionKey} from './listing-store.js';
import {HttpError} from './security.js';
import {redis} from './store.js';

// The preceding GET is used for comparison and merging. Recheck the exact value
// before writing so that a live collection that completed meanwhile takes priority.
export const IMPORT_DATASET_LISTING=`
local current=redis.call('GET',KEYS[1])
if (ARGV[1]=='new' and current) or (ARGV[1]=='existing' and current~=ARGV[2]) then return 0 end
local kind=redis.call('TYPE',KEYS[2]).ok
if kind~='none' and kind~='set' then return redis.error_reply('invalid listing index') end
redis.call('SADD',KEYS[2],KEYS[1])
redis.call('SET',KEYS[1],ARGV[3])
return 1`;

function observedAt(values,now){
 const valid=values.map(sourceDate).filter(date=>date&&Date.parse(date)<=now);
 return valid.length?valid.sort().at(-1):null;
}

function candidate(raw,now,locations){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const id=raw.id??raw.gid;
 if((typeof id!=='string'&&!Number.isSafeInteger(id))||!String(id).trim()||String(id).length>180)return null;
 const item=normalize(raw);
 if(!item.id||item.rent===null||(item.priceType&&!['월세','MONTHLY_RENT'].includes(item.priceType)))return null;
 const address=JSON.stringify([item.region,item.address,item.dong]);
 if(!locations.has(address))locations.set(address,canonicalAddress(item));
 const location=locations.get(address);
 if(!location)return null;
 // Provider modification dates for a Dataset describe the container, not all its listings.
 const collectedAt=observedAt([raw.collectedAt,raw.metadata?.scrapedAt],now);
 const lastSeenAt=observedAt([collectedAt,raw.lastSeenAt],now);
 return {...item,region:location,searchRegion:location,collectedAt,lastSeenAt,
  firstCollectedAt:collectedAt||lastSeenAt,monthlyTotal:item.fee===null?null:item.rent+item.fee,
  syncStatus:lastSeenAt?(now-Date.parse(lastSeenAt)>7*86400000?'stale':'current'):'unknown',
  availability:'unverified'};
}

function numericHeader(response,name){
 const value=response.headers?.get?.('x-apify-pagination-'+name);
 if(value==null)return null;
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new HttpError(502,'Dataset 페이지 정보를 확인할 수 없습니다.');
 return Number(value);
}

async function readDataset(env,fetcher,now){
 const id=env.APIFY_DATASET_ID;
 if(!env.APIFY_TOKEN||typeof id!=='string'||!/^[-\w]+$/.test(id))
  throw new HttpError(503,'기존 Apify Dataset 연결 설정이 필요합니다.');
 const items=new Map(),locations=new Map(),size=100;
 let sourceRows=0,skippedRows=0,duplicateRows=0,knownTotal=null;
 for(;;){
  const url=new URL('https://api.apify.com/v2/datasets/'+encodeURIComponent(id)+'/items');
  // Keep empty entries in pagination offsets. Unusable records are classified below.
  url.search=new URLSearchParams({format:'json',limit:String(size),offset:String(sourceRows)}).toString();
  const response=await fetcher(url.href,{method:'GET',headers:{Authorization:'Bearer '+env.APIFY_TOKEN},
   redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new HttpError(502,'기존 Apify Dataset 조회에 실패했습니다.');
  const rows=await response.json();
  if(!Array.isArray(rows)||rows.length>size)throw new HttpError(502,'Dataset 응답 형식을 확인할 수 없습니다.');
  const total=numericHeader(response,'total'),offset=numericHeader(response,'offset');
  if((offset!==null&&offset!==sourceRows)||(total!==null&&knownTotal!==null&&total!==knownTotal))
   throw new HttpError(502,'Dataset이 변경되었습니다. 다시 동기화해 주세요.');
  knownTotal=total??knownTotal;
  for(const raw of rows){
   const item=candidate(raw,now,locations);
   if(!item){skippedRows++;continue;}
   const prior=items.get(item.id);
   if(prior)duplicateRows++;
   if(!prior||(item.lastSeenAt&&(!prior.lastSeenAt||item.lastSeenAt>prior.lastSeenAt)))items.set(item.id,item);
  }
  sourceRows+=rows.length;
  if(knownTotal!==null){
   if(sourceRows===knownTotal)break;
   if(!rows.length||sourceRows>knownTotal)throw new HttpError(502,'Dataset 전체 조회를 확인할 수 없습니다.');
  }else if(rows.length<size)break;
 }
 return {items,sourceRows,skippedRows,duplicateRows};
}

function richerThanCandidate(current,item){
 // An overview often omits details present on a previous live run. Do not redate
 // those values as if newly observed or discard verified coordinates and fees.
 if(['fee','deposit','areaM2','lat','lng','url'].some(field=>current[field]!=null&&item[field]==null))return true;
 if(current.nearCampusVerified===true&&!item.nearCampusVerified)return true;
 if(current.source==='detail'&&item.source==='overview')return true;
 if(current.approximate===false&&item.approximate!==false)return true;
 if(current.roomType&&current.roomType!=='미확인'&&item.roomType==='미확인')return true;
 if(current.title&&current.title!=='제목 미확인 매물'&&item.title==='제목 미확인 매물')return true;
 return Array.isArray(current.options)&&current.options.length>0&&item.options.length===0;
}

async function writeListing(db,item,datasetId){
 const key=listingKey(item.id);
 for(let attempt=0;attempt<8;attempt++){
  const raw=await db.command(['GET',key]);
  const existing=raw===null?null:JSON.parse(raw);
  if(raw!==null&&existing?.id!==item.id)throw new HttpError(503,'저장된 매물 ID를 확인할 수 없습니다.');
  if(existing){
   const dates=[existing.lastSeenAt,existing.collectedAt,existing.firstCollectedAt].map(sourceDate).filter(Boolean);
   const previous=dates.sort().at(-1);
   if(!previous||!item.lastSeenAt||item.lastSeenAt<=previous||richerThanCandidate(existing,item))return 'unchanged';
  }
  const next={...existing,...item,sourceDatasetId:datasetId,runId:null,
   firstCollectedAt:existing?.firstCollectedAt||existing?.collectedAt||existing?.lastSeenAt||item.firstCollectedAt,
   availability:existing?.availability||item.availability};
  const result=await db.command(['EVAL',IMPORT_DATASET_LISTING,2,key,regionKey(item.region),
   existing?'existing':'new',raw??'',JSON.stringify(next)]);
  if(result===1)return existing?'updated':'inserted';
  if(result!==0)throw new HttpError(503,'매물 저장 결과를 확인할 수 없습니다.');
 }
 throw new HttpError(503,'매물이 갱신 중입니다. 다시 동기화해 주세요.');
}

async function verifyPresence(db,ids){
 let present=0;
 for(let at=0;at<ids.length;at+=100){
  const batch=ids.slice(at,at+100);
  const rows=await db.command(['MGET',...batch.map(listingKey)]);
  if(!Array.isArray(rows)||rows.length!==batch.length)throw new HttpError(503,'Redis 저장 검증에 실패했습니다.');
  for(const [index,raw] of rows.entries()){
   if(raw===null)continue;
   const item=JSON.parse(raw);
   if(item?.id===batch[index]&&Number.isFinite(item.rent)&&item.rent>=0)present++;
  }
 }
 return present;
}

export async function syncExistingDataset({env=process.env,fetcher=fetch,store,now=Date.now()}={}){
 const db=store||redis(env,fetcher);
 const {items,sourceRows,skippedRows,duplicateRows}=await readDataset(env,fetcher,now);
 const counts={inserted:0,updated:0,unchanged:0},groups=new Map();
 for(const item of items.values()){
  const change=await writeListing(db,item,env.APIFY_DATASET_ID);
  counts[change]++;
  groups.set(item.region,(groups.get(item.region)||0)+1);
 }
 const verifiedPresent=await verifyPresence(db,[...items.keys()]);
 const regions=[...groups].sort(([a],[b])=>a.localeCompare(b,'ko')).map(([location,count])=>({location,count}));
 return {sourceRows,skippedRows,duplicateRows,uniqueListings:items.size,...counts,verifiedPresent,
  verifiedMissing:items.size-verifiedPresent,regions,verified:verifiedPresent===items.size};
}
