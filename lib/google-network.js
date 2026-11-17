import https from 'node:https';
import {admin} from './security.js';
import {redis} from './store.js';
const HOST='generativelanguage.googleapis.com';
// Only the fixed Google API origin is reachable. No tokens/URLs/headers in output.
export function transportProbe({path,method='GET',body,key,timeoutMs=5000,requester=https.request}){
 return new Promise(resolve=>{
  const start=performance.now(),timings={};let phase='dns-or-connect',size=0,chunks=[];
  const elapsed=()=>Math.round(performance.now()-start);
  const done=(extra={})=>resolve({timings:{...timings,totalMs:elapsed(),phase},...extra});
  const bytes=body?Buffer.from(JSON.stringify(body)):null;
  const headers={...(key?{'x-goog-api-key':key}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})};
  let req;
  try{
   req=requester({hostname:HOST,port:443,path,method,headers,agent:false,signal:AbortSignal.timeout(timeoutMs)},res=>{
    timings.firstByteMs=elapsed();phase='response-body';
    res.on('data',chunk=>{size+=chunk.length;if(size<=65536)chunks.push(chunk);else req.destroy(Object.assign(Error('size limit'),{code:'BODY_LIMIT'}));});
    res.on('error',e=>done({errorCode:['ABORT_ERR','ETIMEDOUT','ECONNRESET'].includes(e.code)?e.code:'TRANSPORT_ERROR'}));
    res.on('end',()=>{phase='complete';let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{}done({httpStatus:res.statusCode,generationSupported:data?.supportedGenerationMethods?.includes('generateContent')===true,hasGeneratedText:Boolean(data?.candidates?.some(c=>c.content?.parts?.some(p=>p.text&&!p.thought)))});});
   });
   req.on('socket',socket=>{
    socket.on('lookup',()=>{timings.dnsMs=elapsed();phase='tcp-connect';});
    socket.on('connect',()=>{timings.tcpMs=elapsed();phase='tls-handshake';});
    socket.on('secureConnect',()=>{timings.tlsMs=elapsed();phase='request-send';});
   });
   req.on('finish',()=>{timings.requestSentMs=elapsed();phase='response-headers';});
   req.on('error',e=>done({errorCode:['ABORT_ERR','ETIMEDOUT','ECONNRESET','ENOTFOUND','EAI_AGAIN','CERT_HAS_EXPIRED'].includes(e.code)?e.code:'TRANSPORT_ERROR'}));
   req.end(bytes||undefined);
  }catch{done({errorCode:'REQUEST_SETUP_FAILED'});}
 });
}
export async function diagnoseGoogleNetwork({req,env=process.env,fetcher=fetch,store,probe=transportProbe}={}){
 const user=admin(req,env),model=env.GEMINI_MODEL||'gemini-2.5-flash';
 if(!env.GEMINI_API_KEY)return {status:'missing',message:'GEMINI_API_KEY 미설정'};
 const db=store||redis(env,fetcher),cacheKey='knuroom:gemini:network:'+encodeURIComponent(model);
 const old=await db.reserve({key:cacheKey,user,kind:'gemini',limit:20,cost:1,budget:20,ttl:120,value:{pending:true}});
 if(old)return old.result?{...old.result,cached:true}:{status:'blocked',message:'검사 진행 중 또는 대기 중'};
 const path='/v1beta/models/'+encodeURIComponent(model);
 const body={contents:[{role:'user',parts:[{text:'안녕'}]}],generationConfig:{maxOutputTokens:1024,temperature:1,...(/^gemini-3/.test(model)?{thinkingConfig:{thinkingLevel:'low'}}:{})}};
 const [publicGet,unauthenticatedPost,modelGet]=await Promise.all([
  probe({path:'/v1beta/models'}),probe({path:path+':generateContent',method:'POST',body}),probe({path,key:env.GEMINI_API_KEY})
 ]);
 const generation=modelGet.httpStatus===200&&modelGet.generationSupported?await probe({path:path+':generateContent',method:'POST',body,key:env.GEMINI_API_KEY,timeoutMs:35000}):{skipped:true};
 const result={status:'measured',model,region:env.VERCEL_REGION||'local',publicGet,unauthenticatedPost,modelGet,generation,actorStarted:false};
 await db.set(cacheKey,{result},120);return result;
}
