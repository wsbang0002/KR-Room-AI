import {endpoint,HttpError,requireCollector} from '../lib/security.js';
import {buildConditions} from '../lib/conditions.js';
import {buildConfirmedConditions} from '../lib/search-turn.js';
import {startCollection} from '../lib/collection.js';
import {syncInventory} from '../lib/inventory-sync.js';
export default endpoint('POST',async req=>{
 requireCollector(req);
 if(req.body&&Object.hasOwn(req.body,'action')){
  if(req.body.action!=='sync-existing')throw new HttpError(400,'지원하지 않는 매물 작업입니다.');
  return syncInventory({req,location:req.body.location});
 }
 const b=req.body;if(typeof b?.query!=='string'||!b.query.trim()||b.query.length>1200)throw new HttpError(400,'검색 조건을 입력해 주세요.');
 const confirmed=Object.hasOwn(b,'confirmedConditions');
 if(confirmed&&b.edits!=null)throw new HttpError(400,'확정한 검색 조건을 확인해 주세요.');
 let conditions;
 try{
  conditions=confirmed?buildConfirmedConditions(b.confirmedConditions):buildConditions(b.query,null,b.edits);
 }catch{throw new HttpError(400,'잘못된 검색 조건');}
 return {status:202,data:await startCollection(conditions,{req})};
});
