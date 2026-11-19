import {publicWalking,publicWalkingPlaces} from '../../lib/public-walking.js';
import {loadListings} from '../../lib/apify.js';
import {listingOrigin} from '../../lib/core.js';
import {getDestination} from '../../lib/destinations.js';
import {withDatasetOrigin} from '../../lib/inventory.js';
import {listingKey} from '../../lib/listing-store.js';
import {admin,endpoint,HttpError,privateData} from '../../lib/security.js';
import {redis} from '../../lib/store.js';
import {validWalkingPoint,walkingRoute,walkingSettings} from '../../lib/walking.js';

const fields=new Set(['listingId','destinationId','diagnostic','confirmFreePlan']);
function unavailable(reason){
 return {status:'unconfirmed',mode:'walking',provider:'tmap',reason,cacheHit:false};
}

export async function handleWalking(body,{req,env=process.env,store,fetcher=fetch}={}){
 if(body&&Object.hasOwn(body,'publicOriginId'))return publicWalking(body,{req,env,store,fetcher});
 privateData(req,env);
 if(body?.diagnostic===true)admin(req,env);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!fields.has(key))||
    ('diagnostic' in body&&typeof body.diagnostic!=='boolean')||
    ('confirmFreePlan' in body&&(body.diagnostic!==true||typeof body.confirmFreePlan!=='boolean'))){
  throw new HttpError(400,'매물 ID와 목적지 ID를 입력하세요.');
 }
 const {listingId,destinationId,diagnostic=false,confirmFreePlan=false}=body;
 const key=listingKey(listingId);
 if(typeof destinationId!=='string'||!destinationId.trim()||destinationId.length>180){
  throw new HttpError(400,'목적지 ID를 확인하세요.');
 }
 const settings=walkingSettings(env);
 const manualApproval=diagnostic&&confirmFreePlan&&settings.oneShotAllowed;
 if(!(diagnostic?settings.diagnosticEnabled||manualApproval:settings.enabled))return unavailable('disabled');
 if(!settings.keyConfigured)return unavailable('missing-key');

 let db,listing,destination;
 try{
  db=store||redis(env,fetcher);
  listing=await db.get(key);
  destination=await getDestination(destinationId,{store:db,env,fetcher});
 }catch{return unavailable('redis-unavailable');}
 if(!destination?.verified)throw new HttpError(404,'좌표가 확인된 목적지를 선택하세요.');
 if(listing?.id===listingId)listing={...listing,...listingOrigin(listing)};
 if(!validWalkingPoint(listing)){
  const loaded=await loadListings({env,fetcher});
  listing=withDatasetOrigin(listing,loaded.items.find(item=>item.id===listingId));
 }
 if(listing?.id!==listingId)throw new HttpError(404,'매물을 찾을 수 없습니다.');
 return walkingRoute(listing,destination,{req,env,store:db,fetcher,diagnostic,confirmFreePlan});
}

// A route's string status is application data. Only the endpoint wrapper sets HTTP status.
const calculate=endpoint('POST',async req=>({data:await handleWalking(req.body,{req})}));
const places=endpoint('GET',req=>{
 if(req.query?.places!=='public')throw new HttpError(400,'공개 장소 목록을 선택해 주세요.');
 return publicWalkingPlaces();
});
export default function walking(req,res){return (req.method==='GET'?places:calculate)(req,res);}
