import {loadListings} from './apify.js';
import {listingOrigin} from './core.js';
import {allStoredListings,storedListings} from './listing-store.js';
import {regionTerms,resolveLocation,locationMatch} from './regions.js';
import {authenticatedReader} from './security.js';
import {redis} from './store.js';
import {validWalkingPoint} from './walking.js';

function canonicalAddress(item,snapshot){
 const scope=snapshot?'강원특별자치도 원주시':item.region;
 const terms=regionTerms([scope,item.address,item.dong].filter(Boolean).join(' '));
 if(!terms.length)return null;
 const exact=resolveLocation(terms.join(' '));
 if(exact.status==='resolved')return exact.location;
 // A legal neighborhood may be absent from the administrative catalog. Retain a
 // supported parent city/district without assigning it to an administrative dong.
 const parent=terms.filter(term=>!/(동|읍|면)$/.test(term));
 if(!parent.length||parent.length===terms.length)return null;
 return resolveLocation(parent.join(' ')).location||null;
}

function sourceDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(value))return null;
 const milliseconds=Date.parse(value);
 return Number.isFinite(milliseconds)?new Date(milliseconds).toISOString():null;
}
function evidence(items,source,now=Date.now()){
 const unique=new Map();
 for(const item of items){
  if(!item.id||item.rent==null||(item.priceType&&!['월세','MONTHLY_RENT'].includes(item.priceType)))continue;
  const location=canonicalAddress(item,source.startsWith('snapshot'));
  const collectedAt=sourceDate(item.collectedAt),lastSeenAt=sourceDate(item.lastSeenAt);
  const latest=lastSeenAt||collectedAt;
  unique.set(item.id,{...item,...listingOrigin(item),region:location||item.region||'',observedRegion:location,inventorySource:source,
   collectedAt,lastSeenAt,syncStatus:latest?(now-Date.parse(latest)>7*86400000?'stale':'current'):'unknown',
   availability:'unverified',availabilityCheckedAt:null});
 }
 return [...unique.values()];
}

const hasDb=({env,store})=>Boolean(store||(env.UPSTASH_REDIS_REST_URL&&env.UPSTASH_REDIS_REST_TOKEN));
const dbFor=({env,store,fetcher})=>store||redis(env,fetcher);
// A missing coordinate pair on a saved record can be recovered from the same
// listing in the Dataset. Keep both axes and the accuracy flag from one origin.
export function withDatasetOrigin(stored,dataset){
 if(!stored)return dataset;
 if(validWalkingPoint(stored)||dataset?.id!==stored.id||!validWalkingPoint(dataset))return stored;
 return {...stored,lat:dataset.lat,lng:dataset.lng,approximate:dataset.approximate!==false};
}
function combine(stored,dataset){
 const rows=new Map(dataset.map(row=>[row.id,row]));
 for(const row of stored)rows.set(row.id,withDatasetOrigin(row,rows.get(row.id)));
 return [...rows.values()];
}

async function readStored(options,location){
 if(!hasDb(options))return {items:[]};
 try{
  const items=await allStoredListings(dbFor(options));
  return {items:evidence(items,'redis')};
 }catch(error){
  // An oversized national store can still serve the old region indexes. Treat
  // this as a partial view since a legacy index records a query, not an address.
  if(location&&error.code==='INVENTORY_TOO_LARGE'){
   try{
    return {items:evidence(await storedListings(dbFor(options),location),'redis'),partial:true};
   }catch{}
  }
  return {items:[],failed:true};
 }
}

async function inventory(options,location){
 const [stored,dataset]=await Promise.all([readStored(options,location),loadListings(options)]);
 const items=combine(stored.items,evidence(dataset.items,dataset.source));
 return {items,source:dataset.source,partial:stored.partial||dataset.partial,
  failed:stored.failed||dataset.failed,stale:dataset.stale,notice:dataset.notice};
}

export async function loadRegionInventory(location,options){
 const read=await inventory(options,location);
 const items=read.items.filter(item=>locationMatch(item,location)!=='mismatch');
 const sources=[...new Set(items.map(item=>item.inventorySource))];
 const source=sources.length===1?sources[0]:sources.length?'mixed':read.source;
 const notice=source==='redis'||source==='mixed'?'보유 매물 자료입니다. 공실·계약 가능 여부는 별도 확인이 필요합니다.':read.notice;
 return {...read,items,source,notice};
}

function emptySummary(location){
 return {location,count:0,unlocatedCount:0,sources:[],lastCollectedAt:null,lastSeenAt:null,stale:false};
}
function add(summary,room){
 summary.count++;
 if(!summary.sources.includes(room.inventorySource))summary.sources.push(room.inventorySource);
 if(room.collectedAt&&(!summary.lastCollectedAt||room.collectedAt>summary.lastCollectedAt))summary.lastCollectedAt=room.collectedAt;
 if(room.lastSeenAt&&(!summary.lastSeenAt||room.lastSeenAt>summary.lastSeenAt))summary.lastSeenAt=room.lastSeenAt;
 if(room.syncStatus==='stale')summary.stale=true;
}
function coverageState(count,unknown,read){
 if(read.failed||read.partial)return count||unknown||read.partial?'partial':'unavailable';
 if(count)return 'available';
 return unknown?'unknown-region':'empty';
}

export function regionalSummary(read,location){
 const summary=emptySummary(location);
 for(const item of read.items){
  const match=locationMatch(item,location);
  if(match==='match')add(summary,item);
  else if(match==='unknown')summary.unlocatedCount++;
 }
 summary.stale||=Boolean(read.stale);
 summary.state=coverageState(summary.count,summary.unlocatedCount,read);
 return summary;
}

export function jobInventory(items){
 return {items:evidence(items,'apify-run'),source:'apify-run',notice:'신규 Dataset 매물입니다. 공실·계약 가능 여부는 미확인입니다.'};
}

async function readOverview(options){
 const read=await inventory(options);
 const records=read.items;
 const groups=new Map();
 let unlocatedCount=0;
 for(const item of records){
  if(!item.observedRegion){unlocatedCount++;continue;}
  const group=groups.get(item.observedRegion)||emptySummary(item.observedRegion);
  add(group,item);
  groups.set(item.observedRegion,group);
 }
 const regions=[...groups.values()].sort((a,b)=>b.count-a.count||a.location.localeCompare(b.location,'ko'));
 const state=coverageState(records.length-unlocatedCount,unlocatedCount,read);
 return {state,regions,unlocatedCount,stale:Boolean(read.stale)||regions.some(r=>r.stale)};
}

// Aggregate public views are identical across readers. Check access before reading
// even the short-lived cache; the cached object contains no listing records.
let view;
export async function inventoryOverview(req,{env=process.env,fetcher=fetch,store,now=Date.now()}={}){
 if(!authenticatedReader(req,env)&&env.DATA_RIGHTS_REVIEWED!=='true')return {state:'private',regions:[]};
 const key=[env.UPSTASH_REDIS_REST_URL,env.UPSTASH_REDIS_REST_TOKEN,env.APIFY_DATASET_ID,env.APIFY_TOKEN].join('\n');
 if(view?.key===key&&view.store===store&&view.fetcher===fetcher&&now<view.until)return view.pending;
 const pending=readOverview({env,fetcher,store,now});
 view={key,store,fetcher,pending,until:now+60000};
 return pending;
}
