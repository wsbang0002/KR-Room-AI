import {endpoint} from '../lib/security.js';
import {collectionStatus} from '../lib/collection.js';
export default endpoint('GET',async req=>{const {items,...status}=await collectionStatus(req.query?.jobId,{req,includeItems:true});return {...status,persistedCount:items.length};});
