import {isFreshTurn,searchTurn} from '../lib/search-turn.js';
import {unsupportedConditions,validateAI} from '../lib/conditions.js';
import {analyzeSearch,selectedProvider} from '../lib/gemini.js';
import {admin,endpoint} from '../lib/security.js';

export async function handleConditions(body,{req,env=process.env,fetcher=fetch,store,analyze=analyzeSearch}={}){
 const authenticated=Boolean(req?.headers?.authorization);
 if(authenticated)admin(req,env);
 const local=searchTurn(body);
 const fresh=isFreshTurn(body.query);
 const input=!fresh&&body.pending?.query?body.pending.query:body.query;
 const unsupported=unsupportedConditions(input);
 const report=(turn,mode)=>({...turn,interpretation:{mode,unsupported}});
 const provider=selectedProvider(env);
 const continuation=!fresh&&(body.previous||body.pending);
 if(local.state!=='ready'||continuation||provider==='local')return report(local,'local');
 if(!authenticated&&(env.DATA_RIGHTS_REVIEWED!=='true'||provider!=='openrouter-free'))return report(local,'local');
 try{
  const result=await analyze(body.query,{req,env,fetcher,store,publicFree:!authenticated});
  if(validateAI(result.ai)&&Object.values(result.ai).some(value=>value!=null)){
   return report(searchTurn(body,{ai:result.ai}),'ai');
  }
 }catch{
  // Guarded provider failures leave the local conditions available.
 }
 return report(local,'fallback');
}
export default endpoint('POST',req=>handleConditions(req.body,{req}));
