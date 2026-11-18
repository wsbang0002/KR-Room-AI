import {admin,endpoint,HttpError} from '../lib/security.js';
import {clearSearchSession,issueSearchSession,sameOriginRequest,searchSessionExpiry} from '../lib/search-session.js';

const get=endpoint('GET',req=>{
 const expiresAt=searchSessionExpiry(req,process.env);
 return expiresAt?{authenticated:true,expiresAt}:{authenticated:false};
});

function checkOrigin(req){
 if(!sameOriginRequest(req,process.env))throw new HttpError(403,'사이트에서 다시 시도해 주세요.');
}

const login=endpoint('POST',(req,res)=>{
 checkOrigin(req);
 try{
  if(!req.headers?.authorization?.startsWith('Bearer '))throw new Error();
  admin(req);
 }catch{
  throw new HttpError(401,'로그인 키를 확인해 주세요.');
 }
 const session=issueSearchSession(process.env);
 res.setHeader('Set-Cookie',session.cookie);
 return {authenticated:true,expiresAt:session.expiresAt};
});

const logout=endpoint('DELETE',(req,res)=>{
 checkOrigin(req);
 res.setHeader('Set-Cookie',clearSearchSession(process.env));
 return {authenticated:false};
});

export default function session(req,res){
 if(req.method==='POST')return login(req,res);
 if(req.method==='DELETE')return logout(req,res);
 res.setHeader('Allow','GET, POST, DELETE');
 return get(req,res);
}
