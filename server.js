import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import walking from './api/routes/walking.js';
import destinations from './api/destinations.js';
import conditions from './api/conditions.js';
import search from './api/search.js';
import status from './api/status.js';
import session from './api/session.js';
import collect from './api/collect.js';
import collectStatus from './api/collect-status.js';
import listings from './api/listings.js';
import inspect from './api/redis-inspect.js';
import integrations from './api/integrations.js';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const handlers={'/api/conditions':conditions,'/api/routes/walking':walking,'/api/destinations':destinations,'/api/search':search,'/api/status':status,'/api/session':session,'/api/collect':collect,'/api/collect-status':collectStatus,'/api/listings':listings,'/api/redis-inspect':inspect,'/api/integrations':integrations};
const pages=new Map([['/','index.html'],['/index.html','index.html'],['/privacy.html','privacy.html'],['/terms.html','terms.html'],['/admin','admin/index.html'],['/admin/','admin/index.html'],['/admin/index.html','admin/index.html']]);
const assetTypes={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{
 res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 const url=new URL(req.url,'http://localhost');req.query=Object.fromEntries(url.searchParams);
 if(handlers[url.pathname]){
  let raw='';try{for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>20000)return res.status(413).json({error:'요청이 너무 큽니다.'});}req.body=raw?JSON.parse(raw):{};}catch{return res.status(400).json({error:'잘못된 JSON'});}
  return handlers[url.pathname](req,res);
 }
 const page=pages.get(url.pathname);
 // Serve only simple public asset paths. API code, dotfiles and the project root stay private.
 const asset=/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(url.pathname)&&assetTypes[path.extname(url.pathname)];
 if(!page&&!asset)return res.status(404).json({error:'Not found'});
 const file=path.join(root,page||url.pathname.slice(1));
 const stream=fs.createReadStream(file);
 stream.on('error',()=>res.status(404).json({error:'Not found'}));
 stream.on('open',()=>{
  res.setHeader('Content-Type',page?'text/html; charset=utf-8':asset);
  stream.pipe(res);
 });
});
server.listen(process.env.PORT||3000,()=>console.log(`KNU Room AI running: http://localhost:${server.address().port}`));
