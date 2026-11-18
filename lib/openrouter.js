import {jsonFetch} from './security.js';

export const openRouterModel='openrouter/free';

export async function extractOpenRouter(text,{apiKey,fetcher,timeoutMs,timings,searchInstruction}){
 if(typeof text!=='string'||!text.trim()||text.length>1200)return {failure:'invalid-input'};
 const started=performance.now();
 const authorization={Authorization:`Bearer ${apiKey}`};
 const account=await jsonFetch('https://openrouter.ai/api/v1/key',{
  fetcher,timeoutMs,redirect:'error',headers:authorization
 });
 if(account?.data?.is_free_tier!==true)return {failure:'free-tier-unverified'};
 const remainingMs=Math.floor(timeoutMs-(performance.now()-started));
 if(remainingMs<=0)return {failure:'upstream-timeout'};
 const data=await jsonFetch('https://openrouter.ai/api/v1/chat/completions',{
  fetcher,timeoutMs:remainingMs,timings,method:'POST',redirect:'error',
  headers:{'Content-Type':'application/json',...authorization},
  body:JSON.stringify({
   model:openRouterModel,
   messages:[{role:'system',content:searchInstruction},{role:'user',content:text}],
   response_format:{type:'json_object'},
   reasoning:{effort:'none'},
   max_tokens:1024,
   plugins:[],
   provider:{
    allow_fallbacks:false,
    require_parameters:true,
    max_price:{prompt:'0',completion:'0',request:'0'}
   }
  })
 });
 const result=data?.choices?.[0];
 if(result?.finish_reason==='length')return {failure:'output-token-limit'};
 if(result?.finish_reason!=='stop')return {failure:'incomplete-response'};
 const answer=result.message?.content;
 if(typeof answer!=='string'||!answer.trim())return {failure:'empty-response'};
 return {ai:JSON.parse(answer)};
}
