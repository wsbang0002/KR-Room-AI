import {endpoint} from '../lib/security.js';
import {checkIntegrations} from '../lib/integrations.js';
export default endpoint('POST',req=>checkIntegrations(req.body,{req}));
