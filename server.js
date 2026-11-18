import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import walking from './api/routes/walking.js';
import destinations from './api/destinations.js';
import search from './api/search.js';
import status from './api/status.js';
import collect from './api/collect.js';
import collectStatus from './api/collect-status.js';
import listings from './api/listings.js';
import inspect from './api/redis-inspect.js';
import integrations from './api/integrations.js';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const handlers={'/api/routes/walking':walking,'/api/destinations':destinations,'/api/search':search,'/api/status':status,'/api/collect':collect,'/api/collect-status':collectStatus,'/api/listings':listings,'/api/redis-inspect':inspect,'/api/integrations':integrations};
const server=http.createServer(async(req,res)=>{
 res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 const url=new URL(req.url,'http://localhost');req.query=Object.fromEntries(url.searchParams);
 if(handlers[url.pathname]){
  let raw='';try{for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>20000)return res.status(413).json({error:'요청이 너무 큽니다.'});}req.body=raw?JSON.parse(raw):{};}catch{return res.status(400).json({error:'잘못된 JSON'});}
  return handlers[url.pathname](req,res);
 }
 const file={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'}[url.pathname];
 if(!file)return res.status(404).json({error:'Not found'});
 const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';res.setHeader('Content-Type',`${type}; charset=utf-8`);fs.createReadStream(path.join(root,file)).pipe(res);
});
server.listen(process.env.PORT||3000,()=>console.log(`KNU Room AI running: http://localhost:${server.address().port}`));
