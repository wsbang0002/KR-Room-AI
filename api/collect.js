import {endpoint,HttpError} from '../lib/security.js';
import {buildConditions} from '../lib/conditions.js';
import {buildConfirmedConditions} from '../lib/search-turn.js';
import {startCollection} from '../lib/collection.js';
export default endpoint('POST',async req=>{
 const b=req.body;if(typeof b?.query!=='string'||!b.query.trim()||b.query.length>1200)throw new HttpError(400,'검색 조건을 입력해 주세요.');
 const confirmed=Object.hasOwn(b,'confirmedConditions');
 if(confirmed&&b.edits!=null)throw new HttpError(400,'확정한 검색 조건을 확인해 주세요.');
 let conditions;
 try{
  conditions=confirmed?buildConfirmedConditions(b.confirmedConditions):buildConditions(b.query,null,b.edits);
 }catch{throw new HttpError(400,'잘못된 검색 조건');}
 return {status:202,data:await startCollection(conditions,{req})};
});
