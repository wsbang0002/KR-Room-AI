import {endpoint} from '../lib/security.js';
import {activeCollectionStatus,collectionStatus} from '../lib/collection.js';

export default endpoint('GET',async req=>{
 const result=req.query?.active==='1'
  ? await activeCollectionStatus({req})
  : await collectionStatus(req.query?.jobId,{req,includeItems:true});
 const {items,...status}=result;
 return items ? {...status,persistedCount:items.length} : status;
});
