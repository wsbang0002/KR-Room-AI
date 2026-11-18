import {searchTurn} from '../lib/search-turn.js';
import {analyzeSearch,selectedProvider} from '../lib/gemini.js';
import {admin,endpoint} from '../lib/security.js';

export async function handleConditions(body,{req,env=process.env,fetcher=fetch,store,analyze=analyzeSearch}={}){
 const authenticated=Boolean(req?.headers?.authorization);
 if(authenticated)admin(req,env);
 const local=searchTurn(body);
 if(local.state!=='ready'||body.previous||body.pending)return local;
 if(!authenticated&&(env.DATA_RIGHTS_REVIEWED!=='true'||selectedProvider(env)!=='openrouter-free'))return local;
 try{
  const result=await analyze(body.query,{req,env,fetcher,store,publicFree:!authenticated});
  if(result.ai)return searchTurn(body,{ai:result.ai});
 }catch{
  // The citizen-facing condition editor also works when the provider is unavailable.
 }
 return local;
}
export default endpoint('POST',req=>handleConditions(req.body,{req}));
