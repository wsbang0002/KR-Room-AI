import {endpoint,admin} from '../lib/security.js';
import {redis} from '../lib/store.js';
import {inspectRedis} from '../lib/listing-store.js';
export default endpoint('GET',async req=>{admin(req);return inspectRedis(redis());});
