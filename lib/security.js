import {timingSafeEqual,createHash} from 'node:crypto';
export class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
export function admin(req,env=process.env){
 const expected=env.ADMIN_API_KEY;
 const received=String(req?.headers?.authorization||'').replace(/^Bearer /,'');
 if(!expected||expected.length<24||!timingSafeEqual(createHash('sha256').update(received).digest(),createHash('sha256').update(expected).digest()))throw new HttpError(401,'관리자 인증이 필요합니다.');
 return createHash('sha256').update(received).digest('hex').slice(0,20);
}
export function privateData(req,env=process.env){if(env.DATA_RIGHTS_REVIEWED!=='true')admin(req,env);}
export async function jsonFetch(url,{fetcher=fetch,timeoutMs=8000,timings,...init}={}){
 const started=performance.now();let phase='response-headers';
 const ms=()=>Math.round(performance.now()-started);
 try{
  const r=await fetcher(url,{...init,signal:AbortSignal.timeout(timeoutMs)});
  if(timings)timings.headersMs=ms();
  if(!r.ok){const error=new HttpError(502,'외부 서비스 요청 실패');error.upstreamStatus=r.status;throw error;}
  phase='response-body';const bodyStarted=performance.now();
  const data=await r.json();
  if(timings){timings.bodyMs=Math.round(performance.now()-bodyStarted);timings.phase='complete';}
  return data;
 }catch(e){if(timings)timings.phase=phase;throw e;}
 finally{if(timings)timings.totalMs=ms();}
}
export function endpoint(method,fn){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!==method)return res.status(405).json({error:`${method}만 허용`});
 try {const result=await fn(req);return res.status(result.status||200).json(result.data??result);}
 catch(e){return res.status(e instanceof HttpError?e.status:500).json({error:e instanceof HttpError?e.message:'요청 처리 중 오류가 발생했습니다.'});}
};}
