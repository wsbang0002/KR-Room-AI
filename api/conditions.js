import {isFreshTurn,searchTurn} from '../lib/search-turn.js';
import {unsupportedConditions,validateAI} from '../lib/conditions.js';
import {analyzeSearch,selectedProvider} from '../lib/gemini.js';
import {authenticatedReader,endpoint} from '../lib/security.js';

// Public search responses carry only these categories, never upstream messages or timings.
function fallbackReason(result,provider){
 const detail=result.timings?.[provider==='gemini'?'google':'openrouter']?.providerReason;
 switch(result.parserReason){
  case 'not-configured':
  case 'free-tier-unverified': return 'configuration';
  case 'daily-rate-limit': return 'daily-limit';
  case 'reservation-unavailable': return 'usage-check';
  case 'pending-or-limited': return 'pending';
  case 'upstream-timeout': return 'timeout';
  case 'upstream-http-429': return 'provider-limit';
  case 'access-unavailable': return 'session';
  case 'response-blocked': return 'response-blocked';
  case 'upstream-http-401':
  case 'upstream-http-403': return 'access';
  case 'upstream-http-400': return 'request-rejected';
  case 'upstream-http-404': return 'provider-resource';
  case 'upstream-http-500':
  case 'upstream-http-502':
  case 'upstream-http-504': return 'service-unavailable';
  case 'upstream-http-503': return detail==='model-capacity'?'capacity':'service-unavailable';
  case 'invalid-schema':
  case 'empty-conditions':
  case 'invalid-json':
  case 'empty-response':
  case 'incomplete-response':
  case 'interaction-incomplete':
  case 'output-token-limit': return 'response-format';
  default: return 'unavailable';
 }
}

export async function handleConditions(body,{req,env=process.env,fetcher=fetch,store,analyze=analyzeSearch}={}){
 const authenticated=Boolean(authenticatedReader(req,env));
 const local=searchTurn(body);
 const fresh=isFreshTurn(body.query);
 const input=!fresh&&body.pending?.query?body.pending.query:body.query;
 const unsupported=unsupportedConditions(input);
 const report=(turn,mode,reason)=>({...turn,interpretation:{mode,unsupported,...(reason?{reason}:{})}});
 const provider=selectedProvider(env);
 const continuation=!fresh&&(body.previous||body.pending);
 if(local.state!=='ready'||continuation||provider==='local')return report(local,'local');
 if(!authenticated&&(env.DATA_RIGHTS_REVIEWED!=='true'||provider!=='openrouter-free'))return report(local,'local');
 try{
  const result=await analyze(body.query,{req,env,fetcher,store,publicFree:!authenticated});
  if(validateAI(result.ai)&&Object.values(result.ai).some(value=>value!=null)){
   return report(searchTurn(body,{ai:result.ai}),'ai');
  }
  return report(local,'fallback',fallbackReason(result,provider));
 }catch{
  return report(local,'fallback','unavailable');
 }
}
export default endpoint('POST',req=>handleConditions(req.body,{req}));
