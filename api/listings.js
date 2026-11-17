import {endpoint} from '../lib/security.js';
import {collectionStatus} from '../lib/collection.js';
import {recommend} from '../lib/recommend.js';
export default endpoint('GET',async req=>{const job=await collectionStatus(req.query?.jobId,{req,includeItems:true});return {...job,...recommend(job.items,job.conditions)};});
