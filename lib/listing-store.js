import {normalize} from './core.js';
import {locationMatch,resolveLocation} from './regions.js';
import {HttpError} from './security.js';
export const listingKey=id=>{if(typeof id!=='string'||!id||id.length>180)throw new HttpError(400,'잘못된 매물 ID');return `knuroom:listing:${encodeURIComponent(id)}`;};
export const regionKey=region=>`knuroom:region:${encodeURIComponent(region)}:listings`;
const UPSERT=`
local old=redis.call('GET',KEYS[1]);local item=cjson.decode(ARGV[1]);
if old then local prev=cjson.decode(old);item.firstCollectedAt=prev.firstCollectedAt or item.firstCollectedAt end
redis.call('SET',KEYS[1],cjson.encode(item))
redis.call('SADD',KEYS[2],KEYS[1]);redis.call('SET',KEYS[3],ARGV[2]);return 1`;
export async function saveListings(db,items,region,{now=new Date().toISOString(),runId=null,cacheTtl=86400}={}){
 const validRegion=resolveLocation(region);if(validRegion.status!=='resolved')throw new HttpError(422,'저장 지역 확인이 필요합니다.');
 const dedup=[...new Map(items.map(raw=>({...normalize(raw),firstCollectedAt:raw.firstCollectedAt||null})).filter(r=>r.id&&r.rent!=null).map(r=>[r.id,r])).values()];
 for(const r of dedup){const record={...r,monthlyTotal:r.fee==null?null:r.rent+r.fee,searchRegion:validRegion.location,firstCollectedAt:r.firstCollectedAt||r.collectedAt||now,lastSeenAt:now,syncStatus:'current',runId,availability:'unverified'};
  await db.command(['EVAL',UPSERT,3,listingKey(r.id),regionKey(validRegion.location),'knuroom:metadata:last-sync',JSON.stringify(record),now]);
 }
 await db.set(`knuroom:cache:region:${encodeURIComponent(validRegion.location)}`,{ids:dedup.map(r=>r.id),updatedAt:now},cacheTtl);
 return dedup.length;
}
export async function storedListings(db,region,{now=Date.now(),staleDays=7}={}){
 // A region set is an index, not evidence that a source listing matches that place.
 const names=region.split(' '),levels=names.map((_,i)=>names.slice(0,i+1).join(' '));
 // Search all saved regional indexes (bounded) to support broad and narrow searches.
 const indexes=await scanKeys(db,'knuroom:region:*:listings');
 const relevant=indexes.filter(k=>{const label=decodeURIComponent(k.slice('knuroom:region:'.length,-':listings'.length));return label===region||label.startsWith(region+' ')||levels.includes(label);});
 const keys=new Set();for(const key of relevant){const members=await db.command(['SMEMBERS',key]);for(const id of members||[])id.startsWith('knuroom:listing:')&&keys.add(id);}
 if(keys.size>5000)throw new HttpError(503,'저장 매물 범위를 더 좁혀 주세요.');
 const items=[];const all=[...keys];for(let i=0;i<all.length;i+=100){const values=await db.command(['MGET',...all.slice(i,i+100)]);for(const value of values||[])if(value){const r=JSON.parse(value);if(locationMatch(r,region)!=='mismatch')items.push({...r,syncStatus:now-Date.parse(r.lastSeenAt)>staleDays*86400000?'stale':'current'});}}
 return items;
}
export async function scanKeys(db,pattern='*',{maxPages=200}={}){
 let cursor='0';const keys=new Set();for(let i=0;i<maxPages;i++){const page=await db.command(['SCAN',cursor,'MATCH',pattern,'COUNT',100]);if(!Array.isArray(page)||!Array.isArray(page[1]))throw new HttpError(503,'Redis SCAN 응답 오류');cursor=String(page[0]);page[1].forEach(k=>keys.add(k));if(cursor==='0')return [...keys];}throw new HttpError(503,'SCAN 범위를 초과했습니다. 기존 키는 변경하지 않았습니다.');
}
export async function inspectRedis(db){
 if(await db.command(['PING'])!=='PONG')throw new HttpError(503,'Redis PING 실패');
 const keys=await scanKeys(db);return {connected:true,checkedAt:new Date().toISOString(),keyCount:keys.length,existingKeys:keys,knuKeys:keys.filter(k=>k.startsWith('knuroom:')).length,note:'기존 키의 값은 읽거나 삭제하지 않았습니다.'};
}
export async function backupListings(db){const keys=await scanKeys(db,'knuroom:listing:*');const listings=[];for(const key of keys){const item=await db.get(key);if(item)listings.push(item);}return {format:'knuroom-listings-v1',createdAt:new Date().toISOString(),listings};}
export async function restoreListings(db,backup){
 if(backup?.format!=='knuroom-listings-v1'||!Array.isArray(backup.listings)||backup.listings.length>5000)throw new HttpError(400,'백업 형식 오류');
 // Validate the entire document before any writes; never execute supplied Redis keys.
 for(const item of backup.listings){listingKey(item?.id);if(resolveLocation(item.searchRegion).status!=='resolved')throw new HttpError(400,'백업 매물 지역 오류');}
 let count=0;for(const item of backup.listings)count+=await saveListings(db,[item],item.searchRegion,{now:item.lastSeenAt||backup.createdAt});return {restored:count};
}
