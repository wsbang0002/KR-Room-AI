import {searchDestinations} from '../lib/destinations.js';
import {endpoint} from '../lib/security.js';

export default endpoint('POST',req=>searchDestinations(req.body,{req}));
