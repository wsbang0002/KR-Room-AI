import {activeCollectionStatus} from './collection.js';
import {syncExistingDataset} from './dataset-sync.js';
import {jobInventory,regionalSummary} from './inventory.js';
import {allStoredListings} from './listing-store.js';
import {defaultLocation,resolveLocation} from './regions.js';
import {admin,HttpError} from './security.js';
import {redis} from './store.js';

// Import existing results, then verify what search can actually find in Redis.
// The three reads can succeed independently, so an unavailable source is explicit.
export async function syncInventory({req,env=process.env,fetcher=fetch,store,location}={}){
 admin(req,env);
 let target;
 if(location!==undefined){
  if(typeof location!=='string'||location.length>160)throw new HttpError(400,'확인할 지역을 선택해 주세요.');
  target=resolveLocation(location).location;
  if(!target)throw new HttpError(422,'확인할 지역을 선택해 주세요.');
 }
 const db=store||redis(env,fetcher);
 const options={req,env,fetcher,store:db};
 const issues=[];
 let previous={state:'UNAVAILABLE'},dataset=null,database=null;
 try{
  const job=await activeCollectionStatus(options);
  previous={state:job.state};
  if(job.jobId){
   previous.location=job.conditions?.location;
   previous.costSettled=job.costSettled;
   if(job.settlementIssue)previous.settlementIssue=job.settlementIssue;
   if(job.state==='SUCCEEDED')previous.persistedCount=job.items.length;
  }
 }catch{issues.push('이전 수집의 실행 상태를 확인할 수 없습니다.');}
 try{
  dataset=await syncExistingDataset(options);
  if(!dataset.verified)issues.push('일부 원본 매물 ID를 DB에서 다시 확인하지 못했습니다.');
 }catch(error){
  issues.push(error instanceof HttpError?error.message:'기존 Dataset 동기화를 완료하지 못했습니다.');
 }
 target=target||previous.location||defaultLocation;
 try{
  const inventory=jobInventory(await allStoredListings(db));
  const region=regionalSummary(inventory,target);
  database={total:inventory.items.length,location:target,regionCount:region.count,unlocated:region.unlocatedCount};
 }catch{issues.push('Redis에 저장된 매물 수를 확인할 수 없습니다.');}
 return {previous,dataset,database,issues};
}
