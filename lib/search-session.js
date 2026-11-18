import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

const lifetimeSeconds=3600;
const usesHttps=env=>env.VERCEL==='1'||env.NODE_ENV==='production';
const cookieName=env=>usesHttps(env)?'__Host-knu_search':'knu_search';

// Deny cross-origin browser use even between two hosts that browsers consider same-site.
export function sameOriginRequest(req,env){
 const headers=req?.headers||{};
 if(['cross-site','same-site'].includes(headers['sec-fetch-site']))return false;
 if(headers.origin===undefined)return true;
 const protocol=usesHttps(env)||req.socket?.encrypted?'https':'http';
 return headers.origin===protocol+'://'+headers.host;
}

function signature(payload,secret){
 return createHmac('sha256',secret).update('knu-room-ai/search-session/v1\n'+payload).digest('base64url');
}

function cookie(value,maxAge,env){
 return cookieName(env)+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(usesHttps(env)?'; Secure':'');
}

export function issueSearchSession(env,now=Date.now()){
 const expiresAt=Math.floor(now/1000)+lifetimeSeconds;
 const payload=expiresAt+'.'+randomBytes(16).toString('hex');
 return {cookie:cookie(payload+'.'+signature(payload,env.ADMIN_API_KEY),lifetimeSeconds,env),expiresAt:expiresAt*1000};
}

export function clearSearchSession(env){
 return cookie('',0,env);
}

export function searchSessionExpiry(req,env,now=Date.now()){
 if(!env.ADMIN_API_KEY||env.ADMIN_API_KEY.length<24||!sameOriginRequest(req,env))return null;
 const prefix=cookieName(env)+'=';
 const pair=String(req?.headers?.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(prefix));
 if(!pair)return null;
 const match=/^(\d{10})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(pair.slice(prefix.length));
 if(!match)return null;
 const [,expiration,nonce,mac]=match;
 const expiresAt=Number(expiration)*1000;
 if(expiresAt<=now||expiresAt>now+lifetimeSeconds*1000)return null;
 const expected=signature(expiration+'.'+nonce,env.ADMIN_API_KEY);
 return timingSafeEqual(Buffer.from(mac),Buffer.from(expected))?expiresAt:null;
}
